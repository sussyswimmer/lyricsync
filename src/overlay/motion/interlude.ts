/**
 * Instrumental breaks: when they are, and how their three dots move (pure, no DOM).
 *
 * A break is the song's intro, or a gap between two sung lines, of INTERLUDE_MIN_MS or more (an empty
 * timed LRC line usually marks one; a long rest between lines counts too). Three dots stand where the
 * next line will be. They light one after another across 92.5 % of the break: each grows (0.75 to
 * about 1.05, then 1), brightens, rises and starts to glow. The group pops in, breathes gently, swells
 * over the break's last 250 ms, and pops out as the break ends at E: the next line's lead (LEAD_MS
 * before it starts), when the view moves on to it. All numbers are in params.ts (DOTS).
 */
import type { Line } from "../../core/lrc";
import { clamp01, spline } from "./curve";
import { framesOf, keyPoints, liftScale, num, sampleTimes, thin } from "./keyframes";
import { PLAN_MS, type Track } from "./karaoke";
import { DOTS, LEAD_MS, type MotionParams } from "./params";
import { chase, springStep, type SpringSpec, type SpringState } from "./spring";

export interface Interlude {
  /** index (among the lyric lines) of the line the break leads into */
  next: number;
  /** song ms the dots appear */
  start: number;
  /** E: song ms the break ends and the view moves to the next line (its start - LEAD_MS); the dots pop out from here */
  end: number;
}

/** A gap needs to be this long to get dots. */
export const INTERLUDE_MIN_MS = 3000;
/** Dots appear this long after the last word before the break ends, once that word has settled. */
export const INTERLUDE_AFTER_MS = 450;

/** The song's breaks, in order: the intro if long enough, then every long gap between lines. */
export function findInterludes(lines: readonly Pick<Line, "start" | "end" | "words">[], minGap = INTERLUDE_MIN_MS): Interlude[] {
  const out: Interlude[] = [];
  const first = lines[0];
  if (first && first.start >= minGap) out.push({ next: 0, start: 0, end: first.start - LEAD_MS });
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const line = lines[i];
    if (!prev || !line) continue;
    const sung = prev.words[prev.words.length - 1]?.end ?? prev.end;
    const end = line.start - LEAD_MS;
    if (line.start - sung >= minGap) out.push({ next: i, start: Math.min(end, sung + INTERLUDE_AFTER_MS), end });
  }
  return out;
}

/** The break playing at `t`, if any ([start, end)). */
export function interludeAt(list: readonly Interlude[], t: number): Interlude | null {
  for (const il of list) if (t >= il.start && t < il.end) return il;
  return null;
}

export interface DotsMotion {
  /** the whole group: its scale (pop in, breathing, swell, pop out; null when it doesn't move) and opacity */
  group: { transform: Track | null; opacity: Track };
  /** per dot: transform (lift, size) and opacity (brightness); only opacity when the dots don't move */
  dots: Track[];
  /** per dot: its halo's opacity */
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

/** A spring chasing `target(ms)` whose spec changes at `switchAt` (the pop-out's snappier spring). */
function chaseTwo(target: (ms: number) => number, first: SpringSpec, second: SpringSpec, switchAt: number, from: number, times: readonly number[]): number[] {
  let state: SpringState = { x: from, v: 0 };
  let t = 0;
  return times.map((until) => {
    while (t < until - 1e-9) {
      const dt = Math.min(8, until - t, t < switchAt ? switchAt - t : Infinity);
      state = springStep(state, target(t + dt / 2), dt / 1000, t < switchAt ? first : second);
      t += dt;
    }
    return state.x;
  });
}

/**
 * The dots' motion through a break, for dots `dotPx` across, with `params.dotAmp` of BL's motion.
 * Without motion (reduced motion, the lite tier, Effects 0) they only fade: the group in and out, each
 * dot to full brightness in its turn. `steps`: see PlanOptions.steps.
 */
export function planDots(il: Interlude, dotPx: number, params: MotionParams, steps = false): DotsMotion {
  const q = (...quantum: number[]): number[] | null => (steps ? quantum : null);
  const amp = params.karaoke === "full" ? params.dotAmp : 0;
  const moving = amp > 0;
  const len = Math.max(1, il.end - il.start);
  const slot = (DOTS.fillShare * len) / 3;
  const total = len + DOTS.tailMs;
  const times = sampleTimes(total, moving ? PLAN_MS : 50);

  // the group
  const opacity = times.map((ms) =>
    ms < len ? clamp01(ms / (moving ? DOTS.fadeInMs : DOTS.calmFadeInMs)) : clamp01(1 - (ms - len) / DOTS.fadeOutMs),
  );
  opacity[opacity.length - 1] = 0;
  const keepOpacity = thin(times, [opacity], [0.01]);
  let transform: Track | null = null;
  if (moving) {
    const away = 1 - amp;
    const swellAt = len - DOTS.swellMs;
    const target = (ms: number): number => {
      if (ms >= len) return away;
      if (ms >= swellAt) return 1 + (DOTS.swell - 1) * amp;
      // breathe from the middle, rising first
      return 1 + DOTS.breath * amp * Math.sin((2 * Math.PI * ms) / DOTS.breathMs);
    };
    const scale = chaseTwo(target, DOTS.popInSpring, DOTS.popOutSpring, len, away, times).map((s) => Math.max(0, s));
    scale[scale.length - 1] = away;
    const keepGroup = thin(times, [scale], [0.002]);
    transform = track(il.start, times, keepGroup, [scale], q(STEP_QUANTUM.scale), ([s]) => ({ transform: `scale(${num(s ?? 0, 4)})` }));
  }
  const group = {
    transform,
    opacity: track(il.start, times, keepOpacity, [opacity], q(STEP_QUANTUM.opacity), ([o]) => ({ opacity: num(o ?? 0, 3) })),
  };

  // the dots
  const dots: Track[] = [];
  const glows: Track[] = [];
  const liftCurve = spline(DOTS.liftKeys);
  const scaleCurve = spline(DOTS.scaleKeys);
  const brightCurve = spline(DOTS.brightKeys);
  const haloCurve = spline(DOTS.haloKeys);
  const dim = DOTS.brightKeys[0]?.[1] ?? 0.35;
  for (let d = 0; d < 3; d++) {
    const p = (ms: number): number => clamp01((ms - d * slot) / slot);
    if (!moving) {
      const bright = times.map((ms) => dim + (1 - dim) * clamp01((ms - d * slot - slot * 0.5) / DOTS.brightenMs));
      const keep = thin(times, [bright], [0.01]);
      dots.push(track(il.start, times, keep, [bright], null, ([b]) => ({ opacity: num(b ?? 1, 3) })));
      glows.push(track(il.start, times, keep, [bright], null, ([b]) => ({ opacity: num(clamp01(((b ?? 1) - dim) / (1 - dim)) * 0.7, 3) })));
      continue;
    }
    const lift = chase((ms) => liftCurve(p(ms)) * dotPx * amp, DOTS.liftSpring, { x: liftCurve(0) * dotPx * amp, v: 0 }, total, PLAN_MS);
    const size = chase((ms) => 1 + (scaleCurve(p(ms)) - 1) * amp, DOTS.scaleSpring, { x: 1 + (scaleCurve(0) - 1) * amp, v: 0 }, total, PLAN_MS);
    const halo = chase((ms) => haloCurve(p(ms)), DOTS.brightSpring, { x: 0, v: 0 }, total, PLAN_MS);
    const bright = chase((ms) => brightCurve(p(ms)), DOTS.brightSpring, { x: brightCurve(0), v: 0 }, total, PLAN_MS);
    for (const ch of [lift, size, halo, bright]) ch.length = times.length;
    const keep = thin(times, [lift, size, bright], [0.05, 0.002, 0.01]);
    dots.push(
      track(il.start, times, keep, [lift, size, bright], q(STEP_QUANTUM.lift, STEP_QUANTUM.scale, STEP_QUANTUM.opacity), ([y, s, b]) => ({
        transform: liftScale(0, y ?? 0, s ?? 1),
        opacity: num(clamp01(b ?? 1), 3),
      })),
    );
    const keepHalo = thin(times, [halo], [0.01]);
    glows.push(track(il.start, times, keepHalo, [halo], q(STEP_QUANTUM.opacity), ([g]) => ({ opacity: num(clamp01(g ?? 0), 3) })));
  }
  return { group, dots, glows, until: il.start + total };
}
