import { describe, expect, it, vi } from "vitest";
import { parseLrc, type Line } from "../src/core/lrc";
import { clamp01, sineOut, sineOutInverse, spline } from "../src/overlay/motion/curve";
import { findInterludes, interludeAt, INTERLUDE_LEAD_MS, planDots } from "../src/overlay/motion/interlude";
import {
  emphasized,
  EMPHASIS_CHARS,
  EMPHASIS_MS,
  FEATHER,
  letterRest,
  OVERHANG,
  partsOf,
  planWord,
  rebase,
  REST_LIFT,
  REST_SCALE,
  restTransform,
  songEnergy,
  wipeEdge,
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
import { graphemes, isRtl, measureLetters, roughMeasure, splittable, type Measure } from "../src/overlay/motion/letters";
import { chase, Glide, settleMs, springStep, type SpringSpec } from "../src/overlay/motion/spring";
import { SongTimeline } from "../src/overlay/motion/timeline";
import { lineLevel, placeSlots, stackOffsets } from "../src/overlay/modes/drift";
import paperLanterns from "./fixtures/paper-lanterns.lrc?raw";

const BOUNCY: SpringSpec = { hz: 1.25, damping: 0.4 };

/** Final keyframe value of a numeric CSS property, or of the y in translate(x, y). */
const lastOpacity = (frames: Keyframe[]): number => Number(frames[frames.length - 1]?.opacity);
const firstOpacity = (frames: Keyframe[]): number => Number(frames[0]?.opacity);
const yOfFrame = (f: Keyframe | undefined): number => Number(/translate\([-\d.]+px, (-?[\d.]+)px\)/u.exec(String(f?.transform))?.[1]);
const scaleOfFrame = (f: Keyframe | undefined): number => Number(/scale\(([\d.]+)\)/u.exec(String(f?.transform))?.[1]);
const xOfFrame = (f: Keyframe | undefined): number => Number(/translateX\((-?[\d.]+)px\)/u.exec(String(f?.transform))?.[1]);

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
  });

  it("swing past a key before a sharp turn (the lift's overshoot)", () => {
    const lift = spline([
      [0, 0.01],
      [0.9, -0.019],
      [1, 0],
    ]);
    const lowest = Math.min(...Array.from({ length: 101 }, (_, i) => lift(i / 100)));
    expect(lowest).toBeLessThan(-0.025);
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
    expect(liftScale(0, -1.23456, 1.025)).toBe("translate(0px, -1.23px) scale(1.025)");
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
      ...[plan.glow, ...plan.letterGlows].flatMap((t) => (t ? [{ track: t, read: (f: Keyframe) => Number(f.opacity), tol: 0.04 }] : [])),
    ];
    const glide = reads(planWord(word, "note", shape, { energy: 0.4, motion: true }));
    const stepped = reads(planWord(word, "note", shape, { energy: 0.4, motion: true, steps: true }));
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
    const plan = planDots({ next: 2, start: 10_000, end: 16_000 }, 20, true, true);
    const scale = (f: Keyframe): number => Number(/scale\(([\d.]+)\)/u.exec(String(f.transform))?.[1]);
    const changes = changeFrames([{ track: plan.group.transform, read: scale }], 11_000, 15_000);
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
    expect(graphemes("éx")).toEqual(["é", "x"]);
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

  it("know their syllable, and a word that can't be split is one letter", () => {
    const { letters } = measureLetters("window", [{ text: "win" }, { text: "dow" }], kerned);
    expect(letters.map((l) => l.part)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(measureLetters("الضوء", [{ text: "الضوء" }], kerned).letters).toHaveLength(1);
    expect(measureLetters("a", [{ text: "a" }], kerned).letters).toEqual([{ text: "a", x: 0, w: 10, part: 0 }]);
  });
});

describe("the emphasis rule", () => {
  const word = (ms: number): WordTiming => ({ start: 1000, end: 1000 + ms });
  it(`breaks a syllable of ${EMPHASIS_MS} ms or more and at most ${EMPHASIS_CHARS} characters into letters`, () => {
    expect(emphasized(word(EMPHASIS_MS), "night")).toBe(true);
    expect(emphasized(word(EMPHASIS_MS - 1), "night")).toBe(false);
    expect(emphasized(word(2000), "a".repeat(EMPHASIS_CHARS))).toBe(true);
    expect(emphasized(word(2000), "a".repeat(EMPHASIS_CHARS + 1))).toBe(false);
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
    expect(emphasized(window, "window")).toBe(true);
    expect(partsOf(window, "window")).toHaveLength(2);
    const quick: WordTiming = { ...window, parts: [{ text: "win", start: 2570, end: 3400 }, { text: "dow", start: 3400, end: 4250 }] };
    expect(emphasized(quick, "window")).toBe(false);
    // without syllables the word is its own part
    expect(partsOf({ start: 0, end: 500 }, "hum")).toEqual([{ text: "hum", start: 0, end: 500 }]);
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

  it("follows the syllables, easing out across a held one", () => {
    const window: WordTiming = {
      start: 2570,
      end: 4250,
      parts: [
        { text: "win", start: 2570, end: 2790 },
        { text: "dow", start: 2790, end: 4250 },
      ],
    };
    const shape = shapeOf("window", [{ text: "win" }, { text: "dow" }]);
    const edge = wipeEdge(window, partsOf(window, "window"), shape);
    const third = (3 * shape.width) / 6;
    // "win" is lit by the end of its own syllable, not a third of the way through the word
    expect(edge(220)).toBeCloseTo(third, 6);
    // the held "dow" eases out: more than half lit halfway through it
    const half = 220 + (4250 - 2790) / 2;
    expect(edge(half) - third).toBeGreaterThan((edge(1680) - third) * 0.6);
    let last = -Infinity;
    for (let ms = 0; ms <= 1680; ms += 10) {
      expect(edge(ms)).toBeGreaterThanOrEqual(last);
      last = edge(ms);
    }
  });
});

describe("a word's motion", () => {
  const motion = { energy: 0.5, motion: true };

  it("pops from its rest pose and settles at full size, the bloom rising and gone again", () => {
    const shape = shapeOf("hum", [{ text: "hum" }]);
    const plan = planWord({ start: 5370, end: 5590 }, "hum", shape, motion);
    const pop = plan.pop?.frames ?? [];
    expect(plan.pop?.t0).toBe(5370);
    expect(yOfFrame(pop[0])).toBeCloseTo(REST_LIFT * 58, 1);
    expect(scaleOfFrame(pop[0])).toBeCloseTo(REST_SCALE, 3);
    expect(yOfFrame(pop[pop.length - 1])).toBe(0);
    expect(scaleOfFrame(pop[pop.length - 1])).toBe(1);
    // it rises above its rest line on the way
    expect(Math.min(...pop.map(yOfFrame))).toBeLessThan(0);
    const glow = plan.glow?.frames ?? [];
    expect(firstOpacity(glow)).toBe(0);
    expect(lastOpacity(glow)).toBe(0);
    expect(Math.max(...glow.map((f) => Number(f.opacity)))).toBeGreaterThan(0.2);
    expect(plan.until).toBeGreaterThan(5590);
    expect(restTransform(58)).toBe(liftScale(0, REST_LIFT * 58, REST_SCALE));
  });

  it("wipes its lit window open while the contents slide back the same distance", () => {
    const shape = shapeOf("bridge", [{ text: "bridge" }]);
    const plan = planWord({ start: 5800, end: 6150 }, "bridge", shape, motion);
    const win = plan.window?.frames ?? [];
    const inner = plan.inner?.frames ?? [];
    expect(plan.window?.duration).toBe(350);
    expect(xOfFrame(win[0])).toBeCloseTo(-(shape.width * (1 + FEATHER) + OVERHANG * 58), 1);
    expect(xOfFrame(win[win.length - 1])).toBe(0);
    win.forEach((f, i) => expect(xOfFrame(inner[i])).toBeCloseTo(-xOfFrame(f), 6));
    // a linear wipe needs no samples between its ends
    expect(win).toHaveLength(2);
  });

  it("ripples every letter in turn, livelier for a livelier song", () => {
    const shape = shapeOf("bridge", [{ text: "bridge" }]);
    const calm = planWord({ start: 5800, end: 6150 }, "bridge", shape, { energy: 0, motion: true });
    const lively = planWord({ start: 5800, end: 6150 }, "bridge", shape, { energy: 1, motion: true });
    const peak = (frames: Keyframe[] | undefined): number => -Math.min(...(frames ?? []).map(yOfFrame));
    expect(calm.letters.every((l) => l !== null)).toBe(true);
    expect(peak(lively.letters[0]?.frames)).toBeGreaterThan(peak(calm.letters[0]?.frames) * 1.5);
    // every letter makes the same hop, each once the wipe has lit it: the first before the last
    const rise = (i: number): number => {
      const track = calm.letters[i];
      const f = track?.frames.find((k) => yOfFrame(k) < -0.5);
      return Number(track?.t0) + Number(f?.offset) * Number(track?.duration);
    };
    expect(rise(0)).toBeGreaterThan(5800);
    expect(rise(5)).toBeGreaterThan(rise(0));
    expect(calm.letters[5]?.frames).toBe(calm.letters[0]?.frames);
    expect(calm.letterGlows.every((g) => g === null)).toBe(true);
    // only the lit copy hops: it alone shows where a letter is lit
    expect(calm.moveBase.every((m) => !m)).toBe(true);
    expect(calm.emphasis).toBe(false);
  });

  it("lights a held word letter by letter, each letter lifting further and blooming to the end", () => {
    const shape = shapeOf("night", [{ text: "night" }]);
    const word = { start: 6790, end: 8250 };
    const plan = planWord(word, "night", shape, motion);
    expect(plan.emphasis).toBe(true);
    expect(plan.letterGlows.every((g) => g !== null)).toBe(true);
    // a held syllable's letters rise while they light: both copies move
    expect(plan.moveBase.every((m) => m)).toBe(true);
    const lifts = plan.letters.map((l) => -Math.min(...(l?.frames ?? []).map(yOfFrame)));
    const wordLift = -Math.min(...(plan.pop?.frames ?? []).map(yOfFrame));
    expect(Math.min(...lifts)).toBeGreaterThan(wordLift * 1.2);
    // the wipe eases out across the held word: sampled, not two keyframes
    expect(plan.window?.frames.length).toBeGreaterThan(4);
    const rest = letterRest(word, "night", shape, true);
    expect(rest.every((r) => r !== "")).toBe(true);
    expect(letterRest(word, "night", shape, false).every((r) => r === "")).toBe(true);
    expect(letterRest({ start: 0, end: 300 }, "night", shape, true).every((r) => r === "")).toBe(true);
  });

  it("only fades color and glow under reduced motion", () => {
    const shape = shapeOf("bridge", [{ text: "bridge" }]);
    const plan = planWord({ start: 5800, end: 6150 }, "bridge", shape, { energy: 1, motion: false });
    expect(plan.pop).toBeNull();
    expect(plan.window).toBeNull();
    expect(plan.letters.every((l) => l === null)).toBe(true);
    expect(plan.litFade?.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(plan.glow?.frames.map((f) => f.opacity)).toEqual([0, 0.6, 0.6, 0]);
  });

  it("still lights a word with no time to it, at once when its time comes", () => {
    const shape = shapeOf("x", [{ text: "x" }]);
    const plan = planWord({ start: 100, end: 100 }, "x", shape, motion);
    expect(plan.window?.t0).toBe(100);
    expect(plan.window?.duration).toBe(1);
    expect(xOfFrame(plan.window?.frames[plan.window.frames.length - 1])).toBe(0);
  });
});

describe("a song's energy", () => {
  const lines = (wordsPerSecond: number): Pick<Line, "words">[] =>
    Array.from({ length: 4 }, (_, l) => ({
      words: Array.from({ length: 8 }, (_, i) => ({ text: "la ", start: l * 5000 + (i * 1000) / wordsPerSecond, end: l * 5000 + ((i + 1) * 1000) / wordsPerSecond })),
    }));
  it("rises with how fast the song is sung", () => {
    expect(songEnergy(lines(1.5))).toBeCloseTo(0, 9);
    expect(songEnergy(lines(3))).toBeGreaterThan(0.3);
    expect(songEnergy(lines(3))).toBeLessThan(0.6);
    expect(songEnergy(lines(6))).toBe(1);
    expect(songEnergy([])).toBe(0.4);
  });
});

describe("instrumental breaks", () => {
  const sung = (start: number, end: number): Pick<Line, "start" | "end" | "words"> => ({ start, end, words: [{ text: "la", start, end }] });

  it("are the intro and every gap of three seconds or more", () => {
    const lines = [sung(4000, 6000), sung(7000, 8000), sung(12_000, 13_000), sung(14_000, 15_000)];
    expect(findInterludes(lines)).toEqual([
      { next: 0, start: 0, end: 4000 },
      { next: 2, start: 8000 + INTERLUDE_LEAD_MS, end: 12_000 },
    ]);
    expect(findInterludes([sung(1000, 2000)])).toEqual([]);
  });

  it("count from the last sung word, in a real song with an empty stamp", () => {
    const lines = parseLrc(paperLanterns, 24_000).filter((l) => l.words.length > 0);
    const breaks = findInterludes(lines);
    expect(breaks).toEqual([{ next: 2, start: 8500 + INTERLUDE_LEAD_MS, end: 12_500 }]);
    expect(interludeAt(breaks, 8949)).toBeNull();
    expect(interludeAt(breaks, 8950)).toEqual(breaks[0]);
    expect(interludeAt(breaks, 12_499)).toEqual(breaks[0]);
    expect(interludeAt(breaks, 12_500)).toBeNull();
  });

  it("light their dots one after another, and pop out at the end", () => {
    const plan = planDots({ next: 2, start: 10_000, end: 16_000 }, 20, true);
    const group = plan.group.transform.frames;
    expect(String(group[0]?.transform)).toBe("scale(0)");
    expect(String(group[group.length - 1]?.transform)).toBe("scale(0)");
    expect(Math.max(...group.map((f) => Number(/scale\(([\d.]+)\)/u.exec(String(f.transform))?.[1])))).toBeGreaterThan(1.1);
    // when each dot reaches full brightness
    const lit = plan.dots.map((d) => {
      const f = d.frames.find((k) => Number(k.opacity) > 0.95);
      return Number(f?.offset) * d.duration;
    });
    expect(lit[0]).toBeLessThan(lit[1] ?? 0);
    expect(lit[1]).toBeLessThan(lit[2] ?? 0);
    expect(lit[2]).toBeLessThan(6000);
    expect(plan.until).toBeGreaterThan(16_000);
    const calm = planDots({ next: 2, start: 10_000, end: 16_000 }, 20, false);
    expect(calm.dots.every((d) => d.frames.every((f) => f.transform === "translate(0px, 0px) scale(1)"))).toBe(true);
  });
});

/** Just enough of a Web Animation for the song timeline. */
class Anim {
  startTime: number | null = null;
  currentTime: number | null = null;
  paused = false;
  cancelled = false;
  pause(): void {
    this.paused = true;
  }
  cancel(): void {
    this.cancelled = true;
  }
}

function element(): { el: Element; anims: Anim[] } {
  const anims: Anim[] = [];
  const el = {
    animate: (): Anim => {
      const a = new Anim();
      anims.push(a);
      return a;
    },
  } as unknown as Element;
  return { el, anims };
}

describe("the song timeline", () => {
  const frames: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];

  it("starts animations at their song time on the document timeline", () => {
    const tl = new SongTimeline();
    tl.sync({ t: 10_000, running: true, rate: 1 }, 500);
    const { el, anims } = element();
    tl.play(el, frames, 10_250, 300, "w");
    expect(anims[0]?.startTime).toBe(750);
    expect(tl.perfOf(9000)).toBe(-500);
  });

  it("stays put on its anchor through small jitter, and moves everything on a jump", () => {
    const tl = new SongTimeline();
    tl.sync({ t: 10_000, running: true, rate: 1 }, 500);
    const { el, anims } = element();
    tl.play(el, frames, 10_000, 1000, "w");
    expect(tl.sync({ t: 10_105, running: true, rate: 1 }, 600).moved).toBe(0);
    expect(anims[0]?.startTime).toBe(500);
    const jump = tl.sync({ t: 15_200, running: true, rate: 1 }, 700);
    expect(jump.moved).toBe(5000);
    expect(anims[0]?.startTime).toBe(700 - 5200);
  });

  it("follows a slew closely and says so, so frames keep coming", () => {
    const tl = new SongTimeline();
    tl.sync({ t: 10_000, running: true, rate: 1 }, 0);
    const { el, anims } = element();
    tl.play(el, frames, 10_000, 1000, "w");
    const slew = tl.sync({ t: 10_013, running: true, rate: 0.8 }, 16);
    expect(slew.slewing).toBe(true);
    expect(slew.moved).toBe(-3);
    expect(anims[0]?.startTime).toBe(3);
  });

  it("holds everything at its song time while paused, a seek included, and resumes on the song", () => {
    const tl = new SongTimeline();
    tl.sync({ t: 10_000, running: true, rate: 1 }, 0);
    const { el, anims } = element();
    tl.play(el, frames, 10_000, 1000, "w");
    tl.sync({ t: 10_400, running: false, rate: 0 }, 400);
    expect(anims[0]?.paused).toBe(true);
    expect(anims[0]?.currentTime).toBe(400);
    expect(tl.perfOf(0)).toBeNull();
    // a seek while paused, and an animation started while paused
    tl.sync({ t: 10_600, running: false }, 900);
    expect(anims[0]?.currentTime).toBe(600);
    tl.play(el, frames, 10_500, 300, "w");
    expect(anims[1]?.paused).toBe(true);
    expect(anims[1]?.currentTime).toBe(100);
    tl.sync({ t: 10_600, running: true, rate: 1 }, 5000);
    expect(anims[0]?.startTime).toBe(4400);
    expect(anims[1]?.startTime).toBe(4900);
  });

  it("cancels one group, and forgets what has ended", () => {
    const tl = new SongTimeline();
    tl.sync({ t: 0, running: true, rate: 1 }, 0);
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
    expect(lineLevel(1)).toBeLessThan(0.6);
    expect(lineLevel(2)).toBeLessThan(lineLevel(1));
    expect(lineLevel(3.5)).toBe(0);
  });
});
