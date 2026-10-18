import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Lyrics, type NowPlaying, type Settings } from "../contract/contract";
import type { ArgsOf, Bridge, Command, Event, Events, ResultOf, Unlisten } from "../src/bridge/types";
import { parseLrc, type Line } from "../src/core/lrc";
import { PaletteCache } from "../src/core/palette";
import { OverlayController } from "../src/overlay/controller";
import { fontFor } from "../src/overlay/fonts";
import { DEFAULT_PICK, resolveLook, textShadow, type Frame, type Look, type PickedLook } from "../src/overlay/look";
import { DriftMode } from "../src/overlay/modes/drift";
import type { Cue } from "../src/overlay/modes/types";
import { cueMap, LINGER_MS, LyricStage, untilNextChange, type StageView } from "../src/overlay/stage";
import { buildState } from "../src/overlay/states";
import { bloomShadow } from "../src/overlay/motion/bloom";
import { bloomOf } from "../src/overlay/motion/params";
import { FakeAnimation, FakeAnimationHost, valuesAt } from "./fake-motion";
import paperLanterns from "./fixtures/paper-lanterns.lrc?raw";

/*
 * Just enough DOM for the stage, the states and Drift/Stack to run in node: elements with inline
 * styles, a text layout that wraps at the row width, and Web Animations that only record themselves.
 */

/** Opacity the fake getComputedStyle reports: an element's own, or whatever a test says a fade is at. */
const drawnOpacity = new WeakMap<FakeElement, number>();

class FakeStyle {
  readonly props = new Map<string, string>();
  [key: string]: unknown;
  setProperty(name: string, value: string): void {
    this.props.set(name, value);
  }
  getPropertyValue(name: string): string {
    return this.props.get(name) ?? "";
  }
}

let stageSize = { width: 1280, height: 720 };

class FakeElement extends FakeAnimationHost {
  readonly tagName: string;
  className = "";
  dir = "";
  style = new FakeStyle();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  ownText = "";
  readonly attrs = new Map<string, string>();
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
    return stageSize.width;
  }
  get clientHeight(): number {
    return stageSize.height;
  }
  /** Rows wrap at 88% of the stage width with glyphs about 0.5 em wide, 1.12 em per row. */
  /** Text that takes room in the layout: the karaoke overlay (`.kw-fx`) is absolutely placed and takes none. */
  get flowText(): string {
    return this.ownText + this.children.map((c) => (c.classList.contains("kw-fx") ? "" : c.flowText)).join("");
  }
  get offsetHeight(): number {
    const size = this.fontSize();
    const width = this.flowText.length * size * 0.5;
    const rows = Math.max(1, Math.ceil(width / (stageSize.width * 0.88)));
    return Math.round(rows * size * 1.12);
  }
  fontSize(): number {
    for (let el: FakeElement | null = this; el; el = el.parent) {
      const v = el.style["fontSize"];
      if (typeof v === "string" && v) return Number.parseFloat(v);
    }
    return 16;
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
    copy.dir = this.dir;
    copy.ownText = this.ownText;
    for (const [k, v] of Object.entries(this.style)) if (k !== "props") copy.style[k] = v;
    for (const [k, v] of this.style.props) copy.style.props.set(k, v);
    for (const [k, v] of this.attrs) copy.attrs.set(k, v);
    if (deep) copy.append(...this.children.map((c) => c.cloneNode(true)));
    return copy;
  }
  find(className: string): FakeElement[] {
    const out: FakeElement[] = [];
    for (const c of this.children) {
      if (c.classList.contains(className)) out.push(c);
      out.push(...c.find(className));
    }
    return out;
  }
}

let clock = 0;

beforeEach(() => {
  clock = 10_000;
  stageSize = { width: 1280, height: 720 };
  vi.stubGlobal("document", { createElement: (tag: string) => new FakeElement(tag) });
  vi.stubGlobal("getComputedStyle", (el: FakeElement) => ({ opacity: String(drawnOpacity.get(el) ?? el.style["opacity"] ?? 1) }));
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

/** Modes and stages a test made: destroyed after it, while its fake document is still in place, so no timer of theirs (the next line's prepare) outlives it. */
const live: { destroy(): void }[] = [];
function keep<T extends { destroy(): void }>(made: T): T {
  live.push(made);
  return made;
}

afterEach(() => {
  for (const made of live.splice(0)) {
    try {
      made.destroy();
    } catch {
      // already torn down by the test
    }
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const asHtml = (el: FakeElement): HTMLElement => el as unknown as HTMLElement;
const settings = (over: Partial<Settings> = {}): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), ...over });
const lookFor = (over: Partial<Settings> = {}, frame: Partial<Frame> = {}): Look =>
  resolveLook(settings(over), null, { width: stageSize.width, height: stageSize.height, dpr: 1, motion: true, unsynced: false, ...frame });

const LINES: Line[] = parseLrc(paperLanterns, 24_000).filter((l) => l.words.length > 0);
/** Eight one-row placeholder lines, two seconds apart. */
const EIGHT: Line[] = parseLrc(
  Array.from({ length: 8 }, (_, i) => `[00:${String(2 * i + 1).padStart(2, "0")}.00]placeholder line number ${i + 1}`).join("\n"),
  20_000,
);

/** A built Drift (depth 1) or Stack (depth 0) on a fake host. */
function drift(depth = 1, look = lookFor(), lines: readonly Line[] = LINES): { mode: DriftMode; host: FakeElement; rows: FakeElement[] } {
  const host = new FakeElement("div");
  const mode = keep(new DriftMode(depth));
  mode.build(asHtml(host), lines, look);
  return { mode, host, rows: host.find("drift-row") };
}

const cue = (line: number, t: number, running = true, waiting = false): Cue => ({ line, t, running, waiting });
const scaleOf = (row: FakeElement | undefined): number => Number(/scale\(([\d.]+)\)/u.exec(row?.style.getPropertyValue("transform") ?? "")?.[1]);
/** Where a row's center sits from the focus position: its translate (its top edge is on look.y) plus half its box. */
const yOf = (row: FakeElement | undefined): number =>
  Number(/translate(?:3d)?\(0px, (-?[\d.]+)px/u.exec(row?.style.getPropertyValue("transform") ?? "")?.[1]) + (row?.offsetHeight ?? 0) / 2;
/** A row's running scroll (Web Animations on the row itself). */
const scrolling = (row: FakeElement | undefined): FakeAnimation[] => row?.getAnimations() ?? [];
/** The word boxes of a row, and one word's part of the karaoke overlay. */
const wordsOf = (row: FakeElement | undefined): FakeElement[] => row?.find("kw") ?? [];
const partOf = (row: FakeElement | undefined, word: number, part: string): FakeElement | undefined => wordsOf(row)[word]?.find(part)[0];

// Regression (drift-paused-freeze): Drift glided from performance.now(), and no frame follows a paused
// paint, so a glide caught by a pause froze halfway and a seek while paused left the old line centered.
// The scroll now runs on the document timeline from the state on screen: a pause lets it finish, where
// it was headed, while the words hold still at their song time.
describe("Drift while paused", () => {
  it("lets a glide in flight finish through a pause, the words held at their song time", () => {
    const { mode, rows } = drift();
    mode.paint(cue(0, 2000));
    clock += 16;
    // the scroll runs on the compositor: no frames asked for, an animation on every row it moves
    expect(mode.paint(cue(1, 4300))).toBe(false);
    const glide = scrolling(rows[1]);
    expect(glide.length).toBe(1);
    expect(glide[0]?.keyframes.length).toBeGreaterThan(2);
    // on the document timeline, from now: not the song's
    expect(glide[0]?.startTime).toBe(clock);
    clock += 150;
    expect(mode.paint(cue(1, 4450))).toBe(false);
    // paused: the glide runs on to its line, which is where the rows' own style already is
    expect(mode.paint(cue(1, 4450, false))).toBe(false);
    expect(scrolling(rows[1])).toEqual(glide);
    expect(glide[0]?.cancelled).toBe(false);
    expect(scaleOf(rows[1])).toBe(1);
    expect(yOf(rows[1])).toBe(0);
    expect(scaleOf(rows[0])).toBeCloseTo(0.58, 4);
    // the line's words hold at their song time
    const words = wordsOf(rows[1]).flatMap((w) => [w, ...w.find("kw-track")]).flatMap((e) => e.getAnimations());
    expect(words.length).toBeGreaterThan(0);
    expect(words.every((a) => a.paused && Math.abs((a.currentTime ?? 0) - (4450 - 4200)) < 1e-6)).toBe(true);
    // ...and resuming doesn't start the glide again
    clock += 100;
    expect(mode.paint(cue(1, 4460))).toBe(false);
    expect(scrolling(rows[1])).toEqual(glide);
    expect(words.every((a) => !a.paused)).toBe(true);
  });

  it("cuts to the line a paused seek lands on, and has the stage crossfade it", () => {
    const { mode, rows } = drift();
    mode.paint(cue(1, 5000));
    mode.paint(cue(1, 5000, false));
    expect(mode.crossfades(cue(2, 12_600, false))).toBe(true);
    expect(mode.paint(cue(2, 12_600, false))).toBe(false);
    expect(scrolling(rows[2])).toEqual([]);
    expect(scaleOf(rows[2])).toBe(1);
    expect(yOf(rows[2])).toBe(0);
    expect(scaleOf(rows[1])).toBeCloseTo(0.58, 4);
    // the focus went to the centered line: lyric color there, the old line dim (drawn by its soft shadow)
    expect(rows[2]?.classList.contains("is-focus")).toBe(true);
    expect(rows[2]?.style.getPropertyValue("color")).toBe(DEFAULT_SETTINGS.colors.lyric);
    expect(rows[1]?.classList.contains("is-focus")).toBe(false);
    expect(rows[1]?.style.getPropertyValue("color")).toBe("transparent");
    expect(rows[1]?.style.getPropertyValue("text-shadow")).toMatch(/^0 0 [\d.]+px rgba\(141, 147, 160, 1\.000\)/u);
  });

  it("glides again (no stage crossfade) once playing", () => {
    const { mode, rows } = drift();
    mode.paint(cue(1, 5000, false));
    expect(mode.crossfades(cue(2, 12_500, false))).toBe(true);
    mode.paint(cue(1, 5016));
    expect(mode.crossfades(cue(2, 12_500))).toBe(false);
    clock += 16;
    expect(mode.paint(cue(2, 12_500))).toBe(false);
    expect(scrolling(rows[2]).length).toBe(1);
  });
});

// Regression (drift-seek-cut): a jump of more than three lines while playing cut the whole stack in
// one frame, where Arc and Lens fade a seek out and in.
describe("Drift on a seek while playing", () => {
  it("has the stage crossfade a jump of more than three lines, and glides a step", () => {
    const { mode } = drift(1, lookFor(), EIGHT);
    mode.paint(cue(1, 3500));
    expect(mode.crossfades(cue(2, 5500))).toBe(false);
    expect(mode.crossfades(cue(4, 9500))).toBe(false);
    expect(mode.crossfades(cue(5, 11_500))).toBe(true);
    // a repeated song starting over
    mode.paint(cue(7, 15_500));
    expect(mode.crossfades(cue(0, 500, true, true))).toBe(true);
    // the stack fades out by itself after the last line
    expect(mode.crossfades(cue(-1, 19_000))).toBe(false);
  });

  it("leaves a fading copy of the old line on the stage for a jump, none for a step", () => {
    const { stage: s, root } = stage();
    s.show({ kind: "lyrics", timeline: { lines: EIGHT, unsynced: false } }, "a");
    const ghosts = (): number => root.children.filter((c) => c.classList.contains("ut-ghost")).length;
    clock += 1000;
    s.render(1500);
    clock += 16;
    s.render(3500);
    expect(ghosts()).toBe(0);
    clock += 600;
    s.render(13_500);
    expect(ghosts()).toBe(1);
  });
});

// Regression (drift-noop-frames): after a rebuild or a cut, paint kept asking for frames for the whole
// ease although nothing moved.
describe("Drift asks for frames only while something moves", () => {
  it("is idle on the first paint after a build, and after a cut", () => {
    const { mode } = drift(1, lookFor(), EIGHT);
    expect(mode.paint(cue(1, 3500))).toBe(false);
    clock += 16;
    expect(mode.paint(cue(1, 3516))).toBe(false);
    // a seek further than a glide covers
    expect(mode.paint(cue(6, 13_500))).toBe(false);
    clock += 16;
    expect(mode.paint(cue(6, 13_516))).toBe(false);
  });

  it("is idle on every line change under reduced motion", () => {
    const { mode } = drift(1, lookFor({}, { motion: false }));
    mode.paint(cue(0, 2000));
    expect(mode.paint(cue(1, 4300))).toBe(false);
  });
});

// Regression (word-boundary-late): a word drew unlit at exactly its start time.
describe("Drift word states", () => {
  /** The value of the first keyframe at or after `offset` in an animation's keyframes. */
  const at = (anim: FakeAnimation | undefined, offset: number): string =>
    String(anim?.keyframes.find((k) => Number(k.offset) >= offset - 1e-9)?.transform ?? "");

  it("lights a word, with its glow, at the very millisecond it starts", () => {
    const { mode, rows } = drift();
    const word = LINES[1]?.words[1];
    expect(word).toMatchObject({ text: "the ", start: 4800 });
    mode.paint(cue(1, 4800));
    // the line is handed to the compositor at once: one window from its first word to when it settles
    const wipe = (i: number): FakeAnimation | undefined => partOf(rows[1], i, "kw-track")?.getAnimations()[0];
    const span = Number(wipe(1)?.options.duration);
    const offset = (ms: number): number => (ms - 4200) / span;
    // "the" starts its wipe at 4.8 s: closed up to then, moving right after
    expect(at(wipe(1), offset(4800))).toMatch(/^translateX\(-/u);
    expect(at(wipe(1), offset(4801))).not.toBe(at(wipe(1), offset(4800)));
    expect(partOf(rows[1], 1, "kw-glow")?.getAnimations()).toHaveLength(1);
    // "boats" holds closed until 5 s
    expect(at(wipe(2), 0)).toBe(at(wipe(2), offset(4999)));
    // every animation of the line shares that window, so the browser starts and ends them together
    const all = wordsOf(rows[1]).flatMap((w) => [w, ...w.find("kw-track"), ...w.find("kw-glow"), ...w.find("kl")]).flatMap((e) => e.getAnimations());
    expect(all.length).toBeGreaterThan(10);
    expect(new Set(all.map((x) => x.options.duration))).toEqual(new Set([span]));
  });
});

// Regressions (drift-perspective-overlap, drift-wrapped-offscreen, drift-small-neighbors).
describe("Drift geometry", () => {
  it("recedes toward the focus line, wherever Height puts it", () => {
    for (const yPos of [5, 46, 95]) {
      const look = lookFor({ yPos });
      const { host } = drift(1, look);
      expect(host.find("drift")[0]?.style["perspectiveOrigin"]).toBe(`50% ${look.y.toFixed(1)}px`);
    }
  });

  it("sets a line that would wrap taller than the stage allows in a smaller size", () => {
    const long = parseLrc(`[00:01.00]${"placeholder words that keep on going ".repeat(9)}\n[00:09.00]short line`, 12_000);
    const look = lookFor({ size: 140 });
    const { rows } = drift(1, look, long);
    const size = Number.parseFloat(String(rows[0]?.style["fontSize"]));
    expect(size).toBeLessThan(look.size);
    // about 45% of the stage (text wraps in whole rows, so give or take one)
    expect(rows[0]?.offsetHeight).toBeLessThanOrEqual(720 * 0.45 + size * 1.12);
    expect(rows[1]?.style["fontSize"]).toBeUndefined();
  });

  it("keeps a tall focus line whole on screen at the Height extremes", () => {
    const text = "a wrapped placeholder line that takes a few rows on this stage ".repeat(3);
    const lines = parseLrc(`[00:01.00]one\n[00:03.00]${text}\n[00:09.00]three`, 12_000);
    for (const yPos of [0, 100]) {
      const look = lookFor({ yPos });
      const { mode, rows } = drift(0, look, lines);
      mode.paint(cue(1, 4000));
      const height = rows[1]?.offsetHeight ?? 0;
      expect(height).toBeGreaterThan(look.size * 1.12 * 2);
      const center = look.y + yOf(rows[1]);
      expect(center - height / 2, `yPos ${yPos}`).toBeGreaterThanOrEqual(0);
      expect(center + height / 2, `yPos ${yPos}`).toBeLessThanOrEqual(720);
    }
  });

  it("keeps neighbor lines at least 11 px tall at a small size", () => {
    const look = lookFor({ size: 22 });
    const { mode, rows } = drift(0, look);
    mode.paint(cue(1, 5000));
    expect(look.size * scaleOf(rows[0])).toBeGreaterThanOrEqual(11);
    expect(look.size * scaleOf(rows[2])).toBeGreaterThanOrEqual(11);
  });
});

describe("Drift restyle", () => {
  it("takes new colors without rebuilding or stopping a glide", () => {
    const { mode, rows, host } = drift();
    mode.paint(cue(0, 2000));
    clock += 16;
    mode.paint(cue(1, 4300));
    clock += 100;
    mode.paint(cue(1, 4400));
    const glide = scrolling(rows[1]);
    expect(glide.length).toBe(1);
    const red = { lyric: "#ffffff", highlight: "#ff0000", dim: "#333333" };
    mode.restyle(lookFor({ colors: red, glow: 80 }));
    clock += 16;
    expect(mode.paint(cue(1, 4416))).toBe(false);
    expect(scrolling(rows[1])).toEqual(glide);
    expect(host.find("drift")[0]?.style.getPropertyValue("--ut-hl")).toBe("#ff0000");
    expect(rows[1]?.style.getPropertyValue("color")).toBe("#ffffff");
    expect(rows[0]?.style.getPropertyValue("text-shadow")).toMatch(/rgba\(51, 51, 51, 1\.000\)/u);
  });
});

/** Reduced motion: every mode has the stage crossfade its line changes. */
function reduceMotion(): void {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

/** A stage on a fake host, mid-song, with the clock and opacities under the test's control. */
/** The house look in another style: the stage draws the picked look's style, not Settings.mode. */
const pick = (style: PickedLook["style"], over: Partial<PickedLook> = {}): PickedLook => ({ ...DEFAULT_PICK, style, ...over });

function stage(): { stage: LyricStage; root: FakeElement; scenes: () => FakeElement[] } {
  const host = new FakeElement("main");
  const s = keep(new LyricStage(asHtml(host)));
  s.setPickedLook(pick("stack"));
  s.setSettings(settings());
  const root = host.children[0] as FakeElement;
  return { stage: s, root, scenes: () => root.children.filter((c) => c.classList.contains("ut-scene")) };
}

const lyricsView = { kind: "lyrics", timeline: { lines: parseLrc(paperLanterns, 24_000), unsynced: false } } as const;
const fadeIn = (el: FakeElement | undefined): FakeAnimation | undefined => el?.animations.find((a) => a.keyframes[1]?.opacity === 1);
const fadeOut = (el: FakeElement | undefined): FakeAnimation | undefined => el?.animations.find((a) => a.keyframes[1]?.opacity === 0);

// Regression (fade-in-waits-invisible-loading): a new song waited 250 ms behind a loading state
// nobody could see yet.
describe("song changes", () => {
  it("brings lyrics in at once behind a loading state that hasn't shown anything yet", () => {
    const { stage: s, scenes } = stage();
    s.show({ kind: "loading" }, "b");
    clock += 300;
    s.show(lyricsView, "b");
    expect(scenes()).toHaveLength(1);
    expect(fadeIn(scenes()[0])?.options.delay).toBe(0);
  });

  it("still waits for a visible old song to fade out, however fast the new lyrics come", () => {
    const { stage: s, scenes } = stage();
    s.show(lyricsView, "a");
    clock += 5000;
    s.show({ kind: "loading" }, "b");
    clock += 20;
    s.show(lyricsView, "b");
    const [old, fresh] = scenes();
    expect(fadeOut(old)).toBeDefined();
    expect(fadeIn(fresh)?.options.delay).toBe(230);
  });

  it("waits for the loading pulse once it is on screen", () => {
    const { stage: s, scenes } = stage();
    s.show({ kind: "loading" }, "b");
    clock += 900;
    s.show(lyricsView, "b");
    expect(scenes()).toHaveLength(2);
    expect(fadeIn(scenes()[1])?.options.delay).toBe(250);
  });
});

// Regression (stage-fade-from-current): fades restarted from their nominal opacity, so a half-faded
// scene or a ghost copy flashed to full brightness.
describe("fades start from what is on screen", () => {
  it("fades a song out from wherever its own fade-in had got to", () => {
    const { stage: s, scenes } = stage();
    s.show(lyricsView, "a");
    clock += 600;
    const first = scenes()[0] as FakeElement;
    drawnOpacity.set(first, 0.44);
    s.show({ kind: "loading" }, "b");
    expect(fadeOut(first)?.keyframes[0]?.opacity).toBe(0.44);
    expect(fadeIn(first)?.cancelled).toBe(true);
  });

  it("starts a line's ghost copy at the scene's current opacity and restarts the scene's fade under it", () => {
    reduceMotion();
    const { stage: s, root, scenes } = stage();
    s.show(lyricsView, "a");
    clock += 1000;
    s.render(2000);
    const scene = scenes()[0] as FakeElement;
    drawnOpacity.set(scene, 0.7);
    s.render(4300);
    const ghost = root.children.find((c) => c.classList.contains("ut-ghost"));
    expect(fadeOut(ghost)?.keyframes[0]?.opacity).toBe(0.7);
    expect(scene.animations.filter((a) => !a.cancelled).map((a) => a.keyframes[0]?.opacity)).toEqual([0]);
  });

  it("doesn't ghost a line that changes before its song has started to fade in", () => {
    reduceMotion();
    const { stage: s, root } = stage();
    s.show(lyricsView, "a");
    clock += 5000;
    s.show({ kind: "loading" }, "b");
    s.show(lyricsView, "b");
    s.render(2000);
    clock += 100;
    s.render(4300);
    expect(root.children.some((c) => c.classList.contains("ut-ghost"))).toBe(false);
  });
});

describe("frames on a boundary", () => {
  it("knows every word boundary, and the line boundaries alone", () => {
    const map = cueMap(lyricsView.timeline);
    expect(untilNextChange(map, 4800)).toBe(200);
    expect(untilNextChange(map, 5016)).toBe(584);
    // Paper Lanterns' line starts (1, 4.2, 9 (the gap stamp), 12.5, 16.4 s). Its lingers ("river" 3.7 s
    // + 2.5, "home" 8.5 s + 2.5) would end after the next stamp, when they no longer change anything.
    expect(untilNextChange(map, 4800, false)).toBe(9000 - 4800);
    expect(untilNextChange(map, 9000, false)).toBe(12_500 - 9000);
    // a linger that ends before the next line does hand over to it
    const rest = cueMap({ lines: parseLrc("[00:01.00]one two\n[00:09.00]three", 12_000), unsynced: false });
    const end = rest.lyrics[0]?.words[1]?.end ?? 0;
    expect(untilNextChange(rest, end, false)).toBe(LINGER_MS);
  });

  it("lets Stack sleep through words (they run on the compositor), still following up a frame on a line start", () => {
    const { stage: s } = stage();
    s.show(lyricsView, "a");
    expect(s.wakesForWords).toBe(false);
    expect(s.nextChange(4200)).toBe(0);
    // the next thing is the dots of the break after "home" (8.5 s), coming in at 8.95 s
    expect(s.nextChange(4200)).toBe(8950 - 4200);
    expect(s.nextChange(4800)).toBe(8950 - 4800);
    expect(s.nextChange(8600)).toBe(350);
  });

  it("also wakes for the mode's own events: Stack's dots at the start of an instrumental break", () => {
    const { stage: s } = stage();
    s.show(lyricsView, "a");
    s.render(8600);
    // Paper Lanterns: "home" ends at 8.5 s, the empty stamp at 9 s; the dots come in at 8.95 s
    expect(s.nextChange(8600)).toBe(350);
  });

  it("passes the clock's rate to the mode: 0 while paused", () => {
    const { stage: s } = stage();
    s.show(lyricsView, "a");
    const seen: (number | undefined)[] = [];
    const scene = (s as unknown as { scene: { mode: DriftMode } }).scene;
    const paint = scene.mode.paint.bind(scene.mode);
    scene.mode.paint = (c: Cue): boolean => {
      seen.push(c.rate);
      return paint(c);
    };
    s.render(5000, 1.1);
    s.setPaused(true);
    s.render(5000, 1);
    expect(seen).toEqual([1.1, 0]);
  });
});

describe("Drift instrumental breaks", () => {
  it("brings three dots into focus for a long break, then the next line, then drops the dots", () => {
    const { mode, host, rows } = drift(0);
    mode.paint(cue(1, 8000));
    expect(host.find("ut-dot")).toHaveLength(0);
    clock += 16;
    mode.paint(cue(2, 10_000, true, true));
    expect(host.find("ut-dot")).toHaveLength(3);
    expect(host.find("drift-break")[0]?.style.getPropertyValue("visibility")).toBe("visible");
    // the dots run on the compositor: the group's pop and fade, each dot and its glow
    expect(host.find("ut-dots")[0]?.getAnimations()).toHaveLength(2);
    expect(host.find("ut-dot").every((d) => d.getAnimations().length === 1)).toBe(true);
    // no line sings karaoke during the break
    expect(rows.some((r) => r.classList.contains("has-fx"))).toBe(false);
    clock += 16;
    mode.paint(cue(2, 12_600));
    expect(rows[2]?.classList.contains("is-focus")).toBe(true);
    clock += 16;
    mode.paint(cue(2, 17_000));
    expect(host.find("ut-dot")).toHaveLength(0);
  });

  it("sends the line before a break back to plain text once its overlay has faded", () => {
    const { mode, rows } = drift(0);
    mode.paint(cue(1, 8000));
    expect(rows[1]?.classList.contains("has-fx")).toBe(true);
    expect(wordsOf(rows[1])[0]?.find("kw-fx")).toHaveLength(1);
    clock += 16;
    mode.paint(cue(1, 8960, true, false));
    expect(rows[1]?.classList.contains("has-fx")).toBe(false);
    // still fading
    expect(mode.nextChange(8960)).toBeLessThanOrEqual(420);
    clock += 500;
    mode.paint(cue(1, 9500, true, true));
    expect(wordsOf(rows[1])[0]?.find("kw-fx")).toHaveLength(0);
  });
});

describe("Drift's karaoke leaving focus", () => {
  /** Animations on a row's word boxes and everything in their overlays (the row's own scroll aside). */
  const wordMotion = (row: FakeElement | undefined): number =>
    wordsOf(row).reduce((n, w) => n + w.getAnimations().length + [...w.find("kw-fx"), ...w.find("kw-track"), ...w.find("kw-in"), ...w.find("kw-glow"), ...w.find("kl")].reduce((m, e) => m + e.getAnimations().length, 0), 0);

  it("stops a line sung through as it leaves, so its overlay fades out still", () => {
    const { mode, rows } = drift(0);
    mode.paint(cue(0, 2000));
    expect(wordMotion(rows[0])).toBeGreaterThan(0);
    clock += 16;
    // Paper Lanterns: "river" ends the first line at 3.7 s, the next one starts at 4.2 s
    mode.paint(cue(1, 4200));
    expect(rows[0]?.classList.contains("has-fx")).toBe(false);
    expect(wordsOf(rows[0])[0]?.find("kw-fx")).toHaveLength(1);
    expect(wordMotion(rows[0])).toBe(0);
    expect(wordMotion(rows[1])).toBeGreaterThan(0);
  });

  it("keeps a line left before it was sung (a seek back) moving with the song", () => {
    const { mode, rows } = drift(0);
    mode.paint(cue(1, 5000));
    const before = wordMotion(rows[1]);
    expect(before).toBeGreaterThan(0);
    clock += 16;
    mode.paint(cue(0, 2500));
    expect(rows[1]?.classList.contains("has-fx")).toBe(false);
    expect(wordMotion(rows[1])).toBe(before);
  });
});

// Regression (dpr-change-no-resize): layouts are snapped to device pixels, but only a resize rebuilt
// them, and a window moved between a 2× and a 1× screen of the same size never resizes.
describe("the stage on a device pixel ratio change", () => {
  interface Query {
    media: string;
    matches: boolean;
    listeners: Set<() => void>;
    addEventListener(type: string, fn: () => void): void;
    removeEventListener(type: string, fn: () => void): void;
  }
  let queries: Query[] = [];

  beforeEach(() => {
    queries = [];
    vi.stubGlobal("devicePixelRatio", 2);
    vi.stubGlobal("matchMedia", (media: string): Query => {
      const listeners = new Set<() => void>();
      const query: Query = {
        media,
        matches: false,
        listeners,
        addEventListener: (_type, fn) => listeners.add(fn),
        removeEventListener: (_type, fn) => listeners.delete(fn),
      };
      queries.push(query);
      return query;
    });
  });

  const watched = (): Query[] => queries.filter((q) => q.media.startsWith("(resolution") && q.listeners.size > 0);

  it("rebuilds with the new ratio, then watches that one; destroy stops watching", () => {
    const { stage: s, scenes } = stage();
    s.show(lyricsView, "a");
    const before = scenes()[0]?.find("drift")[0];
    expect(watched().map((q) => q.media)).toEqual(["(resolution: 2dppx)"]);

    vi.stubGlobal("devicePixelRatio", 1);
    for (const fn of [...(watched()[0]?.listeners ?? [])]) fn();
    expect(scenes()[0]?.find("drift")[0]).not.toBe(before);
    expect(watched().map((q) => q.media)).toEqual(["(resolution: 1dppx)"]);

    s.destroy();
    expect(watched()).toEqual([]);
  });
});

// Regression (cjk-fallback-order): every song got one fixed CJK fallback order, and the page said
// lang="en", so Chinese lines mixed Japanese and Chinese faces.
describe("the stage's CJK language", () => {
  const song = (text: string): StageView => ({
    kind: "lyrics",
    timeline: { lines: parseLrc(`[00:01.00]${text}\n[00:05.00]${text}`, 20_000), unsynced: false },
  });

  it("is picked once per song, set on the scene, and puts that language's faces first", () => {
    const { stage: s, scenes } = stage();
    s.show(song("夜明けの駅で、紙の鳥が待っている"), "ja");
    const ja = scenes()[0];
    expect((ja as unknown as { lang?: string }).lang).toBe("ja");
    expect(String(ja?.find("drift")[0]?.style["fontFamily"])).toMatch(/^"Fraunces", Georgia, "Hiragino Mincho ProN"/);
    clock += 5000;
    s.show(song("灯笼漂过安静的河面，我们说好再见"), "zh");
    const zh = scenes()[scenes().length - 1];
    expect((zh as unknown as { lang?: string }).lang).toBe("zh-Hans");
    expect(String(zh?.find("drift")[0]?.style["fontFamily"])).toMatch(/^"Fraunces", Georgia, "Songti SC"/);
  });

  it("leaves a song without CJK text, and the states, in the page's language", () => {
    const { stage: s, scenes } = stage();
    s.show(lyricsView, "a");
    expect((scenes()[0] as unknown as { lang?: string }).lang).toBeUndefined();
    expect(String(scenes()[0]?.find("drift")[0]?.style["fontFamily"])).toBe(fontFor("Fraunces").stack);
  });
});

describe("the stage's reference height", () => {
  it("asks for one given as a function on every layout (the overlay's follows its screen)", () => {
    let reference = 720;
    const host = new FakeElement("main");
    const s = keep(new LyricStage(asHtml(host), { referenceHeight: () => reference }));
    s.setPickedLook(pick("stack"));
    s.setSettings(settings());
    s.show(lyricsView, "a");
    const drift = (): FakeElement | undefined => host.find("drift")[0];
    expect(drift()?.style["fontSize"]).toBe("58px");
    reference = 360;
    s.setSettings(settings({ glow: 41 }));
    expect(drift()?.style["fontSize"]).toBe("116px");
  });
});

describe("the stage while paused", () => {
  it("tells the mode the clock isn't running", () => {
    const { stage: s } = stage();
    s.show(lyricsView, "a");
    const seen: boolean[] = [];
    const scene = (s as unknown as { scene: { mode: DriftMode } }).scene;
    const paint = scene.mode.paint.bind(scene.mode);
    scene.mode.paint = (c: Cue): boolean => {
      seen.push(c.running);
      return paint(c);
    };
    s.render(5000);
    s.setPaused(true);
    s.render(5000);
    s.setPaused(false);
    s.render(5016);
    expect(seen).toEqual([true, false, true]);
  });

  it("restyles instead of rebuilding for colors, glow and opacity", () => {
    const { stage: s, scenes } = stage();
    s.show(lyricsView, "a");
    const before = scenes()[0]?.find("drift")[0];
    s.setSettings(settings({ glow: 90, opacity: 50, colors: { lyric: "#ffffff", highlight: "#ff0000", dim: "#333333" } }));
    expect(scenes()[0]?.find("drift")[0]).toBe(before);
    s.setSettings(settings({ size: 80 }));
    expect(scenes()[0]?.find("drift")[0]).not.toBe(before);
  });
});

// Regression (chip-short-hold): the chip's 4 s animation started at build and included its own
// fade-in, so it was fully readable for only about 2.5 s.
describe("the not-found chip", () => {
  it("holds for 4 s after its scene has faded in, then fades out", () => {
    const host = new FakeElement("div");
    buildState(asHtml(host), "not-found", lookFor());
    expect(host.children[0]?.style["animationDelay"]).toBe("4700ms");
  });

  it("resumes where it was after a rebuild, so a faded chip stays gone", () => {
    const host = new FakeElement("div");
    buildState(asHtml(host), "not-found", lookFor(), 6000);
    expect(host.children[0]?.style["animationDelay"]).toBe("-1300ms");
  });
});

/**
 * stage.css without comments, read from disk: vitest hands CSS imports (even ?raw) to its CSS pipeline,
 * which yields "" in node. A non-literal specifier, because the strict type check runs without node's types.
 */
async function stageCss(): Promise<string> {
  const fsModule = "node:fs";
  const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: URL, encoding: "utf8"): string };
  return fs.readFileSync(new URL("../src/styles/stage.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** A stylesheet's top-level `prelude { body }` blocks; nested blocks stay whole in their body. */
function blocks(sheet: string): { prelude: string; body: string }[] {
  const out: { prelude: string; body: string }[] = [];
  let depth = 0;
  let start = 0;
  let open = 0;
  for (let i = 0; i < sheet.length; i++) {
    if (sheet[i] === "{" && depth++ === 0) open = i;
    if (sheet[i] === "}" && --depth === 0) {
      out.push({ prelude: sheet.slice(start, open).trim(), body: sheet.slice(open + 1, i) });
      start = i + 1;
    }
  }
  return out;
}

// Regression (reduced-motion-loading-pulse): under reduced motion the loading dots kept pulsing forever;
// only the instrumental ♪ had stopped breathing. C6: reduced motion means crossfades only.
describe("stage.css under reduced motion", () => {
  let css = "";
  beforeAll(async () => {
    css = await stageCss();
  });

  const animationOf = (body: string): string => /(?:^|;)\s*animation\s*:\s*([^;]*)/.exec(body)?.[1]?.trim() ?? "";
  /** The rules inside `@media (prefers-reduced-motion: reduce)`, by selector. */
  const reducedRules = (): Map<string, string> => {
    const media = blocks(css).find((b) => /^@media\s*\(prefers-reduced-motion:\s*reduce\)$/.test(b.prelude));
    const rules = new Map<string, string>();
    for (const rule of blocks(media?.body ?? "")) for (const sel of rule.prelude.split(",")) rules.set(sel.trim(), rule.body);
    return rules;
  };

  it("stops every endless state animation", () => {
    const endless = blocks(css).filter((b) => !b.prelude.startsWith("@") && /\binfinite\b/.test(animationOf(b.body)));
    expect(endless.map((b) => b.prelude)).toEqual(expect.arrayContaining([".state-loading", ".state-instrumental"]));
    const reduced = reducedRules();
    for (const rule of endless) {
      for (const sel of rule.prelude.split(",").map((x) => x.trim())) {
        const body = reduced.get(sel);
        expect(body, sel).toBeDefined();
        expect(animationOf(body ?? ""), sel).not.toMatch(/\binfinite\b/);
      }
    }
  });

  it("brings the loading dots in with one fade after the same quiet start, then holds them still", () => {
    const animation = animationOf(reducedRules().get(".state-loading") ?? "");
    expect(animation).toMatch(/\bforwards\b/);
    const name = animation.split(/\s+/)[0] ?? "";
    const frames = blocks(css).find((b) => b.prelude === `@keyframes ${name}`)?.body ?? "";
    // a fade from nothing, no movement
    expect(frames).toMatch(/from\s*\{\s*opacity:\s*0;?\s*\}/);
    expect(frames).not.toMatch(/transform/);
    // to a level that can still be seen
    expect(Number(/\bto\s*\{\s*opacity:\s*([\d.]+)/.exec(frames)?.[1])).toBeGreaterThan(0.1);
    // the quiet start is the inline delay states.ts sets, which the sheet's shorthand can't override
    const host = new FakeElement("div");
    buildState(asHtml(host), "loading", lookFor());
    expect(host.children[0]?.style["animationDelay"]).toBe("600ms");
  });
});

/** WCAG relative luminance of an sRGB color, 0-255 per channel. */
function luminance([r, g, b]: number[]): number {
  const lin = (c: number): number => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r ?? 0) + 0.7152 * lin(g ?? 0) + 0.0722 * lin(b ?? 0);
}
const rgbOf = (hex: string): number[] => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const contrast = (a: number[], b: number[]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

describe("stage.css legibility", () => {
  let css = "";
  beforeAll(async () => {
    css = await stageCss();
  });
  const rule = (selector: string): string => blocks(css).find((b) => b.prelude === selector)?.body ?? "";

  // Regression (chip-contrast): the not-found and error chips' 0.42 dark fill left light lyric text at
  // about 2.8:1 over a light wallpaper, under the 4.5:1 that 17 px text needs.
  it("keeps the chip's text at 4.5:1 or better over a white wallpaper, and gives it the lyrics' dark shadow", () => {
    const m = /background:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(rule(".state-chip"));
    expect(m).not.toBeNull();
    const alpha = Number(m?.[4]);
    const fill = [1, 2, 3].map((i) => Number(m?.[i]) * alpha + 255 * (1 - alpha));
    // the default lyric color, and the bluest album lyric color paletteFromPixels makes (HSL lightness 0.92, saturation 0.3)
    for (const lyric of [DEFAULT_SETTINGS.colors.lyric, "#e4e4f1"]) expect(contrast(rgbOf(lyric), fill), lyric).toBeGreaterThanOrEqual(4.5);
    const host = new FakeElement("div");
    buildState(asHtml(host), "not-found", lookFor());
    expect(String(host.children[0]?.style["textShadow"])).toMatch(/rgba\(0, 0, 0,/);
  });

  // Windows Contrast themes force every color, shadows off: word states, drawn by color alone, vanished.
  it("keeps the lyric colors and shadows under forced colors", () => {
    expect(rule(".ut-stage")).toMatch(/forced-color-adjust:\s*none/);
  });

  // Drift and Stack left one word alone on the last row of a wrapped lyric.
  it("balances the rows of a wrapped Drift or Stack line", () => {
    expect(rule(".drift-row")).toMatch(/text-wrap:\s*balance/);
  });
});

// DoD (C6 performance budget): with nothing to sing, the stage gives the frame loop nothing to wake
// for, so the controller only takes its 250 ms safety wake (tests/regress-foundation-controller.test.ts).
describe("the stage with nothing to sing", () => {
  it("asks for no frames in any state", () => {
    for (const kind of ["loading", "not-found", "instrumental", "error"] as const) {
      const { stage: s } = stage();
      s.show({ kind }, "a");
      for (const t of [0, 5000, 60_000]) {
        expect(s.render(t), kind).toBe(false);
        expect(s.nextChange(t), kind).toBe(Infinity);
      }
    }
  });

  it("asks for none once the last line has lingered", () => {
    const { stage: s } = stage();
    s.show(lyricsView, "a");
    // Paper Lanterns' last word ends at 20 s; its line stays lit, and nothing changes after it (Stack
    // draws the last word's end on the compositor: no frame for it; the last line has nothing to linger for)
    s.render(19_500);
    expect(s.nextChange(19_500)).toBe(Infinity);
    for (const t of [20_000 + LINGER_MS + 1, 30_000]) {
      expect(s.render(t)).toBe(false);
      expect(s.nextChange(t)).toBe(Infinity);
    }
  });
});

/** A transform's translate y, px. */
const yIn = (transform: string | undefined): number => Number(/translate(?:3d)?\([-\d.]+px, (-?[\d.]+)px/u.exec(transform ?? "")?.[1]);
/** A wipe track's translateX, px. */
const xIn = (transform: string | undefined): number => Number(/translateX\((-?[\d.]+)px\)/u.exec(transform ?? "")?.[1]);

describe("the stage and the picked look", () => {
  it("draws the picked look's style, whatever Settings.mode says", () => {
    const { stage: s, scenes } = stage();
    s.show(lyricsView, "a");
    s.render(5000);
    const rowTransform = (): string => scenes()[0]?.find("drift-row")[0]?.style.getPropertyValue("transform") ?? "";
    // Stack: flat transforms
    expect(rowTransform()).toMatch(/^translate\(/u);
    s.setSettings(settings({ mode: "lens" }));
    s.render(5016);
    expect(rowTransform()).toMatch(/^translate\(/u);
    s.setPickedLook(pick("drift"));
    s.render(5032);
    expect(rowTransform()).toMatch(/^translate3d\(/u);
    expect(s.pickedLook.style).toBe("drift");
    // no pick: the house look
    const fresh = keep(new LyricStage(asHtml(new FakeElement("main"))));
    expect(fresh.pickedLook).toBe(DEFAULT_PICK);
    fresh.setPickedLook(pick("lens"));
    fresh.setPickedLook(null);
    expect(fresh.pickedLook).toBe(DEFAULT_PICK);
  });

  it("restyles for colors, glow and bloom, re-plans the focus line for the motion, and rebuilds for a new shape", () => {
    const { stage: s, scenes } = stage();
    s.show(lyricsView, "a");
    s.render(4800);
    const box = scenes()[0]?.find("drift")[0];
    const word = (): FakeElement | undefined => scenes()[0]?.find("drift-row")[1]?.find("kw")[1];
    const before = word()?.getAnimations() ?? [];
    expect(before.length).toBeGreaterThan(0);
    s.setSettings(settings({ glow: 90 }));
    expect(scenes()[0]?.find("drift")[0]).toBe(box);
    expect(box?.style.getPropertyValue("--ut-bloom")).toBe(bloomShadow(DEFAULT_SETTINGS.colors.highlight, bloomOf(DEFAULT_PICK.glow, 90)));
    expect(before.every((a) => !a.cancelled)).toBe(true);
    // a livelier pick: the same rows, the focus line planned again where the song is
    s.setPickedLook(pick("stack", { energy: 0.9 }));
    expect(scenes()[0]?.find("drift")[0]).toBe(box);
    expect(before.every((a) => a.cancelled)).toBe(true);
    const after = word()?.getAnimations() ?? [];
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]?.currentTime).toBeCloseTo(4800 - 4200, 6);
    // a face is a shape
    s.setPickedLook(pick("stack", { energy: 0.9, font: { family: "Syne", weight: 800 } }));
    expect(scenes()[0]?.find("drift")[0]).not.toBe(box);
  });

  it("crossfades a new shape in behind a still copy of what was on screen", () => {
    const { stage: s, root, scenes } = stage();
    s.show(lyricsView, "a");
    clock += 1000;
    s.render(4800);
    clock += 100;
    // "the" (4.8-5.0 s) is mid-pop: what it draws now
    const sung = scenes()[0]?.find("drift-row")[1]?.find("kw")[1];
    const shown = sung?.getAnimations()[0]?.values().transform;
    expect(shown).toBeDefined();
    expect(shown).not.toBe("none");
    s.setPickedLook(pick("drift"), "crossfade");
    const ghost = root.children.find((c) => c.classList.contains("ut-ghost"));
    expect(ghost).toBeDefined();
    expect(fadeOut(ghost)?.options.duration).toBe(170);
    // the copy shows the word as it was drawn, not as its line ends
    const copy = ghost?.find("drift-row")[1]?.find("kw")[1];
    expect(copy?.style.getPropertyValue("transform")).toBe(shown);
    // and the scene behind it is the new look, fading in
    s.render(4916);
    expect(scenes()[0]?.find("drift-row")[0]?.style.getPropertyValue("transform")).toMatch(/^translate3d\(/u);
  });

  it("calls safe points at the first paint before the first line, at each line change and as a long break starts", () => {
    let safe = 0;
    const host = new FakeElement("main");
    const s = keep(new LyricStage(asHtml(host), { onSafePoint: () => safe++ }));
    s.setPickedLook(pick("stack"));
    s.setSettings(settings());
    s.show(lyricsView, "a");
    s.render(500);
    expect(safe).toBe(1);
    s.render(1200);
    expect(safe).toBe(1);
    s.render(4300);
    expect(safe).toBe(2);
    // "home" ends at 8.5 s, the next line comes at 12.5 s: a break, woken for
    s.render(4800);
    expect(s.nextChange(7000)).toBe(1500);
    s.render(8000);
    s.render(8600);
    expect(safe).toBe(3);
    s.render(9100);
    expect(safe).toBe(4);
    expect([500, 5000, 9000, 12_300, 17_000].map((t) => s.atSafePoint(t))).toEqual([true, false, true, false, false]);
  });

  it("follows a quiet sample with retime, and says when a paint is due after all", () => {
    const { stage: s } = stage();
    s.show(lyricsView, "a");
    expect(s.retime(3800)).toBe(true);
    s.render(3800);
    expect(s.retime(3850, 1, 3870)).toBe(false);
    // line 1's lead (3.9 s) comes before the stage's line changes (4.2 s): the list wants a paint
    expect(s.retime(3950, 1, 3950)).toBe(true);
    // a new line on the stage: a paint
    expect(s.retime(4300, 1, 4300)).toBe(true);
  });
});

describe("Stack and Drift on the motion engine", () => {
  it("move to a line 300 ms before it starts", () => {
    const { mode, rows } = drift(0);
    mode.paint(cue(0, 3800));
    clock += 99;
    mode.paint(cue(0, 3899));
    expect(rows[0]?.classList.contains("is-focus")).toBe(true);
    expect(scrolling(rows[1])).toEqual([]);
    clock += 1;
    // line 1 starts at 4.2 s: the list is on its way there at 3.9 s, the line waiting, its overlay mounted
    mode.paint(cue(0, 3900));
    expect(rows[1]?.classList.contains("is-focus")).toBe(true);
    expect(rows[1]?.classList.contains("has-fx")).toBe(true);
    expect(scrolling(rows[1])).toHaveLength(1);
    const wipe = partOf(rows[1], 0, "kw-track")?.getAnimations()[0];
    expect(xIn(wipe?.values().transform)).toBeLessThan(0);
    // the mode wakes for its own events: the old line's overlay to drop once faded, then the break's dots at 8.95 s
    expect(mode.nextChange(4000)).toBe(3900 + 420 - 4000);
    clock += 500;
    mode.paint(cue(1, 4400));
    expect(mode.nextChange(4400)).toBe(8950 - 4400);
  });

  it("glide from what is on screen when the song seeks one to three lines, either way", () => {
    const { mode, rows } = drift(0, lookFor(), EIGHT);
    mode.paint(cue(1, 3500));
    clock += 16;
    expect(mode.crossfades(cue(3, 7500))).toBe(false);
    mode.paint(cue(3, 7500));
    const down = scrolling(rows[2])[0];
    expect(down?.startTime).toBe(clock);
    clock += 150;
    const shown = yIn(down?.values().transform);
    // a seek back two lines, mid-glide: the list turns around from where it is, moving
    expect(mode.crossfades(cue(1, 3700))).toBe(false);
    mode.paint(cue(1, 3700));
    expect(down?.cancelled).toBe(true);
    const up = scrolling(rows[2])[0];
    expect(up?.startTime).toBe(clock);
    expect(Math.abs(yIn(valuesAt(up?.keyframes ?? [], 0).transform) - shown)).toBeLessThan(0.3);
  });

  it("re-light the focus line after a seek back past what its animations still cover", () => {
    // Paper Lanterns' last line: "Light is a promise the water keeps" 16.4-20 s; its motion is over by
    // about 21.3 s, and a paint at 21.7 s drops it. Seeking back to 17 s must not leave it fully lit.
    const { mode, rows } = drift(0);
    mode.paint(cue(3, 16_500));
    // the wipes drawing anything (an engine drops finished animations; the fake keeps them)
    const tracks = (): FakeAnimation[] =>
      wordsOf(rows[3])
        .flatMap((w) => w.find("kw-track"))
        .flatMap((e) => e.getAnimations())
        .filter((a) => a.playState !== "finished");
    const first = tracks();
    clock += 16;
    mode.paint(cue(3, 18_000));
    // a seek the animations still cover needs nothing new
    expect(tracks()).toEqual(first);
    clock += 16;
    mode.paint(cue(3, 21_700));
    clock += 16;
    mode.paint(cue(3, 17_000));
    const after = tracks();
    expect(after).toHaveLength(first.length);
    expect(after.some((a) => first.includes(a))).toBe(false);
    // "promise" (17.3 s) waits unlit at 17 s, "is" (16.9-17.1 s) is being lit
    const drawing = (el: FakeElement | undefined): FakeAnimation | undefined => el?.getAnimations().find((a) => a.playState !== "finished");
    const promise = drawing(partOf(rows[3], 3, "kw-track"));
    expect(xIn(promise?.values().transform)).toBeLessThan(-50);
    const is = drawing(partOf(rows[3], 1, "kw-track"));
    expect(xIn(is?.values().transform)).toBeLessThan(0);
    expect(xIn(is?.values().transform)).toBeGreaterThan(xIn(promise?.values().transform));
  });

  it("leave a ghost on a far seek that shows what was on screen, not the line's end", () => {
    const { stage: s, root, scenes } = stage();
    s.show({ kind: "lyrics", timeline: { lines: EIGHT, unsynced: false } }, "a");
    clock += 1000;
    s.render(1100);
    clock += 300;
    const word = scenes()[0]?.find("drift-row")[0]?.find("kw")[0];
    const shown = word?.getAnimations()[0]?.values().transform;
    expect(shown).not.toBe("translate(0px, 0px) scale(1)");
    s.render(13_500);
    const ghost = root.children.find((c) => c.classList.contains("ut-ghost"));
    expect(ghost?.find("drift-row")[0]?.find("kw")[0]?.style.getPropertyValue("transform")).toBe(shown);
  });

  it("keep the scroll but draw the reduced karaoke in the lite tier", () => {
    const { mode, rows } = drift(0, lookFor({}, { power: "lite" }));
    mode.paint(cue(0, 2000));
    clock += 16;
    mode.paint(cue(1, 4300));
    expect(scrolling(rows[1])).toHaveLength(1);
    const w = wordsOf(rows[1])[0];
    expect(w?.getAnimations()).toEqual([]);
    expect(w?.find("kw-win")[0]?.getAnimations()).toHaveLength(1);
    expect(w?.find("kw-win")[0]?.style.getPropertyValue("mask-image")).toBe("");
    expect(w?.find("kw-dark")[0]?.find("kl")).toEqual([]);
    // a steady 0.6 bloom while it is sung, faded in and out
    expect(w?.find("kw-glow")[0]?.getAnimations()[0]?.keyframes.map((k) => k.opacity)).toEqual([0, 0.6, 0.6, 0, 0]);
  });

  it("only fade under reduced motion, and cut every line change for the stage to crossfade", () => {
    const { mode, rows } = drift(0, lookFor({}, { motion: false }));
    mode.paint(cue(0, 2000));
    expect(mode.crossfades(cue(1, 4300))).toBe(true);
    clock += 16;
    mode.paint(cue(1, 4300));
    expect(scrolling(rows[1])).toEqual([]);
    expect(wordsOf(rows[1]).every((w) => w.getAnimations().length === 0)).toBe(true);
    // no lead without motion: the list follows the stage's line; next, the old overlay goes, then the dots
    expect(mode.nextChange(4300)).toBe(420);
    clock += 500;
    mode.paint(cue(1, 4800));
    expect(mode.nextChange(4800)).toBe(8950 - 4800);
  });

  it("fold the break's slot away once the list has moved past it", () => {
    const { mode, host } = drift(0);
    const slot = host.find("drift-break")[0];
    mode.paint(cue(1, 8000));
    expect(slot?.style.getPropertyValue("visibility")).toBe("hidden");
    clock += 16;
    mode.paint(cue(2, 10_000, true, true));
    expect(slot?.style.getPropertyValue("visibility")).toBe("visible");
    expect(slot?.style.getPropertyValue("will-change")).toBe("transform, opacity");
    // E = 12.2 s: the list moves on to "Fold a wish...", the slot folding as it goes
    clock += 16;
    mode.paint(cue(2, 12_250, true, true));
    expect(host.find("drift-row")[2]?.classList.contains("is-focus")).toBe(true);
    clock += 3000;
    mode.paint(cue(2, 15_000));
    expect(slot?.style.getPropertyValue("visibility")).toBe("hidden");
    expect(slot?.style.getPropertyValue("will-change")).toBe("auto");
  });

  it("set the look's letter-spacing and case, and measure with them", () => {
    const l = resolveLook(settings(), null, { width: 1280, height: 720, dpr: 1, motion: true, unsynced: false }, pick("stack", { letterSpacing: 0.04, textCase: "upper" }));
    const { mode, host, rows } = drift(0, l);
    expect(host.find("drift")[0]?.style["letterSpacing"]).toBe("0.04em");
    expect(rows[0]?.textContent).toBe("PAPER LANTERNS OVER THE RIVER");
    mode.paint(cue(0, 2000));
    expect(wordsOf(rows[0])[0]?.find("kw-win")[0]?.find("kl").map((x) => x.textContent).join("")).toBe("PAPER");
  });

  it("carry the karaoke's CSS variables, the dark shadow drawn for each row's own size", () => {
    const long = parseLrc(`[00:01.00]${"placeholder words that keep on going ".repeat(9)}\n[00:09.00]short line`, 12_000);
    const look = lookFor({ size: 140 });
    const { host, rows } = drift(0, look, long);
    const box = host.find("drift")[0];
    expect(box?.style.getPropertyValue("--ut-dark")).toBe(textShadow(look, look.size));
    expect(box?.style.getPropertyValue("--ut-bloom")).toBe(bloomShadow(look.colors.highlight, look.bloom));
    expect(box?.style.getPropertyValue("--ut-hl")).toBe(look.colors.highlight);
    const size = Number.parseFloat(String(rows[0]?.style["fontSize"]));
    expect(size).toBeLessThan(look.size);
    expect(rows[0]?.style.getPropertyValue("--ut-dark")).toBe(textShadow(look, size));
    expect(rows[1]?.style.getPropertyValue("--ut-dark")).toBe("");
  });
});

/** A bridge that answers commands from fixed values and lets the test send events. */
class StubBridge implements Bridge {
  readonly kind = "mock" as const;
  readonly answers: Partial<{ [C in Command]: ResultOf<C> }> = {};
  private readonly handlers = new Map<Event, Set<(payload: never) => void>>();

  invoke<C extends Command>(command: C, ..._args: ArgsOf<C>): Promise<ResultOf<C>> {
    return Promise.resolve(this.answers[command] as ResultOf<C>);
  }

  listen<E extends Event>(event: E, handler: (payload: Events[E]) => void): Promise<Unlisten> {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (payload: never) => void);
    this.handlers.set(event, set);
    return Promise.resolve(() => set.delete(handler as (payload: never) => void));
  }

  emit<E extends Event>(event: E, payload: Events[E]): void {
    for (const h of this.handlers.get(event) ?? []) (h as (p: Events[E]) => void)(payload);
  }
}

// DoD (C6 performance budget), end to end: the overlay as overlay/main.ts builds it (a gated controller,
// the stage invalidating through it) on the real stage, through a song, its states and a pause.
describe("the overlay's frame loop on a real stage", () => {
  const T0 = 1_760_000_000_000;
  let frames = new Map<number, FrameRequestCallback>();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(T0);
    frames = new Map();
    let lastId = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
      frames.set(++lastId, cb);
      return lastId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
      frames.delete(id);
    });
    vi.stubGlobal("document", {
      createElement: (tag: string) => new FakeElement(tag),
      visibilityState: "visible",
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets `ms` pass in 16 ms vsyncs, the stage's animation clock with it; frames requested by each vsync run. */
  function run(ms: number): void {
    for (let elapsed = 0; elapsed < ms; elapsed += 16) {
      vi.advanceTimersByTime(16);
      clock += 16;
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb(Date.now());
    }
  }

  const SONG = 24_000;
  const track = (trackKey: string, over: Partial<NowPlaying> = {}): NowPlaying => ({
    source: "spotify",
    trackKey,
    title: trackKey,
    artist: "Demo Artist",
    album: "Undertone Demo",
    durationMs: SONG,
    positionMs: 0,
    sampledAt: Date.now(),
    isPlaying: true,
    artwork: null,
    ...over,
  });
  const result = (trackKey: string, status: Lyrics["status"], synced: string | null = null): Lyrics => ({
    trackKey,
    status,
    synced,
    plain: null,
    source: "lrclib",
  });

  async function overlay(): Promise<{ bridge: StubBridge; host: FakeElement; paints: number[]; controller: OverlayController }> {
    const bridge = new StubBridge();
    bridge.answers.get_settings = settings();
    bridge.answers.get_now_playing = track("a");
    bridge.answers.get_lyrics = result("a", "loading");
    // as overlay/main.ts wires them (with `?look=stack`)
    const host = new FakeElement("main");
    let controller: OverlayController | null = null;
    const s = keep(new LyricStage(asHtml(host), { onInvalidate: () => controller?.kick(), onSafePoint: () => controller?.safePoint() }));
    controller = new OverlayController(bridge, s, { gate: true, palettes: new PaletteCache(async () => null) });
    controller.forceLook({ style: "stack" });
    const paints: number[] = [];
    const render = s.render.bind(s);
    s.render = (t: number): boolean => {
      paints.push(Date.now());
      return render(t);
    };
    await controller.start();
    return { bridge, host, paints, controller };
  }

  /**
   * Over the next `ms`, the loop only takes its safety wake (`sleep` ms: 250, or 1000 for a mode whose
   * words run on the compositor): the timer plus the next vsync, never two paints closer, yet awake.
   */
  function expectAsleep(paints: number[], ms: number, what: string, sleep = 250): void {
    const from = paints.length;
    run(ms);
    const times = paints.slice(from);
    const gaps = times.slice(1).map((t, i) => t - (times[i] ?? t));
    expect(times.length, what).toBeGreaterThanOrEqual(Math.floor(ms / (sleep + 12)));
    expect(times.length, what).toBeLessThanOrEqual(Math.ceil(ms / (sleep - 4)));
    expect(Math.min(...gaps), what).toBeGreaterThanOrEqual(sleep - 4);
  }

  it("sleeps through loading, after the last line and in empty states, and stops on pause", async () => {
    const { bridge, host, paints, controller } = await overlay();
    // past the start-up kicks and the 1.5 s wait for artwork
    run(1600);
    expectAsleep(paints, 2000, "loading");

    // the song plays through, then sits after its last line
    bridge.emit("lyrics", result("a", "found", paperLanterns));
    expect(host.find("drift-row").length).toBeGreaterThan(0);
    run(20_000 + LINGER_MS + 600 - (Date.now() - T0));
    // Stack's words run on the compositor: past its last line it only takes a safety wake a second
    expectAsleep(paints, 5000, "after the last line", 1000);

    for (const status of ["instrumental", "not-found"] as const) {
      bridge.emit("now-playing", track(status));
      bridge.emit("lyrics", result(status, status));
      expect(host.find(`state-${status}`), status).toHaveLength(1);
      run(2000);
      expectAsleep(paints, 5000, status);
    }

    bridge.emit("now-playing", track("not-found", { isPlaying: false, positionMs: 9000 }));
    run(16);
    const from = paints.length;
    run(10_000);
    expect(paints.length - from).toBe(0);
    controller.destroy();
  });
});
