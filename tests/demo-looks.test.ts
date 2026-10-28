import { describe, expect, it } from "vitest";
import { MOCK_TRACKS, lyricsOf, trackKeyOf, type MockTrack } from "../src/bridge/mock";
import { FONTS } from "../src/core/faces";
import type { CoverStats } from "../src/core/palette";
import { hasWordTags, lookLabel, pickLook, songFeatures, timingOf, type SongLook } from "../src/core/songlook";
import { viewFor } from "../src/overlay/view";

/*
 * The look demos, mock tracks 7–9: three original songs written so that Undertone picks three
 * different looks for them, as songlook.ts reads them (their real parse, their timing, their covers).
 */

/**
 * coverStats of the look demos' covers (src/bridge/covers.ts, covers 3–5), sampled at 48×48 in
 * Chromium the way readArtwork does. Precomputed, since the pixels need a real canvas; the same
 * script gives covers 0–2 exactly the numbers tests/songlook.test.ts has for them.
 */
const COVERS: Readonly<Record<number, CoverStats>> = {
  // Ledger Lines: a ruled page in black and white
  3: { lightness: 0.493, contrast: 0.349, chroma: 0.003, colorfulness: 0.01, warmth: 0, gray: 1, hue: null },
  // Strobe Hearts: neon rings and strobe bars on black
  4: { lightness: 0.161, contrast: 0.192, chroma: 0.183, colorfulness: 0.724, warmth: 0.017, gray: 0.613, hue: 0.155 },
  // Glacier Nocturne: a pale moon over ridges of ice, at night
  5: { lightness: 0.168, contrast: 0.143, chroma: 0.151, colorfulness: 0.243, warmth: -0.98, gray: 0.146, hue: 0.58 },
};

function demo(title: string): MockTrack {
  const t = MOCK_TRACKS.find((x) => x.title === title);
  if (!t) throw new Error(`no demo track "${title}"`);
  return t;
}

/** The song as an overlay offers it once its lyrics and cover are in (or before the cover decodes). */
function inputOf(t: MockTrack, withCover = true) {
  const lyrics = lyricsOf(t);
  const view = viewFor(lyrics, t.durationMs);
  const timeline = view.kind === "lyrics" ? view.timeline : null;
  return {
    track: { trackKey: trackKeyOf(t), title: t.title, album: t.album, durationMs: t.durationMs },
    lines: timeline?.lines ?? [],
    timing: timingOf(lyrics, timeline),
    cover: withCover && t.cover !== null ? (COVERS[t.cover] ?? null) : null,
  };
}

const lookOf = (t: MockTrack, withCover = true): SongLook => pickLook(songFeatures(inputOf(t, withCover)));
const face = (family: string) => FONTS.find((f) => f.family === family);

const LEDGER = "Ledger Lines";
const STROBE = "Strobe Hearts (Club Mix)";
const GLACIER = "Glacier Nocturne";

describe("the look demos (mock tracks 7–9)", () => {
  it("come after the first seven tracks, which keep their places", () => {
    expect(MOCK_TRACKS.slice(0, 7).map((t) => t.title)).toEqual([
      "Neon Monsoon",
      "Paper Lanterns",
      "Letters Never Sent",
      "Ultraviolet Static",
      "Tidal Interlude",
      "Script Sampler",
      "Glass Harbor",
    ]);
    expect(MOCK_TRACKS.slice(7, 10).map((t) => t.title)).toEqual([LEDGER, STROBE, GLACIER]);
  });

  it("are longer songs, 60–120 s and 16–30 lines, timed word by word, with original placeholder lyrics", () => {
    for (const title of [LEDGER, STROBE, GLACIER]) {
      const t = demo(title);
      expect(t.status, title).toBe("found");
      expect(t.durationMs, title).toBeGreaterThanOrEqual(60_000);
      expect(t.durationMs, title).toBeLessThanOrEqual(120_000);
      const synced = t.synced ?? "";
      expect(synced, title).toContain("[by:Original placeholder lyrics written for Undertone]");
      expect(hasWordTags(synced), title).toBe(true);
      const input = inputOf(t);
      expect(input.timing, title).toBe("word");
      const sung = input.lines.filter((l) => l.words.length > 0);
      expect(sung.length, title).toBeGreaterThanOrEqual(16);
      expect(sung.length, title).toBeLessThanOrEqual(30);
      // every sung line ends inside the song, with room to spare
      expect(sung[sung.length - 1]?.end ?? Infinity, title).toBeLessThan(t.durationMs - 2000);
    }
  });

  it("Ledger Lines: a fast, dense verse under a black-and-white cover is kinetic Slant in Bricolage", () => {
    const look = lookOf(demo(LEDGER));
    expect(lookLabel(look)).toBe("Slant · Bricolage");
    expect(look.font).toEqual({ family: "Bricolage Grotesque", weight: face("Bricolage Grotesque")?.weight });
    expect(look.textCase).toBe("as-is");
    expect(look.traits).toEqual(expect.arrayContaining(["fast", "black-and-white cover"]));
  });

  it("Strobe Hearts (Club Mix): short shouted hooks under a neon cover Pop in Unbounded capitals", () => {
    const look = lookOf(demo(STROBE));
    expect(lookLabel(look)).toBe("Pop · Unbounded");
    expect(look.textCase).toBe("upper");
    expect(look.traits).toEqual(expect.arrayContaining(["shouted lines", "remix"]));
  });

  it("Glacier Nocturne: sparse, slow lines with long breaks under a cold, dark cover are a Spotlight in Instrument Serif", () => {
    const look = lookOf(demo(GLACIER));
    expect(lookLabel(look)).toBe("Spotlight · Instrument Serif");
    expect(look.traits).toEqual(expect.arrayContaining(["slow", "long instrumental gaps"]));
    // long breaks: the interlude dots get room (3 s or more between two lines)
    const sung = inputOf(demo(GLACIER)).lines.filter((l) => l.words.length > 0);
    const lastWordEnd = (i: number): number => {
      const words = sung[i]?.words ?? [];
      return words[words.length - 1]?.end ?? 0;
    };
    const gaps = sung.slice(1).map((l, i) => l.start - lastWordEnd(i));
    expect(gaps.filter((ms) => ms >= 10_000)).toHaveLength(3);
  });

  it("are clear picks: no near-tie settled by the trackKey hash, and the cover never changes the pick", () => {
    const labels = [LEDGER, STROBE, GLACIER].map((title) => {
      const look = lookOf(demo(title));
      expect(look.ties, title).toEqual({ style: false, font: false });
      // the artwork arriving after the lyrics refines nothing on screen (LookKeeper)
      const early = lookOf(demo(title), false);
      expect(lookLabel(early), title).toBe(lookLabel(look));
      expect(early.textCase, title).toBe(look.textCase);
      return lookLabel(look);
    });
    expect(new Set(labels).size).toBe(3);
  });
});
