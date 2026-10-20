/**
 * Effects mode (Settings.effectsMode): each song's own flair on top of its look. How its words move as
 * they're sung (they don't all float up), the splash that bursts from its big moments, and the tiny
 * pictures beside the words that name something (wordpics.ts). The picker (songlook.ts) chooses a
 * song's flair from how it is sung, what its words are about and its cover; this module holds the
 * vocabulary and plans, line by line, which words get what. Everything is pure and deterministic: a
 * song gets the same flair, splashes and pictures every time it plays, in every window.
 */
import type { Line } from "./lrc";
import type { EmphasisRule } from "./songlook";
import { normalizeToken, planPictures, tokensOf, type PictureId } from "./wordpics";

/**
 * How a word moves as it's sung. rise: swells and floats up, then settles (the house motion). bounce:
 * hops and lands with a little bounce. sway: tilts and swings back like a pendulum. wave: a wave runs
 * through its letters as they light. pulse: a quick swell on the beat, no lift. drop: waits a little
 * high and drops into place.
 */
export const MOVES = ["rise", "bounce", "sway", "wave", "pulse", "drop"] as const;
export type Move = (typeof MOVES)[number];

/**
 * What bursts from a word at a big moment. drops: a splash of droplets that arc and fall. sparks: a
 * quick burst of streaks. confetti: tumbling flakes in the song's colors. ripple: rings spreading
 * out. glints: a few twinkling stars.
 */
export const SPLASHES = ["drops", "sparks", "confetti", "ripple", "glints"] as const;
export type SplashKind = (typeof SPLASHES)[number];

/** A song's flair: how most lines move, how its hooks (the lines it repeats) move, and its splash. */
export interface Flair {
  move: Move;
  accent: Move;
  splash: SplashKind;
}

/** No flair: every word rises, as with Effects mode off. */
export const PLAIN_FLAIR: Flair = Object.freeze({ move: "rise", accent: "rise", splash: "ripple" });

export const isMove = (value: unknown): value is Move => typeof value === "string" && (MOVES as readonly string[]).includes(value);
export const isSplash = (value: unknown): value is SplashKind => typeof value === "string" && (SPLASHES as readonly string[]).includes(value);

/** A flair made safe to draw: anything unknown falls back to PLAIN_FLAIR's. */
export function saneFlair(value: Partial<Flair> | null | undefined): Flair {
  return {
    move: isMove(value?.move) ? value.move : PLAIN_FLAIR.move,
    accent: isMove(value?.accent) ? value.accent : PLAIN_FLAIR.accent,
    splash: isSplash(value?.splash) ? value.splash : PLAIN_FLAIR.splash,
  };
}

// ─────────────────────────────────────────── themes ───────────────────────────────────────────

/** What a song's words are about, as far as its splash goes. */
export const THEMES = ["water", "fire", "party", "night"] as const;
export type Theme = (typeof THEMES)[number];
/** The share of a song's lyric lines that mention each theme, 0..1. */
export type Themes = Readonly<Record<Theme, number>>;

const THEME_WORDS: Readonly<Record<Theme, readonly string[]>> = {
  water: ["rain", "raining", "rainy", "ocean", "sea", "waves", "tide", "river", "tears", "cry", "crying", "cried", "swim", "swimming", "pool", "drown", "drowning", "wet", "splash", "water", "waterfall", "flood", "lake", "shore", "storm", "thunder", "monsoon"],
  fire: ["fire", "flame", "burn", "burning", "spark", "electric", "lightning", "firework", "heat", "blaze", "ignite", "explode", "boom", "lit"],
  party: ["party", "dance", "dancing", "celebrate", "celebration", "birthday", "champagne", "confetti", "club", "weekend", "drinks", "cheers", "disco", "bass", "bassline", "strobe", "dj", "rave", "dancefloor"],
  night: ["star", "moon", "moonlight", "dream", "dreaming", "night", "sky", "heaven", "angel", "magic", "wish", "glitter", "sparkle", "shine", "galaxy", "midnight"],
};

let themeOf: Map<string, Theme> | null = null;

function themeWords(): Map<string, Theme> {
  if (themeOf) return themeOf;
  const map = new Map<string, Theme>();
  for (const theme of THEMES) for (const word of THEME_WORDS[theme]) map.set(normalizeToken(word), theme);
  themeOf = map;
  return map;
}

/** The theme a sung token belongs to, if any (a plural counts as its singular). */
function themeOfToken(token: string): Theme | undefined {
  const map = themeWords();
  return map.get(token) ?? (token.length > 3 && token.endsWith("s") ? map.get(token.slice(0, -1)) : undefined);
}

/** How much of a song's lyrics mention water, fire, a party or the night sky. */
export function themesOf(lines: readonly Line[]): Themes {
  const counts: Record<Theme, number> = { water: 0, fire: 0, party: 0, night: 0 };
  let total = 0;
  for (const line of lines) {
    if (line.words.length === 0) continue;
    total++;
    const seen = new Set<Theme>();
    for (const token of tokensOf(line)) {
      const theme = themeOfToken(token.text);
      if (theme) seen.add(theme);
    }
    for (const theme of seen) counts[theme]++;
  }
  const share = (n: number): number => (total > 0 ? Math.round((n / total) * 1000) / 1000 : 0);
  return { water: share(counts.water), fire: share(counts.fire), party: share(counts.party), night: share(counts.night) };
}

// ─────────────────────────────────────────── hooks ───────────────────────────────────────────

/** Lines this alike (shared words over all words) count as the same line sung again. */
const HOOK_LIKENESS = 0.8;

/**
 * The song's hooks: indices of lyric lines it sings more than once, word for word or nearly (the
 * chorus, a refrain). They move with the flair's accent.
 */
export function hookLines(lines: readonly Line[]): Set<number> {
  const sets = lines.map((line) => (line.words.length === 0 ? null : tokensOf(line).map((t) => t.text)));
  const hooks = new Set<number>();
  sets.forEach((a, i) => {
    if (!a || a.length === 0 || hooks.has(i)) return;
    const setA = new Set(a);
    const key = a.join(" ");
    sets.forEach((b, j) => {
      if (j <= i || !b || b.length === 0) return;
      let same = b.join(" ") === key;
      if (!same && a.length >= 3 && b.length >= 3) {
        const setB = new Set(b);
        let shared = 0;
        for (const t of setA) if (setB.has(t)) shared++;
        same = shared / (setA.size + setB.size - shared) >= HOOK_LIKENESS;
      }
      if (same) {
        hooks.add(i);
        hooks.add(j);
      }
    });
  });
  return hooks;
}

// ─────────────────────────────────────────── decor ───────────────────────────────────────────

/** What one word gets on top of its line's move. */
export interface WordDecor {
  picture?: PictureId;
  splash?: SplashKind;
}

/** One line's flair: how its words move, and the words with a picture or a splash. */
export interface LineDecor {
  move: Move;
  /** sung more than once (hookLines) */
  hook: boolean;
  /** by word index */
  words: ReadonlyMap<number, WordDecor>;
}

/** Splashes are at least this far apart (ms), at most one a line. */
export const SPLASH_GAP_MS = 5000;
/** Held this long, a word splashes (when the song's look has no held-note rule of its own), ms. */
export const HELD_SPLASH_MS = 1000;

/** A shouted line: ends in "!", or its letters are mostly capitals. */
function shouted(line: Line): boolean {
  const text = line.text.trim();
  if (text.endsWith("!")) return true;
  const letters = text.replace(/[^\p{L}]/gu, "");
  const upper = text.replace(/[^\p{Lu}]/gu, "").length;
  return letters.length >= 4 && upper / letters.length >= 0.6;
}

/**
 * The words in a line that would splash, earliest first: a held note (as long as the look's held-note
 * rule asks, on word-timed lines), and the last word of a hook or a shouted line.
 */
function splashCandidates(line: Line, hook: boolean, emphasis: EmphasisRule | null): number[] {
  const out = new Set<number>();
  const last = line.words.length - 1;
  if (line.estimated !== true) {
    const held = emphasis?.minMs ?? HELD_SPLASH_MS;
    line.words.forEach((w, i) => {
      if (w.end - w.start >= held && (!emphasis?.lastWordOnly || i === last)) out.add(i);
    });
  }
  if (last >= 0 && (hook || shouted(line))) out.add(last);
  return [...out].sort((a, b) => (line.words[a]?.start ?? 0) - (line.words[b]?.start ?? 0));
}

/**
 * Each line's flair, by line index (gaps included, with nothing on them). With `flair` null (Effects
 * mode off) every line rises and nothing splashes or shows a picture.
 */
export function planDecor(lines: readonly Line[], flair: Flair | null, emphasis: EmphasisRule | null): LineDecor[] {
  if (!flair) return lines.map(() => ({ move: "rise", hook: false, words: new Map() }));
  const hooks = hookLines(lines);
  const pictures = planPictures(lines);
  let lastSplash = Number.NEGATIVE_INFINITY;
  return lines.map((line, index) => {
    const hook = hooks.has(index);
    const words = new Map<number, WordDecor>();
    if (line.words.length === 0) return { move: flair.move, hook, words };
    const picture = pictures.get(index);
    if (picture) words.set(picture.word, { picture: picture.id });
    for (const i of splashCandidates(line, hook, emphasis)) {
      const at = line.words[i]?.start ?? line.start;
      if (at - lastSplash < SPLASH_GAP_MS) continue;
      words.set(i, { ...words.get(i), splash: flair.splash });
      lastSplash = at;
      break;
    }
    return { move: hook ? flair.accent : flair.move, hook, words };
  });
}
