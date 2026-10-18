/**
 * Web Animations anchored to song time. Every animation the karaoke engine starts has a song time
 * for its local zero; this keeps all of them on the song as it plays, pauses, seeks and slews, so the
 * compositor runs the motion and the page only steps in at word boundaries:
 *
 * - playing: one anchor maps song time to the document timeline (start time = anchor + t0 - song);
 * - paused: every animation is paused at its song time (a seek while paused moves them there);
 * - a jump or a drift past a few ms (a seek, a resync snap, the end of a slew): re-anchored at once;
 * - a slew (the clock bending time toward a new sample): re-anchored every few ms while it lasts,
 *   so the caller keeps frames coming then (sync's `slewing`).
 */

export interface SongCue {
  /** song time, ms (offsets applied) */
  t: number;
  /** false while paused or stopped */
  running: boolean;
  /** song ms per wall ms right now: 1 playing, 0 paused, around 1 while the clock slews */
  rate?: number;
}

export interface SyncResult {
  /** the clock is bending time: keep painting so the anchor can follow */
  slewing: boolean;
  /** ms the animations were moved by (a seek, a snap); 0 when they stayed on their anchor */
  moved: number;
}

interface Entry {
  anim: Animation;
  /** song time of the animation's local 0 */
  t0: number;
  /** song time it ends at */
  end: number;
  /** what it belongs to, for cancelling one part of a scene */
  group: string;
}

/** Drift tolerated before re-anchoring, ms: below a frame, and above the jitter of reading two clocks. */
const DRIFT_MS = 8;
/** While slewing, re-anchor as soon as this much has built up. */
const SLEW_DRIFT_MS = 2;
/** A rate this far from 1 is a slew worth following. */
const SLEW_RATE = 0.02;

const perfNow = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

export class SongTimeline {
  private readonly live = new Set<Entry>();
  /** song time at document-timeline time `perf`, while playing */
  private anchor: { perf: number; song: number } | null = null;
  private running = false;
  private song = 0;

  /** The song time of the last sync. */
  get now(): number {
    return this.song;
  }

  get playing(): boolean {
    return this.running;
  }

  /** Number of animations it is keeping on the song (for tests and diagnostics). */
  get size(): number {
    return this.live.size;
  }

  /**
   * Brings every animation onto song time `cue.t`, as of `perf` (performance.now(), the document
   * timeline's clock). Call it first in every paint.
   */
  sync(cue: SongCue, perf = perfNow()): SyncResult {
    this.song = cue.t;
    const rate = cue.rate ?? (cue.running ? 1 : 0);
    if (!cue.running) {
      for (const e of this.live) pauseAt(e, cue.t);
      this.running = false;
      this.anchor = null;
      return { slewing: false, moved: 0 };
    }
    const slewing = Math.abs(rate - 1) > SLEW_RATE;
    if (!this.running || !this.anchor) {
      this.running = true;
      this.anchor = { perf, song: cue.t };
      for (const e of this.live) this.place(e);
      return { slewing, moved: 0 };
    }
    const expected = this.anchor.song + (perf - this.anchor.perf);
    const drift = cue.t - expected;
    if (Math.abs(drift) > (slewing ? SLEW_DRIFT_MS : DRIFT_MS)) {
      this.anchor = { perf, song: cue.t };
      for (const e of this.live) this.place(e);
      return { slewing, moved: drift };
    }
    return { slewing, moved: 0 };
  }

  /** Document-timeline time of song time `song` under the current anchor (null while paused). */
  perfOf(song: number): number | null {
    return this.anchor ? this.anchor.perf + (song - this.anchor.song) : null;
  }

  /**
   * Runs `frames` on `el` for `duration` ms with its local 0 at song time `t0`, kept on the song from
   * now on. Fills backwards: before t0 the element holds the first keyframe; after the end, its own style.
   */
  play(el: Element, frames: Keyframe[], t0: number, duration: number, group: string): Animation | null {
    if (typeof (el as HTMLElement).animate !== "function" || frames.length === 0 || !(duration > 0)) return null;
    const anim = (el as HTMLElement).animate(frames, { duration, fill: "backwards", easing: "linear" });
    const entry: Entry = { anim, t0, end: t0 + duration, group };
    this.live.add(entry);
    if (this.running && this.anchor) this.place(entry);
    else pauseAt(entry, this.song);
    return anim;
  }

  /** Forgets animations that ended before song time `t` (they no longer draw anything). */
  prune(t = this.song): void {
    for (const e of this.live) if (e.end < t) this.live.delete(e);
  }

  /** Cancels the animations of `group` (every group when omitted). */
  cancel(group?: string): void {
    for (const e of this.live) {
      if (group !== undefined && e.group !== group) continue;
      this.live.delete(e);
      try {
        e.anim.cancel();
      } catch {
        // already gone
      }
    }
  }

  /** Whether any animation of `group` is still running at song time `t`. */
  busy(group: string, t = this.song): boolean {
    for (const e of this.live) if (e.group === group && e.end > t) return true;
    return false;
  }

  private place(e: Entry): void {
    const start = this.perfOf(e.t0);
    if (start === null) return;
    try {
      // a resolved start time also resumes a paused animation
      e.anim.startTime = start;
    } catch {
      // an engine without settable start times keeps whatever it has
    }
  }
}

function pauseAt(e: Entry, song: number): void {
  try {
    if (typeof e.anim.pause === "function") e.anim.pause();
    e.anim.currentTime = song - e.t0;
  } catch {
    // ignore engines that can't hold an animation at a time
  }
}
