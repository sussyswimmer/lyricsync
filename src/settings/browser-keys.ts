/*
 * The settings window is a native-feeling window, not a web page: these are the browser keys it
 * turns off in the app (main.ts), along with the browser's context menu.
 */

/** The parts of a KeyboardEvent `isBrowserKey` reads. */
export type BrowserKeyPress = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey">;

/** Ctrl or ⌘ with one of these letters: reload, print, find, find next, view source. */
const COMMAND_LETTERS = new Set(["r", "p", "f", "g", "u"]);
/** Function keys a browser acts on: find next, reload, caret browsing. */
const FUNCTION_KEYS = new Set(["F3", "F5", "F7"]);
/** A keyboard's (or mouse's) own back, forward and reload keys. */
const HISTORY_KEYS = new Set(["BrowserBack", "BrowserForward", "BrowserRefresh"]);

/**
 * A key the webview would act on as a browser does: reload (F5, Ctrl/⌘+R, with Shift too), print
 * (Ctrl/⌘+P), find (Ctrl/⌘+F, Ctrl/⌘+G, F3), view source (Ctrl/⌘+U), caret browsing (F7), and
 * back and forward (Alt+← / Alt+→ and the keyboard's own keys). The settings window has no use for
 * any of them; WebView2 keeps them on by default, so F5 rebooted Settings and Ctrl+P opened a print
 * preview. ⌘W and ⌘Q stay free: on a Mac they are menu items.
 *
 * A letter is matched by what it types, as the browser matches it, or by its position when it types
 * something other than a Latin letter (a Russian layout's Ctrl+А is still Ctrl+F).
 */
export function isBrowserKey(press: BrowserKeyPress): boolean {
  if (FUNCTION_KEYS.has(press.key) || HISTORY_KEYS.has(press.key)) return true;
  if (press.altKey && !press.ctrlKey && !press.metaKey && (press.key === "ArrowLeft" || press.key === "ArrowRight")) return true;
  if (!press.ctrlKey && !press.metaKey) return false;
  const letter = /^[a-z]$/i.test(press.key) ? press.key.toLowerCase() : /^Key[A-Z]$/.test(press.code) ? press.code.slice(3).toLowerCase() : "";
  return COMMAND_LETTERS.has(letter);
}
