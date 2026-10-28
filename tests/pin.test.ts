import { describe, expect, it } from "vitest";
import { RETIRED_STYLES, STYLES } from "../src/core/songlook";
import { parseStylePin, pinOverride } from "../src/overlay/pin";

describe("the style pin (Settings › Style)", () => {
  it("reads every style Settings offers", () => {
    for (const style of STYLES) expect(parseStylePin(style)).toBe(style);
    expect(pinOverride("slant")).toEqual({ style: "slant" });
    expect(pinOverride(null)).toBeNull();
  });

  it("reads a pin of a retired style, saved before it was retired, as Auto", () => {
    for (const style of RETIRED_STYLES) expect(parseStylePin(style), style).toBeNull();
  });

  it("reads anything else as Auto", () => {
    for (const value of [null, undefined, "", "auto", "Slant", 3, {}]) expect(parseStylePin(value)).toBeNull();
  });
});
