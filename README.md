# Audiogram

Turn an MP3/WAV/M4A into an audiogram video: animated waveform, word-by-word highlighted captions, your
background, title and headshot, exported as an MP4 (H.264 + AAC). Everything runs in the browser: no backend,
no API keys, the audio never leaves your machine.

```bash
cd audiogram   # after cloning
npm install
npm run dev        # http://localhost:5173
```

Use desktop **Chrome** (or Edge). Export needs WebCodecs with an H.264 encoder; other browsers get a banner
saying so. The first transcription downloads the Whisper model from huggingface.co (cached afterwards).

## Use it as an app (no Terminal)

Everything runs in the browser, so any static host works. Recommended: **Vercel** (free).

1. Go to https://vercel.com/new, sign in with GitHub, and import `joshuabraungit/audiogram`.
2. Keep the detected settings (Vite, `npm run build`, output `dist`) and click **Deploy**.
3. Open the URL it gives you in Chrome and click the install icon at the right end of the address bar
   (or ⋮ → Cast, save and share → Install page as app).

Audiogram then lives in your Dock/Launchpad, opens in its own window, and shows up under
**Open With** for MP3, WAV and M4A files. Every push to `main` redeploys automatically.

Avoid Cloudflare Pages: the speech engine's wasm file (~27 MB) is over its 25 MB per-file limit.

## Editing by text

Like Descript: select words in the transcript (drag, or click then shift-click) and press **Delete** to cut
that audio. Cut words stay visible, struck through; click one to bring the cut back. ⌘Z / ⇧⌘Z undo and redo,
and "Restore all" clears every cut. Double-click a word to fix its spelling without touching the audio.

A deleted run is cut from its first word to the start of the next kept word, so the pause before it stays and
the one after it goes. Joins get a 6 ms fade so they never click. Nothing is copied: playback schedules the kept
pieces back to back, and the waveform and export read the original through the same time map
(`src/lib/edit.ts`), so cutting is instant even on long files.

## How it works

| Piece | File | Notes |
| --- | --- | --- |
| Decode + analysis | `src/lib/audio.ts` | Decoded once at 48 kHz. Spectrum bands are a pure function of time (FFT on the samples around `t`), so the waveform is identical in preview and export. Files over 15 min are folded to mono to halve memory. |
| Transcription | `src/workers/whisper.worker.ts`, `src/lib/chunks.ts` | transformers.js Whisper (`onnx-community/whisper-*_timestamped`) in a Web Worker, WebGPU with wasm fallback, `return_timestamps: 'word'`. Audio is cut into < 30 s chunks at the quietest point near each boundary, so long files (30+ min) stream in chunk by chunk and words are never split. |
| Rendering | `src/lib/render.ts` | One `drawFrame(ctx, scene, t)` draws background, waveform, logo, title and captions. The preview canvas and the exporter both call it. |
| Captions | `src/lib/captions.ts` | Words are grouped into short pages (words per line × lines), breaking on pauses and sentence ends. |
| Export | `src/lib/exporter.ts` | Offline frame-by-frame render → WebCodecs H.264 + AAC → MP4 via Mediabunny. Faster than real time, no dropped frames, fast-start MP4. Clips over ~400 MB stream straight to a file you pick instead of RAM. |
| Playback | `src/lib/player.ts` | Web Audio playback with a sample-accurate clock. |

### Two things worth knowing

- **Mediabunny instead of mp4-muxer.** mp4-muxer is deprecated by its author in favor of Mediabunny (same
  author, its successor). Mediabunny also ships a wasm AAC encoder, which matters because Chrome on Linux has no
  native AAC encoder. Native AAC is used whenever the browser has it (Chrome on macOS/Windows).
- **AAC priming is compensated.** AAC encoders prepend ~1024 samples of silence, which would make audio play
  ~21 ms late. The exporter measures the exact delay of whichever encoder is in use (encode a click, decode it,
  find it) and writes an MP4 edit list so players trim it. Measured A/V offset in the tests: 0.0 ms.

## Tests

```bash
npm test                                   # pure logic: chunking, caption paging, word edits
# Browser tests need a Chrome with H.264 (Playwright's bundled Chromium has none) and `npm run dev` running:
CHROME=/path/to/chrome npm run test:export -- 130 1080x1920   # export pipeline: beeps vs. flashes, sync to the ms
CHROME=/path/to/chrome npm run test:e2e    # full UI: load, transcribe (mock), edit, trim, cut by text, exports verified
CHROME=/path/to/chrome npm run test:long   # 37 min file end to end
```

`?mock` in the URL swaps Whisper for a fake transcriber (one "word" per 0.35 s of sound) so the UI can be tested
without downloading a model. Test fixtures are generated with ffmpeg's `flite` speech synthesizer into
`test/fixtures-gen/` by `test/make-fixtures.sh`.
