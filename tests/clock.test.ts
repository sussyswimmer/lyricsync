import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaybackClock, SLEW_MS, SNAP_MS, type ClockSample } from "../src/core/clock";

const T0 = 1_000_000;
const KEY = "demo artist|neon monsoon|undertone demo|35";

const sample = (over: Partial<ClockSample> = {}): ClockSample => ({
  trackKey: KEY,
  positionMs: 10_000,
  sampledAt: T0,
  isPlaying: true,
  ...over,
});

/** A clock playing from 10 000 ms at T0. */
function playing(): PlaybackClock {
  const clock = new PlaybackClock();
  clock.update(sample(), T0);
  return clock;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PlaybackClock basics", () => {
  it("reads 0 with no track", () => {
    const clock = new PlaybackClock();
    expect(clock.position(T0)).toBe(0);
    expect(clock.trackKey).toBeNull();
    expect(clock.isPlaying).toBe(false);
  });

  it("interpolates from sampledAt while playing", () => {
    const clock = new PlaybackClock();
    expect(clock.update(sample(), T0 + 50)).toBe("reset");
    expect(clock.position(T0 + 50)).toBe(10_050);
    expect(clock.position(T0 + 1050)).toBe(11_050);
    expect(clock.trackKey).toBe(KEY);
    expect(clock.isPlaying).toBe(true);
  });

  it("never extrapolates backwards from a sample stamped in the future", () => {
    expect(playing().position(T0 - 100)).toBe(10_000);
  });

  it("uses the wall clock by default", () => {
    vi.useFakeTimers({ now: T0 });
    const clock = new PlaybackClock();
    clock.update(sample());
    vi.setSystemTime(T0 + 500);
    expect(clock.position()).toBe(10_500);
  });

  it("clears on a null sample", () => {
    const clock = playing();
    expect(clock.update(null, T0 + 100)).toBe("reset");
    expect(clock.position(T0 + 100)).toBe(0);
    expect(clock.trackKey).toBeNull();
  });
});

describe("PlaybackClock pause and resume", () => {
  it("freezes while paused", () => {
    const clock = new PlaybackClock();
    clock.update(sample({ isPlaying: false }), T0);
    expect(clock.position(T0)).toBe(10_000);
    expect(clock.position(T0 + 60_000)).toBe(10_000);
    expect(clock.isPlaying).toBe(false);
  });

  it("holds the highlight where it is on pause and picks up smoothly on resume", () => {
    const clock = playing();
    // the player paused at 10 980; the event lands 40 ms after the clock passed that point
    expect(clock.update(sample({ positionMs: 10_980, sampledAt: T0 + 1000, isPlaying: false }), T0 + 1020)).toBe("slew");
    expect(clock.position(T0 + 1020)).toBe(11_020);
    expect(clock.position(T0 + 5000)).toBe(11_020);

    clock.update(sample({ positionMs: 10_980, sampledAt: T0 + 6000 }), T0 + 6000);
    expect(clock.position(T0 + 6000)).toBe(11_020);
    expect(clock.position(T0 + 6000 + SLEW_MS)).toBe(10_980 + SLEW_MS);
  });

  it("snaps a seek made while paused", () => {
    const clock = new PlaybackClock();
    clock.update(sample({ isPlaying: false }), T0);
    expect(clock.update(sample({ positionMs: 50_000, sampledAt: T0 + 2000, isPlaying: false }), T0 + 2000)).toBe("snap");
    expect(clock.position(T0 + 9000)).toBe(50_000);
  });
});

describe("PlaybackClock seek and slew", () => {
  it("snaps to a seek in either direction", () => {
    const clock = playing();
    expect(clock.update(sample({ positionMs: 60_000, sampledAt: T0 + 1000 }), T0 + 1000)).toBe("snap");
    expect(clock.position(T0 + 1000)).toBe(60_000);
    expect(clock.update(sample({ positionMs: 2000, sampledAt: T0 + 2000 }), T0 + 2000)).toBe("snap");
    expect(clock.position(T0 + 2100)).toBe(2100);
  });

  it("treats exactly 400 ms as drift and anything more as a seek", () => {
    expect(playing().update(sample({ positionMs: 11_000 + SNAP_MS, sampledAt: T0 + 1000 }), T0 + 1000)).toBe("slew");
    expect(playing().update(sample({ positionMs: 11_001 + SNAP_MS, sampledAt: T0 + 1000 }), T0 + 1000)).toBe("snap");
  });

  it("blends small drift in over 300 ms without a jump", () => {
    const clock = playing();
    // the clock shows 11 000 at T0+1000; the player says 11 200
    expect(clock.update(sample({ positionMs: 11_200, sampledAt: T0 + 1000 }), T0 + 1000)).toBe("slew");
    expect(clock.position(T0 + 1000)).toBe(11_000);
    expect(clock.position(T0 + 1150)).toBe(11_250);
    expect(clock.position(T0 + 1000 + SLEW_MS)).toBe(11_200 + SLEW_MS);
    expect(clock.position(T0 + 2000)).toBe(12_200);
  });

  it("slows down rather than running backwards when it is ahead", () => {
    const clock = playing();
    // 390 ms ahead: a 300 ms slew would run time backwards, so it stretches to 487.5 ms
    clock.update(sample({ positionMs: 10_610, sampledAt: T0 + 1000 }), T0 + 1000);
    let last = clock.position(T0 + 1000);
    for (let t = T0 + 1010; t <= T0 + 1600; t += 10) {
      const now = clock.position(t);
      expect(now).toBeGreaterThan(last);
      last = now;
    }
    expect(clock.position(T0 + 1488)).toBe(10_610 + 488);
  });

  it("chains corrections from wherever the last one left off", () => {
    const clock = playing();
    clock.update(sample({ positionMs: 11_200, sampledAt: T0 + 1000 }), T0 + 1000);
    const before = clock.position(T0 + 1100);
    clock.update(sample({ positionMs: 11_250, sampledAt: T0 + 1100 }), T0 + 1100);
    expect(clock.position(T0 + 1100)).toBe(before);
    expect(clock.position(T0 + 1100 + SLEW_MS)).toBe(11_250 + SLEW_MS);
  });

  it("ignores a sample older than the one it has", () => {
    const clock = playing();
    clock.update(sample({ positionMs: 11_000, sampledAt: T0 + 1000 }), T0 + 1000);
    expect(clock.update(sample({ positionMs: 90_000, sampledAt: T0 + 500 }), T0 + 1100)).toBe("ignored");
    expect(clock.position(T0 + 1100)).toBe(11_100);
  });
});

describe("PlaybackClock track changes and offsets", () => {
  it("resets on a new track instead of slewing", () => {
    const clock = playing();
    expect(clock.update(sample({ trackKey: "other", positionMs: 11_100, sampledAt: T0 + 1000 }), T0 + 1000)).toBe("reset");
    expect(clock.position(T0 + 1000)).toBe(11_100);
    expect(clock.trackKey).toBe("other");
  });

  it("adds the global offset and this track's offset", () => {
    const clock = playing();
    clock.setOffsets({ globalOffsetMs: 150, trackOffsetsMs: { [KEY]: -50, other: 999 } });
    expect(clock.position(T0)).toBe(10_100);

    clock.update(sample({ trackKey: "fresh", positionMs: 0, sampledAt: T0 }), T0);
    expect(clock.position(T0)).toBe(150);
  });

  it("applies offset changes immediately", () => {
    const clock = playing();
    clock.setOffsets({ globalOffsetMs: 0, trackOffsetsMs: { [KEY]: 100 } });
    expect(clock.position(T0 + 500)).toBe(10_600);
    clock.setOffsets({ globalOffsetMs: 0, trackOffsetsMs: {} });
    expect(clock.position(T0 + 500)).toBe(10_500);
  });
});
