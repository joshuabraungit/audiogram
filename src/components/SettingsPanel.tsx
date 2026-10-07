import type { Dispatch, SetStateAction } from 'react';
import { FONTS, type Aspect, type BackgroundKind, type Settings, type WaveStyle } from '../lib/types';
import { Color, FilePick, Row, Section, Segmented, Select, Slider, Toggle } from './ui';

const pct = (v: number) => `${Math.round(v * 100)}%`;

const PRESETS: { name: string; from: string; to: string }[] = [
  { name: 'Indigo', from: '#1e1b4b', to: '#0f766e' },
  { name: 'Sunset', from: '#7c2d12', to: '#db2777' },
  { name: 'Ocean', from: '#0c4a6e', to: '#1e293b' },
  { name: 'Mono', from: '#171717', to: '#404040' },
  { name: 'LinkedIn', from: '#0a66c2', to: '#004182' },
];

export function SettingsPanel({
  settings: s,
  setSettings,
  hasBgImage,
  hasLogo,
  onBgImage,
  onLogo,
  onClearLogo,
}: {
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  hasBgImage: boolean;
  hasLogo: boolean;
  onBgImage: (f: File) => void;
  onLogo: (f: File) => void;
  onClearLogo: () => void;
}) {
  function set<K extends keyof Settings>(key: K, patch: Partial<Settings[K]>) {
    setSettings((prev) => ({ ...prev, [key]: { ...(prev[key] as object), ...patch } }));
  }

  return (
    <div className="pb-10">
      <Section title="Format">
        <Segmented<Aspect>
          value={s.aspect}
          onChange={(aspect) => setSettings((p) => ({ ...p, aspect }))}
          options={[
            { value: '1:1', label: '1:1 Square' },
            { value: '9:16', label: '9:16 Story' },
            { value: '16:9', label: '16:9 Wide' },
          ]}
        />
      </Section>

      <Section title="Background">
        <Segmented<BackgroundKind>
          value={s.bg.kind}
          onChange={(kind) => set('bg', { kind })}
          options={[
            { value: 'solid', label: 'Solid' },
            { value: 'gradient', label: 'Gradient' },
            { value: 'image', label: 'Image' },
          ]}
        />
        {s.bg.kind === 'solid' && (
          <Row label="Color">
            <Color value={s.bg.color} onChange={(color) => set('bg', { color })} />
          </Row>
        )}
        {s.bg.kind === 'gradient' && (
          <>
            <div className="flex gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.name}
                  title={p.name}
                  onClick={() => set('bg', { gradientFrom: p.from, gradientTo: p.to })}
                  className="h-7 flex-1 rounded-md ring-1 ring-white/10 hover:ring-white/40"
                  style={{ background: `linear-gradient(135deg, ${p.from}, ${p.to})` }}
                />
              ))}
            </div>
            <Row label="From">
              <Color value={s.bg.gradientFrom} onChange={(gradientFrom) => set('bg', { gradientFrom })} />
            </Row>
            <Row label="To">
              <Color value={s.bg.gradientTo} onChange={(gradientTo) => set('bg', { gradientTo })} />
            </Row>
            <Row label="Angle">
              <Slider value={s.bg.gradientAngle} min={0} max={360} step={1} onChange={(gradientAngle) => set('bg', { gradientAngle })} format={(v) => `${v}°`} />
            </Row>
          </>
        )}
        {s.bg.kind === 'image' && (
          <>
            <Row label="Image">
              <FilePick accept="image/*" label={hasBgImage ? 'Replace…' : 'Upload…'} onFile={onBgImage} />
            </Row>
            {!hasBgImage && <p className="text-xs text-neutral-500">Until you upload one, the solid color is used.</p>}
            <Row label="Dark overlay">
              <Slider value={s.bg.overlay} min={0} max={0.9} onChange={(overlay) => set('bg', { overlay })} format={pct} />
            </Row>
          </>
        )}
      </Section>

      <Section title="Waveform" right={<Toggle value={s.wave.enabled} onChange={(enabled) => set('wave', { enabled })} />}>
        <Segmented<WaveStyle>
          value={s.wave.style}
          onChange={(style) => set('wave', { style })}
          options={[
            { value: 'bars', label: 'Bars' },
            { value: 'line', label: 'Line' },
            { value: 'circular', label: 'Circular' },
          ]}
        />
        {s.wave.style === 'circular' && hasLogo && <p className="text-xs text-neutral-500">Circular wraps around your logo.</p>}
        <Row label="Color">
          <Color value={s.wave.color} onChange={(color) => set('wave', { color })} />
        </Row>
        <Row label="Position">
          <Slider value={s.wave.position} min={0.05} max={0.95} onChange={(position) => set('wave', { position })} format={pct} />
        </Row>
        <Row label="Height">
          <Slider value={s.wave.height} min={0.04} max={0.5} onChange={(height) => set('wave', { height })} format={pct} />
        </Row>
      </Section>

      <Section title="Captions" right={<Toggle value={s.captions.enabled} onChange={(enabled) => set('captions', { enabled })} />}>
        <Row label="Font">
          <Select value={s.captions.font} options={FONTS} onChange={(font) => set('captions', { font })} />
        </Row>
        <Row label="Size">
          <Slider value={s.captions.size} min={28} max={140} step={1} onChange={(size) => set('captions', { size })} format={(v) => `${v}`} />
        </Row>
        <Row label="Text color">
          <Color value={s.captions.color} onChange={(color) => set('captions', { color })} />
        </Row>
        <Row label="Active word">
          <Color value={s.captions.highlight} onChange={(highlight) => set('captions', { highlight })} />
        </Row>
        <Row label="Position">
          <Slider value={s.captions.position} min={0.05} max={0.95} onChange={(position) => set('captions', { position })} format={pct} />
        </Row>
        <Row label="Words per line">
          <Slider value={s.captions.maxWordsPerLine} min={1} max={8} step={1} onChange={(maxWordsPerLine) => set('captions', { maxWordsPerLine })} format={(v) => `${v}`} />
        </Row>
        <Row label="Lines">
          <Slider value={s.captions.lines} min={1} max={3} step={1} onChange={(lines) => set('captions', { lines })} format={(v) => `${v}`} />
        </Row>
        <Row label="UPPERCASE">
          <Toggle value={s.captions.uppercase} onChange={(uppercase) => set('captions', { uppercase })} />
        </Row>
      </Section>

      <Section title="Title" defaultOpen={false}>
        <textarea
          value={s.title.text}
          onChange={(e) => set('title', { text: e.target.value })}
          placeholder="Optional title, e.g. episode name"
          rows={2}
          className="w-full resize-none rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm outline-none focus:border-indigo-400"
        />
        <Row label="Font">
          <Select value={s.title.font} options={FONTS} onChange={(font) => set('title', { font })} />
        </Row>
        <Row label="Size">
          <Slider value={s.title.size} min={24} max={120} step={1} onChange={(size) => set('title', { size })} format={(v) => `${v}`} />
        </Row>
        <Row label="Color">
          <Color value={s.title.color} onChange={(color) => set('title', { color })} />
        </Row>
        <Row label="Position">
          <Slider value={s.title.position} min={0.03} max={0.97} onChange={(position) => set('title', { position })} format={pct} />
        </Row>
      </Section>

      <Section title="Logo / headshot" defaultOpen={false}>
        <Row label="Image">
          <div className="flex gap-2">
            {hasLogo && (
              <button className="text-xs text-neutral-400 hover:text-red-400" onClick={onClearLogo}>
                Remove
              </button>
            )}
            <FilePick accept="image/*" label={hasLogo ? 'Replace…' : 'Upload…'} onFile={onLogo} />
          </div>
        </Row>
        {hasLogo && (
          <>
            <Row label="Circle crop">
              <Toggle value={s.logo.round} onChange={(round) => set('logo', { round })} />
            </Row>
            <Row label="Size">
              <Slider value={s.logo.size} min={0.06} max={0.6} onChange={(size) => set('logo', { size })} format={pct} />
            </Row>
            <Row label="Horizontal">
              <Slider value={s.logo.x} min={0.05} max={0.95} onChange={(x) => set('logo', { x })} format={pct} />
            </Row>
            <Row label="Vertical">
              <Slider value={s.logo.y} min={0.05} max={0.95} onChange={(y) => set('logo', { y })} format={pct} />
            </Row>
          </>
        )}
      </Section>
    </div>
  );
}
