// 30+ minute file through the real UI: decode, analysis, chunked (mock) transcription, clip export near the end.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
const fx = new URL('./fixtures-gen/', import.meta.url).pathname;
const out = new URL('./out/', import.meta.url).pathname;
const base = process.argv[2] ?? 'http://localhost:5173';
const fail = [];
const check = (c, m) => (c ? console.log('  ok  ', m) : (fail.push(m), console.log('  FAIL', m)));
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('crash', () => errors.push('PAGE CRASHED'));
await page.goto(`${base}/?mock`);
let t = Date.now();
await page.locator('input[type=file]').first().setInputFiles(`${fx}long.mp3`);
await page.waitForFunction(() => window.__ag?.player, null, { timeout: 300_000 });
const dur = await page.evaluate(() => window.__ag.player.duration);
check(dur > 30 * 60, `decoded ${(dur / 60).toFixed(1)} min in ${((Date.now() - t) / 1000).toFixed(1)}s`);
t = Date.now();
await page.getByRole('button', { name: /Re-transcribe/ }).waitFor({ timeout: 600_000 });
const words = await page.locator('[data-i]').count();
check(words > 5000, `chunked transcription finished: ${words} words in ${((Date.now() - t) / 1000).toFixed(1)}s`);
const mem = await page.evaluate(() => performance.memory?.usedJSHeapSize / 1e6);
console.log(`   JS heap ${mem?.toFixed(0)} MB (audio sample buffers live outside the JS heap)`);

// Playback near the end + transcript scroll.
await page.evaluate(() => window.__ag.player.seek(35 * 60));
await page.keyboard.press('Space');
await page.waitForTimeout(1200);
await page.keyboard.press('Space');
await page.screenshot({ path: `${out}long-ui.png` });

// Export a 20 s clip from 35:00.
const fields = page.locator('input.font-mono');
await fields.nth(1).fill('35:20.0');
await fields.nth(1).press('Enter');
await fields.nth(0).fill('35:00.0');
await fields.nth(0).press('Enter');
const [download] = await Promise.all([page.waitForEvent('download', { timeout: 300_000 }), page.getByRole('button', { name: 'Export MP4' }).click()]);
const file = `${out}long-clip.mp4`;
await download.saveAs(file);
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]).toString());
const v = probe.streams.find((s) => s.codec_type === 'video');
check(Math.abs(v.duration - 20) < 0.05, `clip exported (${v.duration}s)`);
check(errors.length === 0, `no crashes/errors ${errors.join('; ')}`);
await browser.close();
if (fail.length) process.exit(1);
console.log('\nALL CHECKS PASSED');
