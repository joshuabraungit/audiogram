import { useState } from 'react';

const ACCEPT = '.mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/aac';

export function isAcceptedAudio(f: File) {
  return /\.(mp3|wav|m4a)$/i.test(f.name) || /^audio\/(mpeg|wav|x-wav|wave|mp4|x-m4a|aac)$/.test(f.type);
}

export function DropZone({ onFile, error }: { onFile: (f: File) => void; error?: string | null }) {
  const [over, setOver] = useState(false);
  return (
    <div className="flex h-full items-center justify-center p-8">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f) onFile(f);
        }}
        className={`flex w-full max-w-xl cursor-pointer flex-col items-center gap-4 rounded-2xl border-2 border-dashed px-10 py-16 text-center transition ${
          over ? 'border-indigo-400 bg-indigo-500/10' : 'border-neutral-700 hover:border-neutral-500'
        }`}
      >
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-indigo-300">
          <path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2M21 12h0" strokeLinecap="round" />
        </svg>
        <div>
          <div className="text-lg font-semibold text-neutral-100">Drop an audio file</div>
          <div className="mt-1 text-sm text-neutral-400">MP3, WAV or M4A · everything stays on your computer</div>
        </div>
        <span className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white">Choose file</span>
        {error && <div className="text-sm text-red-400">{error}</div>}
        <input
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
      </label>
    </div>
  );
}
