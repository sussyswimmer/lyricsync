import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION, DEFAULT_SETTINGS, type MediaStatus, type ShortcutAction, type ShortcutsStatus } from "../contract/contract";
describe("contract v3", () => {
  it("exports the complete initial settings payload", () => {
    expect(CONTRACT_VERSION).toBe(3);
    expect(DEFAULT_SETTINGS).toEqual({
      version: 1, mode: "arc", autoColor: true,
      colors: { lyric: "#f1ece3", highlight: "#f2a65a", dim: "#8d93a0" },
      font: { family: "Fraunces", weight: 700 }, size: 58, curve: 38,
      yPos: 46, glow: 40, opacity: 100, showWhen: "playing", displays: "primary",
      globalOffsetMs: 0, trackOffsetsMs: {},
      enabled: true, launchAtLogin: false,
      shortcuts: {
        enabled: true,
        toggleLyrics: "CmdOrCtrl+Alt+Shift+L",
        nudgeEarlier: "CmdOrCtrl+Alt+Shift+]",
        nudgeLater: "CmdOrCtrl+Alt+Shift+[",
      },
    });
  });

  it("adds media-status without touching the settings schema", () => {
    // Settings.version is the settings schema's own version: still 1 after the contract bumps.
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

  it("reports shortcuts per action, keyed by the camelCase action names", () => {
    const actions: ShortcutAction[] = ["toggleLyrics", "nudgeEarlier", "nudgeLater"];
    const status: ShortcutsStatus = { toggleLyrics: "ok", nudgeEarlier: "unavailable", nudgeLater: "off" };
    expect(Object.keys(status)).toEqual(actions);
    expect(Object.keys(DEFAULT_SETTINGS.shortcuts)).toEqual(["enabled", ...actions]);
    const states: ShortcutsStatus[ShortcutAction][] = ["ok", "off", "unavailable", "invalid"];
    expect(JSON.parse(JSON.stringify(states))).toEqual(states);
  });
});
