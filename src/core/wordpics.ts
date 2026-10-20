/**
 * Word pictures (Effects mode): a word in the lyrics that names something you can picture (iced tea,
 * rain, a rose, a guitar, a wolf) shows a tiny photograph of it beside the word as it's sung. The 140
 * pictures are bundled with the app (src/overlay/pictures, made once for Undertone with Higgsfield), so
 * this works offline and costs nothing per song. This module only knows which words call which picture, and which of a song's
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
  "anchor",
  "angel",
  "apple",
  "balloon",
  "bed",
  "bee",
  "beer",
  "bird",
  "boat",
  "book",
  "boots",
  "bottle",
  "bouquet",
  "bridge",
  "broken-heart",
  "burger",
  "butterfly",
  "cactus",
  "cake",
  "camera",
  "campfire",
  "candle",
  "candy",
  "car",
  "cards",
  "cassette",
  "castle",
  "cat",
  "champagne",
  "cherry",
  "chocolate",
  "city",
  "clock",
  "cloud",
  "clover",
  "cocktail",
  "coffee",
  "compass",
  "cowboy-hat",
  "crown",
  "diamond",
  "dice",
  "disco",
  "dog",
  "door",
  "dove",
  "dress",
  "drum",
  "earth",
  "feather",
  "fire",
  "fireworks",
  "galaxy",
  "ghost",
  "gift",
  "gold",
  "guitar",
  "headphones",
  "heart",
  "heels",
  "horse",
  "hourglass",
  "house",
  "ice",
  "ice-cream",
  "iced-tea",
  "jacket",
  "key",
  "lantern",
  "laptop",
  "leaf",
  "lemon",
  "letter",
  "light-bulb",
  "lighter",
  "lighthouse",
  "lightning",
  "lion",
  "lips",
  "map",
  "match",
  "microphone",
  "milkshake",
  "mirror",
  "money",
  "moon",
  "motorcycle",
  "mountain",
  "music",
  "necklace",
  "palm",
  "paper-plane",
  "peach",
  "pen",
  "perfume",
  "phone",
  "piano",
  "pine",
  "pizza",
  "plane",
  "planet",
  "polaroid",
  "popcorn",
  "radio",
  "rain",
  "rainbow",
  "raven",
  "ring",
  "rocket",
  "rose",
  "saxophone",
  "smoke",
  "snake",
  "sneakers",
  "snow",
  "sparkler",
  "star",
  "strawberry",
  "street-lamp",
  "suitcase",
  "sun",
  "sunflower",
  "sunglasses",
  "tear",
  "teddy-bear",
  "tequila",
  "tiger",
  "train",
  "tree",
  "trophy",
  "truck",
  "tv",
  "umbrella",
  "watch",
  "watermelon",
  "wave",
  "whiskey",
  "window",
  "wine",
  "wolf",
] as const;

export type PictureId = (typeof PICTURE_IDS)[number];

/**
 * What calls each picture: words and phrases of up to three words, as sung. Plurals ("roses"), "'s" and
 * a dropped final g ("burnin'") are found without being listed.
 */
const VOCABULARY: Readonly<Record<PictureId, readonly string[]>> = {
  anchor: ["anchor"],
  angel: ["angel", "halo", "heaven", "heavenly", "guardian angel", "wings"],
  apple: ["apple", "apples"],
  balloon: ["balloon"],
  bed: ["bed", "bedroom", "pillow"],
  bee: ["bee", "honeybee", "bumblebee", "honeycomb"],
  beer: ["beer", "lager", "pint", "keg", "cold one", "cold beer"],
  bird: ["bird", "songbird", "sparrow", "robin", "bluebird"],
  boat: ["boat", "sailboat", "sail", "sailing", "ship", "yacht"],
  book: ["book", "novel", "chapter", "diary", "journal", "poem", "poetry"],
  boots: ["boots", "cowboy boots"],
  bottle: ["bottle"],
  bouquet: ["flower", "bouquet", "blossom", "bloom", "blooming", "petal", "garden", "daisy", "daisies", "tulip", "lilies", "lily", "lavender"],
  bridge: ["bridge"],
  "broken-heart": ["heartbreak", "heartbreaker", "heartbroken", "heartache", "broken heart", "heart broken", "break my heart", "breaking my heart", "broke my heart", "broken hearted", "brokenhearted"],
  burger: ["burger", "cheeseburger", "hamburger", "fries", "french fries"],
  butterfly: ["butterfly", "butterflies"],
  cactus: ["cactus", "desert"],
  cake: ["cake", "cupcake", "cheesecake", "birthday", "wedding cake", "birthday cake", "happy birthday"],
  camera: ["camera", "selfie", "snapshot", "say cheese"],
  campfire: ["campfire", "bonfire", "fireplace", "firelight", "fireside"],
  candle: ["candle", "candlelight", "candlelit"],
  candy: ["candy", "lollipop", "sweets", "sugar", "bubblegum", "bubble gum", "cotton candy", "candy cane", "gumdrop", "jelly bean"],
  car: ["car", "drive", "driving", "drove", "cadillac", "mustang", "chevy", "porsche", "ferrari", "lambo", "lamborghini", "convertible", "backseat", "back seat", "front seat", "passenger seat", "highway", "freeway", "road trip"],
  cards: ["cards", "poker", "deck of cards", "ace"],
  cassette: ["cassette", "mixtape", "mix tape"],
  castle: ["castle", "palace", "kingdom"],
  cat: ["cat", "kitty", "kitten"],
  champagne: ["champagne", "bubbly", "prosecco", "cheers", "pop the bottle", "sparkling wine", "raise a glass", "raise your glass", "make a toast"],
  cherry: ["cherry", "cherries", "cherry pie"],
  chocolate: ["chocolate", "cocoa", "hot chocolate"],
  city: ["city", "cities", "downtown", "skyline", "skyscraper", "city lights", "big city"],
  clock: ["clock", "o'clock", "tick tock", "tick-tock", "ticking", "alarm clock"],
  cloud: ["cloud", "cloudy", "sky", "skies"],
  clover: ["clover", "lucky", "luck", "four leaf clover", "good luck"],
  cocktail: ["cocktail", "margarita", "martini", "mojito", "daiquiri", "pina colada", "cosmopolitan"],
  coffee: ["coffee", "espresso", "latte", "cappuccino", "caffeine", "mocha", "macchiato", "cup of joe", "coffee shop", "cafe"],
  compass: ["compass"],
  "cowboy-hat": ["cowboy", "cowgirl", "stetson", "rodeo", "cowboy hat"],
  crown: ["crown", "crowned", "king", "queen", "royal", "royalty", "throne", "prince", "princess"],
  diamond: ["diamond", "jewel", "jewelry", "jewellery", "gem", "gemstone", "bling"],
  dice: ["dice", "roll the dice", "gamble", "gambling", "casino", "vegas", "las vegas", "jackpot"],
  disco: ["disco", "dance", "dancing", "danced", "dancer", "dancefloor", "dance floor", "party", "partying", "nightclub", "disco ball", "club", "clubbing"],
  dog: ["dog", "puppy", "puppies", "hound"],
  door: ["door", "doorway", "doorstep", "front door"],
  dove: ["dove"],
  dress: ["dress", "gown", "sundress", "little black dress"],
  drum: ["drum", "drumbeat", "drummer"],
  earth: ["earth", "world", "globe", "worldwide"],
  feather: ["feather", "feathers"],
  fire: ["fire", "flame", "flaming", "burn", "burning", "burned", "burnt", "blaze", "blazing", "ablaze", "inferno", "wildfire", "on fire", "set fire"],
  fireworks: ["firework", "fireworks", "fourth of july"],
  galaxy: ["galaxy", "galaxies", "universe", "cosmos", "milky way", "outer space"],
  ghost: ["ghost", "ghosted", "ghosting", "haunt", "haunted", "haunting", "phantom"],
  gift: ["gift", "christmas", "xmas"],
  gold: ["gold", "gold rush", "solid gold"],
  guitar: ["guitar", "six string", "six-string"],
  headphones: ["headphones", "earphones", "headset", "earbuds"],
  heart: ["heart", "heartbeat", "sweetheart", "head over heels"],
  heels: ["heels", "high heels", "stilettos"],
  horse: ["horse", "stallion", "pony", "horseback", "wild horses"],
  hourglass: ["hourglass", "sands of time"],
  house: ["house", "home", "hometown", "cottage", "home sweet home"],
  ice: ["ice cube", "ice cubes", "ice cold", "cold as ice", "iceberg"],
  "ice-cream": ["ice cream", "icecream", "sundae", "gelato", "soft serve"],
  "iced-tea": ["iced tea", "ice tea", "sweet tea", "tea", "iced teas", "cup of tea", "teacup"],
  jacket: ["leather jacket", "jacket"],
  key: ["key", "keys", "keychain"],
  lantern: ["lantern"],
  laptop: ["laptop", "computer"],
  leaf: ["leaf", "autumn", "maple", "fallen leaves", "autumn leaves"],
  lemon: ["lemon", "lemons", "lemonade"],
  letter: ["letter", "love letter", "envelope", "postcard", "mailbox"],
  "light-bulb": ["light bulb", "lightbulb", "bulb"],
  lighter: ["lighter", "lighters", "zippo"],
  lighthouse: ["lighthouse"],
  lightning: ["lightning", "thunder", "thunderstorm", "storm", "stormy", "electric", "electricity", "thunderbolt", "lightning bolt"],
  lion: ["lion", "lioness"],
  lips: ["lips", "kiss", "kissed", "kissing", "lipstick", "smooch"],
  map: ["map"],
  match: ["matchstick", "strike a match", "light a match"],
  microphone: ["microphone", "mic", "karaoke", "on the mic", "sing along", "singalong"],
  milkshake: ["milkshake"],
  mirror: ["mirror", "reflection"],
  money: ["money", "cash", "dollar", "bucks", "rich", "riches", "wealthy", "fortune", "paycheck"],
  moon: ["moon", "moonlight", "moonlit", "moonbeam", "crescent", "full moon"],
  motorcycle: ["motorcycle", "motorbike", "harley"],
  mountain: ["mountain", "mountaintop"],
  music: ["music", "melody", "melodies", "song", "tune", "playlist", "vinyl", "record player", "harmony"],
  necklace: ["necklace", "pearls", "pearl"],
  palm: ["beach", "island", "tropical", "tropics", "vacation", "oasis", "palm tree", "seaside", "paradise"],
  "paper-plane": ["paper plane", "paper airplane"],
  peach: ["peach", "peaches", "peachy"],
  pen: ["pen", "pencil", "ink", "autograph"],
  perfume: ["perfume", "cologne", "fragrance"],
  phone: ["phone", "telephone", "cellphone", "voicemail", "texting", "call me", "calling me", "text me", "hit my phone", "dial tone", "iphone"],
  piano: ["piano", "grand piano", "piano keys"],
  pine: ["pine tree", "christmas tree", "evergreen"],
  pizza: ["pizza", "pepperoni"],
  plane: ["plane", "airplane", "aeroplane", "airport", "flight", "jet plane", "private jet", "first class"],
  planet: ["planet", "orbit", "saturn", "jupiter", "mars", "solar system"],
  polaroid: ["photo", "photograph", "polaroid"],
  popcorn: ["popcorn", "movie", "movies", "cinema", "drive-in", "drive in", "silver screen"],
  radio: ["radio", "on the radio"],
  rain: ["rain", "raining", "rained", "rainy", "rainfall", "raindrop", "rainstorm", "drizzle", "downpour", "pouring rain"],
  rainbow: ["rainbow", "over the rainbow"],
  raven: ["raven", "crow", "blackbird"],
  ring: ["wedding", "marry", "married", "marry me", "engaged", "engagement", "fiance", "fiancee", "wedding ring", "diamond ring", "engagement ring", "put a ring", "bride"],
  rocket: ["rocket", "spaceship", "spacecraft", "blast off", "astronaut"],
  rose: ["rose", "roses"],
  saxophone: ["saxophone", "sax"],
  smoke: ["smoke", "smoky", "smoking", "cigarette"],
  snake: ["snake", "serpent", "viper", "rattlesnake"],
  sneakers: ["sneakers"],
  snow: ["snow", "snowing", "snowfall", "snowflake", "snowman", "blizzard", "winter", "frozen", "freezing"],
  sparkler: ["sparkle", "sparkling", "glitter", "glittering", "shimmer", "shimmering", "magic", "magical", "twinkle", "twinkling", "shine", "shining", "shiny", "sparkler"],
  star: ["star", "starlight", "starry", "stardust", "starlit", "superstar", "rockstar", "rock star", "shooting star", "constellation", "north star"],
  strawberry: ["strawberry", "strawberries"],
  "street-lamp": ["streetlight", "street light", "streetlamp", "street lamp", "lamppost", "lamp post"],
  suitcase: ["suitcase", "luggage", "pack my bags", "packed my bags", "packing my bags"],
  sun: ["sun", "sunshine", "sunny", "sunlight", "sunbeam", "sunburn", "sunset", "sunrise", "sundown", "dusk", "dawn", "horizon", "golden hour"],
  sunflower: ["sunflower", "sunflowers"],
  sunglasses: ["sunglasses", "aviators"],
  tear: ["tears", "teardrop", "cry", "cries", "crying", "cried", "weep", "weeping", "sob", "sobbing"],
  "teddy-bear": ["teddy", "teddy bear"],
  tequila: ["tequila", "shot glass", "take a shot", "mezcal"],
  tiger: ["tiger"],
  train: ["train", "railroad", "railway", "locomotive"],
  tree: ["tree", "oak", "willow", "forest", "woods"],
  trophy: ["trophy", "trophies", "champion", "winner", "victory"],
  truck: ["truck", "pickup truck", "tailgate"],
  tv: ["tv", "television"],
  umbrella: ["umbrella"],
  watch: ["wristwatch", "rolex", "rollie", "timepiece"],
  watermelon: ["watermelon"],
  wave: ["ocean", "sea", "waves", "tide", "surf", "surfing", "high tide", "deep blue sea", "seashore"],
  whiskey: ["whiskey", "whisky", "bourbon", "scotch", "liquor", "on the rocks", "glass of whiskey"],
  window: ["window", "windowsill"],
  wine: ["wine", "merlot", "cabernet", "rose wine", "red wine", "white wine", "vino", "glass of wine", "pinot", "chardonnay", "wine glass"],
  wolf: ["wolf", "wolves", "howl", "howling"],
};

/** The words and phrases that call picture `id`, as listed. */
export function wordsFor(id: PictureId): readonly string[] {
  return VOCABULARY[id];
}

/** At most one picture per line, at least this long after the last one (ms)... */
export const PICTURE_GAP_MS = 4000;
/** ...and the same picture again only this long after it last showed. */
export const SAME_PICTURE_GAP_MS = 20000;
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
