import "@fontsource/fraunces/700.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/syne/800.css";
import "@fontsource/unbounded/700.css";
import "@fontsource/bricolage-grotesque/700.css";
import "@fontsource/caveat/600.css";
import "@fontsource/jetbrains-mono/600.css";

import { FONTS, type FontChoice } from "../core/faces";

/**
 * The faces' catalog lives in core/faces.ts, pure, so the look picker reads it without loading a
 * font. This module adds what needs the DOM: the bundled font files (the imports above) and loading.
 */
export { cjkLang, FONTS, fontFor, stackFor, type CjkLang, type FontChoice } from "../core/faces";

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
