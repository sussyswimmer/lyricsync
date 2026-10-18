import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLrc, type Line, type Word } from "../src/core/lrc";
import { lineLevel, placeSlots, stackOffsets } from "../src/overlay/modes/drift";
import { bloomLayers, bloomShadow, dotBloom } from "../src/overlay/motion/bloom";
import { clamp01, sineOut, sineOutInverse, spline, type Key } from "../src/overlay/motion/curve";
import { InterludeDots } from "../src/overlay/motion/dots";
import { findInterludes, interludeAt, INTERLUDE_AFTER_MS, planDots } from "../src/overlay/motion/interlude";
import {
  emphasized,
  FEATHER,
  FULL_TRANSFORM,
  heldParts,
  letterRest,
  OVERHANG,
  partsOf,
  planWord,
  rebase,
  restTransform,
  wipeEdge,
  wordUntil,
  type Track,
  type WordShape,
  type WordTiming,
} from "../src/overlay/motion/karaoke";
import {
  compositorSteps,
  framesOf,
  HOLD,
  keyframesAt,
  keyPoints,
  liftScale,
  num,
  sampleTimes,
  SAMPLE_MS,
  STEP_MS,
  thin,
} from "../src/overlay/motion/keyframes";
import { cased, casedLines, graphemes, isRtl, measureLetters, resetMeasure, roughMeasure, splittable, type Measure } from "../src/overlay/motion/letters";
import { KaraokeLine, SETTLE_IN_MS, type LetterPlacer } from "../src/overlay/motion/line";
import {
  A_MAX,
  BL_EMPHASIS,
  BL_INPUT,
  BL_REFERENCE,
  bloomOf,
  DOTS,
  glowGain,
  LEAD_MS,
  motionParams,
  paramsKey,
  SCROLL_SPRING,
  type EmphasisRule,
  type MotionInput,
} from "../src/overlay/motion/params";
import { detectPower, forcedPower, isSoftwareRenderer, probePower, resetPower } from "../src/overlay/motion/power";
import { focusAt, leadTimes, untilNext } from "../src/overlay/motion/schedule";
import { playWall, springFrames, WallGlide } from "../src/overlay/motion/scroll";
import { chase, Glide, settleMs, springStep, type SpringSpec } from "../src/overlay/motion/spring";
import { DEAD_ZONE_MS, JUMP_MS, SongTimeline } from "../src/overlay/motion/timeline";
import { FakeAnimation, FakeAnimationHost, fakeContext2d, valuesAt, withCanvas } from "./fake-motion";
import paperLanterns from "./fixtures/paper-lanterns.lrc?raw";

const BOUNCY: SpringSpec = { hz: 1.25, damping: 0.4 };
/** Beautiful Lyrics' own motion (A = 1), and the default look's (energy 0.45: A = 1.5). */
const BL = motionParams(BL_INPUT);
const HOUSE = motionParams({ ...BL_INPUT, energy: 0.45 });
const params = (over: Partial<MotionInput>) => motionParams({ ...BL_INPUT, ...over });

/** Final keyframe value of a numeric CSS property, or of the y in translate(x, y). */
const lastOpacity = (frames: Keyframe[]): number => Number(frames[frames.length - 1]?.opacity);
const firstOpacity = (frames: Keyframe[]): number => Number(frames[0]?.opacity);
const yOfFrame = (f: Keyframe | undefined): number => Number(/translate\([-\d.]+px, (-?[\d.]+)px\)/u.exec(String(f?.transform))?.[1]);
const scaleOfFrame = (f: Keyframe | undefined): number => Number(/scale\(([\d.]+)\)/u.exec(String(f?.transform))?.[1]);
const xOfFrame = (f: Keyframe | undefined): number => Number(/translateX\((-?[\d.]+)px\)/u.exec(String(f?.transform))?.[1]);
const opacityOf = (f: Keyframe): number => Number(f.opacity);

/**
 * A track's value at song time `t` the way an engine evaluates it: linear between keyframes, or in
 * steps(n, end) where a keyframe's easing says so; held at either end.
 */
function valueAt(track: Track, t: number, read: (f: Keyframe) => number): number {
  const fr = track.frames;
  const first = fr[0];
  const last = fr[fr.length - 1];
  if (!first || !last) return Number.NaN;
  const local = track.duration > 0 ? (t - track.t0) / track.duration : 1;
  if (local <= Number(first.offset)) return read(first);
  for (let i = 0; i + 1 < fr.length; i++) {
    const a = fr[i] as Keyframe;
    const b = fr[i + 1] as Keyframe;
    const oa = Number(a.offset);
    const ob = Number(b.offset);
    if (local >= ob) continue;
    let p = ob > oa ? (local - oa) / (ob - oa) : 1;
    const steps = /^steps\((\d+), end\)$/u.exec(String(a.easing ?? ""));
    if (steps) p = Math.floor(p * Number(steps[1]) + 1e-9) / Number(steps[1]);
    return read(a) + (read(b) - read(a)) * p;
  }
  return read(last);
}

/** Song times (on a 60 Hz frame clock over [from, to)) at which any of the tracks shows a new value. */
function changeFrames(tracks: { track: Track; read: (f: Keyframe) => number }[], from: number, to: number): number[] {
  const out: number[] = [];
  let prev: number[] | null = null;
  for (let t = from; t < to; t += 1000 / 60) {
    const now = tracks.map(({ track, read }) => valueAt(track, t, read));
    if (prev && now.some((v, i) => Math.abs(v - (prev?.[i] ?? v)) > 1e-9)) out.push(t);
    prev = now;
  }
  return out;
}

describe("springs", () => {
  it("reach their target, underdamped ones overshooting it and critical or overdamped ones not", () => {
    for (const damping of [0.4, 1, 1.6]) {
      const path = chase(() => 1, { hz: 2, damping }, { x: 0, v: 0 }, 4000, 10);
      expect(path[0]).toBe(0);
      expect(path[path.length - 1]).toBeCloseTo(1, 4);
      const peak = Math.max(...path);
      if (damping < 1) expect(peak).toBeGreaterThan(1.1);
      else expect(peak).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("step exactly: two half steps land where one whole step does", () => {
    for (const damping of [0.4, 1, 1.6]) {
      const spec = { hz: 1.7, damping };
      const once = springStep({ x: 0.3, v: -2 }, 1, 0.1, spec);
      const twice = springStep(springStep({ x: 0.3, v: -2 }, 1, 0.05, spec), 1, 0.05, spec);
      expect(twice.x).toBeCloseTo(once.x, 10);
      expect(twice.v).toBeCloseTo(once.v, 10);
    }
    expect(springStep({ x: 2, v: 3 }, 0, 0, BOUNCY)).toEqual({ x: 2, v: 3 });
  });

  it("sample once per step, ending exactly at the duration", () => {
    expect(chase(() => 0, BOUNCY, { x: 0, v: 0 }, 1000, SAMPLE_MS)).toHaveLength(61);
    expect(sampleTimes(1000)).toHaveLength(61);
    expect(sampleTimes(1000)[60]).toBe(1000);
  });

  it("settle within the bound settleMs gives", () => {
    for (const spec of [BOUNCY, { hz: 0.7, damping: 0.6 }, { hz: 3, damping: 1 }, { hz: 1, damping: 2 }]) {
      const ms = settleMs(spec, 1, 0.001);
      const path = chase(() => 0, spec, { x: 1, v: 0 }, ms + 2000, 5);
      const after = path.slice(Math.ceil(ms / 5));
      expect(Math.max(...after.map(Math.abs))).toBeLessThanOrEqual(0.001);
    }
    expect(settleMs(BOUNCY, 0.0001, 0.001)).toBe(0);
  });

  it("glide from any state, continuing where a previous glide was", () => {
    const first = new Glide({ x: 0, v: 0 }, 1, BOUNCY);
    const mid = first.at(180);
    const second = new Glide(mid, 2, BOUNCY);
    expect(second.at(0)).toEqual(mid);
    expect(second.at(second.settle(0.001)).x).toBeCloseTo(2, 2);
    expect(first.at(-50)).toEqual({ x: 0, v: 0 });
  });
});

describe("curves", () => {
  it("pass through their keys and hold flat outside them", () => {
    const f = spline([
      [0, 0.95],
      [0.7, 1.025],
      [1, 1],
    ]);
    expect(f(0)).toBeCloseTo(0.95, 9);
    expect(f(0.7)).toBeCloseTo(1.025, 9);
    expect(f(1)).toBeCloseTo(1, 9);
    expect(f(-1)).toBe(0.95);
    expect(f(2)).toBe(1);
    expect(spline([])(0.5)).toBe(0);
    expect(spline([[0.5, 3]])(0.1)).toBe(3);
    expect(spline([[0.5, 3]])(0.9)).toBe(3);
  });

  it("run straight between two keys, and through every one of many", () => {
    const line = spline([
      [0.2, 1],
      [0.6, 3],
    ]);
    expect(line(0.4)).toBeCloseTo(2, 12);
    expect(line(0.3)).toBeCloseTo(1.5, 12);
    expect(line(0)).toBe(1);
    expect(line(1)).toBe(3);
    const keys: Key[] = [
      [0, 0],
      [0.25, 1],
      [0.5, 0],
      [0.75, -1],
      [1, 0],
    ];
    const wave = spline(keys);
    for (const [at, value] of keys) expect(wave(at)).toBeCloseTo(value, 9);
    // smooth through the middle keys: no kink where two pieces meet
    const slope = (x: number): number => (wave(x + 1e-6) - wave(x - 1e-6)) / 2e-6;
    expect(slope(0.5 - 1e-4)).toBeCloseTo(slope(0.5 + 1e-4), 2);
    expect(wave(0.125)).toBeGreaterThan(0);
    expect(wave(0.625)).toBeLessThan(0);
  });

  it("swing past a key before a sharp turn (the lift's overshoot: BL's -1.8 % key dips to about -4 %)", () => {
    const lift = spline(BL.liftKeys);
    const lowest = Math.min(...Array.from({ length: 101 }, (_, i) => lift(i / 100)));
    expect(lowest).toBeLessThan(-0.035);
    expect(lowest).toBeGreaterThan(-0.045);
    const scale = spline(BL.scaleKeys);
    expect(Math.max(...Array.from({ length: 101 }, (_, i) => scale(i / 100)))).toBeCloseTo(1.027, 2);
  });

  it("ease out fast, and invert", () => {
    expect(sineOut(0)).toBe(0);
    expect(sineOut(1)).toBeCloseTo(1, 12);
    expect(sineOut(0.5)).toBeGreaterThan(0.7);
    for (const y of [0, 0.25, 0.5, 0.9]) expect(sineOut(sineOutInverse(y))).toBeCloseTo(y, 9);
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(7)).toBe(1);
  });
});

describe("keyframes", () => {
  it("keep only the samples a straight line can't stand in for", () => {
    const times = [0, 1, 2, 3, 4, 5, 6];
    const line = times.map((t) => t * 2);
    expect(thin(times, [line], [0.01])).toEqual([0, 6]);
    const corner = [0, 1, 2, 3, 2, 1, 0];
    expect(thin(times, [corner], [0.01])).toEqual([0, 3, 6]);
    // the tolerance is per channel: a channel within its tolerance doesn't keep points
    expect(thin(times, [corner], [5])).toEqual([0, 6]);
    expect(thin([0, 1], [[1, 2]], [0.1])).toEqual([0, 1]);
  });

  it("place kept samples by their time", () => {
    const frames = keyframesAt([0, 50, 100], [0, 2], (i) => ({ opacity: i }));
    expect(frames).toEqual([
      { opacity: 0, offset: 0 },
      { opacity: 2, offset: 1 },
    ]);
  });

  it("stretch a track onto a line's shared window, holding still before and after it", () => {
    const track = { t0: 1200, duration: 400, frames: [{ opacity: 0, offset: 0 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 1 }] };
    expect(rebase(track, 1000, 2000)).toEqual([
      { opacity: 0, offset: 0 },
      { opacity: 0, offset: 0.2 },
      { opacity: 1, offset: 0.4 },
      { opacity: 0, offset: 0.6 },
      { opacity: 0, offset: 1 },
    ]);
    // a track starting with the window needs no hold before it; one ending with it none after
    expect(rebase({ t0: 1000, duration: 1000, frames: [{ opacity: 0 }, { opacity: 1 }] }, 1000, 2000)).toEqual([
      { opacity: 0, offset: 0 },
      { opacity: 1, offset: 1 },
    ]);
    // lead frames replace the hold: a word easing into its rest pose as its line comes into focus
    const lead = [
      { at: 1000, frame: { opacity: 0.5 } },
      { at: 1100, frame: { opacity: 0.2 } },
    ];
    expect(rebase(track, 1000, 2000, lead).slice(0, 3)).toEqual([
      { opacity: 0.5, offset: 0 },
      { opacity: 0.2, offset: 0.1 },
      { opacity: 0, offset: 0.2 },
    ]);
  });

  it("write short numbers and one transform function list", () => {
    expect(num(1.5)).toBe("1.5");
    expect(num(2)).toBe("2");
    expect(num(-0.0001)).toBe("0");
    expect(num(3.14159, 0)).toBe("3");
    expect(num(-0.4, 0)).toBe("0");
    expect(liftScale(0, -1.23456, 1.025)).toBe("translate(0px, -1.23px) scale(1.025)");
  });

  it("cope with samples at one instant, and with empty or instant tracks", () => {
    // samples all at one time: nothing to interpolate along, so every point that differs stays
    expect(thin([5, 5, 5], [[0, 9, 0]], [0.01])).toEqual([0, 1, 2]);
    expect(thin([5, 5, 5], [[0, 0, 0]], [0.01])).toEqual([0, 2]);
    expect(keyframesAt([], [], () => ({ opacity: 1 }))).toEqual([]);
    expect(keyframesAt([0], [0], () => ({ opacity: 1 }))).toEqual([{ opacity: 1, offset: 0 }]);
    expect(framesOf([{ t: 0, v: [1] }], 0, ([v]) => ({ opacity: v ?? 0 }))).toEqual([{ opacity: 1, offset: 0 }]);
  });
});

describe("slow motion on the beat", () => {
  const ramp = (from: number, to: number, ms: number, every = 10): { times: number[]; values: number[] } => {
    const times = sampleTimes(ms, every);
    return { times, values: times.map((t) => from + ((to - from) * t) / ms) };
  };
  const trackOf = (t0: number, times: number[], points: ReturnType<typeof keyPoints>): Track => {
    const duration = times[times.length - 1] ?? 0;
    return { t0, duration, frames: framesOf(points, duration, ([v]) => ({ opacity: v ?? 0 })) };
  };
  const read = (f: Keyframe): number => Number(f.opacity);
  /** A change shown on the frame at `t` came from a beat since the frame before. */
  const onBeat = (t: number): boolean => t - Math.floor((t + 1e-6) / STEP_MS) * STEP_MS < 1000 / 60 + 1e-6;

  it("are keyframesAt's points without stepping", () => {
    const { times, values } = ramp(0, 1, 100, 50);
    expect(keyPoints(times, [0, 2], [values], null)).toEqual([
      { t: 0, v: [0] },
      { t: 100, v: [1] },
    ]);
    const frames = framesOf(keyPoints(times, [0, 2], [values], null), 100, ([v]) => ({ opacity: v ?? 0 }));
    expect(frames).toEqual(keyframesAt(times, [0, 2], (i) => ({ opacity: values[i] ?? 0 })));
  });

  it("step a slow stretch on the song's beat, through the values the straight line has there", () => {
    // 0 to 10 over 2 s: a quarter per beat, under a quantum of 1
    const { times, values } = ramp(0, 10, 2000);
    const t0 = 1030;
    const points = keyPoints(times, thin(times, [values], [0.01]), [values], { t0, quantum: [1] });
    expect(points[0]?.easing).toBe(HOLD);
    const track = trackOf(t0, times, points);
    const changes = changeFrames([{ track, read }], t0, t0 + 2100);
    // every change but the last (the stretch's own end) shows on the first frame of a beat
    expect(changes.slice(0, -1).every(onBeat)).toBe(true);
    expect(changes.length).toBeLessThanOrEqual(2000 / STEP_MS + 1);
    // on each beat it shows the line's value there, and it never strays a step from the line
    for (let beat = 1050; beat <= 3000; beat += STEP_MS) expect(valueAt(track, beat, read)).toBeCloseTo(((beat - t0) / 2000) * 10, 9);
    for (let t = t0; t <= t0 + 2000; t += 7) expect(Math.abs(valueAt(track, t, read) - ((t - t0) / 2000) * 10)).toBeLessThanOrEqual(0.25 + 1e-9);
    expect(valueAt(track, t0 + 2000, read)).toBe(10);
  });

  it("leave fast stretches linear, joined to a slow one where the fast ones need them", () => {
    // a fast rise (25 per beat), a slow drift (0.1 per beat), a fast fall
    const times = [0, 200, 1200, 1400];
    const values = [0, 100, 102, 0];
    const points = keyPoints(times, [0, 1, 2, 3], [values], { t0: 0, quantum: [1] });
    expect(points.map((p) => p.t)).toEqual([0, 200, 250, 1200, 1400]);
    expect(points.map((p) => p.easing)).toEqual([undefined, HOLD, "steps(19, end)", undefined, undefined]);
    const track = trackOf(0, times, points);
    expect(valueAt(track, 100, read)).toBeCloseTo(50, 9);
    expect(valueAt(track, 1300, read)).toBeCloseTo(51, 9);
    expect(valueAt(track, 700, read)).toBeCloseTo(101, 9);
    expect(valueAt(track, 720, read)).toBeCloseTo(101, 9);
    // a stretch that doesn't move needs no steps
    expect(keyPoints([0, 1000], [0, 1], [[3, 3]], { t0: 0, quantum: [1] }).every((p) => p.easing === undefined)).toBe(true);
  });

  it("give every track the same beat, wherever it starts", () => {
    const a = ramp(0, 1, 3000);
    const b = ramp(5, 4, 3000);
    const ta = trackOf(1000, a.times, keyPoints(a.times, thin(a.times, [a.values], [0.001]), [a.values], { t0: 1000, quantum: [0.02] }));
    const tb = trackOf(1017, b.times, keyPoints(b.times, thin(b.times, [b.values], [0.001]), [b.values], { t0: 1017, quantum: [0.02] }));
    const one = changeFrames([{ track: ta, read }], 1100, 3900);
    expect(one.length).toBeGreaterThan(40);
    expect(changeFrames([{ track: ta, read }, { track: tb, read }], 1100, 3900)).toEqual(one);
  });

  it("let a held word redraw on the beat once it is slow, never far from its glide", () => {
    const shape = shapeOf("note", [{ text: "note" }]);
    const word = { start: 1900, end: 13_000 };
    const reads = (plan: ReturnType<typeof planWord>): { track: Track; read: (f: Keyframe) => number; tol: number }[] => [
      ...[plan.pop, ...plan.letters].flatMap((t) =>
        t
          ? [
              { track: t, read: yOfFrame, tol: 0.5 },
              { track: t, read: scaleOfFrame, tol: 0.006 },
            ]
          : [],
      ),
      ...(plan.window ? [{ track: plan.window, read: xOfFrame, tol: 1.2 }] : []),
      ...[plan.glow, ...plan.letterGlows].flatMap((t) => (t ? [{ track: t, read: opacityOf, tol: 0.04 }] : [])),
    ];
    const glide = reads(planWord(word, "note", shape, BL));
    const stepped = reads(planWord(word, "note", shape, BL, { steps: true }));
    expect(stepped).toHaveLength(glide.length);
    const smooth = changeFrames(glide, 5500, 11_500).length;
    const beat = changeFrames(stepped, 5500, 11_500).length;
    expect(beat).toBeLessThan(smooth * 0.7);
    for (let t = 1900; t < 14_500; t += 37) {
      glide.forEach((g, i) => {
        const s = stepped[i];
        if (s) expect(Math.abs(valueAt(g.track, t, g.read) - valueAt(s.track, t, s.read))).toBeLessThanOrEqual(g.tol + 1e-6);
      });
    }
  });

  it("put a break's breathing on the beat too", () => {
    const plan = planDots({ next: 2, start: 10_000, end: 16_000 }, 20, BL, true);
    const group = plan.group.transform as Track;
    const changes = changeFrames([{ track: group, read: (f) => scaleOfFrame(f) }], 11_000, 15_000);
    expect(changes.length).toBeGreaterThan(10);
    expect(changes.every(onBeat)).toBe(true);
  });

  it("only where the engine composites stepped keyframes", () => {
    const on = (userAgent: string): boolean => {
      vi.stubGlobal("navigator", { userAgent });
      try {
        return compositorSteps();
      } finally {
        vi.unstubAllGlobals();
      }
    };
    expect(on("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0")).toBe(true);
    expect(on("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36")).toBe(true);
    expect(on("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe(false);
    expect(on("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1")).toBe(false);
    // no navigator (a worker, a test), or one without a user agent: linear keyframes
    vi.stubGlobal("navigator", undefined);
    try {
      expect(compositorSteps()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
    vi.stubGlobal("navigator", {});
    try {
      expect(compositorSteps()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leave a stretch between two kept samples at one instant alone, and one with no beat in it linear", () => {
    // two kept samples at the same time: no stretch between them to step
    const same = keyPoints([0, 0, 100], [0, 1, 2], [[0, 1, 1.001]], { t0: 0, quantum: [1] });
    expect(same[0]).toEqual({ t: 0, v: [0] });
    expect(same[1]).toEqual({ t: 0, v: [1], easing: HOLD });
    expect(same.some((p) => p.t === 50 && p.easing === "steps(1, end)")).toBe(true);
    expect(same[same.length - 1]).toEqual({ t: 100, v: [1.001] });
    // a slow stretch from 10 to 40 ms holds no beat (they fall on 0 and 50): it simply ends at its sample
    const short = keyPoints([0, 10, 40], [0, 1, 2], [[0, 5, 5.001]], { t0: 0, quantum: [0.01] });
    expect(short).toEqual([
      { t: 0, v: [0] },
      { t: 10, v: [5], easing: HOLD },
      { t: 40, v: [5.001] },
    ]);
  });
});

describe("the motion's parameters", () => {
  it("are Beautiful Lyrics' own at A = 1: energy 0.3, snap 0.4, Effects 50", () => {
    const p = BL;
    const R = BL_REFERENCE;
    expect(p.amp).toBe(R.amp);
    expect(p.pace).toBeCloseTo(R.pace, 12);
    expect(p.restScale).toBeCloseTo(R.restScale, 12);
    expect(p.restLift).toBeCloseTo(R.restLift, 12);
    expect(p.scaleKeys[1]?.[1]).toBeCloseTo(R.scalePeak, 12);
    expect(p.liftKeys[1]?.[1]).toBeCloseTo(R.liftKey, 12);
    for (const [mine, ref] of [
      [p.liftSpring, R.liftSpring],
      [p.scaleSpring, R.scaleSpring],
      [p.glowSpring, R.glowSpring],
      [p.rippleSpring, R.rippleSpring],
      [p.letterGlowSpring, R.letterGlowSpring],
    ] as const) {
      expect(mine.hz).toBeCloseTo(ref.hz, 12);
      expect(mine.damping).toBeCloseTo(ref.damping, 12);
    }
    expect(p.rippleHeight).toBeCloseTo(R.rippleHeight, 12);
    expect(p.restLift * p.letterLiftGain).toBeCloseTo(R.letterRestLift, 12);
    expect((p.liftKeys[1]?.[1] ?? 0) * p.letterLiftGain).toBeCloseTo(R.letterLiftKey, 12);
    expect(p.letterScaleKeys[0]?.[1]).toBeCloseTo(R.letterRestScale, 12);
    expect(p.letterScaleKeys[1]?.[1]).toBeCloseTo(R.letterScalePeak, 12);
    expect(p.karaoke).toBe("full");
    expect(p.emphasis).toEqual(BL_EMPHASIS);
  });

  it("grow with the song's energy and with Effects: a typical song at Effects 50 moves half again as much as BL", () => {
    expect(HOUSE.amp).toBeCloseTo(1.5, 12);
    expect(params({ energy: 0.3, effects: 100 }).amp).toBeCloseTo(2, 12);
    expect(params({ energy: 0.3, effects: 25 }).amp).toBeCloseTo(0.5, 12);
    for (const key of ["energy", "effects"] as const) {
      let last = motionParams({ ...BL_INPUT, [key]: 0 });
      for (let i = 1; i <= 20; i++) {
        const p = motionParams({ ...BL_INPUT, [key]: key === "energy" ? i / 20 : i * 5 });
        expect(p.amp, `${key} ${i}`).toBeGreaterThanOrEqual(last.amp);
        expect(p.restScale).toBeLessThanOrEqual(last.restScale);
        expect(p.restLift).toBeGreaterThanOrEqual(last.restLift);
        expect(p.liftKeys[1]?.[1] ?? 0).toBeLessThanOrEqual(last.liftKeys[1]?.[1] ?? 0);
        expect(p.scaleKeys[1]?.[1] ?? 0).toBeGreaterThanOrEqual(last.scaleKeys[1]?.[1] ?? 0);
        expect(p.rippleHeight).toBeGreaterThanOrEqual(last.rippleHeight);
        expect(p.liftSpring.damping).toBeLessThanOrEqual(last.liftSpring.damping);
        last = p;
      }
    }
  });

  it("cap at 2.5 times BL, the ripple at 0.14 em, and keep the lift's spring from ringing", () => {
    const p = params({ energy: 1, effects: 100 });
    expect(p.amp).toBe(A_MAX);
    expect(p.rippleHeight).toBe(0.14);
    expect(p.liftSpring.damping).toBeCloseTo(0.32, 12);
    expect(p.restScale).toBeCloseTo(0.92, 12);
    expect(params({ energy: 1, effects: 1e6 }).amp).toBe(A_MAX);
  });

  it("hold every transform still at Effects 0, under reduced motion and in the lite tier", () => {
    for (const p of [params({ effects: 0 }), params({ motion: false }), params({ power: "lite" })]) {
      expect(p.amp).toBe(0);
      expect(p.rippleHeight).toBe(0);
      expect(p.restScale).toBe(1);
      expect(p.restLift).toBe(0);
      expect(p.liftKeys.every(([, v]) => v === 0)).toBe(true);
      expect(p.scaleKeys.every(([, v]) => v === 1)).toBe(true);
      expect(p.dotAmp).toBe(0);
    }
    // Effects 0 keeps the wipe and bloom; reduced motion and lite fade instead
    expect(params({ effects: 0 }).karaoke).toBe("full");
    expect(params({ motion: false }).karaoke).toBe("fade");
    expect(params({ power: "lite" }).karaoke).toBe("fade");
  });

  it("take the springs' pace from the song's snap", () => {
    expect(params({ snap: 0 }).pace).toBeCloseTo(0.8, 12);
    expect(params({ snap: 1 }).pace).toBeCloseTo(1.3, 12);
    expect(params({ snap: 1 }).liftSpring.hz).toBeCloseTo(1.3 * 1.3, 12);
    // out-of-range and missing numbers stay sane
    expect(params({ snap: Number.NaN }).pace).toBeCloseTo(1, 12);
    expect(params({ energy: -3 }).amp).toBe(0);
  });

  it("say when a re-plan is needed", () => {
    const base = paramsKey(HOUSE);
    expect(paramsKey(motionParams({ ...BL_INPUT, energy: 0.45 }))).toBe(base);
    for (const over of [{ energy: 0.6 }, { effects: 80 }, { snap: 0.9 }, { emphasis: null }, { motion: false }] as Partial<MotionInput>[]) {
      expect(paramsKey(motionParams({ ...BL_INPUT, energy: 0.45, ...over })), JSON.stringify(over)).not.toBe(base);
    }
  });
});

describe("the bloom", () => {
  const alphas = (shadow: string): number[] => [...shadow.matchAll(/rgba\([^)]*, ([\d.]+)\)/gu)].map((m) => Number(m[1]));
  const blurs = (shadow: string): number[] => [...shadow.matchAll(/0 0 ([\d.]+)em/gu)].map((m) => Number(m[1]));

  it("scales the song's glow by the Glow setting: a faint 0.3 at 0, as picked at 40, half again at 100", () => {
    expect(glowGain(0)).toBeCloseTo(0.3, 12);
    expect(glowGain(20)).toBeCloseTo(0.65, 12);
    expect(glowGain(40)).toBeCloseTo(1, 12);
    expect(glowGain(100)).toBeCloseTo(1.5, 12);
    expect(bloomOf(0.6, 40)).toBeCloseTo(0.6, 12);
    expect(bloomOf(0.3, 0)).toBeCloseTo(0.09, 12);
    expect(bloomOf(1, 100)).toBe(1.3);
  });

  it("is never off: a faint core and halo at Glow 0, wider and brighter as it grows", () => {
    expect(bloomShadow("#f5a524", 0)).not.toBe("none");
    expect(dotBloom("#f5a524", 0, 20)).not.toBe("none");
    const faint = bloomShadow("#f5a524", bloomOf(0.3, 0));
    const full = bloomShadow("#f5a524", 1);
    expect(alphas(faint)).toHaveLength(3);
    alphas(faint).forEach((a, i) => expect(a).toBeLessThan(alphas(full)[i] ?? 0));
    blurs(faint).forEach((b, i) => expect(b).toBeLessThan(blurs(full)[i] ?? 0));
    // at b = 1 the wide layer is 0.52 em, about 30 px at 58 px
    expect(blurs(full)[2]).toBeCloseTo(0.52, 3);
    const one = bloomLayers(1).flat();
    [0.07, 1, 0.23, 0.75, 0.52, 0.52].forEach((v, i) => expect(one[i]).toBeCloseTo(v, 12));
  });

  it("is stronger on a held syllable's letters: blurs a third wider, alphas a quarter brighter (at most 1)", () => {
    const plain = bloomLayers(0.6);
    const strong = bloomLayers(0.6, true);
    strong.forEach(([blur, alpha], i) => {
      expect(blur).toBeCloseTo((plain[i]?.[0] ?? 0) * 1.3, 12);
      expect(alpha).toBeCloseTo(Math.min(1, (plain[i]?.[1] ?? 0) * 1.25), 12);
    });
    expect(Math.max(...alphas(bloomShadow("#f5a524", 1.3, true)))).toBe(1);
    expect(dotBloom("#f5a524", 0.6, 20)).toMatch(/^0 0 6\.2px rgba\(245, 165, 36, /u);
  });

  it("takes a strength that isn't a number as none at all (the faint floor), and caps it at 1.3", () => {
    expect(bloomLayers(Number.NaN)).toEqual(bloomLayers(0));
    expect(bloomLayers(Number.POSITIVE_INFINITY)).toEqual(bloomLayers(0));
    expect(bloomLayers(5)).toEqual(bloomLayers(1.3));
    expect(dotBloom("#f5a524", Number.NaN, 20)).toBe(dotBloom("#f5a524", 0, 20));
    expect(dotBloom("#f5a524", 9, 20)).toBe(dotBloom("#f5a524", 1.3, 20));
    // a dot is never drawn smaller than a pixel across
    expect(dotBloom("#f5a524", 0.6, 0)).toBe(dotBloom("#f5a524", 0.6, 1));
  });
});

/** A measurer that kerns "AV" tighter, like a real font, and draws each character 10 px wide. */
const kerned: Measure = (text) => [...text].length * 10 - (text.includes("AV") ? 3 : 0);

function shapeOf(text: string, parts: { text: string }[], size = 58): WordShape {
  const { width, letters } = measureLetters(text, parts, roughMeasure(size));
  return { width, size, letters, rtl: isRtl(text) };
}

describe("letters", () => {
  it("keep a letter and its accents together", () => {
    expect(graphemes("Đấ")).toHaveLength(2);
    expect(graphemes("éx")).toEqual(["é", "x"]);
  });

  it("split only scripts whose letters stand alone", () => {
    expect(splittable("night")).toBe(true);
    expect(splittable("Người")).toBe(true);
    expect(splittable("灯笼")).toBe(true);
    expect(splittable("الضوء")).toBe(false);
    expect(splittable("האור")).toBe(false);
    expect(isRtl("האור")).toBe(true);
    expect(isRtl("night")).toBe(false);
  });

  it("sit where the whole word draws them, kerning included", () => {
    const { width, letters } = measureLetters("AVA", [{ text: "AVA" }], kerned);
    expect(width).toBe(27);
    // "V" starts where "AV" ends less its own advance: pulled in by the kerning
    expect(letters.map((l) => l.x)).toEqual([0, 7, 17]);
    expect(letters.map((l) => l.w)).toEqual([10, 10, 10]);
  });

  it("move one letter-spacing right per letter before them, the word growing one per gap", () => {
    const { width, letters } = measureLetters("AVA", [{ text: "AVA" }], kerned, 2);
    expect(width).toBe(27 + 2 * 2);
    expect(letters.map((l) => l.x)).toEqual([0, 9, 21]);
    expect(measureLetters("a", [{ text: "a" }], kerned, 5).width).toBe(10);
  });

  it("know their syllable, and a word that can't be split is one letter", () => {
    const { letters } = measureLetters("window", [{ text: "win" }, { text: "dow" }], kerned);
    expect(letters.map((l) => l.part)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(measureLetters("الضوء", [{ text: "الضوء" }], kerned).letters).toHaveLength(1);
    expect(measureLetters("a", [{ text: "a" }], kerned).letters).toEqual([{ text: "a", x: 0, w: 10, part: 0 }]);
  });

  it("come in the look's case, every syllable with them", () => {
    expect(cased("Đèn phố", "upper")).toBe("ĐÈN PHỐ");
    expect(cased("Hold on", "as-is")).toBe("Hold on");
    const [line] = casedLines(parseLrc("[00:01.00]<00:01.00>Count<00:01.30>ing <00:01.60>sheep", 5000), "upper");
    expect(line?.text).toBe("COUNTING SHEEP");
    expect(line?.words[0]?.text).toBe("COUNTING ");
    expect(line?.words[0]?.parts?.map((p) => p.text)).toEqual(["COUNT", "ING "]);
    expect(measureLetters("COUNTING", line?.words[0]?.parts ?? [], kerned).letters.map((l) => l.part)).toEqual([0, 0, 0, 0, 0, 1, 1, 1]);
    const lines = parseLrc("[00:01.00]as written", 5000);
    expect(casedLines(lines, "as-is")).toEqual(lines);
  });
});

describe("the emphasis rule", () => {
  const word = (ms: number): WordTiming => ({ start: 1000, end: 1000 + ms });

  it(`breaks a syllable of at least the look's minMs and at most its maxChars graphemes into letters`, () => {
    expect(emphasized(word(1000), "night", BL_EMPHASIS)).toBe(true);
    expect(emphasized(word(999), "night", BL_EMPHASIS)).toBe(false);
    expect(emphasized(word(2000), "a".repeat(12), BL_EMPHASIS)).toBe(true);
    expect(emphasized(word(2000), "a".repeat(13), BL_EMPHASIS)).toBe(false);
    // a letter with its accents is one character
    expect(emphasized(word(2000), "Ngườ".repeat(3), BL_EMPHASIS)).toBe(true);
    const slow: EmphasisRule = { minMs: 1500, maxChars: 4, lastWordOnly: false };
    expect(emphasized(word(1400), "home", slow)).toBe(false);
    expect(emphasized(word(1500), "homes", slow)).toBe(false);
    expect(emphasized(word(1500), "home", slow)).toBe(true);
  });

  it("judges each syllable on its own", () => {
    const window: WordTiming = {
      start: 2570,
      end: 4250,
      parts: [
        { text: "win", start: 2570, end: 2790 },
        { text: "dow", start: 2790, end: 4250 },
      ],
    };
    expect(emphasized(window, "window", BL_EMPHASIS)).toBe(true);
    expect(heldParts(window, "window", BL_EMPHASIS)).toEqual([false, true]);
    expect(partsOf(window, "window")).toHaveLength(2);
    const quick: WordTiming = { ...window, parts: [{ text: "win", start: 2570, end: 3400 }, { text: "dow", start: 3400, end: 4250 }] };
    expect(emphasized(quick, "window", BL_EMPHASIS)).toBe(false);
    // without syllables the word is its own part
    expect(partsOf({ start: 0, end: 500 }, "hum")).toEqual([{ text: "hum", start: 0, end: 500 }]);
  });

  it("applies to the line's last word alone with lastWordOnly (line-timed songs), and never without a rule", () => {
    const lastOnly: EmphasisRule = { minMs: 1300, maxChars: 12, lastWordOnly: true };
    expect(emphasized(word(2000), "home", lastOnly, false)).toBe(false);
    expect(emphasized(word(2000), "home", lastOnly, true)).toBe(true);
    expect(emphasized(word(5000), "home", null, true)).toBe(false);
    // and the plan follows it
    const shape = shapeOf("home", [{ text: "home" }]);
    const p = params({ emphasis: lastOnly });
    expect(planWord(word(2000), "home", shape, p).emphasis).toBe(false);
    expect(planWord(word(2000), "home", shape, p, { isLast: true }).emphasis).toBe(true);
    expect(planWord(word(2000), "home", shape, params({ emphasis: null }), { isLast: true }).letterGlows.every((g) => g === null)).toBe(true);
  });
});

describe("the wipe", () => {
  it("runs from a feather's width before the word to past its end, linearly", () => {
    const shape = shapeOf("bridge", [{ text: "bridge" }]);
    const word = { start: 5800, end: 6150 };
    const edge = wipeEdge(word, partsOf(word, "bridge"), shape);
    const span = word.end - word.start;
    expect(edge(0)).toBeCloseTo(-FEATHER * shape.width, 6);
    expect(edge(span)).toBeCloseTo(shape.width + OVERHANG * shape.size, 6);
    expect(edge(span / 2)).toBeCloseTo((edge(0) + edge(span)) / 2, 6);
    expect(edge(-100)).toBe(edge(0));
    expect(edge(span + 500)).toBe(edge(span));
  });

  it("is linear within each syllable, and eases out across a held one", () => {
    const window: WordTiming = {
      start: 2570,
      end: 4250,
      parts: [
        { text: "win", start: 2570, end: 2790 },
        { text: "dow", start: 2790, end: 4250 },
      ],
    };
    const shape = shapeOf("window", [{ text: "win" }, { text: "dow" }]);
    const linear = wipeEdge(window, partsOf(window, "window"), shape);
    const eased = wipeEdge(window, partsOf(window, "window"), shape, heldParts(window, "window", BL_EMPHASIS));
    const third = (3 * shape.width) / 6;
    // "win" is lit by the end of its own syllable, not a third of the way through the word
    for (const edge of [linear, eased]) expect(edge(220)).toBeCloseTo(third, 6);
    const half = 220 + (4250 - 2790) / 2;
    // linear: halfway through the held syllable, halfway across it; eased: well past halfway
    expect(linear(half) - third).toBeCloseTo((linear(1680) - third) / 2, 6);
    expect(eased(half) - third).toBeGreaterThan((eased(1680) - third) * 0.6);
    let last = -Infinity;
    for (let ms = 0; ms <= 1680; ms += 10) {
      expect(eased(ms)).toBeGreaterThanOrEqual(last);
      last = eased(ms);
    }
    // the plan samples the eased stretch; a linear word needs only its ends
    expect(planWord(window, "window", shape, BL).window?.frames.length).toBeGreaterThan(4);
    expect(planWord({ start: 5800, end: 6150 }, "bridge", shapeOf("bridge", [{ text: "bridge" }]), BL).window?.frames).toHaveLength(2);
  });
});

describe("a word's motion", () => {
  it("pops from its rest pose and settles at full size, the bloom rising and gone again", () => {
    const shape = shapeOf("hum", [{ text: "hum" }]);
    const plan = planWord({ start: 5370, end: 5590 }, "hum", shape, BL);
    const pop = plan.pop?.frames ?? [];
    expect(plan.pop?.t0).toBe(5370);
    expect(yOfFrame(pop[0])).toBeCloseTo(BL.restLift * 58, 1);
    expect(scaleOfFrame(pop[0])).toBeCloseTo(BL.restScale, 3);
    expect(yOfFrame(pop[pop.length - 1])).toBe(0);
    expect(scaleOfFrame(pop[pop.length - 1])).toBe(1);
    // it rises above its rest line on the way
    expect(Math.min(...pop.map(yOfFrame))).toBeLessThan(0);
    const glow = plan.glow?.frames ?? [];
    expect(firstOpacity(glow)).toBe(0);
    expect(lastOpacity(glow)).toBe(0);
    expect(Math.max(...glow.map(opacityOf))).toBeGreaterThan(0.2);
    expect(plan.until).toBeGreaterThan(5590);
    expect(plan.until).toBeLessThanOrEqual(wordUntil({ start: 5370, end: 5590 }, BL));
    expect(restTransform(58, BL)).toBe(liftScale(0, BL.restLift * 58, BL.restScale));
  });

  it("rises and swells further with a larger amplitude", () => {
    const shape = shapeOf("night", [{ text: "night" }]);
    const word = { start: 6790, end: 7700 };
    const rise = (p: ReturnType<typeof motionParams>): number => -Math.min(...(planWord(word, "night", shape, p).pop?.frames ?? []).map(yOfFrame));
    const swell = (p: ReturnType<typeof motionParams>): number => Math.max(...(planWord(word, "night", shape, p).pop?.frames ?? []).map(scaleOfFrame));
    expect(rise(HOUSE)).toBeGreaterThan(rise(BL) * 1.3);
    expect(swell(HOUSE)).toBeGreaterThan(swell(BL));
    expect(rise(params({ energy: 1, effects: 100 }))).toBeGreaterThan(rise(HOUSE) * 1.4);
  });

  it("wipes its lit window open while the contents slide back the same distance", () => {
    const shape = shapeOf("bridge", [{ text: "bridge" }]);
    const plan = planWord({ start: 5800, end: 6150 }, "bridge", shape, BL);
    const win = plan.window?.frames ?? [];
    const inner = plan.inner?.frames ?? [];
    expect(plan.window?.duration).toBe(350);
    expect(xOfFrame(win[0])).toBeCloseTo(-(shape.width * (1 + FEATHER) + OVERHANG * 58), 1);
    expect(xOfFrame(win[win.length - 1])).toBe(0);
    win.forEach((f, i) => expect(xOfFrame(inner[i])).toBeCloseTo(-xOfFrame(f), 6));
  });

  it("ripples every letter in turn, as high as min(0.14, 0.06·A) em", () => {
    const shape = shapeOf("bridge", [{ text: "bridge" }]);
    const word = { start: 5800, end: 6150 };
    const peak = (frames: Keyframe[] | undefined): number => -Math.min(...(frames ?? []).map(yOfFrame));
    const at = (p: ReturnType<typeof motionParams>): number => peak(planWord(word, "bridge", shape, p).letters[0]?.frames);
    const one = at(BL);
    expect(one).toBeGreaterThan(0.5 * 0.06 * 58);
    // the hop is a spring chasing the height: twice the height, twice the hop
    expect(at(params({ energy: 0.6 }))).toBeCloseTo(2 * one, 1);
    expect(at(params({ energy: 1, effects: 100 }))).toBeCloseTo((0.14 / 0.06) * one, 1);
    const plan = planWord(word, "bridge", shape, BL);
    expect(plan.letters.every((l) => l !== null)).toBe(true);
    // every letter makes the same hop, each once the wipe has lit it: the first before the last
    const rise = (i: number): number => {
      const track = plan.letters[i];
      const f = track?.frames.find((k) => yOfFrame(k) < -0.5);
      return Number(track?.t0) + Number(f?.offset) * Number(track?.duration);
    };
    expect(rise(0)).toBeGreaterThan(5800);
    expect(rise(5)).toBeGreaterThan(rise(0));
    expect(plan.letters[5]?.frames).toBe(plan.letters[0]?.frames);
    expect(plan.letterGlows.every((g) => g === null)).toBe(true);
    // only the lit copy (and its dark twin) hops: it alone shows where a letter is lit
    expect(plan.moveBase.every((m) => !m)).toBe(true);
    expect(plan.emphasis).toBe(false);
  });

  it("holds a hop up longer the slower the wipe crosses a letter, within 130 to 260 ms", () => {
    const shape = shapeOf("bridge", [{ text: "bridge" }]);
    const hop = (ms: number): Keyframe[] => planWord({ start: 1000, end: 1000 + ms }, "bridge", shape, BL).letters[0]?.frames ?? [];
    const lowAt = (frames: Keyframe[]): number => {
      const ys = frames.map(yOfFrame);
      return Number(frames[ys.indexOf(Math.min(...ys))]?.offset);
    };
    const quick = hop(120);
    // both cross a letter in over 260 ms, both under the 1 s that makes a held note
    const slow = hop(900);
    const slower = hop(990);
    // the quick word's hop is let go at 130 ms, before the spring has peaked; the slow one is held to 260 ms
    expect(-Math.min(...quick.map(yOfFrame))).toBeLessThan(-Math.min(...slow.map(yOfFrame)));
    expect(slow).toEqual(slower);
    expect(lowAt(quick)).toBeGreaterThan(0);
  });

  it("lights a held word letter by letter, each letter lifting further and blooming to the end", () => {
    const shape = shapeOf("night", [{ text: "night" }]);
    const word = { start: 6790, end: 8250 };
    const plan = planWord(word, "night", shape, BL);
    expect(plan.emphasis).toBe(true);
    expect(plan.letterGlows.every((g) => g !== null)).toBe(true);
    // a held syllable's letters rise while they light: both copies move
    expect(plan.moveBase.every((m) => m)).toBe(true);
    const lifts = plan.letters.map((l) => -Math.min(...(l?.frames ?? []).map(yOfFrame)));
    const wordLift = -Math.min(...(plan.pop?.frames ?? []).map(yOfFrame));
    expect(Math.min(...lifts)).toBeGreaterThan(wordLift);
    expect(Math.max(...lifts)).toBeGreaterThan(wordLift * 1.8);
    // letter j starts at sineOutInverse(j / k) of the syllable: fast, then stretching through the hold
    const starts = plan.letters.map((l) => {
      const f = l?.frames.findIndex((k, i) => i > 0 && Math.abs(yOfFrame(k) - yOfFrame(l.frames[0])) > 0.05) ?? -1;
      return Number(l?.frames[Math.max(0, f - 1)]?.offset) * Number(l?.duration);
    });
    const gaps = starts.slice(1).map((s, i) => s - (starts[i] ?? 0));
    expect(gaps[gaps.length - 1]).toBeGreaterThan(gaps[0] ?? 0);
    expect(starts[4]).toBeCloseTo(sineOutInverse(4 / 5) * 1460, -2);
    const rest = letterRest(word, "night", shape, BL);
    expect(rest.every((r) => r === liftScale(0, BL.restLift * BL.letterLiftGain * 58, BL.letterScaleKeys[0]?.[1] ?? 1))).toBe(true);
    expect(letterRest(word, "night", shape, params({ motion: false })).every((r) => r === "")).toBe(true);
    expect(letterRest({ start: 0, end: 300 }, "night", shape, BL).every((r) => r === "")).toBe(true);
  });

  it("keeps the wipe and the bloom at Effects 0, with no transform at all", () => {
    const still = params({ effects: 0 });
    const bridge = planWord({ start: 5800, end: 6150 }, "bridge", shapeOf("bridge", [{ text: "bridge" }]), still);
    expect(bridge.pop).toBeNull();
    expect(bridge.letters.every((l) => l === null)).toBe(true);
    expect(bridge.window?.frames.length).toBe(2);
    expect(Math.max(...(bridge.glow?.frames ?? []).map(opacityOf))).toBeGreaterThan(0.2);
    // a held word still blooms letter by letter, standing still
    const night = planWord({ start: 6790, end: 8250 }, "night", shapeOf("night", [{ text: "night" }]), still);
    expect(night.letters.every((l) => l === null)).toBe(true);
    expect(night.moveBase.every((m) => !m)).toBe(true);
    expect(night.letterGlows.every((g) => g !== null)).toBe(true);
  });

  it("only fades the lit copy and a steady bloom under reduced motion and in the lite tier", () => {
    for (const p of [params({ motion: false }), params({ power: "lite" })]) {
      const shape = shapeOf("bridge", [{ text: "bridge" }]);
      const plan = planWord({ start: 5800, end: 6150 }, "bridge", shape, p);
      expect(plan.pop).toBeNull();
      expect(plan.window).toBeNull();
      expect(plan.letters.every((l) => l === null)).toBe(true);
      expect(plan.litFade).toEqual({ t0: 5800, duration: 140, frames: [{ opacity: 0 }, { opacity: 1 }] });
      expect(plan.glow?.frames.map((f) => f.opacity)).toEqual([0, 0.6, 0.6, 0]);
      expect(plan.until).toBe(wordUntil({ start: 5800, end: 6150 }, p));
    }
  });

  it("still lights a word with no time to it, at once when its time comes", () => {
    const shape = shapeOf("x", [{ text: "x" }]);
    const plan = planWord({ start: 100, end: 100 }, "x", shape, BL);
    expect(plan.window?.t0).toBe(100);
    expect(plan.window?.duration).toBe(1);
    expect(xOfFrame(plan.window?.frames[plan.window.frames.length - 1])).toBe(0);
  });
});

describe("instrumental breaks", () => {
  const sung = (start: number, end: number): Pick<Line, "start" | "end" | "words"> => ({ start, end, words: [{ text: "la", start, end }] });

  it("are the intro and every gap of three seconds or more, each ending at its next line's lead", () => {
    const lines = [sung(4000, 6000), sung(7000, 8000), sung(12_000, 13_000), sung(14_000, 15_000)];
    expect(findInterludes(lines)).toEqual([
      { next: 0, start: 0, end: 4000 - LEAD_MS },
      { next: 2, start: 8000 + INTERLUDE_AFTER_MS, end: 12_000 - LEAD_MS },
    ]);
    expect(findInterludes([sung(1000, 2000)])).toEqual([]);
  });

  it("count from the last sung word, in a real song with an empty stamp", () => {
    const lines = parseLrc(paperLanterns, 24_000).filter((l) => l.words.length > 0);
    const breaks = findInterludes(lines);
    expect(breaks).toEqual([{ next: 2, start: 8500 + INTERLUDE_AFTER_MS, end: 12_500 - LEAD_MS }]);
    expect(interludeAt(breaks, 8949)).toBeNull();
    expect(interludeAt(breaks, 8950)).toEqual(breaks[0]);
    expect(interludeAt(breaks, 12_199)).toEqual(breaks[0]);
    expect(interludeAt(breaks, 12_200)).toBeNull();
  });

  it("light their dots one after another, swell, then pop out over the break's last 200 ms: gone by E", () => {
    const il = { next: 2, start: 10_000, end: 16_000 };
    const plan = planDots(il, 20, BL);
    const group = plan.group.transform as Track;
    const scale = (t: number): number => valueAt(group, t, scaleOfFrame);
    const opacity = (t: number): number => valueAt(plan.group.opacity, t, opacityOf);
    const exit = il.end - DOTS.fadeOutMs;
    expect(String(group.frames[0]?.transform)).toBe("scale(0)");
    expect(String(group.frames[group.frames.length - 1]?.transform)).toBe("scale(0)");
    // breathing through the break, swollen as the pop-out starts
    expect(scale(13_000)).toBeGreaterThan(0.9);
    expect(scale(13_000)).toBeLessThan(1.1);
    expect(scale(exit - DOTS.swellMs - 10)).toBeLessThan(1.08);
    expect(scale(exit)).toBeGreaterThan(1.1);
    // popping out, then gone by E, when the view moves on
    expect(scale(exit + 120)).toBeLessThan(scale(exit) - 0.3);
    expect(opacity(exit - 1)).toBeCloseTo(1, 2);
    expect(opacity(exit + DOTS.fadeOutMs / 2)).toBeCloseTo(0.5, 1);
    expect(opacity(il.end)).toBe(0);
    expect(scale(il.end)).toBe(0);
    expect(plan.until).toBe(il.end);
    expect(group.t0 + group.duration).toBe(il.end);
    expect(plan.group.opacity.t0 + plan.group.opacity.duration).toBe(il.end);
    // when each dot reaches full brightness: in turn, all within the break
    const lit = plan.dots.map((d) => {
      const f = d.frames.find((k) => Number(k.opacity) > 0.95);
      return Number(f?.offset) * d.duration;
    });
    expect(lit[0]).toBeLessThan(lit[1] ?? 0);
    expect(lit[1]).toBeLessThan(lit[2] ?? 0);
    expect(lit[2]).toBeLessThan(6000);
  });

  it("only fade and brighten in turn without motion (reduced motion, lite, Effects 0)", () => {
    for (const p of [params({ motion: false }), params({ power: "lite" }), params({ effects: 0 })]) {
      const plan = planDots({ next: 2, start: 10_000, end: 16_000 }, 20, p);
      expect(plan.group.transform).toBeNull();
      expect(plan.dots.every((d) => d.frames.every((f) => f.transform === undefined))).toBe(true);
      expect(valueAt(plan.group.opacity, 16_000 - DOTS.fadeOutMs - 1, opacityOf)).toBeCloseTo(1, 2);
      expect(valueAt(plan.group.opacity, 16_000, opacityOf)).toBe(0);
      expect(plan.until).toBe(16_000);
    }
  });

  it("move less, never more, than BL's dots at a smaller amplitude", () => {
    const lift = (p: ReturnType<typeof motionParams>): number => -Math.min(...(planDots({ next: 0, start: 0, end: 6000 }, 20, p).dots[0]?.frames ?? []).map(yOfFrame));
    expect(lift(params({ energy: 0.15 }))).toBeLessThan(lift(BL));
    expect(lift(HOUSE)).toBeCloseTo(lift(BL), 6);
  });
});

describe("the lead", () => {
  const sung = (start: number, end: number): Pick<Line, "start" | "end" | "words"> => ({ start, end, words: [{ text: "la", start, end }] });

  it("moves the view to a line 300 ms before it starts, unless the line before is still being sung", () => {
    const lines = [sung(1000, 2000), sung(2500, 3500), sung(3600, 5000), sung(8000, 9000), sung(9100, 9500)];
    // line 3 waits for line 2's last word (3.5 s), line 5 for line 4's (9.0 s)
    expect(leadTimes(lines)).toEqual([1000 - LEAD_MS, 2200, 3500, 8000 - LEAD_MS, 9000]);
    // a line whose predecessor overruns it starts in focus at its own start
    expect(leadTimes([sung(0, 5000), sung(4000, 6000)])).toEqual([-LEAD_MS, 4000]);
  });

  it("is where the focus is, and the line it brings waits until it starts", () => {
    const lines = [sung(1000, 2000), sung(2500, 3500), sung(8000, 9000)];
    const leads = leadTimes(lines);
    const breaks = findInterludes(lines);
    expect(focusAt({ line: 0, waiting: false, t: 2100 }, lines, leads, breaks, true)).toEqual({ line: 0, waiting: false, interlude: null });
    expect(focusAt({ line: 0, waiting: false, t: 2200 }, lines, leads, breaks, true)).toEqual({ line: 1, waiting: true, interlude: null });
    expect(focusAt({ line: 1, waiting: false, t: 2600 }, lines, leads, breaks, true)).toEqual({ line: 1, waiting: false, interlude: null });
    // a break plays between 3.95 s and its end 300 ms before the next line
    expect(focusAt({ line: 2, waiting: true, t: 5000 }, lines, leads, breaks, true).interlude).toEqual(breaks[0]);
    expect(focusAt({ line: 2, waiting: true, t: 7700 }, lines, leads, breaks, true)).toEqual({ line: 2, waiting: true, interlude: null });
    // without motion the view follows the stage's line, which crossfades it
    expect(focusAt({ line: 0, waiting: false, t: 2300 }, lines, leads, breaks, false)).toEqual({ line: 0, waiting: false, interlude: null });
    expect(focusAt({ line: -1, waiting: false, t: 99_000 }, lines, leads, breaks, true).line).toBe(-1);
    expect(untilNext(leads, 2100)).toBe(100);
    expect(untilNext(leads, 9000)).toBe(Infinity);
  });
});

describe("the glide on the document timeline", () => {
  it("springs from rest to its target and settles there", () => {
    const g = new WallGlide(0, SCROLL_SPRING, 1000);
    expect(g.state(1500)).toEqual({ x: 0, v: 0 });
    g.to(1, 1000);
    expect(g.state(1000).x).toBe(0);
    const ms = g.settleMs(0.002);
    expect(ms).toBeGreaterThan(400);
    expect(ms).toBeLessThan(1500);
    expect(Math.abs(g.state(1000 + ms).x - 1)).toBeLessThanOrEqual(0.002);
    // about 5 % overshoot
    const peak = Math.max(...sampleTimes(1200, 5).map((t) => g.state(1000 + t).x));
    expect(peak).toBeGreaterThan(1.02);
    expect(peak).toBeLessThan(1.1);
    expect(g.moving(1100)).toBe(true);
    expect(g.moving(1000 + ms + 1)).toBe(false);
  });

  it("retargets from the position and velocity on screen, mid-glide", () => {
    const g = new WallGlide(0, SCROLL_SPRING, 0);
    g.to(1, 0);
    const shown = g.state(200);
    expect(shown.v).toBeGreaterThan(0);
    g.to(2, 200);
    expect(g.state(200)).toEqual(shown);
    expect(g.released).toBe(200);
    expect(g.target).toBe(2);
    // velocity carries on: no kink
    expect((g.state(200.01).x - g.state(200).x) / 0.00001).toBeCloseTo(shown.v, 1);
  });

  it("keeps wall time through a seek back: retargeting never jumps to where it began", () => {
    // the list glides three lines down; 300 ms in, the song seeks back and the list heads up again
    const g = new WallGlide(4, SCROLL_SPRING, 50_000);
    g.to(7, 50_000);
    const shown = g.state(50_300);
    expect(shown.x).toBeGreaterThan(5);
    g.to(4, 50_300);
    expect(g.state(50_300)).toEqual(shown);
    expect(g.state(50_316).x).toBeGreaterThan(5);
    // a cut stops it dead
    g.cut(2, 50_400);
    expect(g.state(51_000)).toEqual({ x: 2, v: 0 });
  });

  it("samples to rest and makes thinned keyframes that start at the release", () => {
    const g = new WallGlide(0, SCROLL_SPRING, 100);
    g.to(1, 100);
    const s = g.samples();
    expect(s.xs[0]).toBe(0);
    expect(s.xs[s.xs.length - 1]).toBe(1);
    expect(s.startTime).toBe(100);
    expect(s.duration).toBe(s.times[s.times.length - 1]);
    const wall = springFrames(g, (x) => ({ transform: `translateY(${num(x * 100, 2)}px)` }));
    expect(wall.startTime).toBe(100);
    expect(wall.frames.length).toBeGreaterThan(3);
    expect(wall.frames.length).toBeLessThan(s.times.length / 2);
    expect(wall.frames[0]?.transform).toBe("translateY(0px)");
    expect(wall.frames[wall.frames.length - 1]?.transform).toBe("translateY(100px)");
    const el = new FakeAnimationHost();
    const anim = playWall(el as unknown as Element, wall) as unknown as FakeAnimation;
    expect(anim.startTime).toBe(100);
    expect(anim.options.fill).toBe("backwards");
    expect(playWall({} as Element, wall)).toBeNull();
  });
});

/** Just enough of an element for the timeline: animate and getAnimations. */
function element(): { el: Element; anims: FakeAnimation[] } {
  const host = new FakeAnimationHost();
  return { el: host as unknown as Element, anims: host.animations };
}

describe("the song timeline", () => {
  const frames: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];
  let perf = 0;
  beforeEach(() => {
    perf = 0;
    vi.spyOn(performance, "now").mockImplementation(() => perf);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts animations at their song time on the document timeline", () => {
    const tl = new SongTimeline();
    perf = 500;
    tl.sync({ t: 10_000, running: true, rate: 1 });
    const { el, anims } = element();
    tl.play(el, frames, 10_250, 300, "w");
    expect(anims[0]?.startTime).toBe(750);
    expect(anims[0]?.currentTime).toBe(-250);
    expect(tl.perfOf(9000)).toBe(-500);
    expect(tl.position(1500)).toBe(11_000);
  });

  it(`leaves a disagreement of up to ${DEAD_ZONE_MS} ms alone, however often it is asked`, () => {
    const tl = new SongTimeline();
    tl.sync({ t: 10_000, running: true, rate: 1 });
    const { el, anims } = element();
    tl.play(el, frames, 10_000, 1000, "w");
    const sets = anims[0]?.startTimeSets ?? 0;
    for (let p = 16; p <= 600; p += 16) {
      perf = p;
      // the clock's sample says the song is 25 ms ahead: within the dead zone, nothing moves
      expect(tl.sync({ t: 10_000 + p, running: true, target: 10_025 + p })).toEqual({ moved: 0, slewing: false });
    }
    expect(anims[0]?.startTimeSets).toBe(sets);
    expect(anims[0]?.rateUpdates).toBe(0);
    expect(tl.nextWake()).toBe(Infinity);
  });

  it("slews a larger one with the playback rate over max(300, |drift| / 0.8) ms, then back to 1 at nextWake", () => {
    const tl = new SongTimeline();
    tl.sync({ t: 10_000, running: true, rate: 1 });
    const { el, anims } = element();
    tl.play(el, frames, 10_000, 5000, "w");
    perf = 100;
    expect(tl.sync({ t: 10_100, running: true, target: 10_220 })).toEqual({ moved: 0, slewing: true });
    expect(tl.playbackRate).toBeCloseTo(1 + 120 / 300, 12);
    expect(anims[0]?.playbackRate).toBeCloseTo(1.4, 12);
    expect(anims[0]?.rateUpdates).toBe(1);
    expect(tl.nextWake()).toBe(300);
    // no jump: the animation is where it was, and gains the 120 ms over the slew
    expect(anims[0]?.currentTime).toBeCloseTo(100, 9);
    perf = 400;
    expect(anims[0]?.currentTime).toBeCloseTo(520, 9);
    // the same sample again (or a cue that agrees with it) changes nothing while the slew owes it
    perf = 250;
    expect(tl.sync({ t: 10_250, running: true, target: 10_370 }).slewing).toBe(true);
    expect(anims[0]?.rateUpdates).toBe(1);
    // the wake: back at rate 1, on the song
    perf = 400;
    expect(tl.sync({ t: 10_520, running: true, target: 10_520 })).toEqual({ moved: 0, slewing: false });
    expect(anims[0]?.playbackRate).toBe(1);
    expect(tl.nextWake()).toBe(Infinity);
    expect(anims[0]?.currentTime).toBeCloseTo(520, 9);
    // a bigger correction takes longer, never bending time by more than 0.8
    perf = 500;
    tl.sync({ t: 10_620, running: true, target: 10_620 + 380 });
    expect(tl.nextWake()).toBeCloseTo(380 / 0.8, 9);
    expect(tl.playbackRate).toBeCloseTo(1.8, 9);
    // its wake puts the rate back; one that goes the other way slows the animations down
    perf = 500 + 380 / 0.8;
    expect(tl.sync({ t: 11_000, running: true, target: tl.position(perf) }).slewing).toBe(false);
    perf = 1500;
    tl.sync({ t: tl.position(1500), running: true, target: tl.position(1500) - 100 });
    expect(tl.playbackRate).toBeCloseTo(1 - 100 / 300, 9);
    // a wake that comes late let the animations run ahead: that is judged like any other drift
    perf = 3000;
    expect(tl.sync({ t: 12_000, running: true, target: tl.position(1800) + 1200 }).slewing).toBe(true);
  });

  it(`jumps past ${JUMP_MS} ms, and for a seek or a resume`, () => {
    const tl = new SongTimeline();
    tl.sync({ t: 10_000, running: true, rate: 1 });
    const { el, anims } = element();
    tl.play(el, frames, 10_000, 1000, "w");
    perf = 100;
    const jump = tl.sync({ t: 15_200, running: true, target: 15_200 });
    expect(jump).toEqual({ moved: 5100, slewing: false });
    expect(anims[0]?.startTime).toBe(100 - 5200);
    expect(anims[0]?.playbackRate).toBe(1);
    // a resume anchors at once, wherever the song is
    perf = 200;
    tl.sync({ t: 15_300, running: false });
    perf = 9000;
    expect(tl.sync({ t: 15_300, running: true, target: 15_350 })).toEqual({ moved: 0, slewing: false });
    expect(anims[0]?.startTime).toBe(9000 - 5350);
  });

  it("holds everything at its song time while paused, a seek included, and resumes on the song", () => {
    const tl = new SongTimeline();
    tl.sync({ t: 10_000, running: true, rate: 1 });
    const { el, anims } = element();
    tl.play(el, frames, 10_000, 1000, "w");
    perf = 400;
    tl.sync({ t: 10_400, running: false, rate: 0 });
    expect(anims[0]?.paused).toBe(true);
    expect(anims[0]?.currentTime).toBe(400);
    expect(tl.perfOf(0)).toBeNull();
    expect(tl.playing).toBe(false);
    // a seek while paused, and an animation started while paused
    perf = 900;
    tl.sync({ t: 10_600, running: false });
    expect(anims[0]?.currentTime).toBe(600);
    tl.play(el, frames, 10_500, 300, "w");
    expect(anims[1]?.paused).toBe(true);
    expect(anims[1]?.currentTime).toBe(100);
    perf = 5000;
    tl.sync({ t: 10_600, running: true, rate: 1 });
    expect(anims[0]?.startTime).toBe(4400);
    expect(anims[1]?.startTime).toBe(4900);
    expect(anims[0]?.paused).toBe(false);
  });

  it("starts new animations at a slew's rate, on its anchor", () => {
    const tl = new SongTimeline();
    tl.sync({ t: 10_000, running: true });
    perf = 100;
    tl.sync({ t: 10_100, running: true, target: 10_200 });
    const { el, anims } = element();
    perf = 150;
    tl.play(el, frames, 10_000, 5000, "w");
    expect(anims[0]?.playbackRate).toBeCloseTo(tl.playbackRate, 12);
    expect(anims[0]?.currentTime).toBeCloseTo(tl.position(150) - 10_000, 9);
  });

  it("freezes what it draws: each animation commits its current values and stops", () => {
    const tl = new SongTimeline();
    tl.sync({ t: 10_000, running: true });
    const style = new Map<string, string>();
    const host = Object.assign(new FakeAnimationHost(), { style: { setProperty: (k: string, v: string) => style.set(k, v) } });
    tl.play(host as unknown as Element, frames, 10_000, 1000, "w");
    tl.play(host as unknown as Element, [{ transform: "translate(0px, 10px) scale(0.9)" }, { transform: "translate(0px, 0px) scale(1)" }], 10_000, 1000, "other");
    perf = 250;
    tl.freeze("w");
    expect(style.get("opacity")).toBe("0.25");
    expect(style.has("transform")).toBe(false);
    expect(tl.size).toBe(1);
    tl.freeze();
    expect(style.get("transform")).toBe("translate(0px, 7.5px) scale(0.925)");
    expect(tl.size).toBe(0);
    expect(host.animations.every((a) => a.cancelled && a.commits === 1)).toBe(true);
  });

  it("cancels one group, and forgets what has ended", () => {
    const tl = new SongTimeline();
    tl.sync({ t: 0, running: true, rate: 1 });
    const a = element();
    const b = element();
    tl.play(a.el, frames, 0, 100, "one");
    tl.play(b.el, frames, 0, 5000, "two");
    expect(tl.busy("one", 50)).toBe(true);
    tl.cancel("one");
    expect(a.anims[0]?.cancelled).toBe(true);
    expect(b.anims[0]?.cancelled).toBe(false);
    expect(tl.size).toBe(1);
    tl.prune(6000);
    expect(tl.size).toBe(0);
    expect(tl.busy("two", 6000)).toBe(false);
    expect(tl.play({} as Element, frames, 0, 100, "x")).toBeNull();
  });
});

// ---------- a karaoke line in a small DOM ----------

class FakeStyle {
  readonly props = new Map<string, string>();
  [key: string]: unknown;
  setProperty(name: string, value: string): void {
    this.props.set(name, value);
  }
  removeProperty(name: string): void {
    this.props.delete(name);
  }
  getPropertyValue(name: string): string {
    return this.props.get(name) ?? "";
  }
}

class Node extends FakeAnimationHost {
  readonly tagName: string;
  className = "";
  style = new FakeStyle();
  children: Node[] = [];
  parent: Node | null = null;
  own = "";
  readonly attrs = new Map<string, string>();
  readonly classList = {
    add: (...names: string[]): void => {
      this.className = [...new Set([...this.className.split(" ").filter(Boolean), ...names])].join(" ");
    },
    remove: (...names: string[]): void => {
      this.className = this.className
        .split(" ")
        .filter((c) => c && !names.includes(c))
        .join(" ");
    },
    toggle: (name: string, force?: boolean): boolean => {
      const on = force ?? !this.classList.contains(name);
      if (on) this.classList.add(name);
      else this.classList.remove(name);
      return on;
    },
    contains: (name: string): boolean => this.className.split(" ").includes(name),
  };
  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }
  get parentNode(): Node | null {
    return this.parent;
  }
  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.own = value;
  }
  append(...nodes: Node[]): void {
    for (const n of nodes) {
      n.remove();
      n.parent = this;
      this.children.push(n);
    }
  }
  remove(): void {
    const p = this.parent;
    if (!p) return;
    p.children.splice(p.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  find(cls: string): Node[] {
    return this.children.flatMap((c) => [...(c.classList.contains(cls) ? [c] : []), ...c.find(cls)]);
  }
  /** Direct children with the class. */
  kids(cls: string): Node[] {
    return this.children.filter((c) => c.classList.contains(cls));
  }
}

const asEl = (n: Node): HTMLElement => n as unknown as HTMLElement;

describe("a karaoke line", () => {
  let perf = 0;
  /** ms each performance.now() call advances (the slices' budget); 0 freezes the clock */
  let tick = 0;
  let frames: FrameRequestCallback[] = [];

  beforeEach(() => {
    perf = 0;
    tick = 0;
    frames = [];
    vi.stubGlobal("document", withCanvas({ createElement: (tag: string) => new Node(tag) }, fakeContext2d(0.5)));
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
      frames[id - 1] = () => undefined;
    });
    vi.spyOn(performance, "now").mockImplementation(() => (perf += tick));
    resetMeasure();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetMeasure();
  });

  /** One `.kw` box per word, each with its plain text, in a row. */
  function row(words: readonly Word[]): { row: Node; boxes: Node[] } {
    const r = new Node("div");
    r.className = "drift-row kw-host";
    const boxes = words.map((w) => {
      const box = new Node("span");
      box.className = "kw";
      const txt = new Node("span");
      txt.className = "kw-txt";
      txt.textContent = w.text.trimEnd();
      box.append(txt);
      r.append(box);
      return box;
    });
    return { row: r, boxes };
  }

  const words = (texts: string[], start: number, every: number, length = every * 0.8): Word[] =>
    texts.map((text, i) => ({ text: `${text} `, start: start + i * every, end: start + i * every + length }));

  function line(ws: Word[], p = BL, extra: { place?: LetterPlacer } = {}): { line: KaraokeLine; boxes: Node[]; tl: SongTimeline } {
    const { boxes } = row(ws);
    const tl = new SongTimeline();
    tl.sync({ t: ws[0]?.start ?? 0, running: true });
    const k = new KaraokeLine(ws, boxes.map(asEl), { size: 58, font: "700 58px Test", letterSpacingPx: 0, params: p, steps: false, ...extra }, tl, "kw1");
    return { line: k, boxes, tl };
  }

  const animated = (box: Node): FakeAnimation[] => [box, ...box.find("kw-track"), ...box.find("kw-in"), ...box.find("kw-win"), ...box.find("kw-glow"), ...box.find("kl")].flatMap((e) => e.getAnimations());
  const runFrames = (): number => {
    const due = frames.splice(0);
    for (const f of due) f(perf);
    return due.length;
  };

  it("mounts the words sung by now or within 400 ms in its first slice, the rest on the next frames, earliest first, in one window", () => {
    const ws = words(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"], 10_000, 300);
    const { line: k, boxes } = line(ws);
    tick = 2;
    k.mount(9700, true);
    const mounted = (): number[] => boxes.map((b, i) => (animated(b).length > 0 ? i : -1)).filter((i) => i >= 0);
    const first = mounted();
    // within 400 ms of the origin (9.7 s): "one" at 10.0 s; a few more while the 6 ms slice lasts
    expect(first[0]).toBe(0);
    expect(first.length).toBeLessThan(ws.length);
    expect(first).toEqual(first.map((_, i) => i));
    expect(k.mounting).toBe(true);
    // the rest wait in their pose: still full size, easing into rest when they mount
    const waiting = boxes[first.length];
    expect(waiting?.style.getPropertyValue("transform")).toBe(FULL_TRANSFORM);
    // each frame mounts at least one more, earliest first
    let last = first.length;
    while (k.mounting) {
      expect(runFrames()).toBe(1);
      const now = mounted();
      expect(now.length).toBeGreaterThan(last);
      expect(now).toEqual(now.map((_, i) => i));
      last = now.length;
    }
    expect(last).toBe(ws.length);
    // every animation of the line shares its window [origin, end], on one anchor
    tick = 0;
    const all = boxes.flatMap(animated);
    const span = k.span;
    expect(span.origin).toBe(9700);
    expect(span.end).toBe(wordUntil(ws[9] as Word, BL));
    expect(new Set(all.map((a) => a.options.duration))).toEqual(new Set([span.end - span.origin]));
    expect(new Set(all.map((a) => Math.round((a.startTime ?? 0) * 1000)))).toHaveProperty("size", 1);
  });

  it("mounts every word sung by the time it comes into focus mid-line in its first slice", () => {
    const ws = words(["one", "two", "three", "four", "five", "six"], 10_000, 300);
    const { line: k, boxes } = line(ws);
    tick = 50;
    k.mount(11_000, false);
    // sung by 11 s, or within 400 ms of it: words 0..4 (starting by 11.2 s), however long the slice takes
    expect(boxes.slice(0, 5).every((b) => animated(b).length > 0)).toBe(true);
    expect(k.span.origin).toBe(10_000);
  });

  it("prepares ahead in slices and reports when every word is ready; mounting then plans nothing", () => {
    const ws = words(["alpha", "beta", "gamma", "delta", "epsilon", "zeta"], 20_000, 400);
    const { line: k, boxes } = line(ws);
    tick = 3;
    let slices = 1;
    while (!k.prepare(6)) slices++;
    expect(slices).toBeGreaterThan(1);
    // the overlays are built, hidden until the row shows them
    expect(boxes.every((b) => b.kids("kw-fx").length === 1 && b.classList.contains("kw-on"))).toBe(true);
    const built = boxes.map((b) => b.kids("kw-fx")[0]);
    tick = 0;
    k.mount(20_000 - LEAD_MS, true);
    expect(boxes.map((b) => b.kids("kw-fx")[0])).toEqual(built);
    expect(boxes.every((b) => animated(b).length > 0)).toBe(true);
    expect(k.prepare()).toBe(true);
  });

  it("draws the dark shadow under everything and outside every window, split exactly where letters move", () => {
    const ws: Word[] = [
      { text: "bridge ", start: 10_000, end: 10_400 },
      { text: "الضوء ", start: 10_400, end: 10_800 },
      { text: "night", start: 10_800, end: 12_400 },
    ];
    const { line: k, boxes } = line(ws);
    k.mount(10_000, false);
    const [bridge, arabic, night] = boxes as [Node, Node, Node];
    for (const box of boxes) {
      const fx = box.kids("kw-fx")[0] as Node;
      // the first layer of the overlay, a sibling of the windows' track, never inside a window
      expect(fx.children[0]?.classList.contains("kw-dark")).toBe(true);
      expect(fx.find("kw-track")[0]?.find("kw-dark")).toEqual([]);
    }
    const darkOf = (box: Node): Node => box.find("kw-dark")[0] as Node;
    const litOf = (box: Node): Node[] => (box.find("kw-win")[0]?.find("kl") ?? []);
    // "bridge" ripples: every dark letter hops with its lit twin, on the very same track
    expect(darkOf(bridge).kids("kl").map((l) => l.textContent)).toEqual([..."bridge"]);
    darkOf(bridge).kids("kl").forEach((d, j) => {
      const lit = litOf(bridge)[j] as Node;
      expect(d.getAnimations()).toHaveLength(1);
      expect(d.getAnimations()[0]?.keyframes).toEqual(lit.getAnimations()[0]?.keyframes);
    });
    // a joining script can't split: one run, standing still
    expect(darkOf(arabic).kids("kl")).toEqual([]);
    expect(darkOf(arabic).textContent).toBe("الضوء");
    expect(darkOf(arabic).getAnimations()).toEqual([]);
    // a held word's letters rise with all their copies
    darkOf(night).kids("kl").forEach((d, j) => {
      const base = night.find("kw-bwin")[0]?.find("kl")[j] as Node;
      expect(d.getAnimations()[0]?.keyframes).toEqual(base.getAnimations()[0]?.keyframes);
    });
    k.destroy();
    expect(boxes.every((b) => b.kids("kw-fx").length === 0 && !b.classList.contains("kw-on"))).toBe(true);
  });

  it("keeps the dark copy one still run where nothing moves: Effects 0, reduced motion, lite", () => {
    for (const p of [params({ effects: 0 }), params({ motion: false }), params({ power: "lite" })]) {
      const { line: k, boxes } = line([{ text: "bridge", start: 10_000, end: 10_400 }], p);
      k.mount(10_000, false);
      const dark = boxes[0]?.find("kw-dark")[0] as Node;
      expect(dark.kids("kl")).toEqual([]);
      expect(dark.textContent).toBe("bridge");
      expect(boxes[0]?.find("kw-win")[0]?.find("kl")).toHaveLength(1);
      // only the full karaoke masks its lit window
      expect(boxes[0]?.find("kw-win")[0]?.style.getPropertyValue("mask-image") !== "").toBe(p.karaoke === "full");
      // and no word box ever moves
      expect(boxes[0]?.getAnimations()).toEqual([]);
    }
  });

  it("places every copy of each letter with its LetterPlacer, through translate and rotate", () => {
    const place: LetterPlacer = (w, j) => ({ dx: w + j, dy: -j, rotate: 2 * j });
    const { line: k, boxes } = line([{ text: "glow", start: 10_000, end: 10_400 }], params({ effects: 0 }), { place });
    k.mount(10_000, false);
    const box = boxes[0] as Node;
    const txt = box.kids("kw-txt")[0] as Node;
    // the plain text too: its run keeps the box's size, unseen, and its letters draw it
    expect(txt.kids("kw-hold")[0]?.textContent).toBe("glow");
    const copies = [
      box.find("kw-dark")[0]?.kids("kl"),
      box.find("kw-glow")[0]?.kids("kl"),
      box.find("kw-bwin")[0]?.find("kl"),
      box.find("kw-win")[0]?.find("kl"),
      txt.kids("kl"),
    ];
    for (const letters of copies) {
      expect(letters?.map((l) => l.textContent)).toEqual([..."glow"]);
      letters?.forEach((l, j) => {
        expect(l.style.getPropertyValue("translate")).toBe(`${j.toFixed(2)}px ${(-j).toFixed(2)}px`);
        expect(l.style.getPropertyValue("rotate")).toBe(`${(2 * j).toFixed(3)}deg`);
      });
    }
    k.destroy();
    expect(txt.textContent).toBe("glow");
    expect(txt.kids("kl")).toEqual([]);
  });

  it("plays along tracks in its batch, rebased onto the same window", () => {
    const ws = words(["one", "two"], 10_000, 300);
    const { line: k, boxes } = line(ws);
    const slot = new Node("span");
    const along = { el: asEl(slot), track: { t0: 9800, duration: 2600, frames: [{ opacity: 0 }, { opacity: 1 }] } };
    k.mount(9700, true, [along]);
    const anim = slot.getAnimations()[0];
    expect(anim).toBeDefined();
    const word = animated(boxes[0] as Node)[0];
    expect(anim?.options.duration).toBe(word?.options.duration);
    expect(k.span.end).toBe(Math.max(wordUntil(ws[1] as Word, BL), 9800 + 2600));
    expect(anim?.keyframes[0]).toEqual({ opacity: 0, offset: 0 });
    expect(Number(anim?.keyframes[1]?.offset)).toBeCloseTo((9800 - 9700) / (k.span.end - 9700), 9);
  });

  it("knows when its animations no longer cover the song: before its origin, or pruned once over", () => {
    const ws = words(["one", "two", "three"], 10_000, 400);
    const { line: k, tl } = line(ws);
    k.mount(10_000, false);
    expect(k.covers(10_500)).toBe(true);
    expect(k.covers(9_000)).toBe(false);
    expect(k.covers(k.span.end + 10)).toBe(true);
    tl.prune(k.span.end + 1);
    expect(k.covers(10_500)).toBe(false);
    k.mount(10_500, false);
    expect(k.covers(10_500)).toBe(true);
  });

  it("finishes where it ends (sung, no bloom) and freezes where it is", () => {
    const ws = words(["one", "two"], 10_000, 400);
    const { line: k, boxes, tl } = line(ws);
    k.mount(10_000, false);
    k.finish();
    expect(tl.size).toBe(0);
    expect(boxes[1]?.find("kw-track")[0]?.style.getPropertyValue("transform")).toBe("translateX(0px)");
    expect(boxes[1]?.find("kw-glow")[0]?.style.getPropertyValue("opacity")).toBe("0");
    k.mount(10_000, false);
    perf = 300;
    const glow = boxes[0]?.find("kw-glow")[0] as Node;
    k.freeze();
    expect(tl.size).toBe(0);
    expect(Number(glow.style.getPropertyValue("opacity"))).toBeGreaterThan(0);
  });

  it(`settles a line arriving early into its rest pose over ${SETTLE_IN_MS} ms`, () => {
    const ws = words(["one", "two"], 10_000, 400);
    const { line: k, boxes } = line(ws);
    k.mount(10_000 - LEAD_MS, true);
    const pop = boxes[0]?.getAnimations()[0] as FakeAnimation;
    const window = k.span.end - k.span.origin;
    expect(valuesAt(pop.keyframes, 0).transform).toBe(FULL_TRANSFORM);
    expect(valuesAt(pop.keyframes, SETTLE_IN_MS / window).transform).toBe(restTransform(58, BL));
  });
});

describe("the interlude dots", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { createElement: (tag: string) => new Node(tag) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("are three dots in a group, played on the song's timeline, taken off and brought back", () => {
    const host = new Node("div");
    const dots = new InterludeDots(asEl(host), 20);
    const tl = new SongTimeline();
    tl.sync({ t: 10_000, running: true });
    const el = dots.el as unknown as Node;
    expect(host.children).toEqual([el]);
    expect(el.find("ut-dot")).toHaveLength(3);
    expect(el.style.gap).toBe("11.00px");
    const until = dots.play({ next: 1, start: 10_000, end: 16_000 }, tl, BL, "dots");
    expect(until).toBe(16_000);
    expect(el.getAnimations()).toHaveLength(2);
    expect(el.find("ut-dot").every((d) => d.getAnimations().length === 1 && d.children[0]?.getAnimations().length === 1)).toBe(true);
    dots.stop();
    expect(host.children).toEqual([]);
    expect(tl.size).toBe(0);
    // without motion only the group's opacity moves, at full size
    dots.play({ next: 1, start: 10_000, end: 16_000 }, tl, params({ motion: false }), "dots");
    expect(host.children).toEqual([el]);
    expect(el.getAnimations()).toHaveLength(1);
    expect(el.style.getPropertyValue("transform")).toBe("none");
  });
});

describe("the power tier", () => {
  afterEach(() => {
    resetPower();
    vi.unstubAllGlobals();
  });

  it("is lite only for a software rasterizer's renderer string", () => {
    for (const soft of [
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
      "Google SwiftShader",
      "llvmpipe (LLVM 15.0.7, 256 bits)",
      "softpipe",
      "Microsoft Basic Render Driver",
      "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "Software Rasterizer",
      "Mesa OffScreen",
    ])
      expect(isSoftwareRenderer(soft), soft).toBe(true);
    for (const gpu of [
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "Apple M2",
      "Apple GPU",
      "WebKit WebGL",
      "AMD Radeon Pro 5500M OpenGL Engine",
      "Mesa Intel(R) UHD Graphics 620 (KBL GT2)",
      "",
    ])
      expect(isSoftwareRenderer(gpu), gpu).toBe(false);
    expect(isSoftwareRenderer(null)).toBe(false);
  });

  it("is whatever ?power= forces", () => {
    expect(forcedPower("?power=lite")).toBe("lite");
    expect(forcedPower("?mock=&power=full")).toBe("full");
    expect(forcedPower("?power=fast")).toBeNull();
    expect(detectPower("?power=lite")).toBe("lite");
  });

  /** A document whose canvas makes `gl` (null: no WebGL), counting the contexts made and lost. */
  function docWith(gl: Record<string, unknown> | null): { doc: Pick<Document, "createElement">; made: () => number; lost: () => number } {
    let made = 0;
    let lost = 0;
    const context = gl && {
      RENDERER: 0x1f01,
      ...gl,
      getExtension: (name: string): unknown =>
        name === "WEBGL_lose_context" ? { loseContext: () => lost++ } : name === "WEBGL_debug_renderer_info" ? (gl.info ?? null) : null,
    };
    const doc = {
      createElement: (): unknown => ({
        getContext: (kind: string) => {
          if (kind !== "webgl") return null;
          made++;
          return context;
        },
      }),
    } as unknown as Pick<Document, "createElement">;
    return { doc, made: () => made, lost: () => lost };
  }

  it("probes WebGL once: no context or a software renderer is lite; a masked, unknown or unreadable one is full", () => {
    const UNMASKED = 0x9246;
    const cases: [Record<string, unknown> | null, "full" | "lite"][] = [
      [null, "lite"],
      [{ info: { UNMASKED_RENDERER_WEBGL: UNMASKED }, getParameter: (p: number) => (p === UNMASKED ? "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)" : "WebKit WebGL") }, "lite"],
      [{ info: { UNMASKED_RENDERER_WEBGL: UNMASKED }, getParameter: (p: number) => (p === UNMASKED ? "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650)" : "WebKit WebGL") }, "full"],
      // WebKit without the extension, or with a masked name
      [{ getParameter: () => "WebKit WebGL" }, "full"],
      [{ info: { UNMASKED_RENDERER_WEBGL: UNMASKED }, getParameter: () => "Apple GPU" }, "full"],
      [{ getParameter: () => "llvmpipe (LLVM 12.0.0, 256 bits)" }, "lite"],
      [{ getParameter: () => 7 }, "full"],
      [
        {
          getParameter: () => {
            throw new Error("context lost");
          },
        },
        "full",
      ],
    ];
    for (const [gl, want] of cases) {
      const { doc, made, lost } = docWith(gl);
      expect(probePower(doc), JSON.stringify(gl)).toBe(want);
      expect(made()).toBe(1);
      if (gl) expect(lost()).toBe(1);
    }
    expect(probePower(undefined)).toBe("full");
    expect(probePower({ createElement: () => ({}) } as unknown as Pick<Document, "createElement">)).toBe("full");
  });

  it("asks once per window", () => {
    const { doc, made } = docWith(null);
    vi.stubGlobal("document", doc);
    expect(detectPower("")).toBe("lite");
    expect(detectPower("")).toBe("lite");
    expect(made()).toBe(1);
    // a forced tier wins over what was found
    expect(detectPower("?power=full")).toBe("full");
  });
});

describe("the list's layout", () => {
  const line = (height = 60): { height: number; collapsible: boolean } => ({ height, collapsible: false });
  const gap = { height: 60, collapsible: true };

  it("is stackOffsets for lines alone", () => {
    const heights = [60, 120, 60, 60];
    const placed = placeSlots(heights.map((h) => line(h)), 1.3, 1, 1.1);
    const offsets = stackOffsets(heights, 1.3, 1, 1.1);
    for (const [i, p] of placed) expect(offsets.get(i)).toBe(p.at);
  });

  it("folds a break away out of focus, counting nothing for it", () => {
    const slots = [line(), gap, line()];
    const away = placeSlots(slots, 0, 0, 1);
    expect(away.has(1)).toBe(false);
    // the line after the folded break is the next line: one line away, one slot below
    expect(away.get(2)?.off).toBeCloseTo(1, 9);
    expect(away.get(2)?.at).toBeCloseTo(60, 9);
    // in focus, the break opens between the lines
    const on = placeSlots(slots, 1, 0, 1);
    expect(on.get(1)?.at).toBe(0);
    expect(on.get(0)?.at).toBeCloseTo(-60, 9);
    expect(on.get(2)?.at).toBeCloseTo(60, 9);
    expect(on.get(2)?.off).toBeCloseTo(1, 9);
  });

  it("moves continuously as it scrolls over a break", () => {
    const slots = [line(), gap, line(), line()];
    let last = placeSlots(slots, 0, 0, 1).get(2)?.at ?? 0;
    for (let s = 0.02; s <= 2; s += 0.02) {
      const at = placeSlots(slots, s, 0, 1).get(2)?.at ?? 0;
      expect(Math.abs(at - last)).toBeLessThan(4);
      last = at;
    }
  });

  it("dims lines with distance, sung ones a little less than upcoming ones", () => {
    expect(lineLevel(0)).toBe(1);
    expect(lineLevel(-1)).toBeGreaterThan(lineLevel(1));
    expect(lineLevel(1)).toBeCloseTo(0.46, 12);
    expect(lineLevel(-1)).toBeCloseTo(0.58, 12);
    expect(lineLevel(2)).toBeLessThan(lineLevel(1));
    expect(lineLevel(3.5)).toBe(0);
  });
});
