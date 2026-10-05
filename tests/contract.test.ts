import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION, DEFAULT_SETTINGS } from "../contract/contract";
describe("contract v1", () => {
  it("exports the complete initial settings payload", () => {
    expect(CONTRACT_VERSION).toBe(1);
    expect(DEFAULT_SETTINGS).toEqual({
      version: 1, mode: "arc", autoColor: true,
      colors: { lyric: "#f1ece3", highlight: "#f2a65a", dim: "#8d93a0" },
      font: { family: "Fraunces", weight: 700 }, size: 58, curve: 38,
      yPos: 46, glow: 40, opacity: 100, showWhen: "playing", displays: "primary",
      globalOffsetMs: 0, trackOffsetsMs: {},
    });
  });
});
