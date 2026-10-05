import type { Settings } from "../../contract/contract";
import type { Palette } from "../core/palette";
import { fontFor } from "./fonts";

/** `Settings.size` is in px on a display this many CSS px tall; lyrics scale with the stage height. */
export const REFERENCE_HEIGHT = 1080;
/** Secondary text (neighbor lines, far words) stays at least this many px tall where the mode can manage it. */
export const MIN_TEXT_PX = 11;

/** Everything a mode needs to draw, resolved to concrete px and colors for the current stage. */
export interface Look {
  colors: Palette;
  font: string;
  weight: number;
  /** font size of the current line, px */
  size: number;
  /** vertical center of the current line, px from the top */
  y: number;
  width: number;
  height: number;
  /** arc bend, -1..1 */
  curve: number;
  /** 0..1 */
  glow: number;
  /** 0.2..1 */
  opacity: number;
  /** false under prefers-reduced-motion: no drift, no lens, crossfades only */
  motion: boolean;
  /** plain lyrics paced evenly: no word highlight */
  unsynced: boolean;
  dpr: number;
}

export interface Frame {
  width: number;
  height: number;
  dpr: number;
  motion: boolean;
  unsynced: boolean;
  /** stage height that counts as 1× (default 1080) */
  referenceHeight?: number;
}

export function resolveLook(settings: Settings, palette: Palette | null, frame: Frame): Look {
  const font = fontFor(settings.font.family);
  const scale = frame.height / (frame.referenceHeight ?? REFERENCE_HEIGHT);
  const size = Math.max(1, settings.size * scale);
  // Height runs 0–100, but the focus line always stays whole on screen.
  const margin = Math.min(size * 0.75, frame.height / 2);
  return {
    colors: settings.autoColor && palette ? palette : settings.colors,
    font: font.stack,
    weight: settings.font.weight || font.weight,
    size,
    y: Math.min(frame.height - margin, Math.max(margin, (frame.height * settings.yPos) / 100)),
    width: frame.width,
    height: frame.height,
    curve: settings.curve / 100,
    glow: settings.glow / 100,
    opacity: settings.opacity / 100,
    motion: frame.motion,
    unsynced: frame.unsynced,
    dpr: frame.dpr,
  };
}

export function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha.toFixed(3)})`;
}

const px = (v: number): string => `${Math.max(0, v).toFixed(1)}px`;

/** Below this text size the dark shadow gets darker, up to fully at SMALL_TEXT_PX - SMALL_TEXT_RAMP_PX. */
const SMALL_TEXT_PX = 32;
const SMALL_TEXT_RAMP_PX = 16;

/**
 * Shadow layers for text of `size` px: the soft dark shadow every lyric carries so light text reads
 * on light wallpapers (subtle at glow 0, softer and wider as glow rises), plus a highlight-colored
 * halo for the active word.
 *
 * The dark layers scale with the text, but never below a pixel floor, and get a little darker under
 * SMALL_TEXT_PX: small dim lines (Arc's neighbors, Lens's next line) on a busy wallpaper are told
 * apart from it only by that halo, which would otherwise shrink to nothing.
 */
export function shadowLayers(look: Look, size: number, active: boolean): [x: string, y: string, blur: string, color: string][] {
  const k = size / 58;
  const g = look.glow;
  const small = Math.min(1, Math.max(0, (SMALL_TEXT_PX - size) / SMALL_TEXT_RAMP_PX));
  const layers: [string, string, string, string][] = [
    ["0px", px(Math.max(1 * k, 1)), px(Math.max((2 + 2 * g) * k, 1.5)), `rgba(0, 0, 0, ${(0.4 + 0.15 * g + 0.2 * small).toFixed(3)})`],
    ["0px", "0px", px(Math.max((8 + 14 * g) * k, 4)), `rgba(0, 0, 0, ${(0.16 + 0.2 * g + 0.04 * small).toFixed(3)})`],
  ];
  if (active && g > 0) layers.push(["0px", "0px", px((6 + 24 * g) * k), rgba(look.colors.highlight, 0.35 + 0.5 * g)]);
  return layers;
}

/** CSS `text-shadow` for HTML text. */
export function textShadow(look: Look, size: number, active = false): string {
  return shadowLayers(look, size, active)
    .map((l) => l.join(" "))
    .join(", ");
}

/** CSS `filter` equivalent for SVG text, which ignores text-shadow in some engines. */
export function dropShadow(look: Look, size: number, active = false): string {
  return shadowLayers(look, size, active)
    .map(([x, y, blur, color]) => `drop-shadow(${x} ${y} ${blur} ${color})`)
    .join(" ");
}

/** Rounds to the device pixel grid so text under transforms stays crisp. */
export function snap(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr;
}
