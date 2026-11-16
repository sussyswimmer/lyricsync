/**
 * Lens's fisheye, planned ahead (pure, no DOM). The focus line's words sit in one row, magnified like a
 * loupe around where the song is being sung: the word under the singing position grows to SCALE_MAX,
 * words further off shrink toward `low` and fade toward OPACITY_MIN, and the row is laid out again
 * around them so it stays centered and inside ROW_FIT of the stage.
 *
 * When a line comes into focus its whole window [origin, end] is solved at once and sampled every
 * PLAN_MS into one track per word (`translate(x, y) scale(s)` plus opacity), which the mode hands to
 * the line's KaraokeLine as `along` tracks: the compositor then plays the lens with the karaoke, on
 * song time, and the page sleeps. The singing position follows the voice through a critically damped
 * spring (LENS_SPRING), so the lens glides from word to word a little behind it instead of stepping;
 * a line that arrived waiting eases the lens in over RAMP_MS from its first word.
 */
import type { Word } from "../../core/lrc";
import { progress } from "../../core/timing";
import { MIN_TEXT_PX } from "../look";
import { clamp01 } from "../motion/curve";
import { PLAN_MS, type Track } from "../motion/karaoke";
import { framesOf, HOLD, holds, keyPoints, liftScale, num, sampleTimes, STEP_MS, thin } from "../motion/keyframes";
import { chase, type SpringSpec } from "../motion/spring";

/**
 * The fisheye. For word j at distance d = j + 0.5 - a from the singing position a:
 * k = exp(-d² / SPREAD), scale = low + (SCALE_MAX - low)·k, opacity = OPACITY_MIN + (1 - OPACITY_MIN)·k.
 */
export const SPREAD = 1.4;
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 1.35;
/**
 * Far words fade to this. The fade is the slot's opacity, so hues stay true; the word's dark
 * legibility shadow is drawn for its faintest (lens.ts drawnShadow), so it never fades with it.
 */
export const OPACITY_MIN = 0.6;
/** The focus row never gets wider than this share of the stage; long lines get a smaller base size. */
export const ROW_FIT = 0.92;
/** A line that arrived waiting eases into the fisheye over this long from its first word, ms. */
export const RAMP_MS = 320;
/** The singing position the lens follows: critically damped, about 70 ms behind the voice. */
export const LENS_SPRING: SpringSpec = { hz: 3.5, damping: 1 };
/** Lens positions sampled per word when finding the widest a row can get. */
const SAMPLES_PER_WORD = 8;
/** Keyframes are kept where straight lines between them would miss by more than this: px, scale, opacity. */
const THIN = { x: 0.25, scale: 0.002, opacity: 0.01 };
/** A stretch that changes less than this per STEP_MS steps on the song-time beat (keyframes.ts keyPoints). */
const STEP_QUANTUM = { x: 1.2, scale: 0.004, opacity: 0.03 };

/** A row of words in visual order: what the layout and the fit need. */
export interface Shape {
  /** per word, by logical index: advance width at the base size, px */
  widths: readonly number[];
  /** logical indices, left to right */
  order: readonly number[];
  /** space after the word at each visual position at scale 1 (0 after the last, and between CJK characters) */
  gaps: readonly number[];
}

/**
 * A row's fit to the stage width. At rest every word is at scale 1; under the lens far words shrink
 * to `low` and the words around the singing position grow to SCALE_MAX, so a long row is much
 * narrower lensed than at rest. Each state gets its own fit, and the row moves between them as the
 * lens eases in (see zoomAt): fitting the lens to the at-rest width left long lines tiny.
 */
export interface RowFit {
  /** smallest fisheye scale: SCALE_MIN, raised at small sizes so far words stay readable */
  low: number;
  /** width at rest, every word at scale 1, px at the base size */
  rest: number;
  /** the widest the lensed row gets anywhere the singing position can be, px at the base size (`rest` without a lens) */
  widest: number;
  /** base size factor under the full lens, at most 1 (the at-rest fit without a lens) */
  fit: number;
}

/**
 * Each word's place as drawn, by logical index: left edge (px), drawn scale (fisheye × zoom), opacity,
 * and for layouts that move words off the line (slot-layouts.ts) a drop below its baseline (px) and a
 * turn (degrees). Lens leaves those at 0.
 */
export interface LensPose {
  x: number[];
  scale: number[];
  opacity: number[];
  y: number[];
  rotate: number[];
  /**
   * Layouts that set a word on a tag (slot-layouts.ts SlotLayout.tags): how much of the tag behind each
   * word shows, 0 (none) to 1 (all of it, wiped in from its left edge). Absent elsewhere.
   */
  tag?: number[];
}

export interface LensInput {
  words: readonly Pick<Word, "start" | "end">[];
  shape: Shape;
  fit: RowFit;
  /** stage width, px */
  width: number;
  /** every word's translateY, px (its baseline on the line's) */
  y: number;
  /** device pixel ratio: a row at rest sits on whole device pixels */
  dpr: number;
  /** the line's window, song ms: its animations all share it */
  origin: number;
  end: number;
  /** song time the lens starts easing in (a line that arrived waiting: its first word); null: in full at once */
  rampFrom: number | null;
  /** false (reduced motion, unsynced lyrics): no lens, every word at rest */
  motion: boolean;
  /** slow stretches step on the song-time beat (compositorSteps()) */
  steps?: boolean;
  /** the lite tier: every pose holds to the next song-time beat (HOLD, STEP_MS), so software compositing redraws at most 20 times a second */
  hold?: boolean;
  /** the layout's pose (slot-layouts.ts) with motion eased in by `lens` around singing position `a`; Lens's fisheye (poseOf) by default */
  poseAt?: (lens: number, a: number, out: LensPose) => LensPose;
  /** the layout turns words: every frame is `translate rotate scale` */
  rotates?: boolean;
  /** the singing position the layout follows, in words, at song time `t` (singingAt by default) and the spring it follows it on (LENS_SPRING) */
  target?: (words: readonly Pick<Word, "start" | "end">[], t: number) => number;
  spring?: SpringSpec;
  /** the layout sets words on tags: plan each word's tag too (LensPose.tag, LensPlan.tagTracks) */
  tags?: boolean;
}

export interface LensPlan {
  origin: number;
  end: number;
  rampFrom: number | null;
  /** one per word, by logical index: `translate(x, y) scale(s)` and opacity over [origin, end] */
  tracks: Track[];
  /** with `tags`: one per word, its tag's wipe (`scaleX`) and opacity over the same window; null without */
  tagTracks: Track[] | null;
  /** where every word rests once the window is over (the tracks' last frame) */
  final: LensPose;
  /** the pose at song time `t` (held at the window's ends), as the tracks draw it */
  at(t: number): LensPose;
}

const easeOut = (x: number): number => 1 - (1 - x) ** 3;

/** How strongly the lens pulls word j with the singing position at a: 1 at the center, falling off to 0. */
export function pull(j: number, a: number): number {
  const d = j + 0.5 - a;
  return Math.exp(-(d * d) / SPREAD);
}

/** The smallest fisheye scale for a line at `size` px. */
export function lowScale(size: number): number {
  return Math.min(0.85, Math.max(SCALE_MIN, MIN_TEXT_PX / size));
}

/** Width of a row of words at the given scales (by logical index). A space takes the mean scale of the two words beside it. */
export function rowWidth(row: Shape, scales: readonly number[]): number {
  const { widths, order, gaps } = row;
  let total = 0;
  for (let v = 0; v < order.length; v++) {
    const j = order[v] ?? 0;
    const s = scales[j] ?? 1;
    const right = order[v + 1];
    const t = right === undefined ? s : (scales[right] ?? s);
    total += s * (widths[j] ?? 0) + ((gaps[v] ?? 0) * (s + t)) / 2;
  }
  return total;
}

/** The widest a fully lensed row gets, anywhere the singing position can be. */
function lensedWidest(row: Shape, low: number): number {
  const n = row.widths.length;
  const scales = new Array<number>(n).fill(1);
  const steps = n * SAMPLES_PER_WORD;
  let widest = 0;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * n;
    for (let j = 0; j < n; j++) scales[j] = low + (SCALE_MAX - low) * pull(j, a);
    widest = Math.max(widest, rowWidth(row, scales));
  }
  return widest;
}

/** Fits a row measured at `size` px into a stage `width` px wide, at rest and (when `lensed`) under the lens. */
export function fitRow(row: Shape, size: number, width: number, lensed: boolean): RowFit {
  const rest = rowWidth(row, new Array<number>(row.widths.length).fill(1));
  const fitTo = (w: number): number => (width > 0 && w > 0 ? Math.min(1, (ROW_FIT * width) / w) : 1);
  let low = lowScale(size);
  if (!lensed) return { low, rest, widest: rest, fit: fitTo(rest) };
  // The floor on far words depends on the fitted size, and the fit on the floor: settle it in two passes.
  let widest = lensedWidest(row, low);
  const settled = lowScale(size * fitTo(widest));
  if (settled > low) {
    low = settled;
    widest = lensedWidest(row, low);
  }
  return { low, rest, widest, fit: fitTo(widest) };
}

/**
 * The row's base size factor with the lens eased in by `lens` (0 at rest, 1 full): the lensed fit,
 * or less while the at-rest width still needs it. Each word's scale moves linearly with `lens`, and
 * so does the row's width, so it never passes ROW_FIT of the stage on the way.
 */
export function zoomAt(f: RowFit, lens: number, width: number): number {
  const widest = (1 - lens) * f.rest + lens * f.widest;
  return width > 0 && widest > 0 ? Math.min(f.fit, (ROW_FIT * width) / widest) : f.fit;
}

/** The smallest a word of the row is ever drawn (a far word under the full lens, or any word at rest), as a scale of the base size. */
export function smallestScale(f: RowFit, width: number, lensed: boolean): number {
  const rest = zoomAt(f, 0, width);
  return lensed ? Math.min(rest, f.low * Math.min(rest, zoomAt(f, 1, width))) : rest;
}

/** Index of the word being sung (or next to be) plus its progress: where the voice is along the line, in words. */
export function singingAt(words: readonly Pick<Word, "start" | "end">[], t: number): number {
  let i = 0;
  while (i < words.length && t >= (words[i]?.end ?? -Infinity)) i++;
  const word = words[i];
  return word ? i + progress(word, t) : words.length;
}

/** The lens ramp at song time t: 0 at rest, 1 in full. */
export function rampAt(rampFrom: number | null, t: number): number {
  return rampFrom === null ? 1 : easeOut(clamp01((t - rampFrom) / RAMP_MS));
}

/**
 * The row laid out with the lens eased in by `lens` around singing position `a`: each word's left
 * edge, drawn scale and opacity, in visual order across the stage, centered. A row at rest snaps to
 * the device pixel grid so its text is crisp.
 */
export function poseOf(shape: Shape, fit: RowFit, width: number, dpr: number, lens: number, a: number, out?: LensPose): LensPose {
  const n = shape.widths.length;
  const pose = out ?? blankPose(n);
  const scales = pose.scale;
  for (let j = 0; j < n; j++) {
    const k = lens > 0 ? pull(j, a) : 1;
    scales[j] = 1 + lens * (fit.low + (SCALE_MAX - fit.low) * k - 1);
    pose.opacity[j] = 1 - (1 - OPACITY_MIN) * lens * (1 - k);
  }
  const zoom = zoomAt(fit, lens, width);
  const still = lens === 0;
  const { order, widths, gaps } = shape;
  let x = (width - rowWidth(shape, scales) * zoom) / 2;
  for (let v = 0; v < order.length; v++) {
    const j = order[v] ?? v;
    const s = scales[j] ?? 1;
    pose.x[j] = still && dpr > 0 ? Math.round(x * dpr) / dpr : x;
    const right = order[v + 1];
    x += zoom * (s * (widths[j] ?? 0) + ((gaps[v] ?? 0) * (s + (right === undefined ? s : (scales[right] ?? s)))) / 2);
  }
  for (let j = 0; j < n; j++) {
    scales[j] = (scales[j] ?? 1) * zoom;
    pose.y[j] = 0;
    pose.rotate[j] = 0;
  }
  return pose;
}

/** A pose of `n` words at rest at the stage's left edge. */
export function blankPose(n: number): LensPose {
  return {
    x: new Array<number>(n).fill(0),
    scale: new Array<number>(n).fill(1),
    opacity: new Array<number>(n).fill(1),
    y: new Array<number>(n).fill(0),
    rotate: new Array<number>(n).fill(0),
  };
}

/** A turned word's transform: translate(x, y) rotate(deg) scale(s), around its left baseline point. */
export function turnTransform(x: number, y: number, deg: number, scale: number): string {
  return `translate(${num(x, 2)}px, ${num(y, 2)}px) rotate(${num(deg, 3)}deg) scale(${num(scale, 4)})`;
}

/**
 * A tag at `v` (LensPose.tag): wiped in from its left edge and solid well before it is all there, so a
 * fast word's tag reads as a slap of marker rather than a slow fade.
 */
export function tagKeyframe(v: number): Keyframe {
  const g = clamp01(v);
  return { transform: `scaleX(${num(Math.max(0.001, g), 3)})`, opacity: num(clamp01(g * 2.5), 3) };
}

/** A word's transform: its left baseline point at (x, y + its baseline), scaled around it (transform-origin: 0 baseline). */
export function lensTransform(x: number, y: number, scale: number): string {
  return liftScale(x, y, scale);
}

/** Plans the lens over a line's window: one track per word, the pose it rests at, and the pose at any time. */
export function planLens(input: LensInput): LensPlan {
  const { words, shape, fit, width, y, dpr, origin, rampFrom } = input;
  const motion = input.motion;
  const end = Math.max(origin + 1, input.end);
  const duration = end - origin;
  const n = words.length;
  const times = sampleTimes(duration, PLAN_MS);
  const position = input.target ?? singingAt;
  const target = (ms: number): number => position(words, origin + ms);
  // the singing position, smoothed: a spring released at rest where the voice is at the origin
  const along = motion ? chase(target, input.spring ?? LENS_SPRING, { x: target(0), v: 0 }, duration, PLAN_MS) : [];
  const xs = Array.from({ length: n }, () => new Array<number>(times.length));
  const ss = Array.from({ length: n }, () => new Array<number>(times.length));
  const os = Array.from({ length: n }, () => new Array<number>(times.length));
  const ys = Array.from({ length: n }, () => new Array<number>(times.length));
  const rs = Array.from({ length: n }, () => new Array<number>(times.length));
  const tagged = input.tags === true;
  const gs = tagged ? Array.from({ length: n }, () => new Array<number>(times.length)) : null;
  const pose = blankPose(n);
  const poseAt = input.poseAt ?? ((lens: number, a: number, out: LensPose): LensPose => poseOf(shape, fit, width, dpr, lens, a, out));
  for (let k = 0; k < times.length; k++) {
    const t = origin + (times[k] ?? 0);
    const lens = motion ? rampAt(rampFrom, t) : 0;
    poseAt(lens, along[k] ?? 0, pose);
    for (let j = 0; j < n; j++) {
      (xs[j] as number[])[k] = pose.x[j] ?? 0;
      (ss[j] as number[])[k] = pose.scale[j] ?? 1;
      (os[j] as number[])[k] = pose.opacity[j] ?? 1;
      (ys[j] as number[])[k] = pose.y[j] ?? 0;
      (rs[j] as number[])[k] = pose.rotate[j] ?? 0;
      if (gs) (gs[j] as number[])[k] = clamp01(pose.tag?.[j] ?? 0);
    }
  }
  const last = times.length - 1;
  /** A channel's value `ms` into the window, linear between samples (held at the ends). */
  const valueAt = (c: readonly number[], ms: number): number => {
    const at = Math.min(duration, Math.max(0, ms));
    const i = Math.max(0, Math.min(last - 1, Math.floor(at / PLAN_MS)));
    const t0 = times[i] ?? 0;
    const t1 = times[i + 1] ?? t0;
    const p = t1 > t0 ? Math.min(1, Math.max(0, (at - t0) / (t1 - t0))) : 1;
    const a = c[i] ?? 0;
    return a + ((c[i + 1] ?? a) - a) * p;
  };
  const tolerance = [THIN.x, THIN.scale, THIN.opacity, THIN.x, 0.05];
  const turns = input.rotates === true;
  // The lite tier: each pose holds from one song-time beat to the next (STEP_MS, the beat every stepped
  // track shares), so software compositing redraws the lens at most 20 times a second, on the same
  // instants as the rest of the scene's stepped motion.
  const beats: number[] = [0];
  if (input.hold === true) {
    for (let b = (Math.floor(origin / STEP_MS) + 1) * STEP_MS; b < end; b += STEP_MS) beats.push(b - origin);
    beats.push(duration);
  }
  const tracks = words.map((_, j): Track => {
    const channels = [xs[j] as number[], ss[j] as number[], os[j] as number[], ys[j] as number[], rs[j] as number[]];
    const frame = ([x, s, o, dy, r]: readonly number[]): Keyframe => ({
      transform: turns ? turnTransform(x ?? 0, y + (dy ?? 0), r ?? 0, s ?? 1) : lensTransform(x ?? 0, y + (dy ?? 0), s ?? 1),
      opacity: num(clamp01(o ?? 1), 3),
    });
    if (input.hold === true) {
      const onBeats = channels.map((c) => beats.map((ms) => valueAt(c, ms)));
      const keep = holds(onBeats, tolerance);
      const frames = keep.map((i) => ({ ...frame(onBeats.map((c) => c[i] ?? 0)), offset: Math.min(1, (beats[i] ?? 0) / duration), easing: HOLD }));
      return { t0: origin, duration, frames };
    }
    const keep = thin(times, channels, tolerance);
    const points = keyPoints(times, keep, channels, input.steps === true ? { t0: origin, quantum: [STEP_QUANTUM.x, STEP_QUANTUM.scale, STEP_QUANTUM.opacity, STEP_QUANTUM.x, 0.1] } : null);
    return { t0: origin, duration, frames: framesOf(points, duration, frame) };
  });
  const tagTracks = gs
    ? gs.map((c): Track => {
        const tagFrame = ([g]: readonly number[]): Keyframe => tagKeyframe(g ?? 0);
        if (input.hold === true) {
          const onBeats = [beats.map((ms) => valueAt(c, ms))];
          const keep = holds(onBeats, [THIN.opacity]);
          const frames = keep.map((i) => ({ ...tagFrame([onBeats[0]?.[i] ?? 0]), offset: Math.min(1, (beats[i] ?? 0) / duration), easing: HOLD }));
          return { t0: origin, duration, frames };
        }
        const keep = thin(times, [c], [THIN.opacity]);
        return { t0: origin, duration, frames: framesOf(keyPoints(times, keep, [c], null), duration, tagFrame) };
      })
    : null;
  const sampleAt = (k: number): LensPose => ({
    x: xs.map((c) => c[k] ?? 0),
    scale: ss.map((c) => c[k] ?? 1),
    opacity: os.map((c) => c[k] ?? 1),
    y: ys.map((c) => c[k] ?? 0),
    rotate: rs.map((c) => c[k] ?? 0),
    ...(gs ? { tag: gs.map((c) => c[k] ?? 0) } : {}),
  });
  const at = (t: number): LensPose => {
    const ms = t - origin;
    return {
      x: xs.map((c) => valueAt(c, ms)),
      scale: ss.map((c) => valueAt(c, ms)),
      opacity: os.map((c) => valueAt(c, ms)),
      y: ys.map((c) => valueAt(c, ms)),
      rotate: rs.map((c) => valueAt(c, ms)),
      ...(gs ? { tag: gs.map((c) => valueAt(c, ms)) } : {}),
    };
  };
  return { origin, end, rampFrom, tracks, tagTracks, final: sampleAt(last), at };
}
