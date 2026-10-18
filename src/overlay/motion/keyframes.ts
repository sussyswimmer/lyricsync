/**
 * Sampled motion to Web Animations keyframes. A track is sampled at a fixed rate, then thinned to the
 * points a straight line between neighbors can't stand in for, so a spring that has settled costs two
 * keyframes, not two hundred.
 */

/** Sample spacing for motion handed to the compositor, ms (it interpolates linearly in between). */
export const SAMPLE_MS = 1000 / 60;

/**
 * Indices of the samples to keep so that linear interpolation between kept samples stays within
 * `tolerance[c]` of every channel `c` (Ramer-Douglas-Peucker, error scaled per channel). The first
 * and last samples are always kept.
 */
export function thin(times: readonly number[], channels: readonly (readonly number[])[], tolerance: readonly number[]): number[] {
  const n = times.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number];
    if (b - a < 2) continue;
    const ta = times[a] ?? 0;
    const span = (times[b] ?? 0) - ta;
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const k = span > 0 ? ((times[i] ?? 0) - ta) / span : 0;
      let err = 0;
      channels.forEach((ch, c) => {
        const va = ch[a] ?? 0;
        const line = va + ((ch[b] ?? 0) - va) * k;
        const e = Math.abs((ch[i] ?? 0) - line) / Math.max(1e-9, tolerance[c] ?? 1e-3);
        if (e > err) err = e;
      });
      if (err > worst) {
        worst = err;
        at = i;
      }
    }
    if (worst > 1 && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** Sample times 0, every, 2·every, ..., duration (the last one exactly at the end). */
export function sampleTimes(durationMs: number, everyMs = SAMPLE_MS): number[] {
  const count = Math.max(1, Math.ceil(durationMs / everyMs - 1e-9));
  return Array.from({ length: count + 1 }, (_, i) => Math.min(durationMs, i * everyMs));
}

/**
 * Keyframes for the kept samples: `frame(i)` builds sample i's properties, `offset` places it at
 * times[i] / duration.
 */
export function keyframesAt(times: readonly number[], keep: readonly number[], frame: (i: number) => Keyframe): Keyframe[] {
  const duration = times[times.length - 1] ?? 0;
  return keep.map((i) => ({ ...frame(i), offset: duration > 0 ? Math.min(1, (times[i] ?? 0) / duration) : 0 }));
}

/** A number for CSS with at most `digits` decimals and no trailing zeros ("-0" becomes "0"). */
export function num(v: number, digits = 3): string {
  const s = v.toFixed(digits);
  const t = s.includes(".") ? s.replace(/\.?0+$/u, "") : s;
  return t === "-0" ? "0" : t;
}

/** translate(x, y) scale(s): one function list for every keyframe, so engines interpolate it piecewise without matrices. */
export function liftScale(x: number, y: number, s: number): string {
  return `translate(${num(x, 2)}px, ${num(y, 2)}px) scale(${num(s, 4)})`;
}
