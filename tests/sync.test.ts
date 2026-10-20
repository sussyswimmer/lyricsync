import { describe, expect, it } from "vitest";
import { hasOwnOffset, learnedOffsetMs, NUDGED_TRACKS_MAX, nudgedAfter, songOffsetMs, type SyncSettings } from "../src/core/sync";

/** Settings after nudging each song in turn to its offset, as `set_track_offset` leaves them. */
function nudged(offsets: [string, number][]): SyncSettings {
  return offsets.reduce<SyncSettings>(
    (s, [key, ms]) => ({ trackOffsetsMs: { ...s.trackOffsetsMs, [key]: ms }, nudgedTracks: nudgedAfter(s.nudgedTracks, key) }),
    { trackOffsetsMs: {}, nudgedTracks: [] },
  );
}

// The same cases as settings.rs `songs_without_their_own_offset_learn_it_from_the_last_nudged`.
describe("learned sync", () => {
  it("waits for two songs: one song's lyrics may just be timed badly", () => {
    expect(learnedOffsetMs(nudged([]))).toBe(0);
    expect(learnedOffsetMs(nudged([["a", 300]]))).toBe(0);
  });

  it("takes the middle of three, and of two the one nearer 0, or 0 when they are equally near", () => {
    expect(learnedOffsetMs(nudged([["a", 100], ["b", 400], ["c", 150]]))).toBe(150);
    expect(learnedOffsetMs(nudged([["a", 100], ["b", 400]]))).toBe(100);
    expect(learnedOffsetMs(nudged([["a", -250], ["b", -100]]))).toBe(-100);
    expect(learnedOffsetMs(nudged([["a", -100], ["b", 100]]))).toBe(0);
    expect(learnedOffsetMs(nudged([["a", 50], ["b", 50]]))).toBe(50);
  });

  it("counts only the newest nine songs, each once", () => {
    const old = Array.from({ length: 9 }, (_, i): [string, number] => [`old${i}`, -500]);
    const recent = Array.from({ length: 9 }, (_, i): [string, number] => [`new${i}`, 100]);
    const s = nudged([...old, ...recent]);
    expect(s.nudgedTracks).toHaveLength(NUDGED_TRACKS_MAX);
    expect(learnedOffsetMs(s)).toBe(100);
    // nudging a song again moves it to the end without counting it twice
    expect(nudgedAfter(["a", "b", "c"], "a")).toEqual(["b", "c", "a"]);
  });

  it("gives a song its own offset when it has one (0 included), else the learned one", () => {
    const s = nudged([["a", 100], ["b", 200], ["c", 150], ["zero", 0]]);
    expect(songOffsetMs(s, "b")).toBe(200);
    expect(songOffsetMs(s, "zero")).toBe(0);
    expect(hasOwnOffset(s, "zero")).toBe(true);
    // a, b, c and zero: of 100 and 150, the one nearer 0
    expect(songOffsetMs(s, "fresh")).toBe(100);
    expect(hasOwnOffset(s, "fresh")).toBe(false);
  });

  it("ignores songs listed without an offset, and offsets of songs not listed", () => {
    const s: SyncSettings = { trackOffsetsMs: { a: 100, b: 100, outside: -900 }, nudgedTracks: ["a", "gone", "b"] };
    expect(learnedOffsetMs(s)).toBe(100);
    expect(songOffsetMs(s, "outside")).toBe(-900);
    // settings from a core older than contract v7
    expect(learnedOffsetMs({ trackOffsetsMs: { a: 100 } } as unknown as SyncSettings)).toBe(0);
  });
});
