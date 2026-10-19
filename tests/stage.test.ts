import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../contract/contract";
import type { Line } from "../src/core/lrc";
import { parseLrc } from "../src/core/lrc";
import { pacePlain, type Timeline } from "../src/core/timing";
import { fontFor, stackFor } from "../src/overlay/fonts";
import { DEFAULT_PICK, type PickedLook } from "../src/overlay/look";
import { LINGER_MS, LyricStage, cueAt, cueMap, untilNextChange } from "../src/overlay/stage";
import { FakeAnimationHost } from "./fake-motion";
import neonMonsoon from "./fixtures/neon-monsoon.lrc?raw";
import paperLanterns from "./fixtures/paper-lanterns.lrc?raw";

/** A line from [text, start, end] word triples; no words makes an instrumental gap. */
function line(start: number, end: number, words: [string, number, number][] = []): Line {
  return {
    start,
    end,
    text: words.map(([t]) => t).join(""),
    words: words.map(([text, s, e]) => ({ text, start: s, end: e })),
  };
}

/**
 * Two lines with a marked instrumental break between them and a trailing gap:
 *   1000 "one two" (words end 2400) · 3000 gap · 8000 "three four" (words end 10000) · 12000 gap
 */
const SONG: Timeline = {
  unsynced: false,
  lines: [
    line(1000, 2650, [
      ["one ", 1000, 1500],
      ["two", 1500, 2400],
    ]),
    line(3000, 7650),
    line(8000, 11650, [
      ["three ", 8000, 9000],
      ["four", 9000, 10000],
    ]),
    line(12000, 20000),
  ],
};

/** A long break the LRC doesn't mark: the first line's words end at 2000, the next starts at 10 000. */
const UNMARKED: Timeline = {
  unsynced: false,
  lines: [
    line(1000, 9650, [
      ["hi ", 1000, 1400],
      ["there", 1400, 2000],
    ]),
    line(10000, 12000, [["again", 10000, 11000]]),
  ],
};

describe("cueMap", () => {
  it("drops gaps from the lyric lines and maps each line to its lyric index", () => {
    const map = cueMap(SONG);
    expect(map.all).toBe(SONG.lines);
    expect(map.lyrics).toEqual([SONG.lines[0], SONG.lines[2]]);
    expect(map.lyricOf).toEqual([0, -1, 1, -1]);
    expect(map.nextLyric).toEqual([1, 1, -1, -1]);
    expect(map.unsynced).toBe(false);
  });

  it("collects every visible change: line starts, word bounds and linger ends, sorted and unique", () => {
    // SONG's lingers end after its gap stamps (3 s, 12 s), when they no longer change anything
    expect(cueMap(SONG).boundaries).toEqual([1000, 1500, 2400, 3000, 8000, 9000, 10000, 12000]);
    // a linger that ends before the next line does
    expect(cueMap(UNMARKED).boundaries).toEqual([1000, 1400, 2000, 2000 + LINGER_MS, 10000, 11000]);
    expect(cueMap(UNMARKED).lineBoundaries).toEqual([1000, 2000 + LINGER_MS, 10000]);
  });

  it("knows the long rests between lines (safe points for a new look)", () => {
    expect(cueMap(SONG).breaks).toEqual([{ start: 2400, end: 8000 }]);
    expect(cueMap(UNMARKED).breakStarts).toEqual([2000]);
    expect(cueMap({ lines: parseLrc(paperLanterns, 24_000), unsynced: false }).breaks.map((b) => b.start)).toEqual([8500]);
  });

  it("handles an empty timeline", () => {
    const map = cueMap({ lines: [], unsynced: false });
    expect(map).toMatchObject({ lyrics: [], lyricOf: [], nextLyric: [], boundaries: [] });
  });
});

describe("cueAt", () => {
  const map = cueMap(SONG);

  it("shows the first line waiting before it starts", () => {
    expect(cueAt(map, 0)).toEqual({ line: 0, waiting: true, t: 0 });
    expect(cueAt(map, 999)).toEqual({ line: 0, waiting: true, t: 999 });
  });

  it("is on a line from its first stamp until the next line", () => {
    expect(cueAt(map, 1000)).toEqual({ line: 0, waiting: false, t: 1000 });
    expect(cueAt(map, 2700)).toEqual({ line: 0, waiting: false, t: 2700 });
    expect(cueAt(map, 8500)).toEqual({ line: 1, waiting: false, t: 8500 });
  });

  it("shows the next line waiting during a marked instrumental gap", () => {
    expect(cueAt(map, 3000)).toEqual({ line: 1, waiting: true, t: 3000 });
    expect(cueAt(map, 7999)).toEqual({ line: 1, waiting: true, t: 7999 });
  });

  it("shows nothing after the trailing gap starts", () => {
    expect(cueAt(map, 11_999)).toEqual({ line: 1, waiting: false, t: 11_999 });
    expect(cueAt(map, 12_000)).toEqual({ line: -1, waiting: false, t: 12_000 });
    expect(cueAt(map, 1e9)).toEqual({ line: -1, waiting: false, t: 1e9 });
  });

  it("starts with the first lyric waiting when the song opens with a gap", () => {
    const intro = cueMap({ unsynced: false, lines: [line(0, 4650), line(5000, 8000, [["la", 5000, 6000]])] });
    expect(cueAt(intro, 100)).toEqual({ line: 0, waiting: true, t: 100 });
    expect(cueAt(intro, 5000)).toEqual({ line: 0, waiting: false, t: 5000 });
  });

  it("has no line at all for an empty timeline or one with only gaps", () => {
    expect(cueAt(cueMap({ lines: [], unsynced: false }), 500).line).toBe(-1);
    expect(cueAt(cueMap({ unsynced: false, lines: [line(0, 9000)] }), 500)).toEqual({ line: -1, waiting: false, t: 500 });
  });
});

describe("cueAt: linger", () => {
  const map = cueMap(UNMARKED);

  it("holds the sung line for LINGER_MS after its last word", () => {
    // The exact instant 2000 + LINGER_MS hands off (see "untilNextChange" below).
    expect(cueAt(map, 2001)).toEqual({ line: 0, waiting: false, t: 2001 });
    expect(cueAt(map, 2000 + LINGER_MS - 1)).toEqual({ line: 0, waiting: false, t: 2000 + LINGER_MS - 1 });
  });

  it("then shows the next line waiting through the rest of an unmarked break", () => {
    expect(cueAt(map, 2001 + LINGER_MS)).toEqual({ line: 1, waiting: true, t: 2001 + LINGER_MS });
    expect(cueAt(map, 9999)).toEqual({ line: 1, waiting: true, t: 9999 });
    expect(cueAt(map, 10_000)).toEqual({ line: 1, waiting: false, t: 10_000 });
  });

  it("keeps the last line up after it ends: there is nothing to wait for", () => {
    expect(cueAt(map, 60_000)).toEqual({ line: 1, waiting: false, t: 60_000 });
  });

  it("does not apply to unsynced timelines", () => {
    const calm = cueMap({ ...UNMARKED, unsynced: true });
    expect(cueAt(calm, 2001 + LINGER_MS)).toEqual({ line: 0, waiting: false, t: 2001 + LINGER_MS });
    expect(cueAt(calm, 9999).line).toBe(0);
  });

  it("does not apply to paced plain lyrics either", () => {
    const plain = pacePlain("First placeholder line\nSecond placeholder line", 60_000);
    const calm = cueMap(plain);
    expect(calm.unsynced).toBe(true);
    const second = plain.lines[1]?.start ?? 0;
    expect(cueAt(calm, second - 1)).toEqual({ line: 0, waiting: false, t: second - 1 });
    expect(cueAt(calm, second).line).toBe(1);
  });
});

describe("cueAt on a parsed enhanced LRC", () => {
  const map = cueMap({ lines: parseLrc(paperLanterns, 24_000), unsynced: false });

  it("walks the fixture's lines and its marked gap", () => {
    expect(map.lyrics.map((l) => l.text.split(" ")[0])).toEqual(["Paper", "Counting", "Fold", "Light"]);
    expect(cueAt(map, 500)).toMatchObject({ line: 0, waiting: true });
    expect(cueAt(map, 4300)).toMatchObject({ line: 1, waiting: false });
    expect(cueAt(map, 9500)).toMatchObject({ line: 2, waiting: true });
    expect(cueAt(map, 13_000)).toMatchObject({ line: 2, waiting: false });
    expect(cueAt(map, 23_999)).toMatchObject({ line: 3, waiting: false });
  });
});

describe("untilNextChange", () => {
  const map = cueMap(SONG);

  it("counts down to the next boundary", () => {
    expect(untilNextChange(map, 0)).toBe(1000);
    expect(untilNextChange(map, 999)).toBe(1);
    expect(untilNextChange(map, 1200)).toBe(300);
    expect(untilNextChange(map, 2400)).toBe(600);
    expect(untilNextChange(map, 4000)).toBe(8000 - 4000);
  });

  it("looks past a boundary it is sitting on", () => {
    expect(untilNextChange(map, 1000)).toBe(500);
    expect(untilNextChange(map, 1500)).toBe(900);
    expect(untilNextChange(map, 10_000)).toBe(2000);
  });

  it("works between fractional times", () => {
    expect(untilNextChange(map, 1499.5)).toBeCloseTo(0.5);
  });

  it("is Infinity once nothing else will change", () => {
    expect(untilNextChange(map, 12_000 - 1)).toBe(1);
    expect(untilNextChange(map, 12_000)).toBe(Number.POSITIVE_INFINITY);
    expect(untilNextChange(map, 1e9)).toBe(Number.POSITIVE_INFINITY);
    expect(untilNextChange(cueMap({ lines: [], unsynced: false }), 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it.each([
    ["the two-line song", SONG],
    ["enhanced LRC (Paper Lanterns)", { lines: parseLrc(paperLanterns, 24_000), unsynced: false }],
    ["line-level LRC with fallback word timing (Neon Monsoon)", { lines: parseLrc(neonMonsoon, 35_000), unsynced: false }],
    ["paced plain lyrics", pacePlain("First placeholder line\nSecond one\nThird and last", 30_000)],
  ] as const)("never sleeps through a visible change: %s", (_name, timeline) => {
    const map = cueMap(timeline);
    for (const t of wakeTimes(map)) {
      const sleep = untilNextChange(map, t);
      expect(sleep, `t=${t}`).toBeGreaterThan(0);
      expect(firstChange(map, t, sleep), `woken at t=${t}, slept ${sleep} ms`).toBeNull();
    }
  });

  it("never sleeps through the linger hand-off on an unmarked break, between boundaries", () => {
    const map = cueMap(UNMARKED);
    const exact = new Set(map.boundaries);
    for (const t of wakeTimes(map).filter((x) => !exact.has(x))) {
      expect(firstChange(map, t, untilNextChange(map, t)), `woken at t=${t}`).toBeNull();
    }
  });

  // Regression: the linger hand-off used a strict `>`, unlike every other boundary, so a frame landing
  // exactly on it kept the old line and slept until the next line started.
  it("never sleeps through the linger hand-off when woken exactly on it", () => {
    const map = cueMap(UNMARKED);
    const t = 2000 + LINGER_MS;
    expect(firstChange(map, t, untilNextChange(map, t))).toBeNull();
  });
});

/** What the stage shows at `t`: the focus line, whether it waits, and each of its words as upcoming, active or sung. */
function shape(map: ReturnType<typeof cueMap>, t: number): string {
  const cue = cueAt(map, t);
  const focus = cue.line >= 0 ? map.lyrics[cue.line] : undefined;
  // Unsynced lyrics show no per-word state in any mode, so only the focus line counts.
  const words = map.unsynced ? "" : (focus?.words ?? []).map((w) => (cue.waiting || t < w.start ? "u" : t >= w.end ? "s" : "a")).join("");
  return `${cue.line}/${cue.waiting}/${words}`;
}

/** Where the controller may wake: every boundary exactly, just either side of it, and a coarse grid. */
function wakeTimes(map: ReturnType<typeof cueMap>): number[] {
  const times = map.boundaries.flatMap((b) => [b - 0.5, b, b + 0.5]);
  for (let t = -100; t < 40_000; t += 37) times.push(t);
  return times;
}

/** The first time in (t, t + sleep) at which the shape differs from the shape at t, or null. */
function firstChange(map: ReturnType<typeof cueMap>, t: number, sleep: number): number | null {
  const before = shape(map, t);
  const end = Number.isFinite(sleep) ? t + sleep : t + 1e6;
  const probes = [t + 0.5, t + (end - t) / 3, t + (end - t) / 2, end - 0.01];
  for (const b of map.boundaries) if (b > t && b < end) probes.push(b, b + 0.5);
  return probes.filter((p) => p > t && p < end).find((p) => shape(map, p) !== before) ?? null;
}

// ---------------------------------------------------------------------------------------------------
// The stage and the song's look (SPEC §4.6): a real LyricStage drawing Stack on just enough DOM.

class FakeStyle {
  readonly props = new Map<string, string>();
  [key: string]: unknown;
  setProperty(name: string, value: string): void {
    this.props.set(name, value);
  }
  getPropertyValue(name: string): string {
    return this.props.get(name) ?? "";
  }
  removeProperty(name: string): void {
    this.props.delete(name);
  }
}

/** Elements with inline styles, rows about 0.5 em per glyph and 1.12 em per row, and Web Animations that record themselves. */
class FakeElement extends FakeAnimationHost {
  readonly tagName: string;
  className = "";
  dir = "";
  lang = "";
  style = new FakeStyle();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  ownText = "";
  readonly attrs = new Map<string, string>();
  readonly classList = {
    add: (...names: string[]): void => {
      this.className = [...new Set([...this.className.split(" ").filter(Boolean), ...names])].join(" ");
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
  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.ownText = value;
  }
  get isConnected(): boolean {
    return this.parent !== null;
  }
  get parentNode(): FakeElement | null {
    return this.parent;
  }
  get clientWidth(): number {
    return 1280;
  }
  get clientHeight(): number {
    return 720;
  }
  get offsetHeight(): number {
    let size = 16;
    for (let el: FakeElement | null = this; el; el = el.parent) {
      const v = el.style["fontSize"];
      if (typeof v === "string" && v) {
        size = Number.parseFloat(v);
        break;
      }
    }
    return Math.round(Math.max(1, Math.ceil((this.textContent.length * size * 0.5) / (1280 * 0.88))) * size * 1.12);
  }
  append(...nodes: FakeElement[]): void {
    for (const n of nodes) {
      n.remove();
      n.parent = this;
      this.children.push(n);
    }
  }
  appendChild(node: FakeElement): FakeElement {
    this.append(node);
    return node;
  }
  after(node: FakeElement): void {
    const p = this.parent;
    if (!p) return;
    node.remove();
    node.parent = p;
    p.children.splice(p.children.indexOf(this) + 1, 0, node);
  }
  remove(): void {
    const p = this.parent;
    if (!p) return;
    p.children.splice(p.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.attrs.has(name);
    if (on) this.attrs.set(name, "");
    else this.attrs.delete(name);
    return on;
  }
  cloneNode(deep = false): FakeElement {
    const copy = new FakeElement(this.tagName);
    copy.className = this.className;
    copy.ownText = this.ownText;
    for (const [k, v] of Object.entries(this.style)) if (k !== "props") copy.style[k] = v;
    for (const [k, v] of this.style.props) copy.style.props.set(k, v);
    if (deep) copy.append(...this.children.map((c) => c.cloneNode(true)));
    return copy;
  }
  find(className: string): FakeElement[] {
    return this.children.flatMap((c) => [...(c.classList.contains(className) ? [c] : []), ...c.find(className)]);
  }
}

describe("the stage and the song's look", () => {
  let clock = 0;
  const made: LyricStage[] = [];

  beforeEach(() => {
    clock = 10_000;
    vi.stubGlobal("document", { createElement: (tag: string) => new FakeElement(tag) });
    vi.stubGlobal("getComputedStyle", (el: FakeElement) => ({ opacity: String(el.style["opacity"] ?? 1) }));
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    for (const s of made.splice(0)) s.destroy();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const pick = (style: PickedLook["style"], over: Partial<PickedLook> = {}): PickedLook => ({ ...DEFAULT_PICK, style, ...over });
  const lyrics = (timeline: Timeline = SONG) => ({ kind: "lyrics" as const, timeline });

  /** A stage drawing Stack with the default settings, on a fake host; `onSafePoint` as given. */
  function stage(onSafePoint?: () => void): { s: LyricStage; root: FakeElement } {
    const host = new FakeElement("main");
    const s = new LyricStage(host as unknown as HTMLElement, onSafePoint ? { onSafePoint } : {});
    made.push(s);
    s.setSettings(structuredClone(DEFAULT_SETTINGS));
    s.setPickedLook(pick("stack"));
    const root = host.children[0];
    if (!root) throw new Error("no root");
    return { s, root };
  }
  const ghosts = (root: FakeElement): number => root.children.filter((c) => c.classList.contains("ut-ghost")).length;
  const scenes = (root: FakeElement): FakeElement[] => root.children.filter((c) => c.classList.contains("ut-scene") && !c.classList.contains("ut-ghost"));

  it("brings a new scene in with the look it is shown with, leaving the old one as it was drawn", () => {
    const { s, root } = stage();
    s.show({ kind: "instrumental" }, "a");
    clock += 1000;
    const syne = pick("stack", { font: { family: "Syne", weight: 800 } });
    s.show({ kind: "instrumental" }, "b", syne);
    expect(s.pickedLook).toBe(syne);
    const notes = scenes(root).map((sc) => sc.find("state-instrumental")[0]?.style["fontFamily"]);
    expect(notes).toEqual([stackFor(fontFor("Fraunces"), null), stackFor(fontFor("Syne"), null)]);
    // null: the house look
    s.show({ kind: "loading" }, "c", null);
    expect(s.pickedLook).toBe(DEFAULT_PICK);
  });

  it("crossfades a new look into lyrics only: a state rebuilds where its animation was, with no copy", () => {
    const { s, root } = stage();
    s.show({ kind: "not-found" }, "a");
    clock += 1000;
    s.setPickedLook(pick("stack", { scale: 1.1 }), "crossfade");
    expect(ghosts(root)).toBe(0);
    expect(scenes(root)).toHaveLength(1);
    s.show(lyrics(), "b");
    clock += 1000;
    s.render(9000);
    s.setPickedLook(pick("drift"), "crossfade");
    expect(ghosts(root)).toBe(1);
  });

  it("is at a safe point while lyrics wait for the scene before them to fade out", () => {
    const { s } = stage();
    s.show(lyrics(), "a");
    clock += 1000;
    s.render(9000);
    // mid-line, on screen
    expect(s.atSafePoint(9000)).toBe(false);
    // new lyrics for the song (plain upgraded to synced): nothing of them shows until the old fade out
    s.show(lyrics({ ...SONG }), "a");
    expect(s.atSafePoint(9000)).toBe(true);
    clock += 260;
    expect(s.atSafePoint(9000)).toBe(false);
    // a state is always one
    s.show({ kind: "loading" }, "b");
    expect(s.atSafePoint(9000)).toBe(true);
  });

  it("tells its safe point listeners, as it does onSafePoint, until they stop listening", () => {
    let option = 0;
    let listener = 0;
    const { s } = stage(() => option++);
    const off = s.addSafePointListener(() => listener++);
    s.show(lyrics(), "a");
    // the first paint before the first line (line 0, waiting)...
    s.render(500);
    s.render(1200);
    s.render(2300);
    // ...a long break starting (the last word ends at 2.4 s), and the focus moving on (the gap at 3 s)
    s.render(2500);
    s.render(3100);
    expect([option, listener]).toEqual([3, 3]);
    off();
    s.show(lyrics({ ...SONG }), "b");
    s.render(500);
    expect([option, listener]).toEqual([4, 3]);
  });

  it("wakes for a long break starting only when someone listens for safe points", () => {
    const { s: quiet } = stage();
    quiet.show(lyrics(), "a");
    quiet.render(2300);
    const { s: heard } = stage();
    heard.addSafePointListener(() => undefined);
    heard.show(lyrics(), "a");
    heard.render(2300);
    expect(heard.nextChange(2300)).toBe(100);
    expect(quiet.nextChange(2300)).toBeGreaterThan(100);
  });
});
