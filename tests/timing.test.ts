import { describe, expect, it } from "vitest";
import type { Line } from "../src/core/lrc";
import { parseLrc } from "../src/core/lrc";
import {
  LAST_WORD_HOLD_MS,
  LINE_GAP_MS,
  MAX_WORD_MS,
  PACE_QUANTILE,
  PACE_WINDOW,
  PLAIN_INTRO,
  PLAIN_LINE_MS,
  PLAIN_MIN_LINE_MS,
  PLAIN_OUTRO,
  beatsOf,
  isKnownDuration,
  lineAt,
  paceWords,
  pacePlain,
  progress,
  singingPace,
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

describe("song-paced words (lines timed by line only)", () => {
  it("counts a line's beats as its words' weights: syllables plus half a beat a word", () => {
    expect(beatsOf(splitWords("the morning light"))).toBe(1 + 2 + 1 + 3 * 0.5);
    expect(beatsOf([])).toBe(0);
  });

  /** `n` lines of 5.5 beats from `from`, one every `every` ms. */
  const steady = (n: number, from: number, every: number): { start: number; next: number; beats: number }[] =>
    Array.from({ length: n }, (_, i) => ({ start: from + i * every, next: from + (i + 1) * every, beats: 5.5 }));

  it("reads the pace from the lines around each one, so a pause after a line doesn't slow it down", () => {
    // a line every 1.1 s (5 beats a second), and one with a 6 s pause after it
    const lines = [...steady(4, 0, 1100), { start: 4400, next: 11_500, beats: 5.5 }, ...steady(5, 11_500, 1100)];
    const pace = singingPace(lines);
    for (const p of pace) expect(p).toBeCloseTo(5, 6);
  });

  it("follows the song as it speeds up and slows down from one part to the next", () => {
    // ten lines at 5 beats a second, then ten at 10, then ten at 5 again
    const lines = [...steady(10, 0, 1100), ...steady(10, 11_000, 550), ...steady(10, 16_500, 1100)];
    const pace = singingPace(lines);
    expect(pace[2]).toBeCloseTo(5, 6);
    expect(pace[15]).toBeCloseTo(10, 6);
    expect(pace[27]).toBeCloseTo(5, 6);
    // between parts it is somewhere in between, and only the lines PACE_WINDOW away count
    expect(pace[9]).toBeGreaterThan(5);
    expect(pace[9 - PACE_WINDOW]).toBeCloseTo(5, 6);
  });

  it("takes the PACE_QUANTILE of the rates near a line, leaving out gaps, and has none with too little to go by", () => {
    const rates = [2, 3, 4, 5, 6];
    const lines = rates.map((r, i) => ({ start: i * 1000, next: (i + 1) * 1000, beats: r }));
    expect(singingPace(lines)[2]).toBeCloseTo(2 + 4 * PACE_QUANTILE, 6);
    const gaps = [{ start: 0, next: 1000, beats: 5 }, { start: 1000, next: 5000, beats: 0 }, { start: 5000, next: 6000, beats: 5 }];
    expect(singingPace(gaps).every(Number.isNaN)).toBe(true);
    expect(singingPace([])).toEqual([]);
  });

  it("sings a line with room to spare at the pace, holds its last word a little, and leaves the rest of the line as a pause", () => {
    const units = splitWords("one two three four");
    // 4 + 4 * 0.5 = 6 beats at 5 a second: 1.2 s
    const words = paceWords(units, 10_000, 16_000, 5);
    const sung = timeWords(units, 10_000, 11_200);
    expect(words.slice(0, -1)).toEqual(sung.slice(0, -1));
    expect(last(words)?.end).toBe((last(sung)?.end ?? 0) + LAST_WORD_HOLD_MS);
    // never past the line's end, nor a word longer than MAX_WORD_MS
    expect(last(paceWords(units, 10_000, 11_300, 5))?.end).toBe(11_300);
    const held = paceWords(["Ohhh"], 0, 9000, 1.2);
    expect(last(held)?.end).toBe(MAX_WORD_MS);
  });

  it("fills a line the singer hurries through, or any line without a pace, as before", () => {
    const units = splitWords("a quick line with many words in it");
    expect(paceWords(units, 0, 1500, 5)).toEqual(timeWords(units, 0, 1500));
    expect(paceWords(units, 0, 6000, Number.NaN)).toEqual(timeWords(units, 0, 6000));
    expect(paceWords([], 0, 6000, 5)).toEqual([]);
  });

  it("is what parseLrc does with lines that have no word tags: a pause no longer stretches the line before it", () => {
    const rows = ["[00:00.00]one two three", "[00:01.10]four five six", "[00:02.20]seven eight nine", "[00:03.30]ten eleven twelve", "[00:10.00]thirteen fourteen", "[00:11.10]fifteen sixteen"];
    const lines = parseLrc(rows.join("\n"), 14_000);
    expect(lines.every((l) => l.estimated === true)).toBe(true);
    // a steady line fills its slot as before
    const steadyLine = lines[1] as Line;
    expect(steadyLine.words).toEqual(timeWords(splitWords(steadyLine.text), steadyLine.start, steadyLine.end));
    // the line before the pause is sung at the song's pace and done long before the next line
    const paused = lines[3] as Line;
    expect(last(paused.words)?.end).toBeLessThan(paused.start + 2500);
    expect(paused.end).toBe(10_000 - LINE_GAP_MS);
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
