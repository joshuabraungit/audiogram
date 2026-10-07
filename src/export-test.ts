// Hardcoded end-to-end check of the export pipeline: synthetic audio with a beep every second and a
// canvas that flashes white exactly while the beep sounds. test/export-test.mjs downloads the MP4 and
// measures the offset between audio onsets and video flashes with ffmpeg.
import { exportMp4 } from './lib/exporter';

const log = (s: string) => {
  document.getElementById('log')!.textContent += s + '\n';
  console.log(s);
};

const BEEP_LEN = 0.1;
const beepActive = (t: number) => {
  const phase = t - Math.floor(t);
  return phase >= 0.5 && phase < 0.5 + BEEP_LEN;
};

function makeAudio(seconds: number, sampleRate = 48000) {
  const length = Math.round(seconds * sampleRate);
  const buf = new AudioBuffer({ length, numberOfChannels: 2, sampleRate });
  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const v = beepActive(t) ? 0.6 * Math.sin(2 * Math.PI * 1000 * t) : 0;
    l[i] = v;
    r[i] = v;
  }
  return buf;
}

async function run(params: { seconds: number; start: number; end: number; width: number; height: number; stream?: boolean }) {
  // stream: write through a FileSystemWritableFileStream (OPFS here, showSaveFilePicker in the app).
  let writable: FileSystemWritableFileStream | undefined;
  let handle: FileSystemFileHandle | undefined;
  if (params.stream) {
    const dir = await navigator.storage.getDirectory();
    handle = await dir.getFileHandle('export-test.mp4', { create: true });
    writable = await handle.createWritable();
  }
  const audio = makeAudio(params.seconds);
  log(`audio: ${params.seconds}s, exporting ${params.start}..${params.end} at ${params.width}x${params.height}`);
  const res = await exportMp4({
    width: params.width,
    height: params.height,
    fps: 30,
    audio,
    writable,
    start: params.start,
    end: params.end,
    render: (ctx, t) => {
      // A frame covers [t, t + 1/30). Flash if the beep is active at the frame's midpoint.
      const on = beepActive(t + 1 / 60);
      ctx.fillStyle = on ? '#ffffff' : '#101820';
      ctx.fillRect(0, 0, params.width, params.height);
      ctx.fillStyle = on ? '#000' : '#7dd3fc';
      ctx.font = 'bold 64px sans-serif';
      ctx.fillText(`t=${t.toFixed(3)}`, 40, 120);
    },
    onProgress: (p) => {
      if (p.frame % 300 === 0 || p.frame === p.totalFrames)
        log(`frame ${p.frame}/${p.totalFrames} speed ${p.speed.toFixed(2)}x`);
    },
  });
  log(`done: ${res.bytes} bytes, codec ${res.videoCodec}, wasm aac: ${res.usedWasmAac}, aac delay ${res.aacDelay}`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(res.blob ?? (await handle!.getFile()));
  a.download = 'export-test.mp4';
  document.body.appendChild(a);
  a.click();
  return { bytes: res.bytes, codec: res.videoCodec, wasmAac: res.usedWasmAac };
}

(window as unknown as { runExportTest: typeof run }).runExportTest = run;
log('ready');
