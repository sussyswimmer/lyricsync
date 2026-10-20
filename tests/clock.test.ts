import { afterEach, describe, expect, it, vi } from "vitest";
import { PHASE_WINDOW, PlaybackClock, SLEW_MS, SNAP_MS, type ClockSample } from "../src/core/clock";

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

  it("blends a reading that disagrees in halfway, and all of it once the next one agrees, without a jump", () => {
    const clock = playing();
    // the clock shows 11 000 at T0+1000; the player says 11 200: the middle of the two readings is 11 100
    expect(clock.update(sample({ positionMs: 11_200, sampledAt: T0 + 1000 }), T0 + 1000)).toBe("slew");
    expect(clock.position(T0 + 1000)).toBe(11_000);
    expect(clock.position(T0 + 1150)).toBe(11_200);
    expect(clock.position(T0 + 1000 + SLEW_MS)).toBe(11_100 + SLEW_MS);
    // a second reading 200 ms ahead: the song moved (a stall), followed at once
    expect(clock.update(sample({ positionMs: 12_200, sampledAt: T0 + 2000 }), T0 + 2000)).toBe("slew");
    expect(clock.position(T0 + 2000)).toBe(12_100);
    expect(clock.position(T0 + 2150)).toBe(12_300);
    expect(clock.position(T0 + 2000 + SLEW_MS)).toBe(12_200 + SLEW_MS);
  });

  it("slows down rather than running backwards when it is behind", () => {
    // paused at 10 000; it resumes at 9 610, 390 ms behind: a 300 ms slew would run time backwards,
    // so it stretches to 487.5 ms
    const clock = new PlaybackClock();
    clock.update(sample({ isPlaying: false }), T0);
    clock.update(sample({ positionMs: 9610, sampledAt: T0 + 1000 }), T0 + 1000);
    let last = clock.position(T0 + 1000);
    expect(last).toBe(10_000);
    for (let t = T0 + 1010; t <= T0 + 1600; t += 10) {
      const now = clock.position(t);
      expect(now).toBeGreaterThan(last);
      last = now;
    }
    expect(clock.position(T0 + 1488)).toBe(9610 + 488);
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

describe("PlaybackClock rate", () => {
  it("is 0 paused or with no track, 1 playing", () => {
    expect(new PlaybackClock().rate(T0)).toBe(0);
    const paused = new PlaybackClock();
    paused.update(sample({ isPlaying: false }), T0);
    expect(paused.rate(T0 + 500)).toBe(0);
    expect(playing().rate(T0 + 500)).toBe(1);
  });

  it("bends while a slew blends a correction in, as fast as the position actually moves, then is 1 again", () => {
    const clock = playing();
    // a reading 60 ms ahead of where the clock thinks the song is: the middle of the two is 30 ms ahead
    expect(clock.update(sample({ positionMs: 11_060, sampledAt: T0 + 1000 }), T0 + 1000)).toBe("slew");
    const rate = clock.rate(T0 + 1100);
    expect(rate).toBeCloseTo(1 + 30 / SLEW_MS, 9);
    expect(clock.position(T0 + 1200) - clock.position(T0 + 1100)).toBeCloseTo(100 * rate, 6);
    expect(clock.rate(T0 + 1000 + SLEW_MS)).toBe(1);
    // a sample that agrees exactly bends nothing
    clock.update(sample({ positionMs: clock.position(T0 + 2000), sampledAt: T0 + 2000 }), T0 + 2000);
    expect(clock.rate(T0 + 2050)).toBe(1);
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
    clock.setOffsets({ globalOffsetMs: 150, trackOffsetsMs: { [KEY]: -50, other: 999 }, nudgedTracks: [] });
    expect(clock.position(T0)).toBe(10_100);

    clock.update(sample({ trackKey: "fresh", positionMs: 0, sampledAt: T0 }), T0);
    expect(clock.position(T0)).toBe(150);
  });

  it("gives a song without its own offset the learned one, and one with its own (even 0) that", () => {
    const clock = playing();
    // two other songs nudged +100 and +200: of two, the one nearer 0
    clock.setOffsets({ globalOffsetMs: 50, trackOffsetsMs: { x: 100, y: 200 }, nudgedTracks: ["x", "y"] });
    expect(clock.position(T0)).toBe(10_150);
    expect(clock.target(T0)).toBe(10_150);
    clock.setOffsets({ globalOffsetMs: 50, trackOffsetsMs: { x: 100, y: 200, [KEY]: 0 }, nudgedTracks: ["x", "y", KEY] });
    expect(clock.position(T0)).toBe(10_050);
  });

  it("applies offset changes immediately", () => {
    const clock = playing();
    clock.setOffsets({ globalOffsetMs: 0, trackOffsetsMs: { [KEY]: 100 }, nudgedTracks: [] });
    expect(clock.position(T0 + 500)).toBe(10_600);
    clock.setOffsets({ globalOffsetMs: 0, trackOffsetsMs: {}, nudgedTracks: [] });
    expect(clock.position(T0 + 500)).toBe(10_500);
  });
});

describe("PlaybackClock target", () => {
  it("is where the position is converging: the latest sample extrapolated, without the slew still blending in", () => {
    const clock = playing();
    expect(clock.target(T0 + 500)).toBe(10_500);
    // a reading 120 ms ahead of the shown position, so the two agree on 60 ms ahead: the position slews
    // there, the target is there at once
    clock.update(sample({ positionMs: 11_120, sampledAt: T0 + 1000 }), T0 + 1000);
    expect(clock.target(T0 + 1000)).toBe(11_060);
    expect(clock.position(T0 + 1000)).toBe(11_000);
    expect(clock.target(T0 + 1100)).toBe(11_160);
    // once the correction has run out the two agree
    expect(clock.position(T0 + 1000 + SLEW_MS)).toBeCloseTo(clock.target(T0 + 1000 + SLEW_MS), 9);
  });

  it("holds still while paused, takes the offsets, and is 0 with no track", () => {
    const clock = new PlaybackClock();
    expect(clock.target(T0)).toBe(0);
    clock.update(sample({ isPlaying: false }), T0);
    expect(clock.target(T0 + 5000)).toBe(10_000);
    clock.setOffsets({ globalOffsetMs: 100, trackOffsetsMs: { [KEY]: -30 }, nudgedTracks: [] });
    expect(clock.target(T0 + 5000)).toBe(10_070);
    expect(clock.target(T0 + 5000)).toBe(clock.position(T0 + 5000));
  });
});

describe("PlaybackClock readings that disagree a little", () => {
  /** Feeds one reading a second whose phase (ms ahead of the true song) is each of `errors` in turn. */
  const feed = (clock: PlaybackClock, errors: readonly number[], from = 1): number => {
    let t = T0;
    errors.forEach((e, i) => {
      t = T0 + (from + i) * 1000;
      clock.update(sample({ positionMs: 10_000 + (t - T0) + e, sampledAt: t }), t);
    });
    return t;
  };

  it("follows the middle of the last readings, not each one", () => {
    const clock = playing();
    const t = feed(clock, [80, -60, 40, -20, 70, -50]);
    // the last five: 80 is gone; -60, 40, -20, 70, -50 → -20
    expect(clock.target(t)).toBe(10_000 + (t - T0) - 20);
    expect(PHASE_WINDOW).toBe(5);
  });

  it("keeps a single wild reading from moving it", () => {
    const clock = playing();
    const t = feed(clock, [0, 0, 0, 300]);
    expect(clock.target(t)).toBe(10_000 + (t - T0));
  });

  it("counts a reading sent again once", () => {
    const clock = playing();
    const at = T0 + 1000;
    const again = sample({ positionMs: 11_100, sampledAt: at });
    // three copies of one reading 100 ms ahead would outvote the first; once, it is the middle of two
    for (let i = 0; i < 3; i++) expect(clock.update(again, at + i * 1000)).toBe("slew");
    expect(clock.target(at)).toBe(11_050);
  });

  it("starts over after a pause, from the first reading once it plays again", () => {
    const clock = playing();
    feed(clock, [0, 0, 0]);
    clock.update(sample({ positionMs: 13_000, sampledAt: T0 + 3000, isPlaying: false }), T0 + 3000);
    clock.update(sample({ positionMs: 13_050, sampledAt: T0 + 9000 }), T0 + 9000);
    expect(clock.target(T0 + 9000)).toBe(13_050);
  });

  it("starts over after a seek", () => {
    const clock = playing();
    feed(clock, [0, 0, 0]);
    expect(clock.update(sample({ positionMs: 60_000, sampledAt: T0 + 4000 }), T0 + 4000)).toBe("snap");
    // the readings before the seek have no say: one 100 ms later is the middle of two
    clock.update(sample({ positionMs: 61_100, sampledAt: T0 + 5000 }), T0 + 5000);
    expect(clock.target(T0 + 5000)).toBe(61_050);
  });
});
