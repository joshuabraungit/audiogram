import { Fragment, memo, useCallback, useEffect, useRef, useState } from 'react';
import { wordAt } from '../lib/captions';
import type { TimeMap } from '../lib/edit';
import { deletedRun, editWord, setDeleted } from '../lib/editing';
import type { Player } from '../lib/player';
import type { Word } from '../lib/types';

/** Index of the word under the playhead; only triggers a render when it changes. */
function useActiveWord(player: Player, words: Word[], map: TimeMap) {
  const [active, setActive] = useState(-1);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const i = wordAt(words, map.toSource(player.time));
      setActive(i >= 0 && words[i].deleted ? -1 : i);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [player, words, map]);
  return active;
}

type Sel = { a: number; b: number } | null;

/**
 * Text-based editor. Click a word to jump there; drag or shift-click to select a range, then press
 * Delete/Backspace to cut that audio. Cut words stay visible (struck through) and come back with a click.
 * Double-click a word to fix its spelling without changing its timing.
 */
export function Transcript({
  words,
  commit,
  player,
  map,
  trimSrc,
  busy,
}: {
  words: Word[];
  /** applies an edit (with undo history) */
  commit: (w: Word[]) => void;
  player: Player;
  map: TimeMap;
  /** clip range in source time */
  trimSrc: [number, number];
  busy: boolean;
}) {
  const active = useActiveWord(player, words, map);
  const [editing, setEditing] = useState<number | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const dragging = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const lastScroll = useRef(0);
  const latest = useRef({ words, commit, map, sel, busy });
  latest.current = { words, commit, map, sel, busy };

  // Selection indices are only meaningful for the word list they were made on.
  useEffect(() => setSel((s) => (s && Math.max(s.a, s.b) < words.length ? s : null)), [words]);

  useEffect(() => {
    if (active < 0 || editing !== null || dragging.current) return;
    if (Date.now() - lastScroll.current < 3000) return; // the user is scrolling manually
    const box = boxRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-i="${active}"]`);
    if (el && box) {
      const b = box.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.top < b.top + 8 || r.bottom > b.bottom - 8) {
        const far = Math.abs(r.top - b.top) > b.height * 3;
        box.scrollTo({ top: box.scrollTop + (r.top - b.top) - b.height / 3, behavior: far ? 'auto' : 'smooth' });
      }
    }
  }, [active, player, editing]);

  // Delete/Backspace cuts the selection; Escape clears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const { sel, words, commit, busy } = latest.current;
      if (!sel) return;
      if (e.key === 'Escape') setSel(null);
      else if ((e.key === 'Backspace' || e.key === 'Delete') && !busy) {
        e.preventDefault();
        commit(setDeleted(words, sel.a, sel.b, true));
        setSel(null);
      }
    };
    const onUp = () => (dragging.current = false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Stable handlers so memoised words don't re-render on every playhead move.
  const onDown = useCallback(
    (i: number, shift: boolean) => {
      const { words, commit, map, sel, busy } = latest.current;
      const w = words[i];
      if (w.deleted && !shift) {
        // Clicking cut text brings the whole cut back.
        if (!busy) {
          const [a, b] = deletedRun(words, i);
          commit(setDeleted(words, a, b, false));
        }
        setSel(null);
        return;
      }
      if (shift && sel) {
        setSel({ a: sel.a, b: i });
        return;
      }
      dragging.current = true;
      setSel({ a: i, b: i });
      player.seek(map.toEdit(w.start));
    },
    [player],
  );
  const onEnter = useCallback((i: number) => {
    if (dragging.current) setSel((s) => (s ? { a: s.a, b: i } : s));
  }, []);
  const onEdit = useCallback(
    (i: number) => {
      if (latest.current.words[i].deleted) return;
      player.pause();
      setSel(null);
      setEditing(i);
    },
    [player],
  );
  const onCommit = useCallback((i: number, text: string) => {
    setEditing(null);
    const { words, commit } = latest.current;
    if (text.trim() !== words[i].text) commit(editWord(words, i, text));
  }, []);
  const onCancel = useCallback(() => setEditing(null), []);

  if (!words.length) {
    return <div className="p-4 text-sm text-neutral-500">{busy ? 'Words will appear here as they are transcribed…' : 'No words transcribed.'}</div>;
  }

  const lo = sel ? Math.min(sel.a, sel.b) : -1;
  const hi = sel ? Math.max(sel.a, sel.b) : -2;

  return (
    <div ref={boxRef} className="h-full select-none overflow-y-auto px-4 py-3 text-[15px] leading-8" onWheel={() => (lastScroll.current = Date.now())}>
      {words.map((w, i) => (
        <Fragment key={w.id}>
          <WordSpan
            w={w}
            i={i}
            active={i === active}
            selected={i >= lo && i <= hi}
            outside={w.end <= trimSrc[0] || w.start >= trimSrc[1]}
            editing={editing === i}
            onDown={onDown}
            onEnter={onEnter}
            onEdit={onEdit}
            onCommit={onCommit}
            onCancel={onCancel}
          />{' '}
        </Fragment>
      ))}
    </div>
  );
}

const WordSpan = memo(function WordSpan({
  w,
  i,
  active,
  selected,
  outside,
  editing,
  onDown,
  onEnter,
  onEdit,
  onCommit,
  onCancel,
}: {
  w: Word;
  i: number;
  active: boolean;
  selected: boolean;
  outside: boolean;
  editing: boolean;
  onDown: (i: number, shift: boolean) => void;
  onEnter: (i: number) => void;
  onEdit: (i: number) => void;
  onCommit: (i: number, t: string) => void;
  onCancel: () => void;
}) {
  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={w.text}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => (e.target.dataset.cancel ? onCancel() : onCommit(i, e.target.value))}
        onKeyDown={(e) => {
          const el = e.target as HTMLInputElement;
          if (e.key === 'Escape') el.dataset.cancel = '1';
          if (e.key === 'Enter' || e.key === 'Escape') el.blur();
        }}
        className="mx-0.5 rounded bg-neutral-800 px-1 text-white ring-2 ring-indigo-400 outline-none"
        style={{ width: `${Math.max(4, w.text.length + 2)}ch` }}
      />
    );
  }
  const cls = w.deleted
    ? `text-neutral-600 line-through decoration-red-400/70 hover:text-neutral-400 ${selected ? 'bg-red-500/10' : ''}`
    : active
      ? 'bg-indigo-500 text-white'
      : selected
        ? 'bg-indigo-400/25 text-white'
        : outside
          ? 'text-neutral-600 hover:bg-neutral-800'
          : 'text-neutral-300 hover:bg-neutral-800';
  return (
    <span
      data-i={i}
      data-deleted={w.deleted ? '' : undefined}
      title={w.deleted ? 'Cut from the audio · click to restore' : `${w.start.toFixed(2)}s · drag to select, Delete to cut · double-click to fix`}
      onMouseDown={(e) => {
        if (e.button !== 0 || e.detail > 1) return; // let double-click through to the editor
        onDown(i, e.shiftKey);
      }}
      onMouseEnter={() => onEnter(i)}
      onDoubleClick={() => onEdit(i)}
      className={`cursor-pointer rounded px-[3px] py-0.5 transition-colors ${cls}`}
    >
      {w.text}
    </span>
  );
});
