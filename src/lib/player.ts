/**
 * Plays the decoded AudioBuffer through Web Audio. The clock is AudioContext time, so the preview's
 * currentTime is sample-accurate and the canvas can be drawn from it the same way the exporter does.
 */
export class Player {
  private ctx: AudioContext | null = null;
  private node: AudioBufferSourceNode | null = null;
  private startedAt = 0; // ctx time when playback (re)started
  private offset = 0; // source time at startedAt
  private listeners = new Set<() => void>();
  playing = false;
  /** playback stops (and loops back) at this source time */
  stopAt = Infinity;
  loopStart = 0;

  constructor(private buffer: AudioBuffer) {}

  get duration() {
    return this.buffer.duration;
  }

  get time(): number {
    if (!this.playing || !this.ctx) return this.offset;
    const t = this.offset + (this.ctx.currentTime - this.startedAt);
    if (t >= Math.min(this.stopAt, this.buffer.duration)) {
      this.pause();
      this.offset = Math.min(this.stopAt, this.buffer.duration);
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
    const end = Math.min(this.stopAt, this.buffer.duration);
    if (this.offset >= end - 0.01 || this.offset < this.loopStart) this.offset = this.loopStart;
    const node = this.ctx.createBufferSource();
    node.buffer = this.buffer;
    node.connect(this.ctx.destination);
    // Compensate for output latency so what you hear lines up with what you see.
    const latency = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    this.startedAt = this.ctx.currentTime + latency;
    node.start(this.ctx.currentTime, this.offset);
    this.node = node;
    this.playing = true;
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    const t = this.time;
    this.playing = false;
    this.offset = Math.max(0, t);
    try {
      this.node?.stop();
    } catch {
      /* already stopped */
    }
    this.node?.disconnect();
    this.node = null;
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else void this.play();
  }

  seek(t: number) {
    const was = this.playing;
    if (was) this.pause();
    this.offset = Math.max(0, Math.min(this.buffer.duration, t));
    if (was) void this.play();
    else this.emit();
  }

  dispose() {
    this.pause();
    void this.ctx?.close();
    this.listeners.clear();
  }
}
