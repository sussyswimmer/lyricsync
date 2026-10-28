/**
 * The automatic per-song look: style, face and motion character, picked from what Undertone knows
 * about a song (its lyrics and their timing, the title, the cover). There is no genre, BPM or audio
 * here, so "the style of the song" is read from how it is sung (pace, held notes, gaps, repetition),
 * what it is written in (script, line length) and what the cover looks like.
 *
 * `songFeatures` → `axesOf` → `pickLook`. Everything is pure and deterministic: the same song always
 * gets the same look, in every window. A stable hash of the trackKey only settles near-ties, never
 * overrides a clear pick. `LookKeeper` keeps the look stable while a song plays (one refinement at
 * most, applied at a safe point). Legibility comes first: a face without the song's letters, or too
 * wide or busy for its lines, is vetoed before any taste is scored, and long lines weigh heavily
 * against the styles that set the whole line in one row. Among styles that fit, the livelier one wins.
 */
import type { Lyrics, Mode, NowPlaying } from "../../contract/contract";
import { cjkLang, FONTS, fontFor, type CjkLang, type FontChoice } from "./faces";
import { MOVES, PLAIN_FLAIR, SPLASHES, themesOf, type Flair, type Move, type SplashKind, type Themes } from "./flair";
import type { Line } from "./lrc";
import type { CoverStats } from "./palette";
import { splitWords, syllables, type Timeline } from "./timing";

// ───────────────────────────────────────────── types ─────────────────────────────────────────────

/**
 * A style: the contract's four modes (Stack is how synced lyrics are drawn as a list), and nine the
 * overlay draws without the core knowing: Poster (the line as a block of rows set big), Spotlight
 * (the line sliding through the middle with the voice), Wave (the line riding a wave whose crest
 * follows the voice), Reveal (the line appearing word by word as it's sung), Collage (the line as
 * cut-out words, each its own size and tilt), Slant (kinetic type: the line built up word by word in a
 * slanted column, the sung word on a tag), Pop (one word at a time, huge, slammed in), Cascade (the
 * line stepping down the screen like stairs) and Tape (cut-out words stuck on strips of tape as
 * they're sung). Settings never names a style since contract v4, so the new ones need no contract
 * change.
 */
export type Style = Mode | "poster" | "spotlight" | "wave" | "reveal" | "collage" | "slant" | "pop" | "cascade" | "tape";
/** The contract's modes. */
export const CONTRACT_STYLES: readonly Mode[] = ["arc", "lens", "drift", "stack"];
/** Every style the overlay can draw. */
export const ALL_STYLES: readonly Style[] = [...CONTRACT_STYLES, "poster", "spotlight", "wave", "reveal", "collage", "slant", "pop", "cascade", "tape"];
/**
 * Styles neither Auto nor Settings › Style offers any more: they light the line but barely move with
 * the voice. Stack is still how plain lyrics are drawn (nothing can follow a voice without timing).
 */
export const RETIRED_STYLES = ["arc", "drift", "stack"] as const satisfies readonly Style[];
export type PickStyle = Exclude<Style, (typeof RETIRED_STYLES)[number]>;
/**
 * The styles the picker chooses between and Settings › Style offers, most reactive first; on equal
 * scores the earlier one ranks first.
 */
export const STYLES: readonly PickStyle[] = ["slant", "pop", "cascade", "tape", "spotlight", "wave", "reveal", "collage", "lens", "poster"];

/** How the lyrics are timed: per word (enhanced LRC), per line, evenly paced plain text, or no lyrics. */
export type Timing = "word" | "line" | "unsynced" | "none";
/** The writing system most of the lyrics are in. */
export type Script = "latin" | "cjk" | "cyrillic" | "greek" | "rtl" | "other";
/** Weak hints from words in the title or album. */
export type Hint = "intimate" | "live" | "dance" | "fast" | "dreamy" | "sparse" | "slow";

export interface SongInput {
  track: Pick<NowPlaying, "trackKey" | "title" | "album" | "durationMs">;
  /** the lines the stage shows (viewFor's timeline), gaps included; [] with no lyrics */
  lines: readonly Line[];
  timing: Timing;
  /** null while the artwork is missing or undecodable (PaletteCache.cover) */
  cover: CoverStats | null;
}

export interface SongFeatures {
  trackKey: string;
  timing: Timing;
  durationMs: number;
  /** lyric lines (gaps left out) */
  lines: number;
  /** median syllables per second while singing, per line */
  rate: number;
  /** spread of the per-line rate: (p75 - p25) / median */
  rateSpread: number;
  /** lyric lines per minute across the stretch that has lyrics */
  linesPerMin: number;
  /** line width in half-em units (a CJK character counts 2): median and 90th percentile */
  widthMedian: number;
  widthP90: number;
  /** share of lines of at most three words (or 8 half-ems of CJK) */
  shortLines: number;
  /** word timing only: median and 90th percentile word duration, ms */
  wordMsMedian: number | null;
  wordMsP90: number | null;
  /** word durations sorted ascending (word timing only), for the emphasis threshold */
  wordMs: readonly number[];
  /** share of words held ≥ 1 s (word timing), or of lines sung slower than 1.8 syllables/s (line timing) */
  held: number;
  /** share of the song with no line being sung */
  instrumental: number;
  /** longest silence between two sung lines, ms (intro and outro left out) */
  longestGapMs: number;
  /** silences of 8 s or more between sung lines */
  longGaps: number;
  /** share of lines repeated elsewhere in the song (exact or near), anaphora counting half */
  repetition: number;
  /** share of shouted lines: mostly capitals, or ending in "!" */
  shout: number;
  /** share of lines that are mostly vocables (oh, la, na, yeah, hey...) */
  vocables: number;
  script: Script;
  /** the CJK language when CJK makes up a real share of the text */
  cjk: CjkLang | null;
  cjkShare: number;
  latinShare: number;
  vietnamese: boolean;
  /** Cyrillic or Greek letters make up a real share (faces must have them) */
  cyrillic: boolean;
  greek: boolean;
  hints: readonly Hint[];
  cover: CoverStats | null;
  /** what the lyrics mention (water, fire, a party, the night sky), for the splash */
  themes: Themes;
}

/** Perceptual axes, 0..1 each (warm is -1..1), the level the picker reasons at. */
export interface Axes {
  pace: number;
  density: number;
  /** lines too long for one curved or fisheyed row */
  longLines: number;
  sustain: number;
  space: number;
  punch: number;
  vivid: number;
  light: number;
  warm: number;
  gray: number;
  intimacy: number;
  /** how much the lyrics tell (few lines → close to neutral) */
  confidence: number;
}

/** Which words get the held-note treatment (a per-letter wave, a stronger glow). */
export interface EmphasisRule {
  /** a word held at least this long, ms... */
  minMs: number;
  /** ...with at most this many characters */
  maxChars: number;
  /** only a line's last word (line timing: the other word times are estimates) */
  lastWordOnly: boolean;
}

/**
 * A song's look: everything the stage draws it with (it is a PickedLook, src/overlay/look.ts), then
 * why it was picked, for the settings card and QA.
 */
export interface SongLook {
  style: Style;
  /** a bundled face at its one bundled weight (FONTS) */
  font: { family: string; weight: number };
  /** -100..100 like Settings.curve; used by Arc */
  curve: number;
  /** motion amplitude 0.2..1 at the default Effects level */
  energy: number;
  /** spring stiffness 0..1: fast songs settle quickly, slow ones float */
  snap: number;
  /** highlight bloom 0.3..1 at the default Glow level */
  glow: number;
  /** null: no held-note treatment (plain lyrics, no lyrics) */
  emphasis: EmphasisRule | null;
  /** multiplies Settings.size, 0.82..1.2 */
  scale: number;
  /** em */
  letterSpacing: number;
  textCase: "as-is" | "upper";
  /** Effects mode's flair: how the words move, and the splash (core/flair.ts) */
  flair: Flair;
  /** the two or three things about the song that drove the pick, in plain words */
  traits: string[];
  /** e.g. "slow, long held notes → Arc with Instrument Serif" */
  reason: string;
  /** the scores behind the pick, for QA */
  scores: { style: Record<PickStyle, number>; font: Record<string, number> };
  /** true where a near-tie was settled by the trackKey hash rather than by the scores */
  ties: { style: boolean; font: boolean };
}

// ─────────────────────────────────────────── helpers ───────────────────────────────────────────

const clamp = (v: number, lo = 0, hi = 1): number => Math.max(lo, Math.min(hi, v));
/** 0 at or below a, 1 at or above b, smooth in between. */
function smooth(x: number, a: number, b: number): number {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
/** 1 at `center`, falling off like a Gaussian of width `width`. */
const bell = (x: number, center: number, width: number): number => Math.exp(-(((x - center) / width) ** 2));
const round = (v: number, digits = 2): number => Math.round(v * 10 ** digits) / 10 ** digits;

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = clamp(q) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}
const sortedOf = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);

/** FNV-1a, 32 bit, as a fraction in [0, 1): the same trackKey always gives the same number. */
export function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x1_0000_0000;
}

// ─────────────────────────────────────────── lyrics ───────────────────────────────────────────

const WORD_TAG = /<\s*\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\s*>/u;
const LEADING_STAMPS = /^(?:\s*\[\s*\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\s*\])+/u;

/** True when at least half the timed lyric rows carry enhanced `<mm:ss.xx>` word tags. */
export function hasWordTags(raw: string): boolean {
  let timed = 0;
  let tagged = 0;
  for (const row of raw.split(/\r\n|\r|\n/u)) {
    const stamps = LEADING_STAMPS.exec(row);
    if (!stamps) continue;
    const body = row.slice(stamps[0].length);
    if (body.replace(/<[^>]*>/gu, "").trim() === "") continue;
    timed++;
    if (WORD_TAG.test(body)) tagged++;
  }
  return timed > 0 && tagged * 2 >= timed;
}

/** How a lyrics result is timed, given the timeline the stage built from it (viewFor), or null for none. */
export function timingOf(lyrics: Pick<Lyrics, "synced"> | null, timeline: Timeline | null): Timing {
  if (!timeline || !timeline.lines.some((l) => l.words.length > 0)) return "none";
  if (timeline.unsynced) return "unsynced";
  return lyrics?.synced && hasWordTags(lyrics.synced) ? "word" : "line";
}

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WIDE_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
const MARK = /\p{M}/u;
const LETTER = /\p{L}/u;
const SCRIPT_TESTS: readonly [Exclude<Script, "other">, RegExp][] = [
  ["latin", /\p{Script=Latin}/u],
  ["cjk", CJK_CHAR],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["greek", /\p{Script=Greek}/u],
  ["rtl", /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u],
];
/** A CJK character carries about as much as a short Latin word: count it this many letters. */
const CJK_LETTERS = 3;
/** Letters only Vietnamese writes: ă đ ơ ư and the tone-marked vowels of Latin Extended Additional. */
const VIETNAMESE = /[ăđơưĂĐƠƯẠ-ỹ]/gu;
const VOCABLE = /^(?:o+h*|a+h+|la|na|da|doo|du|ya+|yeah+|yea|yo|hey+|ho|whoa+|woah+|woo+|uh+|mm+|hmm+|ay+|eh+|ey|ha)$/u;

/**
 * Version tags live in the title ("(Acoustic)", "- Live", "(Club Mix)"). Album names are matched only
 * for words that rarely mean anything else there ("MTV Unplugged", "Remixes"): "Demo" or "Live" in an
 * album name is too often just a name.
 */
const TITLE_HINTS: readonly [Hint, RegExp][] = [
  ["intimate", /\b(?:acoustic|unplugged|stripped|piano version|voice memo|lo-?fi)\b|[([\-–—]\s*(?:[a-z]+ )?(?:demo|piano)\b/u],
  ["live", /[([\-–—]\s*live\b|\blive (?:at|from|in|session)\b/u],
  ["dance", /\b(?:remix|club|extended mix|vip|bootleg|rework|dub mix|[a-z]+ mix)\b/u],
  ["fast", /\b(?:sped up|speed up|nightcore|hyperpop)\b/u],
  ["dreamy", /\b(?:slowed|reverb|lullaby)\b/u],
  ["sparse", /\b(?:interlude|intro|outro|prelude|skit|reprise|instrumental)\b/u],
  ["slow", /\b(?:ballad|nocturne|lament|requiem|hymn|serenade|lullaby)\b/u],
];
const ALBUM_HINTS: readonly [Hint, RegExp][] = [
  ["intimate", /\b(?:unplugged|acoustic)\b/u],
  ["live", /\blive (?:at|from|in)\b/u],
  ["dance", /\bremix(?:es|ed)\b/u],
];

/** Version tags from the title, and the few unambiguous ones from the album. */
export function hintsOf(title: string, album: string): Hint[] {
  const norm = (t: string): string => t.normalize("NFKC").toLowerCase();
  const found = new Set<Hint>();
  for (const [hint, re] of TITLE_HINTS) if (re.test(norm(title))) found.add(hint);
  for (const [hint, re] of ALBUM_HINTS) if (re.test(norm(album))) found.add(hint);
  return [...found];
}

/** Width in half-em units: a CJK or full-width character counts 2, combining marks 0. */
function widthOf(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (MARK.test(ch)) continue;
    w += WIDE_CHAR.test(ch) ? 2 : 1;
  }
  return w;
}

/** Lower case, punctuation and symbols (hyphens too) turned into spaces, spaces collapsed. */
const normalizeText = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}]/gu, " ").replace(/\s+/gu, " ").trim();

/** Words for Latin-like lines; character pairs for CJK lines (which don't space their words). */
function tokensOf(norm: string): string[] {
  const chars = [...norm.replace(/\s/gu, "")];
  const cjk = chars.filter((c) => CJK_CHAR.test(c)).length;
  if (cjk * 2 >= chars.length && chars.length > 1) return chars.slice(1).map((c, i) => `${chars[i] ?? ""}${c}`);
  return norm.split(" ").filter((t) => t !== "");
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let both = 0;
  for (const t of a) if (b.has(t)) both++;
  return both / (a.size + b.size - both);
}

/** Share of lines that come back: the same text 1, nearly the same (Jaccard ≥ 0.6) 1, the same opening two words 0.5. */
function repetitionOf(texts: readonly string[]): number {
  if (texts.length < 2) return 0;
  const norms = texts.map(normalizeText);
  const tokens = norms.map(tokensOf);
  const sets = tokens.map((t) => new Set(t));
  let total = 0;
  for (let i = 0; i < norms.length; i++) {
    let best = 0;
    for (let j = 0; j < norms.length && best < 1; j++) {
      if (i === j) continue;
      const a = tokens[i] ?? [];
      const b = tokens[j] ?? [];
      if (norms[i] === norms[j] || jaccard(sets[i] ?? new Set(), sets[j] ?? new Set()) >= 0.6) best = 1;
      else if (a.length >= 3 && b.length >= 3 && a[0] === b[0] && a[1] === b[1]) best = Math.max(best, 0.5);
    }
    total += best;
  }
  return total / norms.length;
}

function isShout(text: string): boolean {
  if (/!\s*$/u.test(text)) return true;
  const letters = text.match(/\p{Script=Latin}/gu) ?? [];
  if (letters.length < 4) return false;
  const upper = letters.filter((c) => c !== c.toLowerCase()).length;
  return upper / letters.length >= 0.7;
}

/** Mostly vocables; "oh-oh" counts as two (normalizeText splits it). */
function isVocables(text: string): boolean {
  const words = normalizeText(text).split(" ").filter((w) => w !== "");
  if (words.length === 0) return false;
  return words.filter((w) => VOCABLE.test(w)).length / words.length >= 0.6;
}

/** Share of a line-timed line's slot that is sung. */
const LINE_FILL = 0.8;

/** The singing span of a line, ms: first word to last word with real word timing, else estimated. */
function sungSpan(line: Line, timing: Timing, syll: number): number {
  const first = line.words[0];
  const last = line.words[line.words.length - 1];
  if (timing === "word" && first && last) return Math.max(250, last.end - first.start);
  // Line timing: the line runs until the next one starts, the breath before it and instrumental breaks
  // included. Singing fills about 80% of a line's slot, and nobody sings a syllable longer than about
  // 0.7 s on average over a line, so cap the span there.
  return Math.max(250, Math.min(LINE_FILL * (line.end - line.start), 700 * syll + 800));
}

/** Everything the picker needs, from the song alone. Pure; about 2 ms for a long song. */
export function songFeatures(input: SongInput): SongFeatures {
  const { track, timing, cover } = input;
  const lyric = input.lines.filter((l) => l.words.length > 0);
  const texts = lyric.map((l) => l.text);
  const lastEnd = lyric[lyric.length - 1]?.end ?? 0;
  const durationMs = Number.isFinite(track.durationMs) && track.durationMs > 0 ? track.durationMs : Math.max(lastEnd, 1);

  // ── pace and holds
  const rates: number[] = [];
  const spans: number[] = [];
  const wordMs: number[] = [];
  let slowLines = 0;
  for (const line of lyric) {
    const syll = Math.max(1, line.words.reduce((sum, w) => sum + syllables(w.text), 0));
    const span = sungSpan(line, timing, syll);
    spans.push(span);
    const rate = (syll * 1000) / span;
    rates.push(rate);
    if (rate < 1.8) slowLines++;
    if (timing === "word") for (const w of line.words) if (w.end > w.start) wordMs.push(w.end - w.start);
  }
  const sortedRates = sortedOf(rates);
  const rate = quantile(sortedRates, 0.5);
  const rateSpread = rate > 0 ? (quantile(sortedRates, 0.75) - quantile(sortedRates, 0.25)) / rate : 0;
  const sortedWordMs = sortedOf(wordMs);
  const held =
    timing === "word"
      ? sortedWordMs.length > 0
        ? sortedWordMs.filter((d) => d >= 1000).length / sortedWordMs.length
        : 0
      : lyric.length > 0
        ? slowLines / lyric.length
        : 0;

  // ── space
  const sung = spans.reduce((a, b) => a + b, 0);
  let longestGapMs = 0;
  let longGaps = 0;
  for (let i = 0; i + 1 < lyric.length; i++) {
    const gap = (lyric[i + 1]?.start ?? 0) - ((lyric[i]?.start ?? 0) + (spans[i] ?? 0));
    longestGapMs = Math.max(longestGapMs, gap);
    if (gap >= 8000) longGaps++;
  }
  const firstStart = lyric[0]?.start ?? 0;
  const lyricWindow = timing === "unsynced" ? durationMs : Math.max(1000, lastEnd - firstStart);
  const linesPerMin = lyric.length / (lyricWindow / 60_000);

  // ── shape
  const widths = sortedOf(texts.map(widthOf));
  const shortLines = lyric.filter((l) => {
    const cjk = [...l.text].filter((c) => CJK_CHAR.test(c)).length;
    return cjk > 0 ? widthOf(l.text) <= 8 : splitWords(l.text).length <= 3;
  }).length;

  // ── script
  const all = texts.join("\n");
  const counts: Record<Script, number> = { latin: 0, cjk: 0, cyrillic: 0, greek: 0, rtl: 0, other: 0 };
  for (const ch of all) {
    if (!LETTER.test(ch)) continue;
    const hit = SCRIPT_TESTS.find(([, re]) => re.test(ch));
    if (hit) counts[hit[0]] += hit[0] === "cjk" ? CJK_LETTERS : 1;
    else counts.other++;
  }
  const letters = Object.values(counts).reduce((a, b) => a + b, 0);
  const share = (s: Script): number => (letters > 0 ? counts[s] / letters : 0);
  const script =
    letters === 0 ? "latin" : (Object.keys(counts) as Script[]).reduce((a, b) => (counts[b] > counts[a] ? b : a), "latin");
  const cjkShare = share("cjk");

  return {
    trackKey: track.trackKey,
    timing,
    durationMs,
    lines: lyric.length,
    rate: round(rate),
    rateSpread: round(rateSpread),
    linesPerMin: round(linesPerMin, 1),
    widthMedian: round(quantile(widths, 0.5), 1),
    widthP90: round(quantile(widths, 0.9), 1),
    shortLines: lyric.length > 0 ? round(shortLines / lyric.length) : 0,
    wordMsMedian: timing === "word" && sortedWordMs.length > 0 ? Math.round(quantile(sortedWordMs, 0.5)) : null,
    wordMsP90: timing === "word" && sortedWordMs.length > 0 ? Math.round(quantile(sortedWordMs, 0.9)) : null,
    wordMs: sortedWordMs,
    held: round(held),
    instrumental: lyric.length > 0 && timing !== "unsynced" ? round(clamp(1 - sung / durationMs)) : 0,
    longestGapMs: Math.round(Math.max(0, longestGapMs)),
    longGaps,
    repetition: round(repetitionOf(texts)),
    shout: lyric.length > 0 ? round(texts.filter(isShout).length / lyric.length) : 0,
    vocables: lyric.length > 0 ? round(texts.filter(isVocables).length / lyric.length) : 0,
    script,
    // with no languages, so the pick can't depend on the reader's locale
    cjk: cjkShare >= 0.05 ? cjkLang(all, []) : null,
    cjkShare: round(cjkShare),
    latinShare: round(share("latin")),
    // composed first: decomposed text writes ă as a + a combining breve
    vietnamese: (all.normalize("NFC").match(VIETNAMESE)?.length ?? 0) >= 2,
    cyrillic: share("cyrillic") >= 0.1,
    greek: share("greek") >= 0.1,
    hints: hintsOf(track.title, track.album),
    cover,
    themes: themesOf(lyric),
  };
}

// ─────────────────────────────────────────── axes ───────────────────────────────────────────

const has = (f: SongFeatures, hint: Hint): number => (f.hints.includes(hint) ? 1 : 0);
const NEUTRAL = 0.4;

/** The features as perceptual axes. Lyric-derived axes lean toward neutral when there are few lines. */
export function axesOf(f: SongFeatures): Axes {
  const synced = f.timing === "word" || f.timing === "line";
  // Fewer than about ten lines say little about a song: pull every lyric-derived axis toward neutral.
  const confidence = synced ? smooth(f.lines, 2, 12) : f.timing === "unsynced" ? 0.5 * smooth(f.lines, 2, 12) : 0;
  const trust = (v: number): number => NEUTRAL + (clamp(v) - NEUTRAL) * (0.35 + 0.65 * confidence);

  const pace = synced ? smooth(f.rate, 2.2, 6.5) : 0.35;
  const sustain =
    f.timing === "word"
      ? 0.55 * smooth(f.held, 0.03, 0.22) + 0.45 * smooth(f.wordMsP90 ?? 0, 650, 1500)
      : f.timing === "line"
        ? 0.8 * smooth(f.held, 0.1, 0.6)
        : 0.3;
  const space = synced
    ? 0.4 * smooth(f.instrumental, 0.35, 0.75) + 0.35 * smooth(f.longestGapMs, 6000, 22_000) + 0.25 * (1 - smooth(f.linesPerMin, 5, 16))
    : 0.6 * (1 - smooth(f.linesPerMin, 4, 14));
  const punch =
    0.4 * smooth(f.repetition, 0.15, 0.6) + 0.25 * smooth(f.shout, 0.05, 0.4) + 0.2 * smooth(f.vocables, 0.02, 0.2) + 0.15 * smooth(f.shortLines, 0.2, 0.6);
  const density = 0.55 * smooth(f.widthMedian, 16, 46) + 0.25 * smooth(f.widthP90, 30, 80) + 0.2 * smooth(f.linesPerMin, 8, 26);

  const c = f.cover;
  const vivid = c ? 0.55 * c.colorfulness + 0.25 * smooth(c.chroma, 0.08, 0.35) + 0.2 * smooth(c.contrast, 0.08, 0.28) : NEUTRAL;
  const a: Axes = {
    pace: clamp(trust(pace) + 0.15 * has(f, "fast") - 0.1 * has(f, "dreamy") - 0.1 * has(f, "slow")),
    density: f.lines > 0 ? clamp(density) : NEUTRAL,
    longLines: smooth(f.widthP90, 46, 90),
    sustain: clamp(trust(sustain) + 0.12 * has(f, "slow")),
    space: clamp(trust(space) + 0.2 * has(f, "sparse") + 0.1 * has(f, "dreamy")),
    punch: clamp(trust(punch) + 0.15 * has(f, "dance") + 0.1 * has(f, "live")),
    vivid: clamp(vivid),
    light: c ? c.lightness : 0.45,
    warm: c ? c.warmth : 0,
    gray: c ? c.gray : 0.5,
    intimacy: 0,
    confidence,
  };
  a.intimacy = clamp(
    0.35 * (1 - a.pace) + 0.25 * (1 - a.density) + 0.2 * (1 - a.vivid) + 0.2 * (1 - a.punch) + 0.25 * has(f, "intimate") - 0.1 * has(f, "live") - 0.15,
  );
  return a;
}

// ─────────────────────────────────────────── styles ───────────────────────────────────────────

const STYLE_LABEL: Record<Style, string> = {
  arc: "Arc",
  lens: "Lens",
  drift: "Drift",
  stack: "Stack",
  poster: "Poster",
  spotlight: "Spotlight",
  wave: "Wave",
  reveal: "Reveal",
  collage: "Collage",
  slant: "Slant",
  pop: "Pop",
  cascade: "Cascade",
  tape: "Tape",
};
/** How far the house face (Fraunces) is favored when the lyrics are too short to tell much. */
const HOUSE_PRIOR = 0.15;
/**
 * How much each style moves with the voice, 0..1: Pop and Slant throw every word at the screen; Lens
 * and Poster mostly light words where they sit. The picker always leans toward the livelier ones.
 */
const REACTIVITY: Record<PickStyle, number> = {
  slant: 1,
  pop: 1,
  cascade: 0.9,
  tape: 0.85,
  spotlight: 0.85,
  wave: 0.85,
  reveal: 0.7,
  collage: 0.7,
  lens: 0.6,
  poster: 0.55,
};
/**
 * How far reactivity weighs against fit. Pop over Poster is worth about 0.22: more than most edges in
 * fit, less than the legibility penalties (long lines, a pace too fast to read a word at a time).
 */
const REACTIVITY_WEIGHT = 0.5;
/**
 * Styles scoring within this of the best can be a song's look, chosen by the trackKey hash, so similar
 * songs don't all look the same. Tight: the best fit wins unless another is about as good, and never
 * for a style much calmer than the best.
 */
const STYLE_VARIETY = 0.04;
const VARIETY_CALMER = 0.2;
const FONT_TIE = 0.03;

function styleScores(f: SongFeatures, a: Axes): Record<PickStyle, number> {
  const timed = f.timing === "word" ? 1 : f.timing === "line" ? 0.5 : 0;
  const scores: Record<PickStyle, number> = {
    // the spotlight follows the voice: needs real timing (it magnifies the estimated word of a line-timed
    // song more than any other style), a pace the eye can follow, hooks
    lens:
      0.26 * (f.timing === "word" ? 1 : f.timing === "line" ? 0.3 : 0) + 0.26 * bell(a.pace, 0.5, 0.32) + 0.2 * a.punch + 0.14 * a.vivid + 0.14 * (1 - 0.5 * a.sustain) -
      0.5 * a.longLines - 0.3 * smooth(a.pace, 0.8, 1),
    // a gig poster: hooks, a beat to dance to, bright covers; short and medium lines set big in rows
    poster:
      0.3 * a.punch + 0.22 * bell(a.pace, 0.55, 0.3) + 0.16 * a.vivid + 0.12 * (1 - a.sustain) + 0.1 * has(f, "dance") + 0.1 * timed + 0.25 * smooth(f.shout, 0.05, 0.4) -
      0.45 * a.longLines - 0.12 * a.intimacy - 0.25 * smooth(f.widthMedian, 30, 46),
    // one word at a time in the middle: slow, spacious songs whose words each get their moment; needs
    // the timing to be real, and words slow enough to read one by one
    spotlight:
      0.3 * a.sustain + 0.22 * a.space + 0.2 * (1 - a.pace) + 0.12 * (1 - a.density) + 0.12 * (f.timing === "word" ? 1 : f.timing === "line" ? 0.35 : 0) -
      0.4 * a.longLines - 0.4 * smooth(a.pace, 0.55, 0.85) - 0.05,
    // a groove: dance, electronic and upbeat pop, a pace to bob to, hooks, bright covers; lines short
    // enough to ride the wave
    wave:
      0.3 * bell(a.pace, 0.6, 0.25) + 0.24 * a.punch + 0.24 * has(f, "dance") + 0.16 * a.vivid + 0.14 * timed + 0.1 * (1 - a.sustain) +
      0.1 * smooth(f.vocables, 0.02, 0.2) - 0.45 * a.longLines - 0.12 * a.intimacy - 0.2 * smooth(f.widthMedian, 30, 44) - 0.04,
    // words landing as they're said: rap, spoken and story songs, fast and wordy, little held; needs real
    // word timing, and lines that still fit one row
    reveal:
      0.3 * a.pace + 0.2 * a.density + 0.14 * (1 - a.sustain) + 0.14 * (f.timing === "word" ? 1 : f.timing === "line" ? 0.2 : 0) + 0.08 * (1 - a.light) -
      0.5 * smooth(f.widthP90, 56, 84) - 0.12 * a.punch * smooth(f.repetition, 0.4, 0.8) - 0.2 * (f.script === "cjk" ? a.density : 0) - 0.06,
    // a zine of cut-out words: rock, punk and raw songs, shouted, live, gritty grey or dark covers; short
    // and medium lines
    collage:
      0.3 * a.punch + 0.3 * smooth(f.shout, 0.05, 0.4) + 0.2 * bell(a.pace, 0.6, 0.3) + 0.16 * has(f, "live") + 0.18 * (1 - a.vivid) * (1 - 0.5 * a.light) +
      0.1 * timed - 0.45 * a.longLines - 0.2 * smooth(f.widthMedian, 32, 48) - 0.1 * a.intimacy - 0.02,
    // kinetic type, word by word up a slanted column: rap, drill and fast punchy hooks, dark covers;
    // each word gets its own row, so long bars still fit; needs the timing to be real
    slant:
      0.28 * a.pace + 0.24 * a.punch + 0.16 * (f.timing === "word" ? 1 : f.timing === "line" ? 0.45 : 0) + 0.12 * a.density + 0.1 * (1 - a.sustain) +
      0.1 * (1 - a.light) - 0.08 * a.longLines - 0.12 * a.intimacy - 0.25 * smooth(a.pace, 0.92, 1) - 0.06,
    // one word at a time, huge: chants and hooks, shouted and repeated lines, a pace slow enough to read
    // a word at a time
    pop:
      0.24 * a.punch + 0.22 * smooth(f.shout, 0.05, 0.4) + 0.18 * bell(a.pace, 0.5, 0.25) + 0.16 * smooth(f.repetition, 0.3, 0.7) + 0.12 * timed + 0.1 * f.shortLines -
      0.3 * smooth(a.pace, 0.7, 0.9) - 0.2 * a.longLines - 0.06,
    // stairs down the screen: flowing mid-tempo songs, held notes, vivid covers, dreamy titles
    cascade:
      0.22 * bell(a.pace, 0.45, 0.3) + 0.18 * a.sustain + 0.16 * a.vivid + 0.14 * timed + 0.12 * has(f, "dreamy") + 0.1 * (1 - a.density) + 0.08 * a.space -
      0.3 * a.longLines - 0.06,
    // a DIY zine taped together: indie, punk-pop and garage songs, bright covers, live takes, hooks
    tape:
      0.26 * a.punch + 0.2 * bell(a.pace, 0.55, 0.3) + 0.24 * a.vivid * (0.4 + 0.6 * a.light) + 0.14 * has(f, "live") + 0.2 * smooth(f.shout, 0.05, 0.4) + 0.1 * timed -
      0.4 * a.longLines - 0.15 * smooth(f.widthMedian, 32, 48) - 0.03,
  };
  for (const s of STYLES) scores[s] = round(scores[s] + REACTIVITY_WEIGHT * REACTIVITY[s], 3);
  return scores;
}

function pickStyle(f: SongFeatures, a: Axes): { style: Style; scores: Record<PickStyle, number>; tie: boolean } {
  const scores = styleScores(f, a);
  // Plain lyrics paced evenly can be anywhere in the song: show several lines, and nothing that
  // tracks a word. Without lyrics the stage shows a state, so the style is only a placeholder.
  if (f.timing === "none" || f.timing === "unsynced") return { style: "stack", scores, tie: false };
  const order = ranked(scores, STYLES);
  const best = order[0] ?? "slant";
  const near = order.filter((s) => scores[best] - scores[s] < STYLE_VARIETY && REACTIVITY[s] >= REACTIVITY[best] - VARIETY_CALMER);
  if (near.length < 2) return { style: best, scores, tie: false };
  return { style: near[Math.min(near.length - 1, Math.floor(stableHash(`${f.trackKey}#style`) * near.length))] ?? best, scores, tie: true };
}

// ─────────────────────────────────────────── fonts ───────────────────────────────────────────

/**
 * Faces that sit well next to the system's CJK faces a CJK song is mostly set in: the serifs with
 * Mincho or Song, Bricolage and System with the Gothics. The display faces look pasted in.
 */
const CJK_PARTNERS: ReadonlySet<string> = new Set(["Fraunces", "Instrument Serif", "Bricolage Grotesque", "System"]);

/** Size multiplier and tracking per face: wide faces a touch smaller and tighter, light or small-eyed ones larger. */
const METRICS: Record<string, { scale: number; spacing: number }> = {
  Fraunces: { scale: 1, spacing: 0 },
  "Instrument Serif": { scale: 1.12, spacing: 0.01 },
  Syne: { scale: 0.94, spacing: -0.01 },
  Unbounded: { scale: 0.88, spacing: -0.02 },
  "Bricolage Grotesque": { scale: 1, spacing: 0 },
  Caveat: { scale: 1.1, spacing: 0 },
  "JetBrains Mono": { scale: 0.92, spacing: -0.02 },
  Anton: { scale: 1.06, spacing: 0.01 },
  "Playfair Display": { scale: 1, spacing: 0 },
  "Space Grotesk": { scale: 0.96, spacing: -0.01 },
  Righteous: { scale: 0.96, spacing: 0 },
  Pacifico: { scale: 0.96, spacing: 0 },
  Rubik: { scale: 0.96, spacing: -0.01 },
  "Pirata One": { scale: 1.08, spacing: 0.01 },
  "Archivo Black": { scale: 0.9, spacing: -0.01 },
  "Bebas Neue": { scale: 1.12, spacing: 0.02 },
  Oswald: { scale: 1.04, spacing: 0 },
  "DM Serif Display": { scale: 1.02, spacing: 0 },
  "Abril Fatface": { scale: 0.98, spacing: 0 },
  "Sedgwick Ave Display": { scale: 1.08, spacing: 0 },
  Bungee: { scale: 0.84, spacing: 0 },
  Silkscreen: { scale: 0.82, spacing: 0 },
  "Bodoni Moda": { scale: 1.02, spacing: 0 },
  Shrikhand: { scale: 0.9, spacing: 0 },
  "Chakra Petch": { scale: 0.98, spacing: 0 },
  "Lilita One": { scale: 1, spacing: 0 },
  System: { scale: 1, spacing: 0 },
};

/** Why a face can't set this song, or null when it can. */
function fontVeto(face: FontChoice, f: SongFeatures, a: Axes): string | null {
  if (f.vietnamese && !face.vietnamese) return "no Vietnamese";
  if (f.cyrillic && !face.cyrillic) return "no Cyrillic";
  if (f.greek && !face.greek) return "no Greek";
  if (f.script === "cjk" && !CJK_PARTNERS.has(face.family)) return "Latin display face";
  if ((f.script === "rtl" || f.script === "other") && face.family !== "System") return "script not covered";
  switch (face.family) {
    case "Caveat":
      if (a.pace > 0.5 || f.widthMedian > 36 || a.density > 0.55) return "handwriting too busy for fast or long lines";
      break;
    case "Unbounded":
      if (f.widthP90 > 38 || f.widthMedian > 26) return "too wide for long lines";
      break;
    case "Syne":
    case "JetBrains Mono":
      if (f.widthP90 > 50) return "too wide for long lines";
      break;
    case "Instrument Serif":
      if (a.pace > 0.6 || a.density > 0.6) return "hairline serif too thin for fast dense lines";
      break;
    case "Playfair Display":
      if (a.pace > 0.7) return "hairline serif too thin for fast lines";
      break;
    case "Righteous":
      if (f.widthP90 > 56) return "too wide for long lines";
      break;
    case "Pacifico":
      if (a.pace > 0.55 || f.widthMedian > 32 || a.density > 0.5) return "script too busy for fast or long lines";
      break;
    case "Pirata One":
      if (f.widthMedian > 28 || f.widthP90 > 46 || a.pace > 0.75 || a.light > 0.42) return "blackletter only for short lines of dark, heavy songs";
      break;
    case "Archivo Black":
      if (f.widthP90 > 64) return "too heavy and wide for long lines";
      break;
    case "Bungee":
      if (f.widthP90 > 40 || f.widthMedian > 28) return "block capitals too wide for long lines";
      break;
    case "Silkscreen":
      if (f.widthP90 > 40 || a.pace > 0.75) return "pixel face too wide or busy for long, fast lines";
      break;
    case "Shrikhand":
      if (f.widthP90 > 48) return "too wide for long lines";
      break;
    case "Sedgwick Ave Display":
      if (f.widthP90 > 70 || a.pace < 0.25) return "graffiti hand for street songs, not long or slow lines";
      break;
    case "Abril Fatface":
      if (a.pace > 0.8) return "hairline serif too thin for fast lines";
      break;
    case "Bodoni Moda":
      if (a.pace > 0.7 || a.density > 0.65) return "hairline serif too thin for fast dense lines";
      break;
  }
  return null;
}

/** Faces that suit each style. */
const HARMONY: Partial<Record<Style, Partial<Record<string, number>>>> = {
  poster: {
    Unbounded: 0.1,
    Syne: 0.1,
    Anton: 0.1,
    "Bebas Neue": 0.08,
    "Bricolage Grotesque": 0.08,
    Bungee: 0.06,
    "Abril Fatface": 0.06,
    Righteous: 0.06,
    "Pirata One": 0.06,
    Rubik: 0.04,
    Fraunces: 0.04,
  },
  spotlight: { "Instrument Serif": 0.08, Fraunces: 0.08, "Playfair Display": 0.08, "Bodoni Moda": 0.06, "DM Serif Display": 0.06, Syne: 0.04, Anton: 0.04 },
  wave: { Rubik: 0.08, Righteous: 0.08, Pacifico: 0.06, Syne: 0.06, "Space Grotesk": 0.06, Shrikhand: 0.06, "Lilita One": 0.06, Unbounded: 0.04 },
  reveal: { Anton: 0.08, "Bricolage Grotesque": 0.08, "Space Grotesk": 0.06, "JetBrains Mono": 0.06, Oswald: 0.06, "Chakra Petch": 0.04, System: 0.04 },
  collage: { Anton: 0.08, "Pirata One": 0.08, Unbounded: 0.06, "Bricolage Grotesque": 0.06, "Sedgwick Ave Display": 0.06, Syne: 0.04, "Playfair Display": 0.04, "Abril Fatface": 0.04 },
  lens: {
    Syne: 0.08,
    Unbounded: 0.08,
    "Bricolage Grotesque": 0.06,
    "Space Grotesk": 0.06,
    Rubik: 0.06,
    "JetBrains Mono": 0.04,
    Righteous: 0.04,
    "Chakra Petch": 0.04,
    Bungee: 0.04,
  },
  stack: { "Bricolage Grotesque": 0.08, System: 0.06, "JetBrains Mono": 0.06, "Space Grotesk": 0.06, Oswald: 0.06, Anton: 0.04, Rubik: 0.04, Fraunces: 0.03, "Archivo Black": 0.03 },
  slant: { "Archivo Black": 0.12, Anton: 0.08, "Bebas Neue": 0.08, "Sedgwick Ave Display": 0.08, Oswald: 0.06, "Bricolage Grotesque": 0.06, Unbounded: 0.04 },
  pop: { Bungee: 0.1, "Archivo Black": 0.1, "Lilita One": 0.08, Unbounded: 0.08, "Bebas Neue": 0.06, Shrikhand: 0.06, Anton: 0.06 },
  cascade: { "DM Serif Display": 0.08, "Bodoni Moda": 0.08, "Playfair Display": 0.06, "Instrument Serif": 0.06, Fraunces: 0.06, Syne: 0.04, "Chakra Petch": 0.04 },
  tape: { "Archivo Black": 0.08, Oswald: 0.06, "Bebas Neue": 0.06, "Sedgwick Ave Display": 0.06, Silkscreen: 0.06, "Bricolage Grotesque": 0.06, "Abril Fatface": 0.04 },
};

/** Each face's character, as taste written down. */
function fontScore(family: string, f: SongFeatures, a: Axes): number {
  const warm = Math.max(0, a.warm);
  const cool = Math.max(0, -a.warm);
  const playful = 0.5 * a.vivid + 0.3 * a.light + 0.2 * warm;
  const elegant = (1 - a.vivid) * (0.5 + 0.5 * Math.max(a.gray, 1 - a.light));
  switch (family) {
    case "Fraunces": // warm, lyrical, the house face: the safe middle, unhurried songs about people
      return 0.22 + 0.14 * bell(a.pace, 0.3, 0.35) + 0.12 * a.sustain + 0.12 * warm + 0.06 * a.intimacy + 0.06 * (1 - a.punch);
    case "Instrument Serif": // elegant hairline serif: intimate, sparse, held notes
      return 0.3 * a.intimacy + 0.26 * a.sustain + 0.16 * (1 - a.density) + 0.14 * elegant + 0.14 * has(f, "slow") - 0.25 * smooth(a.pace, 0.45, 0.7);
    case "Syne": // quirky wide display: bright covers, hooks, dancing mid-tempo
      return 0.3 * playful + 0.26 * a.punch + 0.24 * bell(a.pace, 0.55, 0.25) + 0.1 * (1 - a.sustain) + 0.1 * a.vivid - 0.1;
    case "Unbounded": // loud and round: chants, shouted short lines, club edits
      return 0.3 * a.punch + 0.24 * smooth(f.shout, 0.05, 0.4) + 0.2 * a.vivid + 0.16 * a.pace + 0.1 * has(f, "dance") - 0.08;
    case "Bricolage Grotesque": // sturdy grotesque: dense, fast verses read at a glance
      return 0.08 + 0.36 * a.density + 0.34 * a.pace + 0.08 * (1 - a.sustain) + 0.06 * (1 - a.vivid);
    case "Caveat": // handwriting: diary songs, acoustic takes
      return 0.36 * a.intimacy + 0.2 * has(f, "intimate") + 0.16 * warm * a.light + 0.14 * f.shortLines + 0.14 * (1 - a.punch) - 0.12;
    case "JetBrains Mono": // machine type: cold neon covers, steady electronic pulse
      return 0.3 * cool + 0.26 * a.vivid * smooth(f.cover?.contrast ?? 0, 0.1, 0.3) + 0.2 * bell(a.pace, 0.5, 0.3) + 0.12 * has(f, "dance") + 0.12 * a.punch - 0.1;
    case "Anton": // tall condensed shout: rap, rock anthems, chants, dark heavy covers; narrow enough for long bars
      return 0.28 * a.punch + 0.24 * smooth(f.shout, 0.05, 0.4) + 0.24 * a.pace + 0.12 * a.density + 0.08 * has(f, "live") + 0.12 * (1 - a.light) - 0.14 * a.intimacy - 0.08;
    case "Playfair Display": // high-contrast display serif: soul, R&B, torch songs, held notes under rich, dark covers
      return 0.24 * a.sustain + 0.18 * elegant + 0.2 * bell(a.pace, 0.3, 0.3) + 0.32 * (1 - a.light) * (0.3 + 0.7 * a.vivid) + 0.12 * warm - 0.02;
    case "Space Grotesk": // clean techy grotesque: synth-pop, house, electronic, cool covers
      return 0.26 * cool + 0.2 * has(f, "dance") + 0.2 * bell(a.pace, 0.55, 0.3) + 0.14 * a.vivid + 0.12 * a.density + 0.08 * (1 - a.sustain) - 0.06;
    case "Righteous": // retro rounded display: disco, funk, grooves, warm saturated covers
      return 0.5 * warm * a.vivid + 0.1 * warm + 0.2 * has(f, "dance") + 0.2 * bell(a.pace, 0.5, 0.25) + 0.14 * a.punch + 0.2 * smooth(f.vocables, 0.02, 0.2) + 0.06 * a.light - 0.12;
    case "Pacifico": // brush script: summer, beach, reggae, feel-good songs, bright warm covers, an easy pace
      return 0.7 * warm * a.light + 0.22 * bell(a.pace, 0.25, 0.3) + 0.12 * (1 - a.density) + 0.12 * a.vivid * a.light - 0.16 * smooth(f.shout, 0.05, 0.4) - 0.12 * a.sustain - 0.06;
    case "Rubik": // friendly rounded sans: bubbly pop, bright light covers, upbeat hooks
      return 0.6 * a.light * (0.5 + 0.5 * a.vivid) + 0.22 * bell(a.pace, 0.62, 0.25) + 0.16 * a.punch + 0.14 * smooth(f.repetition, 0.3, 0.7) + 0.08 * (1 - a.intimacy) - 0.2 * (1 - a.light) - 0.12;
    case "Pirata One": { // blackletter: metal, gothic, heavy and dark, shouted short lines
      const dark = smooth(0.42 - a.light, 0, 0.3);
      return 0.45 * dark * (0.4 + 0.6 * a.punch) + 0.26 * smooth(f.shout, 0.05, 0.4) + 0.12 * (1 - a.vivid) + 0.08 * (1 - a.intimacy) - 0.16;
    }
    case "Archivo Black": // heavy grotesque: rap and drill, punchy hooks, dark covers; the kinetic-type face
      return 0.26 * a.punch + 0.22 * a.pace + 0.16 * (1 - a.light) + 0.14 * a.density + 0.1 * smooth(f.shout, 0.05, 0.4) - 0.12 * a.intimacy - 0.06;
    case "Bebas Neue": // tall condensed capitals: anthems, festival EDM, trailer drama, cool covers
      return 0.24 * a.punch + 0.2 * bell(a.pace, 0.6, 0.3) + 0.16 * cool + 0.14 * has(f, "dance") + 0.1 * a.vivid + 0.1 * smooth(f.shout, 0.05, 0.4) - 0.1 * a.intimacy - 0.08;
    case "Oswald": // condensed workhorse: rock and dense fast verses, long lines read at a glance
      return 0.06 + 0.28 * a.density + 0.24 * a.pace + 0.1 * a.punch + 0.08 * has(f, "live") + 0.06 * (1 - a.vivid) - 0.04;
    case "DM Serif Display": // soft display serif: R&B, soul, indie folk, warm and unhurried
      return 0.22 * a.sustain + 0.2 * warm + 0.18 * bell(a.pace, 0.35, 0.3) + 0.16 * a.intimacy + 0.1 * elegant - 0.08;
    case "Abril Fatface": // fat didone: glam, diva pop, big held notes under rich covers
      return 0.24 * a.punch * (1 - 0.5 * a.pace) + 0.22 * a.vivid + 0.18 * a.sustain + 0.12 * warm + 0.1 * (1 - a.light) - 0.12;
    case "Sedgwick Ave Display": // graffiti hand: hip-hop, street and gritty songs, fast and loud
      return 0.3 * a.pace * a.punch + 0.2 * smooth(f.shout, 0.05, 0.4) + 0.16 * (1 - a.light) + 0.08 * a.density + 0.12 * has(f, "live") - 0.14 * a.sustain - 0.1;
    case "Bungee": // block signage capitals: chants, shouted short lines, bright loud covers
      return 0.26 * a.punch + 0.22 * smooth(f.shout, 0.05, 0.4) + 0.2 * a.vivid + 0.14 * f.shortLines + 0.1 * has(f, "dance") - 0.12;
    case "Silkscreen": // pixel type: chiptune, game and glitchy electronic songs, cold neon covers
      return 0.3 * cool * a.vivid + 0.2 * has(f, "dance") + 0.16 * bell(a.pace, 0.6, 0.25) + 0.14 * smooth(f.vocables, 0.02, 0.2) + 0.1 * f.shortLines - 0.16;
    case "Bodoni Moda": // fashion serif: elegant, slow songs, grey and muted covers
      return 0.26 * elegant + 0.2 * a.sustain + 0.18 * bell(a.pace, 0.3, 0.3) + 0.14 * a.gray + 0.08 * a.intimacy - 0.08;
    case "Shrikhand": // retro bold italic: seventies funk, summer grooves, warm saturated covers
      return 0.4 * warm * a.vivid + 0.2 * bell(a.pace, 0.55, 0.25) + 0.16 * has(f, "dance") + 0.12 * a.punch + 0.1 * a.light - 0.14;
    case "Chakra Petch": // squared techno: synthwave, cyberpunk, cool neon on dark covers
      return 0.3 * cool + 0.22 * a.vivid * (1 - a.light) + 0.18 * bell(a.pace, 0.6, 0.3) + 0.12 * has(f, "dance") + 0.08 * a.punch - 0.1;
    case "Lilita One": // chunky and friendly: bubblegum pop, bright light covers, sing-along hooks
      return 0.5 * a.light * a.vivid + 0.2 * bell(a.pace, 0.6, 0.25) + 0.14 * a.punch + 0.1 * smooth(f.repetition, 0.3, 0.7) - 0.2 * (1 - a.light) - 0.1;
    case "System": // neutral, covers every script
      return 0.18 + 0.08 * a.density;
    default:
      return 0;
  }
}

function pickFont(f: SongFeatures, a: Axes, style: Style): { face: FontChoice; scores: Record<string, number>; tie: boolean } {
  const scores: Record<string, number> = {};
  const eligible: [FontChoice, number][] = [];
  for (const face of FONTS) {
    if (fontVeto(face, f, a)) continue;
    let s = fontScore(face.family, f, a) + (HARMONY[style]?.[face.family] ?? 0);
    if (face.family === "Fraunces") s += 0.5 * HOUSE_PRIOR * (1 - a.confidence);
    // CJK lines take the face's serif or sans system stack: serif (Mincho, Song) for slow songs, sans (Gothic) for pop
    if (f.script === "cjk") s += face.serif ? 0.15 * (1 - a.pace) : 0.15 * a.pace;
    scores[face.family] = round(s, 3);
    eligible.push([face, s]);
  }
  eligible.sort((x, y) => y[1] - x[1]);
  const [first, second] = eligible;
  // System is never vetoed; the fallback only guards a catalog without it
  if (!first) return { face: fontFor("System"), scores, tie: false };
  const tie = !!second && first[1] - second[1] < FONT_TIE;
  if (second && tie && stableHash(`${f.trackKey}#font`) >= 0.5) return { face: second[0], scores, tie };
  return { face: first[0], scores, tie };
}

// ─────────────────────────────────────────── look ───────────────────────────────────────────

/** How far Arc bends a song's line, in Settings.curve units (before the trackKey's ±2 wobble). */
export const CURVE_MIN = 8;
export const CURVE_MAX = 32;

function curveOf(f: SongFeatures, a: Axes): number {
  // A gentle bend: a little deeper for held notes and slow songs, flatter for long lines, and never
  // past CURVE_MAX, so a line reads as a line that bends, not as a bow.
  const magnitude = clamp(10 + 18 * a.sustain + 8 * (1 - a.pace) - 18 * smooth(f.widthMedian, 24, 52), CURVE_MIN, CURVE_MAX);
  // Anthems and bright songs arch upward; intimate, dark ones cradle in a gentle valley.
  const sign = a.punch > 0.55 || a.light > 0.55 ? 1 : a.intimacy > 0.55 ? -1 : 1;
  const wobble = Math.round((stableHash(`${f.trackKey}#curve`) - 0.5) * 4);
  return Math.round(sign * magnitude) + wobble;
}

function energyOf(f: SongFeatures, a: Axes): number {
  if (f.timing === "unsynced" || f.timing === "none") return 0.2; // only line-to-line motion
  // Synced songs always move hard: twice BL's amplitude at least (0.3 is BL's own), so even a ballad
  // reacts to every word; pace and hooks push it to the cap.
  const dynamic = smooth(f.rateSpread, 0.2, 0.8);
  let e = 0.62 + 0.38 * (0.5 * a.pace + 0.25 * a.punch + 0.15 * a.vivid + 0.1 * dynamic);
  e += 0.08 * has(f, "dance") + 0.08 * has(f, "fast");
  if (f.timing === "line") e *= 0.92; // word times are estimates: big per-word pops would land on the wrong words
  return round(clamp(e, 0.55, 1));
}

function emphasisOf(f: SongFeatures, a: Axes): EmphasisRule | null {
  if (f.timing === "line") return { minMs: 1300, maxChars: 12, lastWordOnly: true };
  if (f.timing !== "word") return null;
  // About 1 s held, as BL does, but adapted per song: fast songs let their rare long notes pop a little
  // sooner; in a ballad full of long notes, about one word per line gets the treatment, or it's noise.
  // Anything held 2 s or more always does.
  const base = 1000 - 150 * smooth(a.pace, 0.5, 0.9);
  const words = f.wordMs.length;
  const allowed = words > 0 ? clamp(f.lines / words, 0.06, 0.2) : 0.12;
  const top = quantile(f.wordMs, 1 - allowed);
  return { minMs: Math.round(clamp(Math.max(base, top), 750, 2000)), maxChars: 12, lastWordOnly: false };
}

/** How far the trackKey hash moves each move's and splash's score: similar songs don't all get the same flair. */
const FLAIR_JITTER = 0.3;
/** Every song leans toward the moves that hit on the word (bounce, pulse, drop) over the floaty ones. */
const MOVE_PUNCH: Record<Move, number> = { rise: -0.15, bounce: 0.15, sway: -0.3, wave: 0.05, pulse: 0.15, drop: 0.1 };

/** The best of `scores`, then the runner-up; equal scores rank in `order`. */
function ranked<K extends string>(scores: Record<K, number>, order: readonly K[]): K[] {
  return [...order].sort((x, y) => scores[y] - scores[x] || order.indexOf(x) - order.indexOf(y));
}

/**
 * Effects mode's flair. Fast, punchy songs bounce and pulse; slow and intimate ones sway; long held
 * notes wave through their letters; dark, heavy ones drop. The hooks move with the runner-up, so a
 * chorus stands apart from the verses. The splash follows what the words are about (water, fire, a
 * party, the night sky), else the pace. The trackKey hash stirs every score a little, so two similar
 * songs needn't look alike. Lyrics without timing don't move (only their lines do).
 */
function flairOf(f: SongFeatures, a: Axes): Flair {
  if (f.timing !== "word" && f.timing !== "line") return { ...PLAIN_FLAIR };
  const jitter = (name: string): number => (stableHash(`${f.trackKey}#flair-${name}`) - 0.5) * FLAIR_JITTER;
  const dance = has(f, "dance");
  const dreamy = has(f, "dreamy");
  const shout = smooth(f.shout, 0.05, 0.4);
  const vocables = smooth(f.vocables, 0.05, 0.3);
  const moves: Record<Move, number> = {
    rise: 0.45,
    bounce: 0.2 + 0.45 * a.pace + 0.25 * a.punch + 0.15 * dance - 0.25 * a.sustain,
    sway: 0.15 + 0.45 * (1 - a.pace) + 0.25 * a.intimacy + 0.15 * dreamy - 0.2 * a.punch,
    wave: 0.15 + 0.4 * a.sustain + 0.25 * vocables + 0.1 * (1 - a.density),
    pulse: 0.1 + 0.4 * a.punch + 0.3 * shout + 0.15 * dance + 0.1 * a.pace,
    drop: 0.15 + 0.3 * a.punch * (1 - a.light) + 0.2 * (1 - a.light) - 0.1 * a.intimacy,
  };
  for (const m of MOVES) moves[m] += MOVE_PUNCH[m] + jitter(m);
  const [move = "rise", accent = "rise"] = ranked(moves, MOVES);
  const t = f.themes;
  const splashes: Record<SplashKind, number> = {
    drops: 0.25 + 1.6 * t.water,
    sparks: 0.2 + 1.6 * t.fire + 0.25 * a.punch * (1 - a.light) + 0.1 * dance,
    confetti: 0.15 + 1.6 * t.party + 0.25 * a.pace * a.vivid + 0.15 * dance,
    ripple: 0.2 + 0.3 * (1 - a.pace) * (0.5 + 0.5 * a.intimacy),
    glints: 0.2 + 1.6 * t.night + 0.1 * (1 - a.pace),
  };
  for (const k of SPLASHES) splashes[k] += 0.5 * jitter(k);
  const [splash = "ripple"] = ranked(splashes, SPLASHES);
  return { move, accent, splash };
}

function traitsOf(f: SongFeatures, a: Axes): string[] {
  // the decisive ones first: what there is to read, and the script, which rules out faces
  const lead: string[] = [];
  if (f.timing === "unsynced") lead.push("plain lyrics without timing");
  if (f.timing === "none") lead.push("no lyrics");
  if (f.cjk === "ja") lead.push("Japanese lyrics");
  else if (f.cjk === "ko") lead.push("Korean lyrics");
  else if (f.cjk === "zh-Hans" || f.cjk === "zh-Hant") lead.push("Chinese lyrics");
  if (f.vietnamese) lead.push("Vietnamese diacritics");
  if (f.cyrillic) lead.push("Cyrillic lyrics");
  if (f.greek) lead.push("Greek lyrics");
  if (f.script === "rtl") lead.push("right-to-left lyrics");
  const synced = f.timing === "word" || f.timing === "line";
  const c = f.cover;
  // One cover trait at most: the strongest.
  const coverTraits: [string, number][] = c
    ? [
        [a.warm >= 0.45 ? "bright, warm cover" : "bright, colorful cover", Math.min(a.vivid - 0.55, a.light - 0.45) * 3],
        ["neon on dark cover", Math.min(a.vivid - 0.5, 0.4 - a.light) * 3],
        ["black-and-white cover", (a.gray - 0.85) * 4],
        ["dark, muted cover", Math.min(0.3 - a.vivid, 0.35 - a.light) * 3],
        ["warm cover", (a.warm - 0.45) * 2],
        ["cold cover", (-a.warm - 0.6) * 2],
      ]
    : [];
  const coverTrait = coverTraits.filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1])[0];
  const scored: [string, number][] = [
    ...(coverTrait ? [coverTrait] : []),
    ["fast", synced ? (a.pace - 0.7) * 3 : 0],
    ["slow", synced ? (0.2 - a.pace) * 3 : 0],
    ["long held notes", (a.sustain - 0.5) * 2],
    ["very long lines", (a.longLines - 0.5) * 2],
    ["dense lines", (a.density - 0.6) * 2.5],
    ["long instrumental gaps", synced ? (a.space - 0.5) * 2 : 0],
    ["big repeating hooks", (smooth(f.repetition, 0.15, 0.6) - 0.5) * 1.6 * a.confidence],
    ["shouted lines", (smooth(f.shout, 0.05, 0.4) - 0.5) * 1.6],
    ["stripped-back version", has(f, "intimate") * 0.6],
    ["remix", has(f, "dance") * 0.6],
    ["live recording", has(f, "live") * 0.5],
    ["sped up", has(f, "fast") * 0.6],
    ["slowed down", has(f, "dreamy") * 0.6],
    ["interlude", has(f, "sparse") * 0.6],
    ["few lines to go on", synced && a.confidence < 0.35 ? 0.3 : 0],
  ];
  const rest = scored.filter(([, s]) => s > 0).sort((x, y) => y[1] - x[1]).map(([t]) => t);
  const traits = [...lead, ...rest].slice(0, 3);
  return traits.length > 0 ? traits : ["a bit of everything"];
}

/** The look for a song. Pure: the same features always give the same look. */
export function pickLook(f: SongFeatures): SongLook {
  const a = axesOf(f);
  const { style, scores: styleScoresOut, tie: styleTie } = pickStyle(f, a);
  const { face, scores: fontScoresOut, tie: fontTie } = pickFont(f, a, style);
  const m = METRICS[face.family] ?? { scale: 1, spacing: 0 };
  const upper =
    (face.family === "Unbounded" || face.family === "Syne" || face.family === "Anton") &&
    f.script === "latin" &&
    !f.vietnamese &&
    (f.shout >= 0.35 || (a.punch >= 0.6 && f.widthMedian <= 22));
  const traits = traitsOf(f, a);
  return {
    style,
    font: { family: face.family, weight: face.weight },
    curve: curveOf(f, a),
    energy: energyOf(f, a),
    // springs settle fast even in slow songs, so a word lands on the voice instead of floating in after it
    snap: round(clamp(0.55 + 0.4 * a.pace + 0.1 * a.punch - 0.1 * a.sustain, 0.5, 1)),
    glow: round(clamp(0.45 + 0.3 * a.vivid * (1 - 0.6 * a.light) + 0.2 * a.sustain + 0.1 * a.punch - 0.2 * a.gray * (1 - a.vivid), 0.3, 1)),
    emphasis: emphasisOf(f, a),
    scale: round(clamp((1 + 0.06 * (1 - a.density) - 0.06 * a.density) * m.scale, 0.82, 1.2)),
    letterSpacing: round(m.spacing + (upper ? 0.04 : 0), 3),
    textCase: upper ? "upper" : "as-is",
    flair: flairOf(f, a),
    traits,
    // With no lyrics the style is moot (the stage shows a state); only the face shows, in the ♪.
    reason: f.timing === "none" ? `${traits.join(", ")} → ${face.label}` : `${traits.join(", ")} → ${STYLE_LABEL[style]} with ${face.label}`,
    scores: { style: styleScoresOut, font: fontScoresOut },
    ties: { style: styleTie, font: fontTie },
  };
}

/** "Lens · Syne", for the settings panel. */
/** A style's name as Settings shows it ("Slant"). */
export function styleLabel(style: Style): string {
  return STYLE_LABEL[style];
}

export function lookLabel(look: Pick<SongLook, "style" | "font">): string {
  const face = FONTS.find((x) => x.family === look.font.family);
  return `${STYLE_LABEL[look.style]} · ${face?.label ?? look.font.family}`;
}

// ───────────────────────────────────────── stability ─────────────────────────────────────────

/** How much an input tells: timing first, then the cover. A refinement needs strictly more. */
export function qualityOf(input: Pick<SongInput, "timing" | "cover">): number {
  const rank: Record<Timing, number> = { none: 0, unsynced: 1, line: 2, word: 3 };
  return rank[input.timing] * 2 + (input.cover ? 1 : 0);
}

/** Same on screen: everything but the explanation and the QA fields. */
const sameLook = (a: SongLook, b: SongLook): boolean => {
  const shown = ({ traits: _t, reason: _r, scores: _s, ties: _x, ...rest }: SongLook): string => JSON.stringify(rest);
  return shown(a) === shown(b);
};

/**
 * Keeps one look per song while it plays. The first look with lyrics is committed. Later, better
 * information (artwork arriving after the lyrics, plain lyrics upgraded to synced ones) may change it
 * once, and only at a safe point the stage reports with `settle()` (a line boundary, an instrumental
 * gap, before the first line). A look picked before any lyrics (for the loading, not-found and
 * instrumental states) is provisional: lyrics replace it freely, since the scene fades over anyway.
 */
export class LookKeeper {
  private key: string | null = null;
  private look: SongLook | null = null;
  private quality = -1;
  private provisional = true;
  private refined = false;
  private pending: { look: SongLook; quality: number } | null = null;

  /** The look to draw with now. */
  get current(): SongLook | null {
    return this.look;
  }

  /** True while a refinement waits for the next safe point. */
  get waiting(): boolean {
    return this.pending !== null;
  }

  /** New information about the playing song. Returns the look to draw with right now. */
  offer(input: SongInput): SongLook {
    const quality = qualityOf(input);
    if (input.track.trackKey !== this.key || !this.look) {
      this.key = input.track.trackKey;
      this.refined = false;
      this.pending = null;
      return this.commit(input, quality);
    }
    if (this.provisional) return quality >= this.quality ? this.commit(input, quality) : this.look;
    if (this.refined || quality <= Math.max(this.quality, this.pending?.quality ?? -1)) return this.look;
    const next = pickLook(songFeatures(input));
    if (sameLook(next, this.look)) {
      this.quality = quality;
      this.pending = null;
    } else {
      this.pending = { look: next, quality };
    }
    return this.look;
  }

  /** The stage is at a safe point: applies a waiting refinement (once per song). Returns the new look, or null. */
  settle(): SongLook | null {
    if (!this.pending) return null;
    this.look = this.pending.look;
    this.quality = this.pending.quality;
    this.pending = null;
    this.refined = true;
    return this.look;
  }

  private commit(input: SongInput, quality: number): SongLook {
    this.look = pickLook(songFeatures(input));
    this.quality = quality;
    this.provisional = input.timing === "none";
    return this.look;
  }
}
