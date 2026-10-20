/**
 * Word scenes (Graphics): a word that names something you can see in light, weather or color doesn't
 * call a picture, it becomes it. "Fire" catches fire, "sunrise" has a half sun rising behind it on a
 * horizon, "moonlight" a pale moon, "snow" gathers a drift at its feet while flakes fall around it,
 * "rain" drips, "lightning" crackles, "heart" beats out little hearts, "gold" glitters, "ocean" stands
 * in rising water, "stars" twinkle around it. The scene is drawn in and around the word itself, and
 * its letters take the scene's colors as they're sung (overlay/motion/scenes.ts).
 *
 * This module is the vocabulary and the plan: which words call which scene, and which sung word of
 * which line gets one. Pure and deterministic, like the pictures' (wordpics.ts), whose word forms it
 * shares. A line with a scene shows no picture.
 */
import type { Line } from "./lrc";
import { normalizeToken, tokensOf, type Token } from "./wordpics";

export const SCENE_IDS = ["fire", "sun", "moon", "snow", "rain", "electric", "love", "gold", "water", "stars"] as const;
export type SceneId = (typeof SCENE_IDS)[number];

/** The words (and two-word phrases) that call each scene, lowercase, as sung. */
const SCENE_WORDS: Readonly<Record<SceneId, readonly string[]>> = {
  fire: ["fire", "fires", "flame", "flames", "flaming", "burn", "burns", "burning", "burned", "burnt", "blaze", "blazing", "ablaze", "inferno", "ignite", "ignited", "wildfire", "firestorm", "heat", "on fire"],
  sun: ["sun", "suns", "sunshine", "sunlight", "sunrise", "sunset", "sundown", "sunny", "dawn", "daybreak", "daylight", "horizon", "golden hour"],
  moon: ["moon", "moons", "moonlight", "moonlit", "moonbeam", "moonrise", "moonshine", "lunar", "crescent"],
  snow: ["snow", "snowing", "snowy", "snowflake", "snowflakes", "snowfall", "frost", "frosty", "frozen", "freeze", "freezing", "ice", "icy", "winter", "blizzard", "cold"],
  rain: ["rain", "rains", "raining", "rainy", "raindrop", "raindrops", "drizzle", "downpour", "tears", "teardrop", "teardrops", "crying", "cried", "wet"],
  electric: ["electric", "electricity", "lightning", "thunder", "thunderstorm", "shock", "shocked", "voltage", "spark", "sparks", "static", "charged", "supercharged"],
  love: ["heart", "hearts", "heartbeat", "heartbeats", "valentine", "romance", "lovesick", "sweetheart"],
  gold: ["gold", "golden", "diamond", "diamonds", "glitter", "glittering", "sparkle", "sparkles", "sparkling", "shine", "shining", "shiny", "jewel", "jewels", "treasure", "platinum", "silver", "gleam", "gleaming"],
  water: ["ocean", "oceans", "sea", "seas", "wave", "waves", "tide", "tides", "river", "rivers", "water", "waters", "underwater", "drown", "drowning", "drowned", "flood", "lake", "swim", "swimming", "sinking"],
  stars: ["star", "stars", "starlight", "starry", "stardust", "galaxy", "galaxies", "cosmos", "cosmic", "constellation", "constellations", "comet", "supernova", "universe", "shooting star"],
};

/** Scenes are at least this far apart, ms... */
export const SCENE_GAP_MS = 2500;
/** ...and the same scene at least this far apart, so a repeated chorus line isn't on fire every time. */
export const SAME_SCENE_GAP_MS = 9000;

/** The words that call scene `id`. */
export function sceneWords(id: SceneId): readonly string[] {
  return SCENE_WORDS[id];
}

let lexicon: Map<string, SceneId> | null = null;

function lexiconOf(): Map<string, SceneId> {
  if (lexicon) return lexicon;
  const map = new Map<string, SceneId>();
  for (const id of SCENE_IDS) {
    for (const entry of SCENE_WORDS[id]) {
      const key = entry.split(/\s+/u).map(normalizeToken).filter(Boolean).join(" ");
      if (key && !map.has(key)) map.set(key, id);
    }
  }
  lexicon = map;
  return map;
}

/** A scene a line calls: on which word (the phrase's last), and which. */
export interface SceneMatch {
  word: number;
  id: SceneId;
}

/** Every scene line `line` calls, in the order they're sung; a two-word phrase ("on fire") before its words alone. */
export function scenesIn(line: Pick<Line, "words">): SceneMatch[] {
  const tokens: Token[] = tokensOf(line);
  const map = lexiconOf();
  const out: SceneMatch[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const one = tokens[i] as Token;
    const two = tokens[i + 1];
    const phrase = two ? map.get(`${one.text} ${two.text}`) : undefined;
    if (phrase && two) {
      out.push({ word: two.word, id: phrase });
      i++;
      continue;
    }
    const id = map.get(one.text);
    if (id) out.push({ word: one.word, id });
  }
  return out;
}

export interface ScenePlan extends SceneMatch {
  line: number;
  /** its word's start, song ms */
  at: number;
}

/**
 * The scene each line shows, by line index: the first one it calls that is SCENE_GAP_MS after the
 * last scene shown and SAME_SCENE_GAP_MS after the same scene. One a line at most.
 */
export function planScenes(lines: readonly Line[]): Map<number, ScenePlan> {
  const plans = new Map<number, ScenePlan>();
  let last = Number.NEGATIVE_INFINITY;
  const lastOf = new Map<SceneId, number>();
  lines.forEach((line, index) => {
    if (line.words.length === 0) return;
    for (const match of scenesIn(line)) {
      const at = line.words[match.word]?.start ?? line.start;
      if (at - last < SCENE_GAP_MS) continue;
      if (at - (lastOf.get(match.id) ?? Number.NEGATIVE_INFINITY) < SAME_SCENE_GAP_MS) continue;
      plans.set(index, { ...match, line: index, at });
      last = at;
      lastOf.set(match.id, at);
      return;
    }
  });
  return plans;
}
