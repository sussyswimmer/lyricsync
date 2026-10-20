/**
 * Bloom: a glow in the highlight color, drawn once as the text-shadow of a copy of the text with no
 * fill of its own (a tight core halo, a softer middle, a wide soft bloom), whose opacity is then
 * animated. Animating opacity never re-rasters it; animating the shadow itself would, every frame.
 *
 * Its strength b (params.ts bloomOf: the song's glow times the Glow setting's gain) runs 0..1.3 and
 * never switches it off: at Glow 0 it is a faint core and a faint halo.
 */
import { accentFor } from "../../core/palette";
import { put } from "../dom";
import { DEFAULT_PICK, rgba, textShadow, type Look } from "../look";
import { num } from "./keyframes";
import { bloomOf, DOTS } from "./params";

const clamp = (x: number, lo: number, hi: number): number => (x <= lo ? lo : x >= hi ? hi : x);

/** The three layers at strength `b`: blur in em, alpha. */
export function bloomLayers(b: number, strong = false): [blur: number, alpha: number][] {
  const g = clamp(Number.isFinite(b) ? b : 0, 0, 1.3);
  const layers: [number, number][] = [
    [0.05 + 0.02 * g, Math.min(1, 0.6 + 0.4 * g)],
    [0.15 + 0.08 * g, Math.min(1, 0.3 + 0.45 * g)],
    [0.26 + 0.26 * g, Math.min(1, 0.16 + 0.36 * g)],
  ];
  return strong ? layers.map(([blur, alpha]) => [blur * 1.3, Math.min(1, alpha * 1.25)]) : layers;
}

/**
 * The bloom around a word (CSS text-shadow), in em so it follows each row's size. `strong` is the
 * letter-by-letter bloom of a held syllable: wider and brighter.
 */
export function bloomShadow(highlight: string, b: number, strong = false): string {
  return bloomLayers(b, strong)
    .map(([blur, alpha]) => `0 0 ${num(blur, 3)}em ${rgba(highlight, alpha)}`)
    .join(", ");
}

/** An interlude dot's halo (box-shadow) at strength `b`, for dots `dotPx` across. */
export function dotBloom(highlight: string, b: number, dotPx: number): string {
  const g = clamp(Number.isFinite(b) ? b : 0, 0, 1.3);
  const d = Math.max(1, dotPx);
  const layers: [blur: number, alpha: number][] = [
    [d * (0.25 + 0.1 * g), Math.min(1, 0.6 + 0.4 * g)],
    [d * (0.6 + 0.3 * g), Math.min(1, 0.3 + 0.45 * g)],
    [d * (1.1 + 0.8 * g), Math.min(1, 0.16 + 0.36 * g)],
  ];
  return layers.map(([blur, alpha]) => `0 0 ${blur.toFixed(1)}px ${rgba(highlight, alpha)}`).join(", ");
}

/**
 * The karaoke's CSS variables on a row or box (stage.css reads them): the lyric, highlight and dim
 * colors, the color the sung words blend into (`--ut-hl2`: the cover's second color, or one next to
 * the highlight), the dark legibility shadow for text `sizePx` tall (`--ut-dark`, drawn by the unclipped
 * dark copy), the word bloom, a held letter's stronger bloom, and the dots' halo.
 */
export function paintVars(el: HTMLElement, look: Look, sizePx: number): void {
  const { lyric, highlight, dim } = look.colors;
  // a spread copy of a look has lost its (non-enumerable) bloom: the house glow at the look's Glow
  const b = Number.isFinite(look.bloom) ? look.bloom : bloomOf(DEFAULT_PICK.glow, look.glow * 100);
  put(el, "--ut-lyric", lyric);
  put(el, "--ut-hl", highlight);
  put(el, "--ut-hl2", look.colors.accent ?? accentFor(highlight));
  put(el, "--ut-dim", dim);
  put(el, "--ut-dark", textShadow(look, sizePx));
  put(el, "--ut-bloom", bloomShadow(highlight, b));
  put(el, "--ut-bloom-strong", bloomShadow(highlight, b, true));
  put(el, "--ut-dot-bloom", dotBloom(highlight, b, DOTS.em * sizePx));
}
