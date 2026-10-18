/**
 * The karaoke motion of one word, planned ahead as keyframes (pure, no DOM):
 *
 * - wipe: the word fills from the upcoming color to the highlight, left to right (right to left in
 *   right-to-left text), syllable by syllable, linearly over each syllable's time, behind a soft edge
 *   FEATHER of the word's width. Drawn as a lit copy inside a window that slides over the word while
 *   its contents slide back the other way, so the text stays put and nothing repaints.
 * - pop: an upcoming word rests a little small and low (REST_SCALE, REST_LIFT); while sung it swells
 *   and rises past its rest, then settles to scale 1 and no lift. Springs carry it: the lift bouncy,
 *   the scale slow, so quick words barely move and held ones visibly rise, overshoot and settle.
 * - glow: the word's bloom rises in the first ~15 % of the word, holds, and fades by its end.
 * - letters: every letter rises in turn as the wipe crosses it (a ripple scaled by the song's energy);
 *   a held syllable (EMPHASIS_MS or longer, EMPHASIS_CHARS or fewer) lights letter by letter along a
 *   sine ease-out, each letter lifting about twice as far and glowing until the syllable ends.
 *
 * Times are song ms. Each track runs from its own `t0` for `duration` ms.
 */
import type { Line } from "../../core/lrc";
import { syllables } from "../../core/timing";
import { clamp01, sineOut, spline } from "./curve";
import { keyframesAt, liftScale, num, sampleTimes, SAMPLE_MS, thin } from "./keyframes";
import { chase, type SpringSpec } from "./spring";

/** One timed piece of a word: a syllable from enhanced LRC, or the whole word. */
export interface Part {
  text: string;
  start: number;
  end: number;
}

/** A word as the engine needs it. */
export interface WordTiming {
  start: number;
  end: number;
  /** syllables with their own timing (enhanced LRC tags inside the word); the whole word when absent */
  parts?: readonly Part[];
}

/** One letter (a grapheme, or the whole word for scripts that can't be split) of a measured word. */
export interface LetterBox {
  text: string;
  /** left edge from the word's left edge, px, in visual order (left to right on screen) */
  x: number;
  /** advance width, px */
  w: number;
  /** index of the part it belongs to */
  part: number;
}

export interface WordShape {
  /** advance width of the word without its trailing space, px */
  width: number;
  /** font size, px */
  size: number;
  letters: readonly LetterBox[];
  /** right-to-left text: the wipe runs from the right */
  rtl: boolean;
}

export interface MotionOptions {
  /** 0..1, how lively the song is (songEnergy): scales the letter ripple */
  energy: number;
  /** false under prefers-reduced-motion: color and glow crossfades only */
  motion: boolean;
}

/** A keyframe animation to run from song time `t0`. */
export interface Track {
  t0: number;
  duration: number;
  frames: Keyframe[];
}

export interface WordMotion {
  /** any part is held long enough to break into letters */
  emphasis: boolean;
  /** song time by which every track below has ended */
  until: number;
  /** transform of the whole word (pop) */
  pop: Track | null;
  /** translateX of the lit window, and of its contents (the opposite, so the text stays put) */
  window: Track | null;
  inner: Track | null;
  /** reduced motion: the lit copy fades in instead of wiping */
  litFade: Track | null;
  /** opacity of the word's bloom */
  glow: Track | null;
  /** transform per letter (base and lit copies alike), null where a letter doesn't move */
  letters: (Track | null)[];
  /** opacity of each letter's own bloom (emphasized letters only) */
  letterGlows: (Track | null)[];
  /** each letter's transform before its word is sung ("" = none) */
  letterRest: string[];
}

// ---------- tuning (re-derived by eye against Beautiful Lyrics' motion; see NOTES) ----------

/** Soft edge of the wipe, as a share of the word's width. */
export const FEATHER = 0.2;
/** The wipe ends this many font sizes past the word's advance, so overhanging glyphs light fully. */
export const OVERHANG = 0.06;
export const REST_SCALE = 0.95;
/** Lift at rest, in font sizes (positive is down). */
export const REST_LIFT = 0.012;
/** A syllable at least this long, of at most this many characters, breaks into letters. */
export const EMPHASIS_MS = 1000;
export const EMPHASIS_CHARS = 12;

const SCALE_CURVE = spline([
  [0, REST_SCALE],
  [0.7, 1.028],
  [1, 1],
]);
/** In font sizes; the spline swings to about -0.038 around 60 % before settling. */
const LIFT_CURVE = spline([
  [0, REST_LIFT],
  [0.9, -0.019],
  [1, 0],
]);
/** An emphasized letter swells further than a word, from (almost) its full size. */
const LETTER_SCALE_CURVE = spline([
  [0, 0.97],
  [0.7, 1.075],
  [1, 1],
]);
const GLOW_CURVE = spline([
  [0, 0],
  [0.15, 1],
  [0.6, 1],
  [1, 0],
]);

const LIFT_SPRING: SpringSpec = { hz: 1.35, damping: 0.4 };
const SCALE_SPRING: SpringSpec = { hz: 0.8, damping: 0.6 };
/** Faster than the lift so a short word still blooms visibly. */
const GLOW_SPRING: SpringSpec = { hz: 2.1, damping: 0.62 };
const LETTER_GLOW_SPRING: SpringSpec = { hz: 1.2, damping: 0.5 };
/** The per-letter ripple: quick, a little springy. */
const RIPPLE_SPRING: SpringSpec = { hz: 3.1, damping: 0.4 };

/** Ripple height in font sizes: RIPPLE_MIN for the calmest song, plus up to RIPPLE_GAIN for the liveliest. */
const RIPPLE_MIN = 0.03;
const RIPPLE_GAIN = 0.045;
/** A letter holds its ripple at least this long, so fast words still show a wave. */
const RIPPLE_HOLD_MS = 130;
const RIPPLE_HOLD_MAX_MS = 260;
/** Letters of a held syllable lift this many times a word's lift. */
const EMPHASIS_LIFT = 2.4;
/** Peak opacity of a word's bloom (emphasized words bloom fully). */
const GLOW_PEAK = 0.92;
/** Springs run on this long after the word before they count as settled... */
const TAIL_MS = 1600;
/** ...within these: px for lifts, scale units, opacity. */
const LIFT_TOL = 0.06;
const SCALE_TOL = 0.0006;
const OPACITY_TOL = 0.004;
/** Reduced motion: the lit copy and the glow fade in this fast. */
const FADE_MS = 140;
const STATIC_GLOW = 0.6;

const isEmphasized = (p: Part): boolean => p.end - p.start >= EMPHASIS_MS && [...p.text.trim()].length <= EMPHASIS_CHARS;

/** The word's parts, never empty: its syllables, or itself as one. */
export function partsOf(word: WordTiming, text: string): Part[] {
  const parts = word.parts?.filter((p) => p.end >= p.start) ?? [];
  return parts.length > 0 ? [...parts] : [{ text, start: word.start, end: word.end }];
}

/** Whether a word (by its parts) breaks into letters. */
export function emphasized(word: WordTiming, text: string): boolean {
  return partsOf(word, text).some(isEmphasized);
}

/**
 * How lively a song is, 0..1, from how fast it is sung: the median syllables per second over its
 * lines (calm ballads around 2, quick pop 4 and up, rap 6 and up).
 */
export function songEnergy(lines: readonly Pick<Line, "words">[]): number {
  const rates: number[] = [];
  for (const line of lines) {
    const first = line.words[0];
    const last = line.words[line.words.length - 1];
    if (!first || !last) continue;
    const span = last.end - first.start;
    if (span <= 0) continue;
    const count = line.words.reduce((n, w) => n + Math.max(1, syllables(w.text)), 0);
    rates.push((count * 1000) / span);
  }
  if (rates.length === 0) return 0.4;
  rates.sort((a, b) => a - b);
  const mid = rates.length >> 1;
  const median = rates.length % 2 ? (rates[mid] ?? 0) : ((rates[mid - 1] ?? 0) + (rates[mid] ?? 0)) / 2;
  return clamp01((median - 1.5) / 3.5);
}

/** A sampled spring channel trimmed to where it has settled on `final`. */
function settledLength(values: readonly number[], final: number, tol: number): number {
  for (let i = values.length - 1; i >= 0; i--) if (Math.abs((values[i] ?? final) - final) > tol) return i + 2;
  return 1;
}

/**
 * Where the wipe's edge (the end of the fully lit part) is `ms` after the word starts, in px from the
 * word's leading edge, by the word's parts: from -feather at the start to the far edge (plus the
 * overhang) at the end, linearly over each part, or eased out over a held one.
 */
export function wipeEdge(word: WordTiming, parts: readonly Part[], shape: WordShape): (ms: number) => number {
  const W = shape.width;
  const feather = FEATHER * W;
  const over = OVERHANG * shape.size;
  // each part's span along the word, in reading order from the leading edge
  const lead = (l: LetterBox): number => (shape.rtl ? W - l.x - l.w : l.x);
  const bounds = parts.map((_, j) => {
    const mine = shape.letters.filter((l) => l.part === j);
    if (mine.length === 0) return null;
    return { from: Math.min(...mine.map(lead)), to: Math.max(...mine.map((l) => lead(l) + l.w)) };
  });
  const segments: { t0: number; t1: number; x0: number; x1: number; ease: boolean }[] = [];
  let x = -feather;
  parts.forEach((p, j) => {
    const b = bounds[j];
    const last = j === parts.length - 1;
    const to = last ? W + over : (b?.to ?? x);
    segments.push({ t0: p.start - word.start, t1: p.end - word.start, x0: x, x1: Math.max(x, to), ease: isEmphasized(p) });
    x = Math.max(x, to);
  });
  return (ms: number): number => {
    let at = -feather;
    for (const s of segments) {
      if (ms <= s.t0) return at;
      const k = s.t1 > s.t0 ? clamp01((ms - s.t0) / (s.t1 - s.t0)) : 1;
      at = s.x0 + (s.x1 - s.x0) * (s.ease ? sineOut(k) : k);
      if (ms < s.t1) return at;
    }
    return at;
  };
}

/** The first time the edge reaches `x`, by bisection over [0, span] (the edge never moves back). */
function timeAtEdge(edge: (ms: number) => number, x: number, span: number): number {
  if (edge(0) >= x) return 0;
  if (edge(span) < x) return span;
  let lo = 0;
  let hi = span;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (edge(mid) >= x) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Transform keyframes from lift and scale channels sampled at `times`. */
function transformTrack(t0: number, times: number[], lift: number[], scale: number[] | null): Track {
  const keep = thin(times, scale ? [lift, scale] : [lift], scale ? [LIFT_TOL, SCALE_TOL] : [LIFT_TOL]);
  const frames = keyframesAt(times, keep, (i) => ({ transform: liftScale(0, lift[i] ?? 0, scale ? (scale[i] ?? 1) : 1) }));
  return { t0, duration: times[times.length - 1] ?? 0, frames };
}

function opacityTrack(t0: number, times: number[], values: number[]): Track {
  const keep = thin(times, [values], [OPACITY_TOL]);
  return { t0, duration: times[times.length - 1] ?? 0, frames: keyframesAt(times, keep, (i) => ({ opacity: num(clamp01(values[i] ?? 0), 3) })) };
}

/** Samples `count + 1` times (every SAMPLE_MS) of a spring chasing `target`, trimmed once settled on `final`. */
function springChannel(target: (ms: number) => number, spec: SpringSpec, from: number, spanMs: number, final: number, tol: number): number[] {
  const values = chase(target, spec, { x: from, v: 0 }, spanMs, SAMPLE_MS);
  return values.slice(0, Math.min(values.length, settledLength(values, final, tol)));
}

/** Pads channels to one length with their final values and returns the shared sample times. */
function align(channels: number[][], finals: number[]): number[] {
  const n = Math.max(2, ...channels.map((c) => c.length));
  channels.forEach((c, i) => {
    while (c.length < n) c.push(finals[i] ?? 0);
    c[n - 1] = finals[i] ?? 0;
  });
  return sampleTimes((n - 1) * SAMPLE_MS);
}

/** Plans one word's motion. `text` is the word without its trailing space. */
export function planWord(word: WordTiming, text: string, shape: WordShape, options: MotionOptions): WordMotion {
  const parts = partsOf(word, text);
  const emphasis = parts.some(isEmphasized);
  const span = Math.max(0, word.end - word.start);
  const size = shape.size;
  const none: WordMotion = {
    emphasis,
    until: word.end,
    pop: null,
    window: null,
    inner: null,
    litFade: null,
    glow: null,
    letters: shape.letters.map(() => null),
    letterGlows: shape.letters.map(() => null),
    letterRest: shape.letters.map(() => ""),
  };
  if (!options.motion) {
    // Reduced motion: the lit copy and a steady glow fade in at the word's start; the glow fades out at its end.
    const glowFrames: Keyframe[] = [
      { opacity: 0, offset: 0 },
      { opacity: STATIC_GLOW, offset: Math.min(1, FADE_MS / (span + FADE_MS)) },
      { opacity: STATIC_GLOW, offset: span / (span + FADE_MS) },
      { opacity: 0, offset: 1 },
    ];
    return {
      ...none,
      until: word.end + FADE_MS,
      litFade: { t0: word.start, duration: FADE_MS, frames: [{ opacity: 0 }, { opacity: 1 }] },
      glow: span > 0 ? { t0: word.start, duration: span + FADE_MS, frames: glowFrames } : null,
    };
  }
  if (span <= 0) return none;

  const progress = (ms: number): number => clamp01(ms / span);
  const runMs = span + TAIL_MS;

  // the pop
  const lift = springChannel((ms) => LIFT_CURVE(progress(ms)) * size, LIFT_SPRING, REST_LIFT * size, runMs, 0, LIFT_TOL);
  const scale = springChannel((ms) => SCALE_CURVE(progress(ms)), SCALE_SPRING, REST_SCALE, runMs, 1, SCALE_TOL);
  const popTimes = align([lift, scale], [0, 1]);
  const pop = transformTrack(word.start, popTimes, lift, scale);

  // the bloom
  const glowValues = springChannel((ms) => Math.max(0, GLOW_CURVE(progress(ms))), GLOW_SPRING, 0, runMs, 0, OPACITY_TOL).map(
    (g) => Math.max(0, g) * (emphasis ? 1 : GLOW_PEAK),
  );
  const glowTimes = align([glowValues], [0]);
  const glow = opacityTrack(word.start, glowTimes, glowValues);

  // the wipe
  const edge = wipeEdge(word, parts, shape);
  const sign = shape.rtl ? -1 : 1;
  // linear between syllable boundaries; sampled where a held syllable eases out
  const bounds = [...new Set([0, ...parts.map((p) => clamp(p.end - word.start, 0, span)), span])].sort((a, b) => a - b);
  const wipeTimes = emphasis ? sampleTimes(span) : bounds;
  const xs = wipeTimes.map((ms) => sign * (edge(ms) - (shape.width + OVERHANG * size)));
  const keepX = thin(wipeTimes, [xs], [0.2]);
  const windowTrack: Track = {
    t0: word.start,
    duration: span,
    frames: keyframesAt(wipeTimes, keepX, (i) => ({ transform: `translateX(${num(xs[i] ?? 0, 2)}px)` })),
  };
  const innerTrack: Track = {
    t0: word.start,
    duration: span,
    frames: keyframesAt(wipeTimes, keepX, (i) => ({ transform: `translateX(${num(-(xs[i] ?? 0), 2)}px)` })),
  };

  // the letters
  const ripple = size * (RIPPLE_MIN + RIPPLE_GAIN * clamp01(options.energy));
  const letters: (Track | null)[] = [];
  const letterGlows: (Track | null)[] = [];
  const letterRest: string[] = [];
  const lead = (l: LetterBox): number => (shape.rtl ? shape.width - l.x - l.w : l.x);
  shape.letters.forEach((letter) => {
    const part = parts[letter.part] ?? parts[0];
    if (shape.letters.length < 2 || !part) {
      letters.push(null);
      letterGlows.push(null);
      letterRest.push("");
      return;
    }
    if (isEmphasized(part)) {
      // letter by letter along a sine ease-out of the syllable; each letter's glow lasts to the syllable's end
      const mine = shape.letters.filter((l) => l.part === letter.part);
      const k = mine.length;
      const j = mine.indexOf(letter);
      const p0 = part.start - word.start;
      const pSpan = Math.max(1, part.end - part.start);
      const alpha = (ms: number): number => sineOut((ms - p0) / pSpan);
      const own = (ms: number): number => clamp01((alpha(ms) - j / k) * k);
      const lit = (ms: number): number => clamp01((alpha(ms) - j / k) / (1 - j / k));
      const restLift = REST_LIFT * size * EMPHASIS_LIFT;
      const lLift = springChannel((ms) => LIFT_CURVE(own(ms)) * size * EMPHASIS_LIFT, LIFT_SPRING, restLift, runMs, 0, LIFT_TOL);
      const lScale = springChannel((ms) => LETTER_SCALE_CURVE(own(ms)), SCALE_SPRING, LETTER_SCALE_CURVE(0), runMs, 1, SCALE_TOL);
      const times = align([lLift, lScale], [0, 1]);
      letters.push(transformTrack(word.start, times, lLift, lScale));
      const g = springChannel((ms) => Math.max(0, GLOW_CURVE(lit(ms))), LETTER_GLOW_SPRING, 0, runMs, 0, OPACITY_TOL);
      letterGlows.push(opacityTrack(word.start, align([g], [0]), g));
      letterRest.push(liftScale(0, restLift, LETTER_SCALE_CURVE(0)));
      return;
    }
    // the ripple: rise as the wipe's feather crosses the letter's middle, hold briefly, spring back
    const middle = lead(letter) + letter.w / 2;
    const hit = timeAtEdge(edge, middle - (FEATHER * shape.width) / 2, span);
    const crossing = timeAtEdge(edge, lead(letter) + letter.w, span) - timeAtEdge(edge, lead(letter) - FEATHER * shape.width, span);
    const hold = clamp(crossing, RIPPLE_HOLD_MS, RIPPLE_HOLD_MAX_MS);
    const from = Math.max(0, hit - 40);
    const rLift = springChannel((ms) => (ms >= from && ms < hit + hold ? -ripple : 0), RIPPLE_SPRING, 0, hit + hold + 900, 0, LIFT_TOL);
    const rScale = rLift.map((y) => 1 + (-y / size) * 0.9);
    const times = align([rLift, rScale], [0, 1]);
    letters.push(transformTrack(word.start, times, rLift, rScale));
    letterGlows.push(null);
    letterRest.push("");
  });

  const ends = [pop, glow, windowTrack, ...letters, ...letterGlows].filter((x): x is Track => x !== null).map((x) => x.t0 + x.duration);
  return {
    emphasis,
    until: Math.max(word.end, ...ends),
    pop,
    window: windowTrack,
    inner: innerTrack,
    litFade: null,
    glow,
    letters,
    letterGlows,
    letterRest,
  };
}

/**
 * Each letter's transform before its word is sung: letters of a held syllable wait a little small and
 * low (they rise further than a word does); the others rest in place ("").
 */
export function letterRest(word: WordTiming, text: string, shape: WordShape, motion: boolean): string[] {
  const parts = partsOf(word, text);
  return shape.letters.map((l) => {
    const part = parts[l.part] ?? parts[0];
    if (!motion || shape.letters.length < 2 || !part || !isEmphasized(part)) return "";
    return liftScale(0, REST_LIFT * shape.size * EMPHASIS_LIFT, LETTER_SCALE_CURVE(0));
  });
}

/** The word's transform before it is sung (upcoming), as a CSS transform. */
export function restTransform(size: number): string {
  return liftScale(0, REST_LIFT * size, REST_SCALE);
}

/** Where the lit window rests before its word is sung: translated so nothing is lit. */
export function closedWindow(shape: WordShape): number {
  const sign = shape.rtl ? -1 : 1;
  return -sign * (shape.width + OVERHANG * shape.size + FEATHER * shape.width);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
