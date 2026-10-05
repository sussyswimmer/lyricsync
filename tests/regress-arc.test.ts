import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../contract/contract";
import { parseLrc, type Line } from "../src/core/lrc";
import { dropShadow, resolveLook, rgba, type Frame, type Look } from "../src/overlay/look";
import {
  arcGeometry,
  arcLength,
  ArcMode,
  clearNeighbor,
  glideFrames,
  glideFrom,
  isRtl,
  leaveFrames,
  reach,
  type Placed,
  type Run,
  type Slot,
} from "../src/overlay/modes/arc";
import type { Cue } from "../src/overlay/modes/types";
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

// Regression (arc-height-clamp): resolveLook keeps a flat line on screen, but the curve lifted the
// middle (or the ends) half a bend further, so at Height 0–10% the active word was off the top at
// 1080p with the default curve, and near 100% a sag (or a long arched line) ran off the bottom.
describe("Arc geometry: the focus line stays on screen at any Height and Curve", () => {
  it.each(FRAMES)("%s", (_, frame) => {
    for (const size of [22, 58, 140])
      for (const curve of [-100, -60, -38, 0, 38, 60, 100])
        for (const yPos of [0, 5, 10, 25, 46, 75, 90, 95, 100])
          for (const r of [0, 0.3, 0.6, 0.94, 1]) {
            const l = look({ size, curve, yPos }, frame);
            const [top, bottom] = baselineSpan(l, r);
            const where = `size ${size} curve ${curve} yPos ${yPos} reach ${r}`;
            expect(top - ABOVE * l.size, where).toBeGreaterThanOrEqual(0);
            expect(bottom + BELOW * l.size, where).toBeLessThanOrEqual(l.height);
          }
  });

  it("puts the arched middle, active word included, on screen at Height 0 (the reported case)", () => {
    const l = look({ yPos: 0, curve: 38 });
    const g = arcGeometry(l, 0.6);
    expect(g.bend).toBeGreaterThan(150);
    expect(g.mid - ABOVE * l.size).toBeGreaterThanOrEqual(0);
  });

  it("leaves mid-screen placement exactly as before: the bend split evenly around the Height", () => {
    const l = look({ yPos: 46, curve: 38 });
    const g = arcGeometry(l, 1);
    expect(g.bend).toBeCloseTo(0.38 * 1080 * 0.42, 6);
    expect(g.mid).toBeCloseTo(l.y + 0.35 * l.size - g.bend / 2, 6);
  });

  it("matches a flat line's placement at curve 0, across the whole Height range", () => {
    for (const yPos of [0, 10, 46, 90, 100]) {
      const l = look({ yPos, curve: 0 });
      expect(arcGeometry(l, 1)).toMatchObject({ bend: 0, mid: l.y + 0.35 * l.size });
    }
  });

  it("still moves the line down as Height rises, and uses more of the range when the lines are short", () => {
    for (const curve of [-100, 38, 100]) {
      const mids = [0, 10, 25, 46, 75, 90, 100].map((yPos) => arcGeometry(look({ yPos, curve }), 0.6).mid);
      for (let i = 1; i < mids.length; i++) expect(mids[i]).toBeGreaterThanOrEqual(mids[i - 1] ?? Infinity);
      const full = arcGeometry(look({ yPos: 100, curve }), 1).mid;
      expect(arcGeometry(look({ yPos: 100, curve }), 0.5).mid).toBeGreaterThanOrEqual(full);
    }
  });

  it("flattens a curve too deep for a tiny stage instead of cutting it off, and never yields NaN", () => {
    const l = look({ size: 140, curve: 100, yPos: 0 }, { width: 400, height: 120, referenceHeight: 120 });
    const g = arcGeometry(l, 1);
    expect(Math.abs(g.bend)).toBeLessThanOrEqual(l.height);
    expect(Number.isFinite(g.mid)).toBe(true);
    const empty = arcGeometry(look({}, { width: 0, height: 0 }), 1);
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
// up into focus for the first ~130 ms.
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

  it("keeps the incoming next line transparent until the line gliding into focus has left its slot", () => {
    const frames = glideFrames({ dy: 29, scale: 1, appear: true });
    const hold = frames.find((f) => f.offset !== 0 && f.opacity === 0);
    expect(frames[0]).toMatchObject({ offset: 0, opacity: 0, transform: "translateY(29.00px) scale(1.0000)" });
    expect(hold?.offset).toBeGreaterThanOrEqual(0.35);
    expect(hold?.transform).toBeUndefined(); // the move itself runs the whole glide
    expect(frames[frames.length - 1]).toMatchObject({ offset: 1, opacity: 1, transform: "none" });
  });

  it("moves lines that stay on screen without touching their opacity", () => {
    for (const f of glideFrames({ dy: -90, scale: 2.08, appear: false })) expect(f.opacity).toBeUndefined();
  });

  it("has the outgoing previous line gone by halfway, before the old focus line shrinks into its slot", () => {
    const frames = leaveFrames(-120);
    const gone = frames.find((f) => f.opacity === 0);
    expect(gone?.offset).toBeLessThanOrEqual(0.5);
    expect(frames[frames.length - 1]).toMatchObject({ transform: "translateY(-120.00px)", opacity: 0 });
    expect(leaveFrames(0)).toEqual([{ opacity: 1 }, { opacity: 0 }]);
  });
});

// Regression (arc-cpu-filtered-transitions): CSS transitions on the words of the drop-shadow-filtered
// bands re-rastered the whole filtered line on every frame of every word change, making Arc (the
// default style) the most expensive mode to draw.
describe("arc.css", () => {
  // Read from disk: vitest hands CSS imports (even ?raw) to its CSS pipeline, which yields "" in node, so
  // an import made this test pass on an empty string. A non-literal specifier, because the strict type
  // check runs without node's types.
  let arcCss = "";
  beforeAll(async () => {
    const fsModule = "node:fs";
    const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: URL, encoding: "utf8"): string };
    arcCss = fs.readFileSync(new URL("../src/styles/arc.css", import.meta.url), "utf8");
  });

  it("has no transitions on the filtered bands", () => {
    expect(arcCss.trim()).not.toBe("");
    const css = arcCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toContain(".arc-line");
    expect(css).not.toMatch(/transition\s*:/);
  });
});

/*
 * Just enough DOM, HTML and SVG, for Arc to build, paint and restyle in node: elements with inline
 * styles and attributes, text half an em wide per character, Web Animations that only record
 * themselves, and counts of what a build costs (elements made, layout reads).
 */
const cost = { created: 0, measured: 0 };

class FakeStyle {
  readonly props = new Map<string, string>();
  [key: string]: unknown;
  setProperty(name: string, value: string): void {
    this.props.set(name, value);
  }
}

class FakeAnimation {
  cancelled = false;
  /** never settles: a band fading out stays in the tree */
  readonly finished = new Promise<void>(() => undefined);
  cancel(): void {
    this.cancelled = true;
  }
}

class FakeNode {
  readonly tagName: string;
  readonly style = new FakeStyle();
  readonly attrs = new Map<string, string>();
  readonly animations: FakeAnimation[] = [];
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  private own = "";
  private readonly classes = new Set<string>();
  readonly classList = {
    add: (...names: string[]): void => {
      for (const n of names) this.classes.add(n);
    },
    contains: (name: string): boolean => this.classes.has(name),
  };

  constructor(tag: string) {
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
    else this.attrs.set(name, value);
  }
  setAttributeNS(_ns: string, name: string, value: string): void {
    this.setAttribute(name, value);
  }
  animate(): FakeAnimation {
    const anim = new FakeAnimation();
    this.animations.push(anim);
    return anim;
  }
  /** the shared path, about 90% of a 1280 px stage */
  getTotalLength(): number {
    cost.measured++;
    return 1160;
  }
  getComputedTextLength(): number {
    cost.measured++;
    return this.textContent.length * Number(this.attrs.get("font-size") ?? "16") * 0.5;
  }
  find(className: string): FakeNode[] {
    return this.children.flatMap((c) => [...(c.classList.contains(className) ? [c] : []), ...c.find(className)]);
  }
  /** The subtree as data, band ids (fresh per build and instance) left out. */
  snapshot(): unknown {
    const plain = (v: string): string => v.replace(/ut-arc\d+-\d+/g, "ut-arc");
    const style = Object.entries(this.style).filter(([k]) => k !== "props");
    return {
      tag: this.tagName,
      className: this.className,
      attrs: [...this.attrs].map(([k, v]) => [k, plain(v)]).sort(),
      style: [...style, ...this.style.props].sort(),
      own: this.own,
      children: this.children.map((c) => c.snapshot()),
    };
  }
}

const asHost = (el: FakeNode): HTMLElement => el as unknown as HTMLElement;
const LINES: Line[] = parseLrc(paperLanterns, 24_000).filter((l) => l.words.length > 0);
const cue = (line: number, t: number, running = true): Cue => ({ line, t, waiting: false, running });
const stageLook = (over: Partial<Settings>, frame: Partial<Frame> = {}): Look => look(over, { width: 1280, height: 720, ...frame });
const RED = { lyric: "#ffffff", highlight: "#ff3030", dim: "#404040" };

function arcOn(l: Look): { mode: ArcMode; host: FakeNode; box: () => FakeNode | undefined } {
  const host = new FakeNode("main");
  const mode = new ArcMode();
  mode.build(asHost(host), LINES, l);
  return { mode, host, box: () => host.children[0] };
}

/** A band's font size: its <text> (after <defs>) carries it. */
const sizeOf = (band: FakeNode): number => Number(band.children[1]?.attrs.get("font-size") ?? "NaN");
/** The focus line's word fills: band > text > textPath > tspans. */
const focusFills = (box: FakeNode | undefined): (string | undefined)[] =>
  (box?.find("arc-focus")[0]?.children[1]?.children[0]?.children ?? []).map((t) => t.style.props.get("fill"));

// Regression (arc-restyle-rebuild): Arc had no restyle, so every Glow, color or Size step rebuilt it,
// and every build asked FontFaceSet.check about the whole song against the whole fallback stack at the
// current size (about 30 ms a step). Settings drags in Arc, the default style, ran at 21-26 fps.
describe("Arc restyle", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      createElement: (tag: string) => new FakeNode(tag),
      createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("takes new colors and glow in place: nothing built or measured, and a step's glide carries on", () => {
    const { mode, box } = arcOn(stageLook({ glow: 30 }));
    mode.paint(cue(0, 2000));
    mode.paint(cue(1, 4300));
    const bands = box()?.find("arc-line") ?? [];
    expect(bands.length).toBe(4);
    const gliding = bands.flatMap((b) => b.animations);
    expect(gliding.length).toBeGreaterThan(0);
    const before = { ...cost };
    const after = stageLook({ glow: 80, autoColor: false, colors: RED });
    mode.restyle(after);
    expect(cost).toEqual(before);
    expect(box()?.find("arc-line")).toEqual(bands);
    expect(gliding.every((a) => !a.cancelled)).toBe(true);
    for (const band of bands) {
      const filter = band.style.props.get("filter") ?? "";
      if (band.classList.contains("arc-glow")) {
        // just the highlight halo, in the new highlight at the new glow
        expect(filter).toContain(rgba(RED.highlight, 0.35 + 0.5 * 0.8));
        expect(filter).not.toContain("rgba(0, 0, 0,");
        expect(band.children[1]?.style.props.get("fill")).toBe(RED.highlight);
      } else {
        expect(filter).toBe(dropShadow(after, sizeOf(band)));
      }
      if (band.classList.contains("arc-prev") || band.classList.contains("arc-next")) expect(band.children[1]?.style.props.get("fill")).toBe(RED.dim);
    }
    // the next paint recolors the focus line's words: sung in the highlight, upcoming in the lyric color
    mode.paint(cue(1, 4320));
    const words = focusFills(box());
    expect(words.length).toBe(LINES[1]?.words.length);
    expect(words[0]).toBe(RED.highlight);
    expect(words[words.length - 1]).toBe(RED.lyric);
  });

  it("draws exactly what a fresh build with the same settings draws", () => {
    const restyled = arcOn(stageLook({ glow: 20 }));
    restyled.mode.paint(cue(1, 4300));
    restyled.mode.restyle(stageLook({ glow: 65, autoColor: false, colors: RED }));
    restyled.mode.paint(cue(1, 4300));
    const fresh = arcOn(stageLook({ glow: 65, autoColor: false, colors: RED }));
    fresh.mode.paint(cue(1, 4300));
    expect(restyled.host.snapshot()).toEqual(fresh.host.snapshot());
  });

  it("rebuilds when glow reaches or leaves 0 (the glow band exists only with a glow), and draws at once", () => {
    const { mode, box } = arcOn(stageLook({ glow: 30 }));
    mode.paint(cue(1, 4300));
    const first = box();
    expect(first?.find("arc-glow").length).toBe(1);
    mode.restyle(stageLook({ glow: 0 }));
    expect(box()).not.toBe(first);
    expect(box()?.find("arc-glow").length).toBe(0);
    expect(box()?.find("arc-line").length).toBe(3);
    const second = box();
    mode.restyle(stageLook({ glow: 45 }));
    expect(box()).not.toBe(second);
    expect(box()?.find("arc-glow").length).toBe(1);
    // unsynced lyrics never draw a glow band: their glow changes stay in place
    const calm = arcOn(stageLook({ glow: 30 }, { unsynced: true }));
    calm.mode.paint(cue(1, 4300));
    const calmBox = calm.box();
    calm.mode.restyle(stageLook({ glow: 0 }, { unsynced: true }));
    expect(calm.box()).toBe(calmBox);
  });

  it("rebuilds rather than restyles a look that moves the layout", () => {
    const { mode, box } = arcOn(stageLook({ glow: 30 }));
    mode.paint(cue(1, 4300));
    const first = box();
    mode.restyle(stageLook({ glow: 30, size: 70 }));
    expect(box()).not.toBe(first);
    expect(box()?.find("arc-line").length).toBe(4);
  });

  it("asks about the lyric face once per face and lyrics, for the bundled family at one size (a Size drag rebuilds every step)", () => {
    const check = vi.fn((_spec: string, _text?: string) => true);
    vi.stubGlobal("document", {
      createElement: (tag: string) => new FakeNode(tag),
      createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
      fonts: { check, load: vi.fn(async () => []) },
    });
    for (let size = 40; size < 60; size++) arcOn(stageLook({ size, font: { family: "Syne", weight: 800 } }));
    expect(check).toHaveBeenCalledTimes(1);
    const [spec, chars] = check.mock.calls[0] ?? [];
    expect(spec).toBe('800 16px "Syne"');
    expect(chars?.length).toBe(new Set(LINES.map((l) => l.text).join("")).size);
  });
});
