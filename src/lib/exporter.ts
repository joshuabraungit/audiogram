import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Input,
  Output,
  Quality,
  StreamTarget,
  canEncodeAudio,
  canEncodeVideo,
  type Target,
} from 'mediabunny';
import type { PcmSource } from './edit';

export type RenderFn = (ctx: OffscreenCanvasRenderingContext2D, t: number) => void;

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  /** Full audio (a decoded buffer, or the cut-aware EditedSource). The exported clip is [start, end) of it. */
  audio: AudioBuffer | PcmSource;
  start: number;
  end: number;
  /** Draws the frame for absolute source time `t` (seconds). */
  render: RenderFn;
  /** Called before export starts, e.g. to wait for fonts/images. */
  onProgress?: (p: ExportProgress) => void;
  signal?: AbortSignal;
  /** Optional writable (from showSaveFilePicker) for files too large to hold in memory. */
  writable?: FileSystemWritableFileStream;
  videoBitrate?: number;
  audioBitrate?: number;
}

export interface ExportProgress {
  frame: number;
  totalFrames: number;
  fraction: number;
  elapsedMs: number;
  /** Rendering speed relative to real time (2 = twice as fast as playback). */
  speed: number;
}

export interface ExportResult {
  blob?: Blob;
  /** Measured AAC encoder delay in samples that was compensated for. */
  aacDelay: number;
  bytes: number;
  usedWasmAac: boolean;
  videoCodec: string;
}

export class ExportUnsupportedError extends Error {}
export class ExportCanceledError extends Error {
  constructor() {
    super('Export canceled');
  }
}

export function webCodecsAvailable(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}

let aacRegistered = false;

/** Makes sure some AAC encoder exists: native WebCodecs if possible, otherwise the wasm (libavcodec) one. */
async function ensureAac(numberOfChannels: number, sampleRate: number, bitrate: number): Promise<boolean> {
  const opts = { numberOfChannels, sampleRate, bitrate };
  if (await canEncodeAudio('aac', opts)) return aacRegistered;
  if (!aacRegistered) {
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
    registerAacEncoder();
    aacRegistered = true;
  }
  if (!(await canEncodeAudio('aac', opts))) {
    throw new ExportUnsupportedError('This browser cannot encode AAC audio.');
  }
  return true;
}

const delayCache = new Map<string, number>();

/**
 * AAC encoders prepend "priming" samples (typically 1024 or 2112) and the amount differs between the native
 * encoders (macOS/Windows) and the wasm fallback. Left alone, the audio plays that much late. We measure it once
 * per config by encoding a click at a known position and decoding it back, then shift the audio timestamps by
 * the measured amount; the muxer turns the negative start into an MP4 edit list that players honor.
 */
async function measureAacDelay(channels: number, sampleRate: number, bitrate: number): Promise<number> {
  const key = `${channels}/${sampleRate}/${bitrate}`;
  const cached = delayCache.get(key);
  if (cached !== undefined) return cached;

  const clickAt = Math.round(sampleRate * 0.25);
  const length = Math.round(sampleRate * 0.6);
  const buf = new AudioBuffer({ length, numberOfChannels: channels, sampleRate });
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    for (let i = clickAt; i < clickAt + sampleRate * 0.1; i++) d[i] = 0.8 * Math.sin((2 * Math.PI * 1000 * (i - clickAt)) / sampleRate);
  }
  const target = new BufferTarget();
  const out = new Output({ format: new Mp4OutputFormat(), target });
  const src = new AudioBufferSource({ codec: 'aac', quality: new Quality({ bitrate }) });
  out.addAudioTrack(src);
  await out.start();
  await src.add(buf);
  src.close();
  await out.finalize();

  const input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  let delay = 0;
  if (track) {
    const sink = new AudioBufferSink(track);
    let found = -1;
    let pos = 0;
    for await (const { buffer } of sink.buffers()) {
      const d = buffer.getChannelData(0);
      for (let i = 0; i < d.length && found < 0; i++) if (Math.abs(d[i]) > 0.3) found = pos + i;
      pos += d.length;
      if (found >= 0) break;
    }
    // The first loud sample of a sine starting at phase 0 sits a few samples after the true onset.
    const sineLag = Math.round(Math.asin(0.3 / 0.8) / (2 * Math.PI * 1000) * sampleRate);
    if (found >= 0) delay = Math.max(0, found - clickAt - sineLag);
  }
  input.dispose();
  delayCache.set(key, delay);
  return delay;
}

/** Rough output size so we can decide whether to stream to disk instead of RAM. */
export function estimateBytes(durationSec: number, videoBitrate = DEFAULT_VIDEO_BITRATE, audioBitrate = DEFAULT_AUDIO_BITRATE) {
  return ((videoBitrate + audioBitrate) / 8) * durationSec * 1.05;
}

export const DEFAULT_VIDEO_BITRATE = 6_000_000;
export const DEFAULT_AUDIO_BITRATE = 192_000;

/**
 * Renders every frame offline (not in real time), encodes H.264 + AAC with WebCodecs and muxes into MP4.
 * Video frame i is stamped at i/fps and shows source time start + i/fps; audio sample 0 is source time start.
 * Both tracks therefore share the same clock and stay in sync regardless of how long encoding takes.
 */
export async function exportMp4(opts: ExportOptions): Promise<ExportResult> {
  const {
    width,
    height,
    fps,
    audio,
    render,
    onProgress,
    signal,
    writable,
    videoBitrate = DEFAULT_VIDEO_BITRATE,
    audioBitrate = DEFAULT_AUDIO_BITRATE,
  } = opts;
  if (!webCodecsAvailable()) throw new ExportUnsupportedError('WebCodecs is not available in this browser.');

  const start = Math.max(0, opts.start);
  const end = Math.min(audio.duration, opts.end);
  const duration = end - start;
  if (duration <= 0) throw new Error('Nothing to export: the trim range is empty.');

  if (!(await canEncodeVideo('avc', { width, height, bitrate: videoBitrate }))) {
    throw new ExportUnsupportedError('This browser cannot encode H.264 video.');
  }
  const channels = Math.min(2, audio.numberOfChannels);
  const pcm: PcmSource = 'read' in audio ? audio : bufferPcm(audio);
  const usedWasmAac = await ensureAac(channels, audio.sampleRate, audioBitrate);
  const aacDelay = await measureAacDelay(channels, audio.sampleRate, audioBitrate);

  const totalFrames = Math.max(1, Math.round(duration * fps));
  const sr = audio.sampleRate;
  const startSample = Math.round(start * sr);
  const totalSamples = Math.round((totalFrames / fps) * sr);

  let target: Target;
  let fastStart: 'in-memory' | 'reserve';
  if (writable) {
    target = new StreamTarget(writable as unknown as WritableStream, { chunked: true });
    fastStart = 'reserve';
  } else {
    target = new BufferTarget();
    fastStart = 'in-memory';
  }

  const output = new Output({ format: new Mp4OutputFormat({ fastStart }), target });

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false })!;

  let videoCodec = '';
  const videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    quality: new Quality({ bitrate: videoBitrate }),
    keyFrameInterval: 2,
    latencyMode: 'quality',
    onEncoderConfig: (c) => (videoCodec = c.codec),
  });
  const audioSource = new AudioBufferSource(
    {
      codec: 'aac',
      quality: new Quality({ bitrate: audioBitrate }),
      transform: { numberOfChannels: channels },
    },
    { startTimestamp: -aacDelay / audio.sampleRate },
  );

  output.addVideoTrack(videoSource, {
    frameRate: fps,
    maximumPacketCount: fastStart === 'reserve' ? totalFrames + 16 : undefined,
  });
  output.addAudioTrack(audioSource, {
    maximumPacketCount: fastStart === 'reserve' ? Math.ceil((totalSamples / 512) * 1.34) + 64 : undefined,
  });

  const aborted = () => signal?.aborted;
  // Once the output is canceled, pending add() promises may never settle, so every await races the abort.
  let rejectAbort!: (e: Error) => void;
  const abortPromise = new Promise<never>((_, rej) => (rejectAbort = rej));
  abortPromise.catch(() => {});
  const guard = <T,>(p: Promise<T>) => Promise.race([p, abortPromise]);
  const onAbort = () => {
    rejectAbort(new ExportCanceledError());
    void output.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted) onAbort();

  try {
    await guard(output.start());

    // Audio is fed in ~1s slices just ahead of the video so the muxer can interleave without buffering everything.
    const sliceSamples = sr;
    let audioFed = 0;
    const feedAudioUntil = async (sampleTarget: number) => {
      while (audioFed < Math.min(sampleTarget, totalSamples)) {
        const n = Math.min(sliceSamples, totalSamples - audioFed);
        const buf = new AudioBuffer({ length: n, numberOfChannels: channels, sampleRate: sr });
        const tmp = new Float32Array(n);
        for (let c = 0; c < channels; c++) {
          pcm.read(c, startSample + audioFed, tmp); // past the end stays silent (zero)
          buf.copyToChannel(tmp, c);
        }
        await guard(audioSource.add(buf));
        audioFed += n;
      }
    };

    const t0 = performance.now();
    let lastReport = 0;
    for (let i = 0; i < totalFrames; i++) {
      if (aborted()) throw new ExportCanceledError();
      await feedAudioUntil(Math.round(((i + 1) / fps + 1) * sr));

      render(ctx, start + i / fps);
      await guard(videoSource.add(i / fps, 1 / fps));

      const now = performance.now();
      if (onProgress && (now - lastReport > 100 || i === totalFrames - 1)) {
        lastReport = now;
        const elapsedMs = now - t0;
        onProgress({
          frame: i + 1,
          totalFrames,
          fraction: (i + 1) / totalFrames,
          elapsedMs,
          speed: (i + 1) / fps / (elapsedMs / 1000),
        });
        // Give the UI a chance to paint progress.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    await feedAudioUntil(totalSamples);
    if (aborted()) throw new ExportCanceledError();

    videoSource.close();
    audioSource.close();
    await guard(output.finalize());

    if (target instanceof BufferTarget) {
      const buffer = target.buffer!;
      return { blob: new Blob([buffer], { type: 'video/mp4' }), bytes: buffer.byteLength, aacDelay, usedWasmAac, videoCodec };
    }
    return { bytes: 0, aacDelay, usedWasmAac, videoCodec };
  } catch (err) {
    if (output.state !== 'canceled' && output.state !== 'finalized') await output.cancel().catch(() => {});
    if (aborted()) throw new ExportCanceledError();
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function bufferPcm(buffer: AudioBuffer): PcmSource {
  return {
    sampleRate: buffer.sampleRate,
    numberOfChannels: buffer.numberOfChannels,
    duration: buffer.duration,
    read(c, start, out) {
      const src = buffer.getChannelData(c);
      out.fill(0);
      if (start < src.length) out.set(src.subarray(Math.max(0, start), Math.min(src.length, start + out.length)));
    },
  };
}
