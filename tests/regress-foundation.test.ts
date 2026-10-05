import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../contract/contract";
import { MOCK_TRACKS } from "../src/bridge/mock";
import { parseLrc } from "../src/core/lrc";
import { pacePlain, progress, wordState, type Timeline } from "../src/core/timing";
import { resolveLook, shadowLayers, type Frame, type Look } from "../src/overlay/look";
import { neighborScale, projection, slotPerPx, stackOffsets } from "../src/overlay/modes/drift";
import { cueAt, cueMap, lookKeys, untilNextChange } from "../src/overlay/stage";
import neonMonsoon from "./fixtures/neon-monsoon.lrc?raw";
import paperLanterns from "./fixtures/paper-lanterns.lrc?raw";

const FRAME: Frame = { width: 1280, height: 720, dpr: 1, motion: true, unsynced: false };
const look = (over: Partial<Settings> = {}, frame: Partial<Frame> = {}): Look =>
  resolveLook({ ...structuredClone(DEFAULT_SETTINGS), ...over }, null, { ...FRAME, ...frame });

// Regression (word-boundary-late): modes lit a word only once progress() > 0, i.e. one ms after it
// started, while the scheduler counted a boundary at exactly t as passed. A frame landing on a word's
// start drew it unlit and then slept up to 250 ms.
describe("wordState", () => {
  const word = { start: 1000, end: 1500 };

  it("is active from the very first millisecond of the word, [start, end)", () => {
    expect(wordState(word, 999.9)).toBe("upcoming");
    expect(wordState(word, 1000)).toBe("active");
    expect(wordState(word, 1499.9)).toBe("active");
    expect(wordState(word, 1500)).toBe("sung");
  });

  it("takes a zero-length word straight from upcoming to sung, like progress does", () => {
    const blink = { start: 2000, end: 2000 };
    expect(wordState(blink, 1999)).toBe("upcoming");
    expect(wordState(blink, 2000)).toBe("sung");
    expect(progress(blink, 2000)).toBe(1);
  });

  it("differs from progress only at a word's first millisecond", () => {
    expect(progress(word, 1000)).toBe(0);
    for (const t of [0, 999, 1001, 1250, 1500, 9000]) {
      const p = progress(word, t);
      expect(wordState(word, t) !== "upcoming", `t=${t}`).toBe(p > 0);
      expect(wordState(word, t) === "active", `t=${t}`).toBe(p > 0 && p < 1);
    }
  });
});

/** What the modes paint at `t`, by wordState: focus line, waiting, and each word upcoming/active/sung. */
function painted(map: ReturnType<typeof cueMap>, t: number): string {
  const cue = cueAt(map, t);
  const focus = cue.line >= 0 ? map.lyrics[cue.line] : undefined;
  const words = map.unsynced ? "" : (focus?.words ?? []).map((w) => (cue.waiting ? "upcoming" : wordState(w, t))[0]).join("");
  return `${cue.line}/${cue.waiting}/${words}`;
}

describe("scheduling against what the modes paint", () => {
  const sampler = MOCK_TRACKS[5];
  const timelines: [string, Timeline][] = [
    ["enhanced LRC (Paper Lanterns)", { lines: parseLrc(paperLanterns, 24_000), unsynced: false }],
    ["line-level LRC (Neon Monsoon)", { lines: parseLrc(neonMonsoon, 35_000), unsynced: false }],
    ["the script sampler", { lines: parseLrc(sampler?.synced ?? "", sampler?.durationMs ?? 0), unsynced: false }],
    ["paced plain lyrics", pacePlain("First placeholder line\nSecond one\nThird and last", 30_000)],
  ];

  it.each(timelines)("a frame exactly on a word start paints it, then sleeps no further than the next change: %s", (_name, timeline) => {
    const map = cueMap(timeline);
    for (const b of map.boundaries) {
      const sleep = untilNextChange(map, b);
      expect(sleep, `t=${b}`).toBeGreaterThan(0);
      const now = painted(map, b);
      // nothing painted differently anywhere inside the sleep
      const end = Number.isFinite(sleep) ? b + sleep : b + 1e6;
      for (const p of [b + 0.25, b + sleep / 2, end - 0.01]) if (p > b && p < end) expect(painted(map, p), `woken at ${b}, probe ${p}`).toBe(now);
    }
  });

  it("lights every tagged word at its own start (Paper Lanterns)", () => {
    const map = cueMap({ lines: parseLrc(paperLanterns, 24_000), unsynced: false });
    for (const line of map.lyrics) {
      for (const w of line.words) {
        if (w.end > w.start) expect(wordState(w, w.start)).toBe("active");
      }
    }
  });
});

// Regression (stage-rebuild-paint-only): every glow, color or opacity step tore down and re-measured the mode.
describe("lookKeys", () => {
  const base = lookKeys(look(), "drift");

  it("ignores opacity entirely: the stage root applies it", () => {
    expect(lookKeys(look({ opacity: 35 }), "drift")).toEqual(base);
  });

  it("puts colors and glow in the paint key only", () => {
    const glow = lookKeys(look({ glow: 90 }), "drift");
    expect(glow.shape).toBe(base.shape);
    expect(glow.paint).not.toBe(base.paint);
    const colors = lookKeys(look({ colors: { lyric: "#ffffff", highlight: "#00ff88", dim: "#444444" } }), "drift");
    expect(colors.shape).toBe(base.shape);
    expect(colors.paint).not.toBe(base.paint);
  });

  it("rebuilds for anything that moves or measures text", () => {
    for (const over of [{ size: 80 }, { yPos: 20 }, { curve: 10 }, { font: { family: "Syne", weight: 800 } }] as Partial<Settings>[]) {
      expect(lookKeys(look(over), "drift").shape, JSON.stringify(over)).not.toBe(base.shape);
    }
    expect(lookKeys(look({}, { width: 900 }), "drift").shape).not.toBe(base.shape);
    expect(lookKeys(look({}, { motion: false }), "drift").shape).not.toBe(base.shape);
    expect(lookKeys(look(), "stack").shape).not.toBe(base.shape);
  });
});

// Regression (small-text-shadow-floor): the dark legibility shadow shrank with the text to a
// sub-pixel offset and a 1–3 px blur, so small dim lines vanished on busy wallpapers.
describe("shadowLayers at small sizes", () => {
  const l = look({ glow: 40 });
  const num = (v: string | undefined): number => Number.parseFloat(v ?? "");
  const alpha = (v: string | undefined): number => Number(/,\s*([\d.]+)\)$/u.exec(v ?? "")?.[1]);

  it("keeps the dark layers at a pixel floor, and darker, for small text", () => {
    const [tight, wide] = shadowLayers(l, 16, false);
    expect(num(tight?.[1])).toBeGreaterThanOrEqual(1);
    expect(num(tight?.[2])).toBeGreaterThanOrEqual(1.5);
    expect(num(wide?.[2])).toBeGreaterThanOrEqual(4);
    const [bigTight, bigWide] = shadowLayers(l, 58, false);
    expect(alpha(tight?.[3])).toBeGreaterThan(alpha(bigTight?.[3]));
    expect(alpha(wide?.[3])).toBeGreaterThan(alpha(bigWide?.[3]));
  });

  it("leaves the shadow at the focus sizes unchanged", () => {
    expect(shadowLayers(look({ glow: 0 }), 58, false)).toEqual([
      ["0px", "1.0px", "2.0px", "rgba(0, 0, 0, 0.400)"],
      ["0px", "0px", "8.0px", "rgba(0, 0, 0, 0.160)"],
    ]);
  });

  it("scales the shadow smoothly: never smaller for larger text", () => {
    let prev = 0;
    for (let size = 4; size <= 140; size += 2) {
      const blur = num(shadowLayers(l, size, false)[1]?.[2]);
      expect(blur, `size ${size}`).toBeGreaterThanOrEqual(prev);
      prev = blur;
    }
  });
});

// Regressions (drift-perspective-overlap, drift-wrapped-offscreen, drift-small-neighbors).
describe("Drift and Stack layout", () => {
  const LINE = 1.12;
  /** Each row's drawn half-height at `shown`: box height × its scale × its depth projection. */
  const halfDrawn = (heights: number[], i: number, shown: number, depth: number, low: number): number => {
    const dist = Math.abs(i - shown);
    return ((heights[i] ?? 0) * (1 - Math.min(dist, 1) * (1 - low)) * projection(dist, depth)) / 2;
  };

  it.each([
    ["one-row lines", [1, 1, 1, 1, 1, 1, 1, 1]],
    ["a tall wrapped line among short ones", [1, 1, 6, 1, 11, 1, 2, 1]],
    ["tall lines everywhere", [5, 7, 3, 9, 4, 6, 2, 8]],
  ])("never draws two lines over each other, gliding or at rest: %s", (_name, rows) => {
    for (const depth of [0, 1]) {
      for (const size of [14, 38.7, 93]) {
        const heights = rows.map((n) => n * size * LINE);
        const low = neighborScale(size, depth);
        for (let shown = 0; shown <= rows.length - 1; shown += 0.05) {
          const at = stackOffsets(heights, shown, depth, slotPerPx(low));
          const placed = [...at.keys()].sort((a, b) => a - b);
          for (let k = 1; k < placed.length; k++) {
            const i = placed[k - 1] ?? 0;
            const j = placed[k] ?? 0;
            const bottom = (at.get(i) ?? 0) + halfDrawn(heights, i, shown, depth, low);
            const top = (at.get(j) ?? 0) - halfDrawn(heights, j, shown, depth, low);
            expect(top - bottom, `depth ${depth} size ${size} shown ${shown.toFixed(2)} rows ${i}/${j}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("puts the line in focus exactly on the focus position at rest", () => {
    const heights = [1, 3, 1, 2].map((n) => n * 40 * LINE);
    for (let i = 0; i < heights.length; i++) expect(stackOffsets(heights, i, 1, slotPerPx(0.58)).get(i)).toBe(0);
  });

  it("moves every line continuously through a glide, across whole-line crossings too", () => {
    const heights = [1, 4, 1, 2, 1].map((n) => n * 40 * LINE);
    for (const depth of [0, 1]) {
      for (let shown = 0.9; shown < 3.1; shown += 0.001) {
        const a = stackOffsets(heights, shown, depth, slotPerPx(0.58));
        const b = stackOffsets(heights, shown + 0.001, depth, slotPerPx(0.58));
        for (const [i, y] of a) if (b.has(i)) expect(Math.abs((b.get(i) ?? 0) - y), `depth ${depth} shown ${shown} row ${i}`).toBeLessThan(1);
      }
    }
  });

  it("keeps Stack's one-row spacing from the prototype: 1.15 font sizes", () => {
    const at = stackOffsets([1, 1, 1].map(() => 40 * LINE), 1, 0, slotPerPx(0.58));
    expect(at.get(0)).toBeCloseTo(-46, 6);
    expect(at.get(2)).toBeCloseTo(46, 6);
  });

  it("raises neighbors at small sizes so they still draw at least 11 px, within limits", () => {
    expect(neighborScale(38.7, 0)).toBe(0.58);
    expect(neighborScale(38.7, 1)).toBe(0.58);
    expect(14.67 * neighborScale(14.67, 0)).toBeGreaterThanOrEqual(11);
    expect(20 * neighborScale(20, 1) * projection(1, 1)).toBeCloseTo(11, 6);
    // never as large as the focus line: the hierarchy stays
    expect(neighborScale(4, 1)).toBe(0.85);
  });
});

// Regression (mock-qa-track): C8's visual QA cases had no mock track.
describe("the script sampler mock track", () => {
  const sampler = MOCK_TRACKS[5];
  const lines = parseLrc(sampler?.synced ?? "", sampler?.durationMs ?? 0).filter((l) => l.words.length > 0);

  it("keeps the demo tracks where QA links expect them and adds the sampler last", () => {
    expect(MOCK_TRACKS.slice(0, 5).map((t) => t.title)).toEqual([
      "Neon Monsoon",
      "Paper Lanterns",
      "Letters Never Sent",
      "Ultraviolet Static",
      "Tidal Interlude",
    ]);
    expect(sampler).toMatchObject({ title: "Script Sampler", status: "found" });
  });

  it("covers CJK, Vietnamese, long, many-word, one-word and right-to-left lines", () => {
    const texts = lines.map((l) => l.text);
    expect(texts.some((t) => /\p{Script=Han}/u.test(t) && /\p{Script=Hiragana}/u.test(t))).toBe(true);
    expect(texts.some((t) => /^\p{Script=Han}+$/u.test(t))).toBe(true);
    expect(texts.some((t) => /\p{Script=Hangul}/u.test(t))).toBe(true);
    expect(texts.some((t) => /[ốẫờộềữ]/u.test(t) && /ĐẤT/u.test(t))).toBe(true);
    expect(Math.max(...texts.map((t) => t.length))).toBeGreaterThanOrEqual(110);
    expect(Math.max(...texts.map((t) => t.split(" ").length))).toBeGreaterThanOrEqual(16);
    expect(texts.some((t) => !/\s/u.test(t) && /^\p{L}+$/u.test(t))).toBe(true);
    expect(texts.some((t) => /\p{Script=Arabic}/u.test(t) && /[!?]$/u.test(t))).toBe(true);
    expect(texts.some((t) => /\p{Script=Hebrew}/u.test(t))).toBe(true);
  });

  it("times the per-character tags of the Chinese line", () => {
    const zh = lines.find((l) => /^\p{Script=Han}+$/u.test(l.text));
    expect(zh?.words.map((w) => w.start)).toEqual([5000, 5400, 5800, 6200, 6600, 7000, 7400, 7800, 8200]);
  });
});
