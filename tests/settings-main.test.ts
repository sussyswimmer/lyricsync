import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings, type ShortcutsStatus } from "../contract/contract";
import type { Bridge } from "../src/bridge/types";
import { activeElement, resetDom, stubDom, type FakeElement } from "./fake-dom";

/*
 * The settings window as main.ts boots it, on a scripted bridge: shortcut status (subscribe, then
 * read), suspending the shortcuts in order while a row records, a refused login item, and Reset to
 * defaults keeping the two General switches.
 */

const env = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("../src/bridge", () => ({ connect: () => Promise.resolve(env.bridge) }));
// The preview draws and animates; the window only needs it to exist.
vi.mock("../src/settings/preview", () => ({
  SettingsPreview: class {
    el = document.createElement("section");
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
function scriptedBridge(replies: Record<string, Reply> = {}) {
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
    kind: "tauri",
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

let windowListeners: Map<string, (() => void)[]>;

function stubWindow(): void {
  windowListeners = new Map();
  const host = document.createElement("main") as unknown as FakeElement;
  host.id = "app";
  const doc = document as unknown as Record<string, unknown>;
  vi.stubGlobal("document", {
    ...doc,
    createElement: doc["createElement"],
    createElementNS: doc["createElementNS"],
    get activeElement() {
      return activeElement();
    },
    getElementById: (id: string) => (id === "app" ? host : null),
    addEventListener: () => undefined,
    visibilityState: "visible",
    documentElement: { style: {}, classList: { toggle: () => undefined } },
  });
  vi.stubGlobal("window", {
    scrollY: 0,
    addEventListener: (type: string, fn: () => void) => windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]),
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
    expect(patch).toMatchObject({ mode: "arc", shortcuts: DEFAULT_SETTINGS.shortcuts });
  });
});
