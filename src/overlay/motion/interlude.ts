/**
 * Instrumental breaks: when they are, and how their three dots move (pure, no DOM).
 *
 * A break is the song's intro, or a gap between two sung lines, of INTERLUDE_MIN_MS or more (an empty
 * timed LRC line usually marks one; a long rest between lines counts too). Three dots stand where the
 * next line will be. They light one after another across 92.5 % of the break: each grows (0.75 to
 * about 1.05, then 1), brightens, rises and starts to glow. The group pops in, breathes gently, then
 * swells and pops out just before the next line starts.
 */
import type { Line } from "../../core/lrc";
import { clamp01, spline } from "./curve";
import { framesOf, keyPoints, liftScale, num, sampleTimes, thin } from "./keyframes";
import { chase, type SpringSpec } from "./spring";
import { PLAN_MS, type Track } from "./karaoke";

export interface Interlude {
  /** index (among the lyric lines) of the line the break leads into */
  next: number;
  /** song ms the dots appear */
  start: number;
  /** song ms the next line starts; the dots are gone by then */
  end: number;
}

/** A gap needs to be this long to get dots. */
export const INTERLUDE_MIN_MS = 3000;
/** Dots appear this long after the last word before the break ends, once that word has settled. */
export const INTERLUDE_LEAD_MS = 450;
/** The dots light over this share of the break... */
const FILL_SHARE = 0.925;
/** ...and the group swells this long before it ends, then pops out. */
const SWELL_MS = 90;
const POP_OUT_MS = 320;

const DOT_SCALE = spline([
  [0, 0.75],
  [0.7, 1.06],
  [1, 1],
]);
/** In dot diameters; positive is down. */
const DOT_LIFT = spline([
  [0, 0.125],
  [0.9, -0.22],
  [1, 0],
]);
const DOT_GLOW = spline([
  [0, 0],
  [0.6, 1],
  [1, 1],
]);
const DOT_OPACITY = spline([
  [0, 0.35],
  [0.6, 1],
  [1, 1],
]);
const DOT_LIFT_SPRING: SpringSpec = { hz: 1.25, damping: 0.4 };
const DOT_SCALE_SPRING: SpringSpec = { hz: 0.8, damping: 0.6 };
const DOT_GLOW_SPRING: SpringSpec = { hz: 1, damping: 0.5 };
/** The group pops: snappy, a little overshoot. */
const GROUP_SPRING: SpringSpec = { hz: 4.5, damping: 0.62 };
/** The group breathes between 1 - BREATH and 1 + BREATH every BREATH_MS. */
const BREATH = 0.045;
const BREATH_MS = 4500;
const FADE_IN_MS = 450;

/** The song's breaks, in order: the intro if long enough, then every long gap between lines. */
export function findInterludes(lines: readonly Pick<Line, "start" | "end" | "words">[], minGap = INTERLUDE_MIN_MS): Interlude[] {
  const out: Interlude[] = [];
  const first = lines[0];
  if (first && first.start >= minGap) out.push({ next: 0, start: 0, end: first.start });
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const line = lines[i];
    if (!prev || !line) continue;
    const sung = prev.words[prev.words.length - 1]?.end ?? prev.end;
    if (line.start - sung >= minGap) out.push({ next: i, start: Math.min(line.start, sung + INTERLUDE_LEAD_MS), end: line.start });
  }
  return out;
}

/** The break playing at `t`, if any ([start, end)). */
export function interludeAt(list: readonly Interlude[], t: number): Interlude | null {
  for (const il of list) if (t >= il.start && t < il.end) return il;
  return null;
}

export interface DotsMotion {
  /** scale and opacity of the whole group (pop in, breathing, swell, pop out) */
  group: { transform: Track; opacity: Track };
  /** per dot: transform (lift, size) and opacity (brightness) */
  dots: Track[];
  /** per dot: the glow's opacity */
  glows: Track[];
  /** song time everything has ended by */
  until: number;
}

/**
 * A track of the kept samples of `channels` from song time `t0`. With `quantum` (per channel, see
 * keyframes.ts keyPoints) its slow stretches step on the shared beat: the breathing and a long break's
 * slow fill then redraw 20 times a second, not 60.
 */
function track(t0: number, times: number[], keep: number[], channels: number[][], quantum: number[] | null, frame: (v: readonly number[]) => Keyframe): Track {
  const duration = times[times.length - 1] ?? 0;
  return { t0, duration, frames: framesOf(keyPoints(times, keep, channels, quantum ? { t0, quantum } : null), duration, frame) };
}

/** The most a dot's channels change per beat to step: group scale, lift px, size, opacities. */
const STEP_QUANTUM = { scale: 0.004, lift: 0.25, opacity: 0.02 };

/**
 * The dots' motion through a break, for dots `dotPx` across. Under reduced motion they only fade:
 * the group in and out, each dot to full brightness in its turn. `steps`: see MotionOptions.steps.
 */
export function planDots(il: Interlude, dotPx: number, motion: boolean, steps = false): DotsMotion {
  const q = (...quantum: number[]): number[] | null => (steps ? quantum : null);
  const len = Math.max(1, il.end - il.start);
  const slot = (FILL_SHARE * len) / 3;
  const total = len + POP_OUT_MS;
  const times = sampleTimes(total, motion ? PLAN_MS : 50);
  const swellAt = len - SWELL_MS;

  // the group
  let scale: number[];
  let opacity: number[];
  if (motion) {
    const target = (ms: number): number => {
      if (ms >= len) return 0;
      if (ms >= swellAt) return 1.15;
      // breathe from the middle, rising first
      return 1 + BREATH * Math.sin((2 * Math.PI * ms) / BREATH_MS);
    };
    scale = chase(target, GROUP_SPRING, { x: 0, v: 0 }, total, PLAN_MS).map((s) => Math.max(0, s));
    opacity = times.map((ms) => (ms < len ? clamp01(ms / FADE_IN_MS) : clamp01(1 - (ms - len) / (POP_OUT_MS * 0.6))));
  } else {
    scale = times.map(() => 1);
    opacity = times.map((ms) => (ms < len ? clamp01(ms / 300) : clamp01(1 - (ms - len) / 200)));
  }
  while (scale.length < times.length) scale.push(0);
  scale.length = times.length;
  // gone at the end, exactly
  scale[scale.length - 1] = 0;
  opacity[opacity.length - 1] = 0;
  const keepGroup = thin(times, [scale], [0.002]);
  const keepOpacity = thin(times, [opacity], [0.01]);
  const group = {
    transform: track(il.start, times, keepGroup, [scale], q(STEP_QUANTUM.scale), ([s]) => ({ transform: `scale(${num(s ?? 0, 4)})` })),
    opacity: track(il.start, times, keepOpacity, [opacity], q(STEP_QUANTUM.opacity), ([o]) => ({ opacity: num(o ?? 0, 3) })),
  };

  // the dots
  const dots: Track[] = [];
  const glows: Track[] = [];
  for (let d = 0; d < 3; d++) {
    const p = (ms: number): number => clamp01((ms - d * slot) / slot);
    if (!motion) {
      const bright = times.map((ms) => 0.35 + 0.65 * clamp01((ms - d * slot - slot * 0.5) / 250));
      const keep = thin(times, [bright], [0.01]);
      dots.push(track(il.start, times, keep, [bright], null, ([b]) => ({ transform: "translate(0px, 0px) scale(1)", opacity: num(b ?? 1, 3) })));
      glows.push(track(il.start, times, keep, [bright], null, ([b]) => ({ opacity: num(clamp01(((b ?? 1) - 0.35) / 0.65) * 0.7, 3) })));
      continue;
    }
    const lift = chase((ms) => DOT_LIFT(p(ms)) * dotPx, DOT_LIFT_SPRING, { x: DOT_LIFT(0) * dotPx, v: 0 }, total, PLAN_MS);
    const size = chase((ms) => DOT_SCALE(p(ms)), DOT_SCALE_SPRING, { x: DOT_SCALE(0), v: 0 }, total, PLAN_MS);
    const glow = chase((ms) => DOT_GLOW(p(ms)), DOT_GLOW_SPRING, { x: 0, v: 0 }, total, PLAN_MS);
    const bright = chase((ms) => DOT_OPACITY(p(ms)), DOT_GLOW_SPRING, { x: DOT_OPACITY(0), v: 0 }, total, PLAN_MS);
    for (const ch of [lift, size, glow, bright]) ch.length = times.length;
    const keep = thin(times, [lift, size, bright], [0.05, 0.002, 0.01]);
    dots.push(
      track(il.start, times, keep, [lift, size, bright], q(STEP_QUANTUM.lift, STEP_QUANTUM.scale, STEP_QUANTUM.opacity), ([y, s, b]) => ({
        transform: liftScale(0, y ?? 0, s ?? 1),
        opacity: num(clamp01(b ?? 1), 3),
      })),
    );
    const keepGlow = thin(times, [glow], [0.01]);
    glows.push(track(il.start, times, keepGlow, [glow], q(STEP_QUANTUM.opacity), ([g]) => ({ opacity: num(clamp01(g ?? 0), 3) })));
  }
  return { group, dots, glows, until: il.start + total };
}
