import type { Word } from './types';

export interface Chunk {
  start: number; // sample index
  end: number;
}

/**
 * Splits audio into windows Whisper can take in one pass (< 30 s), cutting at the quietest moment near each
 * boundary so words are never sliced in half. Works on any length: a 30+ min file is just more chunks, and
 * only one chunk is ever handed to the model at a time.
 */
export function planChunks(audio: Float32Array, sampleRate: number, maxSec = 28, minSec = 18): Chunk[] {
  const chunks: Chunk[] = [];
  const win = Math.round(sampleRate * 0.05); // 50 ms energy windows
  const maxLen = Math.round(maxSec * sampleRate);
  const minLen = Math.round(minSec * sampleRate);
  let start = 0;
  while (start < audio.length) {
    if (audio.length - start <= maxLen) {
      chunks.push({ start, end: audio.length });
      break;
    }
    let bestPos = start + maxLen;
    let bestEnergy = Infinity;
    for (let p = start + minLen; p + win <= start + maxLen; p += win) {
      let e = 0;
      for (let i = p; i < p + win; i++) e += audio[i] * audio[i];
      // Slight preference for later cuts so chunks stay long (fewer boundaries).
      const score = e * (1 + (0.15 * (start + maxLen - p)) / maxLen);
      if (score < bestEnergy) {
        bestEnergy = score;
        bestPos = p + (win >> 1);
      }
    }
    chunks.push({ start, end: bestPos });
    start = bestPos;
  }
  return chunks;
}

export interface RawWordChunk {
  text: string;
  timestamp: [number, number | null];
}

/** Converts transformers.js word chunks (relative to a chunk) into absolute, cleaned words. */
export function toWords(raw: RawWordChunk[], offsetSec: number, chunkEndSec: number, firstId: number): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < raw.length; i++) {
    const text = raw[i].text.trim();
    if (!text) continue;
    let [s, e] = raw[i].timestamp;
    if (e === null || !Number.isFinite(e)) e = raw[i + 1]?.timestamp[0] ?? chunkEndSec - offsetSec;
    s = Math.max(0, s);
    if (e < s) e = s;
    out.push({ id: firstId + out.length, text, start: offsetSec + s, end: Math.min(offsetSec + e, chunkEndSec) });
  }
  // Whisper can attach a token-less fragment like "'s" or "," as its own word: glue it to the previous one.
  const merged: Word[] = [];
  for (const w of out) {
    const prev = merged[merged.length - 1];
    if (prev && /^[.,!?;:%'’)\]]/.test(w.text)) {
      prev.text += w.text;
      prev.end = Math.max(prev.end, w.end);
    } else merged.push(w);
  }
  return merged.map((w, i) => ({ ...w, id: firstId + i }));
}
