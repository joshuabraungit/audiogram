import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DropZone, isAcceptedAudio } from './components/DropZone';
import { ExportModal, type ExportState } from './components/ExportModal';
import { Preview, Transport } from './components/Preview';
import { SettingsPanel } from './components/SettingsPanel';
import { Transcript } from './components/Transcript';
import { Button, ProgressBar, Select } from './components/ui';
import { AudioAnalysis, decodeAudioFile, LONG_FILE_SEC, toWhisperInput } from './lib/audio';
import { buildPages } from './lib/captions';
import { estimateBytes, ExportCanceledError, exportMp4, ExportUnsupportedError } from './lib/exporter';
import { Player } from './lib/player';
import { canvasSize, drawFrame, ensureFonts, type Scene } from './lib/render';
import { checkExportSupport, type Support } from './lib/support';
import { MODELS, transcribe, type TranscribeHandle, type TranscribeProgress } from './lib/transcriber';
import { defaultSettings, FPS, type Settings, type Word } from './lib/types';

const SETTINGS_KEY = 'audiogram.settings.v1';
const MODEL_KEY = 'audiogram.model';
const MOCK = new URLSearchParams(location.search).has('mock');
/** Above this estimated size the export streams to a file on disk instead of RAM. */
const STREAM_THRESHOLD = 400e6;

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings>;
      const merged = { ...defaultSettings } as Settings;
      for (const k of Object.keys(defaultSettings) as (keyof Settings)[]) {
        const v = saved[k];
        if (v === undefined) continue;
        (merged as unknown as Record<string, unknown>)[k] = typeof v === 'object' ? { ...(defaultSettings[k] as object), ...(v as object) } : v;
      }
      return merged;
    }
  } catch {
    /* ignore */
  }
  return defaultSettings;
}

interface Loaded {
  file: File;
  buffer: AudioBuffer;
  analysis: AudioAnalysis;
  player: Player;
}

export default function App() {
  const [support, setSupport] = useState<Support | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [words, setWords] = useState<Word[]>([]);
  const [tx, setTx] = useState<TranscribeProgress | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [model, setModel] = useState(() => {
    try {
      return localStorage.getItem(MODEL_KEY) || MODELS[0].id;
    } catch {
      return MODELS[0].id;
    }
  });
  const [trim, setTrim] = useState<[number, number]>([0, 0]);
  const [bgImage, setBgImage] = useState<ImageBitmap | null>(null);
  const [logo, setLogo] = useState<ImageBitmap | null>(null);
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const txHandle = useRef<TranscribeHandle | null>(null);
  const exportAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    checkExportSupport().then(setSupport);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  const pages = useMemo(() => buildPages(words, settings.captions.maxWordsPerLine * settings.captions.lines), [words, settings.captions.maxWordsPerLine, settings.captions.lines]);

  const scene: Scene = { settings, analysis: loaded?.analysis ?? null, pages, assets: { bgImage, logo } };
  const sceneRef = useRef<Scene>(scene);
  sceneRef.current = scene;

  // Keep the player inside the clip.
  useEffect(() => {
    if (!loaded) return;
    loaded.player.loopStart = trim[0];
    loaded.player.stopAt = trim[1];
  }, [loaded, trim]);

  useEffect(() => {
    void ensureFonts(settings);
  }, [settings.captions.font, settings.title.font]);

  const startTranscription = useCallback(
    async (buffer: AudioBuffer, modelId: string) => {
      txHandle.current?.cancel();
      setWords([]);
      setTxError(null);
      setTx({ stage: 'loading', message: 'Preparing audio…', fraction: 0 });
      const audio16k = await toWhisperInput(buffer);
      const collected: Word[] = [];
      const handle = transcribe(
        audio16k,
        { model: modelId, mock: MOCK },
        setTx,
        (chunkWords) => {
          for (const w of chunkWords) collected.push({ ...w, id: collected.length });
          setWords([...collected]);
        },
      );
      txHandle.current = handle;
      try {
        await handle.promise;
        setTx(null);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg !== 'canceled') setTxError(msg);
        setTx(null);
      } finally {
        if (txHandle.current === handle) txHandle.current = null;
      }
    },
    [],
  );

  const onFile = useCallback(
    async (file: File) => {
      if (!isAcceptedAudio(file)) {
        setLoadError('Please choose an MP3, WAV or M4A file.');
        return;
      }
      setLoadError(null);
      setDecoding(true);
      try {
        const buffer = await decodeAudioFile(file);
        const analysis = new AudioAnalysis(buffer);
        loaded?.player.dispose();
        txHandle.current?.cancel();
        const player = new Player(buffer);
        setLoaded({ file, buffer, analysis, player });
        setTrim([0, buffer.duration]);
        void startTranscription(buffer, model);
      } catch (e) {
        console.error(e);
        setLoadError(`Couldn't decode that file (${(e as Error).message || 'unknown error'}).`);
      } finally {
        setDecoding(false);
      }
    },
    [loaded, model, startTranscription],
  );

  // Test hook (dev builds only) so the e2e test can seek to exact timestamps.
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __ag: unknown }).__ag = { player: loaded?.player, analysis: loaded?.analysis };
  }, [loaded]);

  // Space toggles playback (unless typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && loaded && !exportState) {
        e.preventDefault();
        loaded.player.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loaded, exportState]);

  const startExport = async () => {
    if (!loaded) return;
    loaded.player.pause();
    const [start, end] = trim;
    const filename = `${loaded.file.name.replace(/\.[^.]+$/, '')}-${settings.aspect.replace(':', 'x')}.mp4`;

    let writable: FileSystemWritableFileStream | undefined;
    const big = estimateBytes(end - start) > STREAM_THRESHOLD;
    const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    if (big && picker) {
      try {
        const handle = await picker({ suggestedName: filename, types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] });
        writable = await handle.createWritable();
      } catch {
        return; // user dismissed the save dialog
      }
    }

    const abort = new AbortController();
    exportAbort.current = abort;
    setExportState({ phase: 'running', progress: null, note: writable ? 'Long clip: streaming straight to the file you picked. Keep this tab open.' : undefined });
    await ensureFonts(settings);
    // Freeze the scene so tweaking settings mid-export can't change the output.
    const frozen: Scene = { ...sceneRef.current, settings: structuredClone(settings) };
    const [W, H] = canvasSize(frozen.settings);
    const t0 = performance.now();
    try {
      const res = await exportMp4({
        width: W,
        height: H,
        fps: FPS,
        audio: loaded.buffer,
        start,
        end,
        writable,
        signal: abort.signal,
        render: (ctx, t) => drawFrame(ctx, frozen, t),
        onProgress: (progress) => setExportState((s) => (s?.phase === 'running' ? { ...s, progress } : s)),
      });
      let url: string | null = null;
      if (res.blob) {
        url = URL.createObjectURL(res.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
      }
      setExportState({ phase: 'done', url, filename, bytes: res.bytes, seconds: (performance.now() - t0) / 1000, savedToDisk: !res.blob });
    } catch (e) {
      if (e instanceof ExportCanceledError) setExportState(null);
      else {
        console.error(e);
        const msg = e instanceof ExportUnsupportedError ? `${e.message}\nPlease use the latest desktop Chrome (or Edge).` : (e as Error).message || String(e);
        setExportState({ phase: 'error', message: msg });
      }
    } finally {
      exportAbort.current = null;
    }
  };

  const readImage = async (f: File) => {
    try {
      return await createImageBitmap(f);
    } catch {
      alert("Couldn't read that image.");
      return null;
    }
  };

  const txBusy = !!tx;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-neutral-800 px-4">
        <div className="flex items-center gap-2 font-semibold text-white">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-500 text-xs">◉</span>
          Audiogram
        </div>
        {loaded && (
          <>
            <span className="truncate text-sm text-neutral-500">{loaded.file.name}</span>
            <label className="ml-2 cursor-pointer text-xs text-neutral-400 hover:text-white">
              Open another…
              <input type="file" accept=".mp3,.wav,.m4a,audio/*" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            </label>
          </>
        )}
        <div className="ml-auto flex items-center gap-3">
          {loaded && loaded.buffer.duration > LONG_FILE_SEC && loaded.buffer.numberOfChannels === 1 && (
            <span className="text-xs text-neutral-500" title="Long files are folded to mono to keep memory use reasonable">
              mono (long file)
            </span>
          )}
          <Button variant="primary" disabled={!loaded || !support?.ok || !!exportState} onClick={startExport}>
            Export MP4
          </Button>
        </div>
      </header>

      {support && !support.ok && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-200">
          <strong>Export isn't available in this browser.</strong> {support.reason} Please open this page in the latest desktop <strong>Google Chrome</strong> (or Edge) to export MP4s.
        </div>
      )}

      {!loaded ? (
        decoding ? (
          <div className="flex flex-1 items-center justify-center text-neutral-400">Decoding audio…</div>
        ) : (
          <div className="flex-1">
            <DropZone onFile={onFile} error={loadError} />
          </div>
        )
      ) : (
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-[3] p-4 pb-2">
              <Preview sceneRef={sceneRef} player={loaded.player} aspectKey={settings.aspect} />
            </div>
            <div className="px-4 pb-3">
              <Transport player={loaded.player} trim={trim} setTrim={setTrim} analysis={loaded.analysis} />
            </div>
            <div className="flex min-h-0 flex-[2] flex-col border-t border-neutral-800">
              <div className="flex items-center gap-3 px-4 py-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Transcript</h2>
                <span className="text-xs text-neutral-600">click a word to jump · double-click to fix it</span>
                <div className="ml-auto flex items-center gap-2">
                  {tx ? (
                    <>
                      <div className="w-40">
                        <ProgressBar fraction={tx.fraction} />
                      </div>
                      <span className="max-w-[320px] truncate text-xs text-neutral-400">
                        {tx.message}
                        {tx.device && tx.stage === 'transcribing' ? ` · ${tx.device === 'webgpu' ? 'GPU' : 'CPU'}` : ''}
                      </span>
                      <button className="text-xs text-neutral-500 hover:text-red-400" onClick={() => txHandle.current?.cancel()}>
                        Stop
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="w-56">
                        <Select
                          value={model}
                          options={MODELS.map((m) => ({ value: m.id, label: m.label }))}
                          onChange={(m) => {
                            setModel(m);
                            try {
                              localStorage.setItem(MODEL_KEY, m);
                            } catch {
                              /* ignore */
                            }
                          }}
                        />
                      </div>
                      <Button
                        onClick={() => {
                          if (!words.length || confirm('Re-transcribe? Your transcript edits will be replaced.')) void startTranscription(loaded.buffer, model);
                        }}
                      >
                        {words.length ? 'Re-transcribe' : 'Transcribe'}
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {txError && (
                <div className="mx-4 mb-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  Transcription failed: {txError}. Check your connection (the model downloads once from huggingface.co), then try again or pick a smaller model.
                </div>
              )}
              <div className="min-h-0 flex-1">
                <Transcript words={words} setWords={setWords} player={loaded.player} trim={trim} busy={txBusy} />
              </div>
            </div>
          </main>
          <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-neutral-800 bg-neutral-950">
            <SettingsPanel
              settings={settings}
              setSettings={setSettings}
              hasBgImage={!!bgImage}
              hasLogo={!!logo}
              onBgImage={async (f) => {
                const img = await readImage(f);
                if (img) {
                  setBgImage(img);
                  setSettings((s) => ({ ...s, bg: { ...s.bg, kind: 'image' } }));
                }
              }}
              onLogo={async (f) => {
                const img = await readImage(f);
                if (img) setLogo(img);
              }}
              onClearLogo={() => setLogo(null)}
            />
          </aside>
        </div>
      )}

      {exportState && (
        <ExportModal
          state={exportState}
          onCancel={() => exportAbort.current?.abort()}
          onClose={() => {
            if (exportState.phase === 'done' && exportState.url) setTimeout(() => URL.revokeObjectURL(exportState.url!), 60_000);
            setExportState(null);
          }}
        />
      )}
    </div>
  );
}
