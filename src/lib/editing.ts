import type { Word } from './types';

/**
 * Replaces word `index` with `text` while keeping its time span. Typing several words splits the span
 * proportionally to their length; clearing the text deletes the word. Neighbouring words are untouched.
 */
export function editWord(words: Word[], index: number, text: string): Word[] {
  const w = words[index];
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const total = parts.reduce((a, p) => a + p.length, 0);
  const replacement: Word[] = [];
  let cursor = w.start;
  for (const p of parts) {
    const dur = ((w.end - w.start) * p.length) / total;
    replacement.push({ id: 0, text: p, start: cursor, end: cursor + dur });
    cursor += dur;
  }
  if (replacement.length) replacement[replacement.length - 1].end = w.end;
  const next = [...words.slice(0, index), ...replacement, ...words.slice(index + 1)];
  return next.map((x, i) => ({ ...x, id: i }));
}
