/**
 * Bloom: a glow in the highlight color, drawn once as the text-shadow of a copy of the text with no
 * fill of its own (a tight core halo, a softer middle, a wide soft bloom), whose opacity is then
 * animated. Animating opacity never re-rasters it; animating the shadow itself would, every frame.
 */
import { rgba } from "../look";

/**
 * The bloom around a word, in em so it follows each row's size. `glow` is Settings.glow (0..1): at 0
 * there is none, as there is no highlight halo in the other styles; from there it starts soft and
 * grows. `strong` is the letter-by-letter bloom of a held word: brighter and wider.
 */
export function bloomShadow(highlight: string, glow: number, strong = false): string {
  const g = Math.max(0, Math.min(1, glow));
  if (!(g > 0)) return "none";
  const k = 0.35 + 0.65 * g;
  const layers: [number, number][] = strong
    ? [
        [0.07, Math.min(1, 1.45 * k)],
        [0.24, Math.min(1, 1.1 * k)],
        [0.62, 0.78 * k],
      ]
    : [
        [0.05, Math.min(1, 1.15 * k)],
        [0.18, 0.82 * k],
        [0.46, 0.56 * k],
      ];
  return layers.map(([blur, alpha]) => `0 0 ${blur}em ${rgba(highlight, alpha)}`).join(", ");
}

/** Interlude dots' halo (box-shadow), px; none at Glow 0 (a lit dot still turns the highlight color). */
export function dotBloom(highlight: string, glow: number, dotPx: number): string {
  const g = Math.max(0, Math.min(1, glow));
  if (!(g > 0)) return "none";
  const k = 0.4 + 0.6 * g;
  return [
    `0 0 ${(dotPx * 0.3).toFixed(1)}px ${rgba(highlight, Math.min(1, 1.3 * k))}`,
    `0 0 ${(dotPx * 0.8).toFixed(1)}px ${rgba(highlight, 0.8 * k)}`,
    `0 0 ${(dotPx * 1.7).toFixed(1)}px ${rgba(highlight, 0.45 * k)}`,
  ].join(", ");
}
