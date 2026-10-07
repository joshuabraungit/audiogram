import { useState, type ReactNode } from 'react';

export function Section({ title, children, defaultOpen = true, right }: { title: string; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-neutral-800">
      <div className="flex items-center justify-between px-4 py-3">
        <button className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-400 hover:text-neutral-200" onClick={() => setOpen(!open)}>
          <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
          {title}
        </button>
        {right}
      </div>
      {open && <div className="space-y-3 px-4 pb-4">{children}</div>}
    </section>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="shrink-0 text-neutral-400">{label}</span>
      <div className="flex min-w-0 flex-1 justify-end">{children}</div>
    </label>
  );
}

export function Slider({ value, min, max, step = 0.01, onChange, format }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <div className="flex w-full max-w-[200px] items-center gap-2">
      <input type="range" className="w-full accent-indigo-400" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="w-10 text-right text-xs tabular-nums text-neutral-500">{format ? format(value) : value}</span>
    </div>
  );
}

export function Color({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-xs uppercase text-neutral-500">{value}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-7 w-9 cursor-pointer rounded border border-neutral-700 bg-transparent p-0.5" />
    </div>
  );
}

export function Select<T extends string>({ value, options, onChange }: { value: T; options: readonly (T | { value: T; label: string })[]; onChange: (v: T) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} className="w-full max-w-[200px] rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200 outline-none focus:border-indigo-400">
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const l = typeof o === 'string' ? o : o.label;
        return (
          <option key={v} value={v}>
            {l}
          </option>
        );
      })}
    </select>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: readonly { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex w-full rounded-lg bg-neutral-900 p-0.5 ring-1 ring-neutral-800">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition ${value === o.value ? 'bg-neutral-700 text-white shadow' : 'text-neutral-400 hover:text-neutral-200'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={value}
      onClick={(e) => {
        e.preventDefault();
        onChange(!value);
      }}
      className={`relative h-5 w-9 rounded-full transition ${value ? 'bg-indigo-500' : 'bg-neutral-700'}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${value ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

export function Button({ children, onClick, variant = 'default', disabled, className = '' }: { children: ReactNode; onClick?: () => void; variant?: 'default' | 'primary' | 'ghost' | 'danger'; disabled?: boolean; className?: string }) {
  const styles = {
    default: 'bg-neutral-800 text-neutral-100 hover:bg-neutral-700 ring-1 ring-neutral-700',
    primary: 'bg-indigo-500 text-white hover:bg-indigo-400',
    ghost: 'text-neutral-300 hover:bg-neutral-800',
    danger: 'bg-red-500/90 text-white hover:bg-red-500',
  }[variant];
  return (
    <button disabled={disabled} onClick={onClick} className={`rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}>
      {children}
    </button>
  );
}

export function FilePick({ accept, label, onFile }: { accept: string; label: string; onFile: (f: File) => void }) {
  return (
    <label className="cursor-pointer rounded-lg bg-neutral-800 px-3 py-1.5 text-sm font-medium text-neutral-100 ring-1 ring-neutral-700 hover:bg-neutral-700">
      {label}
      <input
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
    </label>
  );
}

export function fmtTime(s: number, withMs = false) {
  if (!Number.isFinite(s)) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = withMs ? sec.toFixed(1).padStart(4, '0') : String(Math.floor(sec)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function ProgressBar({ fraction, className = '' }: { fraction: number; className?: string }) {
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-neutral-800 ${className}`}>
      <div className="h-full rounded-full bg-indigo-400 transition-[width] duration-200" style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%` }} />
    </div>
  );
}
