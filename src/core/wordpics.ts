/**
 * Word pictures (Effects mode): a word in the lyrics that names something you can draw (iced tea, rain,
 * a rose) shows a tiny picture of it beside the word as it's sung. The pictures are bundled with the
 * app (src/overlay/pictures, made once for Undertone with Higgsfield), so this works offline and costs
 * nothing per song. This module only knows which words call which picture, and which of a song's
 * matches get one: a song never turns into a sticker book.
 *
 * Matching is English and deliberately literal: the listed forms and phrases, plus a plural or a
 * possessive ending and a dropped final g ("burnin'"). Nothing is guessed. A phrase beats a single word
 * ("broken heart" over "heart"), and the picture goes with the phrase's last word, once the whole phrase
 * has been heard. Words that mean too many things ("ring", "wave", "present", "tear") are left out, or
 * only count inside a phrase.
 */
import type { Line } from "./lrc";

/** Every bundled picture: `src/overlay/pictures/<id>.webp`. */
export const PICTURE_IDS = [
  "angel",
  "beer",
  "broken-heart",
  "butterfly",
  "cake",
  "camera",
  "candle",
  "candy",
  "car",
  "champagne",
  "cherry",
  "clock",
  "cocktail",
  "coffee",
  "crown",
  "diamond",
  "disco",
  "fire",
  "ghost",
  "gift",
  "guitar",
  "heart",
  "ice-cream",
  "iced-tea",
  "letter",
  "lightning",
  "lips",
  "money",
  "moon",
  "music",
  "palm",
  "peach",
  "phone",
  "pizza",
  "plane",
  "planet",
  "rain",
  "rainbow",
  "ring",
  "rose",
  "snow",
  "sparkles",
  "star",
  "strawberry",
  "sun",
  "sunset",
  "tear",
  "wave",
  "wine",
] as const;

export type PictureId = (typeof PICTURE_IDS)[number];

/**
 * What calls each picture: words and phrases of up to three words, as sung. Plurals ("roses"), "'s" and
 * a dropped final g ("burnin'") are found without being listed.
 */
const VOCABULARY: Readonly<Record<PictureId, readonly string[]>> = {
  angel: ["angel", "halo", "heaven", "heavenly", "guardian angel"],
  beer: ["beer", "lager", "pint", "keg", "cold one"],
  "broken-heart": ["heartbreak", "heartbreaker", "heartbroken", "heartache", "broken heart", "heart broken", "break my heart", "breaking my heart", "broke my heart", "broken hearted", "brokenhearted"],
  butterfly: ["butterfly", "butterflies"],
  cake: ["cake", "cupcake", "cheesecake", "birthday", "wedding cake", "birthday cake"],
  camera: ["camera", "photo", "photograph", "polaroid", "selfie", "snapshot", "say cheese"],
  candle: ["candle", "candlelight", "candlelit"],
  candy: ["candy", "lollipop", "sweets", "sugar", "bubblegum", "bubble gum", "cotton candy", "candy cane", "gumdrop", "jelly bean"],
  car: ["car", "drive", "driving", "drove", "cadillac", "mustang", "chevy", "porsche", "ferrari", "lambo", "lamborghini", "convertible", "backseat", "back seat", "front seat", "passenger seat", "highway", "freeway", "road trip"],
  champagne: ["champagne", "bubbly", "prosecco", "cheers", "pop the bottle", "sparkling wine"],
  cherry: ["cherry", "cherries", "cherry pie"],
  clock: ["clock", "o'clock", "tick tock", "tick-tock", "ticking", "hourglass", "alarm clock"],
  cocktail: ["cocktail", "margarita", "martini", "mojito", "tequila", "daiquiri", "pina colada", "piña colada"],
  coffee: ["coffee", "espresso", "latte", "cappuccino", "caffeine", "mocha", "macchiato", "cup of joe"],
  crown: ["crown", "crowned", "king", "queen", "royal", "royalty", "throne", "prince", "princess"],
  diamond: ["diamond", "jewel", "jewelry", "jewellery", "gem", "gemstone", "bling"],
  disco: ["disco", "dance", "dancing", "danced", "dancer", "dancefloor", "dance floor", "party", "partying", "nightclub", "disco ball"],
  fire: ["fire", "flame", "flaming", "burn", "burning", "burned", "burnt", "blaze", "blazing", "ablaze", "inferno", "wildfire", "on fire", "set fire"],
  ghost: ["ghost", "ghosted", "ghosting", "haunt", "haunted", "haunting", "phantom"],
  gift: ["gift", "christmas", "xmas"],
  guitar: ["guitar", "six string", "six-string"],
  heart: ["heart", "heartbeat", "sweetheart"],
  "ice-cream": ["ice cream", "icecream", "sundae", "gelato", "soft serve"],
  "iced-tea": ["iced tea", "ice tea", "sweet tea", "tea", "iced teas"],
  letter: ["letter", "love letter", "envelope", "postcard", "mailbox"],
  lightning: ["lightning", "thunder", "thunderstorm", "storm", "stormy", "electric", "electricity", "thunderbolt", "lightning bolt"],
  lips: ["lips", "kiss", "kissed", "kissing", "lipstick", "smooch"],
  money: ["money", "cash", "dollar", "bucks", "rich", "riches", "wealthy", "fortune", "paycheck"],
  moon: ["moon", "moonlight", "moonlit", "moonbeam", "crescent", "full moon"],
  music: ["music", "melody", "melodies", "song", "radio", "tune", "playlist", "mixtape", "vinyl", "harmony", "record player", "sing along", "singalong"],
  palm: ["beach", "island", "tropical", "tropics", "vacation", "oasis", "palm tree", "seaside"],
  peach: ["peach", "peaches", "peachy"],
  phone: ["phone", "telephone", "cellphone", "voicemail", "texting", "call me", "calling me", "text me", "hit my phone", "dial tone"],
  pizza: ["pizza", "pepperoni"],
  plane: ["plane", "airplane", "aeroplane", "airport", "flight", "jet plane", "private jet", "first class"],
  planet: ["planet", "galaxy", "galaxies", "universe", "cosmos", "orbit", "saturn", "jupiter", "mars", "outer space", "solar system"],
  rain: ["rain", "raining", "rained", "rainy", "rainfall", "raindrop", "rainstorm", "drizzle", "downpour", "umbrella", "pouring rain"],
  rainbow: ["rainbow", "over the rainbow"],
  ring: ["wedding", "marry", "married", "marry me", "engaged", "engagement", "fiance", "fiancee", "wedding ring", "diamond ring", "engagement ring", "put a ring"],
  rose: ["rose", "roses", "flower", "bouquet", "blossom", "bloom", "blooming", "petal", "garden", "daisy", "daisies", "tulip", "lilies"],
  snow: ["snow", "snowing", "snowfall", "snowflake", "snowman", "blizzard", "winter", "frozen", "freezing"],
  sparkles: ["sparkle", "sparkling", "glitter", "glittering", "shimmer", "shimmering", "magic", "magical", "twinkle", "twinkling", "shine", "shining", "shiny", "firework", "fireworks"],
  star: ["star", "starlight", "starry", "stardust", "starlit", "superstar", "rockstar", "rock star", "shooting star", "constellation"],
  strawberry: ["strawberry", "strawberries"],
  sun: ["sun", "sunshine", "sunny", "sunlight", "sunbeam", "sunburn"],
  sunset: ["sunset", "sunrise", "sundown", "dusk", "dawn", "horizon", "golden hour"],
  tear: ["tears", "teardrop", "cry", "cries", "crying", "cried", "weep", "weeping", "sob", "sobbing"],
  wave: ["ocean", "sea", "waves", "tide", "surf", "surfing", "high tide", "deep blue sea", "seashore"],
  wine: ["wine", "merlot", "cabernet", "rose wine", "red wine", "white wine", "vino", "glass of wine"],
};

/** The words and phrases that call picture `id`, as listed. */
export function wordsFor(id: PictureId): readonly string[] {
  return VOCABULARY[id];
}

/** At most one picture per line, at least this long after the last one (ms)... */
export const PICTURE_GAP_MS = 6000;
/** ...and the same picture again only this long after it last showed. */
export const SAME_PICTURE_GAP_MS = 25000;
/** Phrases are at most this many words. */
const MAX_PHRASE = 3;

/** A word as matching sees it: lower case, without accents, punctuation or a possessive ending. */
export function normalizeToken(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[‘’ʼ`´]/gu, "'")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, "")
    .replace(/'s$|s'$|'+$/u, (end) => (end === "s'" ? "s" : ""))
    .replace(/^'+/u, "");
}

/** One matchable token of a line: a word, or a part of a hyphenated one, with the word it came from. */
export interface Token {
  text: string;
  word: number;
}

/** A line's tokens in order: each word normalized, hyphenated and slashed words split. */
export function tokensOf(line: Pick<Line, "words">): Token[] {
  const out: Token[] = [];
  line.words.forEach((w, word) => {
    for (const piece of w.text.split(/[-–—/]+/u)) {
      const text = normalizeToken(piece);
      if (text) out.push({ text, word });
    }
  });
  return out;
}

let lexicon: Map<string, PictureId> | null = null;

/** Every listed form and phrase, normalized like sung words are. */
function lexiconOf(): Map<string, PictureId> {
  if (lexicon) return lexicon;
  const map = new Map<string, PictureId>();
  for (const id of PICTURE_IDS) {
    for (const entry of VOCABULARY[id]) {
      const key = entry
        .split(/[\s-]+/u)
        .map(normalizeToken)
        .filter(Boolean)
        .join(" ");
      if (key && !map.has(key)) map.set(key, id);
    }
  }
  lexicon = map;
  return map;
}

/** The forms a sung word may be listed as: itself, then without a plural ending, then with its final g back. */
function formsOf(token: string): string[] {
  const forms = [token];
  if (token.length > 3) {
    if (token.endsWith("ies")) forms.push(`${token.slice(0, -3)}y`);
    if (/(?:ches|shes|sses|xes|oes)$/u.test(token)) forms.push(token.slice(0, -2));
    if (token.endsWith("s") && !token.endsWith("ss")) forms.push(token.slice(0, -1));
  }
  if (/in$/u.test(token) && token.length > 4) forms.push(`${token}g`);
  if (token.includes("'")) forms.push(token.replace(/'/gu, ""));
  return forms;
}

/** The picture a run of tokens names, if any (its last token may be a plural or a dropped-g form). */
function lookup(tokens: readonly Token[], from: number, n: number): PictureId | null {
  const map = lexiconOf();
  const head = tokens.slice(from, from + n - 1).map((t) => t.text);
  const last = tokens[from + n - 1];
  if (!last) return null;
  for (const form of formsOf(last.text)) {
    const id = map.get([...head, form].join(" "));
    if (id) return id;
  }
  return null;
}

/** A picture called by a line: the word it goes with (the last word of its phrase). */
export interface PictureMatch {
  word: number;
  id: PictureId;
}

/** Every picture a line calls, left to right; the longest phrase wins where phrases overlap. */
export function picturesIn(line: Pick<Line, "words">): PictureMatch[] {
  const tokens = tokensOf(line);
  const out: PictureMatch[] = [];
  let i = 0;
  while (i < tokens.length) {
    let found: { id: PictureId; n: number } | null = null;
    for (let n = Math.min(MAX_PHRASE, tokens.length - i); n >= 1 && !found; n--) {
      const id = lookup(tokens, i, n);
      if (id) found = { id, n };
    }
    if (found) {
      const word = tokens[i + found.n - 1]?.word ?? 0;
      if (out[out.length - 1]?.word !== word) out.push({ word, id: found.id });
      i += found.n;
    } else {
      i++;
    }
  }
  return out;
}

/** A picture the song shows: on line `line`, beside word `word`, as it starts at song time `at`. */
export interface PicturePlan extends PictureMatch {
  line: number;
  at: number;
}

/**
 * Which of a song's matches show a picture, by line index: in song order, at most one a line, at least
 * PICTURE_GAP_MS after the last one, and the same picture again only after SAME_PICTURE_GAP_MS. A song
 * gets the same pictures every time it plays.
 */
export function planPictures(lines: readonly Line[]): Map<number, PicturePlan> {
  const plans = new Map<number, PicturePlan>();
  let last = Number.NEGATIVE_INFINITY;
  const lastOf = new Map<PictureId, number>();
  lines.forEach((line, index) => {
    if (line.words.length === 0) return;
    for (const match of picturesIn(line)) {
      const at = line.words[match.word]?.start ?? line.start;
      if (at - last < PICTURE_GAP_MS) continue;
      if (at - (lastOf.get(match.id) ?? Number.NEGATIVE_INFINITY) < SAME_PICTURE_GAP_MS) continue;
      plans.set(index, { ...match, line: index, at });
      last = at;
      lastOf.set(match.id, at);
      return;
    }
  });
  return plans;
}
