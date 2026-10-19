import type { Mode, Settings } from "../../contract/contract";
import { isMove, isSplash, PLAIN_FLAIR, saneFlair, type Flair } from "../core/flair";
import type { Palette } from "../core/palette";
import { FONTS, fontFor, stackFor, type CjkLang } from "./fonts";
import type { TextCase } from "./motion/letters";
import { bloomOf, type EmphasisRule } from "./motion/params";
import type { Power } from "./motion/power";

/** `Settings.size` is in px on a display this many CSS px tall; lyrics scale with the stage height. */
export const REFERENCE_HEIGHT = 1080;
/** Secondary text (neighbor lines, far words) stays at least this many px tall where the mode can manage it. */
export const MIN_TEXT_PX = 11;

/**
 * The look Undertone picks for a song (SPEC §4): the style, the face and the motion's character. The
 * user's settings scale it (Size, Effects, Glow) but don't choose it.
 */
export interface PickedLook {
  style: Mode;
  font: { family: string; weight: number };
  /** -100..100, Arc only */
  curve: number;
  /** 0..1: how much words move */
  energy: number;
  /** 0..1: how quickly their springs settle */
  snap: number;
  /** 0..1: the song's bloom strength G (Settings.glow scales it) */
  glow: number;
  /** held notes; null: plain lyrics, no emphasis */
  emphasis: EmphasisRule | null;
  /** multiplies Settings.size, 0.82..1.2 */
  scale: number;
  /** em */
  letterSpacing: number;
  textCase: "as-is" | "upper";
  /** Effects mode's flair: how the words move, and the splash (core/flair.ts) */
  flair: Flair;
}

/** The house look, for a song nothing is known about yet (SPEC §2.2). */
export const DEFAULT_PICK: PickedLook = Object.freeze({
  style: "arc" as const,
  font: Object.freeze({ family: "Fraunces", weight: 700 }),
  curve: 38,
  energy: 0.45,
  snap: 0.4,
  glow: 0.6,
  emphasis: Object.freeze({ minMs: 1000, maxChars: 12, lastWordOnly: false }),
  scale: 1,
  letterSpacing: 0,
  textCase: "as-is" as const,
  flair: PLAIN_FLAIR,
});

/** Everything a mode needs to draw, resolved to concrete px and colors for the current stage. */
export interface Look {
  colors: Palette;
  /** the CSS font stack, with the song's CJK families first */
  font: string;
  /** the face's family (FontChoice.family), the one there is to wait for (see whenFaceLoads) */
  family: string;
  weight: number;
  /** font size of the current line, px (Settings.size, scaled to the stage and by the look's scale) */
  size: number;
  /** vertical center of the current line, px from the top: always the middle of the stage */
  y: number;
  width: number;
  height: number;
  /** arc bend, -1..1 (the picked curve) */
  curve: number;
  /** Settings.glow, 0..1: softens and widens the dark legibility shadow (shadowLayers) */
  glow: number;
  /** 0.2..1 */
  opacity: number;
  /** false under prefers-reduced-motion: no drift, no lens, crossfades only */
  motion: boolean;
  /** plain lyrics paced evenly: no word highlight */
  unsynced: boolean;
  dpr: number;
  /** the style to draw with (the picked one) */
  style: Mode;
  /** the song's motion character, for motionParams */
  energy: number;
  snap: number;
  /** Settings.effects, 0..100 (effectsOf) */
  effects: number;
  /**
   * The bloom's strength b, 0..1.3 (bloomOf: the song's glow by Settings.glow). Not enumerable on a
   * resolved look: it changes with Glow, which only restyles, and code that keys a look's layout on its
   * enumerable fields (`JSON.stringify`, a rest spread) must not see a Glow drag as a new layout. A
   * spread copy loses it; paintVars then falls back to the house glow.
   */
  bloom: number;
  emphasis: EmphasisRule | null;
  /** "lite": software compositing, the reduced-motion karaoke */
  power: Power;
  /** em */
  letterSpacing: number;
  textCase: TextCase;
  /** the song's flair (PickedLook.flair) */
  flair: Flair;
  /**
   * Settings.effectsMode (effectsModeOf): the song's flair, splashes and word pictures. Off, every word
   * rises and nothing else is added.
   */
  effectsMode: boolean;
}

export interface Frame {
  width: number;
  height: number;
  dpr: number;
  motion: boolean;
  unsynced: boolean;
  /** stage height that counts as 1× (default 1080) */
  referenceHeight?: number;
  /** the song's CJK language (cjkLang), whose families the font stack puts first */
  lang?: CjkLang | null;
  /** the window's power tier (detectPower); full when absent */
  power?: Power;
}

/**
 * The 1× stage height for an overlay framed to its display's work area (menu bar, Dock or taskbar left
 * out), so that Size stays relative to the whole screen: 1× is still 1080 px of screen height. The
 * share of the screen the stage covers is clamped to 0.8–1, which bounds a wrong screen report.
 */
export function workAreaReference(stageHeight: number, screenHeight: number): number {
  const share = stageHeight / screenHeight;
  return REFERENCE_HEIGHT * (Number.isFinite(share) && share > 0 ? Math.min(1, Math.max(0.8, share)) : 1);
}

const clamp = (x: number, lo: number, hi: number): number => (x <= lo ? lo : x >= hi ? hi : x);
const finiteOr = (x: unknown, fallback: number): number => (typeof x === "number" && Number.isFinite(x) ? x : fallback);

export const MODES: readonly Mode[] = ["arc", "lens", "drift", "stack"];

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

/**
 * Settings.effects (contract v4), 0..100: how much lyrics move as they're sung. A store from before
 * v4 has none, which counts as 50, the look as picked.
 */
export function effectsOf(settings: Settings): number {
  const value: unknown = "effects" in settings ? settings.effects : undefined;
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 100) : 50;
}

/**
 * Settings.effectsMode (contract v5): each song's own motion, its splashes and the tiny pictures beside
 * words. A store from before v5 has none, which counts as on.
 */
export function effectsModeOf(settings: Settings): boolean {
  const value: unknown = "effectsMode" in settings ? settings.effectsMode : undefined;
  return value !== false;
}

/**
 * Only the PickedLook fields of a look: what the stage draws with. A song's look (core/songlook's
 * SongLook) also carries why it was picked (traits, reason, scores), which no drawing depends on.
 */
export function pickedOf(look: PickedLook): PickedLook {
  const { style, font, curve, energy, snap, glow, emphasis, scale, letterSpacing, textCase, flair } = look;
  return { style, font, curve, energy, snap, glow, emphasis, scale, letterSpacing, textCase, flair };
}

/** A pick made safe to draw: a known style, every number finite and in range (an unknown face falls back in fontFor). */
export function sanePick(look: PickedLook): PickedLook {
  const emphasis = look.emphasis
    ? { minMs: Math.max(0, finiteOr(look.emphasis.minMs, 1000)), maxChars: Math.max(1, finiteOr(look.emphasis.maxChars, 12)), lastWordOnly: look.emphasis.lastWordOnly === true }
    : null;
  return {
    style: isMode(look.style) ? look.style : DEFAULT_PICK.style,
    font: { family: typeof look.font?.family === "string" ? look.font.family : DEFAULT_PICK.font.family, weight: finiteOr(look.font?.weight, 0) },
    curve: clamp(finiteOr(look.curve, DEFAULT_PICK.curve), -100, 100),
    energy: clamp(finiteOr(look.energy, DEFAULT_PICK.energy), 0, 1),
    snap: clamp(finiteOr(look.snap, DEFAULT_PICK.snap), 0, 1),
    glow: clamp(finiteOr(look.glow, DEFAULT_PICK.glow), 0, 1),
    emphasis,
    scale: clamp(finiteOr(look.scale, 1), 0.82, 1.2),
    letterSpacing: clamp(finiteOr(look.letterSpacing, 0), -0.1, 0.2),
    textCase: look.textCase === "upper" ? "upper" : "as-is",
    flair: saneFlair(look.flair),
  };
}

/**
 * The look for the stage. With a `picked` look (the stage always passes one: the song's, or
 * DEFAULT_PICK), the style, face, curve, size scale, letter-spacing, case and motion character come
 * from it. Without one, the style, face and curve are the stored Settings' (as before contract v4,
 * for callers that draw a mode directly) and the rest is DEFAULT_PICK's.
 */
export function resolveLook(settings: Settings, palette: Palette | null, frame: Frame, picked?: PickedLook | null): Look {
  const pick = sanePick(picked ?? { ...DEFAULT_PICK, style: settings.mode, font: settings.font, curve: settings.curve });
  const face = fontFor(pick.font.family);
  const scale = frame.height / (frame.referenceHeight ?? REFERENCE_HEIGHT);
  const size = Math.max(1, settings.size * scale * pick.scale);
  const look: Omit<Look, "bloom"> = {
    colors: settings.autoColor && palette ? palette : settings.colors,
    font: stackFor(face, frame.lang ?? null),
    family: face.family,
    weight: pick.font.weight || face.weight,
    size,
    // The lyrics always sit in the middle of the display's work area (Settings.yPos is not read).
    y: frame.height / 2,
    width: frame.width,
    height: frame.height,
    curve: pick.curve / 100,
    glow: settings.glow / 100,
    opacity: settings.opacity / 100,
    motion: frame.motion,
    unsynced: frame.unsynced,
    dpr: frame.dpr,
    style: pick.style,
    energy: pick.energy,
    snap: pick.snap,
    effects: effectsOf(settings),
    emphasis: pick.emphasis,
    power: frame.power ?? "full",
    letterSpacing: pick.letterSpacing,
    textCase: pick.textCase,
    flair: pick.flair,
    effectsMode: effectsModeOf(settings),
  };
  return withBloom(look, bloomOf(pick.glow, settings.glow));
}

/** `look` with its bloom strength attached, not enumerable (see Look.bloom). */
export function withBloom(look: Omit<Look, "bloom">, bloom: number): Look {
  Object.defineProperty(look, "bloom", { value: bloom, enumerable: false, writable: true, configurable: true });
  return look as Look;
}

// ---------- QA overrides (SPEC §4.10): never stored ----------

/** Forces parts of the picked look: `?look=`, `--look`, `?flair=`, the mock's `mode`/`font`/`curve`, the console. */
export interface LookOverride {
  style?: Mode;
  /** a face's family name */
  font?: string;
  /** -100..100 */
  curve?: number;
  /** parts of the song's flair (Effects mode): `?flair=move[,accent[,splash]]` */
  flair?: Partial<Flair>;
}

/** The bundled face named `name` (family or label, any case), if any. */
function faceNamed(name: string): string | null {
  const n = name.trim().toLowerCase();
  const face = FONTS.find((f) => f.family.toLowerCase() === n || f.label.toLowerCase() === n);
  return face ? face.family : null;
}

/** An override with only its valid parts (a face must be bundled, a curve finite); null when none is. */
export function cleanOverride(o: LookOverride | null | undefined): LookOverride | null {
  if (!o) return null;
  const out: LookOverride = {};
  if (isMode(o.style)) out.style = o.style;
  const face = typeof o.font === "string" ? faceNamed(o.font) : null;
  if (face) out.font = face;
  if (typeof o.curve === "number" && Number.isFinite(o.curve)) out.curve = clamp(o.curve, -100, 100);
  const flair: Partial<Flair> = {};
  if (isMove(o.flair?.move)) flair.move = o.flair.move;
  if (isMove(o.flair?.accent)) flair.accent = o.flair.accent;
  if (isSplash(o.flair?.splash)) flair.splash = o.flair.splash;
  if (Object.keys(flair).length > 0) out.flair = flair;
  return out.style !== undefined || out.font !== undefined || out.curve !== undefined || out.flair !== undefined ? out : null;
}

/** `style[,family[,curve]]` (`?look=lens`, `?look=lens,Syne`, `?look=arc,,-50`): empty parts keep the pick. */
export function parseLookOverride(value: unknown): LookOverride | null {
  if (typeof value !== "string") return null;
  const [style = "", font = "", curve = ""] = value.split(",").map((s) => s.trim());
  return cleanOverride({
    ...(style ? { style: style.toLowerCase() as Mode } : {}),
    ...(font ? { font } : {}),
    ...(curve ? { curve: Number(curve) } : {}),
  });
}

/**
 * `move[,accent[,splash]]` (`?flair=bounce`, `?flair=sway,pulse,confetti`, `?flair=,,drops`): forces
 * the song's flair for QA; empty parts keep the pick. An accent left out follows the move.
 */
export function parseFlairOverride(value: unknown): LookOverride | null {
  if (typeof value !== "string") return null;
  const [move = "", accent = "", splash = ""] = value.split(",").map((s) => s.trim().toLowerCase());
  return cleanOverride({ flair: { ...(move ? { move: move as Flair["move"] } : {}), ...(accent || move ? { accent: (accent || move) as Flair["accent"] } : {}), ...(splash ? { splash: splash as Flair["splash"] } : {}) } });
}

/** The `mode`, `font` and `curve` of a `?settings=` patch (the mock's QA tools set the look that way). */
export function overrideFromSettings(json: string | null): LookOverride | null {
  if (!json) return null;
  try {
    const patch: unknown = JSON.parse(json);
    if (typeof patch !== "object" || patch === null) return null;
    const p = patch as { mode?: unknown; font?: unknown; curve?: unknown };
    const family = typeof p.font === "object" && p.font !== null ? (p.font as { family?: unknown }).family : undefined;
    return cleanOverride({
      ...(isMode(p.mode) ? { style: p.mode } : {}),
      ...(typeof family === "string" ? { font: family } : {}),
      ...(typeof p.curve === "number" ? { curve: p.curve } : {}),
    });
  } catch {
    return null;
  }
}

/** Two overrides as one, `b`'s parts over `a`'s. */
export function mergeOverrides(a: LookOverride | null, b: LookOverride | null): LookOverride | null {
  const flair = { ...(a?.flair ?? {}), ...(b?.flair ?? {}) };
  return cleanOverride({ ...(a ?? {}), ...(b ?? {}), flair });
}

/** `look` with an override's parts in place of the pick's (a forced face at its bundled weight). */
export function withOverride(look: PickedLook, override: LookOverride | null): PickedLook {
  const o = cleanOverride(override);
  if (!o) return look;
  const face = o.font ? fontFor(o.font) : null;
  return {
    ...look,
    ...(o.style ? { style: o.style } : {}),
    ...(face ? { font: { family: face.family, weight: face.weight } } : {}),
    ...(o.curve !== undefined ? { curve: o.curve } : {}),
    ...(o.flair ? { flair: { ...look.flair, ...o.flair } } : {}),
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
