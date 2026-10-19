import { describe, expect, it } from "vitest";
import type { Lyrics, LyricsStatus } from "../contract/contract";
import { parseLrc } from "../src/core/lrc";
import { pacePlain, PLAIN_INTRO, PLAIN_LINE_MS, PLAIN_OUTRO } from "../src/core/timing";
import type { StageView } from "../src/overlay/stage";
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

  // Regression (degenerate-synced): the parser keeps the first line of a stamp and skips unstamped
  // rows, so LRC with every row on one stamp, or with one stamped row over untimed text, held a single
  // line on screen for the whole song while the plain lyrics went unused.
  describe("synced LRC whose timing would hold one line all song", () => {
    const FOUR = "First line here\nSecond line here\nThird line here\nFourth line here";

    it("paces the plain lyrics when every row sits on one stamp", () => {
      const synced = FOUR.split("\n").map((t) => `[00:00.00]${t}`).join("\n");
      expect(viewFor(lyrics("found", { synced, plain: FOUR }), DURATION)).toEqual({ kind: "lyrics", timeline: pacePlain(FOUR, DURATION) });
    });

    it("paces the LRC's own text when only its first row is timed and there are no plain lyrics", () => {
      // "[00:12.00]First line here", then three rows with no stamp
      const synced = `[ar:Demo Artist]\n[00:12.00]${FOUR}`;
      const view = viewFor(lyrics("found", { synced }), DURATION);
      expect(view).toEqual({ kind: "lyrics", timeline: pacePlain(FOUR, DURATION) });
      expect(view.kind === "lyrics" && view.timeline.unsynced).toBe(true);
    });

    it("keeps translated LRCs synced, with two or three rows on every stamp", () => {
      for (const rows of [2, 3]) {
        const synced = [1, 2, 3, 4]
          .map((n) => Array.from({ length: rows }, (_, r) => `[00:0${2 * n}.00]line ${n} row ${r + 1}`).join("\n"))
          .join("\n");
        const view = viewFor(lyrics("found", { synced, plain: FOUR }), DURATION);
        expect(view, `${rows} rows`).toEqual({ kind: "lyrics", timeline: { lines: parseLrc(synced, DURATION), unsynced: false } });
        expect(view.kind === "lyrics" && view.timeline.lines.map((l) => l.text)).toEqual(["line 1 row 1", "line 2 row 1", "line 3 row 1", "line 4 row 1"]);
      }
    });

    it("keeps a short song synced, and a song with a few untimed credit rows", () => {
      const short = "[00:01.00]only line\n[00:03.00]and another";
      expect(viewFor(lyrics("found", { synced: short, plain: FOUR }), DURATION)).toMatchObject({ kind: "lyrics", timeline: { unsynced: false } });
      const credits = `Words and music by nobody in particular\n${neonMonsoon}`;
      expect(viewFor(lyrics("found", { synced: credits }), DURATION)).toMatchObject({ kind: "lyrics", timeline: { unsynced: false } });
    });

    // Regression (shape-knife-edge): every unstamped row counted as untimed text, so an unstamped
    // translation under each stamped row, or the synced block's text pasted under it, sat one credit
    // or title row away from throwing away good timing and pacing every row evenly.
    const ORIGINALS = Array.from({ length: 10 }, (_, n) => `placeholder line number ${n + 1}`);
    const stamp = (n: number): string => `[00:${String(1 + 3 * n).padStart(2, "0")}.00]`;
    const synced = (lrc: string): StageView => ({ kind: "lyrics", timeline: { lines: parseLrc(lrc, DURATION), unsynced: false } });

    it("keeps an unstamped translation under every stamped row synced, with a credit row too", () => {
      const rows = ORIGINALS.map((t, n) => `${stamp(n)}${t}\nthe same placeholder line ${n + 1}, translated`);
      const lrc = `Lyrics by somebody placeholder\n${rows.join("\n")}`;
      const view = viewFor(lyrics("found", { synced: lrc }), DURATION);
      expect(view).toEqual(synced(lrc));
      expect(view.kind === "lyrics" && view.timeline.lines.map((l) => l.text)).toEqual(ORIGINALS);
    });

    it("keeps a stamped block synced with a blank row, a title and its plain text pasted under it", () => {
      const block = ORIGINALS.map((t, n) => `${stamp(n)}${t}`).join("\n");
      for (const lrc of [`${block}\n\nA Placeholder Title\n${ORIGINALS.join("\n")}`, `A Placeholder Title\n${block}\n${ORIGINALS.join("\n")}`]) {
        expect(viewFor(lyrics("found", { synced: lrc, plain: ORIGINALS.join("\n") }), DURATION)).toEqual(synced(lrc));
      }
    });

    it("still paces a partly timed LRC, not counting the row under a stamped one or copies of stamped rows", () => {
      // two stamped rows, then all ten as plain text: eight rows the parser would never show
      const lrc = `${stamp(0)}${ORIGINALS[0]}\n${stamp(1)}${ORIGINALS[1]}\n${ORIGINALS.join("\n")}`;
      const view = viewFor(lyrics("found", { synced: lrc, plain: ORIGINALS.join("\n") }), DURATION);
      expect(view).toEqual({ kind: "lyrics", timeline: pacePlain(ORIGINALS.join("\n"), DURATION) });
      // and one stamped row over three plain ones, the row right under it skipped: two against one
      const one = `${stamp(0)}${ORIGINALS[0]}\n${ORIGINALS.slice(1, 4).join("\n")}`;
      expect(viewFor(lyrics("found", { synced: one }), DURATION)).toMatchObject({ kind: "lyrics", timeline: { unsynced: true } });
    });
  });

  it("is not-found when nothing usable is left", () => {
    expect(viewFor(lyrics("found"), DURATION)).toEqual({ kind: "not-found" });
    expect(viewFor(lyrics("found", { synced: "", plain: "" }), DURATION)).toEqual({ kind: "not-found" });
    expect(viewFor(lyrics("found", { synced: "[00:01.00]\n", plain: " \n\t\n " }), DURATION)).toEqual({ kind: "not-found" });
  });
});

describe("viewFor: plain-only", () => {
  it("paces plain lines across the track after its intro, unsynced", () => {
    const view = viewFor(lyrics("plain-only", { plain: PLAIN }), 30_000);
    expect(view).toEqual({ kind: "lyrics", timeline: pacePlain(PLAIN, 30_000) });
    if (view.kind !== "lyrics") return;
    expect(view.timeline.unsynced).toBe(true);
    expect(view.timeline.lines.map((l) => l.text)).toEqual(["First placeholder line", "Second placeholder line", "Third one"]);
    expect(view.timeline.lines[0]?.start).toBe(PLAIN_INTRO.minMs);
    expect(view.timeline.lines[view.timeline.lines.length - 1]?.end).toBe(30_000 - PLAIN_OUTRO.minMs);
  });

  it("never treats synced text as timed when the status says plain-only", () => {
    const view = viewFor(lyrics("plain-only", { synced: neonMonsoon, plain: PLAIN }), DURATION);
    expect(view.kind === "lyrics" && view.timeline.unsynced).toBe(true);
    expect(viewFor(lyrics("plain-only", { synced: neonMonsoon }), DURATION)).toEqual({ kind: "not-found" });
  });

  it("gives each line PLAIN_LINE_MS on average when the duration is unknown", () => {
    const view = viewFor(lyrics("plain-only", { plain: PLAIN }), 0);
    if (view.kind !== "lyrics") throw new Error("no lyrics");
    expect(view.timeline.lines[0]?.start).toBe(0);
    expect(view.timeline.lines[view.timeline.lines.length - 1]?.end).toBe(3 * PLAIN_LINE_MS);
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
