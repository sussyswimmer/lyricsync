import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type NowPlaying, type Settings, type ShortcutsStatus } from "../contract/contract";
import type { Bridge } from "../src/bridge/types";
import type { KeyLayout, Platform } from "../src/core/accelerator";
import { PaletteCache } from "../src/core/palette";
import type { PanelState, SettingsPanel as Panel } from "../src/settings/panel";
import { SettingsPreview } from "../src/settings/preview";
import { ALTGR_NOTE, NOTE_MS, RECORD_TIMEOUT_MS } from "../src/settings/recorder";
import { applyWrite, defaultsPatch, SettingsSync, withDefaults, type Write } from "../src/settings/store";
import { activeElement, resetDom, runFrames, stubDom, type FakeElement } from "./fake-dom";

/*
 * Contract v3 in the settings window: the General group (lyrics on or off, Launch at login), the
 * Behavior rows' wording, the Shortcuts group and its key recorder, and Reset to defaults keeping the
 * two General switches.
 */

const previewFakes = vi.hoisted(() => {
  class Stage {
    setSettings(): void {}
    destroy(): void {}
  }
  class Controller {
    track: NowPlaying | null = null;
    async start(): Promise<void> {}
    setSettings(): void {}
    kick(): void {}
    destroy(): void {}
  }
  return { Stage, Controller };
});
vi.mock("../src/overlay/stage", () => ({ LyricStage: previewFakes.Stage }));
vi.mock("../src/overlay/controller", () => ({ OverlayController: previewFakes.Controller }));

let SettingsPanel: typeof Panel;
beforeAll(async () => {
  stubDom();
  ({ SettingsPanel } = await import("../src/settings/panel"));
});

beforeEach(() => {
  resetDom();
  stubDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const D = DEFAULT_SETTINGS.shortcuts;
const OK: ShortcutsStatus = { toggleLyrics: "ok", nudgeEarlier: "ok", nudgeLater: "ok" };

/** A panel wired the way main.ts wires it: every edit re-renders at once. */
function mount(platform: Platform = "mac", over: Partial<Settings> = {}, status: ShortcutsStatus | null = OK, keyLayout?: () => Promise<KeyLayout | null>) {
  let settings: Settings = { ...structuredClone(DEFAULT_SETTINGS), ...over };
  const edits: Partial<Settings>[] = [];
  const now: Partial<Settings>[] = [];
  const suspends: boolean[] = [];
  let state: PanelState = { settings, palette: null, paletteFor: null, artPending: false, track: null, media: null, shortcuts: status, loginError: false };
  const apply = (patch: Partial<Settings>): void => {
    settings = { ...settings, ...patch };
    panel.render((state = { ...state, settings }));
  };
  const panel = new SettingsPanel(
    {
      edit: (patch) => {
        edits.push(patch);
        apply(patch);
      },
      editNow: (patch) => {
        now.push(patch);
        apply(patch);
      },
      setTrackOffset: () => undefined,
      reset: () => undefined,
      suspendShortcuts: (s) => suspends.push(s),
    },
    { platform, keyLayout },
  );
  panel.render(state);
  const root = panel.el as unknown as FakeElement;
  const group = (title: string): FakeElement => {
    const found = root.all("group").find((g) => g.one("group-title").textContent === title);
    if (!found) throw new Error(`no ${title} group`);
    return found;
  };
  const shortcuts = group("Shortcuts");
  const rows = shortcuts.all("sc-row");
  const keys = shortcuts.all("sc-key");
  const [toggleKey, earlierKey, laterKey] = keys;
  if (!toggleKey || !earlierKey || !laterKey) throw new Error("three shortcut rows expected");
  return {
    panel,
    root,
    group,
    edits,
    now,
    suspends,
    rows,
    keys,
    toggleKey,
    earlierKey,
    laterKey,
    settings: (): Settings => settings,
    message: (i: number): FakeElement => (rows[i] as FakeElement).one("sc-msg"),
    hint: (): FakeElement => shortcuts.one("sc-hint"),
    rerender(next: Partial<PanelState>): void {
      if (next.settings) settings = next.settings;
      panel.render((state = { ...state, ...next }));
    },
    spoken(): string {
      runFrames();
      return root.children.find((c) => c.getAttribute("role") === "status" && c.classList.contains("sr-only"))?.textContent ?? "";
    },
  };
}

type Mounted = ReturnType<typeof mount>;

function switchIn(el: FakeElement, label: string): FakeElement {
  const row = el.all("toggle").find((r) => r.one("row-label").textContent === label);
  if (!row) throw new Error(`no ${label} switch`);
  return row.one("switch");
}

function flip(input: FakeElement, on: boolean): void {
  input.checked = on;
  input.dispatch("change");
}

describe("General: lyrics on the desktop and Launch at login", () => {
  it("sits first, right under the media notice", () => {
    const p = mount();
    expect(p.root.children[0]?.classList.contains("notice")).toBe(true);
    expect(p.root.children[1]).toBe(p.group("General"));
  });

  it("the lyrics switch edits `enabled`; Launch at login saves at once, on its own", () => {
    const p = mount();
    const general = p.group("General");
    const lyrics = switchIn(general, "Lyrics on the desktop");
    const login = switchIn(general, "Launch at login");
    expect(lyrics.checked).toBe(true);
    expect(login.checked).toBe(false);
    flip(lyrics, false);
    expect(p.edits).toEqual([{ enabled: false }]);
    flip(login, true);
    expect(p.now).toEqual([{ launchAtLogin: true }]);
    expect(p.edits).toHaveLength(1);
    expect(p.settings()).toMatchObject({ enabled: false, launchAtLogin: true });
  });

  it("says where to turn the lyrics back on once they're off, with the toggle shortcut in this OS's notation", () => {
    const mac = mount("mac");
    const caption = (p: Mounted): string => p.group("General").all("toggle-hint")[0]?.textContent ?? "";
    expect(caption(mac)).toBe("Shown on your desktop, under your windows.");
    flip(switchIn(mac.group("General"), "Lyrics on the desktop"), false);
    expect(caption(mac)).toBe("Hidden on the desktop. Turn them back on here, from the menu bar, or with ⌥⇧⌘L.");

    const win = mount("windows", { enabled: false });
    expect(caption(win)).toBe("Hidden on the desktop. Turn them back on here, from the tray icon, or with Ctrl+Alt+Shift+L.");
    // a binding of the user's own
    win.rerender({ settings: { ...win.settings(), shortcuts: { ...D, toggleLyrics: "Control+Alt+K" } } });
    expect(caption(win)).toBe("Hidden on the desktop. Turn them back on here, from the tray icon, or with Ctrl+Alt+K.");
  });

  it("leaves the shortcut out when it is off, unbound, held by another app or unusable", () => {
    const p = mount("mac", { enabled: false });
    const caption = (): string => p.group("General").all("toggle-hint")[0]?.textContent ?? "";
    const without = "Hidden on the desktop. Turn them back on here or from the menu bar.";
    p.rerender({ settings: { ...p.settings(), shortcuts: { ...D, enabled: false } } });
    expect(caption()).toBe(without);
    p.rerender({ settings: { ...p.settings(), shortcuts: { ...D, toggleLyrics: "" } } });
    expect(caption()).toBe(without);
    p.rerender({ settings: { ...p.settings(), shortcuts: D }, shortcuts: { ...OK, toggleLyrics: "unavailable" } });
    expect(caption()).toBe(without);
    p.rerender({ shortcuts: { ...OK, toggleLyrics: "invalid" } });
    expect(caption()).toBe(without);
    // an older core, with no status at all: the binding is shown
    p.rerender({ shortcuts: null });
    expect(caption()).toContain("or with ⌥⇧⌘L.");
  });

  it("says when the OS refused the login item, and forgets it once that clears", () => {
    const p = mount("mac");
    const note = p.group("General").one("login-note");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toBe("");
    p.rerender({ loginError: true });
    expect(note.textContent).toBe("Couldn't change Undertone's login item. Try again, or check System Settings › General › Login Items.");
    p.rerender({ loginError: false });
    expect(note.textContent).toBe("");
    const win = mount("windows");
    win.rerender({ loginError: true });
    expect(win.group("General").one("login-note").textContent).toBe("Couldn't change Undertone's login item. Try again, or check Settings › Apps › Startup.");
  });
});

describe("Behavior: When and Where, not to be confused with the lyrics switch", () => {
  it("names its rows When and Where, and speaks them in full", () => {
    const p = mount();
    const behavior = p.group("Behavior");
    const labels = behavior.all("row-label").map((l) => l.textContent);
    expect(labels).toEqual(["When", "Where"]);
    const groups = behavior.all("seg");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["When to show lyrics", "Where to show lyrics"]);
    expect(groups.map((g) => g.getAttribute("aria-labelledby"))).toEqual([null, null]);
    expect(groups[0]?.all("opt-label").map((o) => o.textContent)).toEqual(["While playing", "Always"]);
    expect(p.root.textContent).not.toContain("Show lyrics");
  });
});

describe("the preview says when the lyrics are off on the desktop", () => {
  it("shows a calm pill while `enabled` is false, and keeps playing", () => {
    const bridge = { kind: "mock", invoke: () => Promise.resolve(null), listen: () => Promise.resolve(() => undefined) } as unknown as Bridge;
    const preview = new SettingsPreview({ bridge, palettes: new PaletteCache(async () => null), settings: { ...structuredClone(DEFAULT_SETTINGS), enabled: false } });
    const pill = (preview.el as unknown as FakeElement).one("pv-off");
    expect(pill.hidden).toBe(false);
    expect(pill.textContent).toBe("Off on the desktop");
    preview.setSettings(structuredClone(DEFAULT_SETTINGS));
    expect(pill.hidden).toBe(true);
    preview.setSettings({ ...structuredClone(DEFAULT_SETTINGS), enabled: false });
    expect(pill.hidden).toBe(false);
    // settings from an older core, without the field: on
    const old: Partial<Settings> = structuredClone(DEFAULT_SETTINGS);
    delete old.enabled;
    preview.setSettings(old as Settings);
    expect(pill.hidden).toBe(true);
    preview.dispose();
  });
});

describe("Shortcuts: the rows", () => {
  it("shows each binding in macOS glyphs, ⌃⌥⇧⌘ order, and speaks it", () => {
    const p = mount("mac");
    expect(p.rows.map((r) => r.one("row-label").textContent)).toEqual(["Show or hide lyrics", "Nudge earlier (+50 ms)", "Nudge later (−50 ms)"]);
    expect(p.keys.map((k) => k.textContent)).toEqual(["⌥⇧⌘L", "⌥⇧⌘]", "⌥⇧⌘["]);
    expect(p.toggleKey.getAttribute("aria-label")).toBe("Show or hide lyrics: Option Shift Command L");
    expect(p.earlierKey.getAttribute("aria-label")).toBe("Nudge earlier (+50 ms): Option Shift Command Right Bracket");
    expect(p.toggleKey.type).toBe("button");
    expect(p.toggleKey.getAttribute("aria-describedby")).toBe(p.message(0).id);
    expect(p.message(0).getAttribute("aria-live")).toBe("polite");
  });

  it("shows them as Ctrl+Alt+Shift+L on Windows", () => {
    const p = mount("windows");
    expect(p.keys.map((k) => k.textContent)).toEqual(["Ctrl+Alt+Shift+L", "Ctrl+Alt+Shift+]", "Ctrl+Alt+Shift+["]);
    expect(p.laterKey.getAttribute("aria-label")).toBe("Nudge later (−50 ms): Control Alt Shift Left Bracket");
  });

  it("shows None for an action without a shortcut", () => {
    const p = mount("mac", { shortcuts: { ...D, nudgeLater: "" } });
    expect(p.laterKey.textContent).toBe("None");
    expect(p.laterKey.classList.contains("is-none")).toBe(true);
    expect(p.laterKey.getAttribute("aria-label")).toBe("Nudge later (−50 ms): no shortcut");
  });

  it("warns under a combination another app holds, or one that isn't usable", () => {
    const p = mount("mac", {}, { toggleLyrics: "unavailable", nudgeEarlier: "invalid", nudgeLater: "ok" });
    expect([0, 1, 2].map((i) => p.message(i).textContent)).toEqual(["Another app is using this combination.", "Not a usable combination.", ""]);
    expect([0, 1, 2].map((i) => p.message(i).getAttribute("data-tone"))).toEqual(["warn", "warn", null]);
    expect(p.toggleKey.classList.contains("is-warning")).toBe(true);
    expect(p.laterKey.classList.contains("is-warning")).toBe(false);
    // the warning goes once the core says it works
    p.rerender({ shortcuts: OK });
    expect(p.message(0).textContent).toBe("");
    // an older core: no status, no warnings
    p.rerender({ shortcuts: null });
    expect(p.message(1).textContent).toBe("");
  });

  it("turned off: the switch edits the whole object; the rows dim and go inert", () => {
    const p = mount("mac");
    const rows = p.group("Shortcuts").one("sc-rows");
    const master = switchIn(p.group("Shortcuts"), "Keyboard shortcuts");
    expect(rows.hasAttribute("inert")).toBe(false);
    flip(master, false);
    expect(p.edits).toEqual([{ shortcuts: { ...D, enabled: false } }]);
    expect(rows.hasAttribute("inert")).toBe(true);
    expect(rows.classList.contains("is-disabled")).toBe(true);
    expect(p.group("Shortcuts").all("toggle-hint")[0]?.textContent).toBe("Off. Other apps can use these keys.");
    flip(master, true);
    expect(rows.hasAttribute("inert")).toBe(false);
    expect(p.group("Shortcuts").all("toggle-hint")[0]?.textContent).toBe("They work from any app, even with Settings closed.");
  });

  it("Reset shortcuts restores the three default bindings, keeping the switch; inert at the defaults", () => {
    const p = mount("mac", { shortcuts: { enabled: true, toggleLyrics: "Control+Alt+K", nudgeEarlier: "", nudgeLater: D.nudgeLater } });
    const reset = p.group("Shortcuts").withText("Reset shortcuts");
    expect(reset.getAttribute("aria-disabled")).toBeNull();
    reset.click();
    expect(p.edits).toEqual([{ shortcuts: D }]);
    expect(p.spoken()).toBe("Shortcuts are back to their defaults");
    expect(reset.getAttribute("aria-disabled")).toBe("true");
    reset.click();
    expect(p.edits).toHaveLength(1);
  });
});

describe("Shortcuts: recording a new one", () => {
  const cmdOpt = { metaKey: true, altKey: true };

  it("listens on click: suspends the shortcuts, says Press keys…, and keeps focus on the button", () => {
    const p = mount("mac");
    p.toggleKey.click();
    expect(p.suspends).toEqual([true]);
    expect(p.toggleKey.textContent).toBe("Press keys…");
    expect(p.toggleKey.classList.contains("is-recording")).toBe(true);
    expect(p.toggleKey.getAttribute("aria-label")).toBe("Show or hide lyrics: listening for the new shortcut");
    // the prompt is on the foot's one line, so the rows below don't move down
    expect(p.message(0).textContent).toBe("");
    expect(p.hint().textContent).toBe("Esc cancels, Delete clears");
    expect(p.hint().getAttribute("aria-live")).toBe("polite");
    expect(activeElement()).toBe(p.toggleKey);
    p.toggleKey.key({ code: "Escape" });
    expect(p.hint().textContent).toBe("");
  });

  it("the prompt stays while listening moves from one row to another", () => {
    const p = mount("mac");
    p.toggleKey.click();
    p.laterKey.click();
    expect(p.hint().textContent).toBe("Esc cancels, Delete clears");
    p.laterKey.blur();
    expect(p.hint().textContent).toBe("");
  });

  it("keeps its width while listening, so wider held modifiers don't widen the key column", () => {
    const p = mount("windows");
    const button = p.toggleKey as unknown as { offsetWidth: number; style: Record<string, unknown> };
    button.offsetWidth = 126;
    p.toggleKey.click();
    expect(button.style["width"]).toBe("126px");
    p.toggleKey.key({ code: "MetaLeft", key: "Meta", metaKey: true, ctrlKey: true, altKey: true, shiftKey: true });
    expect(p.toggleKey.textContent).toBe("Win+Ctrl+Alt+Shift+…");
    p.toggleKey.key({ code: "Escape" });
    expect(button.style["width"]).toBe("");
  });

  it("shows the modifiers as they go down, then saves the combination, normalized", () => {
    const p = mount("mac");
    p.toggleKey.click();
    expect(p.toggleKey.key({ code: "AltLeft", key: "Alt", altKey: true }).defaultPrevented).toBe(true);
    expect(p.toggleKey.textContent).toBe("⌥…");
    p.toggleKey.key({ code: "MetaLeft", key: "Meta", ...cmdOpt });
    expect(p.toggleKey.textContent).toBe("⌥⌘…");
    p.toggleKey.key({ code: "MetaLeft", key: "Meta", altKey: true }, "keyup");
    expect(p.toggleKey.textContent).toBe("⌥…");
    const e = p.toggleKey.key({ code: "KeyK", key: "˚", ...cmdOpt });
    expect(e.defaultPrevented).toBe(true);
    expect(p.edits).toEqual([{ shortcuts: { ...D, toggleLyrics: "CmdOrCtrl+Alt+K" } }]);
    expect(p.suspends).toEqual([true, false]);
    expect(p.toggleKey.textContent).toBe("⌥⌘K");
    expect(p.toggleKey.classList.contains("is-recording")).toBe(false);
    expect(p.message(0).textContent).toBe("");
    expect(p.spoken()).toBe("Show or hide lyrics: Option Command K");
  });

  it("records Ctrl as CmdOrCtrl on Windows", () => {
    const p = mount("windows");
    p.earlierKey.click();
    p.earlierKey.key({ code: "Digit9", key: "9", ctrlKey: true, shiftKey: true });
    expect(p.edits).toEqual([{ shortcuts: { ...D, nudgeEarlier: "CmdOrCtrl+Shift+9" } }]);
    expect(p.earlierKey.textContent).toBe("Ctrl+Shift+9");
  });

  it("Esc cancels and keeps the binding", () => {
    const p = mount("mac");
    p.toggleKey.click();
    expect(p.toggleKey.key({ code: "Escape", key: "Escape" }).defaultPrevented).toBe(true);
    expect(p.edits).toEqual([]);
    expect(p.suspends).toEqual([true, false]);
    expect(p.toggleKey.textContent).toBe("⌥⇧⌘L");
    expect(p.spoken()).toBe("Shortcut unchanged");
    expect(activeElement()).toBe(p.toggleKey);
  });

  it("Delete or Backspace clears it to None", () => {
    for (const code of ["Backspace", "Delete"]) {
      const p = mount("mac");
      p.laterKey.click();
      expect(p.laterKey.key({ code }).defaultPrevented).toBe(true);
      expect(p.edits).toEqual([{ shortcuts: { ...D, nudgeLater: "" } }]);
      expect(p.laterKey.textContent).toBe("None");
      expect(p.suspends).toEqual([true, false]);
      expect(p.spoken()).toBe("Nudge later (−50 ms): no shortcut");
    }
  });

  it("turns down a combination another action has, and keeps listening", () => {
    const p = mount("mac");
    p.toggleKey.click();
    p.toggleKey.key({ code: "BracketRight", key: "]", metaKey: true, altKey: true, shiftKey: true });
    expect(p.edits).toEqual([]);
    expect(p.message(0).textContent).toBe("⌥⇧⌘] is already used for Nudge earlier.");
    expect(p.message(0).getAttribute("data-tone")).toBe("error");
    expect(p.toggleKey.classList.contains("is-recording")).toBe(true);
    expect(p.suspends).toEqual([true]);
    // the next try works
    p.toggleKey.key({ code: "KeyJ", key: "j", ...cmdOpt });
    expect(p.edits).toEqual([{ shortcuts: { ...D, toggleLyrics: "CmdOrCtrl+Alt+J" } }]);
  });

  it("asks for a modifier, and turns down keys no shortcut can use", () => {
    const mac = mount("mac");
    mac.toggleKey.click();
    expect(mac.toggleKey.key({ code: "KeyK" }).defaultPrevented).toBe(true);
    expect(mac.message(0).textContent).toBe("Hold ⌘, ⌥ or ⌃ with the key.");
    mac.toggleKey.key({ code: "KeyK", shiftKey: true });
    expect(mac.message(0).textContent).toBe("Hold ⌘, ⌥ or ⌃ with the key.");
    mac.toggleKey.key({ code: "NumpadAdd", key: "+", altKey: true });
    expect(mac.message(0).textContent).toBe("That key can't be part of a shortcut.");
    // Space and Enter alone don't click the button out of listening
    expect(mac.toggleKey.key({ code: "Space", key: " " }).defaultPrevented).toBe(true);
    expect(mac.toggleKey.key({ code: "Enter", key: "Enter" }).defaultPrevented).toBe(true);
    expect(mac.toggleKey.classList.contains("is-recording")).toBe(true);
    expect(mac.edits).toEqual([]);

    const win = mount("windows");
    win.toggleKey.click();
    win.toggleKey.key({ code: "KeyK" });
    expect(win.message(0).textContent).toBe("Hold Ctrl or Alt with the key.");
  });

  it("saving the binding it already has changes nothing", () => {
    const p = mount("mac");
    p.toggleKey.click();
    p.toggleKey.key({ code: "KeyL", metaKey: true, altKey: true, shiftKey: true });
    expect(p.edits).toEqual([]);
    expect(p.suspends).toEqual([true, false]);
    expect(p.toggleKey.classList.contains("is-recording")).toBe(false);
  });

  it("Tab moves on (not taken as a shortcut), and leaving the button cancels", () => {
    const p = mount("mac");
    p.toggleKey.click();
    expect(p.toggleKey.key({ code: "Tab", key: "Tab" }).defaultPrevented).toBe(false);
    expect(p.toggleKey.key({ code: "Tab", key: "Tab", shiftKey: true }).defaultPrevented).toBe(false);
    p.earlierKey.focus();
    expect(p.toggleKey.classList.contains("is-recording")).toBe(false);
    expect(p.suspends).toEqual([true, false]);
    expect(p.edits).toEqual([]);
  });

  it("a click elsewhere, a second pointer click, or the window losing focus cancels", () => {
    const p = mount("mac");
    p.toggleKey.click();
    p.toggleKey.blur();
    expect(p.suspends).toEqual([true, false]);

    p.toggleKey.click();
    p.toggleKey.click();
    expect(p.toggleKey.classList.contains("is-recording")).toBe(false);
    expect(p.suspends).toEqual([true, false, true, false]);

    p.toggleKey.click();
    p.panel.cancelRecording();
    expect(p.toggleKey.classList.contains("is-recording")).toBe(false);
    expect(p.suspends).toEqual([true, false, true, false, true, false]);
    // nothing to cancel: no extra resume
    p.panel.cancelRecording();
    expect(p.suspends).toHaveLength(6);
  });

  it("a keyboard click while listening, or the Space that just saved, doesn't restart", () => {
    const p = mount("mac");
    p.toggleKey.click();
    p.toggleKey.click({ detail: 0 });
    expect(p.toggleKey.classList.contains("is-recording")).toBe(true);
    // ⌃Space saves on keydown; its keyup (where a button clicks on Space) is held back
    p.toggleKey.key({ code: "Space", key: " ", ctrlKey: true });
    expect(p.toggleKey.key({ code: "Space", key: " " }, "keyup").defaultPrevented).toBe(true);
    expect(p.toggleKey.classList.contains("is-recording")).toBe(false);
    expect(p.edits).toEqual([{ shortcuts: { ...D, toggleLyrics: "Control+Space" } }]);
    expect(p.suspends).toEqual([true, false]);
    // only that keyup: the next Space starts again
    expect(p.toggleKey.key({ code: "Space", key: " " }, "keyup").defaultPrevented).toBe(false);
    p.toggleKey.click({ detail: 0 });
    expect(p.toggleKey.classList.contains("is-recording")).toBe(true);
    // an engine that clicks before the keyup: that one click is swallowed instead
    p.toggleKey.key({ code: "Space", key: " ", altKey: true });
    p.toggleKey.click({ detail: 0 });
    expect(p.toggleKey.classList.contains("is-recording")).toBe(false);
    p.toggleKey.click({ detail: 0 });
    expect(p.toggleKey.classList.contains("is-recording")).toBe(true);
    // a combination with another key holds nothing back
    p.toggleKey.key({ code: "KeyJ", metaKey: true, altKey: true });
    p.toggleKey.click({ detail: 0 });
    expect(p.toggleKey.classList.contains("is-recording")).toBe(true);
  });

  it("one row listens at a time", () => {
    const p = mount("mac");
    p.toggleKey.click();
    // focus moving to the other button cancels the first; even without a blur, starting one stops the rest
    p.laterKey.click();
    expect(p.toggleKey.classList.contains("is-recording")).toBe(false);
    expect(p.laterKey.classList.contains("is-recording")).toBe(true);
    expect(p.suspends).toEqual([true, false, true]);
  });

  it("gives up after a while, before the core's own safety resume, and says so briefly", () => {
    vi.useFakeTimers();
    const p = mount("mac");
    p.toggleKey.click();
    vi.advanceTimersByTime(RECORD_TIMEOUT_MS - 1);
    expect(p.suspends).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(p.suspends).toEqual([true, false]);
    expect(RECORD_TIMEOUT_MS).toBeLessThan(30_000);
    expect(p.message(0).textContent).toBe("Stopped listening. Click to try again.");
    vi.advanceTimersByTime(NOTE_MS);
    expect(p.message(0).textContent).toBe("");
  });

  it("stops listening when shortcuts are turned off", () => {
    const p = mount("mac");
    p.toggleKey.click();
    p.rerender({ settings: { ...p.settings(), shortcuts: { ...D, enabled: false } } });
    expect(p.toggleKey.classList.contains("is-recording")).toBe(false);
    expect(p.suspends).toEqual([true, false]);
  });

  it("while listening, the row keeps its status warning in place (the button drops its warning ring)", () => {
    const p = mount("mac", {}, { ...OK, toggleLyrics: "unavailable" });
    p.toggleKey.click();
    expect(p.message(0).textContent).toBe("Another app is using this combination.");
    expect(p.toggleKey.classList.contains("is-warning")).toBe(false);
    expect(p.hint().textContent).toBe("Esc cancels, Delete clears");
    p.toggleKey.key({ code: "Escape" });
    expect(p.message(0).textContent).toBe("Another app is using this combination.");
    expect(p.toggleKey.classList.contains("is-warning")).toBe(true);
  });

  it("turns down combinations every app relies on, and keeps listening", () => {
    const mac = mount("mac");
    mac.earlierKey.click();
    mac.earlierKey.key({ code: "KeyC", key: "c", metaKey: true });
    expect(mac.message(1).textContent).toBe("⌘C copies in every app. Choose another combination.");
    mac.earlierKey.key({ code: "KeyQ", key: "q", metaKey: true });
    expect(mac.message(1).textContent).toBe("⌘Q quits apps. Choose another combination.");
    mac.earlierKey.key({ code: "Space", key: " ", metaKey: true });
    expect(mac.message(1).textContent).toBe("⌘Space opens Spotlight. Choose another combination.");
    expect(mac.earlierKey.classList.contains("is-recording")).toBe(true);
    expect(mac.edits).toEqual([]);
    // with another modifier it's a different combination
    mac.earlierKey.key({ code: "KeyC", key: "c", metaKey: true, shiftKey: true });
    expect(mac.edits).toEqual([{ shortcuts: { ...D, nudgeEarlier: "CmdOrCtrl+Shift+C" } }]);

    const win = mount("windows");
    win.earlierKey.click();
    win.earlierKey.key({ code: "F4", key: "F4", altKey: true });
    expect(win.message(1).textContent).toBe("Alt+F4 closes the window. Choose another combination.");
    win.earlierKey.key({ code: "KeyV", key: "v", ctrlKey: true });
    expect(win.message(1).textContent).toBe("Ctrl+V pastes in every app. Choose another combination.");
    expect(win.edits).toEqual([]);
  });

  it("on Windows, saves a Ctrl+Alt shortcut on a typing key but says it may take an AltGr character", () => {
    vi.useFakeTimers();
    const win = mount("windows");
    win.earlierKey.click();
    win.earlierKey.key({ code: "KeyQ", key: "@", ctrlKey: true, altKey: true });
    expect(win.edits).toEqual([{ shortcuts: { ...D, nudgeEarlier: "CmdOrCtrl+Alt+Q" } }]);
    expect(win.message(1).textContent).toBe(ALTGR_NOTE);
    vi.advanceTimersByTime(NOTE_MS);
    expect(win.message(1).textContent).toBe("");
    // with Shift, or on an F key, no note
    win.laterKey.click();
    win.laterKey.key({ code: "KeyQ", key: "Q", ctrlKey: true, altKey: true, shiftKey: true });
    win.toggleKey.click();
    win.toggleKey.key({ code: "F9", key: "F9", ctrlKey: true, altKey: true });
    expect(win.edits).toHaveLength(3);
    expect([win.message(0).textContent, win.message(2).textContent]).toEqual(["", ""]);
    // a Mac has no AltGr
    const mac = mount("mac");
    mac.earlierKey.click();
    mac.earlierKey.key({ code: "KeyQ", ctrlKey: true, altKey: true });
    expect(mac.edits).toEqual([{ shortcuts: { ...D, nudgeEarlier: "Control+Alt+Q" } }]);
    expect(mac.message(1).textContent).toBe("");
  });

  it("on Windows, records a letter by what it types on the current layout, and turns down moved punctuation", async () => {
    // AZERTY: the key where US has Q types a; German: the key where US has [ types ü
    const layout = new Map([
      ["KeyQ", "a"],
      ["KeyA", "q"],
      ["BracketLeft", "ü"],
      ["Period", "."],
    ]);
    const asked: number[] = [];
    const keyLayout = (): Promise<KeyLayout | null> => {
      asked.push(1);
      return Promise.resolve(layout);
    };
    const win = mount("windows", {}, OK, keyLayout);
    win.toggleKey.click();
    await Promise.resolve();
    win.toggleKey.key({ code: "BracketLeft", key: "Ü", ctrlKey: true, altKey: true, shiftKey: true });
    expect(win.message(0).textContent).toBe("That key can't be a shortcut on this keyboard layout. Try a letter, a digit or an F key.");
    expect(win.edits).toEqual([]);
    win.toggleKey.key({ code: "KeyQ", key: "A", ctrlKey: true, altKey: true, shiftKey: true });
    expect(win.edits).toEqual([{ shortcuts: { ...D, toggleLyrics: "CmdOrCtrl+Alt+Shift+A" } }]);
    expect(win.toggleKey.textContent).toBe("Ctrl+Alt+Shift+A");
    // read again each time listening starts
    win.laterKey.click();
    expect(asked).toHaveLength(2);

    // a Mac registers by position: the layout isn't asked for
    const mac = mount("mac", {}, OK, keyLayout);
    mac.toggleKey.click();
    await Promise.resolve();
    mac.toggleKey.key({ code: "KeyQ", key: "a", metaKey: true, altKey: true });
    expect(mac.edits).toEqual([{ shortcuts: { ...D, toggleLyrics: "CmdOrCtrl+Alt+Q" } }]);
    expect(asked).toHaveLength(2);
  });
});

describe("Reset to defaults keeps the lyrics switch and the login item", () => {
  it("resets shortcuts with everything else, but not enabled or launchAtLogin", () => {
    const patch = defaultsPatch();
    expect(patch).not.toHaveProperty("enabled");
    expect(patch).not.toHaveProperty("launchAtLogin");
    expect(patch).not.toHaveProperty("version");
    expect(patch).not.toHaveProperty("trackOffsetsMs");
    expect(patch.shortcuts).toEqual(D);
    const mine: Settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      mode: "lens",
      enabled: false,
      launchAtLogin: true,
      shortcuts: { enabled: false, toggleLyrics: "", nudgeEarlier: "Control+Alt+K", nudgeLater: D.nudgeLater },
      trackOffsetsMs: { a: 100 },
    };
    expect(applyWrite(mine, { kind: "patch", patch })).toEqual({ ...structuredClone(DEFAULT_SETTINGS), enabled: false, launchAtLogin: true, trackOffsetsMs: { a: 100 } });
  });

  it("says so in its confirmation", () => {
    const p = mount();
    const confirm = p.root.one("confirm");
    expect(confirm.textContent).toContain("shortcuts go back to how Undertone started");
    expect(confirm.textContent).toContain("Lyrics on the desktop and Launch at login stay as they are.");
  });
});

describe("SettingsSync for contract v3", () => {
  const settled = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it("editNow sends earlier edits first, then the switch as its own save", async () => {
    const sent: Partial<Settings>[] = [];
    const sync = new SettingsSync({
      bridge: {
        invoke: ((_: string, args: { patch: Partial<Settings> }) => {
          sent.push(args.patch);
          return Promise.resolve({ ...structuredClone(DEFAULT_SETTINGS), ...args.patch });
        }) as Bridge["invoke"],
      },
      initial: structuredClone(DEFAULT_SETTINGS),
      onChange: () => undefined,
    });
    sync.edit({ size: 40 });
    sync.editNow({ launchAtLogin: true });
    expect(sync.view).toMatchObject({ size: 40, launchAtLogin: true });
    await settled();
    expect(sent).toEqual([{ size: 40 }, { launchAtLogin: true }]);
  });

  it("a refused save reports which write failed, and the view falls back to the core's settings", async () => {
    const failures: [unknown, Write][] = [];
    const views: Settings[] = [];
    const sync = new SettingsSync({
      bridge: { invoke: (() => Promise.reject(new Error("login item"))) as Bridge["invoke"] },
      initial: structuredClone(DEFAULT_SETTINGS),
      onChange: (v) => views.push(v),
      onError: (error, write) => failures.push([error, write]),
    });
    sync.editNow({ launchAtLogin: true });
    expect(views[views.length - 1]?.launchAtLogin).toBe(true);
    await settled();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.[1]).toEqual({ kind: "patch", patch: { launchAtLogin: true } });
    expect(views[views.length - 1]?.launchAtLogin).toBe(false);
  });

  it("fills the v3 fields of settings from an older core with their defaults", () => {
    const old: Partial<Settings> = { ...structuredClone(DEFAULT_SETTINGS), mode: "drift" };
    delete old.enabled;
    delete old.launchAtLogin;
    delete old.shortcuts;
    expect(withDefaults(old as Settings)).toEqual({ ...structuredClone(DEFAULT_SETTINGS), mode: "drift" });
    const complete = structuredClone(DEFAULT_SETTINGS);
    expect(withDefaults(complete)).toBe(complete);
    const sync = new SettingsSync({ bridge: { invoke: (() => Promise.resolve(null)) as Bridge["invoke"] }, initial: old as Settings, onChange: () => undefined });
    expect(sync.view.shortcuts).toEqual(D);
    sync.receive(old as Settings);
    expect(sync.view.enabled).toBe(true);
  });
});
