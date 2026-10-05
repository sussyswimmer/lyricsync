import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../contract/contract";
import type { Palette } from "../src/core/palette";
import { FONTS, fontFor } from "../src/overlay/fonts";
import { REFERENCE_HEIGHT, dropShadow, resolveLook, rgba, shadowLayers, snap, textShadow, type Frame, type Look } from "../src/overlay/look";

const FRAME: Frame = { width: 1920, height: 1080, dpr: 2, motion: true, unsynced: false };
const PALETTE: Palette = { lyric: "#f5efe6", highlight: "#e0559a", dim: "#7d7f99" };

const settings = (over: Partial<Settings> = {}): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), ...over });
const look = (over: Partial<Settings> = {}, frame: Partial<Frame> = {}, palette: Palette | null = null): Look =>
  resolveLook(settings(over), palette, { ...FRAME, ...frame });

describe("resolveLook: size", () => {
  it("is Settings.size on a 1080 px tall stage", () => {
    expect(REFERENCE_HEIGHT).toBe(1080);
    expect(look().size).toBe(58);
    expect(look({ size: 22 }).size).toBe(22);
  });

  it("scales with the stage height so it reads the same on any display", () => {
    expect(look({}, { height: 2160 }).size).toBe(116);
    expect(look({}, { height: 540 }).size).toBe(29);
    expect(look({ size: 140 }, { height: 1440 }).size).toBeCloseTo(186.667, 3);
  });

  it("does not scale by the device pixel ratio (CSS px already account for it)", () => {
    expect(look({}, { dpr: 1 }).size).toBe(look({}, { dpr: 3 }).size);
  });

  it("scales against a custom reference height (the settings preview)", () => {
    expect(look({}, { height: 270, referenceHeight: 270 }).size).toBe(58);
    expect(look({}, { height: 540, referenceHeight: 270 }).size).toBe(116);
  });

  it("never drops below 1 px, even on a collapsed stage", () => {
    expect(look({}, { height: 0 }).size).toBe(1);
    expect(look({ size: 22 }, { height: 10 }).size).toBe(1);
  });
});

describe("resolveLook: colors", () => {
  it("uses the album palette when autoColor is on and one is ready", () => {
    expect(look({ autoColor: true }, {}, PALETTE).colors).toEqual(PALETTE);
  });

  it("uses the manual colors until a palette arrives", () => {
    expect(look({ autoColor: true }).colors).toEqual(DEFAULT_SETTINGS.colors);
  });

  it("uses the manual colors when autoColor is off, palette or not", () => {
    const colors = { lyric: "#ffffff", highlight: "#00ff88", dim: "#444444" };
    expect(look({ autoColor: false, colors }, {}, PALETTE).colors).toEqual(colors);
  });
});

describe("resolveLook: placement and scaled settings", () => {
  // Mid-range values only: at the extremes the line is kept on screen (next tests).
  it("places the line at yPos percent of the stage height", () => {
    expect(look({ yPos: 46 }).y).toBeCloseTo(496.8, 6);
    expect(look({ yPos: 25 }, { height: 900 }).y).toBe(225);
    expect(look({ yPos: 75 }, { height: 900 }).y).toBe(675);
    expect(look({ yPos: 50 }, { height: 300 }).y).toBe(150);
  });

  it("moves the line down as yPos rises, across the whole range", () => {
    const ys = [0, 10, 25, 46, 75, 90, 100].map((yPos) => look({ yPos }, { height: 720 }).y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1] ?? Infinity);
    expect(ys[ys.length - 1]).toBeGreaterThan(ys[0] ?? Infinity);
  });

  // Regression: Height 0 and 100 used to center the focus line on the screen edge, half off screen.
  // The contract allows 0..100, so resolveLook keeps the line whole rather than the slider limiting it.
  it("keeps the whole focus line on the stage at the Height extremes", () => {
    for (const yPos of [0, 100]) {
      const l = look({ yPos }, { height: 720 });
      expect(l.y - l.size / 2).toBeGreaterThanOrEqual(0);
      expect(l.y + l.size / 2).toBeLessThanOrEqual(l.height);
    }
  });

  it("maps curve, glow and opacity to unit ranges", () => {
    expect(look({ curve: 38, glow: 40, opacity: 100 })).toMatchObject({ curve: 0.38, glow: 0.4, opacity: 1 });
    expect(look({ curve: -100, glow: 0, opacity: 20 })).toMatchObject({ curve: -1, glow: 0, opacity: 0.2 });
    expect(look({ curve: 100, glow: 100 })).toMatchObject({ curve: 1, glow: 1 });
  });

  it("passes the frame through", () => {
    expect(look({}, { width: 800, height: 600, dpr: 1.5, motion: false, unsynced: true })).toMatchObject({
      width: 800,
      height: 600,
      dpr: 1.5,
      motion: false,
      unsynced: true,
    });
  });
});

describe("resolveLook: font", () => {
  it("resolves a bundled family to its stack and keeps the chosen weight", () => {
    const l = look({ font: { family: "Syne", weight: 600 } });
    expect(l.font).toBe(fontFor("Syne").stack);
    expect(l.font.startsWith('"Syne"')).toBe(true);
    expect(l.weight).toBe(600);
  });

  it("falls back to the default face for an unknown family", () => {
    const l = look({ font: { family: "Not A Real Font", weight: 700 } });
    expect(l.font).toBe(FONTS[0]?.stack);
    expect(l.font.startsWith('"Fraunces"')).toBe(true);
  });

  it("uses the face's own weight when none is set", () => {
    expect(look({ font: { family: "Syne", weight: 0 } }).weight).toBe(800);
    expect(look({ font: { family: "Instrument Serif", weight: 0 } }).weight).toBe(400);
  });

  it("gives the system stack CJK fallbacks", () => {
    expect(look({ font: { family: "System", weight: 700 } }).font).toMatch(/PingFang SC.*sans-serif$/u);
  });
});

describe("rgba", () => {
  it("converts #rrggbb with a 3-decimal alpha", () => {
    expect(rgba("#f2a65a", 0.5)).toBe("rgba(242, 166, 90, 0.500)");
    expect(rgba("#000000", 1)).toBe("rgba(0, 0, 0, 1.000)");
    expect(rgba("#FFFFFF", 0)).toBe("rgba(255, 255, 255, 0.000)");
    expect(rgba("#0a0b0c", 0.12345)).toBe("rgba(10, 11, 12, 0.123)");
  });
});

describe("shadows", () => {
  it("always carries the soft dark shadow, subtle at glow 0", () => {
    const flat = look({ glow: 0 });
    expect(shadowLayers(flat, 58, false)).toEqual([
      ["0px", "1.0px", "2.0px", "rgba(0, 0, 0, 0.400)"],
      ["0px", "0px", "8.0px", "rgba(0, 0, 0, 0.160)"],
    ]);
  });

  it("adds no halo at glow 0, even on the active word", () => {
    const flat = look({ glow: 0 });
    expect(shadowLayers(flat, 58, true)).toHaveLength(2);
    expect(textShadow(flat, 58, true).match(/rgba\(/gu)).toHaveLength(2);
    expect(dropShadow(flat, 58, true).match(/drop-shadow\(/gu)).toHaveLength(2);
  });

  it("adds a highlight-colored halo to the active word only", () => {
    const glowing = look({ glow: 40 });
    expect(shadowLayers(glowing, 58, false)).toHaveLength(2);
    const active = shadowLayers(glowing, 58, true);
    expect(active).toHaveLength(3);
    expect(active[2]).toEqual(["0px", "0px", "15.6px", rgba(DEFAULT_SETTINGS.colors.highlight, 0.55)]);
    expect(textShadow(glowing, 58, true)).toContain("rgba(242, 166, 90, ");
    expect(textShadow(glowing, 58)).not.toContain("rgba(242, 166, 90, ");
  });

  it("grows with glow and scales with text size", () => {
    const full = look({ glow: 100 });
    expect(shadowLayers(full, 116, true)).toEqual([
      ["0px", "2.0px", "8.0px", "rgba(0, 0, 0, 0.550)"],
      ["0px", "0px", "44.0px", "rgba(0, 0, 0, 0.360)"],
      ["0px", "0px", "60.0px", rgba(DEFAULT_SETTINGS.colors.highlight, 0.85)],
    ]);
  });

  it("takes the halo color from the palette when album colors are on", () => {
    const l = look({ autoColor: true, glow: 50 }, {}, PALETTE);
    expect(shadowLayers(l, 58, true)[2]?.[3]).toBe(rgba(PALETTE.highlight, 0.6));
  });

  it("formats text-shadow and drop-shadow from the same layers", () => {
    const l = look({ glow: 40 });
    expect(textShadow(l, 58, true)).toBe(
      "0px 1.0px 2.8px rgba(0, 0, 0, 0.460), 0px 0px 13.6px rgba(0, 0, 0, 0.240), 0px 0px 15.6px rgba(242, 166, 90, 0.550)",
    );
    expect(dropShadow(l, 58, true)).toBe(
      "drop-shadow(0px 1.0px 2.8px rgba(0, 0, 0, 0.460)) drop-shadow(0px 0px 13.6px rgba(0, 0, 0, 0.240)) drop-shadow(0px 0px 15.6px rgba(242, 166, 90, 0.550))",
    );
  });

  it("never emits a negative length", () => {
    expect(textShadow(look({ glow: 0 }), -58)).not.toMatch(/-\d/u);
  });
});

describe("snap", () => {
  it("rounds to the device pixel grid", () => {
    expect(snap(10.3, 1)).toBe(10);
    expect(snap(10.6, 1)).toBe(11);
    expect(snap(1.26, 2)).toBe(1.5);
    expect(snap(1.24, 2)).toBe(1);
    expect(snap(0.34, 3)).toBeCloseTo(1 / 3, 10);
    expect(snap(-2.2, 2)).toBe(-2);
  });
});
