import { DEFAULT_SETTINGS, type Settings } from "../../contract/contract";

/** Lyric, highlight and dim colors as #rrggbb. */
export type Palette = Settings["colors"];

/** Artwork is sampled at this many pixels square. */
export const SAMPLE_SIZE = 48;
/** A color needs this share of the cover to be picked as the highlight. */
const MIN_SHARE = 0.008;
/** Below this chroma a cover has no hue worth matching. */
const GRAY_CHROMA = 0.08;
/** On a gray cover, an accent at least this colorful still sets the highlight, however small. */
const ACCENT_CHROMA = 0.2;
/** Keeps near-black or near-white covers from tinting the lyrics with a hue you can't see in them. */
const TINT_PER_CHROMA = 1.5;

/** Average color of one 4-bit-per-channel bucket. h, s, l and chroma c are 0..1. */
interface Bucket {
  n: number;
  h: number;
  s: number;
  l: number;
  c: number;
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const [rf, gf, bf] = [r / 255, g / 255, b / 255];
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rf ? (gf - bf) / d + (gf < bf ? 6 : 0) : max === gf ? (bf - rf) / d + 2 : (rf - gf) / d + 4;
  return [h / 6, s, l];
}

export function hslToHex(h: number, s: number, l: number): string {
  const channel = (n: number): string => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

export function hexToHsl(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function buckets(rgba: ArrayLike<number>): Bucket[] {
  const sums = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if ((rgba[i + 3] ?? 0) < 128) continue;
    const r = rgba[i] ?? 0;
    const g = rgba[i + 1] ?? 0;
    const b = rgba[i + 2] ?? 0;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const sum = sums.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    sum.r += r;
    sum.g += g;
    sum.b += b;
    sum.n++;
    sums.set(key, sum);
  }
  return [...sums.values()].map(({ r, g, b, n }) => {
    const [ar, ag, ab] = [r / n, g / n, b / n];
    const [h, s, l] = rgbToHsl(ar, ag, ab);
    return { n, h, s, l, c: (Math.max(ar, ag, ab) - Math.min(ar, ag, ab)) / 255 };
  });
}

/** Highlight from a bucket's hue, forced vivid and mid-light so it reads on any wallpaper. */
const highlightFrom = (b: Bucket): string => hslToHex(b.h, Math.max(b.s, 0.62), clamp(b.l, 0.62, 0.72));

/**
 * Picks overlay colors from RGBA pixels (a 48×48 sample of the cover). The most common color
 * tints the lyric and dim colors; the most vivid common color becomes the highlight. Lyrics stay
 * at lightness ≥ 0.85 and the highlight at lightness 0.6–0.75 with saturation ≥ 0.55. Gray covers
 * get the default warm white and the most colorful pixel, or the default highlight.
 */
export function paletteFromPixels(rgba: ArrayLike<number>): Palette {
  const all = buckets(rgba);
  const total = all.reduce((sum, b) => sum + b.n, 0);
  const defaults = DEFAULT_SETTINGS.colors;
  const dominant = all.reduce<Bucket | undefined>((a, b) => (a && a.n >= b.n ? a : b), undefined);
  if (!dominant) return { ...defaults };

  const score = (b: Bucket): number => b.c * (1 - Math.abs(b.l - 0.55)) * Math.sqrt(b.n);
  const vivid = all.filter((b) => b.n > total * MIN_SHARE).reduce((a, b) => (score(b) > score(a) ? b : a), dominant);

  if (vivid.c < GRAY_CHROMA) {
    const accent = all.reduce((a, b) => (b.c > a.c ? b : a), dominant);
    return { ...defaults, highlight: accent.c >= ACCENT_CHROMA ? highlightFrom(accent) : defaults.highlight };
  }
  const tint = Math.min(dominant.s, dominant.c * TINT_PER_CHROMA);
  return {
    lyric: hslToHex(dominant.h, Math.min(tint, 0.3), 0.92),
    highlight: highlightFrom(vivid),
    dim: hslToHex(dominant.h, Math.min(tint, 0.18), 0.66),
  };
}

/** Decodes artwork (a data: URL) and samples it at 48×48 RGBA. Null when it can't be decoded. */
export async function readArtwork(artwork: string): Promise<Uint8ClampedArray | null> {
  try {
    const img = new Image();
    img.src = artwork;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    return ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  } catch {
    return null;
  }
}

export type ArtworkReader = (artwork: string) => Promise<ArrayLike<number> | null>;

/**
 * Album colors per track, computed once per track and artwork, off the animation path.
 * Resolves to null with no artwork or undecodable artwork; the renderer then uses `settings.colors`.
 */
export class PaletteCache {
  private readonly entries = new Map<string, { artwork: string | null; palette: Promise<Palette | null> }>();
  private readonly read: ArtworkReader;
  private readonly limit: number;

  constructor(read: ArtworkReader = readArtwork, limit = 32) {
    this.read = read;
    this.limit = limit;
  }

  get(trackKey: string, artwork: string | null): Promise<Palette | null> {
    const hit = this.entries.get(trackKey);
    this.entries.delete(trackKey);
    // Artwork can arrive after the track does, so a new picture for the same track recomputes.
    const palette =
      hit && hit.artwork === artwork
        ? hit.palette
        : artwork === null
          ? Promise.resolve(null)
          : this.read(artwork).then((px) => (px ? paletteFromPixels(px) : null), () => null);
    this.entries.set(trackKey, { artwork, palette });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit) break;
      this.entries.delete(oldest);
    }
    return palette;
  }
}
