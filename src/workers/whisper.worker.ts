/// <reference lib="webworker" />
import { planChunks, toWords, type RawWordChunk } from '../lib/chunks';
import type { Word } from '../lib/types';

export type WorkerIn =
  | { type: 'transcribe'; audio: Float32Array; model: string; language: string | null; mock?: boolean }
  | { type: 'cancel' };

export type WorkerOut =
  | { type: 'status'; message: string }
  | { type: 'download'; file: string; loaded: number; total: number; progress: number }
  | { type: 'device'; device: 'webgpu' | 'wasm' }
  | { type: 'chunk'; index: number; total: number; words: Word[]; processedSec: number; totalSec: number }
  | { type: 'done'; words: Word[] }
  | { type: 'error'; message: string };

const SR = 16000;
const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m);

type Transcriber = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string; chunks?: RawWordChunk[] }>;

let loaded: { model: string; fn: Transcriber } | null = null;
let canceled = false;

async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function load(model: string): Promise<Transcriber> {
  if (loaded?.model === model) return loaded.fn;
  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowLocalModels = false;

  const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number; progress?: number }) => {
    if (p.status === 'progress' && p.file)
      post({ type: 'download', file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0, progress: p.progress ?? 0 });
  };

  const tryDevice = async (device: 'webgpu' | 'wasm') => {
    post({ type: 'status', message: `Loading ${model} (${device === 'webgpu' ? 'GPU' : 'CPU'})…` });
    const fn = (await pipeline('automatic-speech-recognition', model, {
      device,
      // Same per-device settings as the official transformers.js word-timestamp example.
      dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
      progress_callback,
    } as never)) as unknown as Transcriber;
    // Warm up (compiles WebGPU shaders) and make sure word timestamps actually work on this device.
    post({ type: 'status', message: 'Warming up model…' });
    await fn(new Float32Array(SR), { return_timestamps: 'word' });
    post({ type: 'device', device });
    return fn;
  };

  let fn: Transcriber;
  if (await hasWebGPU()) {
    try {
      fn = await tryDevice('webgpu');
    } catch (e) {
      console.warn('WebGPU failed, falling back to wasm', e);
      fn = await tryDevice('wasm');
    }
  } else fn = await tryDevice('wasm');
  loaded = { model, fn };
  return fn;
}

/** Test double: emits one fake word per ~0.35 s of non-silent audio, so the UI can be exercised offline. */
const mockTranscriber: Transcriber = async (audio) => {
  const chunks: RawWordChunk[] = [];
  const step = Math.round(SR * 0.35);
  let n = 0;
  for (let i = 0; i + step <= audio.length; i += step) {
    let e = 0;
    for (let j = i; j < i + step; j++) e += audio[j] * audio[j];
    if (Math.sqrt(e / step) > 0.01) chunks.push({ text: ` word${++n}`, timestamp: [i / SR, (i + step * 0.9) / SR] });
  }
  await new Promise((r) => setTimeout(r, 30));
  return { text: '', chunks };
};

async function transcribe(msg: Extract<WorkerIn, { type: 'transcribe' }>) {
  canceled = false;
  const fn = msg.mock ? mockTranscriber : await load(msg.model);
  const audio = msg.audio;
  const chunks = planChunks(audio, SR);
  const totalSec = audio.length / SR;
  const all: Word[] = [];
  post({ type: 'status', message: 'Transcribing…' });
  const isEnglishOnly = msg.model.includes('.en');
  for (let i = 0; i < chunks.length; i++) {
    if (canceled) return;
    const { start, end } = chunks[i];
    const slice = audio.subarray(start, end);
    // Silent chunks make Whisper hallucinate ("Thank you."), so skip them.
    let e = 0;
    for (let j = 0; j < slice.length; j += 4) e += slice[j] * slice[j];
    let words: Word[] = [];
    if (Math.sqrt(e / (slice.length / 4)) > 0.002) {
      const opts: Record<string, unknown> = { return_timestamps: 'word' };
      if (!isEnglishOnly && msg.language) opts.language = msg.language;
      const res = await fn(slice, opts);
      words = toWords(res.chunks ?? [], start / SR, end / SR, all.length);
    }
    all.push(...words);
    post({ type: 'chunk', index: i, total: chunks.length, words, processedSec: end / SR, totalSec });
  }
  post({ type: 'done', words: all });
}

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type === 'cancel') canceled = true;
  else if (msg.type === 'transcribe')
    transcribe(msg).catch((err) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
};
