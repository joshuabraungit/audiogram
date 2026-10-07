import type { ExportProgress } from '../lib/exporter';
import { Button, ProgressBar, fmtTime } from './ui';

export type ExportState =
  | { phase: 'running'; progress: ExportProgress | null; note?: string }
  | { phase: 'done'; url: string | null; filename: string; bytes: number; seconds: number; savedToDisk: boolean }
  | { phase: 'error'; message: string };

export function ExportModal({ state, onCancel, onClose }: { state: ExportState; onCancel: () => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl bg-neutral-900 p-6 shadow-2xl ring-1 ring-neutral-800">
        {state.phase === 'running' && (
          <>
            <h2 className="text-lg font-semibold text-white">Exporting MP4…</h2>
            <p className="mt-1 text-sm text-neutral-400">{state.note ?? 'Rendering every frame offline. Keep this tab open.'}</p>
            <ProgressBar fraction={state.progress?.fraction ?? 0} className="mt-5 h-2" />
            <div className="mt-2 flex justify-between text-xs tabular-nums text-neutral-400">
              {state.progress ? (
                <>
                  <span>
                    {Math.round(state.progress.fraction * 100)}% · frame {state.progress.frame}/{state.progress.totalFrames}
                  </span>
                  <span>
                    {state.progress.speed.toFixed(1)}× realtime · {fmtTime(eta(state.progress))} left
                  </span>
                </>
              ) : (
                <span>Preparing encoders…</span>
              )}
            </div>
            <div className="mt-6 flex justify-end">
              <Button variant="danger" onClick={onCancel}>
                Cancel export
              </Button>
            </div>
          </>
        )}
        {state.phase === 'done' && (
          <>
            <h2 className="text-lg font-semibold text-white">Export complete</h2>
            <p className="mt-1 text-sm text-neutral-400">
              {state.filename} · {(state.bytes / 1e6).toFixed(1)} MB{state.bytes ? '' : ' (saved to disk)'} · rendered in {fmtTime(state.seconds)}
            </p>
            <p className="mt-3 text-xs text-neutral-500">H.264 + AAC MP4, ready for QuickTime and LinkedIn.</p>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              {state.url && (
                <a href={state.url} download={state.filename} className="rounded-lg bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-400">
                  Download again
                </a>
              )}
            </div>
          </>
        )}
        {state.phase === 'error' && (
          <>
            <h2 className="text-lg font-semibold text-white">Export failed</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm text-red-300">{state.message}</p>
            <div className="mt-6 flex justify-end">
              <Button onClick={onClose}>Close</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function eta(p: ExportProgress) {
  if (p.fraction <= 0) return 0;
  return ((p.elapsedMs / p.fraction) * (1 - p.fraction)) / 1000;
}
