import { DEFAULT_SETTINGS, type Settings } from "../../contract/contract";

/**
 * Lyric, highlight and dim colors as #rrggbb, and, from a cover, the `accent` the highlight blends
 * into: the sung words are filled with a gradient from one to the other (stage.css, `accentFor`
 * when there is none).
 */
export type Palette = Settings["colors"] & { accent?: string };

/**
 * What a cover looks like, for the look picker (core/songlook.ts). Read from the palette's own 48×48
 * sample, in the same pass, and rounded to three decimals.
 */
export interface CoverStats {
  /** mean HSL lightness, 0..1 */
  lightness: number;
  /** standard deviation of lightness, 0..0.5 */
  contrast: number;
  /** mean chroma ((max − min) / 255), 0..1 */
  chroma: number;
  /** Hasler–Süsstrunk colorfulness ÷ 110, capped at 1 (extremely colorful) */
  colorfulness: number;
  /** −1 cool (blue) .. +1 warm (orange), faded toward 0 on near-gray covers */
  warmth: number;
  /** share of pixels with chroma below 0.08 */
  gray: number;
  /** chroma-weighted mean hue 0..1, or null for a gray cover (92% gray pixels or more) */
  hue: number | null;
}

/** Artwork is sampled at this many pixels square. */
export const SAMPLE_SIZE = 48;
/** A color needs this share of the cover to be picked as the highlight. */
const MIN_SHARE = 0.008;
/** Below this chroma a cover has no hue worth matching. */
const GRAY_CHROMA = 0.08;
/** On a gray cover, an accent at least this colorful still sets the highlight, however small. */
const ACCENT_CHROMA = 0.2;
/**
 * The cover's colors tint the lyric and dim colors in full once they cover this share of it, and not
 * at all below COLOR_FROM: a sun on a black sky is the cover's color, however much sky there is.
 */
const COLOR_FROM = 0.04;
const COLOR_FULL = 0.3;
/** The warmest hue (orange), in turns; its opposite (blue) is the coolest. */
const WARM_HUE = 40 / 360;
/** A cover with at least this share of gray pixels has no hue. */
const GRAY_COVER = 0.92;
/**
 * The second color. One this muted still counts: the dark olive of ivy, a dusty rose. Its share of the
 * cover counts in full from FAMILY_FULL_CHROMA up and less below, so a big muted area can outweigh a
 * small vivid one, as it does to the eye.
 */
const FAMILY_CHROMA = 0.035;
const FAMILY_FULL_CHROMA = 0.12;
/** The second color is looked for among this many hue bins (15° each)... */
const HUE_BINS = 24;
/** ...at least this far from the highlight's hue (turns, 40°)... */
const ACCENT_HUE_GAP = 0.11;
/** ...weighing at least this share of the cover's main color (both three bins wide). */
const ACCENT_MASS = 0.12;

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
/** 0 at or below a, 1 at or above b, smooth in between. */
function smoothstep(x: number, a: number, b: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
/** Three decimals, never −0. */
const round3 = (v: number): number => Math.round(v * 1000) / 1000 + 0;

/** Calls `visit` with each pixel of an RGBA sample that is at least half opaque. */
function eachOpaque(rgba: ArrayLike<number>, visit: (r: number, g: number, b: number) => void): void {
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if ((rgba[i + 3] ?? 0) < 128) continue;
    visit(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0);
  }
}

/** The palette's 4-bit-per-channel buckets, filled one pixel at a time. */
class BucketSums {
  private readonly sums = new Map<number, { r: number; g: number; b: number; n: number }>();

  add(r: number, g: number, b: number): void {
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const sum = this.sums.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    sum.r += r;
    sum.g += g;
    sum.b += b;
    sum.n++;
    this.sums.set(key, sum);
  }

  /** Buckets in the order their first pixel came. */
  buckets(): Bucket[] {
    return [...this.sums.values()].map(({ r, g, b, n }) => {
      const [ar, ag, ab] = [r / n, g / n, b / n];
      const [h, s, l] = rgbToHsl(ar, ag, ab);
      return { n, h, s, l, c: (Math.max(ar, ag, ab) - Math.min(ar, ag, ab)) / 255 };
    });
  }
}

/** The sums behind CoverStats, filled one pixel at a time. */
class CoverSums {
  private n = 0;
  private lightness = 0;
  private lightness2 = 0;
  private chroma = 0;
  private grays = 0;
  // the opponent channels behind colorfulness: red-green and yellow-blue
  private rg = 0;
  private rg2 = 0;
  private yb = 0;
  private yb2 = 0;
  // over the pixels with a hue, weighted by chroma: the hue as a vector, and its warmth
  private hueX = 0;
  private hueY = 0;
  private warmth = 0;
  private weight = 0;

  add(r: number, g: number, b: number): void {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 510;
    const c = (max - min) / 255;
    this.n++;
    this.lightness += l;
    this.lightness2 += l * l;
    this.chroma += c;
    const rg = r - g;
    const yb = 0.5 * (r + g) - b;
    this.rg += rg;
    this.rg2 += rg * rg;
    this.yb += yb;
    this.yb2 += yb * yb;
    if (c < GRAY_CHROMA) {
      this.grays++;
      return;
    }
    const angle = rgbToHsl(r, g, b)[0] * 2 * Math.PI;
    this.hueX += c * Math.cos(angle);
    this.hueY += c * Math.sin(angle);
    this.warmth += c * Math.cos(angle - WARM_HUE * 2 * Math.PI);
    this.weight += c;
  }

  /** Null without a single opaque pixel. */
  stats(): CoverStats | null {
    const n = this.n;
    if (n === 0) return null;
    const meanL = this.lightness / n;
    const meanC = this.chroma / n;
    const rgMean = this.rg / n;
    const ybMean = this.yb / n;
    const rgSd = Math.sqrt(Math.max(0, this.rg2 / n - rgMean ** 2));
    const ybSd = Math.sqrt(Math.max(0, this.yb2 / n - ybMean ** 2));
    const colorfulness = (Math.hypot(rgSd, ybSd) + 0.3 * Math.hypot(rgMean, ybMean)) / 110;
    const gray = this.grays / n;
    const hued = this.weight > 0;
    return {
      lightness: round3(meanL),
      contrast: round3(Math.sqrt(Math.max(0, this.lightness2 / n - meanL ** 2))),
      chroma: round3(meanC),
      colorfulness: round3(clamp(colorfulness, 0, 1)),
      warmth: round3(hued ? (this.warmth / this.weight) * smoothstep(meanC, 0.02, 0.12) : 0),
      gray: round3(gray),
      hue: hued && gray < GRAY_COVER ? round3((((Math.atan2(this.hueY, this.hueX) / (2 * Math.PI)) % 1) + 1) % 1) : null,
    };
  }
}

/**
 * Highlight from a bucket's color, kept as colorful as the cover has it (at least 0.56, so 0.55 once
 * rounded to hex) and mid-light so it reads on any wallpaper; no lighter than `most`.
 */
const highlightFrom = (b: Pick<Bucket, "h" | "s" | "l">, most = 0.74): string => hslToHex(b.h, clamp(b.s, 0.56, 0.95), clamp(b.l, 0.6, most));
/** Hues this close (in turns) read as one color: the highlight then keeps darker than the lyrics. */
const SAME_HUE = 0.08;
/**
 * The gradient's second color from the cover's: as light as the highlight band, but allowed to stay as
 * muted as the cover has it (from 0.36), so an olive stays an olive rather than turning lime.
 */
const accentFrom = (f: Pick<Bucket, "h" | "s" | "l">): string => hslToHex(f.h, clamp(f.s * 1.2, 0.36, 0.9), clamp(f.l, 0.62, 0.74));

/**
 * The color a highlight blends into when its cover gives no second one (one-color covers, the user's
 * own colors): its neighbor on the color wheel, a touch lighter, so the sung words still shade.
 */
export function accentFor(highlight: string): string {
  const [h, s, l] = hexToHsl(highlight);
  if (s < 0.08) return hslToHex(0, 0, clamp(l + 0.08, 0, 0.98));
  return hslToHex((h + 0.055) % 1, clamp(s, 0, 1), clamp(l + 0.08, 0.6, 0.82));
}

/** WCAG relative luminance of a #rrggbb color. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** WCAG contrast ratio between two #rrggbb colors, 1..21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The tag behind a word must let the lyric color read on it at least this well (WCAG large text is 3). */
export const TAG_CONTRAST = 3.4;
/** A grey highlight's tag: marker red (hue, saturation, lightness). */
const TAG_MARKER: readonly [number, number, number] = [0.99, 0.78, 0.5];

/**
 * The color of the tag a word is set on (Slant's sung word, Tape's strips): the highlight's own hue,
 * saturated like a marker, and taken darker (under light lyrics) or lighter (under dark ones) until the
 * lyric color reads on it at TAG_CONTRAST. A grey highlight (a black and white cover) gets a red
 * marker instead: a grey tag reads as a disabled button, not as ink.
 */
export function tagFor(lyric: string, highlight: string): string {
  const grey = hexToHsl(highlight)[1] < 0.12;
  const [h, s0, l0] = grey ? TAG_MARKER : hexToHsl(highlight);
  const s = clamp(s0 * 1.15, 0.5, 0.92);
  const darker = luminance(lyric) > 0.4;
  let l = clamp(l0, 0.2, 0.8);
  let color = hslToHex(h, s, l);
  for (let i = 0; i < 40 && contrast(lyric, color) < TAG_CONTRAST; i++) {
    l = clamp(l + (darker ? -0.02 : 0.02), 0, 1);
    color = hslToHex(h, s, l);
  }
  return color;
}

/**
 * The cover's colors by hue, for its second color (`second`): every pixel at least FAMILY_CHROMA
 * colorful, in HUE_BINS bins, each weighted by its share of the cover, a muted one less (pixels, not
 * the palette's buckets: averaging a 16-level bucket turns dark olive gray).
 */
class HueSums {
  private readonly bins = Array.from({ length: HUE_BINS }, () => ({ w: 0, x: 0, y: 0, s: 0, l: 0 }));
  private n = 0;

  add(r: number, g: number, b: number): void {
    this.n++;
    const c = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    if (c < FAMILY_CHROMA) return;
    const [h, s, l] = rgbToHsl(r, g, b);
    const w = Math.min(1, c / FAMILY_FULL_CHROMA);
    const bin = this.bins[Math.floor(h * HUE_BINS) % HUE_BINS] as HueBin;
    bin.w += w;
    bin.x += w * Math.cos(h * 2 * Math.PI);
    bin.y += w * Math.sin(h * 2 * Math.PI);
    bin.s += w * s;
    bin.l += w * l;
  }

  /**
   * The color the highlight blends into: the heaviest bin at least ACCENT_HUE_GAP from the highlight's
   * hue `from` (more distant hues counting more), with its neighbors that are as far, averaged; none
   * when they weigh less than ACCENT_MASS of the cover's main color, both three bins wide. A cover
   * that shades from one color into the next (a brown door into green ivy) has no second peak, so
   * this looks for weight, not peaks.
   */
  second(from: number): { h: number; s: number; l: number } | undefined {
    if (this.n === 0) return undefined;
    const bin = (i: number): HueBin => this.bins[(i + HUE_BINS) % HUE_BINS] as HueBin;
    const distance = (i: number): number => {
      const gap = Math.abs((i + 0.5) / HUE_BINS - from);
      return Math.min(gap, 1 - gap);
    };
    const away = (i: number): boolean => distance(i) >= ACCENT_HUE_GAP;
    // a bin counts more the further its hue is from the highlight's: the fringe of a big color next to
    // it (a sky's violet edge) must not outweigh a true second color (its orange horizon)
    const score = (i: number): number => bin(i).w * smoothstep(distance(i), ACCENT_HUE_GAP * 0.75, 0.25);
    let best = -1;
    for (let i = 0; i < HUE_BINS; i++) if (away(i) && (best < 0 || score(i) > score(best))) best = i;
    if (best < 0 || bin(best).w <= 0) return undefined;
    const sum = { w: 0, x: 0, y: 0, s: 0, l: 0 };
    for (const i of [best - 1, best, best + 1]) {
      if (!away(i)) continue;
      const b = bin(i);
      sum.w += b.w;
      sum.x += b.x;
      sum.y += b.y;
      sum.s += b.s;
      sum.l += b.l;
    }
    // weighed as colors are seen, three bins (45°) at a time: one spread over a few bins is still one color
    const heaviest = Math.max(...this.bins.map((_, i) => bin(i - 1).w + bin(i).w + bin(i + 1).w));
    if (sum.w < ACCENT_MASS * heaviest) return undefined;
    return { h: (((Math.atan2(sum.y, sum.x) / (2 * Math.PI)) % 1) + 1) % 1, s: sum.s / sum.w, l: sum.l / sum.w };
  }
}
interface HueBin {
  w: number;
  x: number;
  y: number;
  s: number;
  l: number;
}

/**
 * Picks overlay colors from RGBA pixels (a 48×48 sample of the cover), so the lyrics look like the
 * cover: the most vivid common color is the highlight (the words being sung), and the cover's tone
 * tints the lyric color (the words still to come) and the dim color (the other lines), as strongly
 * as the cover is colorful. Lyrics stay at lightness ≥ 0.85 and the highlight at lightness 0.6–0.74
 * with saturation ≥ 0.55. A gray cover (black and white, or a toned photo) gets grays: the highlight
 * near white, the lyrics a light gray, or its colorful accent as the highlight.
 */
export function paletteFromPixels(rgba: ArrayLike<number>): Palette {
  const sums = new BucketSums();
  const hues = new HueSums();
  eachOpaque(rgba, (r, g, b) => {
    sums.add(r, g, b);
    hues.add(r, g, b);
  });
  return paletteOf(sums.buckets(), hues);
}

/**
 * What a cover looks like (CoverStats) from RGBA pixels, the palette's 48×48 sample: lightness and
 * its spread, chroma, colorfulness, warmth, the share of gray and the mean hue, over the pixels that
 * are at least half opaque. Null when none is.
 */
export function coverStats(rgba: ArrayLike<number>): CoverStats | null {
  const sums = new CoverSums();
  eachOpaque(rgba, (r, g, b) => sums.add(r, g, b));
  return sums.stats();
}

/** The palette and the cover's statistics, in one pass over the sample. */
function readSample(rgba: ArrayLike<number>): { palette: Palette; cover: CoverStats | null } {
  const buckets = new BucketSums();
  const hues = new HueSums();
  const stats = new CoverSums();
  eachOpaque(rgba, (r, g, b) => {
    buckets.add(r, g, b);
    hues.add(r, g, b);
    stats.add(r, g, b);
  });
  return { palette: paletteOf(buckets.buckets(), hues), cover: stats.stats() };
}

function paletteOf(all: readonly Bucket[], hues: HueSums): Palette {
  const total = all.reduce((sum, b) => sum + b.n, 0);
  const dominant = all.reduce<Bucket | undefined>((a, b) => (a && a.n >= b.n ? a : b), undefined);
  if (!dominant) return { ...DEFAULT_SETTINGS.colors };

  const score = (b: Bucket): number => b.c * (1 - Math.abs(b.l - 0.55)) * Math.sqrt(b.n);
  const vivid = all.filter((b) => b.n > total * MIN_SHARE).reduce((a, b) => (score(b) > score(a) ? b : a), dominant);

  if (vivid.c < GRAY_CHROMA) {
    // Grays: a near-white highlight over light gray lyrics, or the cover's colorful accent, however
    // small. Its pixels are all but gray, so nothing tints them.
    const accent = all.reduce((a, b) => (b.c > a.c ? b : a), dominant);
    const highlight = accent.c >= ACCENT_CHROMA ? highlightFrom(accent) : hslToHex(0, 0, 0.96);
    return {
      lyric: hslToHex(0, 0, 0.74),
      highlight,
      dim: hslToHex(0, 0, 0.56),
      accent: accentFor(highlight),
    };
  }

  // The cover's tone: its colorful pixels' hues, each a vector as long as its chroma times its share.
  // The tint is as strong as those colors are saturated, as much of the cover as they take, and as
  // well as they agree on a hue (colors that clash leave the lyrics near neutral).
  let x = 0;
  let y = 0;
  let weight = 0;
  let saturation = 0;
  let colorful = 0;
  for (const b of all) {
    if (b.c < GRAY_CHROMA) continue;
    const k = (b.c * b.n) / total;
    x += k * Math.cos(b.h * 2 * Math.PI);
    y += k * Math.sin(b.h * 2 * Math.PI);
    weight += k;
    saturation += k * b.s;
    colorful += b.n / total;
  }
  const tone = (((Math.atan2(y, x) / (2 * Math.PI)) % 1) + 1) % 1;
  const agreement = weight > 0 ? Math.hypot(x, y) / weight : 0;
  const strength = weight > 0 ? (saturation / weight) * agreement * smoothstep(colorful, COLOR_FROM, COLOR_FULL) : 0;

  // A strongly toned cover tints the lyrics deeper; a highlight of the same hue then stays a step
  // darker than them, so the words being sung still stand out from the ones to come.
  const gap = Math.abs(vivid.h - tone);
  const sameHue = Math.min(gap, 1 - gap) < SAME_HUE && strength > 0.3;
  const highlight = highlightFrom(vivid, sameHue ? 0.66 : 0.74);
  // The sung words blend from the highlight into the cover's other main color, or, on a cover of one
  // color, the highlight's neighbor on the color wheel.
  const other = hues.second(vivid.h);
  return {
    lyric: hslToHex(tone, 0.12 + 0.6 * strength, 0.87 - 0.03 * strength),
    highlight,
    dim: hslToHex(tone, 0.08 + 0.4 * strength, 0.66),
    accent: other ? accentFrom(other) : accentFor(highlight),
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

interface CacheEntry {
  artwork: string | null;
  palette: Promise<Palette | null>;
  /** set by the decode behind `palette`, before it resolves */
  cover: CoverStats | null;
}

/**
 * Album colors per track, computed once per track and artwork, off the animation path, along with
 * the cover's statistics for the look picker: one decode and one pass over the sample for both.
 * Resolves to null with no artwork or undecodable artwork; the renderer then uses `settings.colors`.
 */
export class PaletteCache {
  private readonly entries = new Map<string, CacheEntry>();
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
    const entry = hit && hit.artwork === artwork ? hit : this.decode(artwork);
    this.entries.set(trackKey, entry);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit) break;
      this.entries.delete(oldest);
    }
    return entry.palette;
  }

  /**
   * The statistics of the track's cover, as of its latest `get()`: filled by the same decode as the
   * palette, before that promise resolves. Null until then, without artwork, when the artwork can't
   * be read, and for a track the cache doesn't hold. Doesn't count as a use for the cache's limit.
   */
  cover(trackKey: string): CoverStats | null {
    return this.entries.get(trackKey)?.cover ?? null;
  }

  private decode(artwork: string | null): CacheEntry {
    const entry: CacheEntry = { artwork, palette: Promise.resolve(null), cover: null };
    if (artwork === null) return entry;
    entry.palette = this.read(artwork).then(
      (px) => {
        if (!px) return null;
        const { palette, cover } = readSample(px);
        entry.cover = cover;
        return palette;
      },
      () => null,
    );
    return entry;
  }
}
