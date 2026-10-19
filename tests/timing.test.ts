import { describe, expect, it } from "vitest";
import type { Line } from "../src/core/lrc";
import {
  LAST_WORD_HOLD_MS,
  LINE_FILL_MS,
  LINE_GAP_MS,
  MAX_WORD_MS,
  PLAIN_INTRO,
  PLAIN_LINE_MS,
  PLAIN_MIN_LINE_MS,
  PLAIN_OUTRO,
  WORD_FILL_MS,
  isKnownDuration,
  karaokeWords,
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
  it("paces non-empty lines after an intro and before an outro, and flags them unsynced", () => {
    const { lines, unsynced } = pacePlain("One\n\nTwo two\r\n  Three  \n", 9000);
    expect(unsynced).toBe(true);
    expect(lines.map((l) => l.text)).toEqual(["One", "Two two", "Three"]);
    expect(lines[0]?.start).toBe(PLAIN_INTRO.minMs);
    expect(lines[2]?.end).toBe(9000 - PLAIN_OUTRO.minMs);
    lines.slice(0, -1).forEach((l, i) => expect(l.end).toBeCloseTo((lines[i + 1]?.start ?? 0) - LINE_GAP_MS, 9));
    expect(lines[1]?.words.map((w) => w.text)).toEqual(["Two ", "two"]);
  });

  it("gives a line time for its syllables, and a stanza break a pause", () => {
    const span = (l: { start: number } | undefined, next: { start: number } | undefined): number => (next?.start ?? 0) - (l?.start ?? 0);
    // a long line takes longer than a short one
    const { lines } = pacePlain("hi\nevery syllable in this longer line\nhi\nhi", 120_000);
    expect(span(lines[1], lines[2])).toBeGreaterThan(2 * span(lines[0], lines[1]));
    // a blank row between stanzas leaves a gap as long as an average line
    const flat = pacePlain("one two\nthree four\nfive six", 120_000).lines;
    const stanzas = pacePlain("one two\n\nthree four\nfive six", 120_000).lines;
    expect(span(stanzas[0], stanzas[1])).toBeCloseTo(2 * span(stanzas[1], stanzas[2]), 6);
    expect(span(flat[0], flat[1])).toBeCloseTo(span(flat[1], flat[2]), 6);
  });

  it("bounds the intro and the outro, and gives them up when the lines need the room", () => {
    const long = pacePlain("a\nb", 600_000).lines;
    expect(long[0]?.start).toBe(PLAIN_INTRO.maxMs);
    expect(long[1]?.end).toBe(600_000 - PLAIN_OUTRO.maxMs);
    const song = pacePlain("a\nb", 200_000).lines;
    expect(song[0]?.start).toBeCloseTo(200_000 * PLAIN_INTRO.share, 6);
    const crowded = pacePlain(Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"), 10 * PLAIN_MIN_LINE_MS + 2000).lines;
    expect(crowded[0]?.start).toBe(0);
    expect(crowded[9]?.end).toBe(10 * PLAIN_MIN_LINE_MS + 2000);
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

describe("karaokeWords (what the karaoke draws)", () => {
  const guessed = (text: string, start: number, end: number): Line => ({ start, end, text, words: timeWords(splitWords(text), start, end), estimated: true });

  it("keeps a line timed word by word as it is", () => {
    const line: Line = { start: 1000, end: 3000, text: "as sung", words: spreadWords(splitWords("as sung"), 1000, 3000) };
    expect(karaokeWords(line)).toBe(line.words);
  });

  it("lights a line with guessed word times as a whole: quick fills one after another, each word sung to the line's end", () => {
    const line = guessed("one two three four", 10_000, 14_000);
    const words = karaokeWords(line);
    expect(words.map((w) => w.text)).toEqual(line.words.map((w) => w.text));
    expect(words.map((w) => w.start)).toEqual([10_000, 10_040, 10_080, 10_120]);
    expect(words.every((w) => w.end === 14_000)).toBe(true);
    expect(words.map((w) => w.parts)).toEqual(words.map((w) => [{ text: w.text, start: w.start, end: w.start + WORD_FILL_MS }]));
  });

  it("fills a long line within LINE_FILL_MS, and a short one within half its length", () => {
    const long = karaokeWords(guessed(Array.from({ length: 20 }, (_, i) => `w${i}`).join(" "), 0, 6000));
    const lit = (words: readonly { parts?: { end: number }[] }[]): number => Math.max(...words.map((w) => w.parts?.[0]?.end ?? 0));
    expect(lit(long)).toBeCloseTo(LINE_FILL_MS, 6);
    const short = karaokeWords(guessed("quick little line", 0, 300));
    expect(lit(short)).toBeLessThanOrEqual(150);
    expect(short.every((w) => w.end === 300)).toBe(true);
    // a lone word fills at once
    expect(karaokeWords(guessed("hey", 500, 2500)).map((w) => [w.start, w.end, w.parts?.[0]?.end])).toEqual([[500, 2500, 500 + WORD_FILL_MS]]);
    // plain lyrics are guessed too
    expect(pacePlain("a b\nc d", 10_000).lines.every((l) => l.estimated === true)).toBe(true);
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
