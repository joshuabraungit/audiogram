// Drives export-test.html in Chrome, saves the MP4, then verifies it with ffprobe/ffmpeg:
//  - H.264 + AAC streams, yuv420p, faststart (moov before mdat)
//  - durations match
//  - every audio beep onset lines up with its video flash (A/V sync)
// Usage: CHROME=/path/to/chrome node test/export-test.mjs [seconds] [WxH] [base url]
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';

const seconds = Number(process.argv[2] ?? 130);
const [width, height] = (process.argv[3] ?? '1080x1920').split('x').map(Number);
const base = process.argv[4] ?? 'http://localhost:5173';
const stream = process.env.STREAM === '1';
const start = 0.3; // also exercises the trim offset
const end = seconds - 0.2;
const outDir = new URL('./out/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
const file = `${outDir}export-${seconds}s-${width}x${height}${process.env.STREAM === '1' ? '-stream' : ''}.mp4`;

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ acceptDownloads: true });
page.on('console', (m) => console.log('[page]', m.text()));
await page.goto(`${base}/export-test.html`);
await page.waitForFunction(() => 'runExportTest' in window);
const t0 = Date.now();
const [download, result] = await Promise.all([
  page.waitForEvent('download', { timeout: 30 * 60_000 }),
  page.evaluate((p) => window.runExportTest(p), { seconds, start, end, width, height, stream }),
]);
await download.saveAs(file);
await browser.close();
console.log('export result', result, `in ${((Date.now() - t0) / 1000).toFixed(1)}s ->`, file);

// ---- container / stream checks
const probe = JSON.parse(
  execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString(),
);
const v = probe.streams.find((s) => s.codec_type === 'video');
const a = probe.streams.find((s) => s.codec_type === 'audio');
const fail = [];
const check = (cond, msg) => (cond ? console.log('  ok  ', msg) : (fail.push(msg), console.log('  FAIL', msg)));
check(v?.codec_name === 'h264', `video codec h264 (${v?.codec_name} ${v?.profile})`);
check(v?.pix_fmt === 'yuv420p', `pix_fmt yuv420p (${v?.pix_fmt})`);
check(v?.width === width && v?.height === height, `size ${v?.width}x${v?.height}`);
check(v?.r_frame_rate === '30/1', `frame rate ${v?.r_frame_rate}`);
check(a?.codec_name === 'aac', `audio codec aac (${a?.codec_name} ${a?.profile} ${a?.sample_rate}Hz ${a?.channels}ch)`);
const expected = end - start;
check(Math.abs(Number(v.duration) - expected) < 0.05, `video duration ${v.duration} ~ ${expected.toFixed(3)}`);
check(Math.abs(Number(a.duration) - expected) < 0.06, `audio duration ${a.duration} ~ ${expected.toFixed(3)}`);
const bytes = readFileSync(file);
const top = [];
for (let o = 0; o + 8 <= bytes.length; ) {
  let size = bytes.readUInt32BE(o);
  const type = bytes.toString('latin1', o + 4, o + 8);
  if (size === 1) size = Number(bytes.readBigUInt64BE(o + 8));
  top.push(type);
  if (size < 8) break;
  o += size;
}
check(top.indexOf('moov') !== -1 && top.indexOf('moov') < top.indexOf('mdat'), `faststart: moov before mdat (${top.join(' ')})`);

// ---- A/V sync: decode both tracks and find beep onsets / flash onsets.
const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], {
  maxBuffer: 1 << 30,
});
const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
const audioOnsets = [];
{
  const win = 48; // 1ms windows
  let on = false;
  for (let i = 0; i + win < samples.length; i += win) {
    let m = 0;
    for (let j = 0; j < win; j++) m = Math.max(m, Math.abs(samples[i + j]));
    if (!on && m > 0.2) {
      audioOnsets.push(i / 48000);
      on = true;
    } else if (on && m < 0.05) on = false;
  }
}
const W = 8, H = 8;
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${W}:${H}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], {
  maxBuffer: 1 << 30,
});
const frames = raw.length / (W * H);
const videoOnsets = [];
let prevOn = false;
for (let f = 0; f < frames; f++) {
  let sum = 0;
  for (let k = 0; k < W * H; k++) sum += raw[f * W * H + k];
  const isOn = sum / (W * H) > 128;
  if (isOn && !prevOn) videoOnsets.push(f / 30);
  prevOn = isOn;
}
console.log(`  audio onsets: ${audioOnsets.length}, video flashes: ${videoOnsets.length}, frames: ${frames}`);
check(audioOnsets.length > 0 && audioOnsets.length === videoOnsets.length, 'same number of beeps and flashes');
let worst = 0;
const offsets = [];
for (let k = 0; k < Math.min(audioOnsets.length, videoOnsets.length); k++) {
  const d = videoOnsets[k] - audioOnsets[k];
  offsets.push(d);
  worst = Math.max(worst, Math.abs(d));
}
const first = offsets.slice(0, 3).map((x) => (x * 1000).toFixed(1));
const last = offsets.slice(-3).map((x) => (x * 1000).toFixed(1));
console.log(`  offsets video-audio (ms) first: ${first.join(', ')}  last: ${last.join(', ')}`);
// One video frame is 33ms; the flash can only start on a frame boundary, so <= 1 frame is perfect sync.
check(worst <= 1 / 30 + 0.002, `worst A/V offset ${(worst * 1000).toFixed(1)}ms <= 1 frame`);
const expectedFirstBeep = (Math.floor(start) + 0.5 >= start ? Math.floor(start) + 0.5 : Math.floor(start) + 1.5) - start;
check(Math.abs(audioOnsets[0] - expectedFirstBeep) < 0.005, `first beep at ${audioOnsets[0].toFixed(4)}s (expected ${expectedFirstBeep.toFixed(4)}s)`);

if (fail.length) {
  console.log(`\nFAILED: ${fail.length} check(s)`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
