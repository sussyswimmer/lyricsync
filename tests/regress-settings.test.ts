import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../contract/contract";
import { GAP_GRACE_MS, TrackHold } from "../src/settings/hold";
import type { PanelState, SettingsPanel as Panel } from "../src/settings/panel";
import { applyWrite, clampTrackOffset, TRACK_OFFSET_LIMIT_MS } from "../src/settings/store";

/*
 * Regressions from the settings-window QA pass:
 * - settings-button-cascade: a page-wide `button { font; color }` reset outranked every button class.
 * - settings-nudge-focus: self-disabling sync buttons handed focus to the opposite action, and a brief
 *   "nothing playing" between songs disabled them all and dropped focus to <body>.
 * - settings-song-aria-live: the "This song" value was a live region rewritten on every render.
 */

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
  readonly style = { setProperty: (): void => undefined } as Record<string, unknown>;
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
  let state: PanelState = { settings, palette: null, paletteFor: null, artPending: false, track };
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
  return root.children.find((c) => c.getAttribute("role") === "status")?.textContent ?? "";
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
    p.panel.render({ settings: { ...DEFAULT_SETTINGS, mode: "lens", trackOffsetsMs: { [KEY]: 50 } }, palette: null, paletteFor: null, artPending: false, track: TRACK });
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
