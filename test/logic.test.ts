// Pure-logic tests. Run: node --test test/logic.test.ts  (Node 22.18+ strips types natively)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planChunks, toWords } from '../src/lib/chunks.ts';
import { buildPages, pageAt, activeWordIndex, wordAt } from '../src/lib/captions.ts';
import { editWord, setDeleted, deletedRun } from '../src/lib/editing.ts';
import { computeCuts, keptSegments, TimeMap, remapWords, EditedSource } from '../src/lib/edit.ts';

const SR = 16000;
function speechLike(seconds: number, gapsAt: number[]) {
  // Continuous noise ("speech") with 300 ms silences at the given times.
  const a = new Float32Array(seconds * SR);
  let seed = 1;
  for (let i = 0; i < a.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    a[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.3;
  }
  for (const g of gapsAt) a.fill(0, Math.round(g * SR), Math.round((g + 0.3) * SR));
  return a;
}

test('planChunks covers 35 min contiguously with <30 s chunks cut at silences', () => {
  const gaps: number[] = [];
  for (let t = 7; t < 35 * 60; t += 11.3) gaps.push(t);
  const audio = speechLike(35 * 60, gaps);
  const chunks = planChunks(audio, SR);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks[chunks.length - 1].end, audio.length);
  for (let i = 0; i < chunks.length; i++) {
    const len = (chunks[i].end - chunks[i].start) / SR;
    assert.ok(len <= 28.01 && len > 0, `chunk ${i} length ${len}`);
    if (i) assert.equal(chunks[i].start, chunks[i - 1].end);
    if (i < chunks.length - 1) {
      // Each cut must land inside a silence.
      const cut = chunks[i].end / SR;
      assert.ok(gaps.some((g) => cut >= g && cut <= g + 0.3), `cut ${cut.toFixed(2)} not in a gap`);
    }
  }
});

test('toWords offsets, fills null end, merges punctuation fragments', () => {
  const w = toWords(
    [
      { text: ' Hello', timestamp: [0.0, 0.4] },
      { text: ',', timestamp: [0.4, 0.45] },
      { text: ' world', timestamp: [0.5, null] },
      { text: ' ', timestamp: [0.9, 1.0] },
    ],
    10,
    12,
    5,
  );
  assert.deepEqual(
    w.map((x) => [x.id, x.text, +x.start.toFixed(2), +x.end.toFixed(2)]),
    [
      [5, 'Hello,', 10, 10.45],
      [6, 'world', 10.5, 10.9], // null end borrows the next token's start
    ],
  );
});

const words = 'one two three four. five six seven eight nine ten'.split(' ').map((text, i) => ({ id: i, text, start: i * 0.5, end: i * 0.5 + 0.4 }));
words.push({ id: 10, text: 'after', start: 10, end: 10.4 }); // long pause before this

test('buildPages respects size, sentence ends and pauses; pages never overlap', () => {
  const pages = buildPages(words, 6);
  assert.deepEqual(pages.map((p) => p.words.map((w) => w.text).join(' ')), ['one two three four.', 'five six seven eight nine ten', 'after']);
  for (let i = 1; i < pages.length; i++) assert.ok(pages[i - 1].end <= pages[i].start);
  assert.equal(pageAt(pages, 0.2)?.words[0].text, 'one');
  assert.equal(pageAt(pages, 1.95)?.words[0].text, 'one'); // short gap: stays up until the next page
  assert.equal(pageAt(pages, 2.0)?.words[0].text, 'five');
  assert.equal(pageAt(pages, 8), null); // long pause: nothing on screen
  const p = pageAt(pages, 2.6)!;
  assert.equal(p.words[activeWordIndex(p, 2.6)].text, 'six');
  assert.equal(words[wordAt(words, 3.1)].text, 'seven');
});

test('editWord keeps timing; splits and deletes', () => {
  const fixed = editWord(words, 1, 'too');
  assert.equal(fixed[1].text, 'too');
  assert.equal(fixed[1].start, words[1].start);
  assert.equal(fixed[1].end, words[1].end);
  assert.equal(fixed[2].start, words[2].start);
  const split = editWord(words, 1, 'to go');
  assert.equal(split.length, words.length + 1);
  assert.equal(split[1].start, words[1].start);
  assert.equal(split[2].end, words[1].end);
  assert.ok(split[1].end <= split[2].start + 1e-9);
  assert.deepEqual(split.map((w) => w.id), split.map((_, i) => i));
  const del = editWord(words, 1, '  ');
  assert.equal(del.length, words.length); // kept in the transcript, marked deleted (restorable)
  assert.equal(del[1].deleted, true);
  assert.equal(del[1].text, 'two');
});

// ---- text-based editing (cut audio by deleting words)
const w = (text: string, start: number, end: number) => ({ id: 0, text, start, end });
const sentence = [w('so', 0, 0.3), w('um', 0.5, 0.7), w('like', 0.8, 1.0), w('we', 1.4, 1.6), w('shipped', 1.7, 2.2), w('it', 2.3, 2.5)].map((x, i) => ({ ...x, id: i }));

test('deleting a run cuts from its first word to the next kept word', () => {
  const edited = setDeleted(sentence, 1, 2, true); // "um like"
  assert.deepEqual(computeCuts(edited, 3), [{ start: 0.5, end: 1.4 }]);
  assert.deepEqual(deletedRun(edited, 2), [1, 2]);
  // Trailing deletion only removes the word itself; leading deletion starts at its start.
  assert.deepEqual(computeCuts(setDeleted(sentence, 5, 5, true), 3), [{ start: 2.3, end: 2.5 }]);
  assert.deepEqual(computeCuts(setDeleted(sentence, 0, 0, true), 3), [{ start: 0, end: 0.5 }]);
  // Overlapping timestamps never eat into the kept neighbour.
  const overlap = [w('a', 0, 1.05), w('b', 1.0, 1.5), w('c', 1.6, 2)].map((x, i) => ({ ...x, id: i }));
  assert.deepEqual(computeCuts(setDeleted(overlap, 1, 1, true), 3), [{ start: 1.05, end: 1.6 }]);
  // Nothing deleted, nothing cut; restoring undoes the cut.
  assert.deepEqual(computeCuts(setDeleted(edited, 1, 2, false), 3), []);
});

test('TimeMap round-trips and remaps kept words', () => {
  const cuts = computeCuts(setDeleted(sentence, 1, 2, true), 3);
  const map = new TimeMap(keptSegments(cuts, 3));
  assert.ok(Math.abs(map.duration - 2.1) < 1e-9);
  assert.equal(map.toEdit(0.3), 0.3);
  assert.equal(map.toEdit(0.9), 0.5); // inside the cut collapses to the join
  assert.ok(Math.abs(map.toEdit(1.7) - 0.8) < 1e-9);
  for (const t of [0, 0.2, 0.49, 1.4, 2.0, 2.9]) assert.ok(Math.abs(map.toSource(map.toEdit(t)) - t) < 1e-9, `round trip ${t}`);
  assert.ok(Math.abs(map.toSource(0.5) - 1.4) < 1e-9); // the join plays the audio after the cut
  const kept = remapWords(setDeleted(sentence, 1, 2, true), map);
  assert.deepEqual(kept.map((x) => x.text), ['so', 'we', 'shipped', 'it']);
  assert.ok(Math.abs(kept[1].start - 0.5) < 1e-9 && Math.abs(kept[3].end - 1.6) < 1e-9);
  assert.equal(new TimeMap(keptSegments([], 3)).identity, true);
});

test('EditedSource skips cut samples with click-free joins, in any read size', () => {
  const sr = 1000;
  const src = new Float32Array(3000).fill(1);
  src.fill(9, 500, 1400); // the part that gets cut
  const map = new TimeMap(keptSegments([{ start: 0.5, end: 1.4 }], 3));
  const es = new EditedSource([src], sr, map);
  assert.equal(es.length, 500 + 1600);
  assert.ok(Math.abs(es.duration - map.duration) < 1e-9);
  // Read in odd chunk sizes (crossing the join mid-chunk) and compare with one big read.
  const whole = new Float32Array(es.length);
  es.read(0, 0, whole);
  const pieces = new Float32Array(es.length);
  for (let pos = 0; pos < es.length; pos += 137) {
    const n = Math.min(137, es.length - pos);
    const tmp = new Float32Array(n);
    es.read(0, pos, tmp);
    pieces.set(tmp, pos);
  }
  assert.deepEqual(pieces, whole);
  assert.ok(whole.every((v) => v <= 1), 'no cut audio leaks through');
  assert.equal(whole[0], 1); // file start untouched
  assert.equal(whole[499 - 10], 1); // fades are only a few ms around the join
  assert.ok(whole[499] < 0.2 && whole[500] < 0.2, 'join faded to near silence');
  assert.equal(whole[whole.length - 1], 1); // file end untouched
  const past = new Float32Array(10).fill(5);
  es.read(0, es.length + 3, past);
  assert.ok(past.every((v) => v === 0), 'reading past the end is silence');
});
