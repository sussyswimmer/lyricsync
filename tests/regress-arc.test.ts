import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../contract/contract";
import { parseLrc, type Line } from "../src/core/lrc";
import { dropShadow, resolveLook, snap, withBloom, type Frame, type Look } from "../src/overlay/look";
import {
  arcGeometry,
  arcLength,
  ArcMode,
  clearNeighbor,
  glideAt,
  glideFrom,
  isRtl,
  leaveAt,
  reach,
  type Placed,
  type Run,
  type Slot,
} from "../src/overlay/modes/arc";
import type { Cue } from "../src/overlay/modes/types";
import { findInterludes, type Interlude } from "../src/overlay/motion/interlude";
import { leadTimes } from "../src/overlay/motion/schedule";
import { FakeAnimation, FakeAnimationHost } from "./fake-motion";
import paperLanterns from "./fixtures/paper-lanterns.lrc?raw";

const look = (over: Partial<Settings>, frame: Partial<Frame> = {}): Look =>
  resolveLook({ ...structuredClone(DEFAULT_SETTINGS), mode: "arc", ...over }, null, {
    width: 1920,
    height: 1080,
    dpr: 1,
    motion: true,
    unsynced: false,
    ...frame,
  });

/** Glyph extents used to judge "on screen": accented capitals above the baseline, descenders (and a little rotation) below. */
const ABOVE = 0.8;
const BELOW = 0.3;

/** The focus line's baseline from its middle out to `r` of the half-width: the highest and lowest points. */
function baselineSpan(l: Look, r: number): [number, number] {
  const g = arcGeometry(l, r);
  const ends = g.mid + g.bend * r * r;
  return [Math.min(g.mid, ends), Math.max(g.mid, ends)];
}

const FRAMES: [string, Partial<Frame>][] = [
  ["1920x1080", { width: 1920, height: 1080 }],
  ["1366x768", { width: 1366, height: 768 }],
  ["1280x720", { width: 1280, height: 720 }],
  ["2560x1080", { width: 2560, height: 1080 }],
  ["1024x768", { width: 1024, height: 768 }],
  ["1080x1920 portrait", { width: 1080, height: 1920 }],
  ["settings preview", { width: 340, height: 191, referenceHeight: 680 }],
];

// Regression (arc-height-clamp): the curve lifted the middle (or the ends) half a bend past where the
// line was placed, so with the line high on screen (Height 0–10%, before contract v6) the active word
// was off the top at 1080p with the default curve, and with it low a sag (or a long arched line) ran
// off the bottom. The song's widest line is always centered now, and a bend that would take its middle
// or its ends closer than EDGE font sizes to an edge gets flatter.
describe("Arc geometry: the focus line stays on screen at any Curve and Size", () => {
  it.each(FRAMES)("%s", (_, frame) => {
    for (const size of [22, 58, 140])
      for (const curve of [-100, -60, -38, 0, 38, 60, 100])
        for (const r of [0, 0.3, 0.6, 0.94, 1]) {
          const l = look({ size, curve }, frame);
          const [top, bottom] = baselineSpan(l, r);
          const where = `size ${size} curve ${curve} reach ${r}`;
          expect(top - ABOVE * l.size, where).toBeGreaterThanOrEqual(0);
          expect(bottom + BELOW * l.size, where).toBeLessThanOrEqual(l.height);
        }
  });

  it("centers the song's widest line on the middle of the stage: its middle as far above it as its ends below", () => {
    for (const curve of [-100, -38, 38, 100])
      for (const r of [0, 0.4, 0.75, 1]) {
        const l = look({ curve });
        const g = arcGeometry(l, r);
        expect(l.y).toBe(540);
        // the glyphs' middle, at the line's middle and where it ends
        const middle = g.mid - 0.35 * l.size;
        expect(middle + (middle + g.bend * r * r), `curve ${curve} reach ${r}`).toBeCloseTo(2 * l.y, 6);
      }
    const g = arcGeometry(look({ curve: 38 }));
    expect(g.bend).toBeCloseTo(0.38 * 1080 * 0.42, 6);
    expect(g.mid).toBeCloseTo(540 + 0.35 * 58 - g.bend / 2, 6);
    // a song of short lines sits its arch lower than one whose lines run the whole path
    expect(arcGeometry(look({ curve: 38 }), 0.5).mid).toBeGreaterThan(g.mid);
  });

  it("matches a flat line's placement at curve 0, whatever yPos says", () => {
    for (const yPos of [0, 10, 46, 90, 100]) {
      const l = look({ yPos, curve: 0 });
      expect(arcGeometry(l)).toMatchObject({ bend: 0, mid: 540 + 0.35 * l.size });
    }
  });

  it("flattens a curve too deep for a tiny stage instead of cutting it off, and never yields NaN", () => {
    const l = look({ size: 140, curve: 100 }, { width: 400, height: 120, referenceHeight: 120 });
    const g = arcGeometry(l);
    expect(Math.abs(g.bend)).toBeLessThanOrEqual(l.height);
    expect(Number.isFinite(g.mid)).toBe(true);
    const empty = arcGeometry(look({}, { width: 0, height: 0 }));
    expect([empty.bend, empty.mid, empty.minFit].every(Number.isFinite)).toBe(true);
  });
});

// Regression (arc-portrait-bend): the bend followed the stage height, so a 1080x1920 display got an
// arch 3x steeper relative to its width, and the fit floor (55% of a height-scaled size) still let an
// ordinary line overflow both edges at curve 0.
describe("Arc geometry: the same shape on any aspect ratio", () => {
  it("keeps 16:9 and wider landscape exactly as before", () => {
    for (const frame of [{ width: 1920, height: 1080 }, { width: 2560, height: 1080 }]) {
      const l = look({ curve: 38 }, frame);
      const g = arcGeometry(l);
      expect(g.bend).toBeCloseTo(0.38 * l.height * 0.42, 6);
      expect(g.minFit).toBe(0.55);
    }
  });

  it("bends a portrait display's path as much, relative to its width, as a landscape one", () => {
    const land = arcGeometry(look({ curve: 38 }, { width: 1920, height: 1080 }));
    const port = arcGeometry(look({ curve: 38 }, { width: 1080, height: 1920 }));
    expect(port.bend / 1080).toBeCloseTo(land.bend / 1920, 6);
  });

  it("lets a line on a portrait display shrink to the same share of the width as on landscape", () => {
    const smallest = (frame: Partial<Frame>): number => {
      const l = look({}, frame);
      return (arcGeometry(l).minFit * l.size) / l.width;
    };
    expect(smallest({ width: 1080, height: 1920 }) / smallest({ width: 1920, height: 1080 })).toBeCloseTo(1, 6);
    expect(smallest({ width: 768, height: 1366 }) / smallest({ width: 1366, height: 768 })).toBeCloseTo(1, 2);
  });
});

// Regression (arc-rtl-direction): every Arc band was laid out left to right, so a Hebrew or Arabic
// line's trailing "?" or "!" landed at the right, next to its first word.
describe("isRtl: a line's base direction, as dir=auto picks it", () => {
  it.each([
    ["שלום, עולם! מה נשמע?", true],
    ["أين أنت؟ تعال هنا!", true],
    ["שלום my friend مرحبا habibi", true],
    ["123, שלום", true],
    ["— ¿ﭏ?", true],
    ["Hello there, שלום!", false],
    ["Đêm nay trăng sáng quá", false],
    ["夜空に浮かぶ灯り", false],
    ["...!?", false],
    ["", false],
  ])("%s → %s", (text, rtl) => {
    expect(isRtl(text)).toBe(rtl);
  });
});

describe("arcLength and reach: where a centered text ends on a parabola path", () => {
  const half = 864;

  it("is the plain distance on a flat path", () => {
    expect(arcLength(300, half, 0)).toBe(300);
    expect(reach(600, half, 0)).toBeCloseTo(600 / 2 / half, 9);
  });

  it("matches the path's polyline length", () => {
    for (const bend of [50, 172, 454, -300]) {
      let poly = 0;
      const n = 4000;
      for (let i = 1; i <= n; i++) {
        const x0 = ((i - 1) / n) * half;
        const x1 = (i / n) * half;
        poly += Math.hypot(x1 - x0, bend * ((x1 / half) ** 2 - (x0 / half) ** 2));
      }
      expect(arcLength(half, half, bend) / poly).toBeCloseTo(1, 4);
    }
  });

  it("grows with the text, stops at the path's end, and reaches less far on a deeper curve", () => {
    expect(reach(0, half, 172)).toBe(0);
    expect(reach(1e6, half, 172)).toBe(1);
    expect(reach(800, half, 172)).toBeLessThan(reach(1000, half, 172));
    expect(reach(1000, half, 454)).toBeLessThan(reach(1000, half, 172));
    const r = reach(1000, half, 172);
    expect(arcLength(r * half, half, 172)).toBeCloseTo(500, 3);
  });
});

// Regression (arc-neighbor-wrap): neighbors are vertical copies of the focus curve, so a previous line
// longer than the focus line hung down beside its ends (above an arch), reading as part of its row.
describe("clearNeighbor: the outer neighbor's ends stay clear of the focus line", () => {
  const half = 576; // 1280 px wide
  const focusSize = 38.7;
  const sideSize = 18.6;

  /** Clearance at the ends, px: positive when the neighbor's ink is clear of the focus line's. */
  function clearance(bend: number, rise: number, focus: Run, side: Run): { gap: number; push: number; bend: number } {
    const out = clearNeighbor(bend, half, rise, focus, side);
    const near = reach(focus.length, half, bend);
    const far = reach(side.length, half, out.bend);
    const focusEnd = bend * near * near; // from the focus line's middle
    const sideEnd = rise * focus.size + Math.sign(rise) * out.push + out.bend * far * far;
    const gap =
      rise < 0
        ? focusEnd - 0.72 * focus.size - (sideEnd + 0.22 * side.size)
        : sideEnd - 0.72 * side.size - (focusEnd + 0.22 * focus.size);
    return { gap, ...out };
  }

  it("leaves a neighbor no longer than the focus line alone", () => {
    expect(clearNeighbor(115, half, -1.25, { size: focusSize, length: 700 }, { size: sideSize, length: 340 })).toEqual({ push: 0, bend: 115 });
  });

  it("moves a long neighbor out, or flattens it past MAX_PUSH, until its ends clear (arch and sag)", () => {
    for (const [bend, rise] of [
      [115, -1.25],
      [454, -1.25],
      [-115, 1.4],
      [-454, 1.4],
    ] as const)
      for (const focusLength of [120, 300, 600, 900])
        for (const sideLength of [300, 600, 900, 1100, 3000]) {
          const r = clearance(bend, rise, { size: focusSize, length: focusLength }, { size: sideSize, length: sideLength });
          const where = `bend ${bend} focus ${focusLength} side ${sideLength}`;
          expect(r.gap, where).toBeGreaterThanOrEqual(-0.5);
          expect(r.push, where).toBeGreaterThanOrEqual(0);
          expect(r.push, where).toBeLessThanOrEqual(focusSize + 1e-9);
          expect(Math.sign(r.bend), where).toBe(Math.sign(bend));
          expect(Math.abs(r.bend), where).toBeLessThanOrEqual(Math.abs(bend));
        }
  });

  it("keeps the shared curve when a push alone is enough (the default curve, an 80-character previous line)", () => {
    const out = clearNeighbor(115, half, -1.25, { size: focusSize, length: 300 }, { size: sideSize, length: 750 });
    expect(out.push).toBeGreaterThan(0);
    expect(out.bend).toBe(115);
  });
});

const slot = (k: number): Slot => ({ name: k < 0 ? "prev" : k > 0 ? "next" : "focus", k, rise: k < 0 ? -1.25 : k > 0 ? 1.4 : 0 });
const placed = (k: number, i: number, size: number, mid: number): Placed => ({ slot: slot(k), i, size, natural: 500, mid, bend: 172 });


// Regression (arc-glide-overlap): stepping lines, the incoming next line faded in from the first
// frame, only half a focus size below its slot, and drew through the descenders of the line gliding
// up into focus for the first ~130 ms. Glides run on a spring now: each band's shape is a function of
// how far along the spring is (past 1 while it overshoots).
describe("Arc step glide", () => {
  it("starts each line where it was drawn a moment ago, pushes included", () => {
    // the old next line had been pushed 20 px down (under a sag); the new previous line is pushed 20 px up
    const before = [placed(-1, 3, 27.8, 300), placed(0, 4, 58, 400), placed(1, 5, 27.8, 501)];
    const after = [placed(-1, 4, 27.8, 307), placed(0, 5, 58, 400), placed(1, 6, 27.8, 481)];
    const [prev, focus, next] = after.map((p) => glideFrom(p, before, 58));
    expect(prev).toEqual({ dy: 93, scale: 58 / 27.8, appear: false });
    expect(focus).toEqual({ dy: 101, scale: 27.8 / 58, appear: false });
    expect(next).toEqual({ dy: 29, scale: 1, appear: true });
  });

  it("keeps a line coming into view transparent until the line gliding out of its slot has left", () => {
    const from = { dy: 29, scale: 1, appear: true };
    expect(glideAt(from, 0)).toEqual({ dy: 29, scale: 1, opacity: 0 });
    expect(glideAt(from, 0.4).opacity).toBe(0);
    expect(glideAt(from, 0.7).opacity).toBeGreaterThan(0);
    expect(glideAt(from, 1)).toEqual({ dy: 0, scale: 1, opacity: 1 });
    // past its place while the spring overshoots, and fully there
    expect(glideAt(from, 1.05).dy).toBeCloseTo(-1.45, 9);
    expect(glideAt(from, 1.05).opacity).toBe(1);
  });

  it("moves lines that stay on screen without touching their opacity", () => {
    for (const x of [0, 0.3, 0.8, 1.05]) expect(glideAt({ dy: -90, scale: 2.08, appear: false }, x).opacity).toBe(1);
    expect(glideAt({ dy: -90, scale: 2.08, appear: false }, 0).scale).toBe(2.08);
  });

  it("has a line leaving view gone by halfway, before the old focus line shrinks into its slot", () => {
    expect(leaveAt(-120, 0).opacity).toBe(1);
    expect(leaveAt(-120, 0.5).opacity).toBe(0);
    expect(leaveAt(-120, 1)).toEqual({ dy: -120, opacity: 0 });
  });
});

// Regression (arc-cpu-filtered-transitions): CSS transitions on the words of the drop-shadow-filtered
// bands re-rastered the whole filtered line on every frame of every word change, making Arc (the
// default style) the most expensive mode to draw.
describe("arc.css", () => {
  // Read from disk: vitest hands CSS imports (even ?raw) to its CSS pipeline, which yields "" in node, so
  // an import made this test pass on an empty string. A non-literal specifier, because the strict type
  // check runs without node's types.
  let css = "";
  beforeAll(async () => {
    const fsModule = "node:fs";
    const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: URL, encoding: "utf8"): string };
    css = fs.readFileSync(new URL("../src/styles/arc.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  });

  it("has no transitions on the filtered bands: only the whole stage of lines fades (on the compositor)", () => {
    expect(css.trim()).not.toBe("");
    expect(css).toContain(".arc-line");
    const transitions = [...css.matchAll(/([^{}]+)\{[^{}]*transition\s*:\s*([^;}]+)/gu)].map((m) => [m[1]?.trim(), m[2]?.trim()]);
    expect(transitions).toEqual([
      [".arc", "opacity 0.4s ease"],
      [".arc", "none"],
    ]);
  });

  it("sets the focus line's word boxes at the line-height arc.ts places letters by", () => {
    expect(css).toMatch(/\.arc-focus\s*\{[^}]*line-height:\s*1\.2;/u);
    expect(css).toMatch(/\.arc-word\s*\{[^}]*transform-origin:\s*0 0;/u);
  });
});

/*
 * Just enough DOM, HTML and SVG, for Arc to build, paint, glide and restyle in node: elements with
 * inline styles and attributes, Web Animations that keep time on the mocked performance.now
 * (tests/fake-motion.ts), and a count of the elements made. No layout (Arc falls back on its baseline
 * estimate) and no canvas (text measures half an em per character).
 */
const cost = { created: 0 };
let clock = 0;

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

class FakeNode extends FakeAnimationHost {
  readonly tagName: string;
  readonly style = new FakeStyle();
  readonly attrs = new Map<string, string>();
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  dir = "";
  private own = "";
  private readonly classes = new Set<string>();
  readonly classList = {
    add: (...names: string[]): void => {
      for (const n of names) this.classes.add(n);
    },
    remove: (...names: string[]): void => {
      for (const n of names) this.classes.delete(n);
    },
    toggle: (name: string, force?: boolean): boolean => {
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name);
      else this.classes.delete(name);
      return on;
    },
    contains: (name: string): boolean => this.classes.has(name),
  };

  constructor(tag: string) {
    super();
    this.tagName = tag;
    cost.created++;
  }

  get className(): string {
    return [...this.classes].join(" ");
  }
  set className(value: string) {
    this.classes.clear();
    for (const c of value.split(" ")) if (c) this.classes.add(c);
  }
  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.own = value;
  }
  get isConnected(): boolean {
    return this.parent !== null;
  }
  get parentNode(): FakeNode | null {
    return this.parent;
  }
  append(...nodes: FakeNode[]): void {
    for (const n of nodes) {
      n.remove();
      n.parent = this;
      this.children.push(n);
    }
  }
  remove(): void {
    const p = this.parent;
    if (!p) return;
    p.children.splice(p.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(name: string, value: string): void {
    if (name === "class") this.className = value;
    else this.attrs.set(name, String(value));
  }
  setAttributeNS(_ns: string, name: string, value: string): void {
    this.setAttribute(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  find(className: string): FakeNode[] {
    return this.children.flatMap((c) => [...(c.classList.contains(className) ? [c] : []), ...c.find(className)]);
  }
  /** This node and every node under it. */
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}

const fakeDocument = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  createElement: (tag: string) => new FakeNode(tag),
  createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
  ...extra,
});

/** Modes a test made: destroyed after it, while its fake document is still in place. */
const live: ArcMode[] = [];

beforeEach(() => {
  clock = 10_000;
  cost.created = 0;
  vi.stubGlobal("document", fakeDocument());
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(() => {
  for (const mode of live.splice(0)) mode.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const asHost = (el: FakeNode): HTMLElement => el as unknown as HTMLElement;
const LINES: Line[] = parseLrc(paperLanterns, 24_000).filter((l) => l.words.length > 0);
const LEADS = leadTimes(LINES);
const BREAK = findInterludes(LINES)[0] as Interlude;
const cue = (line: number, t: number, running = true, waiting = false): Cue => ({ line, t, waiting, running, rate: running ? 1 : 0, target: t });
const stageLook = (over: Partial<Settings> = {}, frame: Partial<Frame> = {}): Look => look({ curve: 38, ...over }, { width: 1280, height: 720, ...frame });
const RED = { lyric: "#ffffff", highlight: "#ff3030", dim: "#404040" };

function arcOn(l: Look, lines: readonly Line[] = LINES): { mode: ArcMode; box: () => FakeNode } {
  const host = new FakeNode("main");
  const mode = new ArcMode();
  live.push(mode);
  mode.build(asHost(host), lines, l);
  return { mode, box: () => host.children[0] as FakeNode };
}

/** Every SVG band: neighbors, and an unsynced focus line. */
const bandsOf = (box: FakeNode): FakeNode[] => box.find("arc-line");
const band = (box: FakeNode, name: "prev" | "next" | "calm"): FakeNode | undefined => box.find(`arc-${name}`)[0];
/** A band's <text> (after its <defs>), which carries its size and fill. */
const textOf = (b: FakeNode | undefined): FakeNode | undefined => b?.children[1];
const sizeOf = (b: FakeNode | undefined): number => Number(textOf(b)?.attrs.get("font-size") ?? "NaN");
/** The HTML focus lines: on screen, leaving, or prepared. */
const groupsOf = (box: FakeNode): FakeNode[] => box.find("arc-focus");
const wordsOf = (g: FakeNode | undefined): FakeNode[] => g?.find("arc-word") ?? [];
const anims = (el: FakeNode | undefined): FakeAnimation[] => el?.getAnimations() ?? [];
const scaleOf = (transform: unknown): number => Number(/scale\((-?[\d.]+)\)/u.exec(String(transform))?.[1] ?? "1");
const angleOf = (transform: unknown): number => Number(/rotate\((-?[\d.]+)deg\)/u.exec(String(transform))?.[1] ?? "NaN");
const xOf = (transform: unknown): number => Number(/^translate\((-?[\d.]+)px/u.exec(String(transform))?.[1] ?? "NaN");
/** A focus line's words as read: each plain text (the hidden whole-word run, once letters are placed). */
const textOfGroup = (g: FakeNode | undefined): string => (g?.find("kw-txt") ?? []).map((t) => (t.find("kw-hold")[0] ?? t).textContent).join(" ");
const wordsText = (i: number): string => (LINES[i]?.words ?? []).map((w) => w.text.trimEnd()).join(" ");

/** Steps from line 0 to line 1 at line 1's lead: the stage still says line 0. */
function stepToLine1(mode: ArcMode): number {
  mode.paint(cue(0, 2000));
  const lead = LEADS[1] as number;
  clock += lead + 1 - 2000;
  mode.paint(cue(0, lead + 1));
  return lead + 1;
}

describe("Arc focus line: HTML words on the curve, SVG neighbors", () => {
  it("draws the focus line as karaoke word boxes in frames turned to the curve, with no glow band", () => {
    const l = stageLook();
    const { mode, box } = arcOn(l);
    expect(mode.paint(cue(1, 5000))).toBe(false);
    const groups = groupsOf(box());
    expect(groups.length).toBe(1);
    const g = groups[0] as FakeNode;
    expect(g.tagName).toBe("div");
    expect(g.classList.contains("kw-host")).toBe(true);
    expect(g.classList.contains("has-fx")).toBe(true);
    expect(g.style.props.get("--ut-hl")).toBe(l.colors.highlight);
    expect(textOfGroup(g)).toBe(wordsText(1));
    const words = wordsOf(g);
    for (const w of words) {
      expect(w.children[0]?.classList.contains("kw")).toBe(true);
      expect(w.style.props.get("transform")).toMatch(/^translate\(-?[\d.]+px, -?[\d.]+px\) rotate\(-?[\d.]+deg\) translate\(-?[\d.]+px, -?[\d.]+px\)$/u);
    }
    // an arch: the words on the left tilt up, those on the right down, turning more toward the ends
    const angles = words.map((w) => angleOf(w.style.props.get("transform")));
    expect(angles[0]).toBeLessThan(0);
    expect(angles[angles.length - 1]).toBeGreaterThan(0);
    for (let k = 1; k < angles.length; k++) expect(angles[k]).toBeGreaterThan(angles[k - 1] ?? Infinity);
    expect(box().find("arc-glow").length).toBe(0);
    expect(bandsOf(box()).some((b) => b.classList.contains("arc-focus"))).toBe(false);
  });

  it("keeps the previous and next lines as dim, drop-shadowed SVG text on parallel paths", () => {
    const l = stageLook();
    const { mode, box } = arcOn(l);
    mode.paint(cue(1, 5000));
    const bands = bandsOf(box());
    expect(bands.map((b) => [b.tagName, b.textContent])).toEqual([
      ["svg", LINES[0]?.text],
      ["svg", LINES[2]?.text],
    ]);
    expect(band(box(), "prev")?.textContent).toBe(LINES[0]?.text);
    for (const b of bands) {
      expect(b.style.props.get("filter")).toBe(dropShadow(l, sizeOf(b)));
      expect(textOf(b)?.style.props.get("fill")).toBe(l.colors.dim);
      expect(textOf(b)?.children[0]?.tagName).toBe("textPath");
      expect(sizeOf(b)).toBeLessThan(l.size);
      expect(b.attrs.get("aria-hidden")).toBe("true");
    }
  });

  it("places every copy of each letter on the curve: the lit, base, dark and bloom copies and the plain text", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { mode, box } = arcOn(stageLook({ curve: 60 }));
    mode.paint(cue(1, 5000));
    vi.advanceTimersByTime(16 * 20);
    const counting = groupsOf(box())[0]?.find("kw")[0] as FakeNode;
    const copies = ["kw-dark", "kw-glow", "kw-bwin", "kw-win", "kw-txt"].map((c) => counting.find(c)[0]?.find("kl") ?? []);
    const placeOf = (letters: FakeNode[]): string[] => letters.map((k) => `${k.style.props.get("translate")} / ${k.style.props.get("rotate")}`);
    const first = placeOf(copies[0] ?? []);
    expect(first.length).toBe("Counting".length);
    for (const letters of copies) expect(placeOf(letters)).toEqual(first);
    // each letter turns a little further than the one before it, along the arch
    const turns = (copies[0] ?? []).map((k) => Number.parseFloat(k.style.props.get("rotate") ?? "NaN"));
    for (let k = 1; k < turns.length; k++) expect(turns[k]).toBeGreaterThan(turns[k - 1] ?? Infinity);
  });

  it("lays a right-to-left line out from the right, its words whole", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const rtl = parseLrc("[00:01.00]שלום עולם יפה\n[00:05.00]a second line", 20_000);
    const { mode, box } = arcOn(stageLook(), rtl);
    mode.paint(cue(0, 1500));
    vi.advanceTimersByTime(16 * 10);
    const g = groupsOf(box())[0];
    const xs = wordsOf(g).map((w) => xOf(w.style.props.get("transform")));
    expect(xs[0]).toBeGreaterThan(xs[1] ?? Infinity);
    expect(xs[1]).toBeGreaterThan(xs[2] ?? Infinity);
    for (const kw of g?.find("kw") ?? []) {
      const letters = kw.find("kw-dark")[0]?.find("kl") ?? [];
      expect(letters.length).toBe(1);
      expect(letters[0]?.style.props.has("rotate")).toBe(false);
    }
  });
});

describe("Arc line change: a spring from the lead", () => {
  it("moves to the next line at its lead, its words gliding up from where the next band drew them", () => {
    const l = stageLook();
    const { mode, box } = arcOn(l);
    mode.paint(cue(0, 2000));
    const old = groupsOf(box())[0] as FakeNode;
    const nextSize = sizeOf(band(box(), "next"));
    const lead = LEADS[1] as number;
    expect(lead).toBeLessThan(LINES[1]?.start ?? 0);
    expect(mode.nextChange(2000)).toBeCloseTo(lead - 2000, 6);
    clock += lead + 1 - 2000;
    expect(mode.paint(cue(0, lead + 1))).toBe(false);
    const groups = groupsOf(box());
    expect(groups.length).toBe(2);
    const g = groups.find((x) => x !== old) as FakeNode;
    expect(textOfGroup(g)).toBe(wordsText(1));
    for (const w of wordsOf(g)) {
      const [glide] = anims(w);
      expect(glide?.startTime).toBe(clock);
      const frames = glide?.keyframes ?? [];
      expect(frames.length).toBeGreaterThan(3);
      expect(scaleOf(frames[0]?.transform)).toBeCloseTo(nextSize / l.size, 3);
      expect(scaleOf(frames[frames.length - 1]?.transform)).toBe(1);
      // a spring: it overshoots, then settles
      expect(Math.max(...frames.map((k) => scaleOf(k.transform)))).toBeGreaterThan(1.005);
      expect(Number(glide?.duration)).toBeGreaterThan(600);
    }
    // the line arrives dim, brightening to full
    const arrive = anims(g).find((a) => a.keyframes[0]?.opacity !== undefined);
    expect(arrive?.keyframes[0]?.opacity).toBe("0.6");
    expect(arrive?.keyframes[arrive.keyframes.length - 1]?.opacity).toBe("1");
    expect(g.style.props.get("opacity")).toBe("1");
  });

  it("glides the old focus line onto the previous band, then hands back to it", () => {
    const l = stageLook();
    const { mode, box } = arcOn(l);
    mode.paint(cue(0, 2000));
    const old = groupsOf(box())[0] as FakeNode;
    stepToLine1(mode);
    expect(old.isConnected).toBe(true);
    expect(old.classList.contains("has-fx")).toBe(true);
    const prev = band(box(), "prev");
    expect(prev?.textContent).toBe(LINES[0]?.text);
    // its words end where the band draws them: at the band's size
    for (const w of wordsOf(old)) {
      const frames = anims(w)[0]?.keyframes ?? [];
      expect(scaleOf(frames[0]?.transform)).toBe(1);
      expect(scaleOf(frames[frames.length - 1]?.transform)).toBeCloseTo(sizeOf(prev) / l.size, 3);
    }
    // it dims as it goes and fades out once there, while the band shows under it
    const fade = anims(old).find((a) => a.keyframes[0]?.opacity !== undefined);
    const ops = (fade?.keyframes ?? []).map((k) => Number(k.opacity));
    expect(ops[0]).toBe(1);
    expect(ops[ops.length - 1]).toBe(0);
    expect(old.style.props.get("opacity")).toBe("0");
    const show = anims(prev)[0]?.keyframes ?? [];
    expect(show[0]?.opacity).toBe("0");
    expect(show[show.length - 1]?.opacity).toBe("1");
    // the band is in place before the line has faded out: the two never thin out together
    const at = (frames: Keyframe[], o: number): number => Number(frames.find((k) => Number(k.offset) >= o)?.opacity);
    const bandIn = Number(show.find((k) => Number(k.opacity) >= 1)?.offset);
    expect(at(fade?.keyframes ?? [], bandIn)).toBeGreaterThan(0);
    // the new next line rises in, transparent at first
    const next = band(box(), "next");
    expect(next?.textContent).toBe(LINES[2]?.text);
    expect(anims(next)[0]?.keyframes[0]?.opacity).toBe("0");
  });

  it("takes the leaving line down once its glide is over, in a paint it wakes for, and lets go of the glides", () => {
    const { mode, box } = arcOn(stageLook());
    mode.paint(cue(0, 2000));
    const old = groupsOf(box())[0] as FakeNode;
    const t = stepToLine1(mode);
    const wake = mode.nextChange(t);
    expect(wake).toBeGreaterThan(500);
    expect(wake).toBeLessThan(1500);
    clock += wake;
    mode.paint(cue(1, t + wake));
    expect(old.isConnected).toBe(false);
    const groups = groupsOf(box());
    expect(groups.length).toBe(1);
    for (const w of wordsOf(groups[0])) expect(anims(w)).toEqual([]);
    for (const b of bandsOf(box())) expect(anims(b)).toEqual([]);
  });

  it("takes a line back that comes into focus again while it is still on its way out", () => {
    const { mode, box } = arcOn(stageLook());
    const t = stepToLine1(mode);
    expect(groupsOf(box()).length).toBe(2);
    // a seek back one line while playing: a glide back
    clock += 50;
    mode.paint(cue(0, 2500));
    const focus = groupsOf(box()).filter((g) => textOfGroup(g) === wordsText(0));
    expect(focus.length).toBe(1);
    expect(focus[0]?.style.props.get("opacity")).toBe("1");
    expect(anims(wordsOf(focus[0])[0]).length).toBe(1);
    void t;
  });
});

describe("Arc instrumental breaks", () => {
  it("shows the dots at the apex of the focus curve, between the line just sung and the next one", () => {
    const l = stageLook();
    const { mode, box } = arcOn(l);
    const t = (BREAK.start + BREAK.end) / 2;
    mode.paint(cue(BREAK.next, t, true, true));
    expect(groupsOf(box()).length).toBe(0);
    const host = box().find("arc-dots")[0] as FakeNode;
    expect(host.find("ut-dot").length).toBe(3);
    expect(anims(host.find("ut-dots")[0]).length).toBeGreaterThan(0);
    const prev = band(box(), "prev");
    const next = band(box(), "next");
    expect(prev?.textContent).toBe(LINES[BREAK.next - 1]?.text);
    expect(next?.textContent).toBe(LINES[BREAK.next]?.text);
    // the apex: the focus curve's middle, NEXT_DROP (1.4) sizes above the next band's middle
    const nextMid = Number.parseFloat(String(next?.style["top"])) + Number(String(next?.style["transformOrigin"]).split(" ")[1]?.replace("px", ""));
    const apex = nextMid - 1.4 * l.size;
    expect(Number.parseFloat(String(host.style["top"]))).toBeCloseTo(apex - 0.32 * l.size, 0);
    expect(mode.nextChange(t)).toBeCloseTo(BREAK.end - t, 6);
  });

  it("hands over to the next line at its lead: the dots go, the line glides into focus, the line just sung stays put", () => {
    const { mode, box } = arcOn(stageLook());
    const t = (BREAK.start + BREAK.end) / 2;
    mode.paint(cue(BREAK.next, t, true, true));
    const host = box().find("arc-dots")[0] as FakeNode;
    const prev = band(box(), "prev");
    clock += BREAK.end + 1 - t;
    mode.paint(cue(BREAK.next, BREAK.end + 1, true, true));
    expect(host.isConnected).toBe(false);
    const g = groupsOf(box())[0];
    expect(textOfGroup(g)).toBe(wordsText(BREAK.next));
    expect(anims(wordsOf(g)[0]).length).toBe(1);
    expect(band(box(), "prev")).toBe(prev);
    expect(anims(prev)).toEqual([]);
  });
});

describe("Arc restyle", () => {
  it("takes new colors and glow in place: nothing built, and a line change's glides carry on", () => {
    const { mode, box } = arcOn(stageLook({ glow: 30 }));
    stepToLine1(mode);
    const flying = box()
      .all()
      .flatMap((n) => n.getAnimations());
    expect(flying.length).toBeGreaterThan(0);
    const before = cost.created;
    const after = stageLook({ glow: 80, autoColor: false, colors: RED });
    mode.restyle(after);
    expect(cost.created).toBe(before);
    expect(flying.every((a) => !a.cancelled)).toBe(true);
    for (const b of bandsOf(box())) {
      expect(b.style.props.get("filter")).toBe(dropShadow(after, sizeOf(b)));
      expect(textOf(b)?.style.props.get("fill")).toBe(RED.dim);
    }
    for (const g of groupsOf(box())) {
      expect(g.style.props.get("--ut-hl")).toBe(RED.highlight);
      expect(g.style.props.get("--ut-lyric")).toBe(RED.lyric);
    }
  });

  it("plans the focus line again at the current time when the motion changes, keeping the line where it is", () => {
    const l = stageLook();
    const { mode, box } = arcOn(l);
    mode.paint(cue(1, 5000));
    const g = groupsOf(box())[0] as FakeNode;
    const kw = g.find("kw")[0];
    const old = anims(kw);
    expect(old.length).toBeGreaterThan(0);
    mode.restyle(withBloom({ ...l, energy: 0.9 }, l.bloom));
    expect(groupsOf(box())[0]).toBe(g);
    expect(old.every((a) => a.cancelled)).toBe(true);
    expect(anims(kw).length).toBeGreaterThan(0);
  });
});

describe("Arc unsynced lyrics", () => {
  it("draws plain lyrics calmly: the focus line an SVG band in the lyric color, no karaoke", () => {
    const l = stageLook({}, { unsynced: true });
    const { mode, box } = arcOn(l);
    mode.paint(cue(1, 5000));
    expect(groupsOf(box()).length).toBe(0);
    expect(box().find("kw").length).toBe(0);
    const calm = band(box(), "calm");
    expect(calm?.textContent).toBe(LINES[1]?.text);
    expect(textOf(calm)?.style.props.get("fill")).toBe(l.colors.lyric);
    expect(calm?.attrs.has("aria-hidden")).toBe(false);
    expect(box().find("arc-dots").length).toBe(0);
  });

  it("glides plain lyrics on the calm spring", () => {
    const { mode, box } = arcOn(stageLook({}, { unsynced: true }));
    stepToLine1(mode);
    const calm = band(box(), "calm");
    expect(calm?.textContent).toBe(LINES[1]?.text);
    const [glide] = anims(calm);
    expect(Number(glide?.duration)).toBeGreaterThan(2000);
    expect(scaleOf(glide?.keyframes[0]?.transform)).toBeLessThan(1);
  });
});

describe("Arc under reduced motion and in the lite tier", () => {
  it("lets the stage crossfade every line change: no lead, nothing glides, words only fade in", () => {
    const l = stageLook({}, { motion: false });
    const { mode, box } = arcOn(l);
    mode.paint(cue(0, 2000));
    expect(mode.nextChange(2000)).toBeGreaterThan((LEADS[1] as number) - 2000);
    expect(mode.crossfades(cue(1, 4200))).toBe(true);
    clock += 2205;
    mode.paint(cue(1, 4205));
    const groups = groupsOf(box());
    expect(groups.length).toBe(1);
    expect(textOfGroup(groups[0])).toBe(wordsText(1));
    for (const w of wordsOf(groups[0])) expect(anims(w)).toEqual([]);
    for (const b of bandsOf(box())) expect(anims(b)).toEqual([]);
    const kw = groups[0]?.find("kw")[0];
    expect(anims(kw)).toEqual([]);
    expect(anims(kw?.find("kw-win")[0]).some((a) => a.keyframes.some((k) => k.opacity !== undefined))).toBe(true);
    expect(kw?.find("kw-dark")[0]?.find("kl")[0]?.style.props.has("rotate")).toBe(true);
  });

  it("keeps the glides in the lite tier, with the reduced-motion karaoke", () => {
    const { mode, box } = arcOn(stageLook({}, { power: "lite" }));
    stepToLine1(mode);
    const g = groupsOf(box()).find((x) => textOfGroup(x) === wordsText(1));
    for (const w of wordsOf(g)) expect(anims(w).length).toBe(1);
    expect(anims(g?.find("kw")[0])).toEqual([]);
  });
});

describe("Arc transport", () => {
  it("glides to a neighboring view while playing, and leaves anything else to the stage's crossfade", () => {
    const { mode } = arcOn(stageLook());
    mode.paint(cue(1, 5000));
    expect(mode.crossfades(cue(0, 2000))).toBe(false);
    expect(mode.crossfades(cue(BREAK.next, BREAK.end + 400))).toBe(true);
    expect(mode.crossfades(cue(0, 2000, false))).toBe(true);
    expect(mode.crossfades(cue(-1, 23_000))).toBe(false);
    expect(mode.cuts(cue(1, 5100))).toBe(false);
    expect(mode.cuts(cue(BREAK.next, BREAK.start + 100, true, true))).toBe(false);
    expect(mode.cuts(cue(BREAK.next, BREAK.start + 100, false, true))).toBe(true);
  });

  it("sleeps between its own events: the next break's start, the next lead", () => {
    const { mode } = arcOn(stageLook());
    mode.paint(cue(1, 5000));
    expect(mode.nextChange(5000)).toBeCloseTo(BREAK.start - 5000, 6);
    mode.paint(cue(2, 13_000));
    expect(mode.nextChange(13_000)).toBeCloseTo((LEADS[3] as number) - 13_000, 6);
  });

  it("holds every animation at its song time while paused", () => {
    const { mode, box } = arcOn(stageLook());
    mode.paint(cue(1, 5000));
    mode.paint(cue(1, 5000, false));
    const all = box()
      .all()
      .flatMap((n) => n.getAnimations());
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((a) => a.paused)).toBe(true);
  });

  it("re-lights the focus line after a seek back past where its motion began", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { mode, box } = arcOn(stageLook());
    mode.paint(cue(1, 4250));
    const kw = groupsOf(box())[0]?.find("kw")[0];
    const before = anims(kw);
    expect(before.length).toBeGreaterThan(0);
    mode.paint(cue(0, 3950));
    expect(before.every((a) => a.cancelled)).toBe(true);
    vi.advanceTimersByTime(16 * 10);
    expect(anims(kw).length).toBeGreaterThan(0);
  });

  it("freezes what is on screen for the stage's copy, and draws the view afresh after", () => {
    const { mode, box } = arcOn(stageLook());
    stepToLine1(mode);
    const flying = box()
      .all()
      .flatMap((n) => n.getAnimations());
    mode.freeze();
    expect(flying.every((a) => a.cancelled)).toBe(true);
    expect(flying.some((a) => a.commits > 0)).toBe(true);
    clock += 30;
    mode.paint(cue(1, (LEADS[1] as number) + 31));
    const groups = groupsOf(box());
    expect(groups.length).toBe(1);
    for (const w of wordsOf(groups[0])) expect(anims(w)).toEqual([]);
  });

  it("fades out after the last line, and comes back on a seek", () => {
    const { mode, box } = arcOn(stageLook());
    mode.paint(cue(3, 18_000));
    mode.paint(cue(-1, 23_000));
    expect(box().style.props.get("opacity")).toBe("0");
    mode.paint(cue(3, 18_000));
    expect(box().style.props.get("opacity")).toBe("1");
  });

  it("prepares the next line ahead, hidden, and brings it in at its lead", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { mode, box } = arcOn(stageLook());
    mode.paint(cue(0, 2000));
    vi.advanceTimersByTime(2000);
    const groups = groupsOf(box());
    expect(groups.length).toBe(2);
    const ready = groups.find((g) => textOfGroup(g) === wordsText(1)) as FakeNode;
    expect(ready.style.props.get("opacity")).toBe("0");
    expect(ready.classList.contains("has-fx")).toBe(false);
    expect(ready.find("kw-fx").length).toBe(LINES[1]?.words.length);
    stepToLine1(mode);
    expect(groupsOf(box()).includes(ready)).toBe(true);
    expect(ready.classList.contains("has-fx")).toBe(true);
  });
});

// Regression (arc-long-lines-off-screen): a long line shrank to 55% of its size at most, then ran
// past its path's ends and off both screen edges, so at Size 100 and up an ordinary 60-70 character
// line on a 16:9 display lost its first and last words.
describe("Arc long lines", () => {
  /** A 106-character line between two short ones. */
  const LONG = "this placeholder line keeps going well past the point where any style could hold it whole on one row again";
  const SONG: Line[] = parseLrc(`[00:01.00]a short line first\n[00:04.00]${LONG}\n[00:09.00]and a short line after`, 20_000);
  const pathOf = (l: Look): number => {
    const half = (snap(l.width * 0.95, l.dpr) - snap(l.width * 0.05, l.dpr)) / 2;
    return 2 * arcLength(half, half, arcGeometry(l).bend);
  };
  const focusSize = (box: FakeNode): number => Number.parseFloat(String(groupsOf(box)[0]?.style["fontSize"]));

  it.each([22, 58, 100, 140])("never draws a line longer than its path at Size %s", (size) => {
    const l = stageLook({ size });
    for (const [line, t] of [
      [1, 5000],
      [2, 9500],
    ] as const) {
      const { mode, box } = arcOn(l, SONG);
      mode.paint(cue(line, t));
      expect(focusSize(box()) * 0.5 * (SONG[line]?.text.length ?? 0)).toBeLessThanOrEqual(pathOf(l) + 0.5);
      for (const b of bandsOf(box())) expect(sizeOf(b) * 0.5 * b.textContent.length, `${b.className} at size ${size}`).toBeLessThanOrEqual(pathOf(l) + 0.5);
    }
  });

  it("leaves lines that fit at their size, and shrinks a slightly long one only to FIT of its path", () => {
    const l = stageLook({ size: 58 });
    const short = arcOn(l, SONG);
    short.mode.paint(cue(0, 2000));
    expect(focusSize(short.box())).toBeCloseTo(l.size, 2);
    const text = "placeholder words ".repeat(4).slice(0, 64);
    const near = arcOn(l, parseLrc(`[00:01.00]${text}`, 20_000));
    near.mode.paint(cue(0, 2000));
    expect(focusSize(near.box()) * 0.5 * text.length).toBeCloseTo(pathOf(l) * 0.94, 0);
  });
});

describe("Arc fonts", () => {
  it("asks about the lyric face once per face and lyrics, for the bundled family at one size (a Size drag rebuilds every step)", () => {
    const check = vi.fn((_spec: string, _text?: string) => true);
    vi.stubGlobal("document", fakeDocument({ fonts: { check, load: vi.fn(async () => []) } }));
    for (let size = 40; size < 60; size++) arcOn(stageLook({ size, font: { family: "Syne", weight: 800 } }));
    expect(check).toHaveBeenCalledTimes(1);
    const [spec, chars] = check.mock.calls[0] ?? [];
    expect(spec).toBe('800 16px "Syne"');
    expect(chars?.length).toBe(new Set(LINES.map((l) => l.text).join("")).size);
  });

  it("measures and places the lines again once the face loads, and draws the view afresh", async () => {
    let loaded: () => void = () => undefined;
    const load = vi.fn((_spec: string, _text?: string) => new Promise<unknown[]>((resolve) => (loaded = () => resolve([]))));
    vi.stubGlobal("document", fakeDocument({ fonts: { check: () => false, load } }));
    const { mode, box } = arcOn(stageLook({ font: { family: "Unbounded", weight: 700 } }));
    expect(load).toHaveBeenCalledWith('700 16px "Unbounded"', expect.any(String));
    mode.paint(cue(1, 5000));
    const first = groupsOf(box())[0] as FakeNode;
    loaded();
    await Promise.resolve();
    await Promise.resolve();
    const second = groupsOf(box())[0];
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expect(textOfGroup(second)).toBe(wordsText(1));
  });
});
