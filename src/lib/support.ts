import { canEncodeVideo } from 'mediabunny';
import { webCodecsAvailable } from './exporter';

export interface Support {
  ok: boolean;
  reason?: string;
}

/** Export needs WebCodecs with an H.264 encoder. AAC is covered by a wasm fallback where the browser lacks it. */
export async function checkExportSupport(): Promise<Support> {
  if (!webCodecsAvailable()) return { ok: false, reason: "This browser doesn't support WebCodecs video encoding." };
  try {
    if (!(await canEncodeVideo('avc', { width: 1920, height: 1080, bitrate: 6_000_000 })))
      return { ok: false, reason: "This browser can't encode H.264 video." };
  } catch {
    return { ok: false, reason: "This browser can't encode H.264 video." };
  }
  return { ok: true };
}
