import { Fragment, memo, useCallback, useEffect, useRef, useState } from 'react';
import { wordAt } from '../lib/captions';
import type { Player } from '../lib/player';
import type { Word } from '../lib/types';
import { editWord } from '../lib/editing';

/** Index of the word under the playhead; only triggers a render when it changes. */
function useActiveWord(player: Player, words: Word[]) {
  const [active, setActive] = useState(-1);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setActive(wordAt(words, player.time));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [player, words]);
  return active;
}

export function Transcript({ words, setWords, player, trim, busy }: { words: Word[]; setWords: (w: Word[]) => void; player: Player; trim: [number, number]; busy: boolean }) {
  const active = useActiveWord(player, words);
  const [editing, setEditing] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const lastScroll = useRef(0);
  const latest = useRef({ words, setWords });
  latest.current = { words, setWords };

  useEffect(() => {
    if (active < 0 || editing !== null) return;
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

  // Stable handlers so memoised words don't re-render on every playhead move.
  const onSeek = useCallback((i: number) => player.seek(latest.current.words[i].start), [player]);
  const onEdit = useCallback(
    (i: number) => {
      player.pause();
      setEditing(i);
    },
    [player],
  );
  const onCommit = useCallback((i: number, text: string) => {
    setEditing(null);
    const { words, setWords } = latest.current;
    if (text.trim() !== words[i].text) setWords(editWord(words, i, text));
  }, []);
  const onCancel = useCallback(() => setEditing(null), []);

  if (!words.length) {
    return <div className="p-4 text-sm text-neutral-500">{busy ? 'Words will appear here as they are transcribed…' : 'No words transcribed.'}</div>;
  }

  return (
    <div ref={boxRef} className="h-full overflow-y-auto px-4 py-3 text-[15px] leading-8" onWheel={() => (lastScroll.current = Date.now())}>
      {words.map((w, i) => (
        <Fragment key={w.id}>
        <WordSpan
          w={w}
          i={i}
          active={i === active}
          outside={w.end <= trim[0] || w.start >= trim[1]}
          editing={editing === i}
          onSeek={onSeek}
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
  outside,
  editing,
  onSeek,
  onEdit,
  onCommit,
  onCancel,
}: {
  w: Word;
  i: number;
  active: boolean;
  outside: boolean;
  editing: boolean;
  onSeek: (i: number) => void;
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
  return (
    <span
      data-i={i}
      title={`${w.start.toFixed(2)}s · double-click to edit`}
      onClick={() => onSeek(i)}
      onDoubleClick={() => onEdit(i)}
      className={`cursor-pointer rounded px-[3px] py-0.5 transition-colors ${
        active ? 'bg-indigo-500 text-white' : outside ? 'text-neutral-600 hover:bg-neutral-800' : 'text-neutral-300 hover:bg-neutral-800'
      }`}
    >
      {w.text}
    </span>
  );
});
