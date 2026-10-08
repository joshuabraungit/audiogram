import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Analysis } from '../lib/edit';
import type { Player } from '../lib/player';
import { canvasSize, drawFrame, type Scene } from '../lib/render';
import { fmtTime } from './ui';

export function usePlayerTime(player: Player | null) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!player) return;
    let raf = 0;
    const tick = () => {
      setT(player.time);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [player]);
  return t;
}

export function Preview({ sceneRef, player, aspectKey }: { sceneRef: RefObject<Scene>; player: Player | null; aspectKey: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [W, H] = canvasSize(sceneRef.current!.settings);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d', { alpha: false })!;
    let raf = 0;
    const loop = () => {
      const scene = sceneRef.current!;
      const [w, h] = canvasSize(scene.settings);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      drawFrame(ctx, scene, player ? player.time : 0);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [sceneRef, player, aspectKey]);

  return (
    <div className="flex h-full w-full items-center justify-center">
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        onClick={() => player?.toggle()}
        className="max-h-full max-w-full cursor-pointer rounded-lg shadow-2xl shadow-black/60 ring-1 ring-white/5"
        style={{ aspectRatio: `${W} / ${H}` }}
      />
    </div>
  );
}

export function Transport({ player, trim, setTrim, analysis }: { player: Player; trim: [number, number]; setTrim: (t: [number, number]) => void; analysis: Analysis }) {
  const t = usePlayerTime(player);
  const [playing, setPlaying] = useState(player.playing);
  useEffect(() => player.onChange(() => setPlaying(player.playing)), [player]);
  const dur = player.duration;

  return (
    <div className="space-y-2">
      <Timeline t={t} duration={dur} trim={trim} setTrim={setTrim} analysis={analysis} onSeek={(x) => player.seek(x)} />
      <div className="flex items-center gap-3">
        <button
          onClick={() => player.toggle()}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-neutral-900 hover:bg-neutral-200"
          title="Play/pause (space)"
        >
          {playing ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="2" y="1" width="3.5" height="12" rx="1" /><rect x="8.5" y="1" width="3.5" height="12" rx="1" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M3 1.5v11a.5.5 0 0 0 .77.42l8.5-5.5a.5.5 0 0 0 0-.84l-8.5-5.5A.5.5 0 0 0 3 1.5Z" /></svg>
          )}
        </button>
        <button className="text-xs text-neutral-400 hover:text-white" onClick={() => player.seek(trim[0])} title="Jump to clip start">
          ⏮
        </button>
        <span className="font-mono text-sm tabular-nums text-neutral-300">
          {fmtTime(t, true)} <span className="text-neutral-600">/ {fmtTime(dur)}</span>
        </span>
        <div className="ml-auto flex items-center gap-2 text-xs text-neutral-400">
          <span>Clip</span>
          <TimeField value={trim[0]} onChange={(v) => setTrim([Math.min(v, trim[1] - 0.5), trim[1]])} />
          <span>→</span>
          <TimeField value={trim[1]} onChange={(v) => setTrim([trim[0], Math.max(v, trim[0] + 0.5)])} />
          <span className="text-neutral-500">({fmtTime(trim[1] - trim[0], true)})</span>
          <button className="rounded px-1.5 py-0.5 ring-1 ring-neutral-700 hover:bg-neutral-800" onClick={() => setTrim([Math.min(t, trim[1] - 0.5), trim[1]])} title="Set clip start at playhead">
            [ start
          </button>
          <button className="rounded px-1.5 py-0.5 ring-1 ring-neutral-700 hover:bg-neutral-800" onClick={() => setTrim([trim[0], Math.max(t, trim[0] + 0.5)])} title="Set clip end at playhead">
            end ]
          </button>
          {(trim[0] > 0 || trim[1] < dur) && (
            <button className="rounded px-1.5 py-0.5 hover:bg-neutral-800" onClick={() => setTrim([0, dur])}>
              reset
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TimeField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      className="w-16 rounded bg-neutral-900 px-1.5 py-0.5 text-center font-mono tabular-nums text-neutral-200 ring-1 ring-neutral-700 outline-none focus:ring-indigo-400"
      value={text ?? fmtTime(value, true)}
      onFocus={() => setText(fmtTime(value, true))}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== null) {
          const parts = text.split(':').map(Number);
          if (parts.every((p) => Number.isFinite(p))) onChange(parts.reduce((a, p) => a * 60 + p, 0));
        }
        setText(null);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** Whole-file overview: loudness envelope, shaded trim region with draggable handles, and the playhead. */
function Timeline({ t, duration, trim, setTrim, analysis, onSeek }: { t: number; duration: number; trim: [number, number]; setTrim: (t: [number, number]) => void; analysis: Analysis; onSeek: (t: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<null | 'start' | 'end' | 'seek'>(null);

  useEffect(() => {
    const c = canvasRef.current!;
    const draw = () => {
      const w = (c.width = c.clientWidth * devicePixelRatio);
      const h = (c.height = c.clientHeight * devicePixelRatio);
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#525252';
      const env = analysis.envelope;
      for (let x = 0; x < w; x += 2) {
        const a = Math.floor((x / w) * env.length);
        const b = Math.max(a + 1, Math.floor(((x + 2) / w) * env.length));
        let m = 0;
        for (let i = a; i < b && i < env.length; i++) m = Math.max(m, env[i]);
        const bh = Math.max(1, m * h * 0.9);
        ctx.fillRect(x, (h - bh) / 2, 1.2 * devicePixelRatio, bh);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [analysis]);

  const timeAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };
  const pct = (x: number) => `${(x / duration) * 100}%`;

  return (
    <div
      ref={ref}
      className="relative h-12 cursor-pointer select-none rounded-md bg-neutral-900 ring-1 ring-neutral-800"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        const handle = (e.target as HTMLElement).dataset.handle as 'start' | 'end' | undefined;
        drag.current = handle ?? 'seek';
        if (!handle) onSeek(timeAt(e.clientX));
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const x = timeAt(e.clientX);
        if (drag.current === 'seek') onSeek(x);
        else if (drag.current === 'start') setTrim([Math.min(x, trim[1] - 0.5), trim[1]]);
        else setTrim([trim[0], Math.max(x, trim[0] + 0.5)]);
      }}
      onPointerUp={() => (drag.current = null)}
    >
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      <div className="pointer-events-none absolute inset-y-0 left-0 bg-neutral-950/70" style={{ width: pct(trim[0]) }} />
      <div className="pointer-events-none absolute inset-y-0 right-0 bg-neutral-950/70" style={{ left: pct(trim[1]) }} />
      <div className="pointer-events-none absolute inset-y-0 border-y-2 border-indigo-400/70" style={{ left: pct(trim[0]), width: `calc(${pct(trim[1])} - ${pct(trim[0])})` }} />
      <div data-handle="start" title="Drag to set clip start" className="absolute inset-y-0 w-2.5 -translate-x-1/2 cursor-ew-resize rounded-l bg-indigo-400" style={{ left: pct(trim[0]) }} />
      <div data-handle="end" title="Drag to set clip end" className="absolute inset-y-0 w-2.5 -translate-x-1/2 cursor-ew-resize rounded-r bg-indigo-400" style={{ left: pct(trim[1]) }} />
      <div className="pointer-events-none absolute -inset-y-1 w-0.5 -translate-x-1/2 bg-white" style={{ left: pct(t) }} />
    </div>
  );
}
