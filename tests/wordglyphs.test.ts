import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Line, Word } from "../src/core/lrc";
import { GLYPH_IDS, glyphOfToken, glyphsIn, glyphWords, planGlyphs } from "../src/core/wordglyphs";
import { GLYPH_EM, GLYPH_GAP_EM, glyphElement, glyphPath } from "../src/overlay/glyphs";
import { resetDom, stubDom } from "./fake-dom";

/** A line of these words, 400 ms each from `start`. */
function line(text: string, start = 0): Line {
  const words: Word[] = text.split(" ").map((w, i, all) => ({ text: i < all.length - 1 ? `${w} ` : w, start: start + 400 * i, end: start + 400 * (i + 1) }));
  return { start, end: start + 400 * words.length, words, text };
}

describe("which words carry a glyph (wordglyphs.ts)", () => {
  it("lists every glyph's words once, in a form sung words match", () => {
    const seen = new Map<string, string>();
    for (const id of GLYPH_IDS) {
      const words = glyphWords(id);
      expect(words.length, id).toBeGreaterThan(2);
      for (const word of words) {
        expect(word, `${id}: ${word}`).toMatch(/^[a-z0-9'’éè-]+$/u);
        expect(seen.get(word), `${word} is ${seen.get(word)}'s too`).toBeUndefined();
        seen.set(word, id);
        expect(glyphOfToken(word), word).toBe(id);
      }
    }
    expect(seen.size).toBeGreaterThan(1500);
  });

  it("matches the reel's words: a building for the city, an arrow for left, play for started, glasses, a dancer", () => {
    expect(glyphsIn(line("ever since I left the city, you"))).toEqual([
      { word: 3, id: "arrow-left" },
      { word: 5, id: "building" },
    ]);
    expect(glyphsIn(line("Started wearing less and goin' out more"))).toEqual([
      { word: 0, id: "play" },
      { word: 1, id: "shirt" },
      { word: 4, id: "arrow-right" },
      { word: 6, id: "plus" },
    ]);
    expect(glyphsIn(line("Glasses of champagne out on the dance floor"))).toEqual([
      { word: 0, id: "glasses" },
      { word: 2, id: "wine" },
      { word: 6, id: "dancer" },
      { word: 7, id: "dancer" },
    ]);
    // case, punctuation and a possessive don't matter; a plural counts as its singular
    expect(glyphsIn(line("CALL me, the city's PHONES!"))).toEqual([
      { word: 0, id: "phone" },
      { word: 3, id: "building" },
      { word: 4, id: "phone" },
    ]);
    expect(glyphsIn(line("a quiet room with nothing in it"))).toEqual([
      { word: 1, id: "headphones" },
      { word: 4, id: "x" },
    ]);
    expect(glyphsIn(line("and so it was with them"))).toEqual([]);
  });

  it("plans a song's glyphs by line and word, leaving out the lines without any", () => {
    const plan = planGlyphs([line("the moon tonight", 0), line("and so it was", 2000), { start: 4000, end: 4001, words: [], text: "" }, line("call me", 5000)]);
    expect([...plan.keys()]).toEqual([0, 3]);
    expect([...(plan.get(0)?.entries() ?? [])]).toEqual([
      [1, "moon"],
      [2, "moon"],
    ]);
    expect(plan.get(3)?.get(0)).toBe("phone");
  });
});

describe("the glyphs' drawings (overlay/glyphs.ts)", () => {
  it("draws every glyph as path data inside its 24 × 24 box", () => {
    for (const id of GLYPH_IDS) {
      const d = glyphPath(id);
      expect(d, id).toMatch(/^M[-\d.]/u);
      expect(d, id).toMatch(/^[MmLlHhVvCcSsQqTtAaZz\d.\s-]+$/u);
      for (const n of d.match(/-?\d+(?:\.\d+)?/gu) ?? []) expect(Math.abs(Number(n)), `${id}: ${n}`).toBeLessThanOrEqual(24);
    }
    expect(GLYPH_EM).toBeGreaterThan(0.5);
    expect(GLYPH_GAP_EM).toBeGreaterThan(0);
  });

  describe("as an element", () => {
    beforeEach(stubDom);
    afterEach(resetDom);

    it("builds a glyph as an element beside its word, named for what it draws", () => {
      const el = glyphElement("building");
      expect(el.getAttribute("class")).toContain("kw-glyph");
      expect(el.getAttribute("data-glyph")).toBe("building");
      expect(glyphElement("play").getAttribute("class")).toContain("is-fill");
    });
  });
});
