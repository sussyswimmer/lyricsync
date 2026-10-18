/**
 * Damped springs, solved in closed form. Everything that moves in the karaoke engine is a spring
 * chasing a target curve, simulated ahead of time and handed to the compositor as keyframes, so the
 * physics never runs per frame.
 */

/** A spring by its natural frequency in Hz and its damping ratio (1 = critical; below 1 overshoots). */
export interface SpringSpec {
  readonly hz: number;
  readonly damping: number;
}

/** Position and velocity (units per second). */
export interface SpringState {
  x: number;
  v: number;
}

/**
 * Where a spring is `dt` seconds later when its target holds still: the exact solution of
 * x'' = -ω²(x - target) - 2ζω·x', for under-, critically and over-damped springs alike.
 */
export function springStep(state: SpringState, target: number, dt: number, spec: SpringSpec): SpringState {
  const w = 2 * Math.PI * spec.hz;
  const z = spec.damping;
  if (!(dt > 0) || !(w > 0)) return { x: state.x, v: state.v };
  const x0 = state.x - target;
  const v0 = state.v;
  if (Math.abs(z - 1) < 1e-6) {
    // critically damped: (a + b·t)·e^(-ωt)
    const b = v0 + w * x0;
    const e = Math.exp(-w * dt);
    return { x: target + (x0 + b * dt) * e, v: (b - w * (x0 + b * dt)) * e };
  }
  if (z < 1) {
    // underdamped: e^(-ζωt)·(a·cos(ω_d t) + b·sin(ω_d t))
    const wd = w * Math.sqrt(1 - z * z);
    const b = (v0 + z * w * x0) / wd;
    const e = Math.exp(-z * w * dt);
    const c = Math.cos(wd * dt);
    const s = Math.sin(wd * dt);
    return {
      x: target + e * (x0 * c + b * s),
      v: e * (c * (b * wd - z * w * x0) - s * (x0 * wd + z * w * b)),
    };
  }
  // overdamped: two decaying exponentials
  const root = Math.sqrt(z * z - 1);
  const r1 = -w * (z - root);
  const r2 = -w * (z + root);
  const c2 = (v0 - r1 * x0) / (r2 - r1);
  const c1 = x0 - c2;
  const e1 = c1 * Math.exp(r1 * dt);
  const e2 = c2 * Math.exp(r2 * dt);
  return { x: target + e1 + e2, v: r1 * e1 + r2 * e2 };
}

/** Internal integration step, ms. The solution is exact per step; this only bounds how a moving target is followed. */
export const STEP_MS = 4;

/**
 * Follows `target(t)` (t in ms from 0) with a spring starting at `from`, and reports the position
 * every `everyMs` from 0 to `durationMs` inclusive.
 */
export function chase(target: (t: number) => number, spec: SpringSpec, from: SpringState, durationMs: number, everyMs: number): number[] {
  const out: number[] = [];
  let state: SpringState = { x: from.x, v: from.v };
  let t = 0;
  const count = Math.max(1, Math.ceil(durationMs / everyMs - 1e-9));
  out.push(state.x);
  for (let i = 1; i <= count; i++) {
    const until = Math.min(durationMs, i * everyMs);
    while (t < until - 1e-9) {
      const dt = Math.min(STEP_MS, until - t);
      // the target at the middle of the step: a zero-order hold that neither leads nor lags
      state = springStep(state, target(t + dt / 2), dt / 1000, spec);
      t += dt;
    }
    out.push(state.x);
  }
  return out;
}

/**
 * How long until a spring released from `offset` away from its target (at rest) stays within
 * `tolerance` of it, in ms: the envelope of its decay, so a safe upper bound.
 */
export function settleMs(spec: SpringSpec, offset: number, tolerance: number): number {
  const w = 2 * Math.PI * spec.hz;
  const z = spec.damping;
  const size = Math.abs(offset);
  if (size <= tolerance || !(w > 0)) return 0;
  // slowest decay rate of the envelope; overdamped springs creep at the slower root
  const rate = z < 1 ? z * w : w * (z - Math.sqrt(z * z - 1));
  // underdamped envelopes reach 1/sqrt(1 - ζ²) times the offset; critical ones (1 + ωt) a little more
  const peak = z < 1 ? 1 / Math.sqrt(1 - z * z) : 2;
  return (Math.log((size * peak) / tolerance) / rate) * 1000;
}

/** A spring released from (x, v) toward a fixed target: its exact position and velocity at any time. */
export class Glide {
  readonly from: SpringState;
  readonly target: number;
  readonly spec: SpringSpec;

  constructor(from: SpringState, target: number, spec: SpringSpec) {
    this.from = { x: from.x, v: from.v };
    this.target = target;
    this.spec = spec;
  }

  /** State `ms` after release (before release: where it started). */
  at(ms: number): SpringState {
    return springStep(this.from, this.target, Math.max(0, ms) / 1000, this.spec);
  }

  /** When it is within `tolerance` of its target for good, ms after release. */
  settle(tolerance: number): number {
    const speed = Math.abs(this.from.v) / (2 * Math.PI * this.spec.hz);
    return settleMs(this.spec, Math.abs(this.from.x - this.target) + speed, tolerance);
  }
}
