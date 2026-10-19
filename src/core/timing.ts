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
/**
 * Plain lyrics: singing rarely starts on the first beat, so the first line waits this share of the
 * song (within these bounds) for its intro...
 */
export const PLAIN_INTRO = { share: 0.06, minMs: 2000, maxMs: 14_000 } as const;
/** ...and the last line ends this share before the song does, for its outro. */
export const PLAIN_OUTRO = { share: 0.07, minMs: 3000, maxMs: 18_000 } as const;
/** Every plain line keeps at least this long: a short song with many lines gives up its intro and outro first. */
export const PLAIN_MIN_LINE_MS = 1200;
/** A plain line takes as long as its syllables, plus this many more for the breath around it... */
const PLAIN_BREATH = 3;
/** ...and a blank row between stanzas as long as an average line (the band plays on). */
const PLAIN_STANZA_GAP = 1;
/**
 * Lines timed by line only are sung at the pace of the lines around them: a line's rate is its beats
 * (weights: syllables plus a little for each word) over the time until the next line starts. A pause
 * after a line makes it read slower than it was sung, never faster, so the singing pace near a line
 * is this high share of the rates of the lines up to PACE_WINDOW either side of it. That follows the
 * song as it speeds up and slows down from one part to the next.
 */
export const PACE_QUANTILE = 0.7;
export const PACE_WINDOW = 4;
/** With fewer lines than this to go by, a line's words fill it, as they did before pacing. */
const PACE_MIN_LINES = 3;
/** No song is sung slower or faster than this, in beats a second. */
const PACE_RANGE = [1.2, 16] as const;

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

/**
 * Plain lyrics with no timestamps, paced as a singer would roughly take them: after an intro and
 * before an outro (PLAIN_INTRO, PLAIN_OUTRO), each line for as long as its syllables plus a breath,
 * and a pause where a blank row ends a stanza. Flagged unsynced: it is a guess, which drifts from the
 * singer, so the renderer shows it calmly, with no word highlight and its neighbors easy to read.
 */
export function pacePlain(plain: string, durationMs: number): Timeline {
  // the lines, each with whether a blank row (a stanza break) comes before it
  const items: { text: string; afterBreak: boolean }[] = [];
  let blank = false;
  for (const row of plain.split(/\r\n|\r|\n/u).map(normalizeSpace)) {
    if (row === "") {
      blank = items.length > 0;
      continue;
    }
    items.push({ text: row, afterBreak: blank });
    blank = false;
  }
  const n = items.length;
  if (n === 0) return { lines: [], unsynced: true };
  const known = isKnownDuration(durationMs);
  const span = known ? durationMs : n * PLAIN_LINE_MS;
  const within = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  let intro = known ? within(span * PLAIN_INTRO.share, PLAIN_INTRO.minMs, PLAIN_INTRO.maxMs) : 0;
  let outro = known ? within(span * PLAIN_OUTRO.share, PLAIN_OUTRO.minMs, PLAIN_OUTRO.maxMs) : 0;
  if (span - intro - outro < n * PLAIN_MIN_LINE_MS) {
    intro = 0;
    outro = 0;
  }
  const weights = items.map((it) => splitWords(it.text).reduce((sum, w) => sum + syllables(w), 0) + PLAIN_BREATH);
  const average = weights.reduce((a, b) => a + b, 0) / n;
  const gaps = items.map((it, i) => (i > 0 && it.afterBreak ? average * PLAIN_STANZA_GAP : 0));
  const total = weights.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
  const unit = (span - intro - outro) / total;
  const starts: number[] = [];
  let at = intro;
  items.forEach((_, i) => {
    at += (gaps[i] ?? 0) * unit;
    starts.push(at);
    at += (weights[i] ?? 0) * unit;
  });
  const lines = items.map((it, i): Line => {
    const start = starts[i] ?? 0;
    const end = i === n - 1 ? span - outro : Math.max(start, (starts[i + 1] ?? span) - LINE_GAP_MS);
    return { start, end, text: it.text, words: timeWords(splitWords(it.text), start, end), estimated: true };
  });
  return { lines, unsynced: true };
}

/** A line's beats: its words' weights, which the pace is counted in. */
export function beatsOf(units: readonly string[]): number {
  return units.reduce((sum, unit) => sum + weight(unit), 0);
}

/** The value `q` (0..1) of the way up `values`, linear between neighbors. `values` is never empty. */
function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const value = (i: number): number => sorted[Math.min(i, sorted.length - 1)] as number;
  const at = q * (sorted.length - 1);
  const lo = Math.floor(at);
  return value(lo) + (value(lo + 1) - value(lo)) * (at - lo);
}

/**
 * How fast the song is sung around each line, in beats a second, by line index (PACE_QUANTILE).
 * `next` is when the following line starts; `beats` is 0 for an instrumental gap, which has no rate of
 * its own. NaN where there's too little to go by.
 */
export function singingPace(lines: readonly { start: number; next: number; beats: number }[]): number[] {
  const rates = lines.map((l) => (l.beats > 0 && l.next > l.start ? (l.beats * 1000) / (l.next - l.start) : NaN));
  return lines.map((_, i) => {
    const near = rates.slice(Math.max(0, i - PACE_WINDOW), i + PACE_WINDOW + 1).filter(Number.isFinite);
    if (near.length < PACE_MIN_LINES) return NaN;
    return Math.min(PACE_RANGE[1], Math.max(PACE_RANGE[0], quantile(near, PACE_QUANTILE)));
  });
}

/**
 * Word timing for a line with no word tags, sung at `pace` beats a second (singingPace): its words
 * take as long as their beats do at that pace, or the whole line when it has less room (the singer
 * hurried), split by weight with the last word held (timeWords). When the line has room left, the
 * last word holds on into it for up to LAST_WORD_HOLD_MS more, the way singers hold a line's end; the
 * rest is the pause before the next line, so the highlight never crawls through it. Without a pace,
 * the words fill the line.
 */
export function paceWords(units: readonly string[], start: number, end: number, pace: number): Word[] {
  const slot = Math.max(0, end - start);
  const sung = Number.isFinite(pace) && pace > 0 ? Math.min(slot, (beatsOf(units) * 1000) / pace) : slot;
  const words = timeWords(units, start, start + sung);
  const last = words[words.length - 1];
  if (last && sung < slot) last.end = Math.min(end, last.end + LAST_WORD_HOLD_MS, Math.max(last.end, last.start + MAX_WORD_MS));
  return words;
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
