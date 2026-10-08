import type { Analysis } from './edit';
import { activeWordIndex, pageAt, type CaptionPage } from './captions';
import { ASPECT_SIZES, type Settings } from './types';

export interface RenderAssets {
  bgImage: ImageBitmap | null;
  logo: ImageBitmap | null;
}

export interface Scene {
  settings: Settings;
  analysis: Analysis | null;
  pages: CaptionPage[];
  assets: RenderAssets;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function canvasSize(s: Settings): [number, number] {
  return ASPECT_SIZES[s.aspect];
}

/**
 * Draws one complete frame for source time t. Used by both the live preview and the offline exporter, so
 * the exported video matches the preview exactly. Must be a pure function of (scene, t).
 */
export function drawFrame(ctx: Ctx, scene: Scene, t: number) {
  const { settings: s } = scene;
  const [W, H] = canvasSize(s);
  const u = Math.min(W, H) / 1080; // unit: settings are authored for a 1080 px short side

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.textBaseline = 'alphabetic';
  drawBackground(ctx, scene, W, H);
  if (s.wave.enabled && scene.analysis) drawWave(ctx, scene, t, W, H, u);
  if (scene.assets.logo) drawLogo(ctx, scene, W, H);
  if (s.title.text.trim()) drawTitle(ctx, s, W, H, u);
  if (s.captions.enabled) drawCaptions(ctx, scene, t, W, H, u);
  ctx.restore();
}

function drawBackground(ctx: Ctx, { settings: s, assets }: Scene, W: number, H: number) {
  const bg = s.bg;
  if (bg.kind === 'image' && assets.bgImage) {
    const img = assets.bgImage;
    const scale = Math.max(W / img.width, H / img.height); // cover
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    if (bg.overlay > 0) {
      ctx.fillStyle = `rgba(0,0,0,${bg.overlay})`;
      ctx.fillRect(0, 0, W, H);
    }
  } else if (bg.kind === 'gradient') {
    const a = ((bg.gradientAngle - 90) * Math.PI) / 180;
    const r = (Math.abs(W * Math.cos(a)) + Math.abs(H * Math.sin(a))) / 2;
    const cx = W / 2;
    const cy = H / 2;
    const g = ctx.createLinearGradient(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    g.addColorStop(0, bg.gradientFrom);
    g.addColorStop(1, bg.gradientTo);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawWave(ctx: Ctx, scene: Scene, t: number, W: number, H: number, u: number) {
  const { wave } = scene.settings;
  const bands = scene.analysis!.bands(t);
  const level = scene.analysis!.level(t);
  const cy = wave.position * H;
  const maxH = wave.height * H;
  ctx.fillStyle = wave.color;
  ctx.strokeStyle = wave.color;

  if (wave.style === 'bars') {
    const n = W > H ? 64 : 40;
    const span = W * (W > H ? 0.8 : 0.84);
    const x0 = (W - span) / 2;
    const step = span / n;
    const bw = step * 0.56;
    for (let i = 0; i < n; i++) {
      // Mirror around the centre: low frequencies in the middle, highs at the edges.
      const d = Math.abs(i - (n - 1) / 2) / ((n - 1) / 2);
      const v = sampleBands(bands, d * 0.85);
      const h = Math.max(bw, v * maxH);
      roundRect(ctx, x0 + i * step + (step - bw) / 2, cy - h / 2, bw, h, bw / 2);
      ctx.fill();
    }
  } else if (wave.style === 'line') {
    const n = 72;
    const span = W * 0.86;
    const x0 = (W - span) / 2;
    const pts: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const d = Math.abs(i - n / 2) / (n / 2);
      const taper = Math.sin(Math.PI * (i / n)); // pinned to the centre line at both ends
      const v = sampleBands(bands, d * 0.85) * taper;
      pts.push([x0 + (i / n) * span, (v * maxH) / 2]);
    }
    for (const sign of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], cy);
      for (let i = 1; i < pts.length; i++) {
        const [x1, y1] = pts[i - 1];
        const [x2, y2] = pts[i];
        ctx.quadraticCurveTo(x1, cy + sign * y1, (x1 + x2) / 2, cy + sign * ((y1 + y2) / 2));
      }
      ctx.lineTo(pts[pts.length - 1][0], cy);
      ctx.globalAlpha = 0.22;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 4 * u;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2 * u;
    ctx.moveTo(x0, cy);
    ctx.lineTo(x0 + span, cy);
    ctx.stroke();
    ctx.globalAlpha = 1;
  } else {
    // circular
    const cx = scene.assets.logo ? scene.settings.logo.x * W : W / 2;
    const ccy = scene.assets.logo ? scene.settings.logo.y * H : cy;
    const baseR = scene.assets.logo
      ? (scene.settings.logo.size * Math.min(W, H)) / 2 + 14 * u
      : Math.min(W, H) * 0.14 * (1 + level * 0.08);
    const n = 96;
    const bw = Math.max(3 * u, ((2 * Math.PI * baseR) / n) * 0.5);
    ctx.lineWidth = bw;
    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const d = Math.abs(((i + n / 2) % n) - n / 2) / (n / 2); // mirrored left/right
      const v = sampleBands(bands, d * 0.85);
      const len = Math.max(bw * 0.2, v * maxH * 0.6);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * baseR, ccy + Math.sin(a) * baseR);
      ctx.lineTo(cx + Math.cos(a) * (baseR + len), ccy + Math.sin(a) * (baseR + len));
      ctx.stroke();
    }
    if (!scene.assets.logo) {
      ctx.globalAlpha = 0.18 + level * 0.25;
      ctx.beginPath();
      ctx.arc(cx, ccy, baseR - bw, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}

/** Linear interpolation into the band array at fractional position p in [0, 1]. */
function sampleBands(bands: Float32Array, p: number) {
  const x = p * (bands.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  return bands[i] * (1 - f) + (bands[Math.min(bands.length - 1, i + 1)] ?? 0) * f;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

function drawLogo(ctx: Ctx, { settings: s, assets }: Scene, W: number, H: number) {
  const img = assets.logo!;
  const size = s.logo.size * Math.min(W, H);
  const cx = s.logo.x * W;
  const cy = s.logo.y * H;
  ctx.save();
  if (s.logo.round) {
    ctx.beginPath();
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
    ctx.clip();
    const scale = Math.max(size / img.width, size / img.height);
    ctx.drawImage(img, cx - (img.width * scale) / 2, cy - (img.height * scale) / 2, img.width * scale, img.height * scale);
  } else {
    const scale = Math.min(size / img.width, size / img.height);
    ctx.drawImage(img, cx - (img.width * scale) / 2, cy - (img.height * scale) / 2, img.width * scale, img.height * scale);
  }
  ctx.restore();
}

export function fontString(weight: number, px: number, family: string) {
  return `${weight} ${px}px "${family}", system-ui, sans-serif`;
}

function drawTitle(ctx: Ctx, s: Settings, W: number, H: number, u: number) {
  const px = s.title.size * u;
  ctx.font = fontString(700, px, s.title.font);
  ctx.fillStyle = s.title.color;
  ctx.textAlign = 'center';
  const lines = wrapText(ctx, s.title.text, W * 0.86);
  const lh = px * 1.2;
  const y0 = s.title.position * H - ((lines.length - 1) * lh) / 2 + px * 0.35;
  setShadow(ctx, u);
  lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + i * lh));
  clearShadow(ctx);
  ctx.textAlign = 'left';
}

function wrapText(ctx: Ctx, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxW) {
        out.push(line);
        line = word;
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

function setShadow(ctx: Ctx, u: number) {
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 12 * u;
  ctx.shadowOffsetY = 3 * u;
}
function clearShadow(ctx: Ctx) {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

function drawCaptions(ctx: Ctx, scene: Scene, t: number, W: number, H: number, u: number) {
  const c = scene.settings.captions;
  const page = pageAt(scene.pages, t);
  if (!page) return;
  const active = activeWordIndex(page, t);
  const maxW = W * 0.88;
  let px = c.size * u;
  const texts = page.words.map((w) => (c.uppercase ? w.text.toUpperCase() : w.text));

  // Lines of at most maxWordsPerLine words; shrink the font if any line is still too wide.
  const lines: number[][] = [];
  for (let i = 0; i < texts.length; i += c.maxWordsPerLine)
    lines.push(texts.slice(i, i + c.maxWordsPerLine).map((_, k) => i + k));
  let space = 0;
  let widths: number[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    ctx.font = fontString(800, px, c.font);
    space = ctx.measureText(' ').width;
    widths = texts.map((tx) => ctx.measureText(tx).width);
    const widest = Math.max(...lines.map((l) => l.reduce((a, i) => a + widths[i], 0) + space * (l.length - 1)));
    if (widest <= maxW) break;
    px *= Math.max(0.6, maxW / widest);
  }

  const lh = px * 1.25;
  const blockH = lh * lines.length;
  let y = c.position * H - blockH / 2 + px * 0.95;
  setShadow(ctx, u);
  for (const line of lines) {
    const lw = line.reduce((a, i) => a + widths[i], 0) + space * (line.length - 1);
    let x = (W - lw) / 2;
    for (const i of line) {
      if (i === active) {
        // Pill behind the active word for legibility on busy backgrounds.
        ctx.save();
        clearShadow(ctx);
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = c.highlight;
        roundRect(ctx, x - px * 0.16, y - px * 0.92, widths[i] + px * 0.32, px * 1.18, px * 0.2);
        ctx.fill();
        ctx.restore();
        setShadow(ctx, u);
      }
      ctx.fillStyle = i === active ? c.highlight : c.color;
      ctx.globalAlpha = i <= active || active < 0 ? 1 : 0.88;
      ctx.fillText(texts[i], x, y);
      x += widths[i] + space;
    }
    ctx.globalAlpha = 1;
    y += lh;
  }
  clearShadow(ctx);
}

/** Wait until the fonts the scene uses are ready, so the first exported frames don't use a fallback font. */
export async function ensureFonts(s: Settings) {
  if (typeof document === 'undefined') return;
  await Promise.all([
    document.fonts.load(fontString(800, 64, s.captions.font)),
    document.fonts.load(fontString(700, 64, s.title.font)),
  ]).catch(() => {});
}
