import { describe, expect, it } from "vitest";
import { fitRow, planLens, poseOf, type Shape } from "../src/overlay/modes/lens-plan";
import {
  balancedRows,
  COLLAGE_LAYOUT,
  collageRows,
  LENS_LAYOUT,
  POSTER_LAYOUT,
  POSTER_MAX_ROW,
  posterRows,
  CASCADE_GHOST,
  CASCADE_LAYOUT,
  POP_BIG,
  POP_LAYOUT,
  popPhase,
  REEL_ABOVE,
  REEL_BELOW,
  REEL_BIG,
  REEL_LAYOUT,
  REEL_LEAD_MS,
  reelAt,
  REVEAL_GHOST,
  REVEAL_LAYOUT,
  SLANT_BIG,
  SLANT_KEEP,
  SLANT_LAYOUT,
  slantOpacity,
  slantScale,
  slantTag,
  SLOT_LAYOUTS,
  TAPE_LAYOUT,
  tapeTag,
  SPOT_BIG,
  SPOT_FAINT,
  SPOTLIGHT_LAYOUT,
  WAVE_AMP,
  WAVE_BIG,
  WAVE_LAYOUT,
} from "../src/overlay/modes/slot-layouts";

const SIZE = 58;
const STAGE = { width: 1440, height: 900 };
/** A line of words of these widths (px at SIZE), a quarter em apart. */
const shapeOf = (widths: number[]): Shape => ({ widths, order: widths.map((_, i) => i), gaps: widths.map((_, i) => (i < widths.length - 1 ? SIZE / 4 : 0)) });
const LINE = shapeOf([120, 60, 200, 90, 150, 60, 180]);

describe("Poster", () => {
  it("sets a line in more rows the more words it has", () => {
    expect([1, 2, 3, 4, 5, 7, 8, 11, 12, 20].map(posterRows)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  it("splits a line into rows of even width, in order, every word once", () => {
    const rows = balancedRows(LINE, 3);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.from).toBe(0);
    expect(rows[2]?.to).toBe(6);
    rows.slice(1).forEach((r, i) => expect(r.from).toBe((rows[i]?.to ?? 0) + 1));
    const even = shapeOf([100, 100, 100, 100, 100, 100]);
    expect(balancedRows(even, 3).map((r) => r.to - r.from + 1)).toEqual([2, 2, 2]);
    expect(balancedRows(shapeOf([]), 3)).toEqual([]);
  });

  it("sets a short row larger to match the widest, within bounds, and the block inside the stage", () => {
    const fit = POSTER_LAYOUT.fit(LINE, SIZE, STAGE, true, 0, 0.8);
    const rows = fit.block?.rows ?? [];
    for (const r of rows) {
      expect(r.scale).toBeGreaterThanOrEqual(1);
      expect(r.scale).toBeLessThanOrEqual(POSTER_MAX_ROW);
    }
    const widest = Math.max(...rows.map((r) => r.width * r.scale));
    expect(widest * fit.fit).toBeLessThanOrEqual(0.86 * STAGE.width + 1e-6);
    expect((fit.block?.height ?? 0) * fit.fit).toBeLessThanOrEqual(0.6 * STAGE.height + 1e-6);
  });

  it("composes each line its own way: aligned and tilted differently from one line to the next, level at rest", () => {
    const comps = [0, 1, 2, 3, 4, 5, 6].map((line) => POSTER_LAYOUT.fit(LINE, SIZE, STAGE, true, line, 0.8).block);
    expect(new Set(comps.map((b) => `${b?.align}|${b?.tilt}`)).size).toBeGreaterThan(3);
    expect(POSTER_LAYOUT.fit(LINE, SIZE, STAGE, false, 1, 0.8).block?.tilt).toBe(0);
  });

  it("stacks its rows, every word in a row on one baseline, and turns the block about its middle", () => {
    const fit = POSTER_LAYOUT.fit(LINE, SIZE, STAGE, false, 0, 0.8);
    const pose = POSTER_LAYOUT.pose(LINE, fit, STAGE.width, 1, 0, 0);
    const rows = fit.block?.rows ?? [];
    const rowY = rows.map((r) => pose.y[r.from] ?? 0);
    for (let i = 1; i < rowY.length; i++) expect(rowY[i]).toBeGreaterThan(rowY[i - 1] ?? 0);
    for (const r of rows) for (let v = r.from; v <= r.to; v++) expect(pose.y[v]).toBeCloseTo(rowY[rows.indexOf(r)] ?? 0, 6);
    expect(pose.opacity.every((o) => o === 1)).toBe(true);
    const tilted = POSTER_LAYOUT.fit(LINE, SIZE, STAGE, true, 1, 0.8);
    const turned = POSTER_LAYOUT.pose(LINE, tilted, STAGE.width, 1, 1, 0);
    expect(turned.rotate.every((r) => r === tilted.block?.tilt)).toBe(true);
  });

  it("keeps the words not sung yet dim and a little small, and the sung ones full", () => {
    const fit = POSTER_LAYOUT.fit(LINE, SIZE, STAGE, true, 0, 0.8);
    const pose = POSTER_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, 2.5);
    expect(pose.opacity[0]).toBe(1);
    expect(pose.opacity[1]).toBe(1);
    expect(pose.opacity[2]).toBeGreaterThan(pose.opacity[5] ?? 1);
    expect(pose.opacity[6]).toBeCloseTo(0.42, 6);
    expect(POSTER_LAYOUT.faintest(fit, STAGE.width, true).opacity).toBeCloseTo(0.42, 6);
    const reach = POSTER_LAYOUT.extent(fit, SIZE * fit.fit);
    expect(reach.above).toBeGreaterThan(SIZE / 2);
  });
});

describe("Spotlight", () => {
  it("draws the word being sung largest, in the middle of the stage, its neighbors smaller and fainter", () => {
    const fit = SPOTLIGHT_LAYOUT.fit(LINE, SIZE, STAGE, true, 0, 0.8);
    const pose = SPOTLIGHT_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, 2.5);
    const biggest = pose.scale.indexOf(Math.max(...pose.scale));
    expect(biggest).toBe(2);
    expect(pose.scale[2]).toBeCloseTo(fit.fit * SPOT_BIG, 1);
    // the singing point, halfway through word 2, is in the middle
    expect((pose.x[2] ?? 0) + 0.5 * (pose.scale[2] ?? 1) * (LINE.widths[2] ?? 0)).toBeCloseTo(STAGE.width / 2, 0);
    expect(pose.opacity[0]).toBeLessThan(pose.opacity[1] ?? 1);
    expect(Math.min(...pose.opacity)).toBeGreaterThanOrEqual(SPOT_FAINT - 1e-9);
    // the largest word fits the stage
    expect(Math.max(...LINE.widths) * fit.fit * SPOT_BIG).toBeLessThanOrEqual(0.8 * STAGE.width + 1e-6);
  });

  it("at rest (reduced motion, plain lyrics) is one plain row, fitted and centered", () => {
    const fit = SPOTLIGHT_LAYOUT.fit(LINE, SIZE, STAGE, false, 0, 0.8);
    const rest = poseOf(LINE, fitRow(LINE, SIZE, STAGE.width, false), STAGE.width, 1, 0, 0);
    const pose = SPOTLIGHT_LAYOUT.pose(LINE, fit, STAGE.width, 1, 0, 0);
    expect(pose.x).toEqual(rest.x);
    expect(pose.scale).toEqual(rest.scale);
    expect(SPOTLIGHT_LAYOUT.faintest(fit, STAGE.width, false).opacity).toBe(1);
    const moving = SPOTLIGHT_LAYOUT.fit(LINE, SIZE, STAGE, true, 0, 0.8);
    expect(SPOTLIGHT_LAYOUT.extent(moving, SIZE).above).toBeGreaterThan(SPOTLIGHT_LAYOUT.extent(fit, SIZE).above);
    expect(SPOTLIGHT_LAYOUT.faintest(moving, STAGE.width, true).opacity).toBe(SPOT_FAINT);
  });
});

describe("Lens as a layout", () => {
  it("is the fisheye as before: its fit, its pose, one row", () => {
    const fit = LENS_LAYOUT.fit(LINE, SIZE, STAGE, true, 0, 0.8);
    expect(fit).toEqual(fitRow(LINE, SIZE, STAGE.width, true));
    const pose = LENS_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, 2.5);
    expect(pose).toEqual(poseOf(LINE, fit, STAGE.width, 1, 1, 2.5));
    expect(pose.y.every((y) => y === 0) && pose.rotate.every((r) => r === 0)).toBe(true);
    expect(LENS_LAYOUT.extent(fit, SIZE)).toEqual({ above: SIZE / 2, below: SIZE / 2 });
    expect(LENS_LAYOUT.faintest(fit, STAGE.width, false).opacity).toBe(1);
  });
});

describe("Wave", () => {
  it("lifts the word being sung onto the crest, a little larger, and tilts the words on the slopes", () => {
    const fit = WAVE_LAYOUT.fit(LINE, SIZE, STAGE, true, 0, 0.8);
    const pose = WAVE_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, 3.5);
    // word 3 is being sung: highest (most negative drop) and largest
    const highest = pose.y.indexOf(Math.min(...pose.y));
    expect(highest).toBe(3);
    expect(pose.scale[3]).toBeCloseTo(fit.fit * WAVE_BIG, 3);
    for (const j of [0, 1, 2, 4, 5, 6]) expect(pose.scale[j]).toBeLessThan(pose.scale[3] ?? 0);
    // never more than the wave's height off the line, and the slopes lean
    for (const y of pose.y) expect(Math.abs(y)).toBeLessThanOrEqual(WAVE_AMP * SIZE * fit.fit + 1e-6);
    expect(pose.rotate.some((r) => r > 2)).toBe(true);
    expect(pose.rotate.some((r) => r < -2)).toBe(true);
    // the crest follows the voice
    const later = WAVE_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, 5.5);
    expect(later.y.indexOf(Math.min(...later.y))).toBe(5);
  });

  it("keeps the row inside the stage, and at rest is one plain row", () => {
    const fit = WAVE_LAYOUT.fit(LINE, SIZE, STAGE, true, 0, 0.8);
    for (const a of [0, 1.5, 3.5, 6.5]) {
      const pose = WAVE_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, a);
      const right = Math.max(...LINE.widths.map((w, j) => (pose.x[j] ?? 0) + w * (pose.scale[j] ?? 1)));
      expect(Math.min(...pose.x)).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(STAGE.width);
    }
    const still = WAVE_LAYOUT.fit(LINE, SIZE, STAGE, false, 0, 0.8);
    const rest = WAVE_LAYOUT.pose(LINE, still, STAGE.width, 1, 0, 2);
    expect(rest).toEqual(poseOf(LINE, fitRow(LINE, SIZE, STAGE.width, false), STAGE.width, 1, 0, 0));
  });
});

describe("Reveal", () => {
  it("shows the words sung so far, and keeps the rest as faint, low ghosts in their places", () => {
    const fit = REVEAL_LAYOUT.fit(LINE, SIZE, STAGE, true, 0, 0.8);
    const pose = REVEAL_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, 3.5);
    for (const j of [0, 1, 2]) {
      expect(pose.opacity[j]).toBeCloseTo(1, 6);
      expect(pose.y[j]).toBeCloseTo(0, 6);
    }
    for (const j of [4, 5, 6]) {
      expect(pose.opacity[j]).toBeCloseTo(REVEAL_GHOST, 6);
      expect(pose.y[j]).toBeGreaterThan(0);
      expect(pose.scale[j]).toBeLessThan(fit.fit);
    }
    // the word being sung is coming in
    expect(pose.opacity[3]).toBeGreaterThan(REVEAL_GHOST);
    // the line doesn't move as it fills in: a word's middle stays where it is
    const start = REVEAL_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, 0);
    const end = REVEAL_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, LINE.widths.length);
    LINE.widths.forEach((w, j) => {
      const mid = (p: typeof pose): number => (p.x[j] ?? 0) + (w * (p.scale[j] ?? 1)) / 2;
      expect(mid(start)).toBeCloseTo(mid(end), 6);
    });
    expect(end.opacity.every((o) => Math.abs(o - 1) < 1e-9)).toBe(true);
  });
});

describe("Collage", () => {
  it("sets a line in one to three rows, each word its own size and tilt, the same every time", () => {
    expect([1, 3, 4, 7, 8, 20].map(collageRows)).toEqual([1, 1, 2, 2, 3, 3]);
    const fit = COLLAGE_LAYOUT.fit(LINE, SIZE, STAGE, true, 4, 0.8);
    const c = fit.collage;
    expect(c?.rows).toHaveLength(2);
    expect(new Set(c?.scale.map((s) => s.toFixed(3))).size).toBeGreaterThan(3);
    expect(c?.tilt.some((t) => t > 0) && c?.tilt.some((t) => t < 0)).toBe(true);
    expect(COLLAGE_LAYOUT.fit(LINE, SIZE, STAGE, true, 4, 0.8)).toEqual(fit);
    expect(COLLAGE_LAYOUT.fit(LINE, SIZE, STAGE, true, 5, 0.8).collage?.tilt).not.toEqual(c?.tilt);
    // the block fits the stage
    expect((c?.width ?? 0) * fit.fit).toBeLessThanOrEqual(0.86 * STAGE.width + 1e-6);
    expect((c?.height ?? 0) * fit.fit).toBeLessThanOrEqual(0.56 * STAGE.height + 1e-6);
  });

  it("stacks its rows, dims the words not sung yet, and at rest is one level row", () => {
    const fit = COLLAGE_LAYOUT.fit(LINE, SIZE, STAGE, true, 2, 0.8);
    const pose = COLLAGE_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, 2.5);
    const rows = fit.collage?.rows ?? [];
    expect((pose.y[rows[1]?.from ?? 0] ?? 0) - (pose.y[rows[0]?.from ?? 0] ?? 0)).toBeGreaterThan(SIZE * fit.fit * 0.5);
    for (const j of [0, 1]) expect(pose.opacity[j]).toBe(1);
    for (const j of [4, 5, 6]) expect(pose.opacity[j]).toBeLessThan(1);
    expect(pose.rotate.some((r) => r !== 0)).toBe(true);
    const still = COLLAGE_LAYOUT.fit(LINE, SIZE, STAGE, false, 2, 0.8);
    const rest = COLLAGE_LAYOUT.pose(LINE, still, STAGE.width, 1, 0, 0);
    expect(still.collage?.rows).toHaveLength(1);
    expect(rest.rotate.every((r) => r === 0)).toBe(true);
    expect(new Set(rest.y.map((y) => y.toFixed(6))).size).toBe(1);
  });
});

describe("Reel", () => {
  const BASELINE = 0.8;

  it("has the word being sung big in the middle of the stage, the one just sung small and faint above it, the next below, the rest unseen", () => {
    const fit = REEL_LAYOUT.fit(LINE, SIZE, STAGE, true, 0, BASELINE);
    const side = fit.reel?.side ?? 0;
    const pose = REEL_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, 2);
    expect(pose.scale[2]).toBeCloseTo(fit.fit * REEL_BIG, 6);
    expect(pose.scale[1]).toBeCloseTo(fit.fit * side, 6);
    expect(pose.scale[3]).toBeCloseTo(fit.fit * side, 6);
    // every word centered across the stage, on its own row
    LINE.widths.forEach((w, j) => expect((pose.x[j] ?? 0) + (w * (pose.scale[j] ?? 1)) / 2).toBeCloseTo(STAGE.width / 2, 6));
    expect(pose.y[1]).toBeLessThan(pose.y[2] ?? 0);
    expect(pose.y[3]).toBeGreaterThan(pose.y[2] ?? 0);
    // the rows' middles (not their baselines: a bigger word's is further below its middle) are a pitch apart
    const middle = (j: number): number => (pose.y[j] ?? 0) - (BASELINE - 0.5) * SIZE * (pose.scale[j] ?? 1);
    expect(middle(3) - middle(2)).toBeCloseTo(middle(2) - middle(1), 6);
    expect(middle(3) - middle(2)).toBeCloseTo((fit.reel?.pitch ?? 0) * fit.fit, 6);
    // the big word's em box is centered on the line's: its baseline sits (baseline - 0.5) of the extra em lower
    expect(pose.y[2]).toBeCloseTo((BASELINE - 0.5) * SIZE * fit.fit * (REEL_BIG - 1), 6);
    expect(pose.opacity[2]).toBe(1);
    expect(pose.opacity[1]).toBeCloseTo(REEL_ABOVE, 6);
    expect(pose.opacity[3]).toBeCloseTo(REEL_BELOW, 6);
    for (const j of [0, 4, 5, 6]) expect(pose.opacity[j]).toBe(0);
    expect(pose.rotate.every((r) => r === 0)).toBe(true);
    // the next word fades in as it comes up from two rows down, the last one out as it goes two rows up
    const rolling = REEL_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, 2.5);
    expect(rolling.opacity[4]).toBeGreaterThan(0);
    expect(rolling.opacity[4]).toBeLessThan(REEL_BELOW);
    expect(rolling.opacity[1]).toBeGreaterThan(0);
    expect(rolling.opacity[1]).toBeLessThan(REEL_ABOVE);
    expect(rolling.scale[2]).toBeCloseTo(rolling.scale[3] ?? 0, 6);
  });

  it("fits the biggest word and the three rows to the stage, holds its rows whatever the ease-in, and at rest is one plain row", () => {
    const fit = REEL_LAYOUT.fit(LINE, SIZE, STAGE, true, 0, BASELINE);
    expect(Math.max(...LINE.widths) * fit.fit * REEL_BIG).toBeLessThanOrEqual(0.78 * STAGE.width + 1e-6);
    const reach = REEL_LAYOUT.extent(fit, SIZE * fit.fit);
    expect(reach.above + reach.below).toBeLessThanOrEqual(0.72 * STAGE.height + 1e-6);
    const narrow = REEL_LAYOUT.fit(LINE, SIZE, { width: 400, height: 900 }, true, 0, BASELINE);
    expect(narrow.fit).toBeLessThan(fit.fit);
    expect(Math.max(...LINE.widths) * narrow.fit * REEL_BIG).toBeLessThanOrEqual(0.78 * 400 + 1e-6);
    // a line arriving before its first word already has it in the middle: lens 0 and 1 pose alike
    expect(REEL_LAYOUT.pose(LINE, fit, STAGE.width, 1, 0, 0)).toEqual(REEL_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, 0));
    expect(REEL_LAYOUT.faintest(fit, STAGE.width, true).opacity).toBeCloseTo(Math.min(REEL_ABOVE, REEL_BELOW), 6);
    const still = REEL_LAYOUT.fit(LINE, SIZE, STAGE, false, 0, BASELINE);
    expect(still.reel).toBeUndefined();
    expect(REEL_LAYOUT.pose(LINE, still, STAGE.width, 1, 0, 3)).toEqual(poseOf(LINE, fitRow(LINE, SIZE, STAGE.width, false), STAGE.width, 1, 0, 0));
    expect(REEL_LAYOUT.faintest(still, STAGE.width, false).opacity).toBe(1);
    expect(REEL_LAYOUT.alone).toBe(true);
    expect(REEL_LAYOUT.glides).toBe(false);
    // Reel alone stands alone: Slant and Pop hide their next line in CSS and keep their pictures, and no other style carries signs
    expect(Object.values(SLOT_LAYOUTS).filter((l) => l.alone).map((l) => l.kind)).toEqual(["reel"]);
  });

  it("steps to each word as it starts, a little early, and holds the first before the line and the last to its end", () => {
    const words = [0, 1, 2].map((i) => ({ start: 10_000 + 500 * i, end: 10_500 + 500 * i }));
    expect(reelAt(words, 0)).toBe(0);
    expect(reelAt(words, 10_000)).toBe(0);
    expect(reelAt(words, 10_500 - REEL_LEAD_MS - 1)).toBe(0);
    expect(reelAt(words, 10_500 - REEL_LEAD_MS)).toBe(1);
    expect(reelAt(words, 10_700)).toBe(1);
    expect(reelAt(words, 11_000)).toBe(2);
    expect(reelAt(words, 99_000)).toBe(2);
    expect(reelAt([], 5)).toBe(0);
  });

  it("plans its own singing position: each word rolls into the middle on a bouncy spring as it starts, and the last stays", () => {
    const shape = shapeOf([120, 60, 200, 90]);
    const words = [0, 1, 2, 3].map((i) => ({ start: 10_000 + 500 * i, end: 10_500 + 500 * i }));
    const fit = REEL_LAYOUT.fit(shape, SIZE, STAGE, true, 0, BASELINE);
    const plan = planLens({
      words,
      shape,
      fit,
      width: STAGE.width,
      y: 0,
      dpr: 1,
      origin: 9500,
      end: 12_500,
      rampFrom: 10_000,
      motion: true,
      poseAt: (lens, a, out) => REEL_LAYOUT.pose(shape, fit, STAGE.width, 1, lens, a, out),
      ...(REEL_LAYOUT.along ? { target: REEL_LAYOUT.along } : {}),
      ...(REEL_LAYOUT.spring ? { spring: REEL_LAYOUT.spring } : {}),
    });
    const big = fit.fit * REEL_BIG;
    // before the first word: it waits in the middle, full size
    expect(plan.at(9600).scale[0]).toBeCloseTo(big, 3);
    // word 2 is on its way into the middle as it starts, and there a third of a second later
    const starting = plan.at(11_000);
    expect(starting.scale[2]).toBeGreaterThan(starting.scale[1] ?? 0);
    const settled = plan.at(11_350);
    expect(settled.scale[2]).toBeCloseTo(big, 1);
    expect(settled.opacity[1]).toBeCloseTo(REEL_ABOVE, 1);
    // the spring overshoots: on its way, word 2's row passes a little above where it settles
    const ys = Array.from({ length: 40 }, (_, i) => plan.at(10_900 + 10 * i).y[2] ?? 0);
    expect(Math.min(...ys)).toBeLessThan((settled.y[2] ?? 0) - 1);
    // the last word holds the middle past the line's end
    expect(plan.final.scale[3]).toBeCloseTo(big, 3);
    expect(plan.at(12_450).opacity[2]).toBeCloseTo(REEL_ABOVE, 1);
    expect(plan.tracks).toHaveLength(4);
  });
});

describe("every layout", () => {
  it("is named for its kind, and reaches above and below the line", () => {
    for (const [kind, layout] of Object.entries(SLOT_LAYOUTS)) {
      expect(layout.kind).toBe(kind);
      for (const moving of [true, false]) {
        const fit = layout.fit(LINE, SIZE, STAGE, moving, 1, 0.8);
        const reach = layout.extent(fit, SIZE * fit.fit);
        expect(reach.above).toBeGreaterThan(0);
        expect(reach.below).toBeGreaterThan(0);
        const faint = layout.faintest(fit, STAGE.width, moving);
        expect(faint.opacity).toBeGreaterThan(0);
        expect(faint.scale).toBeGreaterThan(0);
        for (const a of [0, 2.5, 7]) {
          const pose = layout.pose(LINE, fit, STAGE.width, 1, moving ? 1 : 0, a);
          for (const list of [pose.x, pose.y, pose.scale, pose.opacity, pose.rotate]) expect(list.every(Number.isFinite)).toBe(true);
        }
      }
    }
  });
});

describe("Slant", () => {
  const fit = SLANT_LAYOUT.fit(LINE, SIZE, STAGE, true, 2, 0.8);

  it("slides a word in big, holds it while it's sung, then shrinks it into the stack, without a jump", () => {
    expect(slantScale(-0.5)).toBeCloseTo(slantScale(-0.2), 6); // waiting off to the side, already set
    expect(slantScale(0)).toBe(SLANT_BIG);
    expect(slantScale(0.5)).toBe(SLANT_BIG);
    expect(slantScale(1)).toBe(SLANT_BIG);
    let last = slantScale(1);
    for (let u = 1; u < 6; u += 0.01) {
      const s = slantScale(u);
      expect(s).toBeLessThanOrEqual(last + 1e-9);
      expect(Math.abs(s - last)).toBeLessThan(0.08);
      last = s;
    }
  });

  it("shows a word only from its arrival until it has climbed SLANT_KEEP words up", () => {
    expect(slantOpacity(-0.5)).toBe(0);
    expect(slantOpacity(0.5)).toBe(1);
    expect(slantOpacity(2)).toBeGreaterThan(0.5);
    expect(slantOpacity(SLANT_KEEP + 0.5)).toBe(0);
  });

  it("puts the word being sung on its tag, and only that one", () => {
    expect(slantTag(-0.3)).toBe(0);
    expect(slantTag(0.5)).toBe(1);
    expect(slantTag(1.5)).toBe(0);
    const pose = SLANT_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, 3.5);
    expect(pose.tag?.map((v) => Math.round(v))).toEqual([0, 0, 0, 1, 0, 0, 0]);
  });

  it("stacks the sung words above the one being sung, the column turned to climb to the right", () => {
    const pose = SLANT_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, 3.5);
    const ys = pose.y.slice(0, 4);
    ys.slice(1).forEach((y, k) => expect(y).toBeGreaterThan(ys[k] ?? 0)); // older words sit higher
    expect(pose.scale[3]).toBeGreaterThan(pose.scale[2] ?? 0);
    expect(pose.rotate.slice(0, 4).every((r) => r < 0)).toBe(true);
  });

  it("rests as one plain row with no tags without motion (reduced motion, plain lyrics)", () => {
    const rest = SLANT_LAYOUT.fit(LINE, SIZE, STAGE, false, 2, 0.8);
    const pose = SLANT_LAYOUT.pose(LINE, rest, STAGE.width, 1, 0, 3.5);
    expect(new Set(pose.y)).toEqual(new Set([0]));
    expect(pose.tag?.every((v) => v === 0)).toBe(true);
    expect(pose.opacity.every((o) => o === 1)).toBe(true);
  });
});

describe("Pop", () => {
  const fit = POP_LAYOUT.fit(LINE, SIZE, STAGE, true, 0, 0.8);

  it("shows one word at a time, huge, and fits the longest word to the stage", () => {
    const pose = POP_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, 2.5);
    expect(pose.opacity.filter((o) => o > 0.5)).toHaveLength(1);
    expect(pose.opacity[2]).toBe(1);
    expect((pose.scale[2] ?? 0) / fit.fit).toBeCloseTo(POP_BIG, 6);
    expect(POP_BIG * Math.max(...LINE.widths) * fit.fit).toBeLessThanOrEqual(STAGE.width * 0.82 + 1e-6);
  });

  it("never draws two words strongly at once through a hand-off", () => {
    for (let a = 1.8; a < 2.2; a += 0.01) {
      const pose = POP_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, a);
      expect((pose.opacity[1] ?? 0) + (pose.opacity[2] ?? 0)).toBeLessThanOrEqual(1.05);
    }
    expect(popPhase(-1).into).toBe(0);
    expect(popPhase(0.5)).toEqual({ into: 1, away: 0 });
    expect(popPhase(2).away).toBe(1);
  });
});

describe("Cascade", () => {
  const fit = CASCADE_LAYOUT.fit(LINE, SIZE, STAGE, true, 0, 0.8);

  it("steps each word lower than the one before, keeps the one being sung in the middle, and the ones ahead faint", () => {
    const pose = CASCADE_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, 3.5);
    pose.y.slice(1).forEach((y, k) => expect(y).toBeGreaterThan(pose.y[k] ?? 0));
    const w = (LINE.widths[3] ?? 0) * (pose.scale[3] ?? 1);
    expect(Math.abs((pose.x[3] ?? 0) + w / 2 - STAGE.width / 2)).toBeLessThan(w);
    expect(pose.opacity[3]).toBeCloseTo(1, 6);
    expect(pose.opacity[4]).toBeCloseTo(CASCADE_GHOST, 6);
  });
});

describe("Tape", () => {
  it("is the collage's layout, with each word's tape on as it's sung and staying", () => {
    const fit = TAPE_LAYOUT.fit(LINE, SIZE, STAGE, true, 1, 0.8);
    const pose = TAPE_LAYOUT.pose(LINE, fit, STAGE.width, 1, 1, 3.5);
    expect(pose.tag?.slice(0, 3).every((v) => v === 1)).toBe(true);
    expect(pose.tag?.slice(4).every((v) => v === 0)).toBe(true);
    expect(tapeTag(-0.5)).toBe(0);
    expect(tapeTag(5)).toBe(1);
    expect(TAPE_LAYOUT.tags).toBe(true);
    expect(COLLAGE_LAYOUT.tags).toBeUndefined();
  });
});
