import type { Word } from './types';

export interface Range {
  start: number;
  end: number;
}

/**
 * Source-time ranges to remove for the words marked deleted. A run of deleted words is cut from the first
 * deleted word's start up to the next kept word's start, so the pause *before* the run stays and the pause
 * after it goes (that is what sounds natural, and it is how Descript behaves).
 */
export function computeCuts(words: Word[], duration: number): Range[] {
  const cuts: Range[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!words[i].deleted) continue;
    let j = i;
    while (j + 1 < words.length && words[j + 1].deleted) j++;
    const prev = i > 0 ? words[i - 1] : null;
    const next = j + 1 < words.length ? words[j + 1] : null;
    // Whisper timestamps can overlap slightly; never eat into the kept neighbours.
    const start = Math.max(words[i].start, prev ? prev.end : 0);
    const end = Math.min(next ? next.start : words[j].end, duration);
    if (end - start > 0.01) {
      const last = cuts[cuts.length - 1];
      if (last && start <= last.end) last.end = Math.max(last.end, end);
      else cuts.push({ start: Math.max(0, start), end });
    }
    i = j;
  }
  return cuts;
}

/** The parts of [0, duration) that survive the cuts, in order. */
export function keptSegments(cuts: Range[], duration: number): Range[] {
  const out: Range[] = [];
  let t = 0;
  for (const c of cuts) {
    if (c.start > t) out.push({ start: t, end: c.start });
    t = Math.max(t, c.end);
  }
  if (t < duration) out.push({ start: t, end: duration });
  return out;
}

/** Maps between source time (original file) and edit time (after cuts). */
export class TimeMap {
  readonly duration: number;
  readonly segments: Range[];
  private editStarts: number[] = [];

  constructor(segments: Range[]) {
    this.segments = segments;
    let acc = 0;
    for (const s of segments) {
      this.editStarts.push(acc);
      acc += s.end - s.start;
    }
    this.duration = acc;
  }

  get identity() {
    return this.segments.length === 1 && this.segments[0].start === 0;
  }

  /** Source → edit. Times inside a cut collapse to the join point. */
  toEdit(t: number): number {
    const segs = this.segments;
    if (!segs.length || t <= segs[0].start) return 0;
    // Last segment starting at or before t.
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    const s = segs[lo];
    return t < s.end ? this.editStarts[lo] + (t - s.start) : lo + 1 < segs.length ? this.editStarts[lo + 1] : this.duration;
  }

  /** Edit → source. A join point maps to the start of the segment after the cut. */
  toSource(x: number): number {
    const segs = this.segments;
    if (!segs.length) return 0;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.editStarts[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    const s = segs[lo];
    return Math.min(s.end, s.start + Math.max(0, x - this.editStarts[lo]));
  }
}

/** Kept words re-timed onto the edit timeline (what the captions show). */
export function remapWords(words: Word[], map: TimeMap): Word[] {
  if (map.identity) return words.filter((w) => !w.deleted);
  const out: Word[] = [];
  for (const w of words) {
    if (w.deleted) continue;
    const start = map.toEdit(w.start);
    out.push({ ...w, start, end: Math.max(start, map.toEdit(w.end)) });
  }
  return out;
}

/** Anything the exporter can pull PCM from. */
export interface PcmSource {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly duration: number;
  /** Fills `out` with channel c starting at sample `start`; past the end is silence. */
  read(c: number, start: number, out: Float32Array): void;
}

/**
 * The edited audio, without copying it: reads go through the kept segments of the original channels,
 * applying the same join fades as spliceChannel. Cutting is instant and costs no extra memory, which
 * matters for 30+ minute files.
 */
export class EditedSource implements PcmSource {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly duration: number;
  private channels: Float32Array[];
  private segs: { src: number; n: number; at: number }[] = [];
  private fade: number;
  readonly length: number;

  constructor(channels: Float32Array[], sampleRate: number, map: TimeMap, fadeSec = 0.006) {
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.numberOfChannels = channels.length;
    this.fade = Math.round(fadeSec * sampleRate);
    let at = 0;
    for (const s of map.segments) {
      const a = Math.round(s.start * sampleRate);
      const b = Math.min(channels[0].length, Math.round(s.end * sampleRate));
      if (b <= a) continue;
      this.segs.push({ src: a, n: b - a, at });
      at += b - a;
    }
    this.length = at;
    this.duration = at / sampleRate;
  }

  static fromBuffer(buffer: AudioBuffer, map: TimeMap) {
    const ch = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    return new EditedSource(ch, buffer.sampleRate, map);
  }

  read(c: number, start: number, out: Float32Array) {
    out.fill(0);
    const src = this.channels[c];
    const segs = this.segs;
    if (!segs.length) return;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].at <= start) lo = mid;
      else hi = mid - 1;
    }
    let pos = 0;
    for (let k = lo; k < segs.length && pos < out.length; k++) {
      const s = segs[k];
      const from = Math.max(0, start + pos - s.at); // offset inside this segment
      if (from >= s.n) continue;
      const take = Math.min(s.n - from, out.length - pos);
      out.set(src.subarray(s.src + from, s.src + from + take), pos);
      const f = Math.min(this.fade, s.n >> 1);
      if (f > 0) {
        for (let i = 0; i < take; i++) {
          const j = from + i; // index within the segment
          let g = 1;
          if (k > 0 && j < f) g = j / f;
          if (k < segs.length - 1 && s.n - 1 - j < f) g = Math.min(g, (s.n - 1 - j) / f);
          if (g < 1) out[pos + i] *= g;
        }
      }
      pos += take;
    }
  }
}

/** What the renderer and timeline need from audio analysis. */
export interface Analysis {
  readonly envelope: Float32Array;
  level(t: number): number;
  bands(t: number): Float32Array;
}

const ENV_RATE = 100;

/** Presents the original file's analysis on the edit timeline (no re-analysis needed after a cut). */
export function editedAnalysis(base: Analysis, map: TimeMap): Analysis {
  if (map.identity) return base;
  const env = new Float32Array(Math.ceil(map.duration * ENV_RATE));
  for (let k = 0; k < env.length; k++) {
    const i = Math.round(map.toSource(k / ENV_RATE) * ENV_RATE);
    env[k] = base.envelope[Math.min(i, base.envelope.length - 1)] ?? 0;
  }
  return {
    envelope: env,
    level: (t) => base.level(map.toSource(t)),
    bands: (t) => base.bands(map.toSource(t)),
  };
}
