import { describe, expect, it } from "vitest";
import type { Line } from "../src/core/lrc";
import { parseLrc } from "../src/core/lrc";
import { pacePlain, type Timeline } from "../src/core/timing";
import { LINGER_MS, cueAt, cueMap, untilNextChange } from "../src/overlay/stage";
import neonMonsoon from "./fixtures/neon-monsoon.lrc?raw";
import paperLanterns from "./fixtures/paper-lanterns.lrc?raw";

/** A line from [text, start, end] word triples; no words makes an instrumental gap. */
function line(start: number, end: number, words: [string, number, number][] = []): Line {
  return {
    start,
    end,
    text: words.map(([t]) => t).join(""),
    words: words.map(([text, s, e]) => ({ text, start: s, end: e })),
  };
}

/**
 * Two lines with a marked instrumental break between them and a trailing gap:
 *   1000 "one two" (words end 2400) · 3000 gap · 8000 "three four" (words end 10000) · 12000 gap
 */
const SONG: Timeline = {
  unsynced: false,
  lines: [
    line(1000, 2650, [
      ["one ", 1000, 1500],
      ["two", 1500, 2400],
    ]),
    line(3000, 7650),
    line(8000, 11650, [
      ["three ", 8000, 9000],
      ["four", 9000, 10000],
    ]),
    line(12000, 20000),
  ],
};

/** A long break the LRC doesn't mark: the first line's words end at 2000, the next starts at 10 000. */
const UNMARKED: Timeline = {
  unsynced: false,
  lines: [
    line(1000, 9650, [
      ["hi ", 1000, 1400],
      ["there", 1400, 2000],
    ]),
    line(10000, 12000, [["again", 10000, 11000]]),
  ],
};

describe("cueMap", () => {
  it("drops gaps from the lyric lines and maps each line to its lyric index", () => {
    const map = cueMap(SONG);
    expect(map.all).toBe(SONG.lines);
    expect(map.lyrics).toEqual([SONG.lines[0], SONG.lines[2]]);
    expect(map.lyricOf).toEqual([0, -1, 1, -1]);
    expect(map.nextLyric).toEqual([1, 1, -1, -1]);
    expect(map.unsynced).toBe(false);
  });

  it("collects every visible change: line starts, word bounds and linger ends, sorted and unique", () => {
    expect(cueMap(SONG).boundaries).toEqual([1000, 1500, 2400, 3000, 2400 + LINGER_MS, 8000, 9000, 10000, 12000, 10000 + LINGER_MS]);
  });

  it("handles an empty timeline", () => {
    const map = cueMap({ lines: [], unsynced: false });
    expect(map).toMatchObject({ lyrics: [], lyricOf: [], nextLyric: [], boundaries: [] });
  });
});

describe("cueAt", () => {
  const map = cueMap(SONG);

  it("shows the first line waiting before it starts", () => {
    expect(cueAt(map, 0)).toEqual({ line: 0, waiting: true, t: 0 });
    expect(cueAt(map, 999)).toEqual({ line: 0, waiting: true, t: 999 });
  });

  it("is on a line from its first stamp until the next line", () => {
    expect(cueAt(map, 1000)).toEqual({ line: 0, waiting: false, t: 1000 });
    expect(cueAt(map, 2700)).toEqual({ line: 0, waiting: false, t: 2700 });
    expect(cueAt(map, 8500)).toEqual({ line: 1, waiting: false, t: 8500 });
  });

  it("shows the next line waiting during a marked instrumental gap", () => {
    expect(cueAt(map, 3000)).toEqual({ line: 1, waiting: true, t: 3000 });
    expect(cueAt(map, 7999)).toEqual({ line: 1, waiting: true, t: 7999 });
  });

  it("shows nothing after the trailing gap starts", () => {
    expect(cueAt(map, 11_999)).toEqual({ line: 1, waiting: false, t: 11_999 });
    expect(cueAt(map, 12_000)).toEqual({ line: -1, waiting: false, t: 12_000 });
    expect(cueAt(map, 1e9)).toEqual({ line: -1, waiting: false, t: 1e9 });
  });

  it("starts with the first lyric waiting when the song opens with a gap", () => {
    const intro = cueMap({ unsynced: false, lines: [line(0, 4650), line(5000, 8000, [["la", 5000, 6000]])] });
    expect(cueAt(intro, 100)).toEqual({ line: 0, waiting: true, t: 100 });
    expect(cueAt(intro, 5000)).toEqual({ line: 0, waiting: false, t: 5000 });
  });

  it("has no line at all for an empty timeline or one with only gaps", () => {
    expect(cueAt(cueMap({ lines: [], unsynced: false }), 500).line).toBe(-1);
    expect(cueAt(cueMap({ unsynced: false, lines: [line(0, 9000)] }), 500)).toEqual({ line: -1, waiting: false, t: 500 });
  });
});

describe("cueAt: linger", () => {
  const map = cueMap(UNMARKED);

  it("holds the sung line for LINGER_MS after its last word", () => {
    // The exact instant 2000 + LINGER_MS is left to the it.fails test in "untilNextChange" below.
    expect(cueAt(map, 2001)).toEqual({ line: 0, waiting: false, t: 2001 });
    expect(cueAt(map, 2000 + LINGER_MS - 1)).toEqual({ line: 0, waiting: false, t: 2000 + LINGER_MS - 1 });
  });

  it("then shows the next line waiting through the rest of an unmarked break", () => {
    expect(cueAt(map, 2001 + LINGER_MS)).toEqual({ line: 1, waiting: true, t: 2001 + LINGER_MS });
    expect(cueAt(map, 9999)).toEqual({ line: 1, waiting: true, t: 9999 });
    expect(cueAt(map, 10_000)).toEqual({ line: 1, waiting: false, t: 10_000 });
  });

  it("keeps the last line up after it ends: there is nothing to wait for", () => {
    expect(cueAt(map, 60_000)).toEqual({ line: 1, waiting: false, t: 60_000 });
  });

  it("does not apply to unsynced timelines", () => {
    const calm = cueMap({ ...UNMARKED, unsynced: true });
    expect(cueAt(calm, 2001 + LINGER_MS)).toEqual({ line: 0, waiting: false, t: 2001 + LINGER_MS });
    expect(cueAt(calm, 9999).line).toBe(0);
  });

  it("does not apply to evenly paced plain lyrics either", () => {
    const plain = pacePlain("First placeholder line\nSecond placeholder line", 60_000);
    const calm = cueMap(plain);
    expect(calm.unsynced).toBe(true);
    expect(cueAt(calm, 29_000)).toEqual({ line: 0, waiting: false, t: 29_000 });
    expect(cueAt(calm, 30_000).line).toBe(1);
  });
});

describe("cueAt on a parsed enhanced LRC", () => {
  const map = cueMap({ lines: parseLrc(paperLanterns, 24_000), unsynced: false });

  it("walks the fixture's lines and its marked gap", () => {
    expect(map.lyrics.map((l) => l.text.split(" ")[0])).toEqual(["Paper", "Counting", "Fold", "Light"]);
    expect(cueAt(map, 500)).toMatchObject({ line: 0, waiting: true });
    expect(cueAt(map, 4300)).toMatchObject({ line: 1, waiting: false });
    expect(cueAt(map, 9500)).toMatchObject({ line: 2, waiting: true });
    expect(cueAt(map, 13_000)).toMatchObject({ line: 2, waiting: false });
    expect(cueAt(map, 23_999)).toMatchObject({ line: 3, waiting: false });
  });
});

describe("untilNextChange", () => {
  const map = cueMap(SONG);

  it("counts down to the next boundary", () => {
    expect(untilNextChange(map, 0)).toBe(1000);
    expect(untilNextChange(map, 999)).toBe(1);
    expect(untilNextChange(map, 1200)).toBe(300);
    expect(untilNextChange(map, 2400)).toBe(600);
    expect(untilNextChange(map, 4000)).toBe(2400 + LINGER_MS - 4000);
  });

  it("looks past a boundary it is sitting on", () => {
    expect(untilNextChange(map, 1000)).toBe(500);
    expect(untilNextChange(map, 1500)).toBe(900);
    expect(untilNextChange(map, 10_000)).toBe(2000);
  });

  it("works between fractional times", () => {
    expect(untilNextChange(map, 1499.5)).toBeCloseTo(0.5);
  });

  it("is Infinity once nothing else will change", () => {
    expect(untilNextChange(map, 10_000 + LINGER_MS - 1)).toBe(1);
    expect(untilNextChange(map, 10_000 + LINGER_MS)).toBe(Number.POSITIVE_INFINITY);
    expect(untilNextChange(map, 1e9)).toBe(Number.POSITIVE_INFINITY);
    expect(untilNextChange(cueMap({ lines: [], unsynced: false }), 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it.each([
    ["the two-line song", SONG],
    ["enhanced LRC (Paper Lanterns)", { lines: parseLrc(paperLanterns, 24_000), unsynced: false }],
    ["line-level LRC with fallback word timing (Neon Monsoon)", { lines: parseLrc(neonMonsoon, 35_000), unsynced: false }],
    ["paced plain lyrics", pacePlain("First placeholder line\nSecond one\nThird and last", 30_000)],
  ] as const)("never sleeps through a visible change: %s", (_name, timeline) => {
    const map = cueMap(timeline);
    for (const t of wakeTimes(map)) {
      const sleep = untilNextChange(map, t);
      expect(sleep, `t=${t}`).toBeGreaterThan(0);
      expect(firstChange(map, t, sleep), `woken at t=${t}, slept ${sleep} ms`).toBeNull();
    }
  });

  it("never sleeps through the linger hand-off on an unmarked break, between boundaries", () => {
    const map = cueMap(UNMARKED);
    const exact = new Set(map.boundaries);
    for (const t of wakeTimes(map).filter((x) => !exact.has(x))) {
      expect(firstChange(map, t, untilNextChange(map, t)), `woken at t=${t}`).toBeNull();
    }
  });

  // BUG (src/overlay/stage.ts cueAt vs cueMap): every other change takes effect AT its boundary
  // (lineAt uses start <= t, word states flip at t >= start / t >= end), and untilNextChange skips a
  // boundary the clock is sitting on. The linger hand-off alone uses a strict `t > lastEnd + LINGER_MS`,
  // so a frame that lands exactly on lastEnd + LINGER_MS still shows the old line and is told to sleep
  // until the next line starts (5500 ms here). The controller's 250 ms MAX_SLEEP_MS cap hides most of
  // it, so the next line appears as "upcoming" up to 250 ms late. Clock positions are integer ms
  // (Date.now()-based), so landing exactly on the boundary is not rare.
  // Repro: cueAt(cueMap(UNMARKED), 4500) → line 0; untilNextChange(…, 4500) → 5500; cueAt(…, 4501) → line 1 waiting.
  // Fix: `t >= lastEnd + LINGER_MS` in cueAt.
  it.fails("never sleeps through the linger hand-off when woken exactly on it", () => {
    const map = cueMap(UNMARKED);
    const t = 2000 + LINGER_MS;
    expect(firstChange(map, t, untilNextChange(map, t))).toBeNull(); // today: changes at t + 0.5
  });
});

/** What the stage shows at `t`: the focus line, whether it waits, and each of its words as upcoming, active or sung. */
function shape(map: ReturnType<typeof cueMap>, t: number): string {
  const cue = cueAt(map, t);
  const focus = cue.line >= 0 ? map.lyrics[cue.line] : undefined;
  const words = (focus?.words ?? []).map((w) => (cue.waiting || t < w.start ? "u" : t >= w.end ? "s" : "a")).join("");
  return `${cue.line}/${cue.waiting}/${words}`;
}

/** Where the controller may wake: every boundary exactly, just either side of it, and a coarse grid. */
function wakeTimes(map: ReturnType<typeof cueMap>): number[] {
  const times = map.boundaries.flatMap((b) => [b - 0.5, b, b + 0.5]);
  for (let t = -100; t < 40_000; t += 37) times.push(t);
  return times;
}

/** The first time in (t, t + sleep) at which the shape differs from the shape at t, or null. */
function firstChange(map: ReturnType<typeof cueMap>, t: number, sleep: number): number | null {
  const before = shape(map, t);
  const end = Number.isFinite(sleep) ? t + sleep : t + 1e6;
  const probes = [t + 0.5, t + (end - t) / 3, t + (end - t) / 2, end - 0.01];
  for (const b of map.boundaries) if (b > t && b < end) probes.push(b, b + 0.5);
  return probes.filter((p) => p > t && p < end).find((p) => shape(map, p) !== before) ?? null;
}
