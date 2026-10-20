import { describe, expect, it } from "vitest";
import { fitRow, poseOf, type Shape } from "../src/overlay/modes/lens-plan";
import { balancedRows, LENS_LAYOUT, POSTER_LAYOUT, POSTER_MAX_ROW, posterRows, SPOT_BIG, SPOT_FAINT, SPOTLIGHT_LAYOUT } from "../src/overlay/modes/slot-layouts";

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
