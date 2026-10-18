/** Target curves: smooth paths through a few keys over a word's progress, and the easings the engine uses. */

/** A key: at progress `at` (0..1) the curve passes through `value`. */
export type Key = readonly [at: number, value: number];

/**
 * A natural cubic spline through `keys` (sorted by `at`), held flat outside them. Unlike a monotone
 * curve it swings past a key on the way to a sharp turn, which is what gives a word its overshoot: a
 * lift keyed to 1.7 % of the font size at 90 % of the word peaks near 3 % around 60 %.
 */
export function spline(keys: readonly Key[]): (x: number) => number {
  const n = keys.length;
  const xs = keys.map((k) => k[0]);
  const ys = keys.map((k) => k[1]);
  if (n === 0) return () => 0;
  if (n === 1) return () => ys[0] ?? 0;
  // second derivatives with natural ends (zero curvature), by the tridiagonal (Thomas) solve
  const m = new Array<number>(n).fill(0);
  if (n > 2) {
    const c = new Array<number>(n).fill(0);
    const d = new Array<number>(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      const h0 = (xs[i] ?? 0) - (xs[i - 1] ?? 0);
      const h1 = (xs[i + 1] ?? 0) - (xs[i] ?? 0);
      const rhs = 6 * (((ys[i + 1] ?? 0) - (ys[i] ?? 0)) / h1 - ((ys[i] ?? 0) - (ys[i - 1] ?? 0)) / h0);
      const diag = 2 * (h0 + h1) - h0 * (c[i - 1] ?? 0);
      c[i] = h1 / diag;
      d[i] = (rhs - h0 * (d[i - 1] ?? 0)) / diag;
    }
    for (let i = n - 2; i >= 1; i--) m[i] = (d[i] ?? 0) - (c[i] ?? 0) * (m[i + 1] ?? 0);
  }
  return (x: number): number => {
    if (x <= (xs[0] ?? 0)) return ys[0] ?? 0;
    if (x >= (xs[n - 1] ?? 0)) return ys[n - 1] ?? 0;
    let i = 0;
    while (i < n - 2 && x > (xs[i + 1] ?? 0)) i++;
    const x0 = xs[i] ?? 0;
    const h = (xs[i + 1] ?? 0) - x0;
    const a = ((xs[i + 1] ?? 0) - x) / h;
    const b = (x - x0) / h;
    const m0 = m[i] ?? 0;
    const m1 = m[i + 1] ?? 0;
    return a * (ys[i] ?? 0) + b * (ys[i + 1] ?? 0) + (((a * a * a - a) * m0 + (b * b * b - b) * m1) * h * h) / 6;
  };
}

export const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);

/** Fast start, slowing to a stop: how an emphasized word's letters light one after another. */
export const sineOut = (x: number): number => Math.sin((clamp01(x) * Math.PI) / 2);

/** Its inverse: the progress at which sineOut reaches `y`. */
export const sineOutInverse = (y: number): number => (Math.asin(clamp01(y)) * 2) / Math.PI;
