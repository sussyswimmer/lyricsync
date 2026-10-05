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
