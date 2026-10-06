import type { ShortcutAction, Shortcuts } from "../../contract/contract";

/**
 * Global shortcut accelerators (contract v3), validated by the same rules as the Rust core
 * (`src-tauri/src/shortcuts.rs`), so the mock bridge, the Settings key recorder and the store agree.
 *
 * An accelerator is case-insensitive tokens joined by "+", with no spaces: modifiers, each at most
 * once, then exactly one key. It needs CmdOrCtrl, Control, Super or Alt, so a shortcut never takes
 * plain typing (Shift alone only types capitals). Its canonical spelling lists the modifiers in
 * `MODIFIERS` order and the key as the global-hotkey parser spells it: "CmdOrCtrl+Alt+Shift+L".
 */

export type Modifier = "CmdOrCtrl" | "Control" | "Super" | "Alt" | "Shift";

/** The canonical order modifiers are written in. */
export const MODIFIERS: readonly Modifier[] = ["CmdOrCtrl", "Control", "Super", "Alt", "Shift"];

/** A shortcut needs at least one of these. */
const PRIMARY: readonly Modifier[] = ["CmdOrCtrl", "Control", "Super", "Alt"];

/** Every spelling a modifier token may have, lowercased. A Map: an object would also match "constructor". */
const MODIFIER_NAMES: ReadonlyMap<string, Modifier> = new Map([
  ["cmdorctrl", "CmdOrCtrl"],
  ["commandorcontrol", "CmdOrCtrl"],
  ["cmd", "Super"],
  ["command", "Super"],
  ["super", "Super"],
  ["ctrl", "Control"],
  ["control", "Control"],
  ["alt", "Alt"],
  ["option", "Alt"],
  ["shift", "Shift"],
]);

const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const DIGITS = [..."0123456789"];
const FUNCTION_KEYS = Array.from({ length: 24 }, (_, i) => `F${i + 1}`);
const NAMED_KEYS = ["Space", "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown", "Insert", "Delete", "Backspace", "Tab", "Enter"];
const PUNCTUATION = ["[", "]", ";", "'", ",", ".", "/", "\\", "`", "-", "="];

/** Every key a shortcut can end with, in its canonical spelling (the global-hotkey parser reads each). */
export const KEYS: readonly string[] = [...LETTERS, ...DIGITS, ...FUNCTION_KEYS, ...NAMED_KEYS, ...PUNCTUATION];
const KEY_NAMES: ReadonlyMap<string, string> = new Map(KEYS.map((k) => [asciiLower(k), k]));

/** The actions in the order Settings lists them. */
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = ["toggleLyrics", "nudgeEarlier", "nudgeLater"];

/** Lowercases A–Z only, as Rust's `to_ascii_lowercase` does (JS's would turn the Kelvin sign into "k"). */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export interface Accelerator {
  /** in canonical order, each at most once */
  modifiers: Modifier[];
  key: string;
}

/** Reads an accelerator, or null when it isn't a usable shortcut. */
export function parseAccelerator(text: string): Accelerator | null {
  const tokens = text.split("+");
  const last = tokens.pop();
  const key = last === undefined ? undefined : KEY_NAMES.get(asciiLower(last));
  if (key === undefined) return null;
  const held = new Set<Modifier>();
  for (const token of tokens) {
    const modifier = MODIFIER_NAMES.get(asciiLower(token));
    if (modifier === undefined || held.has(modifier)) return null;
    held.add(modifier);
  }
  if (!PRIMARY.some((m) => held.has(m))) return null;
  return { modifiers: MODIFIERS.filter((m) => held.has(m)), key };
}

/** The canonical spelling of a parsed accelerator. */
export function formatCanonical(accelerator: Accelerator): string {
  return [...accelerator.modifiers, accelerator.key].join("+");
}

/** A binding's canonical spelling, "" for none, or null when it isn't a usable shortcut. */
export function normalizeBinding(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value === "") return "";
  const accelerator = parseAccelerator(value);
  return accelerator ? formatCanonical(accelerator) : null;
}

/** The action other than `action` that already has `binding`, if any. "" never clashes. */
export function bindingOwner(shortcuts: Shortcuts, binding: string, except: ShortcutAction): ShortcutAction | null {
  if (binding === "") return null;
  return SHORTCUT_ACTIONS.find((other) => other !== except && shortcuts[other] === binding) ?? null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `settings::merge_patch` for `shortcuts`: a partial object changes only the keys it has, and each
 * binding on its own keeps its current value when it isn't usable or when another action ends up
 * with the same one. Clashes are judged on the merged result, all at once (a swap is fine; two
 * actions taking the same new binding both keep theirs), and again after each undo, since undoing
 * one can make it clash with another. A dup-free `current` always gives a dup-free result.
 */
export function mergeShortcuts(current: Shortcuts, patch: unknown): Shortcuts {
  const next: Shortcuts = { ...current };
  if (!isObject(patch)) return next;
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  const changed = new Set<ShortcutAction>();
  for (const action of SHORTCUT_ACTIONS) {
    const binding = normalizeBinding(patch[action]);
    if (binding === null || binding === current[action]) continue;
    next[action] = binding;
    changed.add(action);
  }
  for (;;) {
    const clashing = [...changed].filter((action) => bindingOwner(next, next[action], action) !== null);
    if (clashing.length === 0) return next;
    for (const action of clashing) {
      next[action] = current[action];
      changed.delete(action);
    }
  }
}

// ---------- recording from a key press ----------

/** Where the Settings window runs: how it names keys, and which key CmdOrCtrl is. */
export type Platform = "mac" | "windows" | "other";

export function detectPlatform(nav: { platform?: string; userAgent?: string } | undefined): Platform {
  const id = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  if (/Mac|iPhone|iPad/i.test(id)) return "mac";
  if (/Win/i.test(id)) return "windows";
  return "other";
}

/** The parts of a KeyboardEvent the recorder reads. */
export interface KeyPress {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** What a key press means to the recorder. */
export type Recorded =
  /** only modifier keys so far, held down */
  | { kind: "modifiers"; modifiers: Modifier[] }
  | { kind: "combo"; accelerator: string }
  /** a key without CmdOrCtrl, Control, Super or Alt */
  | { kind: "needs-modifier" }
  /** a key no shortcut can use (Caps Lock, a keypad key, Escape…) */
  | { kind: "unsupported" }
  /** a punctuation key that types something else on this Windows keyboard layout (see `recordKey`) */
  | { kind: "layout" };

/** What each key position (`KeyboardEvent.code`) types on the keyboard layout in use. */
export interface KeyLayout {
  get(code: string): string | undefined;
}

/** The keyboard layout in use, from `navigator.keyboard.getLayoutMap()`; null where the engine can't say. */
export async function loadKeyLayout(nav: object | undefined): Promise<KeyLayout | null> {
  const keyboard = (nav as { keyboard?: { getLayoutMap?: () => Promise<KeyLayout> } } | undefined)?.keyboard;
  if (typeof keyboard?.getLayoutMap !== "function") return null;
  try {
    return await keyboard.getLayoutMap();
  } catch {
    return null;
  }
}

/** Physical keys (`KeyboardEvent.code`, the same on every layout) to their canonical names. */
const CODE_KEYS: ReadonlyMap<string, string> = new Map([
  ...LETTERS.map((l): [string, string] => [`Key${l}`, l]),
  ...DIGITS.map((d): [string, string] => [`Digit${d}`, d]),
  ...FUNCTION_KEYS.map((f): [string, string] => [f, f]),
  ["Space", "Space"],
  ["ArrowUp", "Up"],
  ["ArrowDown", "Down"],
  ["ArrowLeft", "Left"],
  ["ArrowRight", "Right"],
  ["Home", "Home"],
  ["End", "End"],
  ["PageUp", "PageUp"],
  ["PageDown", "PageDown"],
  ["Insert", "Insert"],
  ["Delete", "Delete"],
  ["Backspace", "Backspace"],
  ["Tab", "Tab"],
  ["Enter", "Enter"],
  ["BracketLeft", "["],
  ["BracketRight", "]"],
  ["Semicolon", ";"],
  ["Quote", "'"],
  ["Comma", ","],
  ["Period", "."],
  ["Slash", "/"],
  ["Backslash", "\\"],
  ["Backquote", "`"],
  ["Minus", "-"],
  ["Equal", "="],
]);

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "AltGraph", "OS", "Super", "Hyper", "Fn", "FnLock"]);

/** True for a press of a modifier key itself (Shift, ⌘, AltGr…), which only adds to what is held. */
export function isModifierKey(press: Pick<KeyPress, "key" | "code">): boolean {
  return MODIFIER_KEYS.has(press.key) || /^(Meta|Control|Alt|Shift|OS)(Left|Right)$/.test(press.code);
}

/** The modifiers held during a press. ⌘ is CmdOrCtrl on a Mac, and Ctrl elsewhere (so bindings travel). */
export function heldModifiers(press: KeyPress, platform: Platform): Modifier[] {
  const held = new Set<Modifier>();
  if (press.metaKey) held.add(platform === "mac" ? "CmdOrCtrl" : "Super");
  if (press.ctrlKey) held.add(platform === "mac" ? "Control" : "CmdOrCtrl");
  if (press.altKey) held.add("Alt");
  if (press.shiftKey) held.add("Shift");
  return MODIFIERS.filter((m) => held.has(m));
}

/**
 * The key a press at `code` records: undefined when no shortcut can use it, null when it can't on
 * this layout. macOS registers a shortcut by key position, as `code` gives it. Windows registers it
 * by virtual key, and a letter key's virtual key is the letter it types on the active layout (the
 * AZERTY key where US has Q is VK_A), so there a letter is recorded as what it types. The number row
 * keeps VK_0–VK_9 on every layout, and non-Latin layouts keep the US letters' virtual keys, so those
 * stay by position. Punctuation keys' virtual keys move between layouts, so one is taken only where
 * it types what it does on a US keyboard. Without a layout (an engine that can't say), by position.
 */
function keyAt(code: string, platform: Platform, layout: KeyLayout | null): string | null | undefined {
  const key = CODE_KEYS.get(code);
  const typed = layout?.get(code);
  if (key === undefined || platform !== "windows" || typed === undefined) return key;
  if (/^[a-z]$/i.test(typed)) return typed.toUpperCase();
  if (code.startsWith("Digit")) return key;
  if (code.startsWith("Key") && !/^[\x20-\x7e]$/.test(typed)) return key;
  return typed === key ? key : null;
}

/** What a key press records: on a Mac the key's position, on Windows the key Windows will register (`keyAt`). */
export function recordKey(press: KeyPress, platform: Platform, layout: KeyLayout | null = null): Recorded {
  const modifiers = heldModifiers(press, platform);
  if (isModifierKey(press)) return { kind: "modifiers", modifiers };
  const key = keyAt(press.code, platform, layout);
  if (!modifiers.some((m) => PRIMARY.includes(m))) return { kind: "needs-modifier" };
  if (key === undefined) return { kind: "unsupported" };
  if (key === null) return { kind: "layout" };
  return { kind: "combo", accelerator: formatCanonical({ modifiers, key }) };
}

// ---------- combinations to leave alone ----------

/** What these already do in (nearly) every app. A global shortcut would take them from all of them. */
const EVERY_APP: readonly [string, string][] = [
  ["CmdOrCtrl+C", "copies in every app"],
  ["CmdOrCtrl+V", "pastes in every app"],
  ["CmdOrCtrl+X", "cuts in every app"],
  ["CmdOrCtrl+Z", "undoes in every app"],
  ["CmdOrCtrl+A", "selects all in every app"],
  ["CmdOrCtrl+S", "saves in most apps"],
  ["CmdOrCtrl+W", "closes windows and tabs"],
];
const MAC_RESERVED: ReadonlyMap<string, string> = new Map([
  ...EVERY_APP,
  ["CmdOrCtrl+Q", "quits apps"],
  ["CmdOrCtrl+Tab", "switches apps"],
  ["CmdOrCtrl+Space", "opens Spotlight"],
]);
const PC_RESERVED: ReadonlyMap<string, string> = new Map([
  ...EVERY_APP,
  ["CmdOrCtrl+Q", "quits many apps"],
  ["CmdOrCtrl+Tab", "switches tabs in most apps"],
  ["Alt+Tab", "switches apps"],
  ["Alt+F4", "closes the window"],
]);

/** What a recorded combination already does everywhere ("copies in every app"), or null. The recorder turns these down. */
export function reservedUse(binding: string, platform: Platform): string | null {
  return (platform === "mac" ? MAC_RESERVED : PC_RESERVED).get(binding) ?? null;
}

const TYPING_KEYS = new Set([...LETTERS, ...DIGITS, ...PUNCTUATION]);

/**
 * Windows reports AltGr as Ctrl+Alt, so a Ctrl+Alt shortcut on a typing key, without Shift or the
 * Windows key, takes the character some layouts type with AltGr and that key (German @ on Q).
 */
export function clashesWithAltGr(binding: string, platform: Platform): boolean {
  const accelerator = platform === "windows" ? parseAccelerator(binding) : null;
  if (!accelerator || !TYPING_KEYS.has(accelerator.key)) return false;
  const held = new Set(accelerator.modifiers);
  return (held.has("CmdOrCtrl") || held.has("Control")) && held.has("Alt") && !held.has("Shift") && !held.has("Super");
}

// ---------- showing a binding ----------

/** Apple's order and glyphs: ⌃⌥⇧⌘. CmdOrCtrl and Super are both ⌘ on a Mac. */
const MAC_ORDER: readonly [Modifier, string][] = [
  ["Control", "⌃"],
  ["Alt", "⌥"],
  ["Shift", "⇧"],
  ["CmdOrCtrl", "⌘"],
  ["Super", "⌘"],
];
const MAC_KEYS: ReadonlyMap<string, string> = new Map([
  ["Up", "↑"],
  ["Down", "↓"],
  ["Left", "←"],
  ["Right", "→"],
  ["Enter", "↩"],
  ["Backspace", "⌫"],
  ["Delete", "⌦"],
  ["Tab", "⇥"],
  ["PageUp", "Page Up"],
  ["PageDown", "Page Down"],
]);
const PC_KEYS: ReadonlyMap<string, string> = new Map([
  ["PageUp", "Page Up"],
  ["PageDown", "Page Down"],
]);

/** Spoken names, where reading the glyph or symbol aloud wouldn't say which key it is. */
const SPOKEN_KEYS: ReadonlyMap<string, string> = new Map([
  ["Up", "Up Arrow"],
  ["Down", "Down Arrow"],
  ["Left", "Left Arrow"],
  ["Right", "Right Arrow"],
  ["PageUp", "Page Up"],
  ["PageDown", "Page Down"],
  ["[", "Left Bracket"],
  ["]", "Right Bracket"],
  [";", "Semicolon"],
  ["'", "Quote"],
  [",", "Comma"],
  [".", "Period"],
  ["/", "Slash"],
  ["\\", "Backslash"],
  ["`", "Backquote"],
  ["-", "Minus"],
  ["=", "Equals"],
]);

/** Modifier names on Windows and Linux, in their usual order: Win+Ctrl+Alt+Shift. */
function pcModifiers(modifiers: readonly Modifier[], platform: Platform, spoken: boolean): string[] {
  const out: string[] = [];
  if (modifiers.includes("Super")) out.push(platform === "windows" ? (spoken ? "Windows" : "Win") : "Super");
  if (modifiers.includes("CmdOrCtrl") || modifiers.includes("Control")) out.push(spoken ? "Control" : "Ctrl");
  if (modifiers.includes("Alt")) out.push("Alt");
  if (modifiers.includes("Shift")) out.push("Shift");
  return out;
}

const MAC_SPOKEN: Readonly<Record<string, string>> = { "⌃": "Control", "⌥": "Option", "⇧": "Shift", "⌘": "Command" };

function macGlyphs(modifiers: readonly Modifier[]): string[] {
  const glyphs = MAC_ORDER.filter(([m]) => modifiers.includes(m)).map(([, g]) => g);
  return [...new Set(glyphs)];
}

/** Held modifiers as the platform writes them, for the recorder's "⌥⇧…" while keys go down. */
export function displayModifiers(modifiers: readonly Modifier[], platform: Platform): string {
  if (platform === "mac") return macGlyphs(modifiers).join("");
  return pcModifiers(modifiers, platform, false)
    .map((m) => `${m}+`)
    .join("");
}

/** A binding as the platform shows shortcuts: "⌥⇧⌘L" on a Mac, "Ctrl+Alt+Shift+L" elsewhere. "" for none or unusable. */
export function displayAccelerator(binding: string, platform: Platform): string {
  const accelerator = parseAccelerator(binding);
  if (!accelerator) return "";
  if (platform === "mac") return macGlyphs(accelerator.modifiers).join("") + (MAC_KEYS.get(accelerator.key) ?? accelerator.key);
  return [...pcModifiers(accelerator.modifiers, platform, false), PC_KEYS.get(accelerator.key) ?? accelerator.key].join("+");
}

/** A binding as a screen reader should say it: "Command Option Shift L". "" for none or unusable. */
export function speakAccelerator(binding: string, platform: Platform): string {
  const accelerator = parseAccelerator(binding);
  if (!accelerator) return "";
  const modifiers =
    platform === "mac" ? macGlyphs(accelerator.modifiers).map((g) => MAC_SPOKEN[g] ?? g) : pcModifiers(accelerator.modifiers, platform, true);
  return [...modifiers, SPOKEN_KEYS.get(accelerator.key) ?? accelerator.key].join(" ");
}
