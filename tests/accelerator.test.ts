import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings, type Shortcuts } from "../contract/contract";
import { mergeSettings } from "../src/bridge/mock";
import {
  bindingOwner,
  clashesWithAltGr,
  detectPlatform,
  displayAccelerator,
  displayModifiers,
  heldModifiers,
  isModifierKey,
  KEYS,
  loadKeyLayout,
  mergeShortcuts,
  MODIFIERS,
  normalizeBinding,
  parseAccelerator,
  recordKey,
  reservedUse,
  speakAccelerator,
  type KeyPress,
} from "../src/core/accelerator";
import cases from "./fixtures/accelerators.json";

// The same table the Rust core's validator is meant to pass (src-tauri/src/shortcuts.rs).
describe("accelerator validation: the shared table", () => {
  it.each(cases.accept)("accepts %j as %j", (input, canonical) => {
    expect(normalizeBinding(input)).toBe(canonical);
    // canonical spellings are fixed points
    expect(normalizeBinding(canonical)).toBe(canonical);
  });

  it.each(cases.reject)("rejects %j", (input) => {
    expect(normalizeBinding(input)).toBeNull();
    expect(parseAccelerator(input)).toBeNull();
  });

  it("takes \"\" as no shortcut, and nothing but a string", () => {
    expect(normalizeBinding("")).toBe("");
    for (const junk of [null, undefined, 5, true, {}, ["CmdOrCtrl+L"]]) expect(normalizeBinding(junk)).toBeNull();
  });

  it("covers every key and every modifier spelling", () => {
    const keys = new Set(cases.accept.map(([, canonical]) => canonical?.split("+").pop()));
    for (const key of ["L", "]", "[", "Delete", "F12", "Space", "Up", "F1", "F24", "0", "A", "Z", "PageUp", "PageDown"]) expect(keys).toContain(key);
    const spellings = cases.accept.flatMap(([input]) => (input ?? "").split("+").slice(0, -1).map((t) => t.toLowerCase()));
    for (const name of ["cmdorctrl", "commandorcontrol", "cmd", "command", "super", "ctrl", "control", "alt", "option", "shift"]) {
      expect(spellings).toContain(name);
    }
  });

  it("the contract's default bindings are canonical and distinct", () => {
    const d = DEFAULT_SETTINGS.shortcuts;
    const bindings = [d.toggleLyrics, d.nudgeEarlier, d.nudgeLater];
    for (const b of bindings) expect(normalizeBinding(b)).toBe(b);
    expect(new Set(bindings).size).toBe(3);
  });

  it("lists every key once, each its own canonical spelling", () => {
    expect(KEYS).toHaveLength(26 + 10 + 24 + 14 + 11);
    expect(new Set(KEYS.map((k) => k.toLowerCase())).size).toBe(KEYS.length);
    for (const key of KEYS) expect(normalizeBinding(`Alt+${key}`)).toBe(`Alt+${key}`);
    expect(MODIFIERS).toEqual(["CmdOrCtrl", "Control", "Super", "Alt", "Shift"]);
  });
});

describe("mergeShortcuts", () => {
  const A = "CmdOrCtrl+Alt+Shift+L";
  const B = "CmdOrCtrl+Alt+Shift+]";
  const C = "CmdOrCtrl+Alt+Shift+[";
  const D = "Control+Alt+K";
  const current: Shortcuts = { enabled: true, toggleLyrics: A, nudgeEarlier: B, nudgeLater: C };

  it("changes only the keys a partial object has, normalized, and never mutates its input", () => {
    const before = structuredClone(current);
    expect(mergeShortcuts(current, { toggleLyrics: "ctrl+alt+k" })).toEqual({ ...current, toggleLyrics: D });
    expect(mergeShortcuts(current, { enabled: false })).toEqual({ ...current, enabled: false });
    expect(mergeShortcuts(current, {})).toEqual(current);
    expect(current).toEqual(before);
    expect(mergeShortcuts(current, {})).not.toBe(current);
  });

  it("keeps the current value for an unusable binding or a wrong type", () => {
    for (const junk of ["L", "Shift+L", "CmdOrCtrl+L+K", " ", 5, null, true, ["x"]]) {
      expect(mergeShortcuts(current, { toggleLyrics: junk, nudgeEarlier: junk, nudgeLater: junk, enabled: "no" })).toEqual(current);
    }
    for (const patch of [null, undefined, "CmdOrCtrl+L", 3, [current]]) expect(mergeShortcuts(current, patch)).toEqual(current);
  });

  it("clears with \"\", and any number of actions may have none", () => {
    expect(mergeShortcuts(current, { toggleLyrics: "", nudgeLater: "" })).toEqual({ ...current, toggleLyrics: "", nudgeLater: "" });
  });

  it("keeps the current value when another action already has the binding", () => {
    expect(mergeShortcuts(current, { toggleLyrics: B })).toEqual(current);
    // also after normalization
    expect(mergeShortcuts(current, { nudgeLater: "shift+alt+cmdorctrl+l" })).toEqual(current);
  });

  it("judges clashes on the merged result: a swap is fine", () => {
    expect(mergeShortcuts(current, { toggleLyrics: B, nudgeEarlier: A })).toEqual({ ...current, toggleLyrics: B, nudgeEarlier: A });
    // so is moving a binding to an action whose old one moves away in the same patch
    expect(mergeShortcuts(current, { toggleLyrics: B, nudgeEarlier: D })).toEqual({ ...current, toggleLyrics: B, nudgeEarlier: D });
  });

  it("two actions taking the same new binding both keep theirs, whatever the order", () => {
    expect(mergeShortcuts(current, { toggleLyrics: D, nudgeLater: D })).toEqual(current);
    expect(mergeShortcuts(current, { nudgeLater: D, toggleLyrics: D })).toEqual(current);
  });

  it("undoing one clash can undo another", () => {
    // nudgeEarlier → C clashes with nudgeLater (unchanged); undone to B, it clashes with toggleLyrics → B, also undone
    expect(mergeShortcuts(current, { toggleLyrics: B, nudgeEarlier: C })).toEqual(current);
  });

  it("repairs a stored set with duplicates by falling back to the current (default) bindings", () => {
    const d = DEFAULT_SETTINGS.shortcuts;
    expect(mergeShortcuts(d, { toggleLyrics: D, nudgeEarlier: D, nudgeLater: D })).toEqual(d);
  });

  // The same table the Rust core's merge_patch is tested with (src-tauri/src/settings.rs).
  it.each(cases.merge)("shared merge case: $why", ({ current: shortcuts, patch, expected }) => {
    const settings: Settings = { ...structuredClone(DEFAULT_SETTINGS), shortcuts };
    expect(mergeSettings(settings, { shortcuts: patch }).shortcuts).toEqual(expected);
  });

  it("bindingOwner finds the other action with a binding, never for \"\"", () => {
    expect(bindingOwner(current, B, "toggleLyrics")).toBe("nudgeEarlier");
    expect(bindingOwner(current, B, "nudgeEarlier")).toBeNull();
    expect(bindingOwner({ ...current, toggleLyrics: "", nudgeLater: "" }, "", "nudgeEarlier")).toBeNull();
  });
});

const press = (code: string, mods: Partial<Pick<KeyPress, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {}, key = code): KeyPress => ({
  code,
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("recordKey: a key press to an accelerator", () => {
  it("⌘ is CmdOrCtrl on a Mac and ⌃ is Control; Ctrl is CmdOrCtrl elsewhere and the Windows key is Super", () => {
    const all = { metaKey: true, altKey: true, shiftKey: true };
    expect(recordKey(press("KeyL", all), "mac")).toEqual({ kind: "combo", accelerator: "CmdOrCtrl+Alt+Shift+L" });
    expect(recordKey(press("KeyL", { ctrlKey: true }), "mac")).toEqual({ kind: "combo", accelerator: "Control+L" });
    expect(recordKey(press("KeyL", { ctrlKey: true, altKey: true, shiftKey: true }), "windows")).toEqual({ kind: "combo", accelerator: "CmdOrCtrl+Alt+Shift+L" });
    expect(recordKey(press("KeyL", { metaKey: true }), "windows")).toEqual({ kind: "combo", accelerator: "Super+L" });
    expect(recordKey(press("KeyL", { metaKey: true, ctrlKey: true }), "other")).toEqual({ kind: "combo", accelerator: "CmdOrCtrl+Super+L" });
  });

  it("without a layout, reads the key's position, not its character", () => {
    // AZERTY: the key labeled A sits where Q is; German: ] is AltGr on another key
    expect(recordKey(press("KeyQ", { altKey: true }, "a"), "windows")).toEqual({ kind: "combo", accelerator: "Alt+Q" });
    expect(recordKey(press("BracketRight", { ctrlKey: true, altKey: true }, "+"), "windows")).toEqual({ kind: "combo", accelerator: "CmdOrCtrl+Alt+]" });
    expect(recordKey(press("Digit1", { altKey: true, shiftKey: true }, "!"), "mac")).toEqual({ kind: "combo", accelerator: "Alt+Shift+1" });
  });

  it("on Windows, reads letters by what they type on the layout, the number row by position, and punctuation only where it types as on US", () => {
    const azerty = new Map([
      ["KeyQ", "a"],
      ["KeyA", "q"],
      ["KeyM", ","],
      ["Semicolon", "m"],
      ["Digit1", "&"],
      ["Comma", ";"],
      ["Equal", "="],
      ["BracketLeft", "^"],
    ]);
    const ctrlAlt = { ctrlKey: true, altKey: true, shiftKey: true };
    const win = (code: string, layout: ReadonlyMap<string, string>) => recordKey(press(code, ctrlAlt), "windows", layout);
    expect(win("KeyQ", azerty)).toEqual({ kind: "combo", accelerator: "CmdOrCtrl+Alt+Shift+A" });
    expect(win("KeyA", azerty)).toEqual({ kind: "combo", accelerator: "CmdOrCtrl+Alt+Shift+Q" });
    expect(win("Semicolon", azerty)).toEqual({ kind: "combo", accelerator: "CmdOrCtrl+Alt+Shift+M" });
    expect(win("Digit1", azerty)).toEqual({ kind: "combo", accelerator: "CmdOrCtrl+Alt+Shift+1" });
    expect(win("Equal", azerty)).toEqual({ kind: "combo", accelerator: "CmdOrCtrl+Alt+Shift+=" });
    // punctuation (or a letter key typing punctuation) where the layout differs from US
    for (const code of ["KeyM", "Comma", "BracketLeft"]) expect(win(code, azerty), code).toEqual({ kind: "layout" });
    // non-Latin layouts keep the US letters' virtual keys
    expect(win("KeyQ", new Map([["KeyQ", "й"]]))).toEqual({ kind: "combo", accelerator: "CmdOrCtrl+Alt+Shift+Q" });
    // keys outside the layout map (F keys, arrows, Space) by position
    expect(win("F5", azerty)).toEqual({ kind: "combo", accelerator: "CmdOrCtrl+Alt+Shift+F5" });
    expect(win("ArrowUp", azerty)).toEqual({ kind: "combo", accelerator: "CmdOrCtrl+Alt+Shift+Up" });
    expect(win("NumpadAdd", azerty)).toEqual({ kind: "unsupported" });
    // a Mac registers by position whatever the layout
    expect(recordKey(press("KeyQ", { metaKey: true }), "mac", azerty)).toEqual({ kind: "combo", accelerator: "CmdOrCtrl+Q" });
    expect(recordKey(press("BracketLeft", { metaKey: true }), "mac", azerty)).toEqual({ kind: "combo", accelerator: "CmdOrCtrl+[" });
  });

  it("loadKeyLayout asks the engine, and is null where it can't say or refuses", async () => {
    const map = new Map([["KeyQ", "a"]]);
    expect(await loadKeyLayout({ keyboard: { getLayoutMap: () => Promise.resolve(map) } })).toBe(map);
    expect(await loadKeyLayout({ keyboard: { getLayoutMap: () => Promise.reject(new Error("SecurityError")) } })).toBeNull();
    expect(await loadKeyLayout({ keyboard: {} })).toBeNull();
    expect(await loadKeyLayout({})).toBeNull();
    expect(await loadKeyLayout(undefined)).toBeNull();
  });

  it("maps a key position to every key a shortcut may use, and to nothing else", () => {
    const codes = [
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => `Key${l}`),
      ..."0123456789".split("").map((d) => `Digit${d}`),
      ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
      ...["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Insert", "Delete", "Backspace", "Tab", "Enter"],
      ...["BracketLeft", "BracketRight", "Semicolon", "Quote", "Comma", "Period", "Slash", "Backslash", "Backquote", "Minus", "Equal"],
    ];
    const recorded = codes.map((code) => {
      const r = recordKey(press(code, { altKey: true }), "mac");
      return r.kind === "combo" ? r.accelerator.replace(/^Alt\+/, "") : `(${code}: ${r.kind})`;
    });
    expect(recorded).toEqual([...KEYS]);
    for (const code of ["Escape", "CapsLock", "NumpadAdd", "Numpad1", "NumpadEnter", "IntlBackslash", "F25", "MediaPlayPause", "PrintScreen", ""]) {
      expect(recordKey(press(code, { altKey: true }), "mac"), code).toEqual({ kind: "unsupported" });
    }
  });

  it("needs ⌘, ⌃, ⌥ or the Windows key; Shift alone isn't enough", () => {
    expect(recordKey(press("KeyL"), "mac")).toEqual({ kind: "needs-modifier" });
    expect(recordKey(press("KeyL", { shiftKey: true }), "windows")).toEqual({ kind: "needs-modifier" });
    expect(recordKey(press("NumpadAdd", { shiftKey: true }), "windows")).toEqual({ kind: "needs-modifier" });
  });

  it("a modifier key on its own reports what is held so far", () => {
    expect(recordKey(press("AltLeft", { altKey: true }, "Alt"), "mac")).toEqual({ kind: "modifiers", modifiers: ["Alt"] });
    expect(recordKey(press("MetaRight", { metaKey: true, shiftKey: true }, "Meta"), "mac")).toEqual({ kind: "modifiers", modifiers: ["CmdOrCtrl", "Shift"] });
    expect(recordKey(press("AltRight", { ctrlKey: true, altKey: true }, "AltGraph"), "windows")).toEqual({ kind: "modifiers", modifiers: ["CmdOrCtrl", "Alt"] });
    expect(isModifierKey({ code: "ShiftLeft", key: "Shift" })).toBe(true);
    expect(isModifierKey({ code: "OSLeft", key: "OS" })).toBe(true);
    expect(isModifierKey({ code: "KeyL", key: "l" })).toBe(false);
    expect(heldModifiers(press("KeyL", { metaKey: true, ctrlKey: true, altKey: true, shiftKey: true }), "mac")).toEqual(["CmdOrCtrl", "Control", "Alt", "Shift"]);
  });
});

describe("combinations to leave alone", () => {
  it("knows what the everyday ones do on each platform", () => {
    expect(reservedUse("CmdOrCtrl+C", "mac")).toBe("copies in every app");
    expect(reservedUse("CmdOrCtrl+C", "windows")).toBe("copies in every app");
    expect(reservedUse("CmdOrCtrl+Space", "mac")).toBe("opens Spotlight");
    expect(reservedUse("CmdOrCtrl+Tab", "mac")).toBe("switches apps");
    expect(reservedUse("CmdOrCtrl+Tab", "windows")).toBe("switches tabs in most apps");
    expect(reservedUse("Alt+F4", "windows")).toBe("closes the window");
    expect(reservedUse("Alt+F4", "mac")).toBeNull();
    for (const free of ["CmdOrCtrl+Shift+C", "Control+C", "CmdOrCtrl+Alt+Shift+L", ""]) expect(reservedUse(free, "windows"), free).toBeNull();
  });

  it("on Windows, Ctrl+Alt on a typing key without Shift or Win may take an AltGr character", () => {
    expect(clashesWithAltGr("CmdOrCtrl+Alt+Q", "windows")).toBe(true);
    expect(clashesWithAltGr("Control+Alt+]", "windows")).toBe(true);
    expect(clashesWithAltGr("CmdOrCtrl+Alt+7", "windows")).toBe(true);
    for (const safe of ["CmdOrCtrl+Alt+Shift+Q", "CmdOrCtrl+Super+Alt+Q", "CmdOrCtrl+Alt+F4", "CmdOrCtrl+Alt+Space", "Alt+Q", "CmdOrCtrl+Q", ""]) {
      expect(clashesWithAltGr(safe, "windows"), safe).toBe(false);
    }
    expect(clashesWithAltGr("CmdOrCtrl+Alt+Q", "mac")).toBe(false);
  });
});

describe("showing a binding", () => {
  it("on a Mac: glyphs in Apple's order ⌃⌥⇧⌘, then the key", () => {
    expect(displayAccelerator("CmdOrCtrl+Alt+Shift+L", "mac")).toBe("⌥⇧⌘L");
    expect(displayAccelerator("CmdOrCtrl+Alt+Shift+]", "mac")).toBe("⌥⇧⌘]");
    expect(displayAccelerator("CmdOrCtrl+Control+Alt+Shift+K", "mac")).toBe("⌃⌥⇧⌘K");
    expect(displayAccelerator("CmdOrCtrl+Super+L", "mac")).toBe("⌘L");
    expect(displayAccelerator("Super+Up", "mac")).toBe("⌘↑");
    expect(displayAccelerator("Alt+Enter", "mac")).toBe("⌥↩");
    expect(displayAccelerator("Alt+Backspace", "mac")).toBe("⌥⌫");
    expect(displayAccelerator("Control+PageUp", "mac")).toBe("⌃Page Up");
    expect(displayAccelerator("Alt+Space", "mac")).toBe("⌥Space");
  });

  it("on Windows: names joined with +, Win first", () => {
    expect(displayAccelerator("CmdOrCtrl+Alt+Shift+L", "windows")).toBe("Ctrl+Alt+Shift+L");
    expect(displayAccelerator("CmdOrCtrl+Alt+Shift+[", "windows")).toBe("Ctrl+Alt+Shift+[");
    expect(displayAccelerator("Super+Control+Alt+Shift+K", "windows")).toBe("Win+Ctrl+Alt+Shift+K");
    expect(displayAccelerator("CmdOrCtrl+Control+L", "windows")).toBe("Ctrl+L");
    expect(displayAccelerator("Alt+PageDown", "windows")).toBe("Alt+Page Down");
    expect(displayAccelerator("Super+L", "other")).toBe("Super+L");
  });

  it("shows nothing for no shortcut or an unusable one", () => {
    for (const platform of ["mac", "windows", "other"] as const) {
      expect(displayAccelerator("", platform)).toBe("");
      expect(displayAccelerator("Shift+L", platform)).toBe("");
      expect(speakAccelerator("", platform)).toBe("");
    }
  });

  it("speaks it with words a screen reader says the same way everywhere", () => {
    expect(speakAccelerator("CmdOrCtrl+Alt+Shift+L", "mac")).toBe("Option Shift Command L");
    expect(speakAccelerator("CmdOrCtrl+Alt+Shift+]", "mac")).toBe("Option Shift Command Right Bracket");
    expect(speakAccelerator("CmdOrCtrl+Alt+Shift+[", "windows")).toBe("Control Alt Shift Left Bracket");
    expect(speakAccelerator("Super+Up", "windows")).toBe("Windows Up Arrow");
    expect(speakAccelerator("Control+=", "mac")).toBe("Control Equals");
  });

  it("writes held modifiers for the recorder", () => {
    expect(displayModifiers(["Alt", "Shift"], "mac")).toBe("⌥⇧");
    expect(displayModifiers(["CmdOrCtrl", "Alt"], "windows")).toBe("Ctrl+Alt+");
    expect(displayModifiers([], "windows")).toBe("");
  });
});

describe("detectPlatform", () => {
  it("reads macOS, Windows, or neither from the browser", () => {
    expect(detectPlatform({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15" })).toBe("mac");
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)" })).toBe("mac");
    expect(detectPlatform({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/129.0" })).toBe("windows");
    expect(detectPlatform({ platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })).toBe("other");
    expect(detectPlatform(undefined)).toBe("other");
  });
});
