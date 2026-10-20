/**
 * Where a one-line style puts the focus line's words (pure, no DOM). Lens, Poster, Spotlight, Wave,
 * Reveal and Collage share one engine (lens.ts): every word sits in a slot of its own, moved on the
 * compositor along a track planned for the line's whole window (lens-plan.ts planLens). Only the
 * layout differs:
 *
 * - Lens: one row, magnified like a loupe around where the song is sung (lens-plan.ts poseOf).
 * - Poster: the line set as a block of two to five rows, justified by size: a short row is set larger
 *   until it is as wide as the widest, like a gig poster. Each line is composed its own way: centered,
 *   pushed left or right, and some tilted a few degrees. Words not sung yet wait dim and a little small,
 *   and punch up to full as the voice reaches them.
 * - Spotlight: the line slides through the middle of the screen with the voice: the word being sung
 *   is large in the middle, its neighbors fall away smaller and fainter to either side.
 * - Wave: the line rides a wave whose crest travels with the voice: the word being sung rides up on
 *   it, a little larger, and its neighbors tilt along the slopes on either side.
 * - Reveal: the line appears as it's sung. Words not reached yet wait as faint ghosts, a little small
 *   and low; each one comes up into its place as the voice reaches it (its own swell is the punch).
 * - Collage: the line as words cut from different magazines: each its own size and tilt, a little off
 *   its row, set in one to three rows. Words not sung yet wait dim and small, and pop as they're sung.
 *
 * Every pose is a function of the motion's ease-in `lens` (0 at rest, 1 in full: reduced motion and
 * plain lyrics stay at rest) and of `a`, the singing position in words (lens-plan.ts singingAt,
 * smoothed). Sizes are px at the look's size; `fit` scales the whole line to the stage.
 */
import { MIN_TEXT_PX } from "../look";
import { blankPose, fitRow, OPACITY_MIN, poseOf, ROW_FIT, smallestScale, type LensPose, type RowFit, type Shape } from "./lens-plan";

export type SlotKind = "lens" | "poster" | "spotlight" | "wave" | "reveal" | "collage";

/** A poster's rows: which visual positions each holds, its width at the look's size and its scale. */
export interface PosterRow {
  from: number;
  to: number;
  width: number;
  scale: number;
}

export interface PosterBlock {
  rows: PosterRow[];
  /** -1 left, 0 centered, 1 right */
  align: -1 | 0 | 1;
  /** degrees, clockwise */
  tilt: number;
  /** the block's width and height at the look's size, before the fit */
  width: number;
  height: number;
  /** the baseline's depth in a 1 em box, as a share of the em */
  baseline: number;
  /** the look's size, px */
  size: number;
}

/** A collage's words: each its own size, tilt and drop off its row, set in rows. */
export interface CollageBlock {
  rows: { from: number; to: number; width: number; height: number }[];
  /** per word, by logical index: its size against the line's, its tilt (degrees), its drop below its row's baseline (em) */
  scale: number[];
  tilt: number[];
  drop: number[];
  /** the block's width and height at the look's size, before the fit */
  width: number;
  height: number;
  /** the baseline's depth in a 1 em box, as a share of the em */
  baseline: number;
  /** the look's size, px */
  size: number;
}

export interface SlotFit extends RowFit {
  /** Poster: its block */
  block?: PosterBlock;
  /** Collage: its block */
  collage?: CollageBlock;
  /** Spotlight, Wave and Reveal: the at-rest fit (one plain row), and how much larger than the line's size the sung word gets */
  restFit?: number;
  big?: number;
  /** Wave and Reveal: the look's size, px (the wave's height and a waiting word's drop are in it) */
  em?: number;
}

export interface Stage {
  width: number;
  height: number;
}

export interface SlotLayout {
  readonly kind: SlotKind;
  /** words are turned: every frame is `translate rotate scale` (lens-plan.ts turnTransform) */
  readonly rotates: boolean;
  /** the next line, drawn as one small row, can grow up into focus as is (one row at rest, like it) */
  readonly glides: boolean;
  /** words sit in a block of rows: a word's picture travels over the block, not into the row above its word */
  readonly blocks: boolean;
  /** fits line number `line`, measured at `size` px, to the stage; `baseline` is the baseline's depth in a 1 em box, as a share of the em */
  fit(shape: Shape, size: number, stage: Stage, moving: boolean, line: number, baseline: number): SlotFit;
  pose(shape: Shape, fit: SlotFit, width: number, dpr: number, lens: number, a: number, out?: LensPose): LensPose;
  /** the smallest and faintest a word is drawn, for its legibility shadow (lens.ts drawnShadow) */
  faintest(fit: SlotFit, width: number, moving: boolean): { scale: number; opacity: number };
  /** how far the line reaches above and below its center at its fitted font size `size`, px */
  extent(fit: SlotFit, size: number): { above: number; below: number };
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

// ───────────────────────────────────────────── Lens ─────────────────────────────────────────────

export const LENS_LAYOUT: SlotLayout = {
  kind: "lens",
  rotates: false,
  glides: true,
  blocks: false,
  fit: (shape, size, stage, moving) => fitRow(shape, size, stage.width, moving),
  pose: (shape, fit, width, dpr, lens, a, out) => poseOf(shape, fit, width, dpr, lens, a, out),
  faintest: (fit, width, moving) => ({ scale: smallestScale(fit, width, moving), opacity: moving ? OPACITY_MIN : 1 }),
  extent: (_fit, size) => ({ above: size / 2, below: size / 2 }),
};

// ──────────────────────────────────────────── Poster ────────────────────────────────────────────

/** A row is set up to this much larger than the look's size to match the widest. */
export const POSTER_MAX_ROW = 2.1;
/** The whole block may be set up to this much larger than the look's size, when it has room. */
export const POSTER_ZOOM = 1.2;
/** Rows are this many of their own font sizes tall: set tight, poster style. */
const POSTER_LEAD = 1.0;
/** The block takes at most this share of the stage's width... */
const POSTER_WIDTH = 0.86;
/** ...and of its height. */
const POSTER_HEIGHT = 0.6;
/** How each line is composed, in turn: where its rows line up, and its tilt. */
const POSTER_COMPOSITIONS: readonly { align: -1 | 0 | 1; tilt: number }[] = [
  { align: 0, tilt: 0 },
  { align: -1, tilt: -3 },
  { align: 0, tilt: 2.5 },
  { align: 1, tilt: 0 },
  { align: 0, tilt: -2 },
  { align: -1, tilt: 0 },
  { align: 1, tilt: 3 },
];
/** Words not sung yet wait at this opacity and this size... */
const POSTER_WAIT_OPACITY = 0.42;
const POSTER_WAIT_SCALE = 0.9;

/** How many rows a line of `n` words is set in. */
export function posterRows(n: number): number {
  return n <= 2 ? 1 : n <= 4 ? 2 : n <= 7 ? 3 : n <= 11 ? 4 : 5;
}

/** Widths of visual positions [from, to] set as one row at scale 1. */
function spanWidth(shape: Shape, from: number, to: number): number {
  let w = 0;
  for (let v = from; v <= to; v++) {
    w += shape.widths[shape.order[v] ?? v] ?? 0;
    if (v < to) w += shape.gaps[v] ?? 0;
  }
  return w;
}

/** Splits the line's visual order into `rows` rows of even width (least squares). */
export function balancedRows(shape: Shape, rows: number): { from: number; to: number }[] {
  const n = shape.order.length;
  const r = Math.max(1, Math.min(rows, n));
  if (n === 0) return [];
  const total = spanWidth(shape, 0, n - 1);
  const mean = total / r;
  // best[k][i]: least cost of setting the first i positions in k rows
  const best = Array.from({ length: r + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const cut = Array.from({ length: r + 1 }, () => new Array<number>(n + 1).fill(0));
  (best[0] as number[])[0] = 0;
  for (let k = 1; k <= r; k++) {
    for (let i = k; i <= n; i++) {
      for (let j = k - 1; j < i; j++) {
        const prev = (best[k - 1] as number[])[j] ?? Infinity;
        if (!Number.isFinite(prev)) continue;
        const cost = prev + (spanWidth(shape, j, i - 1) - mean) ** 2;
        if (cost < ((best[k] as number[])[i] ?? Infinity)) {
          (best[k] as number[])[i] = cost;
          (cut[k] as number[])[i] = j;
        }
      }
    }
  }
  const out: { from: number; to: number }[] = [];
  let i = n;
  for (let k = r; k >= 1; k--) {
    const j = (cut[k] as number[])[i] ?? 0;
    out.unshift({ from: j, to: i - 1 });
    i = j;
  }
  return out;
}

export const POSTER_LAYOUT: SlotLayout = {
  kind: "poster",
  rotates: true,
  glides: false,
  blocks: true,
  fit(shape, size, stage, moving, line, baseline) {
    const spans = balancedRows(shape, posterRows(shape.order.length));
    const widest = Math.max(1, ...spans.map((s) => spanWidth(shape, s.from, s.to)));
    const rows = spans.map((s): PosterRow => {
      const width = spanWidth(shape, s.from, s.to);
      return { ...s, width, scale: width > 0 ? Math.min(POSTER_MAX_ROW, Math.max(1, widest / width)) : 1 };
    });
    const blockWidth = Math.max(1, ...rows.map((r) => r.width * r.scale));
    const blockHeight = rows.reduce((h, r) => h + r.scale * size * POSTER_LEAD, 0);
    const composition = POSTER_COMPOSITIONS[line % POSTER_COMPOSITIONS.length] ?? { align: 0, tilt: 0 };
    const tilt = moving ? composition.tilt : 0;
    // a tilted block needs a little more room across and down
    const turned = Math.abs(Math.sin((tilt * Math.PI) / 180));
    const across = blockWidth + turned * blockHeight;
    const down = blockHeight + turned * blockWidth;
    const fit = Math.min(POSTER_ZOOM, (POSTER_WIDTH * stage.width) / across, stage.height > 0 ? (POSTER_HEIGHT * stage.height) / down : POSTER_ZOOM);
    return {
      low: POSTER_WAIT_SCALE,
      rest: blockWidth,
      widest: blockWidth,
      fit,
      block: { rows, align: composition.align, tilt, width: blockWidth, height: blockHeight, baseline, size },
    };
  },
  pose(shape, fit, width, _dpr, lens, a, out) {
    const n = shape.widths.length;
    const pose = out ?? blankPose(n);
    const block = fit.block;
    if (!block) return poseOf(shape, fit, width, 1, 0, 0, pose);
    const f = fit.fit;
    const { size, baseline } = block;
    const left = (width - block.width * f) / 2;
    // every word's baseline is drawn relative to the line's own: a 1 em row of the fitted size centered on the line's center
    const own = -(size * f) / 2 + baseline * size * f;
    let top = -(block.height * f) / 2;
    const theta = (block.tilt * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const cx = width / 2;
    const cy = -own;
    for (const row of block.rows) {
      const k = row.scale * f;
      const h = row.scale * size * POSTER_LEAD * f;
      const emTop = top + (h - row.scale * size * f) / 2;
      const dy = emTop + baseline * row.scale * size * f - own;
      let x = left + ((block.align + 1) / 2) * (block.width * f - row.width * k);
      for (let v = row.from; v <= row.to; v++) {
        const j = shape.order[v] ?? v;
        const w = (shape.widths[j] ?? 0) * k;
        // not sung yet: waiting dim and a little small (around its middle); sung: full
        const sung = clamp01(a - j);
        const m = 1 - lens * (1 - POSTER_WAIT_SCALE) * (1 - sung);
        const px = x + ((1 - m) * w) / 2;
        // the whole block turns about its middle
        pose.x[j] = cx + (px - cx) * cos - (dy - cy) * sin;
        pose.y[j] = cy + (px - cx) * sin + (dy - cy) * cos;
        pose.rotate[j] = block.tilt;
        pose.scale[j] = k * m;
        pose.opacity[j] = 1 - lens * (1 - POSTER_WAIT_OPACITY) * (1 - sung);
        x += w + (v < row.to ? (shape.gaps[v] ?? 0) * k : 0);
      }
      top += h;
    }
    return pose;
  },
  faintest(fit, _width, moving) {
    const smallest = Math.min(...(fit.block?.rows.map((r) => r.scale) ?? [1])) * fit.fit;
    return { scale: smallest * (moving ? POSTER_WAIT_SCALE : 1), opacity: moving ? POSTER_WAIT_OPACITY : 1 };
  },
  extent(fit, size) {
    const block = fit.block;
    if (!block) return { above: size / 2, below: size / 2 };
    const turned = Math.abs(Math.sin((block.tilt * Math.PI) / 180)) * block.width * fit.fit;
    const half = (block.height * fit.fit + turned) / 2;
    return { above: half, below: half };
  },
};

// ─────────────────────────────────────────── Spotlight ───────────────────────────────────────────

/** The word being sung is drawn this much larger than the line's size... */
export const SPOT_BIG = 2.3;
/** ...its neighbors fall off toward this (raised at small sizes so they stay readable)... */
const SPOT_LOW = 0.45;
/** ...over about this many words (the lens's SPREAD, tighter)... */
const SPOT_SPREAD = 0.42;
/** ...and fade toward this over a little more. */
export const SPOT_FAINT = 0.16;
const SPOT_FADE = 1.3;
/** The largest word fills at most this share of the stage's width. */
const SPOT_FIT = 0.8;

export const SPOTLIGHT_LAYOUT: SlotLayout = {
  kind: "spotlight",
  rotates: false,
  glides: false,
  blocks: false,
  fit(shape, size, stage, moving) {
    const rest = fitRow(shape, size, stage.width, false);
    if (!moving) return { ...rest, restFit: rest.fit, big: 1 };
    const longest = Math.max(1, ...shape.widths);
    const fit = Math.min(1, stage.width > 0 ? (SPOT_FIT * stage.width) / (SPOT_BIG * longest) : 1);
    const low = Math.max(SPOT_LOW, Math.min(0.85, MIN_TEXT_PX / (size * fit)));
    return { low, rest: rest.rest, widest: rest.widest, fit, restFit: rest.fit, big: SPOT_BIG };
  },
  pose(shape, fit, width, dpr, lens, a, out) {
    const n = shape.widths.length;
    const pose = out ?? blankPose(n);
    // at rest: one plain row, fitted and centered
    poseOf(shape, { low: 1, rest: fit.rest, widest: fit.rest, fit: fit.restFit ?? fit.fit }, width, dpr, 0, 0, pose);
    if (lens <= 0) return pose;
    const f = fit.fit;
    const scales = new Array<number>(n);
    const fades = new Array<number>(n);
    for (let j = 0; j < n; j++) {
      const d = j + 0.5 - a;
      scales[j] = f * (fit.low + (SPOT_BIG - fit.low) * Math.exp(-(d * d) / SPOT_SPREAD));
      fades[j] = SPOT_FAINT + (1 - SPOT_FAINT) * Math.exp(-(d * d) / SPOT_FADE);
    }
    // laid out left to right, then slid so the singing point is in the middle of the stage
    const starts = new Array<number>(n).fill(0);
    let x = 0;
    for (let v = 0; v < shape.order.length; v++) {
      const j = shape.order[v] ?? v;
      starts[j] = x;
      const right = shape.order[v + 1];
      const s = scales[j] ?? 1;
      x += s * (shape.widths[j] ?? 0) + ((shape.gaps[v] ?? 0) * (s + (right === undefined ? s : (scales[right] ?? s)))) / 2;
    }
    const i = Math.max(0, Math.min(n - 1, Math.floor(a)));
    const into = Math.max(0, Math.min(1, a - i));
    const point = (starts[i] ?? 0) + into * (scales[i] ?? 1) * (shape.widths[i] ?? 0);
    const shift = width / 2 - point;
    for (let j = 0; j < n; j++) {
      pose.x[j] = (pose.x[j] ?? 0) + lens * ((starts[j] ?? 0) + shift - (pose.x[j] ?? 0));
      pose.scale[j] = (pose.scale[j] ?? 1) + lens * ((scales[j] ?? 1) - (pose.scale[j] ?? 1));
      pose.opacity[j] = 1 + lens * ((fades[j] ?? 1) - 1);
    }
    return pose;
  },
  faintest(fit, width, moving) {
    if (!moving) return { scale: fit.restFit ?? smallestScale(fit, width, false), opacity: 1 };
    return { scale: fit.fit * fit.low, opacity: SPOT_FAINT };
  },
  extent(fit, size) {
    const big = fit.big ?? 1;
    return { above: 0.62 * big * size, below: 0.42 * big * size };
  },
};

// ───────────────────────────────────────────── shared ─────────────────────────────────────────────

/** The fitted left edges of a row of words at the given scales (by logical index), centered on the stage. */
function rowStarts(shape: Shape, scales: readonly number[], width: number): number[] {
  const n = shape.widths.length;
  const starts = new Array<number>(n).fill(0);
  let x = 0;
  for (let v = 0; v < shape.order.length; v++) {
    const j = shape.order[v] ?? v;
    starts[j] = x;
    const right = shape.order[v + 1];
    const s = scales[j] ?? 1;
    x += s * (shape.widths[j] ?? 0) + ((shape.gaps[v] ?? 0) * (s + (right === undefined ? s : (scales[right] ?? s)))) / 2;
  }
  const left = (width - x) / 2;
  for (let j = 0; j < n; j++) starts[j] = (starts[j] ?? 0) + left;
  return starts;
}

/** One plain row at rest, fitted and centered (what reduced motion and plain lyrics draw). */
function restPose(shape: Shape, fit: SlotFit, width: number, dpr: number, out: LensPose): LensPose {
  return poseOf(shape, { low: 1, rest: fit.rest, widest: fit.rest, fit: fit.restFit ?? fit.fit }, width, dpr, 0, 0, out);
}

/** A row that grows a word to `big` under motion: fitted so the row stays inside the stage with it. */
function rowFit(shape: Shape, size: number, stage: Stage, moving: boolean, big: number): SlotFit {
  const rest = fitRow(shape, size, stage.width, false);
  if (!moving) return { ...rest, restFit: rest.fit, big: 1, em: size };
  const longest = Math.max(1, ...shape.widths);
  const room = stage.width > 0 ? ROW_FIT * stage.width : Infinity;
  const fit = Math.min(1, room / (rest.rest + (big - 1) * longest), room / Math.max(1, big * longest));
  return { low: 1, rest: rest.rest, widest: rest.rest + (big - 1) * longest, fit, restFit: rest.fit, big, em: size };
}

/** A stable number in [0, 1) for a line, a word and a purpose: the same collage every time a song plays. */
function jitter(line: number, word: number, salt: number): number {
  let h = Math.imul(line + 1, 0x9e3779b1) ^ Math.imul(word + 7, 0x85ebca6b) ^ Math.imul(salt + 13, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// ───────────────────────────────────────────── Wave ─────────────────────────────────────────────

/** The crest lifts the sung word this many of the line's sizes... */
export const WAVE_AMP = 0.36;
/** ...the wave runs half a wavelength over this many words, so the words beside it sit in its troughs... */
const WAVE_HALF = 1.6;
/** ...and dies out over about this many words to either side (a Gaussian's 2σ²). */
const WAVE_SPAN = 7;
/** The word on the crest is drawn this much larger. */
export const WAVE_BIG = 1.18;
/** Words tilt along the slope, up to this many degrees. */
const WAVE_TILT_MAX = 12;
/** Words far off the crest fade to this. */
const WAVE_FAINT = 0.72;

/** The wave's lift at distance d (in words) from the singing position, in the line's sizes: up is negative. */
function waveAt(d: number): number {
  return -WAVE_AMP * Math.cos((Math.PI * d) / WAVE_HALF) * Math.exp(-(d * d) / WAVE_SPAN);
}

export const WAVE_LAYOUT: SlotLayout = {
  kind: "wave",
  rotates: true,
  glides: false,
  blocks: false,
  fit: (shape, size, stage, moving) => rowFit(shape, size, stage, moving, WAVE_BIG),
  pose(shape, fit, width, dpr, lens, a, out) {
    const n = shape.widths.length;
    const pose = restPose(shape, fit, width, dpr, out ?? blankPose(n));
    if (lens <= 0) return pose;
    const f = fit.fit;
    const em = (fit.em ?? 0) * f;
    const scales = new Array<number>(n);
    for (let j = 0; j < n; j++) {
      const d = j + 0.5 - a;
      scales[j] = f * (1 + (WAVE_BIG - 1) * Math.exp(-(d * d) / 0.7));
    }
    const starts = rowStarts(shape, scales, width);
    for (let j = 0; j < n; j++) {
      // the word's left end sits on the wave, and it tilts so its right end does too
      const d = j + 0.5 - a;
      const s = scales[j] ?? f;
      const w = (shape.widths[j] ?? 0) * s;
      const left = waveAt(d - 0.5) * em;
      const right = waveAt(d + 0.5) * em;
      const tilt = Math.max(-WAVE_TILT_MAX, Math.min(WAVE_TILT_MAX, (Math.atan2(right - left, Math.max(1, w)) * 180) / Math.PI));
      pose.x[j] = (pose.x[j] ?? 0) + lens * ((starts[j] ?? 0) - (pose.x[j] ?? 0));
      pose.scale[j] = (pose.scale[j] ?? 1) + lens * (s - (pose.scale[j] ?? 1));
      pose.y[j] = lens * left;
      pose.rotate[j] = lens * tilt;
      pose.opacity[j] = 1 - lens * (1 - WAVE_FAINT) * (1 - Math.exp(-(d * d) / WAVE_SPAN));
    }
    return pose;
  },
  faintest(fit, width, moving) {
    if (!moving) return { scale: fit.restFit ?? smallestScale(fit, width, false), opacity: 1 };
    return { scale: fit.fit, opacity: WAVE_FAINT };
  },
  extent(fit, size) {
    const big = fit.big ?? 1;
    return { above: 0.62 * big * size + WAVE_AMP * size, below: 0.42 * size + WAVE_AMP * size };
  },
};

// ──────────────────────────────────────────── Reveal ────────────────────────────────────────────

/** A word not reached yet waits this faint... */
export const REVEAL_GHOST = 0.22;
/** ...this much smaller (around its middle)... */
const REVEAL_WAIT_SCALE = 0.94;
/** ...and this many of its sizes below its place. */
const REVEAL_WAIT_DROP = 0.22;
/** A word is in within this share of its own time. */
const REVEAL_IN = 0.3;

export const REVEAL_LAYOUT: SlotLayout = {
  kind: "reveal",
  rotates: false,
  glides: false,
  blocks: false,
  fit: (shape, size, stage, moving) => rowFit(shape, size, stage, moving, 1),
  pose(shape, fit, width, dpr, lens, a, out) {
    const n = shape.widths.length;
    const pose = restPose(shape, fit, width, dpr, out ?? blankPose(n));
    if (lens <= 0) return pose;
    const f = fit.fit;
    const starts = rowStarts(shape, new Array<number>(n).fill(f), width);
    for (let j = 0; j < n; j++) {
      const u = a - j;
      const shown = clamp01(u / REVEAL_IN);
      const ease = shown * shown * (3 - 2 * shown);
      const m = REVEAL_WAIT_SCALE + (1 - REVEAL_WAIT_SCALE) * ease;
      const w = (shape.widths[j] ?? 0) * f;
      const x = (starts[j] ?? 0) + ((1 - m) * w) / 2;
      pose.x[j] = (pose.x[j] ?? 0) + lens * (x - (pose.x[j] ?? 0));
      pose.scale[j] = (pose.scale[j] ?? 1) + lens * (f * m - (pose.scale[j] ?? 1));
      pose.y[j] = lens * REVEAL_WAIT_DROP * (1 - ease) * (fit.em ?? 0) * f;
      pose.opacity[j] = 1 - lens * (1 - REVEAL_GHOST) * (1 - ease);
    }
    return pose;
  },
  // the ghosts are only there to read ahead: their legibility shadow is drawn for a word half as faint
  faintest(fit, width, moving) {
    if (!moving) return { scale: fit.restFit ?? smallestScale(fit, width, false), opacity: 1 };
    return { scale: fit.fit * REVEAL_WAIT_SCALE, opacity: 0.5 };
  },
  extent(fit, size) {
    const big = fit.big ?? 1;
    return { above: 0.62 * big * size, below: 0.42 * size + REVEAL_WAIT_DROP * size };
  },
};

// ──────────────────────────────────────────── Collage ───────────────────────────────────────────

/** A word is cut out this much smaller to this much larger than the line's size... */
const COLLAGE_SMALL = 0.8;
const COLLAGE_LARGE = 1.32;
/** ...turned up to this many degrees either way... */
const COLLAGE_TILT = 7;
/** ...and set up to this many of its sizes off its row. */
const COLLAGE_DROP = 0.1;
/** The block takes at most this share of the stage's width and height, and is set at most this much larger than the look's size. */
const COLLAGE_WIDTH = 0.86;
const COLLAGE_HEIGHT = 0.56;
const COLLAGE_ZOOM = 1.15;
/** Rows are this many of their tallest word's sizes apart. */
const COLLAGE_LEAD = 1.14;
/** Words not sung yet wait this dim and this much smaller; a word being sung pops this much larger. */
const COLLAGE_WAIT_OPACITY = 0.45;
const COLLAGE_WAIT_SCALE = 0.9;
const COLLAGE_POP = 1.1;

/** How many rows a collage of `n` words is set in. */
export function collageRows(n: number): number {
  return n <= 3 ? 1 : n <= 7 ? 2 : 3;
}

export const COLLAGE_LAYOUT: SlotLayout = {
  kind: "collage",
  rotates: true,
  glides: false,
  blocks: true,
  fit(shape, size, stage, moving, line, baseline) {
    const n = shape.widths.length;
    const mean = n > 0 ? shape.widths.reduce((sum, w) => sum + w, 0) / n : 1;
    const scale = new Array<number>(n);
    const tilt = new Array<number>(n);
    const drop = new Array<number>(n);
    for (let j = 0; j < n; j++) {
      // longer words are cut a little bigger, and each its own way
      const long = clamp01(((shape.widths[j] ?? 0) / Math.max(1, mean) - 0.6) / 1.2);
      const k = 0.92 + 0.22 * long + 0.3 * (jitter(line, j, 1) - 0.5);
      scale[j] = moving ? Math.max(COLLAGE_SMALL, Math.min(COLLAGE_LARGE, k)) : 1;
      // tilts alternate in direction, so neighbors lean apart
      const side = (j + line) % 2 === 0 ? 1 : -1;
      tilt[j] = moving ? side * COLLAGE_TILT * (0.35 + 0.65 * jitter(line, j, 2)) : 0;
      drop[j] = moving ? COLLAGE_DROP * (2 * jitter(line, j, 3) - 1) : 0;
    }
    const sized: Shape = { ...shape, widths: shape.widths.map((w, j) => w * (scale[j] ?? 1)) };
    const spans = balancedRows(sized, moving ? collageRows(n) : 1);
    const rows = spans.map((r) => {
      let width = 0;
      let tallest = 0;
      for (let v = r.from; v <= r.to; v++) {
        const j = shape.order[v] ?? v;
        width += (shape.widths[j] ?? 0) * (scale[j] ?? 1);
        if (v < r.to) width += (shape.gaps[v] ?? 0) * (scale[j] ?? 1);
        tallest = Math.max(tallest, scale[j] ?? 1);
      }
      return { ...r, width, height: tallest * size * COLLAGE_LEAD };
    });
    const blockWidth = Math.max(1, ...rows.map((r) => r.width));
    const blockHeight = rows.reduce((h, r) => h + r.height, 0);
    const across = blockWidth + Math.sin((COLLAGE_TILT * Math.PI) / 180) * size;
    const fit = Math.min(moving ? COLLAGE_ZOOM : 1, stage.width > 0 ? (COLLAGE_WIDTH * stage.width) / across : 1, stage.height > 0 ? (COLLAGE_HEIGHT * stage.height) / blockHeight : COLLAGE_ZOOM);
    return {
      low: COLLAGE_WAIT_SCALE * COLLAGE_SMALL,
      rest: blockWidth,
      widest: blockWidth,
      fit,
      collage: { rows, scale, tilt, drop, width: blockWidth, height: blockHeight, baseline, size },
    };
  },
  pose(shape, fit, width, _dpr, lens, a, out) {
    const n = shape.widths.length;
    const pose = out ?? blankPose(n);
    const c = fit.collage;
    if (!c) return poseOf(shape, fit, width, 1, 0, 0, pose);
    const f = fit.fit;
    const { size, baseline } = c;
    // every word's baseline is drawn relative to the line's own: a 1 em row of the fitted size centered on the line's center
    const own = -(size * f) / 2 + baseline * size * f;
    let top = -(c.height * f) / 2;
    for (const row of c.rows) {
      const h = row.height * f;
      let x = (width - row.width * f) / 2;
      for (let v = row.from; v <= row.to; v++) {
        const j = shape.order[v] ?? v;
        const k = (c.scale[j] ?? 1) * f;
        const w = (shape.widths[j] ?? 0) * k;
        const sung = clamp01(a - j);
        const singing = a > j && a < j + 1 ? Math.sin(Math.PI * (a - j)) : 0;
        const m = 1 - lens * (1 - COLLAGE_WAIT_SCALE) * (1 - sung) + lens * (COLLAGE_POP - 1) * singing;
        // its own row's baseline, its own drop, scaled around its middle
        const emTop = top + (h - k * size) / 2;
        pose.x[j] = x + ((1 - m) * w) / 2;
        pose.y[j] = emTop + baseline * k * size - own + (c.drop[j] ?? 0) * k * size;
        pose.rotate[j] = (c.tilt[j] ?? 0) * (0.4 + 0.6 * lens);
        pose.scale[j] = k * m;
        pose.opacity[j] = 1 - lens * (1 - COLLAGE_WAIT_OPACITY) * (1 - sung);
        x += w + (v < row.to ? (shape.gaps[v] ?? 0) * k : 0);
      }
      top += h;
    }
    return pose;
  },
  faintest(fit, _width, moving) {
    const smallest = Math.min(...(fit.collage?.scale ?? [1])) * fit.fit;
    return { scale: smallest * (moving ? COLLAGE_WAIT_SCALE : 1), opacity: moving ? COLLAGE_WAIT_OPACITY : 1 };
  },
  extent(fit, size) {
    const c = fit.collage;
    if (!c) return { above: size / 2, below: size / 2 };
    const half = (c.height * fit.fit) / 2 + Math.sin((COLLAGE_TILT * Math.PI) / 180) * size * 0.5;
    return { above: half, below: half };
  },
};

export const SLOT_LAYOUTS: Record<SlotKind, SlotLayout> = {
  lens: LENS_LAYOUT,
  poster: POSTER_LAYOUT,
  spotlight: SPOTLIGHT_LAYOUT,
  wave: WAVE_LAYOUT,
  reveal: REVEAL_LAYOUT,
  collage: COLLAGE_LAYOUT,
};
