import { LINE_GAP_MS, beatsOf, isKnownDuration, paceWords, singingPace, splitWords, spreadWords, timeWords } from "./timing";

/**
 * One word (or one CJK character) and when it is sung, in ms. `text` keeps the space that
 * follows it, so a line's words joined with "" give back `Line.text`.
 */
export interface Word {
  text: string;
  start: number;
  end: number;
  /**
   * The word's syllables when enhanced LRC times them separately (tags inside the word, such as
   * `Count<00:04.50>ing`): consecutive, covering [start, end], their texts joining to `text`.
   * Absent for a word timed as a whole.
   */
  parts?: WordPart[];
}

/** One syllable of a word, in ms. */
export interface WordPart {
  text: string;
  start: number;
  end: number;
}

/** One lyric line in ms. A line with no words is an instrumental gap. */
export interface Line {
  start: number;
  end: number;
  words: Word[];
  text: string;
  /**
   * Its words' times are a guess (no usable word tags): they are sung at the pace of the lines around
   * it (timing.ts paceWords), so a held note on such a line is a guess too.
   */
  estimated?: boolean;
}

/** Span of the last line when the track duration is unknown. */
export const LAST_LINE_MS = 5000;
/** Word tags this far outside their line are junk; when most of a line's are, it falls back to estimated timing. */
const TAG_SLACK_MS = 1000;

const STAMP = /^\[\s*(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\s*\]/u;
const WORD_TAG = /<\s*(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\s*>/gu;
const META = /^\[\s*([a-z#][\w#-]*)\s*:(.*)\]\s*$/iu;
/** Anything stamp-like, valid or not, anywhere in a row. */
const ANY_STAMP = /\[\s*\d{1,3}:\d{1,2}/u;
/** Stamp-like brackets at the start of a row, valid or not. */
const LEADING_STAMPS = /^(?:\s*\[\s*\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\s*\])+/u;

interface Mark {
  /** position in the normalized line text */
  index: number;
  time: number;
}

interface Entry {
  start: number;
  text: string;
  marks: Mark[];
  /** added to word tag times: the [offset:] tag, plus the stamp shift when one line has several stamps */
  shift: number;
}

/** `[mm:ss]`, `[mm:ss.x]`, `[mm:ss.xx]` or `[mm:ss.xxx]` (also with `:` before the fraction) → ms. */
function stampMs(m: RegExpExecArray): number | null {
  const min = Number(m[1]);
  const sec = Number(m[2]);
  if (sec >= 60) return null;
  const frac = m[3] ? Number(m[3].padEnd(3, "0")) : 0;
  return min * 60_000 + sec * 1000 + frac;
}

/** Leading line stamps and the body after them, or null for a line that isn't timed. */
function readStamps(raw: string): { stamps: number[]; body: string } | null {
  const stamps: number[] = [];
  let rest = raw.trimStart();
  for (let m = STAMP.exec(rest); m; m = STAMP.exec(rest)) {
    const t = stampMs(m);
    if (t === null) return null;
    stamps.push(t);
    rest = rest.slice(m[0].length).trimStart();
  }
  return stamps.length > 0 ? { stamps, body: rest } : null;
}

function rowsOf(raw: string): string[] {
  return raw.replace(/^﻿/u, "").split(/\r\n|\r|\n/u);
}

/** Strips word tags and normalizes spaces, remembering where each tag sat in the clean text. */
function readBody(body: string): { text: string; marks: Mark[] } {
  let text = "";
  const marks: Mark[] = [];
  const append = (chunk: string): void => {
    let c = chunk.replace(/\s+/gu, " ");
    if (c.startsWith(" ") && (text === "" || text.endsWith(" "))) c = c.slice(1);
    text += c;
  };
  let last = 0;
  for (const m of body.matchAll(WORD_TAG)) {
    append(body.slice(last, m.index));
    const time = stampMs(m);
    if (time !== null) marks.push({ index: text.length, time });
    last = m.index + m[0].length;
  }
  append(body.slice(last));
  if (text.endsWith(" ")) text = text.slice(0, -1);
  for (const mark of marks) mark.index = Math.min(mark.index, text.length);
  return { text, marks };
}

function readOffset(lines: readonly string[]): number {
  for (const line of lines) {
    const m = META.exec(line.trim());
    if (m?.[1]?.toLowerCase() === "offset") {
      const ms = Number.parseInt(m[2]?.trim() ?? "", 10);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return 0;
}

/**
 * Word timing from enhanced LRC tags. Each word starts at the last tag at or before it; words that
 * share a tag split its span by weight. Tags inside a word (syllable karaoke) don't split the word:
 * they time its syllables (`parts`), when the word itself starts on a tag.
 * A tag at the very end closes the last word; without one, the last words get fallback timing.
 */
function taggedWords(text: string, marks: readonly Mark[], times: readonly number[], start: number, end: number): Word[] {
  const words: Word[] = [];
  /** per word: where it starts in `text`, and whether a tag starts it */
  const units: { at: number; text: string; tagged: boolean }[] = [];
  let group: string[] = [];
  let groupStart = start;
  let k = 0;
  let at = 0;
  for (const unit of splitWords(text)) {
    let tag = -1;
    while (k < marks.length && (marks[k]?.index ?? Infinity) <= at) tag = k++;
    if (tag >= 0) {
      const t = times[tag] ?? groupStart;
      words.push(...spreadWords(group, groupStart, t));
      group = [];
      groupStart = t;
    }
    units.push({ at, text: unit, tagged: tag >= 0 && marks[tag]?.index === at });
    group.push(unit);
    at += unit.length;
  }
  const closing = marks[marks.length - 1]?.index === text.length ? times[times.length - 1] : undefined;
  words.push(...(closing === undefined ? timeWords(group, groupStart, end) : spreadWords(group, groupStart, closing)));
  words.forEach((word, i) => {
    const unit = units[i];
    if (!unit?.tagged) return;
    const parts = syllableParts(word, unit.at, unit.text, marks, times);
    if (parts) word.parts = parts;
  });
  return words;
}

/**
 * A word's syllables from the tags inside it (strictly between its first and last letter), or null
 * when it has none. Times are kept inside the word and in order.
 */
function syllableParts(word: Word, at: number, unit: string, marks: readonly Mark[], times: readonly number[]): WordPart[] | null {
  const letters = unit.trimEnd().length;
  const inner: { index: number; time: number }[] = [];
  marks.forEach((m, i) => {
    if (m.index > at && m.index < at + letters) inner.push({ index: m.index - at, time: times[i] ?? word.start });
  });
  if (inner.length === 0) return null;
  const parts: WordPart[] = [];
  let from = 0;
  let t = word.start;
  for (const mark of inner) {
    if (mark.index <= from) continue;
    const next = Math.min(word.end, Math.max(t, mark.time));
    parts.push({ text: unit.slice(from, mark.index), start: t, end: next });
    from = mark.index;
    t = next;
  }
  parts.push({ text: unit.slice(from), start: t, end: Math.max(t, word.end) });
  return parts.length > 1 ? parts : null;
}

/**
 * Tags are kept when they run forwards and most of them fall near their line; the clamp to [start, end]
 * takes care of the few that don't (a held last word over a duet partner's next line, an early first
 * tag). A closing tag only bounds the last word and is clamped to `end` anyway, so it isn't counted,
 * unless it is the line's only tag.
 */
function wordsFor(entry: Entry, end: number, pace: number): { words: Word[]; estimated: boolean } {
  const { text, marks, shift, start } = entry;
  const times = marks.map((m) => m.time + shift);
  const near = (t: number): boolean => t >= start - TAG_SLACK_MS && t <= end + TAG_SLACK_MS;
  const forwards = times.every((t, i) => t >= (times[i - 1] ?? -Infinity));
  const counted = times.length > 1 && marks[marks.length - 1]?.index === text.length ? times.slice(0, -1) : times;
  const sane = forwards && counted.filter(near).length >= Math.ceil(counted.length / 2);
  if (marks.length === 0 || !sane) return { words: paceWords(splitWords(text), start, end, pace), estimated: true };
  return { words: taggedWords(text, marks, times.map((t) => Math.min(end, Math.max(start, t))), start, end), estimated: false };
}

/**
 * Parses LRC (plain or enhanced with `<mm:ss.xx>` word tags) into sorted lines with word timing.
 * Junk lines and metadata are skipped. An empty timed line is an instrumental gap: it ends the
 * line before it and has no words. When several lyric lines share one stamp, the first wins. Each line ends `LINE_GAP_MS` before the next one starts and
 * never runs past `durationMs`. Lines without word tags are sung at the pace of the lines around them
 * (timing.ts singingPace).
 */
export function parseLrc(raw: string, durationMs: number): Line[] {
  const rows = rowsOf(raw);
  const offset = readOffset(rows);

  const entries: Entry[] = [];
  for (const row of rows) {
    const stamped = readStamps(row);
    if (!stamped) continue;
    const { text, marks } = readBody(stamped.body);
    // With several stamps on one line, word tags belong to the stamp nearest the first tag.
    const firstTag = marks[0]?.time ?? 0;
    const ref = stamped.stamps.reduce((a, b) => (Math.abs(b - firstTag) < Math.abs(a - firstTag) ? b : a));
    for (const stamp of stamped.stamps) {
      entries.push({ start: Math.max(0, stamp - offset), text, marks, shift: stamp - ref - offset });
    }
  }

  // Gaps sort before lyrics that share their timestamp, so the lyric wins the tie.
  // Back-to-back gaps merge into the first.
  // Two lyric lines on one stamp (translated LRCs add the translation under the original): keep the
  // first, otherwise it would get zero length and only the second would ever show.
  entries.sort((a, b) => a.start - b.start || Number(a.text !== "") - Number(b.text !== ""));
  const kept: Entry[] = [];
  entries.forEach((entry, i) => {
    const prev = kept[kept.length - 1];
    if (entry.text === "") {
      if (prev?.text === "" || entries[i + 1]?.start === entry.start) return;
    } else if (prev && prev.text !== "" && prev.start === entry.start) {
      return;
    }
    kept.push(entry);
  });

  const limit = isKnownDuration(durationMs) ? durationMs : Infinity;
  const ends = kept.map((entry, i) => {
    const next = kept[i + 1];
    const natural = next ? next.start - LINE_GAP_MS : Number.isFinite(limit) ? limit : entry.start + LAST_LINE_MS;
    return Math.max(entry.start, Math.min(natural, limit));
  });
  const pace = singingPace(
    kept.map((entry, i) => ({
      start: entry.start,
      next: kept[i + 1]?.start ?? (ends[i] ?? entry.start) + LINE_GAP_MS,
      beats: entry.text === "" ? 0 : beatsOf(splitWords(entry.text)),
    })),
  );
  return kept.map((entry, i): Line => {
    const end = ends[i] ?? entry.start;
    if (entry.text === "") return { start: entry.start, end, text: entry.text, words: [] };
    const { words, estimated } = wordsFor(entry, end, pace[i] ?? NaN);
    return { start: entry.start, end, text: entry.text, words, ...(estimated ? { estimated } : {}) };
  });
}

/** How an LRC file's text is timed, for telling usable timing from timing that would hold one line all song. */
export interface LrcShape {
  /** rows with a stamp and some text */
  timedLyricRows: number;
  /** distinct stamps among those rows */
  distinctLyricStamps: number;
  /**
   * rows with text and no stamp anywhere, metadata left out. Rows that belong to the timed text are
   * left out too: one right under a timed lyric row (blank rows aside), its translation or
   * continuation, and one with a timed lyric row's text, the synced block pasted again as plain text.
   */
  untimedTextRows: number;
}

export function lrcShape(raw: string): LrcShape {
  let timedLyricRows = 0;
  const stamps = new Set<number>();
  const timedTexts = new Set<string>();
  const untimedTexts: string[] = [];
  // the last row with anything on it, metadata aside, was a timed lyric row (not a gap or a bad stamp)
  let underTimed = false;
  for (const row of rowsOf(raw)) {
    const line = row.trim();
    if (line === "" || META.test(line)) continue;
    const stamped = readStamps(line);
    if (stamped) {
      const { text } = readBody(stamped.body);
      underTimed = text !== "";
      if (text === "") continue;
      timedLyricRows++;
      timedTexts.add(text);
      for (const stamp of stamped.stamps) stamps.add(stamp);
    } else {
      if (!underTimed && !ANY_STAMP.test(line)) untimedTexts.push(readBody(line).text);
      underTimed = false;
    }
  }
  const untimedTextRows = untimedTexts.filter((text) => !timedTexts.has(text)).length;
  return { timedLyricRows, distinctLyricStamps: stamps.size, untimedTextRows };
}

/** The text of an LRC file as plain lyrics, one row per line: stamps, word tags and metadata rows removed. */
export function stripLrc(raw: string): string {
  return rowsOf(raw)
    .filter((row) => !META.test(row.trim()))
    .map((row) => readBody(row.replace(LEADING_STAMPS, "")).text)
    .join("\n");
}
