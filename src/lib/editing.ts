import type { Word } from './types';

/**
 * Replaces word `index` with `text` while keeping its time span. Typing several words splits the span
 * proportionally to their length; clearing the text marks the word deleted (cutting its audio, restorable).
 * Neighbouring words are untouched.
 */
export function editWord(words: Word[], index: number, text: string): Word[] {
  const w = words[index];
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return setDeleted(words, index, index, true);
  const total = parts.reduce((a, p) => a + p.length, 0);
  const replacement: Word[] = [];
  let cursor = w.start;
  for (const p of parts) {
    const dur = ((w.end - w.start) * p.length) / total;
    replacement.push({ id: 0, text: p, start: cursor, end: cursor + dur, ...(w.deleted ? { deleted: true } : {}) });
    cursor += dur;
  }
  if (replacement.length) replacement[replacement.length - 1].end = w.end;
  const next = [...words.slice(0, index), ...replacement, ...words.slice(index + 1)];
  return next.map((x, i) => ({ ...x, id: i }));
}

/** Marks words [from, to] (inclusive, any order) deleted or restored. */
export function setDeleted(words: Word[], from: number, to: number, deleted: boolean): Word[] {
  const [a, b] = from <= to ? [from, to] : [to, from];
  return words.map((w, i) => (i >= a && i <= b && !!w.deleted !== deleted ? { ...w, deleted } : w));
}

/** Index range of the contiguous run of deleted words containing index i. */
export function deletedRun(words: Word[], i: number): [number, number] {
  let a = i;
  let b = i;
  while (a > 0 && words[a - 1].deleted) a--;
  while (b < words.length - 1 && words[b + 1].deleted) b++;
  return [a, b];
}
