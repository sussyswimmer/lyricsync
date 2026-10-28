import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../contract/contract";
import type { Palette } from "../src/core/palette";
import { FONTS, fontFor, stackFor } from "../src/overlay/fonts";
import {
  DEFAULT_PICK,
  REFERENCE_HEIGHT,
  cleanOverride,
  dropShadow,
  effectsModeOf,
  effectsOf,
  mergeOverrides,
  overrideFromSettings,
  parseLookOverride,
  pickedOf,
  resolveLook,
  rgba,
  sanePick,
  shadowLayers,
  snap,
  textShadow,
  withOverride,
  workAreaReference,
  type Frame,
  type Look,
  type PickedLook,
} from "../src/overlay/look";
import type { EmphasisRule as CoreEmphasisRule, SongLook } from "../src/core/songlook";
import { bloomOf, type EmphasisRule } from "../src/overlay/motion/params";

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

  // The native overlays cover their display's work area (menu bar, Dock or taskbar left out), which
  // would set every lyric 3-5% smaller than Size says.
  it("keeps Size relative to the whole screen on a stage framed to the work area", () => {
    expect(workAreaReference(1032, 1080)).toBe(1032);
    expect(look({}, { height: 1032, referenceHeight: workAreaReference(1032, 1080) }).size).toBeCloseTo(58, 9);
    expect(look({}, { height: 1415, referenceHeight: workAreaReference(1415, 1440) }).size).toBeCloseTo(58 * (1440 / 1080), 9);
    expect(workAreaReference(1080, 1080)).toBe(REFERENCE_HEIGHT);
  });

  it("bounds a wrong screen report: the work area counts as 80-100% of the screen", () => {
    expect(workAreaReference(700, 1080)).toBeCloseTo(0.8 * REFERENCE_HEIGHT, 9);
    expect(workAreaReference(1200, 1080)).toBe(REFERENCE_HEIGHT);
    for (const screen of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(workAreaReference(1032, screen)).toBe(REFERENCE_HEIGHT);
    expect(workAreaReference(0, 1080)).toBe(REFERENCE_HEIGHT);
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
  // Contract v6: the lyrics always sit in the middle of the display's work area; yPos, still stored
  // (and still in settings saved before v6), moves nothing.
  it("centers the line on the stage, whatever yPos says", () => {
    for (const yPos of [0, 10, 25, 46, 50, 75, 90, 100]) {
      expect(look({ yPos }).y, `yPos ${yPos}`).toBe(540);
      expect(look({ yPos }, { height: 900 }).y, `yPos ${yPos}`).toBe(450);
    }
    expect(look({}, { height: 300 }).y).toBe(150);
    expect(look({}, { height: 1415, referenceHeight: workAreaReference(1415, 1440) }).y).toBe(707.5);
  });

  it("keeps the whole focus line on the stage at any Size, on any stage", () => {
    for (const size of [22, 58, 140]) {
      for (const height of [200, 720, 1415]) {
        const l = look({ size }, { height });
        expect(l.y - l.size / 2).toBeGreaterThanOrEqual(0);
        expect(l.y + l.size / 2).toBeLessThanOrEqual(l.height);
      }
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

  it("puts the song's CJK language first in the stack, and names the face to wait for", () => {
    const ja = look({ font: { family: "Syne", weight: 800 } }, { lang: "ja" });
    expect(ja.font).toBe(stackFor(fontFor("Syne"), "ja"));
    expect(ja.font.indexOf("Hiragino Sans")).toBeLessThan(ja.font.indexOf("PingFang SC"));
    expect(look({}, { lang: "zh-Hans" }).font).toMatch(/^"Fraunces", Georgia, "Songti SC"/u);
    expect(look({}, { lang: null }).font).toBe(fontFor("Fraunces").stack);
    expect(ja.family).toBe("Syne");
    expect(look({ font: { family: "Not A Real Font", weight: 700 } }).family).toBe("Fraunces");
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

describe("the picked look", () => {
  const pick = (over: Partial<PickedLook> = {}): PickedLook => ({ ...DEFAULT_PICK, ...over });
  const picked = (p: PickedLook, over: Partial<Settings> = {}, frame: Partial<Frame> = {}): Look => resolveLook(settings(over), null, { ...FRAME, ...frame }, p);

  it("defaults to the house look: Arc in Fraunces 700, a gentle curve, BL-like motion", () => {
    expect(DEFAULT_PICK).toEqual({
      style: "arc",
      font: { family: "Fraunces", weight: 700 },
      curve: 22,
      energy: 0.45,
      snap: 0.4,
      glow: 0.6,
      emphasis: { minMs: 1000, maxChars: 12, lastWordOnly: false },
      scale: 1,
      letterSpacing: 0,
      textCase: "as-is",
      flair: { move: "rise", accent: "rise", splash: "ripple" },
    });
    expect(Object.isFrozen(DEFAULT_PICK)).toBe(true);
  });

  it("gives the stage its style, face, curve, size scale, letter-spacing, case and motion character", () => {
    const p = pick({ style: "lens", font: { family: "Syne", weight: 800 }, curve: -50, energy: 0.8, snap: 0.9, glow: 0.5, scale: 0.94, letterSpacing: 0.03, textCase: "upper" });
    // the stored mode, face and curve no longer count
    const l = picked(p, { mode: "drift", font: { family: "Caveat", weight: 600 }, curve: 90, size: 60 });
    expect(l.style).toBe("lens");
    expect(l.family).toBe("Syne");
    expect(l.weight).toBe(800);
    expect(l.font).toBe(stackFor(fontFor("Syne"), null));
    expect(l.curve).toBe(-0.5);
    expect(l.size).toBeCloseTo(60 * 0.94, 9);
    expect(l.letterSpacing).toBe(0.03);
    expect(l.textCase).toBe("upper");
    expect([l.energy, l.snap, l.emphasis]).toEqual([0.8, 0.9, DEFAULT_PICK.emphasis]);
    // Glow still scales the song's bloom; Effects comes from the settings
    expect(l.bloom).toBeCloseTo(bloomOf(0.5, 40), 12);
    expect(l.effects).toBe(50);
    expect(l.power).toBe("full");
    expect(picked(p, {}, { power: "lite" }).power).toBe("lite");
  });

  it("keeps the stored mode, face and curve for a caller that passes no pick, with the house motion", () => {
    const l = look({ mode: "drift", font: { family: "Caveat", weight: 600 }, curve: 90 });
    expect([l.style, l.family, l.weight, l.curve]).toEqual(["drift", "Caveat", 600, 0.9]);
    expect([l.energy, l.snap, l.letterSpacing, l.textCase]).toEqual([0.45, 0.4, 0, "as-is"]);
    expect(l.bloom).toBeCloseTo(bloomOf(0.6, 40), 12);
  });

  it("keeps the bloom out of a look's enumerable fields, so a Glow drag never reads as a new layout", () => {
    const a = look({ glow: 30 });
    const b = look({ glow: 80 });
    expect(a.bloom).not.toBe(b.bloom);
    const { glow: _a, colors: _ca, opacity: _oa, ...restA } = a;
    const { glow: _b, colors: _cb, opacity: _ob, ...restB } = b;
    expect(JSON.stringify(restA)).toBe(JSON.stringify(restB));
    expect(Object.keys(a)).not.toContain("bloom");
  });

  it("makes any pick safe to draw", () => {
    const wild = sanePick({ ...pick(), style: "flow" as PickedLook["style"], curve: 400, energy: 7, snap: -1, glow: Number.NaN, scale: 3, letterSpacing: 1, textCase: "loud" as PickedLook["textCase"] });
    expect(wild).toMatchObject({ style: "arc", curve: 100, energy: 1, snap: 0, glow: 0.6, scale: 1.2, letterSpacing: 0.2, textCase: "as-is" });
    expect(sanePick({ ...pick(), emphasis: null }).emphasis).toBeNull();
    expect(picked(pick({ font: { family: "Nope", weight: 0 } })).family).toBe("Fraunces");
  });

  it("draws a song's look by its PickedLook fields alone, leaving out why it was picked", () => {
    const song: SongLook = {
      ...pick({ style: "lens", font: { family: "Syne", weight: 800 }, curve: -12 }),
      traits: ["big repeating hooks"],
      reason: "big repeating hooks → Lens with Syne",
      scores: { style: { arc: 0.1, lens: 0.6, drift: 0.2, stack: 0.3, poster: 0.2, spotlight: 0.1, wave: 0.2, reveal: 0.1, collage: 0.1, slant: 0.1, pop: 0.1, cascade: 0.1, tape: 0.1 }, font: { Syne: 0.5 } },
      ties: { style: false, font: false },
    };
    const drawn: PickedLook = pickedOf(song);
    expect(drawn).toEqual(pick({ style: "lens", font: { family: "Syne", weight: 800 }, curve: -12 }));
    expect(Object.keys(drawn)).not.toContain("reason");
    // one emphasis rule for the picker and the motion: each is the other
    const rule: EmphasisRule = { minMs: 900, maxChars: 10, lastWordOnly: true };
    const same: CoreEmphasisRule = rule;
    const back: EmphasisRule = same;
    expect(back).toBe(rule);
  });

  it("reads Effects from a store that has it, and 50 from one older than contract v4", () => {
    expect(effectsOf(settings())).toBe(50);
    expect(effectsOf({ ...settings(), effects: 80 } as Settings)).toBe(80);
    expect(effectsOf({ ...settings(), effects: 180 } as Settings)).toBe(100);
    expect(effectsOf({ ...settings(), effects: "lots" } as unknown as Settings)).toBe(50);
    expect(look({ effects: 20 } as Partial<Settings>).effects).toBe(20);
  });

  it("reads Effects mode from a store that has it, and on from one older than contract v5", () => {
    expect(effectsModeOf(settings())).toBe(true);
    expect(effectsModeOf(settings({ effectsMode: false }))).toBe(false);
    const v4: Record<string, unknown> = { ...settings() };
    delete v4["effectsMode"];
    expect(effectsModeOf(v4 as unknown as Settings)).toBe(true);
    expect(look({ effectsMode: false }).effectsMode).toBe(false);
    expect(look().effectsMode).toBe(true);
  });

  it("carries the song's flair to the stage, and makes any flair safe to draw", () => {
    const flair = { move: "sway", accent: "pulse", splash: "glints" } as const;
    expect(resolveLook(settings(), null, FRAME, pick({ flair })).flair).toEqual(flair);
    expect(look().flair).toEqual(DEFAULT_PICK.flair);
    const wild = sanePick({ ...pick(), flair: { move: "spin", accent: 3, splash: null } as unknown as PickedLook["flair"] });
    expect(wild.flair).toEqual({ move: "rise", accent: "rise", splash: "ripple" });
    expect(pickedOf({ ...pick({ flair }) }).flair).toEqual(flair);
  });
});

describe("look overrides (QA)", () => {
  it("parse style[,family[,curve]], keeping the pick where a part is empty", () => {
    expect(parseLookOverride("lens")).toEqual({ style: "lens" });
    expect(parseLookOverride("Lens,syne")).toEqual({ style: "lens", font: "Syne" });
    expect(parseLookOverride("arc,,-50")).toEqual({ style: "arc", curve: -50 });
    expect(parseLookOverride(",Bricolage")).toEqual({ font: "Bricolage Grotesque" });
    expect(parseLookOverride("stack,Instrument Serif,999")).toEqual({ style: "stack", font: "Instrument Serif", curve: 100 });
    // what isn't a style, a bundled face or a number is left out; nothing valid is null
    expect(parseLookOverride("flow,Comic,wide")).toBeNull();
    expect(parseLookOverride("drift,Comic")).toEqual({ style: "drift" });
    expect(parseLookOverride("")).toBeNull();
    expect(parseLookOverride(undefined)).toBeNull();
    expect(parseLookOverride(42)).toBeNull();
  });

  it("take the mock's mode, font and curve from ?settings=", () => {
    expect(overrideFromSettings(JSON.stringify({ mode: "stack", glow: 80 }))).toEqual({ style: "stack" });
    expect(overrideFromSettings(JSON.stringify({ font: { family: "Caveat", weight: 600 }, curve: 10 }))).toEqual({ font: "Caveat", curve: 10 });
    expect(overrideFromSettings(JSON.stringify({ glow: 80 }))).toBeNull();
    expect(overrideFromSettings("{not json")).toBeNull();
    expect(overrideFromSettings("[1]")).toBeNull();
    expect(overrideFromSettings(null)).toBeNull();
  });

  it("merge part by part, and force the pick's parts, a face at its bundled weight", () => {
    expect(mergeOverrides({ style: "stack", curve: 5 }, { style: "lens" })).toEqual({ style: "lens", curve: 5 });
    expect(mergeOverrides(null, null)).toBeNull();
    const forced = withOverride(DEFAULT_PICK, { style: "drift", font: "Unbounded", curve: -20 });
    expect(forced).toEqual({ ...DEFAULT_PICK, style: "drift", font: { family: "Unbounded", weight: 700 }, curve: -20 });
    expect(withOverride(DEFAULT_PICK, null)).toBe(DEFAULT_PICK);
    expect(cleanOverride({ style: "lens", font: "Nope", curve: Number.NaN })).toEqual({ style: "lens" });
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
