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
  stack: string;
  weight: number;
}

const SANS_TAIL = `system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans", "Yu Gothic", "Microsoft YaHei", "Malgun Gothic", sans-serif`;
const SERIF_TAIL = `Georgia, "Hiragino Mincho ProN", "Yu Mincho", "Songti SC", "SimSun", serif`;

export const FONTS: readonly FontChoice[] = [
  { family: "Fraunces", label: "Fraunces", stack: `"Fraunces", ${SERIF_TAIL}`, weight: 700 },
  { family: "Instrument Serif", label: "Instrument Serif", stack: `"Instrument Serif", ${SERIF_TAIL}`, weight: 400 },
  { family: "Syne", label: "Syne", stack: `"Syne", ${SANS_TAIL}`, weight: 800 },
  { family: "Unbounded", label: "Unbounded", stack: `"Unbounded", ${SANS_TAIL}`, weight: 700 },
  { family: "Bricolage Grotesque", label: "Bricolage", stack: `"Bricolage Grotesque", ${SANS_TAIL}`, weight: 700 },
  { family: "Caveat", label: "Caveat", stack: `"Caveat", "Comic Sans MS", ${SANS_TAIL}`, weight: 600 },
  { family: "JetBrains Mono", label: "JetBrains Mono", stack: `"JetBrains Mono", ui-monospace, Menlo, Consolas, ${SANS_TAIL}`, weight: 600 },
  { family: "System", label: "System", stack: SANS_TAIL, weight: 700 },
];

/** The choice for a settings family name; unknown names fall back to the default face. */
export function fontFor(family: string): FontChoice {
  return FONTS.find((f) => f.family === family) ?? (FONTS[0] as FontChoice);
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
 * Null when the lyric face of `stack` is in for every character of `text`; otherwise a promise that
 * settles once it has loaded. Asks about the bundled family alone, at one size, for each distinct
 * character: `FontFaceSet.check` looks every family of a stack up for every character it is given (in
 * Blink a platform font lookup per family and character, uncached), so the whole song against the
 * whole fallback stack cost tens to hundreds of ms per build, seconds on long lyrics. Only the bundled
 * family has faces to load (the rest are platform or generic fonts), and size doesn't change which
 * subsets a text needs. The system stack has nothing to load.
 */
export function whenFaceLoads(stack: string, weight: number, text: string): Promise<unknown> | null {
  const fonts = typeof document !== "undefined" ? document.fonts : undefined;
  const family = FONTS.find((f) => f.stack === stack && f.family !== "System")?.family;
  if (!fonts || !family) return null;
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
