/**
 * Where a one-line style puts the focus line's words (pure, no DOM). Lens, Poster and Spotlight share
 * one engine (lens.ts): every word sits in a slot of its own, moved on the compositor along a track
 * planned for the line's whole window (lens-plan.ts planLens). Only the layout differs:
 *
 * - Lens: one row, magnified like a loupe around where the song is sung (lens-plan.ts poseOf).
 * - Poster: the line set as a block of two to five rows, justified by size: a short row is set larger
 *   until it is as wide as the widest, like a gig poster. Each line is composed its own way: centered,
 *   pushed left or right, and some tilted a few degrees. Words not sung yet wait dim and a little small,
 *   and punch up to full as the voice reaches them.
 * - Spotlight: the line slides through the middle of the screen with the voice: the word being sung
 *   is large in the middle, its neighbors fall away smaller and fainter to either side.
 *
 * Every pose is a function of the motion's ease-in `lens` (0 at rest, 1 in full: reduced motion and
 * plain lyrics stay at rest) and of `a`, the singing position in words (lens-plan.ts singingAt,
 * smoothed). Sizes are px at the look's size; `fit` scales the whole line to the stage.
 */
import { MIN_TEXT_PX } from "../look";
import { blankPose, fitRow, OPACITY_MIN, poseOf, smallestScale, type LensPose, type RowFit, type Shape } from "./lens-plan";

export type SlotKind = "lens" | "poster" | "spotlight";

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

export interface SlotFit extends RowFit {
  /** Poster: its block */
  block?: PosterBlock;
  /** Spotlight: the at-rest fit (one plain row), and how much larger than the line's size the sung word gets */
  restFit?: number;
  big?: number;
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

export const SLOT_LAYOUTS: Record<SlotKind, SlotLayout> = { lens: LENS_LAYOUT, poster: POSTER_LAYOUT, spotlight: SPOTLIGHT_LAYOUT };
