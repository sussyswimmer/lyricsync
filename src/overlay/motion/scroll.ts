/**
 * Line-to-line motion on the document timeline (wall time). The list's scroll, and Lens's and Arc's
 * glides, are transitions between discrete states: they start when the view changes, from what is on
 * screen at that moment, and run to rest whatever the song does meanwhile. A pause lets a glide in
 * flight finish; a seek back retargets it from where it is, moving, rather than from where it began.
 *
 * WallGlide is that spring: released at a document-timeline time from a state (position and
 * velocity), solved in closed form, and retargeted from the exact state it shows at the moment of the
 * change. springFrames samples it into keyframes for the compositor.
 */
import { SAMPLE_MS, keyframesAt, sampleTimes, thin } from "./keyframes";
import { settleMs, springStep, type SpringSpec, type SpringState } from "./spring";

const perfNow = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

/** A glide sampled from its release to rest. */
export interface GlideSamples {
  /** document-timeline time of the first sample (the release) */
  startTime: number;
  /** ms from the release, every `everyMs`, the last one exactly at `duration` */
  times: number[];
  /** the position at each sample */
  xs: number[];
  duration: number;
}

export class WallGlide {
  private from: SpringState;
  private goal: number;
  private releasedAt: number;
  private springSpec: SpringSpec;

  /** At rest at `x`. */
  constructor(x: number, spec: SpringSpec, now = perfNow()) {
    this.from = { x, v: 0 };
    this.goal = x;
    this.releasedAt = now;
    this.springSpec = spec;
  }

  /** Where it is headed. */
  get target(): number {
    return this.goal;
  }

  get spec(): SpringSpec {
    return this.springSpec;
  }

  /** Document-timeline time of its last release. */
  get released(): number {
    return this.releasedAt;
  }

  /** Its state `ms` after the release (before it: the state it was released from). */
  at(ms: number): SpringState {
    return springStep(this.from, this.goal, Math.max(0, ms) / 1000, this.springSpec);
  }

  /** Its state at document-timeline time `now`: what is on screen. */
  state(now = perfNow()): SpringState {
    return this.at(now - this.releasedAt);
  }

  /**
   * Heads for `target` from the state shown at `now` (position and velocity), on `spec` (the current
   * spring by default). A glide in flight bends toward the new target without a jump.
   */
  to(target: number, now = perfNow(), spec = this.springSpec): void {
    this.from = this.state(now);
    this.goal = target;
    this.releasedAt = now;
    this.springSpec = spec;
  }

  /** Stops dead at `x` (a cut). */
  cut(x: number, now = perfNow()): void {
    this.from = { x, v: 0 };
    this.goal = x;
    this.releasedAt = now;
  }

  /** Ms after the release until it stays within `tolerance` of its target. */
  settleMs(tolerance: number): number {
    const speed = Math.abs(this.from.v) / (2 * Math.PI * this.springSpec.hz);
    return settleMs(this.springSpec, Math.abs(this.from.x - this.goal) + speed, tolerance);
  }

  /** Whether it is still visibly moving at `now`. */
  moving(now = perfNow(), tolerance = 0.002): boolean {
    return now - this.releasedAt < this.settleMs(tolerance);
  }

  /**
   * Samples it from its release to rest (within `tolerance`), every `everyMs`, for at least `minMs`
   * and at most `maxMs`.
   */
  samples(everyMs = SAMPLE_MS, tolerance = 0.002, minMs = 200, maxMs = 2600): GlideSamples {
    const duration = Math.min(maxMs, Math.max(minMs, this.settleMs(tolerance)));
    const times = sampleTimes(duration, everyMs);
    const xs = times.map((ms) => this.at(ms).x);
    xs[xs.length - 1] = this.goal;
    return { startTime: this.releasedAt, times, xs, duration };
  }
}

/** Keyframes of one element following a glide, ready for `playWall`. */
export interface WallFrames {
  frames: Keyframe[];
  duration: number;
  /** document-timeline time the animation starts at (the glide's release) */
  startTime: number;
}

/**
 * One element's keyframes over a glide: `sample(x)` gives its keyframe at glide position x. Samples a
 * straight line through x can stand in for (within `tolerance` of x) are left out.
 */
export function springFrames(glide: WallGlide, sample: (x: number) => Keyframe, everyMs = SAMPLE_MS, tolerance = 0.002): WallFrames {
  const s = glide.samples(everyMs, tolerance);
  const keep = thin(s.times, [s.xs], [tolerance]);
  return { frames: keyframesAt(s.times, keep, (i) => sample(s.xs[i] ?? glide.target)), duration: s.duration, startTime: s.startTime };
}

/**
 * Plays wall-time keyframes on `el`, started at document-timeline time `startTime` (an animation started
 * a moment ago joins where it should be). Before its start it shows the first frame; after its end,
 * the element's own style, which should be the last frame.
 */
export function playWall(el: Element, wall: WallFrames): Animation | null {
  if (typeof (el as HTMLElement).animate !== "function" || wall.frames.length === 0 || !(wall.duration > 0)) return null;
  const anim = (el as HTMLElement).animate(wall.frames, { duration: wall.duration, fill: "backwards", easing: "linear" });
  try {
    anim.startTime = wall.startTime;
  } catch {
    // an engine without settable start times starts it now
  }
  return anim;
}
