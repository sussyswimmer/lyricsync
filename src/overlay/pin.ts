import { STYLES, type PickStyle } from "../core/songlook";
import type { Bridge } from "../bridge/types";

/**
 * Undertone 0.3.0 kept the style chosen in Settings › Style in the windows' shared web storage,
 * under this key. Since 0.4.0 it is `Settings.style` (contract v9), saved by the core like every
 * other setting. A pin left by 0.3.0 is moved over once, by the first window to start.
 */
export const STYLE_PIN_KEY = "undertone.style-pin";

/** What a stored pin means: a style Settings offers, or null (anything else, a retired style included). */
export function parseStylePin(value: unknown): PickStyle | null {
  return typeof value === "string" && (STYLES as readonly string[]).includes(value) ? (value as PickStyle) : null;
}

/** The 0.3.0 pin, taken out of storage (null when there is none, or storage is blocked). */
export function takeStylePin(storage: Pick<Storage, "getItem" | "removeItem"> | null = webStorage()): PickStyle | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(STYLE_PIN_KEY);
    if (value === null) return null;
    storage.removeItem(STYLE_PIN_KEY);
    return parseStylePin(value);
  } catch {
    return null;
  }
}

/** Moves a 0.3.0 pin into Settings › Style. A core that can't take it (older than contract v9) just loses it. */
export async function migrateStylePin(bridge: Pick<Bridge, "invoke">, storage: Pick<Storage, "getItem" | "removeItem"> | null = webStorage()): Promise<void> {
  const style = takeStylePin(storage);
  if (!style) return;
  await bridge.invoke("update_settings", { patch: { style } }).catch(() => undefined);
}

function webStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
