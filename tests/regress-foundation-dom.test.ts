import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../contract/contract";
import { parseLrc, type Line } from "../src/core/lrc";
import { resolveLook, type Frame, type Look } from "../src/overlay/look";
import { DriftMode } from "../src/overlay/modes/drift";
import type { Cue } from "../src/overlay/modes/types";
import { LyricStage } from "../src/overlay/stage";
import { buildState } from "../src/overlay/states";
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

class FakeAnimation {
  readonly keyframes: Keyframe[];
  readonly options: KeyframeAnimationOptions;
  readonly finished: Promise<void>;
  cancelled = false;
  private reject: (e: Error) => void = () => undefined;
  constructor(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    this.keyframes = keyframes;
    this.options = options;
    this.finished = new Promise<void>((_, reject) => {
      this.reject = reject;
    });
  }
  cancel(): void {
    this.cancelled = true;
    this.reject(new Error("AbortError"));
  }
}

let stageSize = { width: 1280, height: 720 };

class FakeElement {
  readonly tagName: string;
  className = "";
  dir = "";
  style = new FakeStyle();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  ownText = "";
  readonly attrs = new Map<string, string>();
  animations: FakeAnimation[] = [];
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
  get clientWidth(): number {
    return stageSize.width;
  }
  get clientHeight(): number {
    return stageSize.height;
  }
  /** Rows wrap at 88% of the stage width with glyphs about 0.5 em wide, 1.12 em per row. */
  get offsetHeight(): number {
    const size = this.fontSize();
    const width = this.textContent.length * size * 0.5;
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
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): FakeAnimation {
    const anim = new FakeAnimation(keyframes, options);
    this.animations.push(anim);
    return anim;
  }
  getAnimations(): FakeAnimation[] {
    return this.animations.filter((a) => !a.cancelled);
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

afterEach(() => {
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
  const mode = new DriftMode(depth);
  mode.build(asHtml(host), lines, look);
  return { mode, host, rows: host.find("drift-row") };
}

const cue = (line: number, t: number, running = true, waiting = false): Cue => ({ line, t, running, waiting });
const scaleOf = (row: FakeElement | undefined): number => Number(/scale\(([\d.]+)\)/u.exec(row?.style.getPropertyValue("transform") ?? "")?.[1]);
const yOf = (row: FakeElement | undefined): number => Number(/calc\(-50% \+ (-?[\d.]+)px\)/u.exec(row?.style.getPropertyValue("transform") ?? "")?.[1]);

// Regression (drift-paused-freeze): Drift glided from performance.now(), and no frame follows a paused
// paint, so a glide caught by a pause froze halfway and a seek while paused left the old line centered.
describe("Drift while paused", () => {
  it("lands a glide in flight on its line in the paint that pauses it", () => {
    const { mode, rows } = drift();
    mode.paint(cue(0, 2000));
    clock += 16;
    expect(mode.paint(cue(1, 4300))).toBe(true);
    clock += 150;
    expect(mode.paint(cue(1, 4450))).toBe(true);
    expect(scaleOf(rows[1])).toBeLessThan(1);
    // paused
    expect(mode.paint(cue(1, 4450, false))).toBe(false);
    expect(scaleOf(rows[1])).toBe(1);
    expect(yOf(rows[1])).toBe(0);
    expect(scaleOf(rows[0])).toBeCloseTo(0.58, 4);
    // ...and resuming doesn't jump back into the glide
    clock += 100;
    expect(mode.paint(cue(1, 4460))).toBe(false);
    expect(scaleOf(rows[1])).toBe(1);
  });

  it("cuts to the line a paused seek lands on, and has the stage crossfade it", () => {
    const { mode, rows } = drift();
    mode.paint(cue(1, 5000));
    mode.paint(cue(1, 5000, false));
    expect(mode.crossfadeLines).toBe(true);
    expect(mode.paint(cue(2, 10_000, false, true))).toBe(false);
    expect(scaleOf(rows[2])).toBe(1);
    expect(yOf(rows[2])).toBe(0);
    expect(scaleOf(rows[1])).toBeCloseTo(0.58, 4);
    // the focus colors went to the centered line
    expect(rows[2]?.children[0]?.style.getPropertyValue("color")).toBe(DEFAULT_SETTINGS.colors.lyric);
    expect(rows[1]?.children[0]?.style.getPropertyValue("color")).toBe(DEFAULT_SETTINGS.colors.dim);
  });

  it("glides again (no stage crossfade) once playing", () => {
    const { mode } = drift();
    mode.paint(cue(1, 5000, false));
    expect(mode.crossfadeLines).toBe(true);
    mode.paint(cue(1, 5016));
    expect(mode.crossfadeLines).toBe(false);
    clock += 16;
    expect(mode.paint(cue(2, 12_500))).toBe(true);
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
  it("lights a word, with its glow, at the very millisecond it starts", () => {
    const { mode, rows } = drift();
    const word = LINES[1]?.words[1];
    expect(word).toMatchObject({ text: "the ", start: 4800 });
    mode.paint(cue(1, 4800));
    const span = rows[1]?.children[1];
    expect(span?.style.getPropertyValue("color")).toBe(DEFAULT_SETTINGS.colors.highlight);
    expect(span?.style.getPropertyValue("text-shadow")).not.toBe("");
    expect(rows[1]?.children[2]?.style.getPropertyValue("color")).toBe(DEFAULT_SETTINGS.colors.lyric);
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
    const { mode, rows } = drift();
    mode.paint(cue(0, 2000));
    clock += 16;
    mode.paint(cue(1, 4300));
    clock += 100;
    mode.paint(cue(1, 4400));
    const red = { lyric: "#ffffff", highlight: "#ff0000", dim: "#333333" };
    mode.restyle(lookFor({ colors: red, glow: 80 }));
    clock += 16;
    expect(mode.paint(cue(1, 4416))).toBe(true);
    expect(rows[1]?.children[0]?.style.getPropertyValue("color")).toBe("#ff0000");
    expect(rows[0]?.children[0]?.style.getPropertyValue("color")).toBe("#333333");
  });
});

/** Reduced motion: every mode has the stage crossfade its line changes. */
function reduceMotion(): void {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

/** A stage on a fake host, mid-song, with the clock and opacities under the test's control. */
function stage(): { stage: LyricStage; root: FakeElement; scenes: () => FakeElement[] } {
  const host = new FakeElement("main");
  const s = new LyricStage(asHtml(host));
  s.setSettings(settings({ mode: "stack" }));
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
  it("asks for one more frame when a frame lands exactly on a word start, once", () => {
    const { stage: s } = stage();
    s.show(lyricsView, "a");
    expect(s.nextChange(4800)).toBe(0);
    expect(s.nextChange(4800)).toBe(200);
    expect(s.nextChange(4900)).toBe(100);
    expect(s.nextChange(5000)).toBe(0);
    expect(s.nextChange(5016)).toBe(584);
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
    s.setSettings(settings({ mode: "stack", glow: 90, opacity: 50, colors: { lyric: "#ffffff", highlight: "#ff0000", dim: "#333333" } }));
    expect(scenes()[0]?.find("drift")[0]).toBe(before);
    s.setSettings(settings({ mode: "stack", size: 80 }));
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
