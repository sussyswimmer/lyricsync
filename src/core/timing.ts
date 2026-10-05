import type { Line, Word } from "./lrc";

/** Silence between one line's end and the next line's start. */
export const LINE_GAP_MS = 350;
/** The last word of a line is held up to this long, the way singers hold line endings. */
export const LAST_WORD_HOLD_MS = 600;
/** On short lines the hold takes at most this share of the line. */
const HOLD_SHARE = 0.2;
/** No word stays active longer than this, so a long instrumental tail can't freeze one word. */
export const MAX_WORD_MS = 1600;
/** Every word costs this much on top of its syllables (onsets, consonants, breath). */
const WEIGHT_FLOOR = 0.5;
/** Pace for plain lyrics when the track duration is unknown. */
export const PLAIN_LINE_MS = 4000;

/** A lyric sheet ready for the renderer. */
export interface Timeline {
  lines: Line[];
  /** Plain lyrics paced evenly: the renderer shows a calmer style with no word highlight. */
  unsynced: boolean;
}

const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const SMALL_KANA = "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ";
/** Small kana that blend into the previous mora rather than adding one. */
const GLIDES = /[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ]/gu;
/**
 * One highlightable unit plus the space after it. Latin-like scripts split on spaces. Chinese,
 * Japanese and Korean split per character, keeping small kana, ー and closing punctuation attached.
 */
const UNIT = new RegExp(
  `(?:[\\p{Ps}\\p{Pi}]*[${CJK}][${SMALL_KANA}ー\\p{Pe}\\p{Pf}\\p{Po}]*|[^\\s${CJK}]+) ?`,
  "gu",
);
const CJK_CHAR = new RegExp(`[${CJK}]`, "gu");
const VOWEL_GROUP = /[aeiouyæøœаеиоуыэюяαεηιουω]+/gu;

export function isKnownDuration(durationMs: number): boolean {
  return Number.isFinite(durationMs) && durationMs > 0;
}

/** Collapses runs of whitespace to one space and trims the ends. */
export function normalizeSpace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Splits a line into highlightable units. Each keeps its trailing space, so they join back to the normalized line. */
export function splitWords(text: string): string[] {
  return normalizeSpace(text).match(UNIT) ?? [];
}

/** Rough syllable count: vowel groups for alphabetic scripts, one per CJK character, one per digit. */
export function syllables(word: string): number {
  const w = word.trim();
  const cjk = (w.match(CJK_CHAR)?.length ?? 0) - (w.match(GLIDES)?.length ?? 0);
  const letters = w.normalize("NFD").replace(/[^\p{L}]/gu, "").toLowerCase();
  let vowels = letters.match(VOWEL_GROUP)?.length ?? 0;
  // silent final e: "like", "fire", "we're" (but not "little", "table")
  if (vowels > 1 && /[^aeiouy]e$/u.test(letters) && !/[^aeiouy]le$/u.test(letters)) vowels--;
  const digits = w.match(/\p{Nd}/gu)?.length ?? 0;
  const total = cjk + vowels + digits;
  if (total > 0) return total;
  // letters with no vowels we know ("hmm", abjads, Thai): about one syllable per three letters
  const count = w.match(/\p{L}/gu)?.length ?? 0;
  return count > 0 ? Math.max(1, Math.round(count / 3)) : 0;
}

export function weight(word: string): number {
  return syllables(word) + WEIGHT_FLOOR;
}

function share(units: readonly string[], spanMs: number): number[] {
  const weights = units.map(weight);
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (spanMs * w) / total);
}

function layout(units: readonly string[], durations: readonly number[], start: number, end: number): Word[] {
  const limit = Math.max(start, end);
  let t = start;
  return units.map((text, i) => {
    const word = { text, start: t, end: Math.min(limit, t + (durations[i] ?? 0)) };
    t = word.end;
    return word;
  });
}

/** Fills [start, end] exactly, split by weight. For words whose bounds are known (enhanced LRC tags). */
export function spreadWords(units: readonly string[], start: number, end: number): Word[] {
  const words = layout(units, share(units, Math.max(0, end - start)), start, end);
  const last = words[words.length - 1];
  if (last) last.end = Math.max(last.start, end);
  return words;
}

/**
 * Fallback word timing for a line with no word tags: split by weight, hold the last word,
 * cap every word. Words start at `start`; any slack left by the cap falls at the end of the line.
 */
export function timeWords(units: readonly string[], start: number, end: number): Word[] {
  if (units.length === 0) return [];
  const span = Math.max(0, end - start);
  const hold = units.length > 1 ? Math.min(LAST_WORD_HOLD_MS, span * HOLD_SHARE) : 0;
  const durations = share(units, span - hold);
  const last = durations.length - 1;
  durations[last] = (durations[last] ?? 0) + hold;
  return layout(units, durations.map((d) => Math.min(d, MAX_WORD_MS)), start, end);
}

/** Plain lyrics with no timestamps: lines paced evenly across the track, flagged unsynced. */
export function pacePlain(plain: string, durationMs: number): Timeline {
  const texts = plain.split(/\r\n|\r|\n/u).map(normalizeSpace).filter((t) => t !== "");
  const span = isKnownDuration(durationMs) ? durationMs : texts.length * PLAIN_LINE_MS;
  const slot = texts.length > 0 ? span / texts.length : 0;
  const lines = texts.map((text, i): Line => {
    const start = i * slot;
    const end = i === texts.length - 1 ? span : Math.max(start, start + slot - LINE_GAP_MS);
    return { start, end, text, words: timeWords(splitWords(text), start, end) };
  });
  return { lines, unsynced: true };
}

/** Index of the line playing at `t` (the last one started), or -1 before the first line. */
export function lineAt(lines: readonly Pick<Line, "start">[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((lines[mid]?.start ?? Infinity) <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Where a word stands at `t`. */
export type WordState = "upcoming" | "active" | "sung";

/**
 * A word is active on [start, end): lit from the very millisecond it starts. The stage schedules
 * frames by the same rule, so a renderer that paints from this never shows a started word unlit.
 * Zero-length words go straight from upcoming to sung.
 */
export function wordState(word: Pick<Word, "start" | "end">, t: number): WordState {
  if (t < word.start) return "upcoming";
  return t < word.end ? "active" : "sung";
}

/** How far through a word `t` is, 0..1. Zero-length words jump straight from 0 to 1. */
export function progress(word: Pick<Word, "start" | "end">, t: number): number {
  if (t < word.start) return 0;
  if (t >= word.end) return 1;
  return (t - word.start) / (word.end - word.start);
}
