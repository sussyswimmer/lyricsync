import type { Settings } from "../../contract/contract";

/**
 * Learned sync. A song you nudge keeps its own offset (`trackOffsetsMs`); every other song starts
 * from what the songs you nudged last have in common, so a correction you keep making for every
 * song (headphones that play late, a player that reports early) is made once. `settings.rs` does
 * the same for the tray and the shortcuts: keep the two in step.
 */
export type SyncSettings = Pick<Settings, "trackOffsetsMs" | "nudgedTracks">;

/** How many of the most recently nudged songs the learned offset looks at. */
export const NUDGED_TRACKS_MAX = 9;

/**
 * The offset a song without its own starts from: the middle of the recently nudged songs' own
 * offsets, from two songs on (one song's lyrics may just be timed badly). With an even number,
 * the middle value nearer 0 (0 when the two are equally near), so one odd song never pulls the
 * rest further than the songs agree.
 */
export function learnedOffsetMs(s: SyncSettings): number {
  const values = (Array.isArray(s.nudgedTracks) ? s.nudgedTracks : [])
    .map((key) => s.trackOffsetsMs[key])
    .filter((ms): ms is number => typeof ms === "number" && Number.isFinite(ms))
    .sort((a, b) => a - b);
  const n = values.length;
  if (n < 2) return 0;
  const hi = values[n >> 1] as number;
  if (n % 2 === 1) return hi;
  const lo = values[(n >> 1) - 1] as number;
  if (Math.abs(lo) < Math.abs(hi)) return lo;
  if (Math.abs(hi) < Math.abs(lo)) return hi;
  return lo === hi ? lo : 0;
}

/** Whether the song has an offset of its own (0 included). */
export function hasOwnOffset(s: SyncSettings, trackKey: string): boolean {
  const ms = s.trackOffsetsMs[trackKey];
  return typeof ms === "number" && Number.isFinite(ms);
}

/** The song's sync on top of All songs: its own offset, or the learned one. */
export function songOffsetMs(s: SyncSettings, trackKey: string): number {
  return hasOwnOffset(s, trackKey) ? (s.trackOffsetsMs[trackKey] as number) : learnedOffsetMs(s);
}

/** The recently nudged songs once `trackKey` is nudged: it moves to the end, the oldest past the limit drop off. */
export function nudgedAfter(nudged: readonly string[], trackKey: string): string[] {
  return [...nudged.filter((key) => key !== trackKey), trackKey].slice(-NUDGED_TRACKS_MAX);
}
