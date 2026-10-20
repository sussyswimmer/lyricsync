import type { NowPlaying, Settings } from "../../contract/contract";
import { learnedOffsetMs } from "./sync";

/** The parts of a now-playing sample the clock reads. */
export type ClockSample = Pick<NowPlaying, "trackKey" | "positionMs" | "sampledAt" | "isPlaying">;
export type ClockOffsets = Pick<Settings, "globalOffsetMs" | "trackOffsetsMs" | "nudgedTracks">;
/** What a sample did to the clock: new track, jump, smooth correction, or dropped as stale. */
export type ClockUpdate = "reset" | "snap" | "slew" | "ignored";

/** A sample further than this from where the clock thinks it is counts as a seek: jump to it. */
export const SNAP_MS = 400;
/** Smaller disagreements are blended in over about this long, so the highlight never jitters. */
export const SLEW_MS = 300;
/** Most a slew may bend time (ms of correction per ms). Keeps the clock from ever running backwards. */
const MAX_SLEW_RATE = 0.8;
/**
 * While playing, where the song is comes from the last few readings together: each says how far the
 * song is ahead of the wall clock (its phase), and the clock follows the middle one of these. A
 * player's reading is a little early or late each time (how long it took to answer, a busy moment),
 * and following each one in turn made the words run a touch fast, then slow, a second at a time.
 */
export const PHASE_WINDOW = 5;
/**
 * The song itself moved (a stall while it buffered) when the newest two readings agree with each
 * other this closely, ms...
 */
const PHASE_AGREE_MS = 40;
/** ...and both sit this far from what the readings before them said: it follows them at once. */
const PHASE_SHIFT_MS = 120;

/** The middle value (the mean of the middle two for an even count). */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Smooth, offset-corrected playback position between now-playing samples.
 * Times are epoch ms, the same clock as `NowPlaying.sampledAt`.
 * Positive offsets move the position forward, so lyrics show earlier.
 */
export class PlaybackClock {
  /** The latest reading with its position taken from the readings' agreed phase (`phases`) while playing. */
  private sample: ClockSample | null = null;
  /** The latest reading as it came, to tell a new one from the same one sent again. */
  private latest: ClockSample | null = null;
  /** Phases (position minus read time) of the distinct readings since the song last started, moved or stopped, oldest first. */
  private phases: number[] = [];
  private offsets: ClockOffsets = { globalOffsetMs: 0, trackOffsetsMs: {}, nudgedTracks: [] };
  /** What a song without its own offset starts from (sync.ts), worked out once per change. */
  private learned = 0;
  /** Shown position minus the sample's own estimate when the correction began. Decays to 0 while playing. */
  private correction = 0;
  private correctionAt = 0;
  private correctionMs = SLEW_MS;

  get trackKey(): string | null {
    return this.sample?.trackKey ?? null;
  }

  get isPlaying(): boolean {
    return this.sample?.isPlaying ?? false;
  }

  setOffsets(offsets: ClockOffsets): void {
    this.offsets = offsets;
    this.learned = learnedOffsetMs(offsets);
  }

  /** All songs plus this song's own offset, or the learned one. */
  private offsetOf(trackKey: string): number {
    const own = this.offsets.trackOffsetsMs[trackKey];
    return this.offsets.globalOffsetMs + (typeof own === "number" && Number.isFinite(own) ? own : this.learned);
  }

  update(next: ClockSample | null, now: number = Date.now()): ClockUpdate {
    const prev = this.latest;
    if (next === null || prev === null || next.trackKey !== prev.trackKey) {
      this.latest = next;
      this.phases = next?.isPlaying ? [next.positionMs - next.sampledAt] : [];
      this.sample = next;
      this.correction = 0;
      return "reset";
    }
    if (next.sampledAt < prev.sampledAt) return "ignored";

    const shown = this.base(now);
    this.latest = next;
    this.sample = this.agreed(next, prev);
    const error = this.raw(now) - shown;
    if (Math.abs(error) > SNAP_MS) {
      this.phases = next.isPlaying ? [next.positionMs - next.sampledAt] : [];
      this.sample = next;
      this.correction = 0;
      return "snap";
    }
    // Start from where the highlight is and converge on the sample. While paused this holds still.
    this.correction = -error;
    this.correctionAt = now;
    this.correctionMs = Math.max(SLEW_MS, Math.abs(error) / MAX_SLEW_RATE);
    return "slew";
  }

  /** Position in ms with the global and per-track offsets applied; 0 with no track. */
  position(now: number = Date.now()): number {
    const s = this.sample;
    if (s === null) return 0;
    return this.base(now) + this.offsetOf(s.trackKey);
  }

  /**
   * Where `position` is converging at `now`: the latest sample extrapolated, offsets applied, without
   * the slew still blending in. Equal to `position` once a correction has run out (and after a snap).
   * Time-anchored animations follow this one and make their own, smoother corrections.
   */
  target(now: number = Date.now()): number {
    const s = this.sample;
    if (s === null) return 0;
    return this.raw(now) + this.offsetOf(s.trackKey);
  }

  /**
   * How fast `position` runs at `now`, in song ms per wall ms: 0 while paused or stopped, 1 while
   * playing, and a little off 1 while a slew is blending a correction in (constant through the slew,
   * so time-anchored animations can follow it exactly).
   */
  rate(now: number = Date.now()): number {
    const s = this.sample;
    if (s === null || !s.isPlaying || now < s.sampledAt) return 0;
    const elapsed = now - this.correctionAt;
    if (this.correction === 0 || elapsed < 0 || elapsed >= this.correctionMs) return 1;
    return 1 - this.correction / this.correctionMs;
  }

  /**
   * `next` with its position from the phase the recent readings agree on, while playing. A pause,
   * a resume or a jump past SNAP_MS starts the readings over; the same reading sent again (the core
   * repeats the last one every second) is counted once.
   */
  private agreed(next: ClockSample, prev: ClockSample): ClockSample {
    if (!next.isPlaying) {
      this.phases = [];
      return next;
    }
    const phase = next.positionMs - next.sampledAt;
    const fresh = next.sampledAt !== prev.sampledAt || next.positionMs !== prev.positionMs;
    if (!prev.isPlaying || this.phases.length === 0 || Math.abs(phase - median(this.phases)) > SNAP_MS) {
      this.phases = [phase];
    } else if (fresh) {
      this.phases.push(phase);
      if (this.phases.length > PHASE_WINDOW) this.phases.shift();
      const n = this.phases.length;
      if (n >= 3) {
        const [a, b] = this.phases.slice(-2) as [number, number];
        const before = median(this.phases.slice(0, -2));
        if (Math.abs(a - b) <= PHASE_AGREE_MS && Math.abs(a - before) > PHASE_SHIFT_MS && Math.abs(b - before) > PHASE_SHIFT_MS) {
          this.phases = [a, b];
        }
      }
    }
    return { ...next, positionMs: next.sampledAt + median(this.phases) };
  }

  /** The latest sample extrapolated to `now`. */
  private raw(now: number): number {
    const s = this.sample;
    if (s === null) return 0;
    return s.positionMs + (s.isPlaying ? Math.max(0, now - s.sampledAt) : 0);
  }

  /** `raw` plus whatever correction is still unwound. Frozen while paused. */
  private base(now: number): number {
    const left = this.isPlaying ? 1 - (now - this.correctionAt) / this.correctionMs : 1;
    return this.raw(now) + this.correction * Math.min(1, Math.max(0, left));
  }
}
