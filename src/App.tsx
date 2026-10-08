import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DropZone, isAcceptedAudio } from './components/DropZone';
import { ExportModal, type ExportState } from './components/ExportModal';
import { Preview, Transport } from './components/Preview';
import { SettingsPanel } from './components/SettingsPanel';
import { Transcript } from './components/Transcript';
import { Button, ProgressBar, Select } from './components/ui';
import { AudioAnalysis, decodeAudioFile, LONG_FILE_SEC, toWhisperInput } from './lib/audio';
import { buildPages } from './lib/captions';
import { computeCuts, EditedSource, editedAnalysis, keptSegments, remapWords, TimeMap, type Analysis } from './lib/edit';
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
  /** the original decoded audio; never modified */
  buffer: AudioBuffer;
  /** analysis of the original audio, computed once per file */
  analysis: AudioAnalysis;
}

/**
 * The audio after transcript cuts. Nothing is copied: playback, waveform and export all read the original
 * through the TimeMap, so a cut is instant even on a 30+ minute file.
 */
interface Edit {
  map: TimeMap;
  source: EditedSource;
  analysis: Analysis;
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
  /** clip range in source (original file) time, so it survives cuts */
  const [trimSrc, setTrimSrc] = useState<[number, number]>([0, 0]);
  const [edit, setEdit] = useState<Edit | null>(null);
  const editRef = useRef<Edit | null>(null);
  const history = useRef<{ past: Word[][]; future: Word[][] }>({ past: [], future: [] });
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

  // ---- Text-based editing: deleted words become cuts; the edited audio is rebuilt when cuts change.
  const cuts = useMemo(() => (loaded ? computeCuts(words, loaded.buffer.duration) : []), [words, loaded]);
  const cutsKey = useMemo(() => JSON.stringify(cuts), [cuts]);
  useEffect(() => {
    if (!loaded) return;
    const prev = editRef.current;
    const map = new TimeMap(keptSegments(cuts, loaded.buffer.duration));
    const source = EditedSource.fromBuffer(loaded.buffer, map);
    const analysis = editedAnalysis(loaded.analysis, map);
    const player = new Player(loaded.buffer, map);
    // Keep the playhead on the same spot of the original audio.
    if (prev && prev.player.duration > 0) player.seek(map.toEdit(prev.map.toSource(prev.player.time)));
    prev?.player.dispose();
    const next = { map, source, analysis, player };
    editRef.current = next;
    setEdit(next);
  }, [loaded, cutsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Applies a transcript edit with undo history. */
  const wordsRef = useRef(words);
  wordsRef.current = words;
  const commitWords = useCallback((next: Word[]) => {
    const h = history.current;
    h.past.push(wordsRef.current);
    if (h.past.length > 200) h.past.shift();
    h.future = [];
    setWords(next);
  }, []);
  const undo = useCallback(() => {
    const h = history.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future.push(wordsRef.current);
    setWords(prev);
  }, []);
  const redo = useCallback(() => {
    const h = history.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push(wordsRef.current);
    setWords(next);
  }, []);

  const map = edit?.map ?? null;
  const keptWords = useMemo(() => (map ? remapWords(words, map) : words), [words, map]);
  const trim: [number, number] = map ? [map.toEdit(trimSrc[0]), map.toEdit(trimSrc[1])] : trimSrc;
  const setTrim = useCallback((t: [number, number]) => {
    const m = editRef.current?.map;
    if (m) setTrimSrc([m.toSource(t[0]), m.toSource(t[1])]);
  }, []);
  const cutSeconds = loaded && map ? loaded.buffer.duration - map.duration : 0;

  const pages = useMemo(() => buildPages(keptWords, settings.captions.maxWordsPerLine * settings.captions.lines), [keptWords, settings.captions.maxWordsPerLine, settings.captions.lines]);

  const scene: Scene = { settings, analysis: edit?.analysis ?? null, pages, assets: { bgImage, logo } };
  const sceneRef = useRef<Scene>(scene);
  sceneRef.current = scene;

  // Keep the player inside the clip.
  useEffect(() => {
    if (!edit) return;
    edit.player.loopStart = trim[0];
    edit.player.stopAt = trim[1];
  }, [edit, trim[0], trim[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void ensureFonts(settings);
  }, [settings.captions.font, settings.title.font]);

  const startTranscription = useCallback(
    async (buffer: AudioBuffer, modelId: string) => {
      txHandle.current?.cancel();
      setWords([]);
      history.current = { past: [], future: [] };
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
        txHandle.current?.cancel();
        editRef.current?.player.dispose();
        editRef.current = null;
        setEdit(null);
        setLoaded({ file, buffer, analysis: new AudioAnalysis(buffer) });
        setTrimSrc([0, buffer.duration]);
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

  // Installed app: files opened via "Open With → Audiogram" arrive through the launch queue.
  const onFileRef = useRef(onFile);
  onFileRef.current = onFile;
  useEffect(() => {
    type LaunchParams = { files: FileSystemFileHandle[] };
    const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: LaunchParams) => void): void } }).launchQueue;
    lq?.setConsumer(async (params) => {
      const handle = params.files[0];
      if (handle) void onFileRef.current(await handle.getFile());
    });
  }, []);

  // Test hook (dev builds only) so the e2e test can seek to exact timestamps.
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __ag: unknown }).__ag = { player: edit?.player, analysis: edit?.analysis, map: edit?.map };
  }, [edit]);

  // Space toggles playback (unless typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (typing || !edit || exportState) return;
      if (e.code === 'Space') {
        e.preventDefault();
        edit.player.toggle();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !tx) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y' && !tx) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [edit, exportState, tx, undo, redo]);

  const startExport = async () => {
    if (!loaded || !edit) return;
    edit.player.pause();
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
        audio: edit.source,
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
      ) : !edit ? (
        <div className="flex flex-1 items-center justify-center text-neutral-400">Analyzing audio…</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-[3] p-4 pb-2">
              <Preview sceneRef={sceneRef} player={edit.player} aspectKey={settings.aspect} />
            </div>
            <div className="px-4 pb-3">
              <Transport player={edit.player} trim={trim} setTrim={setTrim} analysis={edit.analysis} />
            </div>
            <div className="flex min-h-0 flex-[2] flex-col border-t border-neutral-800">
              <div className="flex items-center gap-3 px-4 py-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Transcript</h2>
                <span className="hidden text-xs text-neutral-600 xl:inline">click to jump · drag + Delete to cut · double-click to fix</span>
                {cuts.length > 0 && (
                  <span className="flex items-center gap-2 text-xs">
                    <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-red-300">
                      {cuts.length} cut{cuts.length > 1 ? 's' : ''} · −{cutSeconds.toFixed(1)}s
                    </span>
                    <button
                      className="text-neutral-400 hover:text-white disabled:opacity-40"
                      disabled={!!tx}
                      onClick={() => commitWords(words.map((w) => (w.deleted ? { ...w, deleted: false } : w)))}
                    >
                      Restore all
                    </button>
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <button className="rounded px-1.5 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-white disabled:opacity-30" title="Undo (⌘Z)" disabled={!!tx || !history.current.past.length} onClick={undo}>
                    ↶
                  </button>
                  <button className="rounded px-1.5 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-white disabled:opacity-30" title="Redo (⇧⌘Z)" disabled={!!tx || !history.current.future.length} onClick={redo}>
                    ↷
                  </button>
                </span>
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
                          if (!words.length || confirm('Re-transcribe? Your transcript edits and cuts will be replaced.')) void startTranscription(loaded.buffer, model);
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
                <Transcript words={words} commit={commitWords} player={edit.player} map={edit.map} trimSrc={trimSrc} busy={txBusy} />
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
