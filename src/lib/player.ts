import type { TimeMap } from './edit';

const FADE = 0.006; // same join fade as the exporter (EditedSource)

/**
 * Plays the decoded AudioBuffer through Web Audio, skipping transcript cuts: each kept segment is scheduled
 * back to back on the audio clock, so `time` is edit time and stays sample-accurate. The clock is AudioContext time, so the preview's
 * currentTime is sample-accurate and the canvas can be drawn from it the same way the exporter does.
 */
export class Player {
  private ctx: AudioContext | null = null;
  private nodes: AudioScheduledSourceNode[] = [];
  private gains: GainNode[] = [];
  private startedAt = 0; // ctx time when playback (re)started
  private offset = 0; // source time at startedAt
  private listeners = new Set<() => void>();
  playing = false;
  /** playback stops (and loops back) at this source time */
  stopAt = Infinity;
  loopStart = 0;

  private buffer: AudioBuffer;
  private map: TimeMap | null;

  constructor(buffer: AudioBuffer, map: TimeMap | null = null) {
    this.buffer = buffer;
    this.map = map && !map.identity ? map : null;
  }

  /** Edit-timeline duration (after cuts). */
  get duration() {
    return this.map ? this.map.duration : this.buffer.duration;
  }

  get time(): number {
    if (!this.playing || !this.ctx) return this.offset;
    const t = this.offset + (this.ctx.currentTime - this.startedAt);
    if (t >= Math.min(this.stopAt, this.duration)) {
      this.pause();
      this.offset = Math.min(this.stopAt, this.duration);
      this.emit();
      return this.offset;
    }
    return t;
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((f) => f());
  }

  async play() {
    if (this.playing) return;
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate: this.buffer.sampleRate, latencyHint: 'playback' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const end = Math.min(this.stopAt, this.duration);
    if (this.offset >= end - 0.01 || this.offset < this.loopStart) this.offset = this.loopStart;
    const ctx = this.ctx;
    // Compensate for output latency so what you hear lines up with what you see.
    const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    const t0 = ctx.currentTime + 0.02; // small lead so the first segments are scheduled in time
    this.startedAt = t0 + latency;
    const segs = this.map ? this.map.segments : [{ start: 0, end: this.buffer.duration }];
    let editAt = 0;
    segs.forEach((seg, k) => {
      const len = seg.end - seg.start;
      const segEditEnd = editAt + len;
      if (segEditEnd > this.offset) {
        const into = Math.max(0, this.offset - editAt); // offset inside this segment
        const when = t0 + (editAt + into - this.offset);
        const node = ctx.createBufferSource();
        node.buffer = this.buffer;
        const gain = ctx.createGain();
        node.connect(gain).connect(ctx.destination);
        const dur = len - into;
        if (k > 0 && into === 0) {
          gain.gain.setValueAtTime(0, when);
          gain.gain.linearRampToValueAtTime(1, when + FADE);
        }
        if (k < segs.length - 1) {
          gain.gain.setValueAtTime(1, Math.max(when, when + dur - FADE));
          gain.gain.linearRampToValueAtTime(0, when + dur);
        }
        node.start(when, seg.start + into, dur);
        this.nodes.push(node);
        this.gains.push(gain);
      }
      editAt = segEditEnd;
    });
    this.playing = true;
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    const t = this.time;
    this.playing = false;
    this.offset = Math.max(0, t);
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
      n.disconnect();
    }
    this.gains.forEach((g) => g.disconnect());
    this.nodes = [];
    this.gains = [];
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else void this.play();
  }

  seek(t: number) {
    const was = this.playing;
    if (was) this.pause();
    this.offset = Math.max(0, Math.min(this.duration, t));
    if (was) void this.play();
    else this.emit();
  }

  dispose() {
    this.pause();
    void this.ctx?.close();
    this.listeners.clear();
  }
}
