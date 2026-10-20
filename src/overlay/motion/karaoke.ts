/**
 * The karaoke motion of one word, planned ahead as keyframes (pure, no DOM). Every number comes from
 * the line's MotionParams (params.ts), worked out from the song's look and the user's Effects:
 *
 * - wipe: the word fills from the lyric color to the highlight, left to right (right to left in
 *   right-to-left text), syllable by syllable, linearly over each syllable's time, behind a soft edge
 *   FEATHER of the word's width. Drawn as a lit copy inside a window that slides over the word while
 *   its contents slide back the other way, so the text stays put and nothing repaints.
 * - pop: an upcoming word rests a little small and low; while sung it swells and rises past its rest,
 *   then settles to scale 1 and no lift. Springs carry it: the lift bouncy, the scale slow, so quick
 *   words barely move and held ones visibly rise, overshoot and settle. That is the "rise" move; the
 *   song's move (params.ts moveTuning) reshapes it: a bounce, a pulse, a drop, a wave in the letters,
 *   or a sway, which adds a tilt that swings back through rest.
 * - glow: the word's bloom rises in the first 15 % of the word, holds, and fades by its end.
 * - letters: every letter hops in turn as the wipe has lit it (a ripple as tall as the song is
 *   lively); a held syllable (the look's emphasis rule) lights letter by letter along a sine ease-out,
 *   each letter lifting further than a word does and glowing until the syllable ends.
 * - "fade" karaoke (reduced motion, the lite tier): the lit copy fades in as the word starts and the
 *   bloom holds steady while it is sung. Nothing moves.
 *
 * Times are song ms. Each track runs from its own `t0` for `duration` ms; `rebase` stretches tracks
 * onto one shared window so a whole line can start and end its animations together.
 */
import { clamp01, sineOut, spline } from "./curve";
import { framesOf, keyPoints, liftScale, liftTiltScale, num, sampleTimes, thin } from "./keyframes";
import { graphemes } from "./letters";
import type { EmphasisRule, MotionParams } from "./params";
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
  /** where its glyphs draw past their boxes, when measured (letters.ts measureLetters) */
  ink?: WordInk;
}

/**
 * How far a word's ink reaches past its boxes, px: a script face's crossbars and tails, a Vietnamese
 * tone mark set beside its circumflex. Glyphs may draw outside their advance; the wipe and every
 * copy's box have to reach them.
 */
export interface WordInk {
  /** past the word's left and right edges (each >= 0) */
  left: number;
  right: number;
  /** sideways past the box of any one letter drawn alone, or of the whole word (>= 0) */
  side: number;
  /** above the font's ascent and below its descent, for the tallest and deepest glyph (< 0: room to spare) */
  above: number;
  below: number;
  /** the font's ascent and descent, px (the layout box around the baseline, before line-height) */
  ascent: number;
  descent: number;
}

export interface PlanOptions {
  /**
   * The pose the word starts its pop from: "rest" (small and low, as an upcoming word waits), or
   * "full" for a word sung the moment its line comes into focus (it never had time to settle into rest).
   */
  from?: "rest" | "full";
  /** the line's last word: an emphasis rule with lastWordOnly applies to it alone */
  isLast?: boolean;
  /**
   * Slow stretches step on the shared song-time beat (keyframes.ts keyPoints) instead of gliding,
   * where the engine still runs stepped keyframes on the compositor (compositorSteps).
   */
  steps?: boolean;
  /** the word's place in its line: a swaying word tilts the other way from its neighbors */
  index?: number;
}

/** A keyframe animation to run from song time `t0`. */
export interface Track {
  t0: number;
  duration: number;
  frames: Keyframe[];
}

export interface WordMotion {
  /** any part is a held note, lit letter by letter */
  emphasis: boolean;
  /** song time by which every track below has ended */
  until: number;
  /** transform of the whole word (pop) */
  pop: Track | null;
  /**
   * translateX of the windows' track (the lit window and the base window move together, their shared
   * feather the wipe's edge), and of each window's contents (the opposite, so the text stays put)
   */
  window: Track | null;
  inner: Track | null;
  /** "fade" karaoke: the lit copy fades in instead of wiping */
  litFade: Track | null;
  /** opacity of the word's bloom */
  glow: Track | null;
  /** transform per letter of the lit copy (and its dark twin), null where a letter doesn't move */
  letters: (Track | null)[];
  /** whether the base copy (and the letter's bloom) moves with it: letters of a held syllable rise while they light */
  moveBase: boolean[];
  /** opacity of each letter's own bloom (held letters only) */
  letterGlows: (Track | null)[];
  /** each letter's transform before its word is sung ("" = none) */
  letterRest: string[];
}

/** Soft edge of the wipe, as a share of the word's width. */
export const FEATHER = 0.2;
/** The wipe ends at least this many font sizes past the word's advance, so overhanging glyphs light fully. */
export const OVERHANG = 0.06;
/** Ink is reached with this much to spare, px (antialiased edges). */
const INK_MARGIN = 1;

/** How far past its trailing edge the word's wipe runs: past every glyph there, and at least OVERHANG. */
export function trailOf(shape: WordShape): number {
  const ink = shape.rtl ? shape.ink?.left : shape.ink?.right;
  return Math.max(OVERHANG * shape.size, ink && ink > 0 ? ink + INK_MARGIN : 0);
}

/** How far before its leading edge the word's ink starts, px: the wipe starts there. */
export function leadOf(shape: WordShape): number {
  const ink = shape.rtl ? shape.ink?.right : shape.ink?.left;
  return ink && ink > 0 ? ink + INK_MARGIN : 0;
}
/** Springs stop once they are this close to rest: px for lifts, scale units, opacity, degrees. */
const SETTLED = { lift: 0.08, scale: 0.0008, opacity: 0.005, tilt: 0.03 };
/** Keyframes are kept where straight lines between them would miss by more than this (all sub-pixel). */
const THIN = { lift: 0.15, scale: 0.0015, opacity: 0.01, x: 0.25, tilt: 0.05 };
/**
 * A stretch that changes less than this per STEP_MS (px for lifts and the wipe, scale units, opacity)
 * steps on the beat: about a third of a pixel of lift, under half a pixel of a word's edge, a pixel of
 * a soft-edged wipe, 2 % of a glow, each 20 times a second.
 */
const STEP_QUANTUM = { lift: 0.5, scale: 0.006, opacity: 0.04, x: 1.2, tilt: 0.15 };
/** Plans are sampled this often; the compositor interpolates linearly in between. */
export const PLAN_MS = 1000 / 30;
/** The ripple's hop lasts its hold plus this long to settle back. */
const HOP_SETTLE_MS = 700;

/** The curves of one set of parameters, built once (a spline solves its tridiagonal system when made). */
interface Curves {
  lift: (x: number) => number;
  scale: (x: number) => number;
  glow: (x: number) => number;
  letterScale: (x: number) => number;
  sway: (x: number) => number;
}
const curveCache = new WeakMap<MotionParams, Curves>();
function curvesOf(p: MotionParams): Curves {
  let c = curveCache.get(p);
  if (!c) {
    c = { lift: spline(p.liftKeys), scale: spline(p.scaleKeys), glow: spline(p.glowKeys), letterScale: spline(p.letterScaleKeys), sway: spline(p.swayKeys) };
    curveCache.set(p, c);
  }
  return c;
}

/** Whether a syllable is a held note under `rule`: long enough, and short enough to light letter by letter. */
export function heldPart(p: Part, rule: EmphasisRule | null): boolean {
  return rule !== null && p.end - p.start >= rule.minMs && graphemes(p.text.trim()).length <= rule.maxChars;
}

/** The word's parts, never empty: its syllables, or itself as one. */
export function partsOf(word: WordTiming, text: string): Part[] {
  const parts = word.parts?.filter((p) => p.end >= p.start) ?? [];
  return parts.length > 0 ? [...parts] : [{ text, start: word.start, end: word.end }];
}

/** Which of a word's parts are held notes (with `lastWordOnly`, only the line's last word has any). */
export function heldParts(word: WordTiming, text: string, rule: EmphasisRule | null, isLast = false): boolean[] {
  const parts = partsOf(word, text);
  if (!rule || (rule.lastWordOnly && !isLast)) return parts.map(() => false);
  return parts.map((p) => heldPart(p, rule));
}

/** Whether a word (by its parts) has a held note that breaks into letters. */
export function emphasized(word: WordTiming, text: string, rule: EmphasisRule | null, isLast = false): boolean {
  return heldParts(word, text, rule, isLast).some(Boolean);
}

/**
 * Where the wipe's edge (the end of the fully lit part) is `ms` after the word starts, in px from the
 * word's leading edge, by the word's parts: from a feather before its ink at the start to its far edge
 * (plus the overhang) at the end, linearly over each part, or eased out over a held one (`eased[j]`).
 */
export function wipeEdge(word: WordTiming, parts: readonly Part[], shape: WordShape, eased: readonly boolean[] = []): (ms: number) => number {
  const W = shape.width;
  const start = -(FEATHER * W + leadOf(shape));
  const over = trailOf(shape);
  // each part's span along the word, in reading order from the leading edge
  const lead = (l: LetterBox): number => (shape.rtl ? W - l.x - l.w : l.x);
  const ends = parts.map((_, j) => {
    const mine = shape.letters.filter((l) => l.part === j);
    return mine.length === 0 ? null : Math.max(...mine.map((l) => lead(l) + l.w));
  });
  const segments: { t0: number; t1: number; x0: number; x1: number; ease: boolean }[] = [];
  let x = start;
  parts.forEach((p, j) => {
    const to = j === parts.length - 1 ? W + over : (ends[j] ?? x);
    segments.push({ t0: p.start - word.start, t1: p.end - word.start, x0: x, x1: Math.max(x, to), ease: eased[j] === true });
    x = Math.max(x, to);
  });
  return (ms: number): number => {
    let at = start;
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

/** A spring following `target` (ms from the word's start) from rest at `from`, stopped once settled on `final`. */
function springChannel(target: (ms: number) => number, spec: SpringSpec, from: number, spanMs: number, final: number, tol: number): number[] {
  const values = chase(target, spec, { x: from, v: 0 }, spanMs, PLAN_MS);
  let n = values.length;
  while (n > 1 && Math.abs((values[n - 1] ?? final) - final) <= tol && Math.abs((values[n - 2] ?? final) - final) <= tol) n--;
  values.length = Math.min(values.length, n + 1);
  return values;
}

/** Pads channels to one length with their final values (ending exactly on them) and returns the sample times. */
function align(channels: number[][], finals: number[]): number[] {
  const n = Math.max(2, ...channels.map((c) => c.length));
  channels.forEach((c, i) => {
    while (c.length < n) c.push(finals[i] ?? 0);
    c[n - 1] = finals[i] ?? 0;
  });
  return sampleTimes((n - 1) * PLAN_MS, PLAN_MS);
}

/** A lift-and-scale track from song time `t0`; `steps` puts its slow stretches on the beat. */
function transformTrack(t0: number, times: number[], lift: number[], scale: number[], steps = false): Track {
  const keep = thin(times, [lift, scale], [THIN.lift, THIN.scale]);
  const duration = times[times.length - 1] ?? 0;
  const points = keyPoints(times, keep, [lift, scale], steps ? { t0, quantum: [STEP_QUANTUM.lift, STEP_QUANTUM.scale] } : null);
  return { t0, duration, frames: framesOf(points, duration, ([y, s]) => ({ transform: liftScale(0, y ?? 0, s ?? 1) })) };
}

/** A swaying word's lift, tilt and scale track (liftTiltScale), like transformTrack's. */
function tiltTrack(t0: number, times: number[], lift: number[], tilt: number[], scale: number[], steps = false): Track {
  const keep = thin(times, [lift, tilt, scale], [THIN.lift, THIN.tilt, THIN.scale]);
  const duration = times[times.length - 1] ?? 0;
  const points = keyPoints(times, keep, [lift, tilt, scale], steps ? { t0, quantum: [STEP_QUANTUM.lift, STEP_QUANTUM.tilt, STEP_QUANTUM.scale] } : null);
  return { t0, duration, frames: framesOf(points, duration, ([y, r, s]) => ({ transform: liftTiltScale(y ?? 0, r ?? 0, s ?? 1) })) };
}

function opacityTrack(t0: number, times: number[], values: number[], steps = false): Track {
  const keep = thin(times, [values], [THIN.opacity]);
  const duration = times[times.length - 1] ?? 0;
  const points = keyPoints(times, keep, [values], steps ? { t0, quantum: [STEP_QUANTUM.opacity] } : null);
  return { t0, duration, frames: framesOf(points, duration, ([o]) => ({ opacity: num(clamp01(o ?? 0), 3) })) };
}

/** Song time by which a word's motion has ended at the latest (its line's shared window can end there). */
export function wordUntil(word: WordTiming, params: MotionParams): number {
  return word.start + Math.max(1, word.end - word.start) + (params.karaoke === "fade" ? params.fadeMs : params.tailMs);
}

/** Plans one word's motion. `text` is the word without its trailing space. */
export function planWord(word: WordTiming, text: string, shape: WordShape, params: MotionParams, options: PlanOptions = {}): WordMotion {
  const isLast = options.isLast === true;
  const parts = partsOf(word, text);
  const held = heldParts(word, text, params.emphasis, isLast);
  const emphasis = params.karaoke === "full" && held.some(Boolean);
  // A word with no time to it still lights (in one step) when its time comes.
  const span = Math.max(1, word.end - word.start);
  const size = shape.size;
  const none: WordMotion = {
    emphasis,
    until: word.start + span,
    pop: null,
    window: null,
    inner: null,
    litFade: null,
    glow: null,
    letters: shape.letters.map(() => null),
    moveBase: shape.letters.map(() => false),
    letterGlows: shape.letters.map(() => null),
    letterRest: letterRest(word, text, shape, params, isLast),
  };
  if (params.karaoke === "fade") {
    // The lit copy and a steady bloom fade in at the word's start; the bloom fades out at its end.
    // Where the compositor runs stepped keyframes, a tier that steps its fades (params.fadeSteps)
    // jumps through them evenly, the first jump on the word's start: one word's fade-out and the
    // next one's fade-in then share their frames.
    const fade = params.fadeMs;
    const total = span + fade;
    const n = options.steps === true ? Math.max(0, Math.round(params.fadeSteps)) : 0;
    const stepped = (f: Keyframe): Keyframe => (n > 0 ? { ...f, easing: `steps(${n}, start)` } : f);
    return {
      ...none,
      until: word.start + total,
      litFade: { t0: word.start, duration: fade, frames: [stepped({ opacity: 0 }), { opacity: 1 }] },
      glow: {
        t0: word.start,
        duration: total,
        frames: [
          stepped({ opacity: 0, offset: 0 }),
          { opacity: params.steadyGlow, offset: Math.min(fade, span) / total },
          stepped({ opacity: params.steadyGlow, offset: span / total }),
          { opacity: 0, offset: 1 },
        ],
      },
    };
  }

  const curves = curvesOf(params);
  const progress = (ms: number): number => clamp01(ms / span);
  const runMs = span + params.tailMs;
  const steps = options.steps === true;
  const moves = params.amp > 0;

  // the pop (and a swaying word's tilt, toward alternate sides word by word)
  let pop: Track | null = null;
  if (moves) {
    const fromFull = options.from === "full";
    const lift = springChannel((ms) => curves.lift(progress(ms)) * size, params.liftSpring, fromFull ? 0 : params.restLift * size, runMs, 0, SETTLED.lift);
    const scale = springChannel((ms) => curves.scale(progress(ms)), params.scaleSpring, fromFull ? 1 : params.restScale, runMs, 1, SETTLED.scale);
    if (params.swayDeg > 0) {
      const side = (options.index ?? 0) % 2 === 0 ? 1 : -1;
      const tilt = springChannel((ms) => curves.sway(progress(ms)) * params.swayDeg * side, params.swaySpring, 0, runMs, 0, SETTLED.tilt);
      pop = tiltTrack(word.start, align([lift, tilt, scale], [0, 0, 1]), lift, tilt, scale, steps);
    } else {
      pop = transformTrack(word.start, align([lift, scale], [0, 1]), lift, scale, steps);
    }
  }

  // the bloom
  const peak = emphasis ? params.glowPeakHeld : params.glowPeak;
  const glowValues = springChannel((ms) => Math.max(0, curves.glow(progress(ms))), params.glowSpring, 0, runMs, 0, SETTLED.opacity).map((g) => Math.max(0, g) * peak);
  const glow = opacityTrack(word.start, align([glowValues], [0]), glowValues, steps);

  // the wipe: linear between syllable boundaries, sampled where a held syllable eases out
  const edge = wipeEdge(word, parts, shape, held);
  const sign = shape.rtl ? -1 : 1;
  const bounds = [...new Set([0, ...parts.map((p) => Math.min(span, Math.max(0, p.end - word.start))), span])].sort((a, b) => a - b);
  const wipeTimes = emphasis ? sampleTimes(span, PLAN_MS) : bounds;
  const xs = wipeTimes.map((ms) => sign * (edge(ms) - (shape.width + trailOf(shape))));
  const keepX = thin(wipeTimes, [xs], [THIN.x]);
  // the windows and their contents step together: one set of points for both
  const wipe = keyPoints(wipeTimes, keepX, [xs], steps ? { t0: word.start, quantum: [STEP_QUANTUM.x] } : null);
  const window: Track = { t0: word.start, duration: span, frames: framesOf(wipe, span, ([x]) => ({ transform: `translateX(${num(x ?? 0, 2)}px)` })) };
  const inner: Track = { t0: word.start, duration: span, frames: framesOf(wipe, span, ([x]) => ({ transform: `translateX(${num(-(x ?? 0), 2)}px)` })) };

  // the letters
  const letters: (Track | null)[] = [];
  const letterGlows: (Track | null)[] = [];
  const moveBase: boolean[] = [];
  const split = shape.letters.length >= 2;
  // how long the wipe takes to cross an average letter and the feather: the hop's hold. The wipe ends
  // with the word's last syllable, which may end before the word does.
  const wiping = Math.max(1, Math.min(span, (parts[parts.length - 1]?.end ?? word.end) - word.start));
  const plain = shape.letters.filter((l) => held[l.part] !== true);
  const avg = plain.length > 0 ? plain.reduce((n, l) => n + l.w, 0) / plain.length : 0;
  const crossing = (wiping * (avg + FEATHER * shape.width)) / Math.max(1, shape.width * (1 + FEATHER) + trailOf(shape) + leadOf(shape));
  const [holdMin, holdMax] = params.rippleHoldMs;
  const hold = Math.min(holdMax, Math.max(holdMin, crossing));
  const height = params.rippleHeight * size;
  let hopTrack: Track | null = null;
  const hop = (): Track => {
    if (hopTrack) return hopTrack;
    const hLift = springChannel((ms) => (ms < hold ? -height : 0), params.rippleSpring, 0, hold + HOP_SETTLE_MS, 0, SETTLED.lift);
    const hScale = hLift.map((y) => 1 + (-y / size) * params.rippleSwell);
    // shared by every letter of the word, each at its own t0, so it can't step on the beat (and is quick)
    hopTrack = transformTrack(0, align([hLift, hScale], [0, 1]), hLift, hScale);
    return hopTrack;
  };
  const lead = (l: LetterBox): number => (shape.rtl ? shape.width - l.x - l.w : l.x);
  for (const letter of shape.letters) {
    moveBase.push(false);
    const part = parts[letter.part] ?? parts[0];
    if (!split || !part) {
      letters.push(null);
      letterGlows.push(null);
      continue;
    }
    if (held[letter.part] === true) {
      // letter by letter along a sine ease-out of the syllable; each letter's glow lasts to the syllable's end
      const mine = shape.letters.filter((l) => l.part === letter.part);
      const k = mine.length;
      const j = mine.indexOf(letter);
      const p0 = part.start - word.start;
      const pSpan = Math.max(1, part.end - part.start);
      const alpha = (ms: number): number => sineOut((ms - p0) / pSpan);
      const own = (ms: number): number => clamp01((alpha(ms) - j / k) * k);
      const lit = (ms: number): number => clamp01((alpha(ms) - j / k) / (1 - j / k));
      if (moves) {
        const gain = params.letterLiftGain;
        const lLift = springChannel((ms) => curves.lift(own(ms)) * size * gain, params.liftSpring, params.restLift * size * gain, runMs, 0, SETTLED.lift);
        const lScale = springChannel((ms) => curves.letterScale(own(ms)), params.scaleSpring, curves.letterScale(0), runMs, 1, SETTLED.scale);
        letters.push(transformTrack(word.start, align([lLift, lScale], [0, 1]), lLift, lScale, steps));
        moveBase[moveBase.length - 1] = true;
      } else {
        letters.push(null);
      }
      const g = springChannel((ms) => Math.max(0, curves.glow(lit(ms))), params.letterGlowSpring, 0, runMs, 0, SETTLED.opacity);
      letterGlows.push(opacityTrack(word.start, align([g], [0]), g, steps));
      continue;
    }
    letterGlows.push(null);
    if (!moves || !(height > 0)) {
      letters.push(null);
      continue;
    }
    // the ripple: each letter hops once it is fully lit (only the lit copy shows there), the same hop
    // for every letter of the word, shifted to its time
    const at = timeAtEdge(edge, lead(letter) + letter.w, span);
    const h = hop();
    letters.push({ t0: word.start + Math.max(0, at - params.rippleLeadMs), duration: h.duration, frames: h.frames });
  }

  const ends = [pop, glow, window, ...letters, ...letterGlows].filter((x): x is Track => x !== null).map((x) => x.t0 + x.duration);
  return { ...none, until: Math.max(word.start + span, ...ends), pop, window, inner, glow, letters, moveBase, letterGlows };
}

/**
 * Each letter's transform before its word is sung: letters of a held syllable wait a little small and
 * low (they rise further than a word does); the others rest in place ("").
 */
export function letterRest(word: WordTiming, text: string, shape: WordShape, params: MotionParams, isLast = false): string[] {
  const held = heldParts(word, text, params.emphasis, isLast);
  const moves = params.karaoke === "full" && params.amp > 0 && shape.letters.length >= 2;
  const scale0 = params.letterScaleKeys[0]?.[1] ?? 1;
  return shape.letters.map((l) => (moves && held[l.part] === true ? liftScale(0, params.restLift * params.letterLiftGain * shape.size, scale0) : ""));
}

/** The word's transform before it is sung (upcoming), as a CSS transform (with the tilt's place for a sway). */
export function restTransform(size: number, params: MotionParams): string {
  return params.swayDeg > 0 ? liftTiltScale(params.restLift * size, 0, params.restScale) : liftScale(0, params.restLift * size, params.restScale);
}

/** The same transform function list at full size, no lift. */
export const FULL_TRANSFORM = liftScale(0, 0, 1);

/** A word's pose at full size, no lift, in its move's transform function list (a sway's has a tilt). */
export function fullTransform(params: MotionParams): string {
  return params.swayDeg > 0 ? liftTiltScale(0, 0, 1) : FULL_TRANSFORM;
}

/** Where the lit window rests before its word is sung: translated so nothing is lit, overhangs included. */
export function closedWindow(shape: WordShape): number {
  const sign = shape.rtl ? -1 : 1;
  return -sign * (shape.width + trailOf(shape) + FEATHER * shape.width + leadOf(shape));
}

/**
 * A track stretched onto the window [origin, end] (song ms): it holds its first frame from the origin
 * until it starts, and its last from when it ends until `end`. `lead` frames (with song times) can
 * replace the hold before it starts. Every animation of a line shares one window, so the browser
 * starts and finishes them together: one main-thread frame each way instead of one per animation.
 */
export function rebase(track: Track, origin: number, end: number, lead: readonly { at: number; frame: Keyframe }[] = []): Keyframe[] {
  const span = Math.max(1, end - origin);
  const at = (t: number): number => Math.min(1, Math.max(0, (t - origin) / span));
  const strip = (f: Keyframe): Keyframe => {
    const { offset: _offset, ...rest } = f;
    void _offset;
    return rest;
  };
  const out: Keyframe[] = [];
  const first = track.frames[0];
  if (lead.length > 0) for (const l of lead) out.push({ ...strip(l.frame), offset: at(l.at) });
  else if (first && track.t0 > origin) out.push({ ...strip(first), offset: 0 });
  const n = track.frames.length;
  track.frames.forEach((f, i) => {
    const local = typeof f.offset === "number" ? f.offset : n > 1 ? i / (n - 1) : 0;
    out.push({ ...strip(f), offset: at(track.t0 + local * track.duration) });
  });
  const last = track.frames[n - 1];
  if (last && track.t0 + track.duration < end) out.push({ ...strip(last), offset: 1 });
  if (out.length > 0) {
    // a window starting with the track still needs a frame at 0, and offsets must never run backwards
    const head = out[0];
    if (head && head.offset !== 0) out.unshift({ ...strip(head), offset: 0 });
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1]?.offset;
      const cur = out[i];
      if (cur && typeof prev === "number" && typeof cur.offset === "number" && cur.offset < prev) cur.offset = prev;
    }
  }
  return out;
}
