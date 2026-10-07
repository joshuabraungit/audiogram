import { fftMagnitudes } from './fft';

export const ANALYSIS_SR = 48000;
export const WHISPER_SR = 16000;

export async function decodeAudioFile(file: Blob): Promise<AudioBuffer> {
  const data = await file.arrayBuffer();
  // Decoding through a 48 kHz context resamples everything to one rate (AAC-friendly, no surprises later).
  const ctx = new OfflineAudioContext(1, 1, ANALYSIS_SR);
  const decoded = await ctx.decodeAudioData(data);
  // A 30 min stereo file is ~700 MB of float samples. Past 15 min, fold to mono to halve that;
  // speech content (podcasts, interviews) loses nothing audible.
  if (decoded.numberOfChannels > 1 && decoded.duration > LONG_FILE_SEC) {
    const mono = new AudioBuffer({ length: decoded.length, numberOfChannels: 1, sampleRate: decoded.sampleRate });
    const out = mono.getChannelData(0);
    const chans = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
    const k = 1 / chans.length;
    for (let i = 0; i < out.length; i++) {
      let v = 0;
      for (const ch of chans) v += ch[i];
      out[i] = v * k;
    }
    return mono;
  }
  return decoded;
}

export const LONG_FILE_SEC = 15 * 60;

/** Mono 16 kHz Float32Array for Whisper. Done with an OfflineAudioContext so resampling is high quality. */
export async function toWhisperInput(buffer: AudioBuffer): Promise<Float32Array> {
  const length = Math.ceil(buffer.duration * WHISPER_SR);
  const ctx = new OfflineAudioContext(1, length, WHISPER_SR);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination); // multi-channel is down-mixed to mono by the destination
  src.start();
  const out = await ctx.startRendering();
  return out.getChannelData(0);
}

const FFT_SIZE = 2048;
const BANDS = 64;
const ENV_RATE = 100; // envelope values per second

/**
 * Precomputed, deterministic audio features. Everything is a pure function of time t, so the preview and the
 * offline export draw identical waveforms for the same timestamp.
 */
export class AudioAnalysis {
  readonly duration: number;
  readonly sampleRate: number;
  private channels: Float32Array[];
  private length: number;
  /** RMS envelope at ENV_RATE Hz, normalised to 0..1 */
  readonly envelope: Float32Array;
  private bandEdges: number[];
  private window: Float32Array;
  private cache = new Map<number, Float32Array>();
  private bandNorm = 1;

  constructor(buffer: AudioBuffer) {
    this.duration = buffer.duration;
    this.sampleRate = buffer.sampleRate;
    const n = buffer.length;
    this.length = n;
    // Keep references, not a mixed copy: long files are already large enough.
    this.channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c));
    const chans = this.channels;
    const k = 1 / chans.length;
    const at = (i: number) => (chans.length === 1 ? chans[0][i] : (chans[0][i] + chans[1][i]) * k);

    const hop = Math.round(this.sampleRate / ENV_RATE);
    const env = new Float32Array(Math.ceil(n / hop));
    let peak = 1e-6;
    for (let k = 0; k < env.length; k++) {
      let s = 0;
      const a = k * hop;
      const b = Math.min(n, a + hop);
      for (let i = a; i < b; i++) {
        const v = at(i);
        s += v * v;
      }
      env[k] = Math.sqrt(s / Math.max(1, b - a));
      if (env[k] > peak) peak = env[k];
    }
    // Normalise to a high percentile rather than the absolute peak so one loud spike doesn't flatten everything.
    const sorted = Float32Array.from(env).sort();
    const ref = Math.max(sorted[Math.floor(sorted.length * 0.98)] || peak, peak * 0.25, 1e-4);
    for (let k = 0; k < env.length; k++) env[k] = Math.min(1, env[k] / ref);
    this.envelope = env;

    this.window = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));

    // Log-spaced bands between 60 Hz and 8 kHz (where speech energy lives).
    const binHz = this.sampleRate / FFT_SIZE;
    this.bandEdges = [];
    for (let b = 0; b <= BANDS; b++) {
      const hz = 60 * Math.pow(8000 / 60, b / BANDS);
      this.bandEdges.push(Math.max(1, Math.round(hz / binHz)));
    }
    // Calibrate band scaling on many loud moments (90th percentile of their peaks) so typical speech
    // reaches near full height without a single spike setting the scale.
    const peaks: number[] = [];
    const stride = Math.max(1, Math.floor(env.length / 400));
    for (let k = 0; k < env.length; k += stride) {
      if (env[k] < 0.3) continue;
      let m = 0;
      for (const v of this.rawBands(k / ENV_RATE)) m = Math.max(m, v);
      peaks.push(m);
    }
    peaks.sort((a, b) => a - b);
    const bandRef = peaks.length ? peaks[Math.floor(peaks.length * 0.9)] : 1;
    this.bandNorm = 1 / Math.max(bandRef, 1e-6);
  }

  /** Envelope value at time t, linearly interpolated. */
  level(t: number): number {
    const x = t * ENV_RATE;
    const i = Math.floor(x);
    if (i < 0 || i >= this.envelope.length - 1) return 0;
    const f = x - i;
    return this.envelope[i] * (1 - f) + this.envelope[i + 1] * f;
  }

  private rawBands(t: number): Float32Array {
    const center = Math.round(t * this.sampleRate);
    const frame = new Float32Array(FFT_SIZE);
    const off = center - FFT_SIZE / 2;
    const [l, r] = this.channels;
    for (let i = 0; i < FFT_SIZE; i++) {
      const j = off + i;
      if (j < 0 || j >= this.length) continue;
      frame[i] = (r ? (l[j] + r[j]) * 0.5 : l[j]) * this.window[i];
    }
    const mags = fftMagnitudes(frame);
    const out = new Float32Array(BANDS);
    for (let b = 0; b < BANDS; b++) {
      const lo = this.bandEdges[b];
      const hi = Math.max(lo + 1, this.bandEdges[b + 1]);
      let s = 0;
      for (let k = lo; k < hi; k++) s += mags[k];
      // Compress dynamic range and tilt up highs a bit so the right side of the spectrum isn't dead.
      out[b] = Math.sqrt(s / (hi - lo)) * (1 + b / BANDS);
    }
    return out;
  }

  /**
   * Spectrum bands (0..1) at time t, smoothed over a short look-back window so bars move fluidly.
   * Quantised to 1/120 s and cached; deterministic for a given t.
   */
  bands(t: number): Float32Array {
    const key = Math.round(t * 120);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const out = new Float32Array(BANDS);
    const taps = [0, 1 / 60, 2 / 60, 3 / 60];
    const weights = [0.4, 0.27, 0.2, 0.13];
    for (let k = 0; k < taps.length; k++) {
      const r = this.rawBands(key / 120 - taps[k]);
      for (let b = 0; b < BANDS; b++) out[b] += r[b] * weights[k];
    }
    // Power curve lifts quieter bands so the whole shape moves, not just a couple of formant peaks.
    for (let b = 0; b < BANDS; b++) out[b] = Math.min(1, Math.pow(Math.max(0, out[b] * this.bandNorm - 0.02) / 0.98, 0.6));
    if (this.cache.size > 4000) this.cache.clear();
    this.cache.set(key, out);
    return out;
  }
}
