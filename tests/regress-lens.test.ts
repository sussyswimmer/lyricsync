import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../contract/contract";
import { parseLrc, type Line } from "../src/core/lrc";
import { FONTS, fontFor, whenFaceLoads } from "../src/overlay/fonts";
import { DEFAULT_PICK, resolveLook, shadowLayers, withBloom, type Frame, type Look } from "../src/overlay/look";
import { drawnShadow, fitRow, focusCenter, LensMode, nextSize, pull, rowWidth, zoomAt, type Shape } from "../src/overlay/modes/lens";
import type { Cue } from "../src/overlay/modes/types";
import { findInterludes } from "../src/overlay/motion/interlude";
import { leadTimes } from "../src/overlay/motion/schedule";
import { FakeAnimationHost } from "./fake-motion";
import paperLanterns from "./fixtures/paper-lanterns.lrc?raw";

const look = (over: Partial<Settings> = {}, frame: Partial<Frame> = {}): Look =>
  resolveLook({ ...structuredClone(DEFAULT_SETTINGS), mode: "lens", ...over }, null, {
    width: 1280,
    height: 720,
    dpr: 1,
    motion: true,
    unsynced: false,
    ...frame,
  });

/** The fisheye's settings (lens.ts): far words shrink to `low`, the word being sung grows to SCALE_MAX. */
const SCALE_MAX = 1.35;
const ROW_FIT = 0.92;

/** A row of `n` words, each `width` px wide at the base size, a space of `space` px between them. */
function row(n: number, width: number, space: number): Shape {
  return {
    widths: new Array<number>(n).fill(width),
    order: Array.from({ length: n }, (_, j) => j),
    gaps: Array.from({ length: n }, (_, v) => (v < n - 1 ? space : 0)),
  };
}

/** The row's drawn width with the lens eased in by `lens` and the singing position at `a`, at the zoom the mode draws it with. */
function drawnWidth(shape: Shape, low: number, lens: number, a: number, zoom: number): number {
  const scales = shape.widths.map((_, j) => 1 + lens * (low + (SCALE_MAX - low) * pull(j, a) - 1));
  return rowWidth(shape, scales) * zoom;
}

// Regression (lens-long-line-fit): the lens was fitted to the row's at-rest width (every word at
// scale 1). Under the lens far words are at half size, so a 16-word line used 57% of the stage and
// its far words shrank to 13 px (a 34-word line hit the 11 px floor), while a 10-word line got 19 px.
describe("Lens: fitting a long line", () => {
  // Fraunces at 38.7 px (1280×720): about 2.6 em per word, a quarter-em space
  const size = look().size;
  const word = size * 2.6;
  const space = size * 0.25;

  it("fits the lensed row on its own: a 16-word line keeps full size under the lens, like a 10-word line", () => {
    const short = fitRow(row(10, word, space), size, 1280, true);
    const long = fitRow(row(16, word, space), size, 1280, true);
    expect(long.fit).toBe(short.fit);
    expect(long.fit).toBe(1);
    expect(size * long.low * long.fit).toBeGreaterThan(19);
    // ...while at rest the same line needs a smaller size to fit
    expect(zoomAt(long, 0, 1280)).toBeLessThan(0.75);
  });

  it("fills the stage under the lens instead of a band in the middle", () => {
    for (const n of [24, 34, 50]) {
      const shape = row(n, word, space);
      const f = fitRow(shape, size, 1280, true);
      expect(f.fit, `${n} words`).toBeLessThan(1);
      const zoom = zoomAt(f, 1, 1280);
      const widest = Math.max(...Array.from({ length: n * 8 + 1 }, (_, i) => drawnWidth(shape, f.low, 1, i / 8, zoom)));
      expect(widest, `${n} words`).toBeGreaterThan(0.97 * ROW_FIT * 1280);
      expect(widest, `${n} words`).toBeLessThanOrEqual(ROW_FIT * 1280 + 1e-6);
    }
  });

  it("never runs wider than the stage allows while the lens eases in, wherever the singing position is", () => {
    for (const [n, w] of [
      [3, word],
      [8, word],
      [16, word],
      [34, word],
      [12, size * 4],
    ] as const) {
      const shape = row(n, w, space);
      const f = fitRow(shape, size, 1280, true);
      for (let l = 0; l <= 1.0001; l += 0.05) {
        const zoom = zoomAt(f, l, 1280);
        for (let a = 0; a <= n; a += 0.25) {
          expect(drawnWidth(shape, f.low, l, a, zoom), `n=${n} lens=${l.toFixed(2)} a=${a}`).toBeLessThanOrEqual(ROW_FIT * 1280 + 1e-6);
        }
      }
    }
  });

  it("keeps a short line's size steady as the lens eases in (only long lines grow into the lens)", () => {
    const f = fitRow(row(5, word, space), size, 1280, true);
    expect(zoomAt(f, 0, 1280)).toBe(1);
    expect(zoomAt(f, 1, 1280)).toBe(1);
    // three long words: the lensed row is the wider one and has to shrink, the same throughout
    const g = fitRow(row(3, size * 9.6, space), size, 1280, true);
    expect(g.widest).toBeGreaterThan(g.rest);
    expect(g.fit).toBeLessThan(1);
    expect(zoomAt(g, 0, 1280)).toBeCloseTo(zoomAt(g, 1, 1280), 9);
    expect(zoomAt(g, 0.5, 1280)).toBeCloseTo(zoomAt(g, 1, 1280), 9);
  });

  it("fits a line without a lens (unsynced, reduced motion) to its at-rest width, at one size", () => {
    const shape = row(16, word, space);
    const f = fitRow(shape, size, 1280, false);
    expect(f.widest).toBe(f.rest);
    expect(zoomAt(f, 0, 1280)).toBe(f.fit);
    expect(f.rest * f.fit).toBeCloseTo(ROW_FIT * 1280, 6);
  });

  it("keeps far words of very long lines readable in portrait", () => {
    const portrait = look({}, { width: 1080, height: 1920 });
    const f = fitRow(row(16, portrait.size * 2, portrait.size * 0.25), portrait.size, 1080, true);
    expect(portrait.size * f.low * zoomAt(f, 1, 1080)).toBeGreaterThan(16);
  });
});

/** A parsed text-shadow layer: offset y, blur, alpha. */
function layers(shadow: string): { y: number; blur: number; alpha: number }[] {
  return shadow.split(/,\s*(?![^()]*\))/).map((layer) => {
    const [, y = "0", blur = "0"] = layer.match(/-?[\d.]+px/g) ?? [];
    const alpha = Number(/,\s*([\d.]+)\)\s*$/.exec(layer)?.[1] ?? "1");
    return { y: Number.parseFloat(y), blur: Number.parseFloat(blur), alpha };
  });
}

// Regression (lens-far-word-legibility): far words faded by element opacity took their dark shadow
// down with them (alpha 0.46 → 0.28), and the shadow, built for the base size, shrank with the
// word's transform to about a pixel. On a light wallpaper "drift toward home" all but vanished.
describe("Lens: the shadow of a word drawn small and faded", () => {
  const l = look();

  it("lands on screen as the shadow of text its drawn size, floors included", () => {
    for (const scale of [1, 0.75, 0.5, 0.3]) {
      const drawn = layers(drawnShadow(l, scale, 1));
      const want = layers(shadowLayers(l, l.size * scale, false).map((x) => x.join(" ")).join(", "));
      expect(drawn).toHaveLength(want.length);
      drawn.forEach((layer, i) => {
        const target = want[i];
        expect(target).toBeDefined();
        if (!target) return;
        // the word's transform scales the shadow by `scale` on the way to the screen
        expect(layer.y * scale, `scale ${scale} layer ${i}`).toBeCloseTo(target.y, 1);
        expect(layer.blur * scale, `scale ${scale} layer ${i}`).toBeCloseTo(target.blur, 1);
      });
    }
    // a half-size word keeps at least a pixel of offset and a 1.5 px blur on screen
    const [first] = layers(drawnShadow(l, 0.25, 0.6));
    expect((first?.y ?? 0) * 0.25).toBeGreaterThanOrEqual(0.99);
    expect((first?.blur ?? 0) * 0.25).toBeGreaterThanOrEqual(1.49);
  });

  it("isn't faded with the word: its alpha times the word's opacity is the full alpha", () => {
    const full = layers(shadowLayers(l, l.size * 0.5, false).map((x) => x.join(" ")).join(", "));
    const faded = layers(drawnShadow(l, 0.5, 0.6));
    faded.forEach((layer, i) => {
      expect(layer.alpha * 0.6).toBeCloseTo(Math.min(0.6, full[i]?.alpha ?? 0), 2);
    });
  });

  it("keeps the active word's highlight halo in its highlight color", () => {
    const glow = drawnShadow(l, 1, 1, true);
    expect(glow).toContain("rgba(0, 0, 0,");
    expect(layers(glow)).toHaveLength(3);
  });
});

// Regression (lens-fontcheck-freeze): every build asked FontFaceSet.check about the whole song
// (every line joined, nothing deduplicated) against the whole fallback stack at the current size.
// Blink looks every family up for every character, so a settings slider step cost 300-400 ms.
describe("Lens: waiting for the lyric face", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFonts(loaded: boolean): { check: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn> } {
    const check = vi.fn((_spec: string, _text?: string) => loaded);
    const load = vi.fn(async (_spec: string, _text?: string) => []);
    vi.stubGlobal("document", { fonts: { check, load } });
    return { check, load };
  }

  it("asks about the bundled family alone, at one size, for each distinct character once", () => {
    const { check } = stubFonts(true);
    const fraunces = fontFor("Fraunces");
    const text = "Paper lanterns over the river Paper lanterns over the river";
    expect(whenFaceLoads(fraunces.family, 700, text)).toBeNull();
    expect(check).toHaveBeenCalledTimes(1);
    const [spec, chars] = check.mock.calls[0] ?? [];
    expect(spec).toBe('700 16px "Fraunces"');
    expect(chars).toBeDefined();
    expect([...(chars ?? "")].sort().join("")).toBe([...new Set(text)].sort().join(""));
  });

  it("never asks again for the same face and lyrics (a Size drag rebuilds with them on every step)", () => {
    const { check } = stubFonts(true);
    const syne = fontFor("Syne");
    const text = "Neon on the wet street, every sign a little sun";
    for (let i = 0; i < 10; i++) expect(whenFaceLoads(syne.family, 800, text)).toBeNull();
    expect(check).toHaveBeenCalledTimes(1);
    // another weight or other lyrics are asked about once each
    whenFaceLoads(syne.family, 700, text);
    whenFaceLoads(syne.family, 800, `${text}!`);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("loads the missing characters when the face isn't in yet, and asks again next time", async () => {
    const { check, load } = stubFonts(false);
    const caveat = fontFor("Caveat");
    const text = "Thương nhớ con đường cũ";
    const loading = whenFaceLoads(caveat.family, 600, text);
    expect(loading).not.toBeNull();
    await loading;
    expect(load).toHaveBeenCalledWith('600 16px "Caveat"', [...new Set(text)].join(""));
    whenFaceLoads(caveat.family, 600, text);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("has nothing to load for the system stack, or without a document", () => {
    const { check } = stubFonts(false);
    const system = FONTS.find((f) => f.family === "System");
    expect(system).toBeDefined();
    expect(whenFaceLoads(system?.family ?? "", 700, "anything")).toBeNull();
    expect(check).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    expect(whenFaceLoads(fontFor("Fraunces").family, 700, "anything")).toBeNull();
  });
});

/*
 * Just enough DOM for Lens and the karaoke engine to build and run in node: elements with inline
 * styles, text half an em wide per character (the baseline mark 0.8 em down), and the Web Animations
 * fakes from fake-motion.ts, which keep time on performance.now() (mocked: `clock`).
 */
class FakeStyle {
  readonly props = new Map<string, string>();
  /** every setProperty, in order: what a paint wrote */
  readonly writes: string[] = [];
  [key: string]: unknown;
  setProperty(name: string, value: string): void {
    this.props.set(name, value);
    this.writes.push(name);
  }
  getPropertyValue(name: string): string {
    return this.props.get(name) ?? "";
  }
}

class FakeElement extends FakeAnimationHost {
  readonly tagName: string;
  className = "";
  dir = "";
  readonly style = new FakeStyle();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  private own = "";
  readonly offsetWidth = 0;
  readonly classList = {
    add: (...names: string[]): void => {
      this.className = [...new Set([...this.className.split(" "), ...names])].filter(Boolean).join(" ");
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
    return this.own + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.own = value;
  }
  get parentNode(): FakeElement | null {
    return this.parent;
  }
  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  private fontSize(): number {
    for (let el: FakeElement | null = this; el; el = el.parent) {
      const v = el.style["fontSize"];
      if (typeof v === "string" && v) return Number.parseFloat(v);
    }
    return 16;
  }
  getBoundingClientRect(): { width: number; left: number; top: number } {
    const size = this.fontSize();
    return { width: this.textContent.length * size * 0.5, left: 0, top: this.tagName === "I" ? 0.8 * size : 0 };
  }
  append(...nodes: (FakeElement | string)[]): void {
    for (const n of nodes) {
      if (typeof n === "string") {
        this.own += n;
        continue;
      }
      n.remove();
      n.parent = this;
      this.children.push(n);
    }
  }
  appendChild(node: FakeElement): FakeElement {
    this.append(node);
    return node;
  }
  insertBefore(node: FakeElement, ref: FakeElement | null): FakeElement {
    if (!ref) return this.appendChild(node);
    node.remove();
    node.parent = this;
    this.children.splice(this.children.indexOf(ref), 0, node);
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
  contains(other: FakeElement): boolean {
    for (let el: FakeElement | null = other; el; el = el.parent) if (el === this) return true;
    return false;
  }
  setAttribute(): void {}
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
const live: LensMode[] = [];

function setup(): void {
  clock = 10_000;
  vi.stubGlobal("document", { createElement: (tag: string) => new FakeElement(tag) });
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

function teardown(): void {
  for (const mode of live.splice(0)) mode.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

const LINES: Line[] = parseLrc(paperLanterns, 24_000).filter((l) => l.words.length > 0);
const LEADS = leadTimes(LINES);
const BREAK = findInterludes(LINES)[0];
const cue = (line: number, t: number, running = true, waiting = false): Cue => ({ line, t, waiting, running });

/** A built Lens on a fake host, with the live focus row, the next line and the break slot to look at. */
function lens(l: Look = look()): {
  mode: LensMode;
  host: FakeElement;
  row: () => FakeElement | undefined;
  rows: () => FakeElement[];
  next: () => FakeElement | undefined;
  brk: () => FakeElement | undefined;
} {
  const host = new FakeElement("main");
  const mode = new LensMode();
  live.push(mode);
  mode.build(host as unknown as HTMLElement, LINES, l);
  const box = (): FakeElement | undefined => host.children[0];
  const shown = (c: FakeElement): boolean => !c.classList.contains("lens-leaving") && c.style.getPropertyValue("visibility") !== "hidden";
  return {
    mode,
    host,
    rows: () => (box()?.children ?? []).filter((c) => c.classList.contains("lens-row")),
    row: () => box()?.children.find((c) => c.classList.contains("lens-row") && shown(c)),
    next: () => box()?.children.find((c) => c.classList.contains("lens-next") && !c.classList.contains("lens-leaving")),
    brk: () => box()?.children.find((c) => c.classList.contains("lens-break") && !c.classList.contains("lens-leaving")),
  };
}

const slotsOf = (row: FakeElement | undefined): FakeElement[] => row?.find("lens-slot") ?? [];
/** An element and everything inside it. */
const everything = (el: FakeElement | undefined): FakeElement[] => (el ? [el, ...el.children.flatMap((c) => everything(c))] : []);
const wordsOf = (row: FakeElement | undefined): FakeElement[] => row?.find("kw") ?? [];
/** Runs the mount slices (a frame each, a timer here). */
const frames = (n = 12): void => {
  vi.advanceTimersByTime(16 * n);
};

/** A slot's lens as drawn at its animation's current time (or its own style without one): left x, scale, opacity. */
function lensOf(slot: FakeElement | undefined): { x: number; s: number; o: number } {
  const anim = slot?.getAnimations()[0];
  const values = anim ? anim.values() : { transform: slot?.style.getPropertyValue("transform") ?? "", opacity: slot?.style.getPropertyValue("opacity") ?? "1" };
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/u.exec(values["transform"] ?? "");
  return { x: Number(m?.[1]), s: Number(m?.[3]), o: Number(values["opacity"] ?? 1) };
}

const translateY = (transform: string | undefined): number => Number(/translate\(-?[\d.]+px, (-?[\d.]+)px\)/u.exec(transform ?? "")?.[1]);

describe("Lens on the motion engine: sleeping between line changes", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("never wakes for words: paint asks for no frames, nextChange names the leads and the break", () => {
    const { mode } = lens();
    expect(mode.wordWakes).toBe(false);
    let last = 500;
    for (const t of [500, 1200, 2400, 3000, 3700]) {
      clock += t - last;
      last = t;
      expect(mode.paint(cue(0, t))).toBe(false);
    }
    expect(mode.nextChange(3000)).toBe((LEADS[1] ?? 0) - 3000);
    expect(BREAK).toBeDefined();
    if (!BREAK) return;
    clock += 1300;
    mode.paint(cue(1, 5000));
    expect(mode.nextChange(5000)).toBe(BREAK.start - 5000);
    expect(mode.nextChange(BREAK.start + 10)).toBe(BREAK.end - BREAK.start - 10);
  });

  it("plays the lens as a planned track on every slot, in the karaoke's batch, on song time", () => {
    const { mode, row } = lens();
    mode.paint(cue(0, 2000));
    frames();
    const slots = slotsOf(row());
    expect(slots).toHaveLength(LINES[0]?.words.length ?? 0);
    const anims = slots.map((s) => s.getAnimations());
    for (const list of anims) expect(list).toHaveLength(1);
    const first = anims[0]?.[0];
    // the line's window starts at its first word (it came in mid-line): one window for every animation
    const span = first?.duration ?? 0;
    for (const list of anims) {
      const a = list[0];
      expect(a?.duration).toBe(span);
      expect(a?.currentTime).toBeCloseTo(2000 - (LINES[0]?.words[0]?.start ?? 0), 6);
      expect(Object.keys(a?.keyframes[0] ?? {})).toEqual(expect.arrayContaining(["transform", "opacity"]));
    }
    // the karaoke shares it: every word box pops in the same window
    for (const w of wordsOf(row())) for (const a of w.getAnimations()) expect(a.duration).toBe(span);
    // each word box sits in its slot, which carries the lens around it
    for (const s of slots) expect(s.children[0]?.classList.contains("kw")).toBe(true);
  });

  it("magnifies the word being sung, and its bloom with it", () => {
    const { mode, row } = lens();
    const words = LINES[0]?.words ?? [];
    mode.paint(cue(0, 1000));
    frames();
    let last = 1000 + 16 * 12;
    clock += 16 * 12;
    words.forEach((w, j) => {
      if (j === 0) return;
      const t = (w.start + w.end) / 2 + 80;
      clock += t - last;
      last = t;
      mode.paint(cue(0, t));
      const scales = slotsOf(row()).map((s) => lensOf(s).s);
      expect(scales.indexOf(Math.max(...scales)), `${w.text} at ${t}`).toBe(j);
    });
    // every word has its bloom copy inside its word box (in the slot), and it glows while sung
    for (const w of wordsOf(row())) {
      const glow = w.find("kw-glow")[0];
      expect(glow).toBeDefined();
      expect(glow?.getAnimations().length).toBe(1);
    }
    expect(row()?.classList.contains("has-fx")).toBe(true);
    expect(row()?.classList.contains("kw-host")).toBe(true);
  });

  it("never swaps a text-shadow as the lens moves: one dark shadow per slot, the glow is the bloom's opacity", () => {
    const { mode, row } = lens();
    mode.paint(cue(0, 900, true, true));
    frames();
    const slots = slotsOf(row());
    const before = slots.map((s) => s.style.writes.filter((w) => w.includes("shadow")).length);
    for (const s of slots) expect(s.style.getPropertyValue("--ut-dark")).toMatch(/rgba\(0, 0, 0,/u);
    for (const t of [1100, 1600, 2300, 2800, 3200, 3600]) {
      clock += 400;
      mode.paint(cue(0, t));
      mode.retime(cue(0, t + 20));
    }
    frames();
    slots.forEach((s, j) => expect(s.style.writes.filter((w) => w.includes("shadow")).length, `slot ${j}`).toBe(before[j]));
    for (const w of wordsOf(row())) expect(w.style.writes.filter((x) => x.includes("shadow"))).toEqual([]);
  });

  it("styles the slots' plain text with the slot's shadow and transitions nothing", () => {
    const css = lensCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/transition/u);
    expect(/\.lens-slot \.kw-txt\s*\{([^}]*)\}/u.exec(css)?.[1]).toContain("var(--ut-dark)");
  });
});

let lensCss = "";
beforeAll(async () => {
  // Read from disk: vitest hands CSS imports (even ?raw) to its CSS pipeline, which yields "" in node. A
  // non-literal specifier, because the strict type check runs without node's types.
  const fsModule = "node:fs";
  const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: URL, encoding: "utf8"): string };
  lensCss = fs.readFileSync(new URL("../src/styles/lens.css", import.meta.url), "utf8");
});

describe("Lens on the motion engine: line changes", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("glides the next line up into focus on a spring at the lead, while the old one fades out where it is", () => {
    const { mode, row, rows, next } = lens();
    mode.paint(cue(0, 3000));
    frames();
    const old = row();
    const lead = LEADS[1] ?? 0;
    clock += lead - 3000;
    // the stage's line is still the old one: the lead is Lens's own
    expect(mode.crossfades(cue(1, lead))).toBe(false);
    expect(mode.paint(cue(0, lead))).toBe(false);
    const fresh = row();
    expect(fresh).not.toBe(old);
    expect(fresh?.textContent).toContain("Count");
    // on the document timeline, from now, sampled from the spring: it overshoots and settles
    const glide = fresh?.getAnimations()[0];
    expect(glide?.startTime).toBe(clock);
    const ys = (glide?.keyframes ?? []).map((k) => translateY(String(k.transform)));
    expect(ys.length).toBeGreaterThan(4);
    expect(ys[0]).toBeGreaterThan(10);
    expect(Math.min(...ys)).toBeLessThan(-0.5);
    expect(ys[ys.length - 1]).toBe(0);
    expect(Number(glide?.keyframes[0]?.opacity)).toBeCloseTo(0.6, 3);
    // the old line: still, fading out where it is
    expect(old?.classList.contains("lens-leaving")).toBe(true);
    const fade = old?.getAnimations().find((a) => a.keyframes.some((k) => k.opacity === 0));
    expect(fade?.duration).toBe(170);
    for (const s of slotsOf(old)) expect(s.getAnimations()).toEqual([]);
    // the line after rises in below
    expect(next()?.textContent).toBe(LINES[2]?.text.trimEnd());
    expect(next()?.getAnimations().some((a) => a.keyframes.some((k) => "transform" in k))).toBe(true);
    // once the fade is over, the old line is gone
    clock += 400;
    mode.paint(cue(1, lead + 400));
    expect(rows().includes(old as FakeElement)).toBe(false);
  });

  it("arrives waiting: the lens eases in from the line's first word", () => {
    const { mode, row } = lens();
    mode.paint(cue(0, 3000));
    const lead = LEADS[1] ?? 0;
    clock += lead - 3000;
    mode.paint(cue(0, lead));
    const first = LINES[1]?.words[0]?.start ?? 0;
    const spread = (t: number): number => {
      clock += 10;
      mode.paint(cue(t < first ? 0 : 1, t));
      const s = slotsOf(row()).map((x) => lensOf(x).s);
      return Math.max(...s) - Math.min(...s);
    };
    expect(spread(lead + 50)).toBeLessThan(1e-3);
    expect(spread(first - 1)).toBeLessThan(1e-3);
    expect(spread(first + 600)).toBeGreaterThan(0.3);
  });

  it("leaves a line for the break's dots, the next line small below; the dots are gone by E", () => {
    const { mode, row, brk, next } = lens();
    expect(BREAK).toBeDefined();
    if (!BREAK) return;
    mode.paint(cue(1, BREAK.start - 500));
    const sung = row();
    clock += 500;
    mode.paint(cue(1, BREAK.start + 10));
    expect(sung?.classList.contains("lens-leaving")).toBe(true);
    const slot = brk();
    const dots = slot?.find("ut-dot") ?? [];
    expect(dots).toHaveLength(3);
    expect(slot?.find("ut-dots")[0]?.getAnimations().length).toBeGreaterThan(0);
    for (const d of dots) expect(d.getAnimations().length).toBeGreaterThan(0);
    // the line the break leads into, small and dim below, where it already was
    expect(next()?.textContent).toBe(LINES[BREAK.next]?.text.trimEnd());
    // ...and at E it glides up into focus; the dots' slot is taken down
    clock += BREAK.end - BREAK.start;
    mode.paint(cue(BREAK.next, BREAK.end, true, true));
    expect(brk()).toBeUndefined();
    expect(row()?.textContent).toContain("Fold");
    expect(row()?.getAnimations()[0]?.startTime).toBe(clock);
  });

  it("re-lights the line after a seek back past where its animations start", () => {
    const { mode, row } = lens();
    mode.paint(cue(1, 6000));
    frames();
    const words = wordsOf(row());
    expect(words[0]?.getAnimations().length).toBeGreaterThan(0);
    const first = LINES[1]?.words[0]?.start ?? 0;
    // back to before the first word, still on this line's lead: the line is put back where the song is
    clock += 16;
    mode.paint(cue(0, first - 100, true));
    frames();
    const a = slotsOf(row())[0]?.getAnimations()[0];
    expect(a?.currentTime).toBeCloseTo(0, 6);
    const s = slotsOf(row()).map((x) => lensOf(x).s);
    expect(Math.max(...s) - Math.min(...s)).toBeLessThan(1e-3);
  });

  it("holds every animation at its song time while paused, and plays on from there", () => {
    const { mode, row } = lens();
    mode.paint(cue(0, 2000));
    frames();
    clock += 100;
    mode.paint(cue(0, 2100, false));
    const all = everything(row()).flatMap((e) => e.getAnimations());
    expect(all.length).toBeGreaterThan(20);
    const origin = LINES[0]?.words[0]?.start ?? 0;
    for (const a of all) {
      expect(a.paused).toBe(true);
      expect(a.currentTime).toBeCloseTo(2100 - origin, 6);
    }
    clock += 5000;
    mode.paint(cue(0, 2100, true));
    for (const a of all) expect(a.paused).toBe(false);
  });

  it("commits what is on screen for the stage's still copy, and starts again on the next paint", () => {
    const { mode, row } = lens();
    mode.paint(cue(0, 2000));
    frames();
    const slot = slotsOf(row())[0];
    const anim = slot?.getAnimations()[0];
    mode.freeze();
    expect(anim?.cancelled).toBe(true);
    expect(anim?.commits).toBe(1);
    clock += 16;
    mode.paint(cue(0, 2016));
    expect(slotsOf(row())[0]?.getAnimations()).toHaveLength(1);
  });

  it("fades a jump out and in (no glide), and draws a fresh build at once", () => {
    const { mode, row, rows } = lens();
    mode.paint(cue(0, 2000));
    expect(row()?.getAnimations()).toEqual([]);
    const old = row();
    clock += 100;
    mode.paint(cue(3, 17_000));
    expect(old?.classList.contains("lens-leaving")).toBe(true);
    const fadeIn = row()?.getAnimations()[0];
    expect(fadeIn?.keyframes.map((k) => k.opacity)).toEqual([0, 1]);
    expect(rows().length).toBe(2);
  });

  it("takes everything down on destroy", () => {
    const { mode, host, row } = lens();
    mode.paint(cue(0, 2000));
    frames();
    const anims = slotsOf(row()).flatMap((s) => s.getAnimations());
    mode.destroy();
    expect(host.children).toEqual([]);
    for (const a of anims) expect(a.cancelled).toBe(true);
  });
});

describe("Lens on the motion engine: reduced motion, lite, plain lyrics, the look", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("has no lens under reduced motion: a per-word fade, and the stage crossfades lines and breaks", () => {
    const { mode, row, brk } = lens(look({}, { motion: false }));
    mode.paint(cue(0, 2400));
    frames();
    const slots = slotsOf(row());
    for (const s of slots) expect(s.getAnimations()).toEqual([]);
    const scales = slots.map((s) => lensOf(s).s);
    expect(Math.max(...scales) - Math.min(...scales)).toBe(0);
    expect(mode.crossfades(cue(1, 4200))).toBe(true);
    // the karaoke fades each word in: no transforms on the word boxes
    for (const w of wordsOf(row())) for (const a of w.getAnimations()) expect(a.keyframes.some((k) => "transform" in k)).toBe(false);
    expect(wordsOf(row())[2]?.find("kw-win")[0]?.getAnimations()[0]?.keyframes.map((k) => k.opacity)).toEqual([0, 0, 1, 1]);
    if (!BREAK) return;
    // no lead without motion: the line changes with the stage's, and the break's dots cut in
    mode.paint(cue(1, BREAK.start - 100));
    expect(mode.cuts(cue(1, BREAK.start + 10))).toBe(true);
    mode.freeze();
    mode.paint(cue(1, BREAK.start + 10));
    expect(brk()?.find("ut-dot")).toHaveLength(3);
    expect(row()).toBeUndefined();
  });

  it("keeps the lens in the lite tier, with the lite karaoke", () => {
    const { mode, row } = lens(look({}, { power: "lite" }));
    mode.paint(cue(0, 2400));
    frames();
    const slots = slotsOf(row());
    for (const s of slots) expect(s.getAnimations()).toHaveLength(1);
    const scales = slots.map((s) => lensOf(s).s);
    expect(Math.max(...scales) - Math.min(...scales)).toBeGreaterThan(0.3);
    for (const w of wordsOf(row())) for (const a of w.getAnimations()) expect(a.keyframes.some((k) => "transform" in k)).toBe(false);
  });

  it("draws plain lyrics calm and at rest, without an overlay, and glides them calmly", () => {
    const { mode, row } = lens(look({}, { unsynced: true }));
    mode.paint(cue(0, 2400));
    frames();
    expect(row()?.find("kw-fx")).toEqual([]);
    expect(row()?.classList.contains("has-fx")).toBe(false);
    for (const s of slotsOf(row())) expect(s.getAnimations()).toEqual([]);
    const lead = LEADS[1] ?? 0;
    clock += 1000;
    mode.paint(cue(0, lead));
    const glide = row()?.getAnimations()[0];
    // the calm spring: no overshoot
    const ys = (glide?.keyframes ?? []).map((k) => translateY(String(k.transform)));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-1e-9);
  });

  it("sets the look's letter-spacing and case, and measures with them", () => {
    const picked = { ...DEFAULT_PICK, style: "lens" as const, letterSpacing: 0.05, textCase: "upper" as const };
    const l = resolveLook({ ...structuredClone(DEFAULT_SETTINGS) }, null, { width: 1280, height: 720, dpr: 1, motion: true, unsynced: false }, picked);
    const { mode, host, row, next } = lens(l);
    expect(host.children[0]?.style["letterSpacing"]).toBe("0.05em");
    mode.paint(cue(0, 2000));
    expect(row()?.find("kw-txt").map((t) => t.textContent)).toEqual(LINES[0]?.words.map((w) => w.text.trimEnd().toUpperCase()));
    expect(next()?.textContent).toBe(LINES[1]?.text.trimEnd().toUpperCase());
  });

  it("measures again once the face has loaded, and redraws the focus line where the song is", async () => {
    let loaded!: () => void;
    const fonts = { check: vi.fn(() => false), load: vi.fn(() => new Promise<void>((resolve) => (loaded = resolve))) };
    vi.stubGlobal("document", { createElement: (tag: string) => new FakeElement(tag), fonts });
    const measure = vi.spyOn(LensMode.prototype as unknown as { measure: () => void }, "measure");
    const { mode, row } = lens();
    mode.paint(cue(0, 2000));
    const before = row();
    expect(measure).toHaveBeenCalledTimes(1);
    loaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(measure).toHaveBeenCalledTimes(2);
    expect(row()).not.toBe(before);
    expect(row()?.textContent).toContain("Paper");
  });

  it("restyles colors in place, and re-plans the focus line for new motion", () => {
    const { mode, host, row } = lens();
    mode.paint(cue(0, 2000));
    frames();
    const anims = slotsOf(row()).flatMap((s) => s.getAnimations());
    mode.restyle(look({ glow: 90 }));
    const box = host.children[0];
    expect(box?.style.getPropertyValue("--ut-bloom")).toContain("rgba");
    for (const a of anims) expect(a.cancelled).toBe(false);
    const livelier = withBloom({ ...look(), energy: 0.9 }, 0.6);
    mode.restyle(livelier);
    for (const a of anims) expect(a.cancelled).toBe(true);
    expect(slotsOf(row())[0]?.getAnimations()).toHaveLength(1);
  });
});

// Regression (lens-next-offscreen): the next line sat NEXT_DROP focus sizes below the Height whatever
// the Height, so at 95% and up it was drawn entirely below the screen and Lens showed one lone line.
describe("Lens: the next line near the bottom of the stage", () => {
  beforeEach(setup);
  afterEach(teardown);

  const translateOf = (transform: unknown): [number, number] => {
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(String(transform ?? ""));
    return [Number(m?.[1]), Number(m?.[2])];
  };

  const FRAMES: Partial<Frame>[] = [
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
  ];

  it("moves the focus line up just enough to keep its next line on screen, below the focus line", () => {
    for (const frame of FRAMES)
      for (const yPos of [95, 100])
        for (const size of [22, 58, 140]) {
          const l = look({ size, yPos }, frame);
          const { mode, row, next } = lens(l);
          mode.paint(cue(0, 2000, false));
          const where = `${frame.width}x${frame.height} Height ${yPos} Size ${size}`;
          expect(next()?.textContent, where).toBe(LINES[1]?.text);
          const top = translateOf(next()?.style.getPropertyValue("transform"))[1];
          const below = Number.parseFloat(next()?.style.getPropertyValue("font-size") ?? "");
          expect(top + below, where).toBeLessThanOrEqual(l.height);
          // every focus word's box as drawn (scaled around its baseline, 0.8 em down in this DOM) ends above it
          for (const slot of slotsOf(row())) {
            const { s } = lensOf(slot);
            const y = translateOf(slot.getAnimations()[0]?.values()["transform"] ?? slot.style.getPropertyValue("transform"))[1];
            expect(y + 0.8 * l.size + 0.2 * l.size * s, where).toBeLessThanOrEqual(top);
          }
          mode.destroy();
        }
  });

  it("leaves the Height alone where the next line fits, and on the last line", () => {
    for (const yPos of [0, 46, 85]) {
      const l = look({ yPos });
      expect(focusCenter(l, l.size, nextSize(600, l.size, l))).toBe(l.y);
    }
    const bottom = look({ yPos: 100 });
    expect(focusCenter(bottom, bottom.size, null)).toBe(bottom.y);
    expect(focusCenter(bottom, bottom.size, nextSize(600, bottom.size, bottom))).toBeLessThan(bottom.y);
  });

  it("never lifts the focus line past resolveLook's top margin on a stage too small for both lines", () => {
    const l = look({ yPos: 100, size: 140 }, { width: 400, height: 120, referenceHeight: 120 });
    expect(focusCenter(l, l.size, nextSize(600, l.size, l))).toBe(Math.min(l.size * 0.75, l.height / 2));
    // the settings preview has the room
    const preview = look({ yPos: 100, size: 140 }, { width: 340, height: 191, referenceHeight: 680 });
    const y = focusCenter(preview, preview.size, nextSize(600, preview.size, preview));
    expect(y).toBeLessThan(preview.y);
    expect(y).toBeGreaterThan(preview.size * 0.75);
  });
});
