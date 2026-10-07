import type { WorkerIn, WorkerOut } from '../workers/whisper.worker';
import type { Word } from './types';

export const MODELS = [
  { id: 'onnx-community/whisper-base.en_timestamped', label: 'Base (English) · balanced', size: '~150 MB' },
  { id: 'onnx-community/whisper-tiny.en_timestamped', label: 'Tiny (English) · fastest', size: '~75 MB' },
  { id: 'onnx-community/whisper-small.en_timestamped', label: 'Small (English) · most accurate, slow', size: '~400 MB' },
  { id: 'onnx-community/whisper-base_timestamped', label: 'Base (multilingual)', size: '~150 MB' },
];

export interface TranscribeProgress {
  stage: 'loading' | 'downloading' | 'transcribing';
  message: string;
  /** 0..1 */
  fraction: number;
  device?: 'webgpu' | 'wasm';
}

export interface TranscribeHandle {
  promise: Promise<Word[]>;
  cancel: () => void;
}

/**
 * Runs Whisper in a dedicated worker. Each call gets a fresh promise; cancel() terminates the worker
 * immediately (the model cache in the browser's Cache Storage survives, so reloading is quick).
 */
export function transcribe(
  audio16k: Float32Array,
  opts: { model: string; language?: string | null; mock?: boolean },
  onProgress: (p: TranscribeProgress) => void,
  onWords: (words: Word[]) => void,
): TranscribeHandle {
  const worker = new Worker(new URL('../workers/whisper.worker.ts', import.meta.url), { type: 'module' });
  const downloads = new Map<string, { loaded: number; total: number }>();
  let device: 'webgpu' | 'wasm' | undefined;
  let reject!: (e: Error) => void;
  const promise = new Promise<Word[]>((resolve, rej) => {
    reject = rej;
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      switch (m.type) {
        case 'status':
          onProgress({ stage: m.message.startsWith('Transcrib') ? 'transcribing' : 'loading', message: m.message, fraction: 0, device });
          break;
        case 'download': {
          downloads.set(m.file, { loaded: m.loaded, total: m.total });
          let loaded = 0;
          let total = 0;
          downloads.forEach((d) => {
            loaded += d.loaded;
            total += d.total;
          });
          const mb = (x: number) => (x / 1e6).toFixed(0);
          onProgress({
            stage: 'downloading',
            message: `Downloading model ${mb(loaded)} / ${mb(total)} MB (first time only)`,
            fraction: total ? loaded / total : 0,
          });
          break;
        }
        case 'device':
          device = m.device;
          break;
        case 'chunk':
          onWords(m.words);
          onProgress({
            stage: 'transcribing',
            message: `Transcribing… ${fmt(m.processedSec)} / ${fmt(m.totalSec)}`,
            fraction: m.processedSec / m.totalSec,
            device,
          });
          break;
        case 'done':
          worker.terminate();
          resolve(m.words);
          break;
        case 'error':
          worker.terminate();
          rej(new Error(m.message));
          break;
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      rej(new Error(e.message || 'Transcription worker crashed'));
    };
  });
  const msg: WorkerIn = { type: 'transcribe', audio: audio16k, model: opts.model, language: opts.language ?? null, mock: opts.mock };
  // Transfer instead of copying: a 30 min file is ~115 MB at 16 kHz.
  worker.postMessage(msg, [audio16k.buffer]);
  return {
    promise,
    cancel: () => {
      worker.terminate();
      reject(new Error('canceled'));
    },
  };
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
