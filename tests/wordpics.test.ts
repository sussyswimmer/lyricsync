import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Line, Word } from "../src/core/lrc";
import { normalizeToken, PICTURE_GAP_MS, PICTURE_IDS, picturesIn, planPictures, SAME_PICTURE_GAP_MS, tokensOf, wordsFor, type PictureId } from "../src/core/wordpics";

/** A line of words, each 400 ms, from `start`. */
function line(text: string, start = 0): Line {
  const parts = text.split(" ");
  const words: Word[] = parts.map((w, i) => ({ text: i < parts.length - 1 ? `${w} ` : w, start: start + i * 400, end: start + (i + 1) * 400 }));
  return { start, end: start + parts.length * 400, words, text };
}

/** "word→picture" for every picture a line calls. */
const calls = (text: string): string[] => {
  const l = line(text);
  return picturesIn(l).map((m) => `${l.words[m.word]?.text.trim()}→${m.id}`);
};

describe("which words call a picture", () => {
  it("finds iced tea, the way it's sung, and puts the picture on the phrase's last word", () => {
    expect(calls("Sipping iced tea on the porch")).toEqual(["tea→iced-tea"]);
    expect(calls("ice tea and sunshine")).toEqual(["tea→iced-tea", "sunshine→sun"]);
    expect(calls("Pour me some sweet tea")).toEqual(["tea→iced-tea"]);
    expect(calls("a cup of tea")).toEqual(["tea→iced-tea"]);
  });

  it("lets the longest phrase win: a broken heart is not a heart", () => {
    expect(calls("You left me with a broken heart")).toEqual(["heart→broken-heart"]);
    expect(calls("Please don't break my heart")).toEqual(["heart→broken-heart"]);
    expect(calls("Heart of glass")).toEqual(["Heart→heart"]);
    expect(calls("Heart of gold")).toEqual(["Heart→heart", "gold→gold"]);
    expect(calls("rose wine at midnight")).toEqual(["wine→wine"]);
    expect(calls("roses in the garden")).toEqual(["roses→rose", "garden→bouquet"]);
    expect(calls("head over heels")).toEqual(["heels→heart"]);
    expect(calls("high heels on the dance floor")).toEqual(["heels→heels", "floor→disco"]);
    expect(calls("a drive-in movie")).toEqual(["drive-in→popcorn", "movie→popcorn"]);
  });

  it("reads case, punctuation, plurals, possessives and a dropped g", () => {
    expect(calls("RAIN!")).toEqual(["RAIN!→rain"]);
    expect(calls("“Moon,” she said")).toEqual(["“Moon,”→moon"]);
    expect(calls("cherries and diamonds")).toEqual(["cherries→cherry", "diamonds→diamond"]);
    expect(calls("all these kisses")).toEqual(["kisses→lips"]);
    expect(calls("my heart's on fire")).toEqual(["heart's→heart", "fire→fire"]);
    expect(calls("burnin' up")).toEqual(["burnin'→fire"]);
    expect(calls("it's five o'clock")).toEqual(["o'clock→clock"]);
    expect(calls("café au lait coffee")).toEqual(["café→coffee", "coffee→coffee"]);
  });

  it("splits hyphenated words, and still names the word that was sung", () => {
    const l = line("a melting ice-cream cone");
    expect(tokensOf(l).map((t) => `${t.text}@${t.word}`)).toEqual(["a@0", "melting@1", "ice@2", "cream@2", "cone@3"]);
    expect(picturesIn(l)).toEqual([{ word: 2, id: "ice-cream" }]);
    expect(calls("tick-tock goes the clock")).toEqual(["tick-tock→clock", "clock→clock"]);
  });

  it("leaves out words that mean too many things", () => {
    for (const text of ["give me a ring", "wave goodbye", "tear it down", "in the present", "a single tear", "jet black", "shades of gray", "a pickup line", "I pine for you"]) {
      expect(calls(text), text).toEqual([]);
    }
    expect(calls("cold as ice")).toEqual(["ice→ice"]);
    // ...unless a phrase says which: a diamond ring, ocean waves, tears
    expect(calls("a diamond ring")).toEqual(["ring→ring"]);
    expect(calls("crashing waves")).toEqual(["waves→wave"]);
    expect(calls("no more tears")).toEqual(["tears→tear"]);
  });

  it("finds nothing in scripts it has no words for", () => {
    expect(calls("雨 が 降る")).toEqual([]);
    expect(calls("Mưa rơi")).toEqual([]);
  });

  it("normalizes a word as a sung token", () => {
    expect(normalizeToken("Heart’s")).toBe("heart");
    expect(normalizeToken("hearts'")).toBe("hearts");
    expect(normalizeToken("¡Fuego!")).toBe("fuego");
    expect(normalizeToken("—")).toBe("");
  });
});

describe("the picture library", () => {
  it("has a bundled file for every picture, and a picture for every file", () => {
    const dir = "src/overlay/pictures";
    for (const id of PICTURE_IDS) expect(existsSync(`${dir}/${id}.webp`), id).toBe(true);
    const files = readdirSync(dir).filter((f) => f.endsWith(".webp")).map((f) => f.replace(/\.webp$/, ""));
    expect(files.sort()).toEqual([...PICTURE_IDS].sort());
  });

  it("lists every word under one picture only, and each listed word calls its own picture", () => {
    const owner = new Map<string, PictureId>();
    for (const id of PICTURE_IDS) {
      expect(wordsFor(id).length, id).toBeGreaterThan(0);
      for (const entry of wordsFor(id)) {
        const key = entry.toLowerCase();
        expect(owner.get(key), `${entry} under ${owner.get(key)} and ${id}`).toBeUndefined();
        owner.set(key, id);
        const sung = line(entry);
        const matches = picturesIn(sung);
        expect(matches[matches.length - 1]?.id, entry).toBe(id);
      }
    }
  });
});

describe("which matches show a picture", () => {
  it("shows at most one a line, the first match, on its word's start", () => {
    const plans = planPictures([line("rain and fire and roses", 1000)]);
    expect([...plans.values()]).toEqual([{ line: 0, word: 0, id: "rain", at: 1000 }]);
  });

  it("waits PICTURE_GAP_MS after one before the next, and SAME_PICTURE_GAP_MS for the same one", () => {
    const lines = [
      line("the rain came down", 0),
      line("then fire", PICTURE_GAP_MS - 1000),
      line("and fire again", PICTURE_GAP_MS + 2000),
      line("more rain", SAME_PICTURE_GAP_MS - 5000),
      line("rain once more", SAME_PICTURE_GAP_MS + 1000),
    ];
    const plans = planPictures(lines);
    expect([...plans.values()].map((p) => `${p.line}:${p.id}@${p.at}`)).toEqual([
      "0:rain@400",
      // line 1's fire is too soon after the rain; line 2's isn't
      `2:fire@${PICTURE_GAP_MS + 2000 + 400}`,
      // line 3's rain is the same picture again too soon; line 4's is far enough
      `4:rain@${SAME_PICTURE_GAP_MS + 1000}`,
    ]);
  });

  it("skips instrumental gaps and is the same every time", () => {
    const lines = [line("snow falls", 0), { start: 3000, end: 9000, words: [], text: "" }, line("a candle burns", 12_000)];
    const a = planPictures(lines);
    expect([...a.keys()]).toEqual([0, 2]);
    expect(planPictures(lines)).toEqual(a);
  });
});
