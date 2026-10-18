/**
 * Breaking a word into letters that can move on their own, placed exactly where the browser draws
 * them in the whole word (kerning included), measured on a canvas so no layout is read.
 */
import type { LetterBox, Part } from "./karaoke";

/**
 * Scripts whose letters stand alone: splitting them changes no shapes. Arabic, Syriac, N'Ko and
 * Mongolian join letters; Indic and Southeast Asian scripts build clusters; those words move whole.
 */
const SPLITTABLE =
  /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Common}\p{Script=Inherited}]+$/u;
/** Right-to-left blocks (Hebrew, Arabic, Syriac, Thaana, N'Ko and the rest). */
const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;

export function isRtl(text: string): boolean {
  return RTL.test(text);
}

/** User-perceived characters: a letter with its accents stays one piece. */
export function graphemes(text: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (typeof Segmenter === "function") return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.segment);
  return Array.from(text);
}

export function splittable(text: string): boolean {
  return SPLITTABLE.test(text) && !isRtl(text);
}

/** Text advance widths, px, for one CSS font; null when there is nothing to measure with (tests, workers). */
export type Measure = (text: string) => number;

let context: CanvasRenderingContext2D | null | undefined;

/** A canvas measurer for `font` (CSS font shorthand), or null without a canvas. */
export function canvasMeasure(font: string): Measure | null {
  if (context === undefined) {
    try {
      const canvas = typeof document !== "undefined" ? (document.createElement("canvas") as HTMLCanvasElement) : null;
      context = typeof canvas?.getContext === "function" ? canvas.getContext("2d") : null;
    } catch {
      context = null;
    }
  }
  const ctx = context;
  if (!ctx) return null;
  const cache = new Map<string, number>();
  return (text: string): number => {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    if (ctx.font !== font) ctx.font = font;
    const w = ctx.measureText(text).width;
    cache.set(text, w);
    return w;
  };
}

/** A rough measurer for when there is no canvas: half an em per character. */
export function roughMeasure(size: number): Measure {
  return (text: string) => [...text].length * size * 0.5;
}

/**
 * The letters of `text` (a word without its trailing space) and its width. Each letter sits where it
 * is drawn inside the whole word: the advance of everything up to and including it, less its own
 * advance, which keeps kerning pairs in place. A word that can't be split is one letter. `parts` (the
 * word's syllables) tell each letter which syllable it belongs to.
 */
export function measureLetters(text: string, parts: readonly Pick<Part, "text">[], measure: Measure): { width: number; letters: LetterBox[] } {
  const width = measure(text);
  if (!splittable(text) || [...text].length < 2) return { width, letters: [{ text, x: 0, w: width, part: 0 }] };
  // character offset where each part ends, in the word's text
  const ends: number[] = [];
  let at = 0;
  for (const p of parts) {
    at += p.text.trimEnd().length > 0 ? p.text.length : 0;
    ends.push(at);
  }
  const letters: LetterBox[] = [];
  let offset = 0;
  for (const g of graphemes(text)) {
    const through = offset + g.length;
    const w = measure(g);
    const x = Math.max(0, measure(text.slice(0, through)) - w);
    let part = ends.findIndex((end) => offset < end);
    if (part < 0) part = Math.max(0, ends.length - 1);
    if (g.trim() !== "") letters.push({ text: g, x, w, part });
    offset = through;
  }
  return { width, letters };
}
