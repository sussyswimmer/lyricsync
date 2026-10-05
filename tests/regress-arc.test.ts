import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../contract/contract";
import { resolveLook, type Frame, type Look } from "../src/overlay/look";
import {
  arcGeometry,
  arcLength,
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
import arcCss from "../src/styles/arc.css?raw";

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
  it("has no transitions on the filtered bands", () => {
    const css = arcCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/transition\s*:/);
  });
});
