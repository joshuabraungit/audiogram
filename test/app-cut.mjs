// Text-based editing end to end: select words, Delete cuts their audio, undo/redo, click-to-restore, and the
// exported MP4 really has the audio removed (verified by cross-correlating against the source).
// Usage: CHROME=/path/to/chrome node test/app-cut.mjs [base url]
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const fx = new URL('./fixtures-gen/', import.meta.url).pathname;
const out = new URL('./out/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const base = process.argv[2] ?? 'http://localhost:5173';
const fail = [];
const check = (c, m) => (c ? console.log('  ok  ', m) : (fail.push(m), console.log('  FAIL', m)));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/?mock`);
await page.locator('input[type=file]').first().setInputFiles(`${fx}speech.mp3`);
await page.getByRole('button', { name: /Re-transcribe/ }).waitFor({ timeout: 120_000 });

const dur = () => page.evaluate(() => window.__ag.player.duration);
const startOf = async (i) => Number((await page.locator(`[data-i="${i}"]`).getAttribute('title')).split('s')[0]);
const D0 = await dur();
const s10 = await startOf(10);
const s20 = await startOf(20);

// Drag-select words 10..19 and press Delete.
const box = async (i) => (await page.locator(`[data-i="${i}"]`).boundingBox());
const b10 = await box(10);
const b19 = await box(19);
await page.mouse.move(b10.x + 4, b10.y + b10.height / 2);
await page.mouse.down();
await page.mouse.move(b19.x + b19.width / 2, b19.y + b19.height / 2, { steps: 8 });
await page.mouse.up();
await page.keyboard.press('Delete');
await page.waitForFunction((d) => window.__ag.player.duration < d - 0.5, D0);
const D1 = await dur();
const cutLen = s20 - s10;
check((await page.locator('[data-deleted]').count()) === 10, '10 words struck through');
check(near(D0 - D1, cutLen, 0.02), `duration shrank by the cut: ${(D0 - D1).toFixed(3)}s (expected ${cutLen.toFixed(3)}s)`);
check(await page.getByText(/1 cut · −/).isVisible(), 'cut summary shown');
await page.screenshot({ path: `${out}cut-1-deleted.png` });

// Caption at the join shows word 20 (word 10..19 never appear).
const capWords = await page.evaluate((s10) => {
  const { map } = window.__ag;
  window.__ag.player.seek(map.toEdit(s10) + 0.05);
  return map.toSource(map.toEdit(s10) + 0.05);
}, s10);
check(capWords >= s20, `playhead right after the join plays source ${capWords.toFixed(2)}s (after the cut, >= ${s20.toFixed(2)}s)`);

// Live playback really skips the cut: record what the player schedules on the Web Audio clock.
const sched = await page.evaluate(async (s10) => {
  const log = [];
  const orig = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when, offset, duration) {
    log.push({ when, offset, duration });
    return orig.call(this, when, offset, duration);
  };
  const { player, map } = window.__ag;
  player.seek(map.toEdit(s10) - 1); // one second before the join
  await player.play();
  player.pause();
  AudioBufferSourceNode.prototype.start = orig;
  return log.slice(0, 2);
}, s10);
check(
  sched.length === 2 && near(sched[0].offset + sched[0].duration, s10, 0.01) && near(sched[1].offset, s20, 0.01) && near(sched[1].when - sched[0].when, sched[0].duration, 1e-6),
  `playback plays up to ${(sched[0].offset + sched[0].duration).toFixed(2)}s then jumps to ${sched[1]?.offset.toFixed(2)}s with no gap`,
);

// Undo / redo.
await page.keyboard.press('Control+z');
await page.waitForFunction((d) => Math.abs(window.__ag.player.duration - d) < 0.01, D0);
check((await page.locator('[data-deleted]').count()) === 0, 'undo restores the words and audio');
await page.keyboard.press('Control+Shift+z');
await page.waitForFunction((d) => Math.abs(window.__ag.player.duration - d) < 0.01, D1);
check((await page.locator('[data-deleted]').count()) === 10, 'redo cuts again');

// Click a struck word: whole cut comes back. Then undo that restore.
await page.locator('[data-i="14"]').click();
await page.waitForFunction((d) => Math.abs(window.__ag.player.duration - d) < 0.01, D0);
check((await page.locator('[data-deleted]').count()) === 0, 'clicking cut text restores it');
await page.keyboard.press('Control+z');
await page.waitForFunction((d) => Math.abs(window.__ag.player.duration - d) < 0.01, D1);

// Second cut via shift-click selection (words 40..44).
await page.locator('[data-i="40"]').click();
await page.locator('[data-i="44"]').click({ modifiers: ['Shift'] });
await page.keyboard.press('Backspace');
await page.waitForFunction(() => document.querySelectorAll('[data-deleted]').length === 15);
const D2 = await dur();
check(await page.getByText(/2 cuts · −/).isVisible(), `shift-click selection cut too (${(D0 - D2).toFixed(2)}s removed in total)`);

// Export the whole edited file and verify the audio really skips the cuts.
const preview = await page.evaluate(async () => {
  window.__ag.player.seek(40);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return document.querySelector('main canvas').toDataURL('image/png');
});
writeFileSync(`${out}cut-preview-40.png`, Buffer.from(preview.split(',')[1], 'base64'));
const map = await page.evaluate(() => ({ segments: window.__ag.map.segments }));
const [download] = await Promise.all([page.waitForEvent('download', { timeout: 600_000 }), page.getByRole('button', { name: 'Export MP4' }).click()]);
const file = `${out}cut-export.mp4`;
await download.saveAs(file);
await page.screenshot({ path: `${out}cut-2-exported.png` });
await browser.close();

const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]).toString());
const v = probe.streams.find((s) => s.codec_type === 'video');
check(near(Number(v.duration), D2, 0.05), `export duration ${v.duration}s matches edited length ${D2.toFixed(3)}s`);

const pcm = (f) => {
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};
const src = pcm(`${fx}speech.mp3`);
const dst = pcm(file);
// For points in each kept segment, the exported audio at edit time x must equal the source at segment start + offset.
let editStart = 0;
for (const seg of map.segments) {
  const len = seg.end - seg.start;
  if (len > 3) {
    const x = editStart + len / 2; // middle of the segment, away from fades
    const srcT = seg.start + len / 2;
    let best = -Infinity, lag = 0;
    const n = 8000, a = Math.round(x * 16000), b = Math.round(srcT * 16000);
    for (let l = -400; l <= 400; l++) {
      let c = 0;
      for (let i = 0; i < n; i += 2) c += dst[a + i] * src[b + i + l];
      if (c > best) ((best = c), (lag = l));
    }
    check(Math.abs(lag) <= 16, `export @${x.toFixed(1)}s = source @${srcT.toFixed(1)}s (lag ${((lag / 16) | 0)} ms)`);
  }
  editStart += len;
}
// WYSIWYG after cuts.
const gray = (args) => execFileSync('ffmpeg', ['-v', 'error', ...args, '-vf', 'scale=64:64', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
const e40 = gray(['-ss', '40', '-i', file, '-frames:v', '1']);
const p40 = gray(['-i', `${out}cut-preview-40.png`]);
const d = e40.reduce((s, x, i) => s + Math.abs(x - p40[i]), 0) / e40.length;
check(d < 3, `exported frame @40s matches preview (diff ${d.toFixed(2)}/255)`);
check(errors.length === 0, `no page errors ${errors.join('; ')}`);
if (fail.length) {
  console.log(`\nFAILED: ${fail.length}`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
