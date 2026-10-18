import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Lyrics, type NowPlaying } from "../contract/contract";
import type { ArgsOf, Bridge, Command, Event, Events, ResultOf, Unlisten } from "../src/bridge/types";
import { parseLrc, type Line } from "../src/core/lrc";
import { PaletteCache } from "../src/core/palette";
import { OverlayController } from "../src/overlay/controller";
import { fontFor } from "../src/overlay/fonts";
import { DriftMode } from "../src/overlay/modes/drift";
import type { Cue } from "../src/overlay/modes/types";
import { LINGER_MS, LyricStage, type StageView } from "../src/overlay/stage";
import { buildState } from "../src/overlay/states";
import { asHtml, FakeAnimation, StageElement, stageSize, stubStageDom } from "./fake-dom";
import paperLanterns from "./fixtures/paper-lanterns.lrc?raw";
import { cue, LINES, look as lookFor, settings, stylesheet } from "./helpers";

/** Opacity the fake getComputedStyle reports: an element's own, or whatever a test says a fade is at. */
const drawnOpacity = new WeakMap<StageElement, number>();

let clock = 0;

beforeEach(() => {
  clock = 10_000;
  Object.assign(stageSize, { width: 1280, height: 720 });
  stubStageDom();
  vi.stubGlobal("getComputedStyle", (el: StageElement) => ({ opacity: String(drawnOpacity.get(el) ?? el.style["opacity"] ?? 1) }));
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Eight one-row placeholder lines, two seconds apart. */
const EIGHT: Line[] = parseLrc(
  Array.from({ length: 8 }, (_, i) => `[00:${String(2 * i + 1).padStart(2, "0")}.00]placeholder line number ${i + 1}`).join("\n"),
  20_000,
);

/** A built Drift (depth 1) or Stack (depth 0) on a fake host. */
function drift(depth = 1, look = lookFor(), lines: readonly Line[] = LINES): { mode: DriftMode; host: StageElement; rows: StageElement[] } {
  const host = new StageElement("div");
  const mode = new DriftMode(depth);
  mode.build(asHtml(host), lines, look);
  return { mode, host, rows: host.find("drift-row") };
}

const scaleOf = (row: StageElement | undefined): number => Number(/scale\(([\d.]+)\)/u.exec(row?.style.getPropertyValue("transform") ?? "")?.[1]);
const yOf = (row: StageElement | undefined): number => Number(/calc\(-50% \+ (-?[\d.]+)px\)/u.exec(row?.style.getPropertyValue("transform") ?? "")?.[1]);

// Drift glided from performance.now(), and no frame follows a paused
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
    expect(mode.crossfades(cue(2, 10_000, false, true))).toBe(true);
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
    expect(mode.crossfades(cue(2, 12_500, false))).toBe(true);
    mode.paint(cue(1, 5016));
    expect(mode.crossfades(cue(2, 12_500))).toBe(false);
    clock += 16;
    expect(mode.paint(cue(2, 12_500))).toBe(true);
  });
});

// A jump of more than three lines while playing cut the whole stack in
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

// After a rebuild or a cut, paint kept asking for frames for the whole
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

// A word drew unlit at exactly its start time.
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
function stage(): { stage: LyricStage; root: StageElement; scenes: () => StageElement[] } {
  const host = new StageElement("main");
  const s = new LyricStage(asHtml(host));
  s.setSettings(settings({ mode: "stack" }));
  const root = host.children[0] as StageElement;
  return { stage: s, root, scenes: () => root.children.filter((c) => c.classList.contains("ut-scene")) };
}

const lyricsView = { kind: "lyrics", timeline: { lines: parseLrc(paperLanterns, 24_000), unsynced: false } } as const;
const fadeIn = (el: StageElement | undefined): FakeAnimation | undefined => el?.animations.find((a) => a.keyframes[1]?.opacity === 1);
const fadeOut = (el: StageElement | undefined): FakeAnimation | undefined => el?.animations.find((a) => a.keyframes[1]?.opacity === 0);

// A new song waited 250 ms behind a loading state
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

// Fades restarted from their nominal opacity, so a half-faded
// scene or a ghost copy flashed to full brightness.
describe("fades start from what is on screen", () => {
  it("fades a song out from wherever its own fade-in had got to", () => {
    const { stage: s, scenes } = stage();
    s.show(lyricsView, "a");
    clock += 600;
    const first = scenes()[0] as StageElement;
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
    const scene = scenes()[0] as StageElement;
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

// Layouts are snapped to device pixels, but only a resize rebuilt
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

// Every song got one fixed CJK fallback order, and the page said
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
    const host = new StageElement("main");
    const s = new LyricStage(asHtml(host), { referenceHeight: () => reference });
    s.setSettings(settings({ mode: "stack" }));
    s.show(lyricsView, "a");
    const drift = (): StageElement | undefined => host.find("drift")[0];
    expect(drift()?.style["fontSize"]).toBe("58px");
    reference = 360;
    s.setSettings(settings({ mode: "stack", glow: 41 }));
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
    s.setSettings(settings({ mode: "stack", glow: 90, opacity: 50, colors: { lyric: "#ffffff", highlight: "#ff0000", dim: "#333333" } }));
    expect(scenes()[0]?.find("drift")[0]).toBe(before);
    s.setSettings(settings({ mode: "stack", size: 80 }));
    expect(scenes()[0]?.find("drift")[0]).not.toBe(before);
  });
});

// The chip's 4 s animation started at build and included its own
// fade-in, so it was fully readable for only about 2.5 s.
describe("the not-found chip", () => {
  it("holds for 4 s after its scene has faded in, then fades out", () => {
    const host = new StageElement("div");
    buildState(asHtml(host), "not-found", lookFor());
    expect(host.children[0]?.style["animationDelay"]).toBe("4700ms");
  });

  it("resumes where it was after a rebuild, so a faded chip stays gone", () => {
    const host = new StageElement("div");
    buildState(asHtml(host), "not-found", lookFor(), 6000);
    expect(host.children[0]?.style["animationDelay"]).toBe("-1300ms");
  });
});

const stageCss = (): string => stylesheet("src/styles/stage.css");

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

// Under reduced motion the loading dots kept pulsing forever;
// only the instrumental ♪ had stopped breathing. Reduced motion means crossfades only.
describe("stage.css under reduced motion", () => {
  let css = "";
  beforeAll(async () => {
    css = stageCss();
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
    const host = new StageElement("div");
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
    css = stageCss();
  });
  const rule = (selector: string): string => blocks(css).find((b) => b.prelude === selector)?.body ?? "";

  // The not-found and error chips' 0.42 dark fill left light lyric text at
  // about 2.8:1 over a light wallpaper, under the 4.5:1 that 17 px text needs.
  it("keeps the chip's text at 4.5:1 or better over a white wallpaper, and gives it the lyrics' dark shadow", () => {
    const m = /background:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(rule(".state-chip"));
    expect(m).not.toBeNull();
    const alpha = Number(m?.[4]);
    const fill = [1, 2, 3].map((i) => Number(m?.[i]) * alpha + 255 * (1 - alpha));
    // the default lyric color, and the bluest album lyric color paletteFromPixels makes (HSL lightness 0.92, saturation 0.3)
    for (const lyric of [DEFAULT_SETTINGS.colors.lyric, "#e4e4f1"]) expect(contrast(rgbOf(lyric), fill), lyric).toBeGreaterThanOrEqual(4.5);
    const host = new StageElement("div");
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

// Performance budget: with nothing to sing, the stage gives the frame loop nothing to wake
// for, so the controller sleeps until something changes (tests/regress-foundation-controller.test.ts).
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
    // Paper Lanterns' last word ends at 20 s; its line stays lit for LINGER_MS, then nothing changes
    s.render(19_500);
    expect(s.nextChange(19_500)).toBe(500);
    expect(s.nextChange(20_000 + LINGER_MS - 100)).toBe(100);
    for (const t of [20_000 + LINGER_MS + 1, 30_000]) {
      expect(s.render(t)).toBe(false);
      expect(s.nextChange(t)).toBe(Infinity);
    }
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

// The performance budget, end to end: the overlay as overlay/main.ts builds it (a gated controller,
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
    stubStageDom({ visibilityState: "visible", addEventListener: (): void => undefined, removeEventListener: (): void => undefined });
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

  async function overlay(): Promise<{ bridge: StubBridge; host: StageElement; paints: number[]; controller: OverlayController }> {
    const bridge = new StubBridge();
    bridge.answers.get_settings = settings({ mode: "stack" });
    bridge.answers.get_now_playing = track("a");
    bridge.answers.get_lyrics = result("a", "loading");
    // as overlay/main.ts wires them
    const host = new StageElement("main");
    let controller: OverlayController | null = null;
    const s = new LyricStage(asHtml(host), { onInvalidate: () => controller?.kick() });
    controller = new OverlayController(bridge, s, { gate: true, palettes: new PaletteCache(async () => null) });
    const paints: number[] = [];
    const render = s.render.bind(s);
    s.render = (t: number): boolean => {
      paints.push(Date.now());
      return render(t);
    };
    await controller.start();
    return { bridge, host, paints, controller };
  }

  /** Over the next `ms` the loop doesn't wake at all: nothing will change until an event kicks it. */
  function expectAsleep(paints: number[], ms: number, what: string): void {
    const from = paints.length;
    run(ms);
    expect(paints.length - from, what).toBe(0);
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
    expectAsleep(paints, 5000, "after the last line");

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
