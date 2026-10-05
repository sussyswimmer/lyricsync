import { LINE_GAP_MS, isKnownDuration, splitWords, spreadWords, timeWords } from "./timing";

/**
 * One word (or one CJK character) and when it is sung, in ms. `text` keeps the space that
 * follows it, so a line's words joined with "" give back `Line.text`.
 */
export interface Word {
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
}

/** Span of the last line when the track duration is unknown. */
export const LAST_LINE_MS = 5000;
/** Word tags this far outside their line are junk; the line falls back to estimated timing. */
const TAG_SLACK_MS = 1000;

const STAMP = /^\[\s*(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\s*\]/u;
const WORD_TAG = /<\s*(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\s*>/gu;
const META = /^\[\s*([a-z#][\w#-]*)\s*:(.*)\]\s*$/iu;

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
 * share a tag split its span by weight. Tags inside a word (syllable karaoke) don't split the word.
 * A tag at the very end closes the last word; without one, the last words get fallback timing.
 */
function taggedWords(text: string, marks: readonly Mark[], times: readonly number[], start: number, end: number): Word[] {
  const words: Word[] = [];
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
    group.push(unit);
    at += unit.length;
  }
  const closing = marks[marks.length - 1]?.index === text.length ? times[times.length - 1] : undefined;
  words.push(...(closing === undefined ? timeWords(group, groupStart, end) : spreadWords(group, groupStart, closing)));
  return words;
}

function wordsFor(entry: Entry, end: number): Word[] {
  const { text, marks, shift, start } = entry;
  const times = marks.map((m) => m.time + shift);
  const sane = times.every((t, i) => t >= start - TAG_SLACK_MS && t <= end + TAG_SLACK_MS && t >= (times[i - 1] ?? -Infinity));
  if (marks.length === 0 || !sane) return timeWords(splitWords(text), start, end);
  return taggedWords(text, marks, times.map((t) => Math.min(end, Math.max(start, t))), start, end);
}

/**
 * Parses LRC (plain or enhanced with `<mm:ss.xx>` word tags) into sorted lines with word timing.
 * Junk lines and metadata are skipped. An empty timed line is an instrumental gap: it ends the
 * line before it and has no words. Each line ends `LINE_GAP_MS` before the next one starts and
 * never runs past `durationMs`.
 */
export function parseLrc(raw: string, durationMs: number): Line[] {
  const rows = raw.replace(/^\uFEFF/u, "").split(/\r\n|\r|\n/u);
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
  entries.sort((a, b) => a.start - b.start || Number(a.text !== "") - Number(b.text !== ""));
  const kept: Entry[] = [];
  entries.forEach((entry, i) => {
    const gap = entry.text === "";
    if (gap && (kept[kept.length - 1]?.text === "" || entries[i + 1]?.start === entry.start)) return;
    kept.push(entry);
  });

  const limit = isKnownDuration(durationMs) ? durationMs : Infinity;
  return kept.map((entry, i): Line => {
    const next = kept[i + 1];
    const natural = next ? next.start - LINE_GAP_MS : Number.isFinite(limit) ? limit : entry.start + LAST_LINE_MS;
    const end = Math.max(entry.start, Math.min(natural, limit));
    return { start: entry.start, end, text: entry.text, words: entry.text === "" ? [] : wordsFor(entry, end) };
  });
}
