/**
 * The lyric faces Undertone bundles, as pure data: which letters each one has, its fallback stacks,
 * and the song's CJK language. No DOM and no font files here: `src/overlay/fonts.ts` imports the
 * `@fontsource` CSS, loads the faces and re-exports this catalog, so the look picker
 * (`core/songlook.ts`) and the tests can read it without loading any font.
 */

/** A lyric face: bundled locally (OFL), with fallbacks that cover CJK and other scripts. */
export interface FontChoice {
  family: string;
  label: string;
  /** the face and its fallbacks, CJK families in their default order (see stackFor) */
  stack: string;
  weight: number;
  /** Latin fallbacks between the face and the system ones */
  latin: string;
  /** serif faces fall back to serif system and CJK faces (Mincho, Song, Myeongjo), the rest to sans ones */
  serif: boolean;
  /**
   * The face draws these letters itself: its Fontsource package ships that subset at the bundled
   * weight. Without them a fallback face draws those letters, so the look picker never gives such a
   * face a song written in them.
   */
  vietnamese: boolean;
  cyrillic: boolean;
  greek: boolean;
}

/** The language a song's Chinese, Japanese or Korean text is set in, picked once per song (cjkLang). */
export type CjkLang = "ja" | "ko" | "zh-Hans" | "zh-Hant";

/**
 * Each language's own CJK families, macOS first, then Windows. CSS takes the first family in a stack
 * that has a glyph, character by character, and Japanese and Chinese fonts both cover the Han
 * characters the languages share, each in its own forms: with the song's language first, a line never
 * mixes Japanese and Chinese faces, nor sets Japanese in a Chinese one.
 */
const CJK: Record<CjkLang, { serif: readonly string[]; sans: readonly string[] }> = {
  ja: { serif: ["Hiragino Mincho ProN", "Yu Mincho"], sans: ["Hiragino Sans", "Yu Gothic", "Meiryo"] },
  "zh-Hans": { serif: ["Songti SC", "SimSun"], sans: ["PingFang SC", "Microsoft YaHei"] },
  "zh-Hant": { serif: ["Songti TC", "PMingLiU"], sans: ["PingFang TC", "Microsoft JhengHei"] },
  ko: { serif: ["AppleMyungjo", "Batang"], sans: ["Apple SD Gothic Neo", "Malgun Gothic"] },
};
/** The order of the other languages' families, after the song's own (all of them, for a song without CJK). */
const CJK_ORDER: readonly CjkLang[] = ["ja", "zh-Hans", "zh-Hant", "ko"];

/**
 * A face's full stack with a song's CJK language first: the bundled face, its Latin fallbacks, the
 * system's, the song's CJK families, the other languages' CJK families, then the generic family.
 */
export function stackFor(font: Pick<FontChoice, "family" | "latin" | "serif">, lang: CjkLang | null): string {
  const kind = font.serif ? "serif" : "sans";
  const cjk = [...(lang ? [lang] : []), ...CJK_ORDER.filter((l) => l !== lang)].flatMap((l) => CJK[l][kind]);
  return [
    ...(font.family === "System" ? [] : [`"${font.family}"`]),
    ...(font.latin ? [font.latin] : []),
    ...(font.serif ? ["Georgia"] : ["system-ui", "-apple-system", `"Segoe UI"`]),
    ...cjk.map((f) => `"${f}"`),
    font.serif ? "serif" : "sans-serif",
  ].join(", ");
}

/** The scripts beyond Latin a face has letters for. */
type Coverage = Partial<Pick<FontChoice, "vietnamese" | "cyrillic" | "greek">>;

const face = (family: string, label: string, weight: number, serif: boolean, covers: Coverage, latin = ""): FontChoice => {
  const spec = {
    family,
    label,
    weight,
    serif,
    vietnamese: covers.vietnamese === true,
    cyrillic: covers.cyrillic === true,
    greek: covers.greek === true,
    latin,
  };
  return { ...spec, stack: stackFor(spec, null) };
};

/** Every bundled face at its one bundled weight. The system stack has every script the OS has. */
export const FONTS: readonly FontChoice[] = [
  face("Fraunces", "Fraunces", 700, true, { vietnamese: true }),
  face("Instrument Serif", "Instrument Serif", 400, true, {}),
  face("Syne", "Syne", 800, false, { greek: true }),
  face("Unbounded", "Unbounded", 700, false, { vietnamese: true, cyrillic: true }),
  face("Bricolage Grotesque", "Bricolage", 700, false, { vietnamese: true }),
  face("Caveat", "Caveat", 600, false, { cyrillic: true }, `"Comic Sans MS"`),
  face("JetBrains Mono", "JetBrains Mono", 600, false, { vietnamese: true, cyrillic: true, greek: true }, "ui-monospace, Menlo, Consolas"),
  face("Anton", "Anton", 400, false, { vietnamese: true }, `Impact, "Arial Narrow"`),
  face("Playfair Display", "Playfair", 700, true, { vietnamese: true, cyrillic: true }, `Didot, "Bodoni MT"`),
  face("Space Grotesk", "Space Grotesk", 700, false, { vietnamese: true }),
  face("Righteous", "Righteous", 400, false, {}),
  face("Pacifico", "Pacifico", 400, false, { vietnamese: true, cyrillic: true }, `"Brush Script MT"`),
  face("Rubik", "Rubik", 700, false, { cyrillic: true }),
  face("Pirata One", "Pirata One", 400, false, {}, `"Old English Text MT"`),
  face("Archivo Black", "Archivo Black", 400, false, {}, `"Arial Black"`),
  face("Bebas Neue", "Bebas Neue", 400, false, {}, `Impact, "Arial Narrow"`),
  face("Oswald", "Oswald", 700, false, { vietnamese: true, cyrillic: true }, `"Arial Narrow"`),
  face("DM Serif Display", "DM Serif", 400, true, {}),
  face("Abril Fatface", "Abril Fatface", 400, true, {}, `Didot, "Bodoni MT"`),
  face("Sedgwick Ave Display", "Sedgwick Ave", 400, false, { vietnamese: true }, `"Marker Felt"`),
  face("Bungee", "Bungee", 400, false, { vietnamese: true }, "Impact"),
  face("Silkscreen", "Silkscreen", 700, false, {}, "ui-monospace, Menlo, Consolas"),
  face("Bodoni Moda", "Bodoni Moda", 700, true, {}, `Didot, "Bodoni MT"`),
  face("Shrikhand", "Shrikhand", 400, false, {}, `"Cooper Black"`),
  face("Chakra Petch", "Chakra Petch", 700, false, { vietnamese: true }),
  face("Lilita One", "Lilita One", 400, false, {}, `"Arial Rounded MT Bold"`),
  face("System", "System", 700, false, { vietnamese: true, cyrillic: true, greek: true }),
];

/** The choice for a settings family name; unknown names fall back to the default face. */
export function fontFor(family: string): FontChoice {
  return FONTS.find((f) => f.family === family) ?? (FONTS[0] as FontChoice);
}

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const HANGUL = /\p{Script=Hangul}/gu;
const HAN = /\p{Script=Han}/gu;
/** Frequent characters only Simplified, or only Traditional, Chinese writes, pair by pair. */
const SIMPLIFIED = "们这个来时说为会对过还没发样么爱梦听让见远风话边开长无记忆东给当间场声";
const TRADITIONAL = "們這個來時說為會對過還沒發樣麼愛夢聽讓見遠風話邊開長無記憶東給當間場聲";

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;
const countOf = (text: string, chars: string): number => [...text].filter((c) => chars.includes(c)).length;

function preferredLanguages(): readonly string[] {
  return typeof navigator !== "undefined" && Array.isArray(navigator.languages) ? navigator.languages : [];
}

/**
 * The language to set a song's lyrics in: Japanese when it has kana, else Korean when it has Hangul,
 * else Chinese when it has Han characters, null with none of them. Kana win over Hangul: Korean faces
 * carry kana and Han characters, so they would take a Japanese line, while Japanese faces have no
 * Hangul to take from a Korean one. A few kana or Hangul among many Han characters (の for 的 in a
 * Chinese line) don't count. Chinese is Traditional or Simplified by the characters only one of them
 * writes, or, when the text doesn't tell, by the reader's first language.
 */
export function cjkLang(text: string, languages: readonly string[] = preferredLanguages()): CjkLang | null {
  const han = count(text, HAN);
  const kana = count(text, KANA);
  const hangul = count(text, HANGUL);
  const counts = (n: number): boolean => n > 0 && n * 20 >= han;
  if (counts(kana)) return "ja";
  if (counts(hangul)) return "ko";
  if (han === 0) return null;
  const simplified = countOf(text, SIMPLIFIED);
  const traditional = countOf(text, TRADITIONAL);
  if (simplified !== traditional) return traditional > simplified ? "zh-Hant" : "zh-Hans";
  return /^zh-(?:tw|hk|mo|hant)\b/iu.test(languages[0] ?? "") ? "zh-Hant" : "zh-Hans";
}
