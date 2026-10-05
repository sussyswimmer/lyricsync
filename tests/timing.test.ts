import { describe, expect, it } from "vitest";
import {
  LAST_WORD_HOLD_MS,
  LINE_GAP_MS,
  MAX_WORD_MS,
  PLAIN_LINE_MS,
  isKnownDuration,
  lineAt,
  pacePlain,
  progress,
  splitWords,
  spreadWords,
  syllables,
  timeWords,
} from "../src/core/timing";

const durations = (words: { start: number; end: number }[]): number[] => words.map((w) => w.end - w.start);
const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

describe("syllables", () => {
  it.each([
    ["a", 1],
    ["the", 1],
    ["beautiful", 3],
    ["like", 1],
    ["we're", 1],
    ["little", 2],
    ["awake,", 2],
    ["hmm", 1],
    ["—", 0],
    ["2024", 4],
    ["người", 1],
    ["ơi,", 1],
    ["любовь", 2],
    ["愛", 1],
    ["きゃ", 1],
    ["사랑", 2],
  ])("%s → %i", (word, count) => {
    expect(syllables(word)).toBe(count);
  });
});

describe("splitWords", () => {
  it("splits on whitespace and keeps one trailing space per word", () => {
    expect(splitWords("  Hold   on,\tthe city  ")).toEqual(["Hold ", "on, ", "the ", "city"]);
  });

  it("splits CJK per character with small kana, ー and punctuation attached", () => {
    expect(splitWords("愛してる")).toEqual(["愛", "し", "て", "る"]);
    expect(splitWords("きゃりー")).toEqual(["きゃ", "りー"]);
    expect(splitWords("「愛」してる!")).toEqual(["「愛」", "し", "て", "る!"]);
    expect(splitWords("我爱你 baby")).toEqual(["我", "爱", "你 ", "baby"]);
  });

  it("joins back to the normalized text", () => {
    for (const text of ["(oh) whoa—oh, yeah!", "사랑해 사랑해", "it's 2am 你好吗？ fine"]) {
      expect(splitWords(text).join("")).toBe(text);
    }
  });

  it("returns nothing for blank text", () => {
    expect(splitWords("   ")).toEqual([]);
  });
});

describe("timeWords (no word tags)", () => {
  it("returns nothing for no words", () => {
    expect(timeWords([], 0, 1000)).toEqual([]);
  });

  it("lays words end to end from the line start", () => {
    const words = timeWords(splitWords("The rain writes cursive on the window"), 800, 4250);
    expect(words[0]?.start).toBe(800);
    words.slice(1).forEach((w, i) => expect(w.start).toBe(words[i]?.end));
    expect(last(words)?.end).toBeCloseTo(4250);
  });

  it("holds the last word up to 600 ms", () => {
    expect(durations(timeWords(["a ", "a ", "a"], 0, 3000))).toEqual([800, 800, 800 + LAST_WORD_HOLD_MS]);
  });

  it("scales the hold down on short lines", () => {
    expect(durations(timeWords(["a ", "a"], 0, 1000))).toEqual([400, 600]);
  });

  it("gives words with more syllables more time", () => {
    const [a, beautiful, day] = durations(timeWords(splitWords("a beautiful day"), 0, 3000));
    expect(beautiful).toBeGreaterThan((a ?? 0) * 2);
    expect(beautiful).toBeGreaterThan(day ?? 0);
  });

  it("caps each word at 1.6 s and leaves the slack at the end of the line", () => {
    const words = timeWords(["Hold ", "on"], 0, 20_000);
    expect(durations(words)).toEqual([MAX_WORD_MS, MAX_WORD_MS]);
    expect(last(words)?.end).toBe(2 * MAX_WORD_MS);
  });

  it("caps a single word too", () => {
    expect(timeWords(["Oh"], 5000, 6000)).toEqual([{ text: "Oh", start: 5000, end: 6000 }]);
    expect(timeWords(["Ohhh"], 5000, 15_000)).toEqual([{ text: "Ohhh", start: 5000, end: 5000 + MAX_WORD_MS }]);
  });

  it("collapses to the line start when the line has no length", () => {
    expect(timeWords(["a ", "b"], 5000, 5000).every((w) => w.start === 5000 && w.end === 5000)).toBe(true);
    expect(timeWords(["a ", "b"], 5000, 4000).every((w) => w.start === 5000 && w.end === 5000)).toBe(true);
  });
});

describe("spreadWords (known bounds)", () => {
  it("fills the span exactly, split by weight", () => {
    const words = spreadWords(["one ", "two"], 10_000, 12_000);
    expect(words).toEqual([
      { text: "one ", start: 10_000, end: 11_000 },
      { text: "two", start: 11_000, end: 12_000 },
    ]);
  });

  it("ignores the hold and the cap", () => {
    expect(durations(spreadWords(["la"], 0, 5000))).toEqual([5000]);
  });

  it("returns nothing for no words", () => {
    expect(spreadWords([], 0, 1000)).toEqual([]);
  });
});

describe("pacePlain", () => {
  it("paces non-empty lines evenly across the duration and flags them unsynced", () => {
    const { lines, unsynced } = pacePlain("One\n\nTwo two\r\n  Three  \n", 9000);
    expect(unsynced).toBe(true);
    expect(lines.map((l) => [l.text, l.start, l.end])).toEqual([
      ["One", 0, 3000 - LINE_GAP_MS],
      ["Two two", 3000, 6000 - LINE_GAP_MS],
      ["Three", 6000, 9000],
    ]);
    expect(lines[1]?.words.map((w) => w.text)).toEqual(["Two ", "two"]);
  });

  it("uses a fixed pace when the duration is unknown", () => {
    const { lines } = pacePlain("a\nb", 0);
    expect(lines.map((l) => [l.start, l.end])).toEqual([
      [0, PLAIN_LINE_MS - LINE_GAP_MS],
      [PLAIN_LINE_MS, 2 * PLAIN_LINE_MS],
    ]);
  });

  it("handles empty lyrics", () => {
    expect(pacePlain(" \n\n", 1000)).toEqual({ lines: [], unsynced: true });
  });
});

describe("lineAt", () => {
  const lines = [{ start: 1000 }, { start: 2000 }, { start: 3000 }];

  it("is -1 before the first line and with no lines", () => {
    expect(lineAt(lines, 999)).toBe(-1);
    expect(lineAt([], 5000)).toBe(-1);
  });

  it("finds the last line that has started", () => {
    expect([1000, 1999, 2000, 2999, 99_999].map((t) => lineAt(lines, t))).toEqual([0, 0, 1, 1, 2]);
  });

  it("searches long sheets", () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ start: i * 10 }));
    expect(lineAt(many, 5555)).toBe(555);
  });
});

describe("progress", () => {
  it("runs 0 → 1 across the word", () => {
    const word = { start: 1000, end: 2000 };
    expect([999, 1000, 1500, 2000, 2500].map((t) => progress(word, t))).toEqual([0, 0, 0.5, 1, 1]);
  });

  it("jumps straight to 1 for a zero-length word", () => {
    expect(progress({ start: 1000, end: 1000 }, 999)).toBe(0);
    expect(progress({ start: 1000, end: 1000 }, 1000)).toBe(1);
  });
});

describe("isKnownDuration", () => {
  it("accepts only positive finite durations", () => {
    expect([1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY].map(isKnownDuration)).toEqual([true, false, false, false, false]);
  });
});
