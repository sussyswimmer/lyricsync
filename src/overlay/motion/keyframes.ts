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

/**
 * Indices of the samples to keep for a track that holds each kept value until the next one (HOLD on
 * every keyframe): a sample is kept once some channel `c` has moved more than `quantum[c]` from the
 * last kept sample. The first and last samples are always kept, so where motion is slow it takes fewer,
 * larger steps, and where it has settled, none.
 */
export function holds(channels: readonly (readonly number[])[], quantum: readonly number[]): number[] {
  const n = Math.max(0, ...channels.map((c) => c.length));
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const out = [0];
  let last = 0;
  for (let i = 1; i < n - 1; i++) {
    const moved = channels.some((ch, c) => Math.abs((ch[i] ?? 0) - (ch[last] ?? 0)) > (quantum[c] ?? 0));
    if (moved) {
      out.push(i);
      last = i;
    }
  }
  out.push(n - 1);
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

// ---------- slow motion on a shared beat ----------

/**
 * The song-time beat that slow motion steps on, ms: 20 updates a second. The compositor draws a frame
 * whenever any animated value changes, so a held note whose wipe creeps a pixel at a time would
 * otherwise be redrawn at every vsync for changes no one can see.
 */
export const STEP_MS = 50;

/** Hold this keyframe's value until the next keyframe, then jump to it. */
export const HOLD = "steps(1, end)";

export interface Stepping {
  /** song time of the track's local 0, so that every track's beats fall on the same instants */
  t0: number;
  /** per channel: the most it may change in one STEP_MS for a stretch to step instead of glide */
  quantum: readonly number[];
}

/** A keyframe before it becomes CSS: local time (ms), channel values, and the easing to the next one. */
export interface KeyPoint {
  t: number;
  v: number[];
  easing?: string;
}

/**
 * The kept samples as key points, with the slow stretches moved onto the song-time beat.
 *
 * Between two kept samples the compositor interpolates linearly. Where that stretch changes less than
 * `quantum[c]` per STEP_MS in every channel, it instead holds still between beats (song times that are
 * multiples of STEP_MS) and steps on them, through the same values the straight line has there. Every
 * track's beats are the same instants, so once everything on screen is slow (a held note, a breathing
 * break) the compositor draws 20 frames a second instead of 60, and none at all where nothing changes.
 * Fast stretches stay linear and smooth. With `stepping` null this is keyframesAt's points.
 */
export function keyPoints(times: readonly number[], keep: readonly number[], channels: readonly (readonly number[])[], stepping: Stepping | null): KeyPoint[] {
  const pts = keep.map((i) => ({ t: times[i] ?? 0, v: channels.map((c) => c[i] ?? 0) }));
  if (!stepping || pts.length < 2) return pts;
  const { t0, quantum } = stepping;
  const slow = pts.slice(1).map((b, k) => {
    const a = pts[k] as KeyPoint;
    const dt = b.t - a.t;
    if (!(dt > 0)) return false;
    let moves = false;
    for (let c = 0; c < channels.length; c++) {
      const d = Math.abs((b.v[c] ?? 0) - (a.v[c] ?? 0));
      if (d > 1e-9) moves = true;
      if ((d / dt) * STEP_MS > (quantum[c] ?? 0)) return false;
    }
    return moves;
  });
  const out: KeyPoint[] = [];
  const lerp = (a: KeyPoint, b: KeyPoint, t: number): number[] => a.v.map((x, c) => x + ((b.v[c] ?? x) - x) * ((t - a.t) / (b.t - a.t)));
  const first = pts[0] as KeyPoint;
  out.push(slow[0] ? { ...first, easing: HOLD } : first);
  for (let k = 0; k < slow.length; k++) {
    const a = pts[k] as KeyPoint;
    const b = pts[k + 1] as KeyPoint;
    const next = slow[k + 1] === true;
    if (!slow[k]) {
      out.push(next ? { ...b, easing: HOLD } : { ...b });
      continue;
    }
    // The beats after a, up to b: one run of steps along the line from a to b. Into a fast stretch
    // (or the end) b itself follows, so the fast stretch starts where it should, and stands in for a
    // last beat that falls on it; into another slow stretch nothing does: its first beat takes over.
    const lo = Math.floor((t0 + a.t) / STEP_MS + 1e-9) + 1;
    const hi = Math.floor((t0 + b.t) / STEP_MS + 1e-9);
    if (hi >= lo) {
      const ga = lo * STEP_MS - t0;
      const gb = hi * STEP_MS - t0;
      const onB = !next && Math.abs(gb - b.t) < 1e-6;
      if (hi > lo) {
        out.push({ t: ga, v: lerp(a, b, ga), easing: `steps(${hi - lo}, end)` });
        if (!onB) out.push({ t: gb, v: lerp(a, b, gb), easing: HOLD });
      } else if (!onB) out.push({ t: ga, v: lerp(a, b, ga), easing: HOLD });
    }
    if (!next) out.push({ ...b });
  }
  return out;
}

/** Keyframes for key points of a track `duration` ms long; `frame` builds one from channel values. */
export function framesOf(points: readonly KeyPoint[], duration: number, frame: (v: readonly number[]) => Keyframe): Keyframe[] {
  return points.map((p) => {
    const f: Keyframe = { ...frame(p.v), offset: duration > 0 ? Math.min(1, Math.max(0, p.t / duration)) : 0 };
    if (p.easing) f.easing = p.easing;
    return f;
  });
}

/**
 * Whether stepped keyframes still run on the compositor here. Chromium's (WebView2, Chrome) does; WebKit
 * gives Core Animation only linear and cubic-bezier keyframes and would run a stepped animation on the
 * main thread instead, so there every stretch stays linear.
 */
export function compositorSteps(): boolean {
  const ua = typeof navigator === "undefined" ? "" : String(navigator.userAgent ?? "");
  // Chrome/, Chromium/, HeadlessChrome/ (Edge and WebView2 say Chrome/ too); Chrome on iOS is WebKit and says CriOS/
  return /Chrom(?:e|ium)\/\d/u.test(ua);
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
