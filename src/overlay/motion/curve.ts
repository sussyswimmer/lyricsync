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
  if (n === 0) return () => 0;
  const xs = keys.map((k) => k[0]);
  const ys = keys.map((k) => k[1]);
  // Every index read below is in range (0..n-1), so read without the undefined fallbacks that
  // noUncheckedIndexedAccess would otherwise ask for at each one.
  const X = (i: number): number => xs[i] as number;
  const Y = (i: number): number => ys[i] as number;
  const first = X(0);
  const last = X(n - 1);
  const y0 = Y(0);
  const yn = Y(n - 1);
  if (n === 1) return () => y0;
  // second derivatives with natural ends (zero curvature), by the tridiagonal (Thomas) solve; two
  // keys need none (a straight line)
  const m = new Array<number>(n).fill(0);
  const M = (i: number): number => m[i] as number;
  if (n > 2) {
    const c = new Array<number>(n).fill(0);
    const d = new Array<number>(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      const h0 = X(i) - X(i - 1);
      const h1 = X(i + 1) - X(i);
      const rhs = 6 * ((Y(i + 1) - Y(i)) / h1 - (Y(i) - Y(i - 1)) / h0);
      const diag = 2 * (h0 + h1) - h0 * (c[i - 1] as number);
      c[i] = h1 / diag;
      d[i] = (rhs - h0 * (d[i - 1] as number)) / diag;
    }
    for (let i = n - 2; i >= 1; i--) m[i] = (d[i] as number) - (c[i] as number) * M(i + 1);
  }
  return (x: number): number => {
    if (x <= first) return y0;
    if (x >= last) return yn;
    let i = 0;
    while (i < n - 2 && x > X(i + 1)) i++;
    const x0 = X(i);
    const h = X(i + 1) - x0;
    const a = (X(i + 1) - x) / h;
    const b = (x - x0) / h;
    return a * Y(i) + b * Y(i + 1) + (((a * a * a - a) * M(i) + (b * b * b - b) * M(i + 1)) * h * h) / 6;
  };
}

export const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);

/** Fast start, slowing to a stop: how an emphasized word's letters light one after another. */
export const sineOut = (x: number): number => Math.sin((clamp01(x) * Math.PI) / 2);

/** Its inverse: the progress at which sineOut reaches `y`. */
export const sineOutInverse = (y: number): number => (Math.asin(clamp01(y)) * 2) / Math.PI;
