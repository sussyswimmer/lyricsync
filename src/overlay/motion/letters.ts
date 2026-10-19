/**
 * Breaking a word into letters that can move on their own, placed exactly where the browser draws
 * them in the whole word (kerning and letter-spacing included), measured on a canvas so no layout is
 * read.
 */
import type { Line, Word } from "../../core/lrc";
import type { LetterBox, Part, WordInk } from "./karaoke";

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

/** The shared 2D context every measurer uses, made once; null without a canvas. */
function canvasContext(): CanvasRenderingContext2D | null {
  if (context === undefined) {
    try {
      const canvas = typeof document !== "undefined" ? (document.createElement("canvas") as HTMLCanvasElement) : null;
      context = typeof canvas?.getContext === "function" ? canvas.getContext("2d") : null;
    } catch {
      context = null;
    }
  }
  return context;
}

/** A canvas measurer for `font` (CSS font shorthand), or null without a canvas. */
export function canvasMeasure(font: string): Measure | null {
  const ctx = canvasContext();
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

/** Where a run of text draws past its box, px: as WordInk, for one run measured alone. */
export interface Ink {
  /** past its start (left) and past its advance (right) */
  left: number;
  right: number;
  /** above the font's ascent and below its descent */
  above: number;
  below: number;
  /** the font's ascent and descent */
  ascent: number;
  descent: number;
}

export type InkMeasure = (text: string) => Ink;

/** A canvas ink measurer for `font` (CSS font shorthand), or null without a canvas. */
export function canvasInk(font: string): InkMeasure | null {
  const ctx = canvasContext();
  if (!ctx) return null;
  const finite = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cache = new Map<string, Ink>();
  return (text: string): Ink => {
    const hit = cache.get(text);
    if (hit) return hit;
    if (ctx.font !== font) ctx.font = font;
    const m = ctx.measureText(text);
    // fontBoundingBox* is missing from older engines: no font box, so no vertical overhang either
    const ascent = finite(m.fontBoundingBoxAscent);
    const descent = finite(m.fontBoundingBoxDescent);
    const known = ascent + descent > 0;
    const ink: Ink = {
      left: finite(m.actualBoundingBoxLeft),
      right: typeof m.actualBoundingBoxRight === "number" ? finite(m.actualBoundingBoxRight) - finite(m.width) : 0,
      above: known ? finite(m.actualBoundingBoxAscent) - ascent : 0,
      below: known ? finite(m.actualBoundingBoxDescent) - descent : 0,
      ascent,
      descent,
    };
    cache.set(text, ink);
    return ink;
  };
}

/**
 * Where a word's glyphs draw past its boxes: the whole word's ink as one run, and each letter's where
 * it sits in the word (`letters`), since a lit letter is drawn alone in a box of its own.
 */
export function wordInk(text: string, letters: readonly LetterBox[], width: number, ink: InkMeasure): WordInk {
  const whole = ink(text);
  let left = whole.left;
  let right = whole.right;
  let side = Math.max(whole.left, whole.right);
  let above = whole.above;
  let below = whole.below;
  if (letters.length > 1) {
    for (const l of letters) {
      const m = ink(l.text);
      left = Math.max(left, m.left - l.x);
      right = Math.max(right, l.x + l.w + m.right - width);
      side = Math.max(side, m.left, m.right);
      above = Math.max(above, m.above);
      below = Math.max(below, m.below);
    }
  }
  return { left: Math.max(0, left), right: Math.max(0, right), side: Math.max(0, side), above, below, ascent: whole.ascent, descent: whole.descent };
}

/** Forgets the canvas context (tests that stub one in, or take it away). */
export function resetMeasure(): void {
  context = undefined;
}

/** A rough measurer for when there is no canvas: half an em per character. */
export function roughMeasure(size: number): Measure {
  return (text: string) => [...text].length * size * 0.5;
}

/**
 * The letters of `text` (a word without its trailing space) and its width. Each letter sits where it
 * is drawn inside the whole word: the advance of everything up to and including it, less its own
 * advance, which keeps kerning pairs in place; `spacingPx` (CSS letter-spacing) follows every
 * grapheme, so the n-th letter moves n spacings right and the word grows by one per gap. A word that
 * can't be split is one letter. `parts` (the word's syllables) tell each letter which syllable it
 * belongs to. With `ink`, it also measures where the glyphs draw past their boxes.
 */
export function measureLetters(
  text: string,
  parts: readonly Pick<Part, "text">[],
  measure: Measure,
  spacingPx = 0,
  ink?: InkMeasure,
): { width: number; letters: LetterBox[]; ink?: WordInk } {
  const all = graphemes(text);
  const gaps = Math.max(0, all.length - 1);
  const width = measure(text) + spacingPx * gaps;
  const withInk = (letters: LetterBox[]): { width: number; letters: LetterBox[]; ink?: WordInk } =>
    ink ? { width, letters, ink: wordInk(text, letters, width, ink) } : { width, letters };
  if (!splittable(text) || all.length < 2) return withInk([{ text, x: 0, w: width, part: 0 }]);
  // character offset where each part ends, in the word's text
  const ends: number[] = [];
  let at = 0;
  for (const p of parts) {
    at += p.text.trimEnd().length > 0 ? p.text.length : 0;
    ends.push(at);
  }
  const letters: LetterBox[] = [];
  let offset = 0;
  all.forEach((g, i) => {
    const through = offset + g.length;
    const w = measure(g);
    const x = Math.max(0, measure(text.slice(0, through)) - w) + spacingPx * i;
    let part = ends.findIndex((end) => offset < end);
    if (part < 0) part = Math.max(0, ends.length - 1);
    if (g.trim() !== "") letters.push({ text: g, x, w, part });
    offset = through;
  });
  return withInk(letters);
}

/** How the look sets lyric text: as written, or upper case (Unbounded and Syne on shouted lines). */
export type TextCase = "as-is" | "upper";

/** `text` in the look's case. */
export function cased(text: string, textCase: TextCase): string {
  return textCase === "upper" ? text.toLocaleUpperCase() : text;
}

/**
 * Lines in the look's case, ready to measure and draw: every word's text, and each syllable's, so a
 * word's letters still find their syllable (casing each part keeps the word equal to its parts).
 */
export function casedLines(lines: readonly Line[], textCase: TextCase): Line[] {
  if (textCase === "as-is") return [...lines];
  return lines.map((line) => {
    const words = line.words.map((w): Word => {
      const parts = w.parts?.map((p) => ({ ...p, text: cased(p.text, textCase) }));
      const text = parts && parts.length > 0 ? parts.map((p) => p.text).join("") : cased(w.text, textCase);
      return parts ? { ...w, text, parts } : { ...w, text };
    });
    return { ...line, words, text: words.map((w) => w.text).join("") || cased(line.text, textCase) };
  });
}
