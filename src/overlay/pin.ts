import { STYLES, type PickStyle, type Style } from "../core/songlook";
import type { LookOverride } from "./look";

/**
 * The style the user pinned in Settings (Settings › Style): every song drawn in it, instead of the one
 * Undertone picks per song. Kept in the windows' shared web storage, not in `Settings`: the contract
 * hasn't named a style since v4, and the core owns that schema (docs/HANDOFF.md asks for a field). The
 * overlay windows and Settings share one origin, so a pin made in Settings reaches every overlay
 * through the `storage` event, and survives a restart.
 */
export const STYLE_PIN_KEY = "undertone.style-pin";

/** What a stored value means: a style, or null for Undertone's own pick (anything else counts as that). */
export function parseStylePin(value: unknown): PickStyle | null {
  return typeof value === "string" && (STYLES as readonly string[]).includes(value) ? (value as PickStyle) : null;
}

/** The pin as a look override for OverlayController.forceLook: only the style, the face stays the song's. */
export function pinOverride(style: Style | null): LookOverride | null {
  return style ? { style } : null;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // storage blocked: no pin, and Undertone picks
    return null;
  }
}

export function readStylePin(): PickStyle | null {
  try {
    return parseStylePin(storage()?.getItem(STYLE_PIN_KEY));
  } catch {
    return null;
  }
}

/** Pins `style` for every window, or unpins with null. The writing window gets no event: it applies the pin itself. */
export function writeStylePin(style: Style | null): void {
  try {
    const s = storage();
    if (!s) return;
    if (style) s.setItem(STYLE_PIN_KEY, style);
    else s.removeItem(STYLE_PIN_KEY);
  } catch {
    // a full or blocked storage keeps the old pin
  }
}

/** Calls `onPin` when another window changes the pin. Returns the unsubscribe. */
export function onStylePin(onPin: (style: Style | null) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const listener = (event: StorageEvent): void => {
    if (event.key === STYLE_PIN_KEY || event.key === null) onPin(parseStylePin(event.newValue));
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
