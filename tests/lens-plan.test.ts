import { describe, expect, it } from "vitest";
import type { Word } from "../src/core/lrc";
import {
  fitRow,
  LENS_SPRING,
  lowScale,
  OPACITY_MIN,
  planLens,
  poseOf,
  pull,
  RAMP_MS,
  rampAt,
  ROW_FIT,
  SCALE_MAX,
  singingAt,
  smallestScale,
  zoomAt,
  type LensInput,
  type LensPlan,
  type Shape,
} from "../src/overlay/modes/lens-plan";
import { PLAN_MS, type Track } from "../src/overlay/motion/karaoke";
import { HOLD, STEP_MS } from "../src/overlay/motion/keyframes";
import { valuesAt } from "./fake-motion";

const SIZE = 58;
const WIDTH = 1920;

/** A row of `n` words, each `width` px wide at the base size, a space of `space` px between them, in visual `order`. */
function row(n: number, width: number, space = SIZE * 0.25, order = Array.from({ length: n }, (_, j) => j)): Shape {
  return {
    widths: new Array<number>(n).fill(width),
    order,
    gaps: Array.from({ length: n }, (_, v) => (v < n - 1 ? space : 0)),
  };
}

/** `n` words of `ms` each, the first at `start`, `gap` ms apart. */
function words(n: number, start = 1000, ms = 450, gap = 50): Pick<Word, "start" | "end">[] {
  return Array.from({ length: n }, (_, j) => ({ start: start + j * (ms + gap), end: start + j * (ms + gap) + ms }));
}

function plan(over: Partial<LensInput> = {}): LensPlan {
  const ws = over.words ?? words(6);
  const shape = over.shape ?? row(ws.length, SIZE * 2.6);
  const fit = over.fit ?? fitRow(shape, SIZE, WIDTH, over.motion ?? true);
  const last = ws[ws.length - 1]?.end ?? 0;
  return planLens({ words: ws, shape, fit, width: WIDTH, y: 400, dpr: 1, origin: 700, end: last + 1300, rampFrom: ws[0]?.start ?? null, motion: true, ...over });
}

/** What a track draws at song time `t` (linear between keyframes, as the compositor does). */
function drawn(track: Track | undefined, t: number): { x: number; y: number; s: number; o: number } {
  if (!track) return { x: Number.NaN, y: Number.NaN, s: Number.NaN, o: Number.NaN };
  const p = Math.min(1, Math.max(0, (t - track.t0) / track.duration));
  const v = valuesAt(track.frames, p);
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\((-?[\d.]+)\)/u.exec(v["transform"] ?? "");
  return { x: Number(m?.[1]), y: Number(m?.[2]), s: Number(m?.[3]), o: Number(v["opacity"]) };
}

const times = (from: number, to: number, every: number): number[] => Array.from({ length: Math.floor((to - from) / every) + 1 }, (_, i) => from + i * every);

describe("Lens plan: the fisheye as tracks", () => {
  it("gives one track per word over the line's window, ending on the pose it rests at", () => {
    const p = plan();
    expect(p.tracks).toHaveLength(6);
    for (const [j, track] of p.tracks.entries()) {
      expect(track.t0).toBe(700);
      expect(track.duration).toBe(p.end - 700);
      const offsets = track.frames.map((f) => f.offset as number);
      expect(offsets[0]).toBe(0);
      expect(offsets[offsets.length - 1]).toBe(1);
      for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1] ?? 0);
      // every keyframe the same function list, the word's baseline on the line's
      for (const f of track.frames) expect(String(f.transform)).toMatch(/^translate\(-?[\d.]+px, 400px\) scale\([\d.]+\)$/u);
      const end = drawn(track, p.end);
      expect(end.x).toBeCloseTo(p.final.x[j] ?? 0, 1);
      expect(end.s).toBeCloseTo(p.final.scale[j] ?? 0, 3);
      expect(end.o).toBeCloseTo(p.final.opacity[j] ?? 0, 2);
    }
  });

  it("keeps every word's track continuous: no jumps anywhere in the window, and thinned well below its samples", () => {
    const p = plan();
    for (const track of p.tracks) {
      let last = drawn(track, 700);
      for (const t of times(701, p.end, 1)) {
        const now = drawn(track, t);
        expect(Math.abs(now.x - last.x), `x at ${t}`).toBeLessThan(4);
        expect(Math.abs(now.s - last.s), `scale at ${t}`).toBeLessThan(0.01);
        expect(Math.abs(now.o - last.o), `opacity at ${t}`).toBeLessThan(0.01);
        last = now;
      }
      // nothing moves before the first word: that stretch costs no keyframes of its own
      const before = track.frames.filter((f) => (f.offset as number) > 0 && (f.offset as number) * track.duration + track.t0 < 1000);
      expect(before.length).toBeLessThanOrEqual(1);
      expect(track.frames.length).toBeLessThan((p.end - 700) / PLAN_MS);
    }
  }, 30_000); // samples every track of a long window: well past the 5 s default on a loaded machine

  it("agrees with its own pose at any time (what a line leaving focus holds)", () => {
    const p = plan();
    for (const t of times(700, p.end, 97)) {
      const pose = p.at(t);
      p.tracks.forEach((track, j) => {
        const d = drawn(track, t);
        expect(d.x, `word ${j} at ${t}`).toBeCloseTo(pose.x[j] ?? 0, 0);
        expect(Math.abs(d.s - (pose.scale[j] ?? 0)), `word ${j} at ${t}`).toBeLessThan(0.004);
      });
    }
    // held at the window's ends
    expect(p.at(0)).toEqual(p.at(700));
    expect(p.at(p.end + 5000)).toEqual(p.final);
  });

  it("peaks on the word being sung, a little behind the voice, and fades the far ones", () => {
    const ws = words(7, 1000, 600, 0);
    const p = plan({ words: ws, shape: row(7, SIZE * 2.4) });
    ws.forEach((w, j) => {
      // the middle of the word, the lens's spring caught up
      const t = (w.start + w.end) / 2 + 80;
      if (t < 1000 + RAMP_MS) return;
      const scales = p.tracks.map((track) => drawn(track, t).s);
      expect(scales.indexOf(Math.max(...scales)), `at ${t}`).toBe(j);
      const opacity = p.tracks.map((track) => drawn(track, t).o);
      expect(opacity[j]).toBeGreaterThan(0.97);
      const far = j < 3 ? 6 : 0;
      expect(opacity[far]).toBeLessThan(0.65);
      expect(opacity[far]).toBeGreaterThanOrEqual(OPACITY_MIN - 1e-9);
    });
    // the spring: just after a word starts, the peak still sits between it and the one before
    const at = (ws[3]?.start ?? 0) + 30;
    const pose = p.at(at);
    expect(pose.scale[2] ?? 0).toBeGreaterThan((pose.scale[4] ?? 0) + 0.2);
  });

  it("keeps the row within ROW_FIT of the stage and centered, at every sample, for short and long lines", () => {
    for (const [n, w] of [
      [3, SIZE * 2.6],
      [8, SIZE * 2.6],
      [16, SIZE * 2.6],
      [34, SIZE * 2.6],
      [12, SIZE * 4],
    ] as const) {
      const ws = words(n, 1000, 300, 0);
      const shape = row(n, w);
      const p = plan({ words: ws, shape });
      for (const t of times(700, p.end, PLAN_MS)) {
        const pose = p.at(t);
        const left = pose.x[0] ?? 0;
        const right = (pose.x[n - 1] ?? 0) + (pose.scale[n - 1] ?? 0) * w;
        // (a row at rest sits on whole pixels: a pixel of slack for that)
        expect(right - left, `${n} words at ${t}`).toBeLessThanOrEqual(ROW_FIT * WIDTH + 1);
        expect(Math.abs((left + right) / 2 - WIDTH / 2), `${n} words at ${t}`).toBeLessThan(1);
        // words never overlap
        for (let j = 1; j < n; j++) expect(pose.x[j] ?? 0).toBeGreaterThan((pose.x[j - 1] ?? 0) + (pose.scale[j - 1] ?? 0) * w - 1e-6);
      }
    }
  });

  it("eases a line that arrived waiting into the lens over RAMP_MS from its first word", () => {
    const p = plan();
    const spread = (t: number): number => {
      const s = p.tracks.map((track) => drawn(track, t).s);
      return Math.max(...s) - Math.min(...s);
    };
    // at rest until the first word: every word the same size, none faded
    for (const t of [700, 900, 1000]) {
      expect(spread(t)).toBeLessThan(1e-3);
      for (const track of p.tracks) expect(drawn(track, t).o).toBeCloseTo(1, 3);
    }
    const full = plan({ rampFrom: null });
    const fullSpread = (t: number): number => {
      const s = full.tracks.map((track) => drawn(track, t).s);
      return Math.max(...s) - Math.min(...s);
    };
    const half = spread(1000 + RAMP_MS / 2);
    expect(half).toBeGreaterThan(0.2 * fullSpread(1000 + RAMP_MS / 2));
    expect(half).toBeLessThan(fullSpread(1000 + RAMP_MS / 2) - 0.05);
    // in full from RAMP_MS on
    for (const t of [1000 + RAMP_MS, 1500, 2500]) expect(spread(t)).toBeCloseTo(fullSpread(t), 2);
    expect(rampAt(1000, 1000 + RAMP_MS)).toBe(1);
    expect(rampAt(1000, 900)).toBe(0);
    expect(rampAt(null, 0)).toBe(1);
  });

  it("has no lens without motion (reduced motion, plain lyrics): every word at rest, the row on whole pixels", () => {
    const ws = words(8);
    const shape = row(8, SIZE * 2.6);
    const fit = fitRow(shape, SIZE, WIDTH, false);
    const p = plan({ words: ws, shape, fit, motion: false, dpr: 2 });
    const zoom = zoomAt(fit, 0, WIDTH);
    for (const track of p.tracks) {
      expect(track.frames).toHaveLength(2);
      for (const t of times(700, p.end, 250)) {
        const d = drawn(track, t);
        expect(d.s).toBeCloseTo(zoom, 4);
        expect(d.o).toBe(1);
        expect(Math.abs(d.x * 2 - Math.round(d.x * 2))).toBeLessThan(1e-6);
      }
    }
  });

  it("lays right-to-left lines out in their visual order", () => {
    const ws = words(4, 1000, 500, 0);
    const shape = row(4, SIZE * 2, SIZE * 0.25, [3, 2, 1, 0]);
    const p = plan({ words: ws, shape });
    for (const t of times(700, p.end, 50)) {
      const pose = p.at(t);
      for (const [a, b] of [
        [3, 2],
        [2, 1],
        [1, 0],
      ] as const) {
        expect(pose.x[a] ?? 0, `at ${t}`).toBeLessThan(pose.x[b] ?? 0);
        expect((pose.x[a] ?? 0) + (pose.scale[a] ?? 0) * SIZE * 2, `at ${t}`).toBeLessThanOrEqual((pose.x[b] ?? 0) + 1e-6);
      }
    }
    // the lens still follows the words in reading order: the first word sung is the rightmost
    const first = p.at(1250 + 80);
    expect(first.scale.indexOf(Math.max(...first.scale))).toBe(0);
  });

  it("holds every pose to the next in the lite tier, and steps slow stretches on the beat with steps", () => {
    const lite = plan({ hold: true, origin: 712 });
    for (const track of lite.tracks) {
      expect(track.frames.every((f) => f.easing === HOLD)).toBe(true);
      // every pose but the first and the last starts on the shared song-time beat: at most 20 a second
      const at = track.frames.slice(1, -1).map((f) => track.t0 + (f.offset as number) * track.duration);
      for (const t of at) expect(Math.abs(t / STEP_MS - Math.round(t / STEP_MS)), `at ${t}`).toBeLessThan(1e-6);
      for (let i = 1; i < at.length; i++) expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBeGreaterThanOrEqual(STEP_MS - 1e-6);
      // and it lands on the plan's own pose there
      const t = at[Math.floor(at.length / 2)] ?? 0;
      const j = lite.tracks.indexOf(track);
      expect(drawn(track, t + 1).s).toBeCloseTo(lite.at(t).scale[j] ?? 0, 2);
    }
    // a long held word: slow stretches of the lens step on the shared beat
    const held = plan({ words: [{ start: 1000, end: 6000 }, { start: 6000, end: 6400 }], shape: row(2, SIZE * 3), steps: true });
    const easings = held.tracks.flatMap((track) => track.frames.map((f) => f.easing)).filter((e) => e !== undefined);
    expect(easings.some((e) => e === HOLD || /^steps\(/u.test(String(e)))).toBe(true);
  });
});

describe("Lens plan: geometry", () => {
  it("pulls hardest on the word under the singing position", () => {
    expect(pull(2, 2.5)).toBe(1);
    expect(pull(0, 2.5)).toBeLessThan(pull(1, 2.5));
    expect(pull(4, 2.5)).toBeCloseTo(pull(0, 2.5), 12);
  });

  it("finds the singing position: before the first word, inside a word, in a gap, after the last", () => {
    const ws = words(3, 1000, 400, 100);
    expect(singingAt(ws, 0)).toBe(0);
    expect(singingAt(ws, 1200)).toBeCloseTo(0.5, 9);
    // in the gap after word 0: at the start of word 1
    expect(singingAt(ws, 1450)).toBe(1);
    expect(singingAt(ws, 5000)).toBe(3);
  });

  it("raises the far words' floor on small text and finds the smallest a word is drawn", () => {
    expect(lowScale(58)).toBe(0.5);
    expect(lowScale(16)).toBeCloseTo(11 / 16, 9);
    expect(lowScale(8)).toBe(0.85);
    const f = fitRow(row(16, SIZE * 2.6), SIZE, WIDTH, true);
    const smallest = smallestScale(f, WIDTH, true);
    expect(smallest).toBeCloseTo(f.low * Math.min(zoomAt(f, 0, WIDTH), zoomAt(f, 1, WIDTH)), 9);
    expect(smallestScale(f, WIDTH, false)).toBe(zoomAt(f, 0, WIDTH));
  });

  it("places a row at rest at the at-rest zoom, a lensed one around the singing position", () => {
    const shape = row(5, SIZE * 2.6);
    const f = fitRow(shape, SIZE, WIDTH, true);
    const rest = poseOf(shape, f, WIDTH, 1, 0, 0);
    for (const s of rest.scale) expect(s).toBeCloseTo(zoomAt(f, 0, WIDTH), 9);
    const lensed = poseOf(shape, f, WIDTH, 1, 1, 2.5);
    expect(Math.max(...lensed.scale)).toBeCloseTo(SCALE_MAX * zoomAt(f, 1, WIDTH), 9);
    expect(lensed.scale.indexOf(Math.max(...lensed.scale))).toBe(2);
    expect(LENS_SPRING.damping).toBe(1);
  });
});
