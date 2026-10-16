import "@fontsource/fraunces/700.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/syne/800.css";
import "@fontsource/unbounded/700.css";
import "@fontsource/bricolage-grotesque/700.css";
import "@fontsource/caveat/600.css";
import "@fontsource/jetbrains-mono/600.css";

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
  /** has Vietnamese accented letters; without them those come from a fallback face (Settings says so) */
  vietnamese: boolean;
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

const face = (
  family: string,
  label: string,
  weight: number,
  serif: boolean,
  vietnamese: boolean,
  latin = "",
): FontChoice => {
  const spec = { family, label, weight, serif, vietnamese, latin };
  return { ...spec, stack: stackFor(spec, null) };
};

export const FONTS: readonly FontChoice[] = [
  face("Fraunces", "Fraunces", 700, true, true),
  face("Instrument Serif", "Instrument Serif", 400, true, false),
  face("Syne", "Syne", 800, false, false),
  face("Unbounded", "Unbounded", 700, false, true),
  face("Bricolage Grotesque", "Bricolage", 700, false, true),
  face("Caveat", "Caveat", 600, false, false, `"Comic Sans MS"`),
  face("JetBrains Mono", "JetBrains Mono", 600, false, true, "ui-monospace, Menlo, Consolas"),
  face("System", "System", 700, false, true),
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

/** Resolves once the face is ready to measure (no-op for the system stack or without a DOM). */
export async function loadFont(font: FontChoice, weight = font.weight): Promise<void> {
  if (font.family === "System" || typeof document === "undefined" || !("fonts" in document)) return;
  try {
    await document.fonts.load(`${weight} 64px "${font.family}"`);
  } catch {
    // a failed load just leaves the fallback face in place
  }
}

/** Faces (family, weight, characters) found loaded: a rebuild with the same face and lyrics never asks again. */
const facesReady = new Set<string>();
const FACES_READY_MAX = 256;

/**
 * Null when the bundled face `family` is in for every character of `text`; otherwise a promise that
 * settles once it has loaded. Asks about the bundled family alone, at one size, for each distinct
 * character: `FontFaceSet.check` looks every family of a stack up for every character it is given (in
 * Blink a platform font lookup per family and character, uncached), so the whole song against the
 * whole fallback stack cost tens to hundreds of ms per build, seconds on long lyrics. Only the bundled
 * family has faces to load (the rest are platform or generic fonts), and size doesn't change which
 * subsets a text needs. The system stack has nothing to load.
 */
export function whenFaceLoads(family: string, weight: number, text: string): Promise<unknown> | null {
  const fonts = typeof document !== "undefined" ? document.fonts : undefined;
  if (!fonts || family === "System" || !FONTS.some((f) => f.family === family)) return null;
  const chars = [...new Set(text)].join("") || " ";
  const key = `${family}/${weight}/${chars}`;
  if (facesReady.has(key)) return null;
  const spec = `${weight} 16px "${family}"`;
  try {
    if (fonts.check(spec, chars)) {
      if (facesReady.size >= FACES_READY_MAX) facesReady.clear();
      facesReady.add(key);
      return null;
    }
    return fonts.load(spec, chars);
  } catch {
    return null;
  }
}
