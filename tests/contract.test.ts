import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION, DEFAULT_SETTINGS, type MediaStatus } from "../contract/contract";
describe("contract v2", () => {
  it("exports the complete initial settings payload", () => {
    expect(CONTRACT_VERSION).toBe(2);
    expect(DEFAULT_SETTINGS).toEqual({
      version: 1, mode: "arc", autoColor: true,
      colors: { lyric: "#f1ece3", highlight: "#f2a65a", dim: "#8d93a0" },
      font: { family: "Fraunces", weight: 700 }, size: 58, curve: 38,
      yPos: 46, glow: 40, opacity: 100, showWhen: "playing", displays: "primary",
      globalOffsetMs: 0, trackOffsetsMs: {},
    });
  });

  it("adds media-status without touching the settings schema", () => {
    // Settings.version is the settings schema's own version: still 1 after the contract bump.
    expect(DEFAULT_SETTINGS.version).toBe(1);
    const statuses: MediaStatus[] = [
      { source: "spotify", problem: null },
      { source: "apple-music", problem: "automation-denied" },
      { source: null, problem: "no-player" },
      { source: null, problem: null },
    ];
    // The wire shape the Rust core sends: camelCase keys, kebab-case values, nulls spelled out.
    expect(JSON.parse(JSON.stringify(statuses))).toEqual(statuses);
    expect(Object.keys(statuses[0] ?? {})).toEqual(["source", "problem"]);
  });
});
