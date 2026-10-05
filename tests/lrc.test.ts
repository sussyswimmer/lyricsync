import { describe, expect, it } from "vitest";
import { LAST_LINE_MS, parseLrc, type Line } from "../src/core/lrc";
import { LINE_GAP_MS } from "../src/core/timing";
import neonMonsoon from "./fixtures/neon-monsoon.lrc?raw";
import paperLanterns from "./fixtures/paper-lanterns.lrc?raw";

const starts = (lines: Line[]): number[] => lines.map((l) => l.start);
const texts = (lines: Line[]): string[] => lines.map((l) => l.text);
const last = <T>(items: readonly T[] | undefined, n = 1): T | undefined => items?.[items.length - n];
const spans = (line: Line | undefined): [string, number, number][] =>
  (line?.words ?? []).map((w) => [w.text, Math.round(w.start), Math.round(w.end)]);

function expectWellFormed(lines: Line[]): void {
  lines.forEach((line, i) => {
    expect(line.end).toBeGreaterThanOrEqual(line.start);
    if (i > 0) expect(line.start).toBeGreaterThanOrEqual(lines[i - 1]?.start ?? 0);
    expect(line.words.map((w) => w.text).join("")).toBe(line.text);
    line.words.forEach((w, j) => {
      expect(w.end).toBeGreaterThanOrEqual(w.start);
      expect(w.start).toBeGreaterThanOrEqual(line.start);
      expect(w.end).toBeLessThanOrEqual(line.end);
      if (j > 0) expect(w.start).toBeGreaterThanOrEqual(line.words[j - 1]?.end ?? 0);
    });
  });
}

describe("parseLrc: line-level fixture", () => {
  const lines = parseLrc(neonMonsoon, 35_000);

  it("reads every timed line in order and skips metadata", () => {
    expect(starts(lines)).toEqual([800, 4600, 8600, 13_000, 17_200, 21_000, 24_800, 28_800, 33_000]);
    expect(lines[0]?.text).toBe("The rain writes cursive on the window");
    expect(lines[7]?.text).toBe("Let the whole sky hear us sing");
  });

  it("ends each line a gap before the next, and the last at the duration", () => {
    expect(lines[0]?.end).toBe(4600 - LINE_GAP_MS);
    expect(lines[7]?.end).toBe(33_000 - LINE_GAP_MS);
    expect(lines[8]?.end).toBe(35_000);
  });

  it("turns the empty closing stamp into a gap with no words", () => {
    expect(lines[8]).toMatchObject({ text: "", words: [] });
  });

  it("times every word inside its line, starting with the line", () => {
    expectWellFormed(lines);
    for (const line of lines.filter((l) => l.words.length > 0)) {
      expect(line.words[0]?.start).toBe(line.start);
    }
  });
});

describe("parseLrc: enhanced fixture", () => {
  const lines = parseLrc(paperLanterns, 24_000);

  it("uses word tags as real word timing, closed by a trailing tag", () => {
    expect(spans(lines[0])).toEqual([
      ["Paper ", 1000, 1500],
      ["lanterns ", 1500, 2200],
      ["over ", 2200, 2700],
      ["the ", 2700, 2900],
      ["river", 2900, 3700],
    ]);
  });

  it("merges syllable tags into one word and estimates an unclosed last word", () => {
    const words = spans(lines[1]);
    expect(words[0]).toEqual(["Counting ", 4200, 4800]);
    expect(last(words, 2)).toEqual(["toward ", 6400, 6900]);
    // "home" has no closing tag: it runs toward the line end, capped at 1.6 s
    expect(last(words)).toEqual(["home", 6900, 8500]);
  });

  it("keeps the instrumental gap and ends the last line at the duration", () => {
    expect(lines[2]).toMatchObject({ start: 9000, end: 12_500 - LINE_GAP_MS, words: [] });
    expect(lines[4]?.end).toBe(24_000);
    expect(last(lines[4]?.words)).toMatchObject({ text: "keeps", start: 19_100, end: 20_000 });
    expectWellFormed(lines);
  });
});

describe("parseLrc: timestamps", () => {
  it("accepts every fraction width, a colon fraction, short and long minutes", () => {
    const lines = parseLrc(
      ["[01:02]a", "[01:02.3]b", "[01:02.34]c", "[01:02.345]d", "[01:03:50]e", "[1:04.5]f", "[100:00.00]g"].join("\n"),
      0,
    );
    expect(starts(lines)).toEqual([62_000, 62_300, 62_340, 62_345, 63_500, 64_500, 6_000_000]);
    expect(texts(lines)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("skips junk: bad seconds, unclosed stamps, untimed text, stamps mid-line", () => {
    const raw = ["[00:75.00]bad", "[00:10.00", "[ab:cd]x", "just words", "words [00:01.00]", "[00:02.00]good"].join("\n");
    expect(texts(parseLrc(raw, 0))).toEqual(["good"]);
  });

  it("repeats a line for each of its stamps and sorts the result", () => {
    const lines = parseLrc("[00:12.00][01:40.00]Chorus line\n[00:30.00]Verse\n[00:05.00] [00:50.00] spaced out", 120_000);
    expect(starts(lines)).toEqual([5000, 12_000, 30_000, 50_000, 100_000]);
    expect(texts(lines)).toEqual(["spaced out", "Chorus line", "Verse", "spaced out", "Chorus line"]);
  });

  it("sorts lines that appear out of order", () => {
    expect(texts(parseLrc("[00:09.00]c\n[00:01.00]a\n[00:05.00]b", 0))).toEqual(["a", "b", "c"]);
  });

  it("applies [offset:] (positive shows lyrics sooner) and clamps at zero", () => {
    expect(starts(parseLrc("[offset:+500]\n[00:01.00]a\n[00:00.20]b", 0))).toEqual([0, 500]);
    expect(starts(parseLrc("[00:01.00]a\n[offset: -250]", 0))).toEqual([1250]);
    expect(starts(parseLrc("[offset:soon]\n[00:01.00]a", 0))).toEqual([1000]);
  });

  it("tolerates CRLF, lone CR, a BOM and messy spacing", () => {
    const raw = "\uFEFF[ar:Someone]\r\n[ti:Thing]\r\nrandom junk\r\n[00:01.00]First\r\n\r\n[#:comment]\r[00:03.00]  Second \t line  \r\n";
    expect(texts(parseLrc(raw, 10_000))).toEqual(["First", "Second line"]);
  });

  it("returns nothing for empty or untimed input", () => {
    expect(parseLrc("", 1000)).toEqual([]);
    expect(parseLrc("[ar:Nobody]\nno timing here", 1000)).toEqual([]);
  });
});

describe("parseLrc: gaps and line ends", () => {
  it("merges back-to-back gaps and lets the gap end the line before it", () => {
    const lines = parseLrc("[00:01.00]One\n[00:04.00]\n[00:04.50]\n[00:09.00]Two", 12_000);
    expect(lines.map((l) => [l.text, l.start, l.end])).toEqual([
      ["One", 1000, 4000 - LINE_GAP_MS],
      ["", 4000, 9000 - LINE_GAP_MS],
      ["Two", 9000, 12_000],
    ]);
  });

  it("drops a gap that shares its stamp with a lyric, whichever comes first", () => {
    expect(texts(parseLrc("[00:05.00]\n[00:05.00]Lyric", 0))).toEqual(["Lyric"]);
    expect(texts(parseLrc("[00:05.00]Lyric\n[00:05.00]", 0))).toEqual(["Lyric"]);
  });

  it("keeps one gap when empty stamps repeat", () => {
    const lines = parseLrc("[00:01.00]x\n[00:10.00]\n[00:10.00]\n[00:20.00]y", 0);
    expect(lines.map((l) => [l.text, l.start])).toEqual([["x", 1000], ["", 10_000], ["y", 20_000]]);
  });

  it("never ends a line before it starts", () => {
    const [a] = parseLrc("[00:01.00]close\n[00:01.20]call", 5000);
    expect(a).toMatchObject({ start: 1000, end: 1000 });
    expect(a?.words.every((w) => w.start === 1000 && w.end === 1000)).toBe(true);
  });

  it("never runs past the duration", () => {
    const lines = parseLrc("[00:01.00]a\n[00:05.00]b", 2000);
    expect(lines.map((l) => [l.start, l.end])).toEqual([[1000, 2000], [5000, 5000]]);
  });

  it("gives the last line a fixed span when the duration is unknown", () => {
    for (const unknown of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseLrc("[00:01.00]a", unknown)[0]?.end).toBe(1000 + LAST_LINE_MS);
    }
  });
});

describe("parseLrc: word tags", () => {
  it("starts text before the first tag at the line stamp", () => {
    expect(spans(parseLrc("[00:10.00]Oh <00:11.00>yes <00:12.00>", 20_000)[0])).toEqual([
      ["Oh ", 10_000, 11_000],
      ["yes", 11_000, 12_000],
    ]);
  });

  it("splits a tag's span by weight when several words share it", () => {
    expect(spans(parseLrc("[00:10.00]<00:10.00>one two <00:12.00>three<00:13.00>", 20_000)[0])).toEqual([
      ["one ", 10_000, 11_000],
      ["two ", 11_000, 12_000],
      ["three", 12_000, 13_000],
    ]);
  });

  it("starts a word at a tag placed before its space", () => {
    expect(spans(parseLrc("[00:10.00]<00:10.00>Hello<00:10.60> world<00:11.20>", 20_000)[0])).toEqual([
      ["Hello ", 10_000, 10_600],
      ["world", 10_600, 11_200],
    ]);
  });

  it("closes the whole line with a lone trailing tag", () => {
    const words = parseLrc("[00:10.00]all at once <00:11.50>", 20_000)[0]?.words ?? [];
    expect(words[0]?.start).toBe(10_000);
    expect(last(words)?.end).toBe(11_500);
  });

  it("ignores invalid tags but keeps their words", () => {
    const [line] = parseLrc("[00:10.00]<00:10.00>a <00:99.00>b <00:11.00>", 20_000);
    expect(line?.text).toBe("a b");
    expect(last(line?.words)?.end).toBe(11_000);
  });

  it("leaves angle brackets that aren't tags in the text", () => {
    expect(parseLrc("[00:10.00]I <3 you", 20_000)[0]?.text).toBe("I <3 you");
  });

  it("falls back to estimated timing when tags run backwards", () => {
    const [line] = parseLrc("[00:10.00]<00:12.00>a <00:11.00>b", 20_000);
    expect(line?.words[0]?.start).toBe(10_000);
    expectWellFormed([line as Line]);
  });

  it("falls back when tags sit far outside their line", () => {
    const [line] = parseLrc("[01:00.00]<00:00.00>a <00:00.50>b <00:01.00>\n[01:10.00]next", 80_000);
    expect(line?.words[0]?.start).toBe(60_000);
    expect(line?.words[1]?.start).toBeGreaterThan(60_000);
  });

  it("clamps tags slightly outside the line into it", () => {
    const [line] = parseLrc("[00:10.00]<00:09.80>a <00:10.50>b <00:12.00>\n[00:12.00]next", 20_000);
    expect(spans(line)).toEqual([
      ["a ", 10_000, 10_500],
      ["b", 10_500, 12_000 - LINE_GAP_MS],
    ]);
  });

  it("shifts tags along with each stamp of a repeated line", () => {
    const lines = parseLrc("[00:10.00][00:40.00]<00:10.00>la <00:10.50>la <00:11.00>", 60_000);
    expect(spans(lines[0])).toEqual([["la ", 10_000, 10_500], ["la", 10_500, 11_000]]);
    expect(spans(lines[1])).toEqual([["la ", 40_000, 40_500], ["la", 40_500, 41_000]]);
  });

  it("applies [offset:] to word tags too", () => {
    expect(spans(parseLrc("[offset:1000]\n[00:10.00]<00:10.00>a <00:10.40>b <00:11.00>", 20_000)[0])).toEqual([
      ["a ", 9000, 9400],
      ["b", 9400, 10_000],
    ]);
  });
});

describe("parseLrc: scripts", () => {
  it("highlights CJK per character, keeping spaces where the line has them", () => {
    const [ja, mixed] = parseLrc("[00:10.00]愛してる\n[00:14.00]我爱你 baby", 20_000);
    expect(ja?.words.map((w) => w.text)).toEqual(["愛", "し", "て", "る"]);
    expect(mixed?.words.map((w) => w.text)).toEqual(["我", "爱", "你 ", "baby"]);
    expectWellFormed([ja as Line, mixed as Line]);
  });

  it("keeps Vietnamese words with their diacritics intact", () => {
    const [line] = parseLrc("[00:10.00]Người ơi, đừng đi", 20_000);
    expect(line?.words.map((w) => w.text)).toEqual(["Người ", "ơi, ", "đừng ", "đi"]);
  });
});
