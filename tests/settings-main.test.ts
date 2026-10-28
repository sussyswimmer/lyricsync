import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings, type ShortcutsStatus } from "../contract/contract";
import type { Bridge } from "../src/bridge/types";
import { isBrowserKey } from "../src/settings/browser-keys";
import { activeElement, resetDom, runFrames, stubDom, type FakeElement } from "./fake-dom";

/*
 * The settings window as main.ts boots it, on a scripted bridge: shortcut status (subscribe, then
 * read), suspending the shortcuts in order while a row records, a refused login item, Reset to
 * defaults keeping the two General switches, saving before the window hides, and the browser keys
 * and context menu it turns off in the app.
 */

const env = vi.hoisted(() => ({ bridge: null as unknown, onInfo: null as ((info: unknown) => void) | null }));
vi.mock("../src/bridge", () => ({ connect: () => Promise.resolve(env.bridge) }));
// The preview draws and animates; the window only needs it to exist, and to hear what it shows.
vi.mock("../src/settings/preview", () => ({
  SettingsPreview: class {
    el = document.createElement("section");
    constructor(options: { onInfo?: (info: unknown) => void }) {
      env.onInfo = options.onInfo ?? null;
    }
    start(): Promise<void> {
      return Promise.resolve();
    }
    setSettings(): void {}
    setMainTrack(): void {}
  },
}));

const OK: ShortcutsStatus = { toggleLyrics: "ok", nudgeEarlier: "ok", nudgeLater: "ok" };

type Reply = (args: Record<string, unknown>) => Promise<unknown>;

/** A core that answers from `replies` (or sensibly), logs every call, and can send events. */
function scriptedBridge(replies: Record<string, Reply> = {}, kind: Bridge["kind"] = "tauri") {
  let settings: Settings = structuredClone(DEFAULT_SETTINGS);
  const log: string[] = [];
  const invoked: { name: string; args: Record<string, unknown> }[] = [];
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  const defaults: Record<string, Reply> = {
    get_settings: () => Promise.resolve(structuredClone(settings)),
    get_now_playing: () => Promise.resolve(null),
    get_media_status: () => Promise.resolve({ source: null, problem: null }),
    get_shortcuts_status: () => Promise.resolve({ ...OK }),
    suspend_shortcuts: () => Promise.resolve(),
    update_settings: (args) => {
      settings = { ...settings, ...(args["patch"] as Partial<Settings>) };
      return Promise.resolve(structuredClone(settings));
    },
  };
  const bridge = {
    kind,
    invoke(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
      log.push(`invoke ${name}`);
      invoked.push({ name, args });
      const reply = replies[name] ?? defaults[name];
      return reply ? reply(args) : Promise.resolve(undefined);
    },
    listen(name: string, fn: (payload: unknown) => void): Promise<() => void> {
      log.push(`listen ${name}`);
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
      return Promise.resolve(() => undefined);
    },
  };
  return {
    bridge: bridge as unknown as Bridge,
    log,
    invoked,
    emit(name: string, payload: unknown): void {
      for (const fn of handlers.get(name) ?? []) fn(payload);
    },
    calls: (name: string) => invoked.filter((c) => c.name === name).map((c) => c.args),
  };
}

type Listener = (e?: unknown) => void;
let windowListeners: Map<string, Listener[]>;
let documentListeners: Map<string, Listener[]>;
let page: { visibilityState: string };

/** Runs the page's listeners for `type` on `target` with an event carrying `init`; returns the event. */
function fire(target: Map<string, Listener[]>, type: string, init: Record<string, unknown> = {}): { defaultPrevented: boolean } {
  const event = {
    ...init,
    type,
    defaultPrevented: Boolean(init["defaultPrevented"]),
    preventDefault(): void {
      event.defaultPrevented = true;
    },
  };
  for (const fn of target.get(type) ?? []) fn(event);
  return event;
}

function stubWindow(): void {
  windowListeners = new Map();
  documentListeners = new Map();
  const host = document.createElement("main") as unknown as FakeElement;
  host.id = "app";
  const doc = document as unknown as Record<string, unknown>;
  page = {
    ...doc,
    createElement: doc["createElement"],
    createElementNS: doc["createElementNS"],
    get activeElement() {
      return activeElement();
    },
    getElementById: (id: string) => (id === "app" ? host : null),
    addEventListener: (type: string, fn: Listener) => documentListeners.set(type, [...(documentListeners.get(type) ?? []), fn]),
    visibilityState: "visible",
    documentElement: { style: {}, classList: { toggle: () => undefined } },
  } as { visibilityState: string };
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", {
    scrollY: 0,
    addEventListener: (type: string, fn: Listener) => windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
    },
  );
  vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)" });
  vi.stubGlobal("console", { ...console, warn: () => undefined });
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** Boots main.ts against `core`; returns the panel's root once it is on the page. */
async function boot(core: ReturnType<typeof scriptedBridge>): Promise<FakeElement> {
  env.bridge = core.bridge;
  vi.resetModules();
  await import("../src/settings/main");
  const host = (document as unknown as { getElementById(id: string): FakeElement }).getElementById("app");
  await vi.waitFor(() => expect(host.children.length).toBe(2));
  await settle();
  return host.children[1] as FakeElement;
}

const shortcutsGroup = (root: FakeElement): FakeElement => {
  const group = root.all("group").find((g) => g.one("group-title").textContent === "Shortcuts");
  if (!group) throw new Error("no Shortcuts group");
  return group;
};
const messages = (root: FakeElement): string[] => shortcutsGroup(root).all("sc-msg").map((m) => m.textContent);

beforeEach(() => {
  resetDom();
  stubDom();
  stubWindow();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("settings window: shortcut status", () => {
  it("subscribes to shortcuts-status before asking for it, and shows what the core reports", async () => {
    const core = scriptedBridge({ get_shortcuts_status: () => Promise.resolve({ ...OK, nudgeLater: "unavailable" }) });
    const root = await boot(core);
    expect(core.log.indexOf("listen shortcuts-status")).toBeGreaterThanOrEqual(0);
    expect(core.log.indexOf("listen shortcuts-status")).toBeLessThan(core.log.indexOf("invoke get_shortcuts_status"));
    expect(messages(root)).toEqual(["", "", "Another app is using this combination."]);
    core.emit("shortcuts-status", OK);
    expect(messages(root)).toEqual(["", "", ""]);
  });

  it("an event that beats the reply wins", async () => {
    let answer: (s: ShortcutsStatus) => void = () => undefined;
    const core = scriptedBridge({ get_shortcuts_status: () => new Promise((resolve) => (answer = resolve)) });
    env.bridge = core.bridge;
    vi.resetModules();
    await import("../src/settings/main");
    await vi.waitFor(() => expect(core.log).toContain("invoke get_shortcuts_status"));
    core.emit("shortcuts-status", { ...OK, toggleLyrics: "invalid" });
    answer({ ...OK });
    const host = (document as unknown as { getElementById(id: string): FakeElement }).getElementById("app");
    await vi.waitFor(() => expect(host.children.length).toBe(2));
    expect(messages(host.children[1] as FakeElement)[0]).toBe("Not a usable combination.");
  });

  it("with an older core that rejects both v3 commands, rows show no status and recording still works", async () => {
    const core = scriptedBridge({
      get_shortcuts_status: () => Promise.reject(new Error("unknown command")),
      suspend_shortcuts: () => Promise.reject(new Error("unknown command")),
    });
    const root = await boot(core);
    expect(messages(root)).toEqual(["", "", ""]);
    const key = shortcutsGroup(root).all("sc-key")[0] as FakeElement;
    key.click();
    key.key({ code: "KeyK", metaKey: true, altKey: true });
    await settle();
    expect(core.calls("suspend_shortcuts")).toEqual([{ suspended: true }, { suspended: false }]);
    expect(key.textContent).toBe("⌥⌘K");
  });
});

describe("settings window: an older core", () => {
  it("boots on settings without the contract v3 fields, showing their defaults", async () => {
    const old: Partial<Settings> = structuredClone(DEFAULT_SETTINGS);
    delete old.enabled;
    delete old.launchAtLogin;
    delete old.shortcuts;
    const core = scriptedBridge({ get_settings: () => Promise.resolve(old) });
    const root = await boot(core);
    expect(shortcutsGroup(root).all("sc-key").map((k) => k.textContent)).toEqual(["⌥⇧⌘L", "⌥⇧⌘]", "⌥⇧⌘["]);
    const general = root.all("group").find((g) => g.one("group-title").textContent === "General") as FakeElement;
    expect(general.all("switch").map((s) => s.checked)).toEqual([true, false]);
  });
});

describe("settings window: suspending the shortcuts while a row records", () => {
  it("sends true then false in order, even when the core answers the first one late", async () => {
    let release: () => void = () => undefined;
    let first = true;
    const core = scriptedBridge({
      suspend_shortcuts: () => {
        if (!first) return Promise.resolve();
        first = false;
        return new Promise<void>((resolve) => (release = resolve));
      },
    });
    const root = await boot(core);
    const key = shortcutsGroup(root).all("sc-key")[0] as FakeElement;
    key.click();
    key.key({ code: "Escape" });
    await settle();
    expect(core.calls("suspend_shortcuts")).toEqual([{ suspended: true }]);
    release();
    await settle();
    expect(core.calls("suspend_shortcuts")).toEqual([{ suspended: true }, { suspended: false }]);
  });

  it("the window losing focus or closing stops recording and resumes the shortcuts", async () => {
    for (const event of ["blur", "pagehide"]) {
      stubWindow(); // a fresh page for each
      const core = scriptedBridge();
      const root = await boot(core);
      const key = shortcutsGroup(root).all("sc-key")[1] as FakeElement;
      key.click();
      for (const fn of windowListeners.get(event) ?? []) fn();
      await settle();
      expect(key.classList.contains("is-recording"), event).toBe(false);
      expect(core.calls("suspend_shortcuts"), event).toEqual([{ suspended: true }, { suspended: false }]);
    }
  });

  it("a recorded shortcut is saved as the whole shortcuts object", async () => {
    vi.useFakeTimers();
    const core = scriptedBridge();
    const root = await boot(core);
    const key = shortcutsGroup(root).all("sc-key")[2] as FakeElement;
    key.click();
    key.key({ code: "F9", ctrlKey: true });
    await vi.advanceTimersByTimeAsync(200);
    expect(core.calls("update_settings")).toEqual([{ patch: { shortcuts: { ...DEFAULT_SETTINGS.shortcuts, nudgeLater: "Control+F9" } } }]);
  });
});

describe("settings window: Launch at login", () => {
  it("a refused login item snaps the switch back and says why; trying again clears it", async () => {
    let refuse = true;
    const core = scriptedBridge({
      update_settings: (args) => {
        const patch = args["patch"] as Partial<Settings>;
        if (patch.launchAtLogin !== undefined && refuse) return Promise.reject(new Error("SMAppService"));
        return Promise.resolve({ ...structuredClone(DEFAULT_SETTINGS), ...patch });
      },
    });
    const root = await boot(core);
    const general = root.all("group").find((g) => g.one("group-title").textContent === "General") as FakeElement;
    const login = general.all("switch")[1] as FakeElement;
    const note = general.one("login-note");
    login.checked = true;
    login.dispatch("change");
    // saved at once, on its own
    expect(core.calls("update_settings")).toEqual([{ patch: { launchAtLogin: true } }]);
    await settle();
    expect(login.checked).toBe(false);
    expect(note.textContent).toContain("Couldn't change Undertone's login item.");
    // the note is a status region itself: the panel's announcer doesn't say it a second time
    runFrames();
    expect(note.getAttribute("role")).toBe("status");
    expect(root.children.find((c) => c.getAttribute("role") === "status" && c.classList.contains("sr-only"))?.textContent).toBe("");
    refuse = false;
    login.checked = true;
    login.dispatch("change");
    expect(note.textContent).toBe("");
    await settle();
    expect(login.checked).toBe(true);
  });

  it("the note goes once the change succeeds elsewhere, and stays through other changes", async () => {
    const core = scriptedBridge({
      update_settings: () => Promise.reject(new Error("SMAppService")),
    });
    const root = await boot(core);
    const general = root.all("group").find((g) => g.one("group-title").textContent === "General") as FakeElement;
    const login = general.all("switch")[1] as FakeElement;
    const note = general.one("login-note");
    login.checked = true;
    login.dispatch("change");
    await settle();
    // the core's echo of the unchanged settings, after the refusal, and another window's unrelated change
    core.emit("settings-changed", structuredClone(DEFAULT_SETTINGS));
    core.emit("settings-changed", { ...structuredClone(DEFAULT_SETTINGS), size: 60 });
    expect(note.textContent).toContain("Couldn't change Undertone's login item.");
    // the menu's Launch at login turns it on
    core.emit("settings-changed", { ...structuredClone(DEFAULT_SETTINGS), size: 60, launchAtLogin: true });
    expect(login.checked).toBe(true);
    expect(note.textContent).toBe("");
  });
});

describe("settings window: Reset to defaults", () => {
  it("resets shortcuts but sends neither enabled nor launchAtLogin", async () => {
    const core = scriptedBridge({
      get_settings: () =>
        Promise.resolve({
          ...structuredClone(DEFAULT_SETTINGS),
          mode: "lens",
          enabled: false,
          launchAtLogin: true,
          shortcuts: { enabled: false, toggleLyrics: "", nudgeEarlier: "Control+Alt+K", nudgeLater: "" },
        }),
    });
    const root = await boot(core);
    root.withText("Reset to defaults…").click();
    root.withText("Reset").click();
    await settle();
    const [sent] = core.calls("update_settings");
    const patch = sent?.["patch"] as Partial<Settings>;
    expect(patch).not.toHaveProperty("enabled");
    expect(patch).not.toHaveProperty("launchAtLogin");
    expect(patch).not.toHaveProperty("trackOffsetsMs");
    expect(patch).toMatchObject({ mode: "arc", shortcuts: DEFAULT_SETTINGS.shortcuts });
  });

  it("with Also clear sync, sends one patch that empties the map, not one set_track_offset per song", async () => {
    const core = scriptedBridge({
      get_settings: () => Promise.resolve({ ...structuredClone(DEFAULT_SETTINGS), size: 90, trackOffsetsMs: { "a|one|x|200": 150, "b|two|y|180": -100 } }),
    });
    const root = await boot(core);
    root.withText("Reset to defaults…").click();
    const forget = root.one("check");
    expect(forget.textContent).toBe("Also clear sync for 2 songs");
    const box = forget.children[0] as FakeElement;
    box.checked = true;
    root.withText("Reset").click();
    await settle();
    expect(core.calls("set_track_offset")).toEqual([]);
    const sent = core.calls("update_settings");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.["patch"]).toMatchObject({ size: DEFAULT_SETTINGS.size, trackOffsetsMs: {} });
  });
});

describe("settings window: nothing is lost as the window goes away", () => {
  const lyricsSwitch = (root: FakeElement): FakeElement => {
    const general = root.all("group").find((g) => g.one("group-title").textContent === "General") as FakeElement;
    return general.all("switch")[0] as FakeElement;
  };

  it("an edit still waiting for its debounce goes out at once when the window hides, blurs or closes", async () => {
    for (const leave of ["hidden", "blur", "pagehide"]) {
      stubWindow(); // a fresh page for each
      const core = scriptedBridge();
      const root = await boot(core);
      const lyrics = lyricsSwitch(root);
      lyrics.checked = false;
      lyrics.dispatch("change");
      expect(core.calls("update_settings"), leave).toEqual([]);
      if (leave === "hidden") {
        page.visibilityState = "hidden";
        fire(documentListeners, "visibilitychange");
      } else {
        fire(windowListeners, leave);
      }
      expect(core.calls("update_settings"), leave).toEqual([{ patch: { enabled: false } }]);
    }
  });

  it("becoming visible again sends nothing", async () => {
    const core = scriptedBridge();
    const root = await boot(core);
    const lyrics = lyricsSwitch(root);
    lyrics.checked = false;
    lyrics.dispatch("change");
    fire(documentListeners, "visibilitychange");
    expect(core.calls("update_settings")).toEqual([]);
  });
});

describe("settings window: the look picked for the preview's song", () => {
  it("the card under the preview shows what the preview plays, as the preview reports it", async () => {
    const root = await boot(scriptedBridge());
    const card = root.one("picked");
    expect(card.one("picked-message").textContent).toBe("Finding lyrics…");
    const info = { track: null, demo: true, palette: null, paletteFrom: null, artPending: false };
    const look = { style: "drift", font: { family: "Instrument Serif", weight: 400 }, traits: ["cold cover", "slow", "long instrumental gaps"] };
    env.onInfo?.({ ...info, look: { kind: "look", key: "demo", demo: true, look } });
    expect(card.one("picked-kicker").textContent).toBe("Picked for the demo song");
    expect(card.one("picked-style").textContent).toBe("Drift");
    expect(card.one("picked-face").textContent).toBe("Instrument Serif");
    expect(card.one("picked-why").textContent).toBe("Cold cover, slow, long instrumental gaps.");
    env.onInfo?.({ ...info, demo: false, look: { kind: "no-lyrics", key: "song", demo: false } });
    expect(card.one("picked-message").textContent).toBe("No lyrics for this song");
  });

  it("has a Style picker but no font picker; Reset to defaults sends Effects back to 50, and the stored look fields too", async () => {
    const core = scriptedBridge({
      get_settings: () =>
        Promise.resolve({
          ...structuredClone(DEFAULT_SETTINGS),
          effects: 85,
          glow: 0,
          mode: "lens",
          font: { family: "Syne", weight: 800 },
          curve: -20,
        }),
    });
    const root = await boot(core);
    expect(root.all("group").map((g) => g.one("group-title").textContent)).toEqual(["Style", "General", "Color", "Look", "Behavior", "Sync", "Shortcuts"]);
    root.withText("Reset to defaults…").click();
    root.withText("Reset").click();
    await settle();
    const [sent] = core.calls("update_settings");
    expect(sent?.["patch"]).toMatchObject({ effects: 50, glow: 40, mode: "arc", font: { family: "Fraunces", weight: 700 }, curve: 38 });
  });
});

describe("settings window: a window, not a web page", () => {
  it("in the app, turns off the browser's context menu and its reload, print and find keys", async () => {
    vi.stubEnv("DEV", false); // a built app, release or debug
    await boot(scriptedBridge());
    expect(fire(documentListeners, "contextmenu").defaultPrevented).toBe(true);
    const key = (init: Record<string, unknown>): boolean =>
      fire(windowListeners, "keydown", { key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }).defaultPrevented;
    expect(key({ key: "F5", code: "F5" })).toBe(true);
    expect(key({ key: "r", code: "KeyR", ctrlKey: true })).toBe(true);
    expect(key({ key: "p", code: "KeyP", metaKey: true })).toBe(true);
    expect(key({ key: "ArrowLeft", code: "ArrowLeft", altKey: true })).toBe(true);
    // everything else is left alone: Tab, arrows on a slider, Space on a switch, ⌘W and ⌘Q
    for (const free of [{ key: "Tab", code: "Tab" }, { key: "ArrowLeft", code: "ArrowLeft" }, { key: " ", code: "Space" }, { key: "w", code: "KeyW", metaKey: true }, { key: "q", code: "KeyQ", metaKey: true }]) {
      expect(key(free), free.code).toBe(false);
    }
  });

  it("in `pnpm tauri dev`, keeps the context menu for Inspect Element, and still turns off the keys", async () => {
    vi.stubEnv("DEV", true);
    await boot(scriptedBridge());
    expect(fire(documentListeners, "contextmenu").defaultPrevented).toBe(false);
    expect(fire(windowListeners, "keydown", { key: "F5", code: "F5" }).defaultPrevented).toBe(true);
  });

  it("in the mock in a browser, keeps them for development", async () => {
    await boot(scriptedBridge({}, "mock"));
    expect(documentListeners.get("contextmenu") ?? []).toEqual([]);
    expect(fire(windowListeners, "keydown", { key: "F5", code: "F5" }).defaultPrevented).toBe(false);
  });

  it("isBrowserKey: reload, print, find, view source, caret browsing, back and forward", () => {
    const press = (key: string, code: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) =>
      isBrowserKey({ key, code, ctrlKey: false, metaKey: false, altKey: false, ...mods });
    for (const k of ["F3", "F5", "F7", "BrowserBack", "BrowserForward", "BrowserRefresh"]) expect(press(k, k), k).toBe(true);
    // with Shift too (a hard reload), and with either Ctrl or ⌘
    for (const [key, code] of [["R", "KeyR"], ["r", "KeyR"], ["p", "KeyP"], ["f", "KeyF"], ["g", "KeyG"], ["u", "KeyU"]] as const) {
      expect(press(key, code, { ctrlKey: true }), key).toBe(true);
      expect(press(key, code, { metaKey: true }), key).toBe(true);
      expect(press(key, code), key).toBe(false);
    }
    // a letter by what it types (Dvorak's u on the F key is Ctrl+U), or by place on a non-Latin layout
    expect(press("u", "KeyF", { ctrlKey: true })).toBe(true);
    expect(press("а", "KeyF", { ctrlKey: true })).toBe(true);
    expect(press("x", "KeyR", { ctrlKey: true })).toBe(false);
    expect(press("ArrowRight", "ArrowRight", { altKey: true })).toBe(true);
    expect(press("ArrowRight", "ArrowRight", { altKey: true, ctrlKey: true })).toBe(false);
    for (const [key, code] of [["w", "KeyW"], ["q", "KeyQ"], ["c", "KeyC"], ["[", "BracketLeft"]] as const) expect(press(key, code, { metaKey: true }), key).toBe(false);
  });
});
