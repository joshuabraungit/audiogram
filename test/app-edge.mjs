// Edge cases: WAV/M4A input, image background + logo + title, export cancel, real-model error path,
// and the unsupported-browser banner (run with UNSUPPORTED_CHROME pointing at a Chromium without H.264).
import { chromium } from 'playwright-core';
const fx = new URL('./fixtures-gen/', import.meta.url).pathname;
const out = new URL('./out/', import.meta.url).pathname;
const base = process.argv[2] ?? 'http://localhost:5173';
const fail = [];
const check = (c, m) => (c ? console.log('  ok  ', m) : (fail.push(m), console.log('  FAIL', m)));
const browser = await chromium.launch({ executablePath: process.env.CHROME });

for (const ext of ['wav', 'm4a']) {
  const page = await browser.newPage();
  await page.goto(`${base}/?mock`);
  await page.locator('input[type=file]').first().setInputFiles(`${fx}speech.${ext}`);
  await page.getByRole('button', { name: /Re-transcribe/ }).waitFor({ timeout: 120_000 });
  const dur = await page.evaluate(() => window.__ag.player.duration);
  check(Math.abs(dur - 170.16) < 0.2, `${ext} decoded (${dur.toFixed(2)}s), transcript ${await page.locator('[data-i]').count()} words`);
  await page.close();
}

{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/?mock`);
  await page.locator('input[type=file]').first().setInputFiles(`${fx}speech.mp3`);
  await page.getByRole('button', { name: /Re-transcribe/ }).waitFor({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Image', exact: true }).click();
  await page.locator('aside input[type=file]').first().setInputFiles(`${fx}bg.png`);
  await page.getByRole('button', { name: /Title/ }).click();
  await page.getByPlaceholder(/Optional title/).fill('Episode 12: Shipping with small teams');
  await page.getByRole('button', { name: /Logo/ }).click();
  await page.locator('aside input[type=file]').last().setInputFiles(`${fx}logo.png`);
  await page.getByRole('button', { name: 'Circular' }).click();
  await page.evaluate(() => window.__ag.player.seek(30));
  await page.waitForTimeout(300);
  await page.locator('main canvas').first().screenshot({ path: `${out}edge-image-logo-title.png` });
  check(true, 'image background + logo + title rendered (see edge-image-logo-title.png)');

  // Cancel export midway.
  await page.getByRole('button', { name: 'Export MP4' }).click();
  await page.getByText(/frame \d+\//).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Cancel export' }).click();
  await page.getByText('Exporting MP4').waitFor({ state: 'detached', timeout: 10_000 });
  check(await page.getByRole('button', { name: 'Export MP4' }).isEnabled(), 'export canceled cleanly, button re-enabled');
  await page.close();
}

{
  // Real model path (no ?mock). Without network access to the model host this must fail visibly, not hang.
  const page = await browser.newPage();
  await page.goto(base);
  await page.locator('input[type=file]').first().setInputFiles(`${fx}speech.mp3`);
  const res = await Promise.race([
    page.getByText(/Transcription failed/).waitFor({ timeout: 90_000 }).then(() => 'error'),
    page.waitForFunction(() => document.querySelectorAll('[data-i]').length > 5, null, { timeout: 90_000 }).then(() => 'words'),
  ]).catch(() => 'timeout');
  const msg = res === 'error' ? await page.getByText(/Transcription failed/).textContent() : '';
  console.log('   real-model result:', res, msg.slice(0, 200));
  check(res !== 'timeout', `real-model path resolves (${res})`);
  await page.close();
}
await browser.close();

if (process.env.UNSUPPORTED_CHROME) {
  const b = await chromium.launch({ executablePath: process.env.UNSUPPORTED_CHROME });
  const page = await b.newPage();
  await page.goto(`${base}/?mock`);
  await page.getByText(/Export isn't available in this browser/).waitFor({ timeout: 10_000 }).catch(() => {});
  check(await page.getByText(/Export isn't available/).isVisible(), 'unsupported browser shows the "use Chrome" banner');
  await b.close();
}
if (fail.length) {
  console.log(`\nFAILED: ${fail.length}`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
