// Pure-logic tests. Run: node --test test/logic.test.ts  (Node 22.18+ strips types natively)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planChunks, toWords } from '../src/lib/chunks.ts';
import { buildPages, pageAt, activeWordIndex, wordAt } from '../src/lib/captions.ts';
import { editWord } from '../src/lib/editing.ts';

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
  assert.equal(del.length, words.length - 1);
  assert.equal(del[1].text, 'three');
});
