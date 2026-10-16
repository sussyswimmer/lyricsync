import type { NowPlaying, Settings } from "../../contract/contract";

/** The parts of a now-playing sample the clock reads. */
export type ClockSample = Pick<NowPlaying, "trackKey" | "positionMs" | "sampledAt" | "isPlaying">;
export type ClockOffsets = Pick<Settings, "globalOffsetMs" | "trackOffsetsMs">;
/** What a sample did to the clock: new track, jump, smooth correction, or dropped as stale. */
export type ClockUpdate = "reset" | "snap" | "slew" | "ignored";

/** A sample further than this from where the clock thinks it is counts as a seek: jump to it. */
export const SNAP_MS = 400;
/** Smaller disagreements are blended in over about this long, so the highlight never jitters. */
export const SLEW_MS = 300;
/** Most a slew may bend time (ms of correction per ms). Keeps the clock from ever running backwards. */
const MAX_SLEW_RATE = 0.8;

/**
 * Smooth, offset-corrected playback position between now-playing samples.
 * Times are epoch ms, the same clock as `NowPlaying.sampledAt`.
 * Positive offsets move the position forward, so lyrics show earlier.
 */
export class PlaybackClock {
  private sample: ClockSample | null = null;
  private offsets: ClockOffsets = { globalOffsetMs: 0, trackOffsetsMs: {} };
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
  }

  update(next: ClockSample | null, now: number = Date.now()): ClockUpdate {
    const prev = this.sample;
    if (next === null || prev === null || next.trackKey !== prev.trackKey) {
      this.sample = next;
      this.correction = 0;
      return "reset";
    }
    if (next.sampledAt < prev.sampledAt) return "ignored";

    const shown = this.base(now);
    this.sample = next;
    const error = this.raw(now) - shown;
    if (Math.abs(error) > SNAP_MS) {
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
    const { globalOffsetMs, trackOffsetsMs } = this.offsets;
    return this.base(now) + globalOffsetMs + (trackOffsetsMs[s.trackKey] ?? 0);
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
