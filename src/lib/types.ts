export interface Word {
  id: number;
  text: string;
  start: number;
  end: number;
}

export type Aspect = '1:1' | '9:16' | '16:9';
export const ASPECT_SIZES: Record<Aspect, [number, number]> = {
  '1:1': [1080, 1080],
  '9:16': [1080, 1920],
  '16:9': [1920, 1080],
};
export const FPS = 30;

export type BackgroundKind = 'solid' | 'gradient' | 'image';
export type WaveStyle = 'bars' | 'line' | 'circular';

export interface Settings {
  aspect: Aspect;
  bg: {
    kind: BackgroundKind;
    color: string;
    gradientFrom: string;
    gradientTo: string;
    gradientAngle: number;
    /** 0..1 darkening layer over an uploaded image */
    overlay: number;
  };
  wave: {
    enabled: boolean;
    style: WaveStyle;
    color: string;
    /** vertical centre of the waveform, 0 (top) .. 1 (bottom) */
    position: number;
    /** height as a fraction of the canvas height */
    height: number;
  };
  captions: {
    enabled: boolean;
    font: string;
    /** px at 1080 width reference */
    size: number;
    color: string;
    highlight: string;
    position: number;
    maxWordsPerLine: number;
    lines: number;
    uppercase: boolean;
  };
  title: {
    text: string;
    font: string;
    size: number;
    color: string;
    position: number;
  };
  logo: {
    /** 0..1 position of the logo centre */
    x: number;
    y: number;
    size: number;
    round: boolean;
  };
}

export const FONTS = ['Inter', 'Montserrat', 'Space Grotesk', 'Playfair Display', 'Bebas Neue', 'Georgia', 'Arial'];

export const defaultSettings: Settings = {
  aspect: '1:1',
  bg: {
    kind: 'gradient',
    color: '#0f172a',
    gradientFrom: '#1e1b4b',
    gradientTo: '#0f766e',
    gradientAngle: 135,
    overlay: 0.4,
  },
  wave: { enabled: true, style: 'bars', color: '#ffffff', position: 0.62, height: 0.16 },
  captions: {
    enabled: true,
    font: 'Montserrat',
    size: 64,
    color: '#ffffff',
    highlight: '#facc15',
    position: 0.82,
    maxWordsPerLine: 4,
    lines: 2,
    uppercase: false,
  },
  title: { text: '', font: 'Inter', size: 56, color: '#ffffff', position: 0.1 },
  logo: { x: 0.5, y: 0.33, size: 0.22, round: true },
};
