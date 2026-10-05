import { describe, expect, it } from "vitest";
import type { Lyrics, LyricsStatus } from "../contract/contract";
import { parseLrc } from "../src/core/lrc";
import { pacePlain } from "../src/core/timing";
import { sameLyrics, viewFor } from "../src/overlay/view";
import neonMonsoon from "./fixtures/neon-monsoon.lrc?raw";
import paperLanterns from "./fixtures/paper-lanterns.lrc?raw";

const KEY = "demo artist|neon monsoon|undertone demo|35";
const DURATION = 35_000;
const PLAIN = "First placeholder line\n\nSecond placeholder line\nThird one";

const lyrics = (status: LyricsStatus, over: Partial<Lyrics> = {}): Lyrics => ({
  trackKey: KEY,
  status,
  synced: null,
  plain: null,
  source: "lrclib",
  ...over,
});

describe("viewFor: states without lines", () => {
  it.each([
    ["loading", "loading"],
    ["instrumental", "instrumental"],
    ["not-found", "not-found"],
    ["error", "error"],
  ] as const)("%s → %s", (status, kind) => {
    expect(viewFor(lyrics(status), DURATION)).toEqual({ kind });
  });

  it("ignores any text that rides along with a non-lyric status", () => {
    expect(viewFor(lyrics("instrumental", { synced: neonMonsoon, plain: PLAIN }), DURATION)).toEqual({ kind: "instrumental" });
    expect(viewFor(lyrics("loading", { plain: PLAIN }), DURATION)).toEqual({ kind: "loading" });
  });
});

describe("viewFor: found", () => {
  it("uses synced LRC, word-highlighted", () => {
    const view = viewFor(lyrics("found", { synced: neonMonsoon, plain: PLAIN }), DURATION);
    expect(view).toEqual({ kind: "lyrics", timeline: { lines: parseLrc(neonMonsoon, DURATION), unsynced: false } });
  });

  it("keeps enhanced word timing", () => {
    const view = viewFor(lyrics("found", { synced: paperLanterns }), 24_000);
    expect(view.kind).toBe("lyrics");
    if (view.kind !== "lyrics") return;
    const first = view.timeline.lines[0];
    expect(first?.words.map((w) => [w.text, w.start])).toEqual([
      ["Paper ", 1000],
      ["lanterns ", 1500],
      ["over ", 2200],
      ["the ", 2700],
      ["river", 2900],
    ]);
  });

  it("caps the last line at the track duration", () => {
    const view = viewFor(lyrics("found", { synced: "[00:01.00]only line" }), 9000);
    expect(view.kind === "lyrics" && view.timeline.lines[view.timeline.lines.length - 1]?.end).toBe(9000);
  });

  it("paces plain text when there is no synced LRC, unsynced", () => {
    const view = viewFor(lyrics("found", { plain: PLAIN }), DURATION);
    expect(view).toEqual({ kind: "lyrics", timeline: pacePlain(PLAIN, DURATION) });
    expect(view.kind === "lyrics" && view.timeline.unsynced).toBe(true);
    expect(view.kind === "lyrics" && view.timeline.lines.map((l) => l.text)).toEqual([
      "First placeholder line",
      "Second placeholder line",
      "Third one",
    ]);
  });

  it("falls back to plain text when the synced LRC has no timed lines", () => {
    const junk = "[ti:Placeholder]\n[ar:Demo]\nnot a timed line\n";
    const view = viewFor(lyrics("found", { synced: junk, plain: PLAIN }), DURATION);
    expect(view).toEqual({ kind: "lyrics", timeline: pacePlain(PLAIN, DURATION) });
  });

  it("falls back to plain text when the synced LRC holds only instrumental gaps", () => {
    const gaps = "[00:01.00]\n[00:10.00]\n";
    expect(parseLrc(gaps, DURATION).length).toBeGreaterThan(0);
    const view = viewFor(lyrics("found", { synced: gaps, plain: PLAIN }), DURATION);
    expect(view.kind === "lyrics" && view.timeline.unsynced).toBe(true);
  });

  it("is not-found when nothing usable is left", () => {
    expect(viewFor(lyrics("found"), DURATION)).toEqual({ kind: "not-found" });
    expect(viewFor(lyrics("found", { synced: "", plain: "" }), DURATION)).toEqual({ kind: "not-found" });
    expect(viewFor(lyrics("found", { synced: "[00:01.00]\n", plain: " \n\t\n " }), DURATION)).toEqual({ kind: "not-found" });
  });
});

describe("viewFor: plain-only", () => {
  it("paces plain lines evenly across the track, unsynced", () => {
    const view = viewFor(lyrics("plain-only", { plain: PLAIN }), 30_000);
    expect(view).toEqual({ kind: "lyrics", timeline: pacePlain(PLAIN, 30_000) });
    if (view.kind !== "lyrics") return;
    expect(view.timeline.lines.map((l) => l.start)).toEqual([0, 10_000, 20_000]);
    expect(view.timeline.lines[view.timeline.lines.length - 1]?.end).toBe(30_000);
  });

  it("never treats synced text as timed when the status says plain-only", () => {
    const view = viewFor(lyrics("plain-only", { synced: neonMonsoon, plain: PLAIN }), DURATION);
    expect(view.kind === "lyrics" && view.timeline.unsynced).toBe(true);
    expect(viewFor(lyrics("plain-only", { synced: neonMonsoon }), DURATION)).toEqual({ kind: "not-found" });
  });

  it("paces at a fixed rate when the duration is unknown", () => {
    const view = viewFor(lyrics("plain-only", { plain: PLAIN }), 0);
    expect(view.kind === "lyrics" && view.timeline.lines.map((l) => l.start)).toEqual([0, 4000, 8000]);
  });

  it("is not-found with no plain text", () => {
    expect(viewFor(lyrics("plain-only"), DURATION)).toEqual({ kind: "not-found" });
  });
});

describe("sameLyrics", () => {
  const a = lyrics("found", { synced: "[00:01.00]la", plain: "la" });

  it("is false with nothing to compare", () => {
    expect(sameLyrics(null, a)).toBe(false);
  });

  it("is true for the same content, whatever the source", () => {
    expect(sameLyrics(a, a)).toBe(true);
    expect(sameLyrics(a, { ...a })).toBe(true);
    expect(sameLyrics(a, { ...a, source: "cache" })).toBe(true);
  });

  it.each([
    ["trackKey", { trackKey: "other|track||1" }],
    ["status", { status: "plain-only" }],
    ["synced", { synced: "[00:02.00]la" }],
    ["plain", { plain: null }],
  ] as const)("is false when %s differs", (_field, change) => {
    expect(sameLyrics(a, { ...a, ...change })).toBe(false);
  });

  it("tells loading apart from the result for the same track", () => {
    expect(sameLyrics(lyrics("loading"), lyrics("found", { synced: "[00:01.00]la" }))).toBe(false);
    expect(sameLyrics(lyrics("loading"), lyrics("loading"))).toBe(true);
  });
});
