import type { Lyrics } from "../../contract/contract";
import { parseLrc } from "../core/lrc";
import { pacePlain } from "../core/timing";
import type { StageView } from "./stage";

/** What the stage should show for a lyrics result. Synced LRC wins; plain text paces evenly. */
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
        if (lines.some((l) => l.words.length > 0)) return { kind: "lyrics", timeline: { lines, unsynced: false } };
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
