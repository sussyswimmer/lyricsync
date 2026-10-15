import type { Lyrics } from "../../contract/contract";
import { lrcShape, parseLrc, stripLrc, type LrcShape } from "../core/lrc";
import { pacePlain } from "../core/timing";
import type { StageView } from "./stage";

/**
 * Synced LRC whose timing would hold one line on screen for most of the song: more text rows without
 * a stamp than with one (partly timed), or four or more lines on one or two stamps (the parser keeps
 * only the first line of a stamp). Translated LRCs put two or three rows on every stamp, and pass.
 */
function brokenTiming(shape: LrcShape): boolean {
  return shape.untimedTextRows > shape.timedLyricRows || (shape.timedLyricRows >= 4 && shape.distinctLyricStamps <= 2);
}

/**
 * What the stage should show for a lyrics result. Synced LRC wins; plain text paces evenly. Synced
 * LRC with broken timing (see brokenTiming) is paced like plain text too, from the plain lyrics when
 * there are any, so every line still shows.
 */
export function viewFor(lyrics: Lyrics, durationMs: number): StageView {
  switch (lyrics.status) {
    case "loading":
      return { kind: "loading" };
    case "instrumental":
      return { kind: "instrumental" };
    case "not-found":
      return { kind: "not-found" };
    case "error":
      return { kind: "error" };
    case "found":
    case "plain-only": {
      if (lyrics.status === "found" && lyrics.synced) {
        const lines = parseLrc(lyrics.synced, durationMs);
        if (lines.some((l) => l.words.length > 0)) {
          if (!brokenTiming(lrcShape(lyrics.synced))) return { kind: "lyrics", timeline: { lines, unsynced: false } };
          const text = lyrics.plain?.trim() ? lyrics.plain : stripLrc(lyrics.synced);
          return { kind: "lyrics", timeline: pacePlain(text, durationMs) };
        }
      }
      if (lyrics.plain) {
        const timeline = pacePlain(lyrics.plain, durationMs);
        if (timeline.lines.length > 0) return { kind: "lyrics", timeline };
      }
      return { kind: "not-found" };
    }
  }
}

/** Same content for the same track: no need to fade anything. */
export function sameLyrics(a: Lyrics | null, b: Lyrics): boolean {
  return !!a && a.trackKey === b.trackKey && a.status === b.status && a.synced === b.synced && a.plain === b.plain;
}
