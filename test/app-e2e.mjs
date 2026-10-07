// End-to-end run of the real UI in Chrome (mock transcription, since the model host may be unreachable in CI).
// Usage: CHROME=/path/to/chrome node test/app-e2e.mjs [audio file] [base url]
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const audioFile = process.argv[2] ?? new URL('./fixtures-gen/speech.mp3', import.meta.url).pathname;
const base = process.argv[3] ?? 'http://localhost:5173';
const out = new URL('./out/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const fail = [];
const check = (c, m) => (c ? console.log('  ok  ', m) : (fail.push(m), console.log('  FAIL', m)));

const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`${base}/?mock`);
await page.locator('input[type=file]').first().setInputFiles(audioFile);
await page.waitForSelector('canvas');
await page.waitForFunction(() => document.querySelectorAll('[data-i]').length > 20, null, { timeout: 60_000 });
await page.getByRole('button', { name: /Re-transcribe/ }).waitFor({ timeout: 120_000 });
const nWords = await page.locator('[data-i]').count();
check(nWords > 100, `transcript has ${nWords} words`);
await page.screenshot({ path: `${out}ui-1-loaded.png` });

// Playback advances the clock.
const t0 = await page.evaluate(() => window.__ag.player.time);
await page.keyboard.press('Space');
await page.waitForTimeout(1500);
const t1 = await page.evaluate(() => window.__ag.player.time);
await page.keyboard.press('Space');
check(t1 - t0 > 1, `playback advanced ${(t1 - t0).toFixed(2)}s`);
await page.screenshot({ path: `${out}ui-2-playing.png` });

// Edit a word: timing must stay identical.
const before = await page.locator('[data-i="3"]').getAttribute('title');
await page.locator('[data-i="3"]').dblclick();
await page.keyboard.type('EDITED');
await page.keyboard.press('Enter');
const txt = await page.locator('[data-i="3"]').textContent();
const after = await page.locator('[data-i="3"]').getAttribute('title');
check(txt === 'EDITED' && before === after, `word edited (${txt}) with timing kept (${after})`);

// Style changes.
await page.getByRole('button', { name: '9:16 Story' }).click();
await page.getByRole('button', { name: 'Circular' }).click();
await page.evaluate(() => window.__ag.player.seek(12.3));
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}ui-3-story-circular.png` });
await page.getByRole('button', { name: '16:9 Wide' }).click();
await page.getByRole('button', { name: 'Line' }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}ui-4-wide-line.png` });
await page.getByRole('button', { name: '1:1 Square' }).click();
await page.getByRole('button', { name: 'Bars' }).click();

// Trim 10s .. 2:40 (a 150 s clip) via the clip time fields.
const fields = page.locator('input.font-mono');
await fields.nth(0).fill('0:10.0');
await fields.nth(0).press('Enter');
await fields.nth(1).fill('2:40.0');
await fields.nth(1).press('Enter');

// WYSIWYG: grab the preview canvas at a few source times across the clip (start, middle, near the end).
const SAMPLE_TIMES = [25.0, 90.0, 155.0];
const fs = await import('node:fs');
for (const st of SAMPLE_TIMES) {
  const png = await page.evaluate(async (st) => {
    window.__ag.player.seek(st);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return document.querySelector('main canvas').toDataURL('image/png');
  }, st);
  fs.writeFileSync(`${out}preview-${st}s.png`, Buffer.from(png.split(',')[1], 'base64'));
}

// Export.
const [download] = await Promise.all([page.waitForEvent('download', { timeout: 600_000 }), page.getByRole('button', { name: 'Export MP4' }).click()]);
const file = `${out}app-export.mp4`;
await download.saveAs(file);
await page.getByText('Export complete').waitFor();
await page.screenshot({ path: `${out}ui-5-exported.png` });
await browser.close();

const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]).toString());
const v = probe.streams.find((s) => s.codec_type === 'video');
const a = probe.streams.find((s) => s.codec_type === 'audio');
check(v.codec_name === 'h264' && a.codec_name === 'aac', `h264 ${v.width}x${v.height} + aac`);
check(Math.abs(v.duration - 150) < 0.05 && Math.abs(a.duration - 150) < 0.06, `trimmed duration v=${v.duration} a=${a.duration}`);

// Compare exported frames with the preview at the same source time (export time = source - 10 s trim).
const gray = (args) => execFileSync('ffmpeg', ['-v', 'error', ...args, '-vf', 'scale=64:64', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
const diff = (x, y) => x.reduce((s, b, i) => s + Math.abs(b - y[i]), 0) / x.length;
for (const st of SAMPLE_TIMES) {
  const prev = gray(['-i', `${out}preview-${st}s.png`]);
  const exp = gray(['-ss', String(st - 10), '-i', file, '-frames:v', '1']);
  const other = gray(['-ss', String(st - 10 + 1.3), '-i', file, '-frames:v', '1']);
  check(diff(exp, prev) < 3, `export @${st - 10}s matches preview @${st}s (diff ${diff(exp, prev).toFixed(2)}/255; 1.3 s later: ${diff(other, prev).toFixed(2)})`);
}
execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '80', '-i', file, '-frames:v', '1', `${out}export-frame-80s.png`]);

// Audio alignment: cross-correlate exported audio against the source (shifted by the trim) at several points.
const pcm = (f) => {
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};
const src = pcm(audioFile);
const dst = pcm(file);
for (const at of [5, 75, 145]) {
  const n = 16000, base = at * 16000;
  let best = -Infinity, lag = 0;
  for (let l = -800; l <= 800; l++) {
    let c = 0;
    for (let i = 0; i < n; i += 2) c += dst[base + i] * src[base + 160000 + i + l];
    if (c > best) ((best = c), (lag = l));
  }
  check(Math.abs(lag) <= 16, `audio @${at}s aligned with source (lag ${((lag / 16000) * 1000).toFixed(1)} ms)`);
}

check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors.slice(0, 3)) : ''}`);
if (fail.length) {
  console.log(`\nFAILED: ${fail.length}`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
