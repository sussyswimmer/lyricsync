import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type MediaStatus, type NowPlaying, type Settings } from "../contract/contract";
import { createMockBridge, type MockBridge } from "../src/bridge/mock";
import type { Bridge } from "../src/bridge/types";
import { PaletteCache } from "../src/core/palette";
import { GAP_GRACE_MS, TrackHold } from "../src/settings/hold";
import type { PanelState, SettingsPanel as Panel } from "../src/settings/panel";
import { SettingsPreview } from "../src/settings/preview";
import { applyWrite, clampTrackOffset, TRACK_OFFSET_LIMIT_MS } from "../src/settings/store";

/*
 * Regressions from the settings-window QA pass:
 * - settings-button-cascade: a page-wide `button { font; color }` reset outranked every button class.
 * - settings-nudge-focus: self-disabling sync buttons handed focus to the opposite action, and a brief
 *   "nothing playing" between songs disabled them all and dropped focus to <body>.
 * - settings-song-aria-live: the "This song" value was a live region rewritten on every render.
 * - settings-preview-bar: the preview's stage ran under its 22 px menu bar and a top mask, so at
 *   Height 0–15 the focus line the stage clamps into view was drawn behind the bar.
 * - media-status-preview: under the mock's `?media=` the preview stayed an empty "Nothing playing"
 *   stage, where the app plays the demo.
 */

// The preview's stage and controller draw and animate; choosing what it plays needs neither.
const previewFakes = vi.hoisted(() => {
  class Stage {
    setSettings(): void {}
    destroy(): void {}
  }
  class Controller {
    track: NowPlaying | null = null;
    private readonly bridge: Bridge;
    constructor(bridge: Bridge) {
      this.bridge = bridge;
    }
    async start(): Promise<void> {
      this.track = await this.bridge.invoke("get_now_playing");
    }
    setSettings(): void {}
    kick(): void {}
    destroy(): void {}
  }
  return { Stage, Controller };
});
vi.mock("../src/overlay/stage", () => ({ LyricStage: previewFakes.Stage }));
vi.mock("../src/overlay/controller", () => ({ OverlayController: previewFakes.Controller }));

// ---------- a DOM just big enough for SettingsPanel ----------

let active: FakeElement | null = null;
const frames: (() => void)[] = [];

class FakeElement {
  readonly tagName: string;
  className = "";
  id = "";
  type = "";
  name = "";
  value = "";
  min = "";
  max = "";
  step = "";
  title = "";
  hidden = false;
  checked = false;
  disabled = false;
  /** a label's `for` (a string), or an output's token list */
  htmlFor: unknown = { add: (): void => undefined };
  readonly dataset: Record<string, string> = {};
  readonly style = { setProperty: (): void => undefined, removeProperty: (): void => undefined } as Record<string, unknown>;
  readonly attrs = new Map<string, string>();
  readonly children: FakeElement[] = [];
  private readonly listeners = new Map<string, (() => void)[]>();
  private text = "";
  /** how many times textContent was assigned */
  textWrites = 0;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.textWrites++;
    this.children.length = 0;
    this.text = value;
  }
  get lastElementChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null;
  }
  readonly classList = {
    add: (...names: string[]): void => {
      const set = new Set(this.className.split(" ").filter(Boolean));
      for (const n of names) set.add(n);
      this.className = [...set].join(" ");
    },
    remove: (...names: string[]): void => {
      this.className = this.className
        .split(" ")
        .filter((c) => c && !names.includes(c))
        .join(" ");
    },
    toggle: (name: string, force?: boolean): boolean => {
      const on = force ?? !this.classList.contains(name);
      if (on) this.classList.add(name);
      else this.classList.remove(name);
      return on;
    },
    contains: (name: string): boolean => this.className.split(" ").includes(name),
  };
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  /**
   * What a keyboard press or a click does. A `disabled` button gets no click (and the browser drops its
   * focus), which is what the old code relied on; an aria-disabled one still gets it.
   */
  click(): void {
    if (this.disabled) return;
    for (const fn of this.listeners.get("click") ?? []) fn();
  }
  focus(): void {
    active = this;
  }
  scrollIntoView(): void {}
  /** A canvas without a 2D context: the mock's demo covers are left out, as outside a browser. */
  getContext(): null {
    return null;
  }
  /** Every descendant with this class, in document order. */
  all(className: string): FakeElement[] {
    const out: FakeElement[] = [];
    for (const c of this.children) {
      if (c.classList.contains(className)) out.push(c);
      out.push(...c.all(className));
    }
    return out;
  }
  one(className: string): FakeElement {
    const el = this.all(className)[0];
    if (!el) throw new Error(`no .${className}`);
    return el;
  }
  querySelector(selector: string): FakeElement | null {
    return this.all(selector.replace(/^\./, ""))[0] ?? null;
  }
}

function stubDom(): void {
  vi.stubGlobal("document", {
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    get activeElement() {
      return active;
    },
  });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
}

// The panel module draws its style icons when it loads, so the fake DOM has to be there first.
let SettingsPanel: typeof Panel;
beforeAll(async () => {
  stubDom();
  ({ SettingsPanel } = await import("../src/settings/panel"));
});

beforeEach(() => {
  active = null;
  frames.length = 0;
  stubDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const KEY = "artist|song|album|200000";
const TRACK = { key: KEY, title: "Placeholder Song", artist: "Nobody" };

/** A panel wired the way main.ts wires it: every action re-renders synchronously. */
function mountPanel(offsetMs = 0, track: PanelState["track"] = TRACK) {
  let settings: Settings = applyWrite(structuredClone(DEFAULT_SETTINGS), { kind: "track", trackKey: KEY, ms: offsetMs });
  const writes: { key: string; ms: number }[] = [];
  let state: PanelState = { settings, palette: null, paletteFor: null, artPending: false, track, media: null };
  const panel = new SettingsPanel({
    edit: (patch) => {
      settings = { ...settings, ...patch };
      panel.render((state = { ...state, settings }));
    },
    setTrackOffset: (key, ms) => {
      writes.push({ key, ms });
      settings = applyWrite(settings, { kind: "track", trackKey: key, ms });
      panel.render((state = { ...state, settings }));
    },
    reset: () => undefined,
  });
  panel.render(state);
  const root = panel.el as unknown as FakeElement;
  const steps = root.all("step");
  const [minus100, minus50, plus50, plus100] = steps;
  if (!minus100 || !minus50 || !plus50 || !plus100) throw new Error("four sync steps expected");
  const resetSong = root.all("link-btn").find((b) => b.textContent === "Reset this song");
  if (!resetSong) throw new Error("no Reset this song");
  return {
    panel,
    root,
    steps,
    minus100,
    plus50,
    plus100,
    resetSong,
    writes,
    value: root.one("song-value"),
    offset: (): number => settings.trackOffsetsMs[KEY] ?? 0,
    setTrack(next: PanelState["track"]): void {
      panel.render((state = { ...state, track: next }));
    },
    setMedia(next: MediaStatus | null): void {
      panel.render((state = { ...state, media: next }));
    },
    rerender(): void {
      // a fresh settings object with the same values, as a save echo or an unrelated edit brings
      settings = { ...settings };
      panel.render((state = { ...state, settings }));
    },
  };
}

const inert = (el: FakeElement): boolean => el.getAttribute("aria-disabled") === "true";
const spoken = (root: FakeElement): string => {
  for (const f of frames.splice(0)) f();
  // the panel's announcer, not the media notice (also a status region)
  return root.children.find((c) => c.getAttribute("role") === "status" && c.classList.contains("sr-only"))?.textContent ?? "";
};

describe("settings-nudge-focus: the sync buttons keep focus and never act backwards", () => {
  it("holding Enter on +100 climbs to the limit and stays there, focus never leaving +100", () => {
    const p = mountPanel();
    p.plus100.focus();
    for (let press = 0; press < 26; press++) (document.activeElement as unknown as FakeElement).click();
    expect(p.offset()).toBe(TRACK_OFFSET_LIMIT_MS);
    expect(document.activeElement).toBe(p.plus100);
    // 20 presses reach +2000; the six after it send nothing (no backwards −100 steps, no no-op IPC)
    expect(p.writes).toHaveLength(20);
    expect(p.writes.every((w, i) => w.ms === (i + 1) * 100)).toBe(true);
    // inert, not disabled: still focusable, still reachable by Tab
    expect(inert(p.plus100)).toBe(true);
    expect(inert(p.plus50)).toBe(true);
    expect(p.steps.some((b) => b.disabled)).toBe(false);
    expect(inert(p.minus100)).toBe(false);
    expect(p.plus100.getAttribute("title")).toBe("This song is at the +2000 ms limit");
  });

  it("a double Enter on Reset this song leaves 0 ms, not −100 ms", () => {
    const p = mountPanel(100);
    expect(inert(p.resetSong)).toBe(false);
    p.resetSong.focus();
    (document.activeElement as unknown as FakeElement).click();
    (document.activeElement as unknown as FakeElement).click();
    expect(p.offset()).toBe(0);
    expect(p.writes).toEqual([{ key: KEY, ms: 0 }]);
    expect(document.activeElement).toBe(p.resetSong);
    expect(inert(p.resetSong)).toBe(true);
    expect(p.resetSong.disabled).toBe(false);
  });

  it("a step past the limit is clamped, and the limit lifts as soon as the offset moves back", () => {
    const p = mountPanel(1950);
    p.plus100.click();
    expect(p.writes[p.writes.length - 1]).toEqual({ key: KEY, ms: TRACK_OFFSET_LIMIT_MS });
    expect(inert(p.plus100)).toBe(true);
    p.minus100.click();
    expect(p.offset()).toBe(1900);
    expect(inert(p.plus100)).toBe(false);
    expect(p.plus100.getAttribute("title")).toBeNull();
  });

  it("with nothing playing every sync button is inert but stays focusable, and comes back with a song", () => {
    const p = mountPanel(0);
    p.plus50.focus();
    p.setTrack(null);
    expect(p.steps.every(inert)).toBe(true);
    expect(inert(p.resetSong)).toBe(true);
    expect(p.steps.some((b) => b.disabled)).toBe(false);
    p.plus50.click();
    expect(p.writes).toHaveLength(0);
    p.setTrack(TRACK);
    expect(document.activeElement).toBe(p.plus50);
    p.plus50.click();
    expect(p.offset()).toBe(50);
  });
});

describe("settings-song-aria-live: nudges are announced once, with context", () => {
  it("the value is not a live region; the stepper group reads it as its description", () => {
    const p = mountPanel(50);
    expect(p.value.getAttribute("aria-live")).toBeNull();
    const stepper = p.root.one("stepper");
    expect(stepper.getAttribute("aria-describedby")).toBe(p.value.id);
    expect(p.value.id).not.toBe("");
  });

  it("re-rendering the same value never rewrites it", () => {
    const p = mountPanel(50);
    const before = p.value.textWrites;
    for (let i = 0; i < 15; i++) p.rerender();
    p.panel.render({ settings: { ...DEFAULT_SETTINGS, mode: "lens", trackOffsetsMs: { [KEY]: 50 } }, palette: null, paletteFor: null, artPending: false, track: TRACK, media: null });
    expect(p.value.textWrites).toBe(before);
    expect(p.value.textContent).toBe("+50 ms");
  });

  it("each nudge says the new value with context; a reset says it once", () => {
    const p = mountPanel(0);
    p.plus50.click();
    expect(spoken(p.root)).toBe("This song: +50 ms, lyrics earlier");
    p.minus100.click();
    expect(spoken(p.root)).toBe("This song: minus 50 ms, lyrics later");
    p.resetSong.click();
    expect(spoken(p.root)).toBe("This song's sync is back to 0");
    // nothing left to reset: no second announcement
    p.resetSong.click();
    expect(frames).toHaveLength(0);
  });

  it("the announcement says the clamped value the store saves", () => {
    const p = mountPanel(-1980);
    p.minus100.click();
    expect(spoken(p.root)).toBe("This song: minus 2000 ms, lyrics later");
  });

  it("a track change announces nothing", () => {
    const p = mountPanel(100);
    spoken(p.root);
    p.setTrack({ key: "other|song|x|1", title: "Other", artist: "Someone" });
    expect(frames).toHaveLength(0);
    expect(p.value.textContent).toBe("0 ms");
  });
});

describe("TrackHold: the panel's song rides out a brief gap between songs", () => {
  beforeEach(() => vi.useFakeTimers());

  it("keeps the last song through a gap shorter than the grace", () => {
    const seen: (string | null)[] = [];
    const hold = new TrackHold<string>("one", (v) => seen.push(v));
    hold.set(null);
    vi.advanceTimersByTime(GAP_GRACE_MS - 500);
    expect(hold.value).toBe("one");
    hold.set("two");
    vi.advanceTimersByTime(GAP_GRACE_MS * 3);
    expect(hold.value).toBe("two");
    expect(seen).toEqual(["two"]);
  });

  it("lets go after the grace, even while nothing keeps being reported", () => {
    const seen: (string | null)[] = [];
    const hold = new TrackHold<string>("one", (v) => seen.push(v));
    hold.set(null);
    vi.advanceTimersByTime(600);
    hold.set(null); // a resync while nothing plays must not restart the countdown
    vi.advanceTimersByTime(GAP_GRACE_MS - 600);
    expect(hold.value).toBeNull();
    expect(seen).toEqual([null]);
    hold.set(null);
    vi.advanceTimersByTime(GAP_GRACE_MS * 2);
    expect(seen).toEqual([null]);
  });

  it("starts empty without waiting, and dispose cancels a pending release", () => {
    const empty = new TrackHold<string>(null, () => undefined);
    empty.set(null);
    expect(empty.value).toBeNull();
    const seen: (string | null)[] = [];
    const hold = new TrackHold<string>("one", (v) => seen.push(v));
    hold.set(null);
    hold.dispose();
    vi.advanceTimersByTime(GAP_GRACE_MS * 2);
    expect(seen).toEqual([]);
  });

  it("clampTrackOffset matches what the store saves", () => {
    expect(clampTrackOffset(2100)).toBe(TRACK_OFFSET_LIMIT_MS);
    expect(clampTrackOffset(-2100)).toBe(-TRACK_OFFSET_LIMIT_MS);
    expect(clampTrackOffset(49.6)).toBe(50);
  });
});

describe("media-status: Settings says why it can't see the song", () => {
  const DENIED_SPOTIFY: MediaStatus = { source: "spotify", problem: "automation-denied" };
  const DENIED_MUSIC: MediaStatus = { source: "apple-music", problem: "automation-denied" };
  const NO_PLAYER: MediaStatus = { source: null, problem: "no-player" };

  it("keeps an empty status region at the top of the panel while nothing is wrong", () => {
    const p = mountPanel(0, null);
    const notice = p.root.one("notice");
    expect(p.root.children[0]).toBe(notice);
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.one("notice-card").hidden).toBe(true);
    for (const media of [null, { source: "spotify", problem: null } satisfies MediaStatus, NO_PLAYER]) {
      p.setMedia(media);
      expect(notice.one("notice-card").hidden).toBe(true);
    }
  });

  it("names the denied player and the Automation switch to turn on", () => {
    const p = mountPanel(0, null);
    const card = p.root.one("notice-card");
    p.setMedia(DENIED_SPOTIFY);
    expect(card.hidden).toBe(false);
    expect(card.one("notice-title").textContent).toBe("Undertone can't see what Spotify is playing.");
    expect(card.one("notice-fix").textContent).toBe(
      "Open System Settings › Privacy & Security › Automation › Undertone, then turn on Spotify.",
    );
    p.setMedia(DENIED_MUSIC);
    expect(card.one("notice-title").textContent).toBe("Undertone can't see what Music is playing.");
    expect(card.one("notice-fix").textContent).toBe(
      "Open System Settings › Privacy & Security › Automation › Undertone, then turn on Music.",
    );
    // The icon is decoration; the words carry it.
    expect(card.children[0]?.getAttribute("aria-hidden")).toBe("true");
  });

  it("hides once the player is readable again, and says nothing new on a repeat", () => {
    const p = mountPanel(0, null);
    const card = p.root.one("notice-card");
    const title = card.one("notice-title");
    p.setMedia(DENIED_SPOTIFY);
    const writes = title.children.map((c) => c.textWrites);
    p.setMedia({ ...DENIED_SPOTIFY });
    expect(title.children.map((c) => c.textWrites)).toEqual(writes);
    p.setMedia({ source: "spotify", problem: null });
    expect(card.hidden).toBe(true);
    p.setMedia(DENIED_SPOTIFY);
    expect(card.hidden).toBe(false);
    p.setMedia(null);
    expect(card.hidden).toBe(true);
  });

  it("with no music app open, the song row says so instead of Nothing playing", () => {
    const p = mountPanel(0, null);
    const title = p.root.one("song-title");
    expect(title.textContent).toBe("Nothing playing");
    p.setMedia(NO_PLAYER);
    expect(title.textContent).toBe("No music app open");
    // Denied Automation has its own notice; the row keeps the plain wording.
    p.setMedia(DENIED_SPOTIFY);
    expect(title.textContent).toBe("Nothing playing");
    p.setMedia(null);
    expect(title.textContent).toBe("Nothing playing");
    // A song always wins.
    p.setMedia(NO_PLAYER);
    p.setTrack(TRACK);
    expect(title.textContent).toBe("Placeholder Song · Nobody");
  });

  it("rides out a brief gap between songs as main.ts wires it: no flash of No music app open", () => {
    vi.useFakeTimers();
    const p = mountPanel(0);
    const title = p.root.one("song-title");
    const held = new TrackHold<PanelState["track"]>(TRACK, (song) => p.setTrack(song));
    // The player went away for a moment: nothing playing, no player, then the next song.
    held.set(null);
    p.setMedia(NO_PLAYER);
    vi.advanceTimersByTime(GAP_GRACE_MS - 100);
    expect(title.textContent).toBe("Placeholder Song · Nobody");
    p.setMedia({ source: "spotify", problem: null });
    held.set({ key: "next|song|x|1", title: "Next Song", artist: "Nobody" });
    expect(title.textContent).toBe("Next Song · Nobody");
    // It really closed: once the grace runs out, the row says so.
    held.set(null);
    p.setMedia(NO_PLAYER);
    vi.advanceTimersByTime(GAP_GRACE_MS);
    expect(title.textContent).toBe("No music app open");
    held.dispose();
  });
});

// ---------- media-status-preview ----------

describe("media-status-preview: with nothing reported, the mock's preview plays the demo as the app's does", () => {
  const live: { bridge: MockBridge; preview: SettingsPreview }[] = [];
  afterEach(() => {
    for (const { bridge, preview } of live.splice(0)) {
      preview.dispose();
      bridge.dispose();
    }
  });

  /** The settings window's preview on a mock bridge, wired the way main.ts wires it. */
  async function mountPreview(query: string) {
    vi.useFakeTimers({ now: 1_760_000_000_000 });
    const bridge = createMockBridge({ shared: false, keys: false, storage: null, params: new URLSearchParams(query) });
    const preview = new SettingsPreview({ bridge, palettes: new PaletteCache(async () => null), settings: structuredClone(DEFAULT_SETTINGS) });
    live.push({ bridge, preview });
    await bridge.listen("now-playing", (np) => preview.setMainTrack(np));
    await preview.start(await bridge.invoke("get_now_playing"));
    const el = preview.el as unknown as FakeElement;
    return { bridge, preview, title: el.one("pv-title"), badge: el.one("pv-badge") };
  }

  it("starts on the demo under ?media=, and moves to the player once it is seen", async () => {
    const { bridge, preview, title, badge } = await mountPreview("?track=1&media=no-player");
    expect(preview.current.demo).toBe(true);
    expect(title.textContent).toBe("Neon Monsoon");
    expect(badge.textContent).toBe("Demo");

    bridge.setMedia(null);
    await vi.waitFor(() => expect(preview.current.demo).toBe(false));
    expect(title.textContent).toBe("Paper Lanterns");
    expect(badge.textContent).toBe("Spotify");
  });

  it("moves to the demo after the between-songs grace when setMedia takes the player away", async () => {
    const { bridge, preview, title } = await mountPreview("?track=1");
    expect(preview.current.demo).toBe(false);
    bridge.setMedia("automation-denied");
    await vi.advanceTimersByTimeAsync(GAP_GRACE_MS - 100);
    expect(preview.current.demo).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(preview.current.demo).toBe(true));
    expect(title.textContent).toBe("Neon Monsoon");
  });

  it("plain ?mock never shows the demo, through a track change", async () => {
    const { preview, title } = await mountPreview("?track=1");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(preview.current.demo).toBe(false);
    expect(title.textContent).toBe("Letters Never Sent");
  });
});

// ---------- settings-button-cascade ----------

// Read from disk: vitest hands CSS imports (even ?raw) to its CSS pipeline, which yields "" in node. A
// non-literal specifier, because the strict type check runs without node's types.
let settingsCss = "";
beforeAll(async () => {
  const fsModule = "node:fs";
  const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: URL, encoding: "utf8"): string };
  settingsCss = fs.readFileSync(new URL("../src/styles/settings.css", import.meta.url), "utf8");
});

/** WCAG contrast of two #rrggbb colors. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (bl ?? 0);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** The rule blocks of the stylesheet, comments removed: [selector, body]. */
function rules(css: string): [string, string][] {
  const out: [string, string][] = [];
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push([(m[1] ?? "").trim(), m[2] ?? ""]);
  return out;
}

describe("settings-button-cascade: button classes win over the page's button reset", () => {
  it("the page-wide button reset has no class specificity", () => {
    const resets = rules(settingsCss).filter(([sel, body]) => /(^|[\s,])button\s*$/.test(sel) && /font\s*:\s*inherit/.test(body));
    expect(resets.length).toBeGreaterThan(0);
    for (const [sel] of resets) expect(sel).toMatch(/^:where\([^)]*\)\s+button$/);
  });

  it("the danger button's white label is at least 4.5:1 in both schemes", () => {
    const dangers = [...settingsCss.matchAll(/--danger:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1] ?? "");
    expect(dangers).toHaveLength(2); // light, then dark
    for (const hex of dangers) expect(contrast("#ffffff", hex)).toBeGreaterThanOrEqual(4.5);
    const danger = rules(settingsCss).find(([sel]) => sel === ".btn-danger");
    expect(danger?.[1]).toMatch(/color:\s*#fff\b/);
  });

  it("the inert sync buttons dim without `disabled`, and hover skips them", () => {
    const sels = rules(settingsCss).map(([sel]) => sel);
    expect(sels).toContain('.step[aria-disabled="true"]');
    expect(sels).toContain('.link-btn[aria-disabled="true"]');
    expect(sels.some((s) => s.startsWith(".step:hover") && s.includes('[aria-disabled="true"]'))).toBe(true);
  });
});

// ---------- settings-preview-bar ----------

/** The declarations of the rule with exactly this selector. */
function declarations(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [sel, body] of rules(settingsCss)) {
    if (sel !== selector) continue;
    for (const d of body.split(";")) {
      const at = d.indexOf(":");
      if (at > 0) out.set(d.slice(0, at).trim(), d.slice(at + 1).trim());
    }
  }
  return out;
}

/** A length with any `var(--x)` replaced by the custom property's value wherever the sheet sets it. */
function resolve(value: string | undefined): string | undefined {
  const flat = settingsCss.replace(/\/\*[\s\S]*?\*\//g, "");
  return value?.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
    const set = [...flat.matchAll(new RegExp(`${name}\\s*:\\s*([^;]+);`, "g"))].map((m) => (m[1] ?? "").trim());
    expect(set, `${name} is set once`).toHaveLength(1);
    return set[0] ?? "";
  });
}

/** Top, right, bottom and left of a positioned rule, from `inset` and any longhands after it. */
function edges(decls: Map<string, string>): string[] {
  const inset = (resolve(decls.get("inset")) ?? "auto").split(/\s+/);
  const [t = "auto", r = t, b = t, l = r] = inset;
  return [
    resolve(decls.get("top")) ?? t,
    resolve(decls.get("right")) ?? r,
    resolve(decls.get("bottom")) ?? b,
    resolve(decls.get("left")) ?? l,
  ];
}

describe("settings-preview-bar: the preview's lyric stage starts below its menu bar", () => {
  // the stylesheet is read in a beforeAll, after this block is collected
  const bar = (): Map<string, string> => declarations(".pv-bar");
  const stage = (): Map<string, string> => declarations(".pv-stage.ut-stage");

  it("the bar sits at the top of the wallpaper, 22 px tall", () => {
    expect(bar().get("position")).toBe("absolute");
    expect(edges(bar())[0]).toBe("0");
    expect(resolve(bar().get("height"))).toBe("22px");
  });

  it("the stage fills the wallpaper from the bar's bottom edge down, so its Height clamp counts the bar as off-stage", () => {
    expect(stage().get("position")).toBe("absolute");
    const [top, right, bottom, left] = edges(stage());
    expect(top).toBe(resolve(bar().get("height")));
    expect([right, bottom, left]).toEqual(["0", "0", "0"]);
  });

  it("no mask fades the top of the stage, where Height 0 puts the focus line", () => {
    for (const prop of stage().keys()) expect(prop).not.toMatch(/mask/);
    const masked = rules(settingsCss).filter(([sel, body]) => /\.pv-stage/.test(sel) && /mask/.test(body));
    expect(masked).toEqual([]);
  });
});
