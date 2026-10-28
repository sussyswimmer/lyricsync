/**
 * Word glyphs (Graphics, in Reel): a small line icon beside a word that names something, the way a
 * road sign stands for a thing: "city" gets a building, "left" an arrow, "started" a play button,
 * "glasses" a pair of glasses, "dance" a dancer, "call" a phone. Reel sets one word at a time, so a
 * word has room for a sign beside it and the eye takes the pair in at once; the row styles show
 * pictures instead (wordpics.ts, which this shares its word forms with).
 *
 * This module is the vocabulary and the plan: which words carry which glyph, and which words of
 * which lines get one (every word that has one: signs are quiet). Pure and deterministic. The
 * drawings are overlay/glyphs.ts.
 */
import type { Line } from "./lrc";
import { tokensOf, type Token } from "./wordpics";

export const GLYPH_IDS = [
  "building",
  "house",
  "arrow-left",
  "arrow-right",
  "arrow-up",
  "arrow-down",
  "play",
  "plus",
  "shirt",
  "glasses",
  "wine",
  "dancer",
  "music",
  "heart",
  "broken-heart",
  "star",
  "moon",
  "sun",
  "cloud",
  "rain",
  "snow",
  "fire",
  "lightning",
  "phone",
  "clock",
  "hourglass",
  "calendar",
  "car",
  "plane",
  "bird",
  "rocket",
  "eye",
  "hand",
  "person",
  "money",
  "diamond",
  "crown",
  "key",
  "camera",
  "pin",
  "globe",
  "bed",
  "cup",
  "gift",
  "flag",
  "trophy",
  "speech",
  "smile",
  "sad",
  "skull",
  "ghost",
  "bell",
  "flower",
  "tree",
  "mountain",
  "wave",
  "boat",
  "train",
  "bike",
  "door",
  "window",
  "food",
  "cake",
  "bag",
  "shoe",
  "ring",
  "letter",
  "pen",
  "book",
  "mic",
  "headphones",
  "guitar",
  "drum",
  "piano",
  "tv",
  "dice",
  "infinity",
  "x",
  "check",
  "question",
  "compass",
  "anchor",
  "link",
  "target",
  "bulb",
  "dumbbell",
  "shield",
  "heal",
  "boom",
  "magic",
  "paw",
  "balloon",
  "party",
  "speaker",
  "signal",
  "scissors",
  "send",
  "mirror",
  "halo",
  "lips",
] as const;
export type GlyphId = (typeof GLYPH_IDS)[number];

/** The words that carry each glyph, lowercase, as sung (a possessive matches its word). */
const GLYPH_WORDS: Readonly<Record<GlyphId, readonly string[]>> = {
  building: ["city", "cities", "town", "downtown", "building", "buildings", "skyline", "apartment", "apartments", "office", "tower", "towers", "rooftop", "rooftops"],
  house: ["home", "homes", "house", "houses", "roof", "porch", "yard", "kitchen", "basement", "attic"],
  "arrow-left": ["left", "leave", "leaves", "leaving", "back", "behind", "backwards", "return", "returning"],
  "arrow-right": ["right", "forward", "ahead", "go", "going", "goin", "gone", "move", "moving", "onward", "next", "through", "chase", "chasing"],
  "arrow-up": ["up", "rise", "rising", "higher", "above", "top", "climb", "climbing", "lift", "lifted", "raise"],
  "arrow-down": ["down", "fall", "falling", "fell", "below", "under", "underneath", "low", "lower", "drop", "dropping", "dropped", "sink", "sinking"],
  play: ["start", "started", "starting", "begin", "began", "beginning", "play", "played", "playing", "press", "pressed"],
  plus: ["more", "plus", "add", "added", "another", "extra", "again", "double"],
  shirt: ["wear", "wearing", "wore", "worn", "clothes", "dress", "dressed", "shirt", "jacket", "jeans", "suit", "outfit", "fit"],
  glasses: ["glasses", "shades", "sunglasses", "specs"],
  wine: ["champagne", "wine", "drink", "drinks", "drinking", "drank", "drunk", "bottle", "bottles", "cheers", "toast", "bar", "bars", "whiskey", "whisky", "tequila", "vodka", "liquor", "beer", "beers", "shots", "cocktail", "cocktails"],
  dancer: ["dance", "danced", "dancing", "dancer", "dancers", "dancefloor", "floor", "groove", "grooving", "twerk", "twirl", "spin", "spinning"],
  music: ["music", "song", "songs", "sing", "singing", "sang", "sung", "melody", "melodies", "tune", "tunes", "radio", "record", "records", "note", "notes", "chorus", "hum", "humming", "playlist", "album", "beat", "beats"],
  heart: ["love", "loved", "loving", "lover", "lovers", "heart", "hearts", "valentine", "sweetheart", "darling", "crush", "adore"],
  "broken-heart": ["broken", "heartbreak", "heartbroken", "hurt", "hurts", "hurting", "breakup", "goodbye"],
  star: ["star", "stars", "famous", "fame", "superstar", "starlight", "stardust", "wish", "wishes", "wishing"],
  moon: ["moon", "moonlight", "night", "nights", "tonight", "midnight", "late", "dark", "darkness", "nightfall", "evening"],
  sun: ["sun", "sunshine", "sunrise", "sunset", "sunny", "morning", "mornings", "day", "days", "daylight", "dawn", "noon", "summer", "afternoon"],
  cloud: ["cloud", "clouds", "cloudy", "sky", "skies", "dream", "dreams", "dreaming", "dreamed", "dreamt", "daydream", "smoke", "fog", "mist", "haze"],
  rain: ["rain", "rains", "raining", "rainy", "storm", "storms", "stormy", "tears", "cry", "crying", "cried", "weep", "weeping", "drizzle", "monsoon"],
  snow: ["snow", "snowing", "snowflake", "snowflakes", "winter", "cold", "colder", "ice", "icy", "frozen", "freeze", "freezing", "frost", "chill", "chilly"],
  fire: ["fire", "fires", "flame", "flames", "burn", "burns", "burning", "burned", "burnt", "hot", "hotter", "heat", "lit", "blaze", "ignite", "hell", "devil", "demons"],
  lightning: ["lightning", "thunder", "electric", "electricity", "power", "powerful", "shock", "shocking", "spark", "sparks", "energy", "charged", "voltage"],
  phone: ["phone", "phones", "call", "calls", "called", "calling", "text", "texts", "texted", "texting", "dial", "dialing", "hotline", "ringing", "line", "cellphone", "voicemail"],
  clock: ["time", "times", "clock", "clocks", "hour", "hours", "minute", "minutes", "second", "seconds", "oclock", "tick", "ticking", "deadline"],
  hourglass: ["wait", "waits", "waiting", "waited", "patience", "patient", "slow", "slowly", "slower", "someday", "eventually", "meanwhile"],
  calendar: ["today", "tomorrow", "yesterday", "week", "weeks", "weekend", "weekends", "month", "months", "year", "years", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december", "birthday", "anniversary"],
  car: ["car", "cars", "drive", "drives", "driving", "drove", "driven", "ride", "rides", "riding", "rode", "road", "roads", "highway", "highways", "street", "streets", "wheel", "wheels", "truck", "trucks", "taxi", "cab", "uber", "lane", "lanes", "traffic", "engine"],
  plane: ["plane", "planes", "airplane", "airplanes", "fly", "flying", "flew", "flight", "flights", "airport", "jet", "jets", "takeoff"],
  bird: ["bird", "birds", "wings", "winged", "dove", "doves", "sparrow", "eagle", "feather", "feathers", "soar", "soaring"],
  rocket: ["rocket", "rockets", "space", "spaceship", "launch", "launched", "blast", "blastoff", "orbit", "astronaut", "mars", "planet", "planets", "galaxy"],
  eye: ["eye", "eyes", "see", "seeing", "saw", "seen", "look", "looks", "looking", "looked", "watch", "watching", "watched", "stare", "staring", "glance", "vision", "view", "visions", "witness"],
  hand: ["hand", "hands", "touch", "touching", "touched", "hold", "holding", "held", "reach", "reaching", "grab", "grip", "wave", "waving", "waved", "palm", "fingers", "fingertips", "high-five", "hug", "hugging", "hugs"],
  person: ["man", "men", "woman", "women", "girl", "girls", "boy", "boys", "people", "friend", "friends", "somebody", "someone", "everybody", "everyone", "nobody", "stranger", "strangers", "lady", "guy", "guys", "brother", "sister", "mama", "mother", "father", "daddy", "papa", "crowd", "neighbor", "neighbors", "child", "children", "kid", "kids", "baby", "babies"],
  money: ["money", "cash", "dollar", "dollars", "rich", "richer", "paid", "pay", "paying", "bank", "banks", "price", "buy", "bought", "sell", "sold", "spend", "spending", "spent", "million", "millions", "billion", "billions", "bills", "coins", "cheque", "check-cashing", "wallet", "pockets", "broke", "fortune", "paycheck", "racks", "stacks"],
  diamond: ["diamond", "diamonds", "jewel", "jewels", "jewelry", "gem", "gems", "pearls", "pearl", "bling", "chains", "necklace", "rolex"],
  crown: ["king", "kings", "queen", "queens", "crown", "crowns", "royal", "royalty", "throne", "prince", "princess", "kingdom", "majesty", "boss"],
  key: ["key", "keys", "lock", "locked", "locks", "unlock", "unlocked", "secret", "secrets"],
  camera: ["camera", "cameras", "picture", "pictures", "photo", "photos", "photograph", "flash", "flashes", "selfie", "selfies", "snapshot", "polaroid", "paparazzi"],
  pin: ["somewhere", "anywhere", "nowhere", "everywhere", "place", "places", "location", "map", "maps", "address", "destination", "corner", "spot", "miles", "distance", "far", "faraway"],
  globe: ["world", "worlds", "earth", "global", "worldwide", "universe", "continent", "countries", "country", "nation", "america", "africa", "europe", "asia", "london", "paris", "tokyo", "york"],
  bed: ["bed", "beds", "sleep", "sleeping", "slept", "asleep", "pillow", "pillows", "blanket", "sheets", "bedroom", "nap", "snooze", "rest", "resting"],
  cup: ["coffee", "tea", "cup", "cups", "espresso", "latte", "cafe", "café", "caffeine", "mug"],
  gift: ["gift", "gifts", "present", "presents", "christmas", "surprise", "surprises", "wrapped"],
  flag: ["flag", "flags", "win", "wins", "winning", "won", "victory", "finish", "finished", "finishing", "goal", "goals", "mission", "country-flag"],
  trophy: ["trophy", "trophies", "champion", "champions", "winner", "winners", "medal", "medals", "prize", "prizes", "award", "awards", "greatest", "legend", "legends"],
  speech: ["say", "says", "said", "saying", "talk", "talks", "talking", "talked", "tell", "tells", "telling", "told", "speak", "speaking", "spoke", "spoken", "words", "word", "conversation", "whisper", "whispers", "whispered", "promise", "promised", "promises", "lie", "lies", "lying", "truth", "story", "stories", "gossip", "rumors", "rumours"],
  smile: ["smile", "smiles", "smiling", "smiled", "happy", "happier", "happiness", "laugh", "laughs", "laughing", "laughed", "laughter", "joy", "joyful", "glad", "grin", "grinning", "giggle"],
  sad: ["sad", "sadness", "lonely", "loneliness", "alone", "sorry", "miss", "missing", "missed", "blue", "blues", "sorrow", "grief", "grieving", "empty", "hollow", "lost"],
  skull: ["dead", "death", "die", "died", "dying", "kill", "killed", "killing", "killer", "grave", "graves", "bones", "skull", "skulls", "poison", "funeral", "coffin", "zombie", "zombies"],
  ghost: ["ghost", "ghosts", "haunted", "haunting", "haunt", "spirit", "spirits", "invisible", "vanish", "vanished", "disappear", "disappeared", "phantom"],
  bell: ["bell", "bells", "alarm", "alarms", "wake", "woke", "waking", "awake", "ring", "rings", "rang", "chime", "chimes", "church-bell"],
  flower: ["flower", "flowers", "rose", "roses", "bloom", "blooming", "blossom", "blossoms", "garden", "gardens", "petal", "petals", "spring", "daisy", "daisies", "lily", "lilies", "tulip", "tulips", "bouquet"],
  tree: ["tree", "trees", "forest", "forests", "woods", "leaf", "pine", "pines", "branch", "branches", "roots", "oak", "jungle", "autumn", "fall-leaves"],
  mountain: ["mountain", "mountains", "hill", "hills", "peak", "peaks", "cliff", "cliffs", "canyon", "valley", "valleys", "summit", "everest", "rocky", "rocks"],
  wave: ["ocean", "oceans", "sea", "seas", "waves", "tide", "tides", "beach", "beaches", "shore", "shores", "river", "rivers", "lake", "lakes", "swim", "swimming", "swam", "surf", "surfing", "water", "waters", "coast", "island", "islands", "bay", "harbor", "harbour", "pool"],
  boat: ["boat", "boats", "ship", "ships", "sail", "sails", "sailing", "sailed", "sailor", "sailors", "yacht", "yachts", "canoe", "cruise", "ferry", "titanic"],
  train: ["train", "trains", "station", "stations", "subway", "metro", "railway", "railroad", "tracks", "platform", "locomotive", "tram"],
  bike: ["bike", "bikes", "bicycle", "bicycles", "motorbike", "motorbikes", "motorcycle", "motorcycles", "cycling", "harley", "scooter"],
  door: ["door", "doors", "doorway", "knock", "knocking", "knocked", "exit", "exits", "enter", "entrance", "gate", "gates", "hallway", "doorstep", "threshold"],
  window: ["window", "windows", "windowsill", "curtains", "curtain", "blinds", "glass", "pane"],
  food: ["eat", "eating", "ate", "food", "dinner", "dinners", "lunch", "breakfast", "hungry", "hunger", "feast", "meal", "meals", "kitchen-table", "restaurant", "pizza", "burger", "taco", "tacos", "noodles", "rice", "bread", "steak", "fries", "chicken", "sushi", "pasta"],
  cake: ["cake", "cakes", "sweet", "sweets", "sweeter", "sugar", "candy", "candies", "honey", "dessert", "chocolate", "cookie", "cookies", "cupcake", "cupcakes", "pie", "icing", "frosting", "treat", "treats"],
  bag: ["bag", "bags", "suitcase", "suitcases", "luggage", "travel", "traveling", "travelling", "trip", "trips", "journey", "journeys", "pack", "packed", "packing", "backpack", "vacation", "holiday", "holidays", "tour", "touring"],
  shoe: ["shoes", "shoe", "boots", "boot", "sneakers", "sneaker", "heels", "walk", "walks", "walking", "walked", "run", "runs", "running", "ran", "steps", "step", "stepping", "feet", "footsteps", "stroll", "strolling", "jog", "jogging", "kicks", "jordans", "nikes"],
  ring: ["married", "marry", "marriage", "wedding", "weddings", "wife", "husband", "bride", "groom", "engaged", "engagement", "proposal", "propose", "vows", "forever-ring", "honeymoon"],
  letter: ["letter", "letters", "mail", "email", "emails", "envelope", "envelopes", "postcard", "postcards", "stamp", "stamps", "message", "messages", "memo", "note-to", "inbox"],
  pen: ["write", "writes", "writing", "wrote", "written", "pen", "pens", "pencil", "pencils", "ink", "signature", "sign", "signed", "signing", "draw", "drawing", "drew", "sketch", "poem", "poems", "poetry", "writer", "author", "diary", "journal"],
  book: ["book", "books", "read", "reads", "reading", "page", "pages", "chapter", "chapters", "novel", "novels", "library", "libraries", "bible", "textbook", "homework", "school", "class", "classes", "college", "lesson", "lessons", "study", "studying"],
  mic: ["mic", "mics", "microphone", "microphones", "rap", "raps", "rapping", "rapper", "rappers", "voice", "voices", "loud", "louder", "scream", "screams", "screaming", "screamed", "shout", "shouts", "shouting", "shouted", "yell", "yelling", "stage", "spotlight", "karaoke", "concert", "concerts", "announce"],
  headphones: ["headphones", "earphones", "earbuds", "listen", "listens", "listening", "listened", "hear", "hears", "hearing", "heard", "sound", "sounds", "noise", "noises", "stereo", "speakers", "airpods", "volume", "silence", "silent", "quiet"],
  guitar: ["guitar", "guitars", "strings", "band", "bands", "rock", "rocking", "rocker", "riff", "riffs", "strum", "strumming", "chords", "chord", "acoustic", "bass", "ukulele", "banjo", "violin", "fiddle", "cello"],
  drum: ["drum", "drums", "drummer", "rhythm", "rhythms", "tempo", "percussion", "cymbals", "snare", "kick-drum", "boom-bap", "pulse", "heartbeat", "heartbeats"],
  piano: ["piano", "pianos", "keyboard", "keyboards", "organ", "synth", "synths", "synthesizer", "ivory", "ivories", "pianist", "grand-piano"],
  tv: ["tv", "television", "televisions", "screen", "screens", "movie", "movies", "film", "films", "cinema", "channel", "channels", "netflix", "theater", "theatre", "hollywood", "video", "videos", "remote", "cartoon", "cartoons"],
  dice: ["dice", "die-roll", "gamble", "gambling", "gambler", "casino", "casinos", "bet", "bets", "betting", "cards", "poker", "roulette", "vegas", "jackpot", "lucky", "luck", "chance", "odds", "game", "games", "gamer"],
  infinity: ["forever", "always", "infinite", "infinity", "endless", "endlessly", "eternal", "eternity", "evermore", "everlasting", "timeless", "unending", "limitless"],
  x: ["no", "never", "nothing", "stop", "stops", "stopped", "stopping", "end", "ends", "ended", "ending", "over", "done", "quit", "wrong", "cancel", "cancelled", "canceled", "nope", "nah", "delete", "deleted", "erase", "erased", "fail", "failed", "failure"],
  check: ["yes", "yeah", "okay", "ok", "fine", "true", "sure", "good", "alright", "right-on", "correct", "agreed", "deal", "perfect", "approved", "confirmed", "yup", "yep", "absolutely", "definitely", "done-deal", "cool"],
  question: ["why", "how", "what", "maybe", "wonder", "wonders", "wondering", "wondered", "question", "questions", "doubt", "doubts", "doubting", "guess", "guessing", "confused", "confusion", "mystery", "mysteries", "riddle", "unsure", "perhaps", "whatever", "unknown", "curious"],
  compass: ["find", "finds", "finding", "found", "search", "searching", "searched", "seek", "seeking", "way", "ways", "direction", "directions", "north", "south", "east", "west", "wander", "wandering", "wandered", "explore", "exploring", "navigate", "compass", "path", "paths", "trail", "trails", "roam", "roaming"],
  anchor: ["stay", "stays", "stayed", "staying", "anchor", "anchors", "anchored", "settle", "settled", "steady", "stable", "grounded", "still", "remain", "remains", "remained", "stuck", "rooted"],
  link: ["together", "connect", "connected", "connection", "connections", "chain", "bond", "bonds", "bonded", "tied", "tie", "ties", "link", "links", "linked", "attached", "union", "united", "unite", "join", "joined", "joining", "partner", "partners", "team", "teams", "us"],
  target: ["aim", "aiming", "aimed", "target", "targets", "focus", "focused", "focusing", "hunt", "hunting", "hunted", "hunter", "bullseye", "shoot", "shooting", "shot", "arrow", "arrows", "sniper", "scope", "precision"],
  bulb: ["idea", "ideas", "think", "thinks", "thinking", "thought", "thoughts", "bright", "brighter", "light", "lights", "lamp", "lamps", "lantern", "lanterns", "glow", "glowing", "shine", "shining", "genius", "clever", "smart", "brilliant", "mind", "minds", "brain", "brains", "realize", "realized", "understand", "understood", "lightbulb"],
  dumbbell: ["strong", "stronger", "strongest", "strength", "gym", "muscle", "muscles", "workout", "training", "train-hard", "tough", "tougher", "power-lift", "weights", "heavy", "heavier", "fight", "fighting", "fought", "fighter", "fighters", "warrior", "warriors", "soldier", "soldiers", "battle", "battles"],
  shield: ["safe", "safety", "safer", "protect", "protects", "protected", "protection", "shield", "shields", "guard", "guards", "guarding", "defend", "defense", "defence", "armor", "armour", "shelter", "sheltered", "secure", "security", "fortress", "castle", "castles", "wall", "walls"],
  heal: ["heal", "heals", "healing", "healed", "doctor", "doctors", "medicine", "hospital", "hospitals", "sick", "sickness", "pain", "pains", "painful", "ache", "aches", "aching", "wound", "wounds", "wounded", "scar", "scars", "scarred", "bleed", "bleeding", "bled", "nurse", "cure", "remedy", "recover", "recovery", "survive", "survived", "survivor", "breathe", "breathing", "breath"],
  boom: ["boom", "bang", "explode", "explodes", "explosion", "exploding", "exploded", "blow", "blows", "blew", "dynamite", "bomb", "bombs", "crash", "crashing", "crashed", "burst", "bursting", "pop", "pops", "shatter", "shattered", "smash", "smashed", "break", "breaks", "breaking", "broke-down", "wreck", "wrecked", "wrecking", "collapse"],
  magic: ["magic", "magical", "spell", "spells", "wand", "sparkle", "sparkles", "sparkling", "glitter", "glittering", "shimmer", "shimmering", "miracle", "miracles", "wonderland", "fairy", "fairies", "fairytale", "enchanted", "charm", "charmed", "charming", "wizard", "witch", "twinkle", "twinkling", "dazzle", "dazzling", "gleam", "gleaming"],
  paw: ["cat", "cats", "kitty", "kitten", "kittens", "dog", "dogs", "puppy", "puppies", "pet", "pets", "wolf", "wolves", "lion", "lions", "tiger", "tigers", "bear", "bears", "fox", "foxes", "paw", "paws", "bark", "barking", "purr", "purring", "meow", "howl", "howling", "animal", "animals", "beast", "beasts", "panther", "leopard", "jaguar", "cheetah"],
  balloon: ["balloon", "balloons", "float", "floats", "floating", "floated", "weightless", "drift", "drifting", "drifted", "hover", "hovering", "levitate", "airborne", "bubble", "bubbles", "lighter", "lightweight"],
  party: ["party", "parties", "partying", "celebrate", "celebrates", "celebrating", "celebrated", "celebration", "celebrations", "club", "clubs", "clubbing", "confetti", "fiesta", "carnival", "festival", "festivals", "rave", "raves", "disco", "turnt", "turn-up", "bash", "shindig"],
  speaker: ["bass-drop", "subwoofer", "boombox", "amp", "amplifier", "blast-it", "pump", "pumping", "thump", "thumping", "bump", "bumping", "speaker", "boost", "boosted", "crank", "cranked", "blare", "blaring", "roar", "roaring", "echo", "echoes", "echoing"],
  signal: ["signal", "signals", "wifi", "online", "internet", "web", "download", "downloads", "upload", "stream", "streaming", "streamed", "broadcast", "broadcasting", "frequency", "frequencies", "antenna", "satellite", "satellites", "transmission", "transmit", "offline", "network", "networks", "static", "radar", "bluetooth", "connection-lost"],
  scissors: ["cut", "cuts", "cutting", "scissors", "snip", "snipped", "trim", "trimmed", "slice", "sliced", "slicing", "sever", "severed", "split", "splits", "splitting", "divide", "divided", "haircut", "barber", "barbershop"],
  send: ["send", "sends", "sending", "sent", "deliver", "delivered", "delivery", "ship-it", "dispatch", "forward-it", "submit", "submitted", "post", "posted", "posting", "tweet", "tweeted", "dm", "dms", "reply", "replied", "replying", "respond", "responded", "response", "answer", "answers", "answered", "answering", "share", "shared", "sharing"],
  mirror: ["mirror", "mirrors", "reflection", "reflections", "reflect", "reflecting", "reflected", "vanity", "makeup", "mascara", "lipstick", "eyeliner", "pretty", "prettier", "prettiest", "beautiful", "beauty", "gorgeous", "handsome", "stunning", "flawless", "fabulous", "lovely", "cute", "cuter", "cutest", "fine-looking", "looks-good"],
  halo: ["heaven", "heavens", "heavenly", "angel", "angels", "angelic", "holy", "bless", "blessed", "blessing", "blessings", "pray", "prays", "prayer", "prayers", "praying", "prayed", "god", "gods", "goddess", "lord", "jesus", "church", "churches", "faith", "faithful", "soul", "souls", "divine", "sacred", "saint", "saints", "amen", "hallelujah", "halo", "halos", "paradise", "grace", "graceful", "mercy", "miracle-worker", "worship", "worshipping", "cathedral", "chapel", "temple", "mosque", "sanctuary"],
  lips: ["lips", "lip", "mouth", "mouths", "kiss", "kisses", "kissing", "kissed", "smooch", "pucker", "lipstick-kiss", "taste", "tasted", "tasting", "tongue", "tongues", "bite", "bites", "biting", "bit", "sip", "sips", "sipping", "sipped", "swallow", "swallowed", "breathless", "pout", "pouting", "red-lips", "cherry", "cherries", "strawberry", "strawberries", "kissable"],
};

/** The words that carry glyph `id`. */
export function glyphWords(id: GlyphId): readonly string[] {
  return GLYPH_WORDS[id];
}

let lexicon: Map<string, GlyphId> | null = null;

/** Every listed word, as sung words are normalized; a word listed twice keeps its first glyph. */
function lexiconOf(): Map<string, GlyphId> {
  if (lexicon) return lexicon;
  const map = new Map<string, GlyphId>();
  for (const id of GLYPH_IDS) for (const word of GLYPH_WORDS[id]) if (!map.has(word)) map.set(word, id);
  lexicon = map;
  return map;
}

/** The glyph a sung token carries, if any (a plural counts as its singular). */
export function glyphOfToken(text: string): GlyphId | undefined {
  const map = lexiconOf();
  return map.get(text) ?? (text.length > 3 && text.endsWith("s") ? map.get(text.slice(0, -1)) : undefined);
}

/** A glyph a line's word carries. */
export interface GlyphMatch {
  word: number;
  id: GlyphId;
}

/** Every word of `line` that carries a glyph, in order, each once (its first token's). */
export function glyphsIn(line: Pick<Line, "words">): GlyphMatch[] {
  const out: GlyphMatch[] = [];
  let last = -1;
  for (const token of tokensOf(line) as Token[]) {
    if (token.word === last) continue;
    const id = glyphOfToken(token.text);
    if (!id) continue;
    out.push({ word: token.word, id });
    last = token.word;
  }
  return out;
}

/** The glyphs of a song, by line index then word index; lines with none are left out. */
export function planGlyphs(lines: readonly Line[]): Map<number, Map<number, GlyphId>> {
  const plan = new Map<number, Map<number, GlyphId>>();
  lines.forEach((line, index) => {
    const found = glyphsIn(line);
    if (found.length > 0) plan.set(index, new Map(found.map((g) => [g.word, g.id])));
  });
  return plan;
}
