/**
 * Web Animations anchored to song time. Every animation the karaoke engine starts has a song time for
 * its local zero; this keeps all of them on the song as it plays, pauses, seeks and drifts, so the
 * compositor runs the motion and the page only steps in when something changes:
 *
 * - playing: one anchor maps song time to the document timeline (start time = anchor + t0 - song);
 * - paused: every animation is paused at its song time (a seek while paused moves them there);
 * - a clock sample that disagrees with where the animations are is followed by one decision, never
 *   per frame (SPEC §2.7). drift = where the clock is converging (`cue.target`) minus where the
 *   timeline will be once any correction in flight is done:
 *     |drift| <= DEAD_ZONE_MS   nothing: below a frame, above the jitter of reading two clocks;
 *     |drift| <= JUMP_MS        a playback-rate slew: every animation runs at 1 + drift/D for D ms
 *                               (D = max(300, |drift| / 0.8)), then back at 1 (nextWake says when);
 *     further, a seek, a resume re-anchored at once.
 */
import { forget } from "../dom";

export interface SongCue {
  /** song time, ms (offsets applied): what the clock shows */
  t: number;
  /** false while paused or stopped */
  running: boolean;
  /** song ms per wall ms right now: 1 playing, 0 paused, around 1 while the clock slews */
  rate?: number;
  /** where the clock is converging (its latest sample, without the slew blend); `t` when absent */
  target?: number;
}

export interface SyncResult {
  /** ms the animations jumped by (a seek, a resume elsewhere, a correction past JUMP_MS); 0 otherwise */
  moved: number;
  /** a playback-rate slew is in flight: nextWake says when it ends */
  slewing: boolean;
}

interface Entry {
  anim: Animation;
  el: Element;
  /** song time of the animation's local 0 */
  t0: number;
  /** song time it ends at */
  end: number;
  /** what it belongs to, for cancelling one part of a scene */
  group: string;
}

/** Disagreement left alone, ms. */
export const DEAD_ZONE_MS = 30;
/** Disagreement past which the animations jump instead of slewing, ms. */
export const JUMP_MS = 400;
/** A slew takes at least this long... */
export const SLEW_MIN_MS = 300;
/** ...and bends song time by at most this much per ms, so animations never run backwards. */
export const SLEW_MAX_RATE = 0.8;

const perfNow = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

export class SongTimeline {
  private readonly live = new Set<Entry>();
  /** song time at document-timeline time `perf`, while playing; the animations run at `rate` from there */
  private anchor: { perf: number; song: number } | null = null;
  private rate = 1;
  /** document-timeline time the playback-rate slew ends (rate back to 1) */
  private slewEnd = 0;
  private running = false;
  private song = 0;

  /** The song time of the last sync. */
  get now(): number {
    return this.song;
  }

  get playing(): boolean {
    return this.running;
  }

  /** The playback rate every animation runs at: 1, or a slew's. */
  get playbackRate(): number {
    return this.rate;
  }

  /** Number of animations it is keeping on the song (for tests and diagnostics). */
  get size(): number {
    return this.live.size;
  }

  /** Where the animations are on the song at `perf` (the last sync's time while paused). */
  position(perf = perfNow()): number {
    const a = this.anchor;
    return a ? a.song + (perf - a.perf) * this.rate : this.song;
  }

  /** Where they will be once the slew in flight is done, extrapolated to `perf`. */
  private planned(perf: number): number {
    const left = this.rate !== 1 ? Math.max(0, this.slewEnd - perf) * (this.rate - 1) : 0;
    return this.position(perf) + left;
  }

  /**
   * Brings every animation onto the song, as of `perf` (performance.now(), the document timeline's
   * clock): one decision per clock sample (see the top of this file). Calling it again with a cue that
   * agrees with the anchor costs nothing.
   */
  sync(cue: SongCue, perf = perfNow()): SyncResult {
    this.song = cue.t;
    if (!cue.running) {
      for (const e of this.live) pauseAt(e, cue.t);
      this.running = false;
      this.anchor = null;
      this.rate = 1;
      this.slewEnd = 0;
      return { moved: 0, slewing: false };
    }
    const target = Number.isFinite(cue.target) ? (cue.target as number) : cue.t;
    if (!this.running || !this.anchor) {
      // starting, or resuming: anchored at once
      this.running = true;
      this.reanchor(perf, target);
      return { moved: 0, slewing: false };
    }
    if (this.rate !== 1 && perf >= this.slewEnd) {
      // the slew has run its course: rate 1 from where the animations are now (a late wake overshot a
      // little; whatever that left is judged below like any other disagreement)
      this.anchor = { perf, song: this.position(perf) };
      this.rate = 1;
      this.slewEnd = 0;
      for (const e of this.live) setRate(e.anim, 1);
    }
    const drift = target - this.planned(perf);
    if (Math.abs(drift) <= DEAD_ZONE_MS) return { moved: 0, slewing: this.rate !== 1 };
    if (Math.abs(drift) > JUMP_MS) {
      const moved = target - this.position(perf);
      this.reanchor(perf, target);
      return { moved, slewing: false };
    }
    // a slew: from where the animations are, gain the whole correction still owed over D
    const at = this.position(perf);
    const owed = target - at;
    const span = Math.max(SLEW_MIN_MS, Math.abs(owed) / SLEW_MAX_RATE);
    this.anchor = { perf, song: at };
    this.rate = 1 + owed / span;
    this.slewEnd = perf + span;
    for (const e of this.live) setRate(e.anim, this.rate);
    return { moved: 0, slewing: true };
  }

  /** Ms (document timeline) until the slew in flight ends and a sync should put the rate back; Infinity without one. */
  nextWake(perf = perfNow()): number {
    return this.rate !== 1 && this.running ? Math.max(0, this.slewEnd - perf) : Infinity;
  }

  /** Document-timeline time of song time `song` under the current anchor (null while paused). */
  perfOf(song: number): number | null {
    const a = this.anchor;
    return a ? a.perf + (song - a.song) / this.rate : null;
  }

  /**
   * Runs `frames` on `el` for `duration` ms with its local 0 at song time `t0`, kept on the song from
   * now on. Fills backwards: before t0 the element holds the first keyframe; after the end, its own style.
   */
  play(el: Element, frames: Keyframe[], t0: number, duration: number, group: string): Animation | null {
    if (typeof (el as HTMLElement).animate !== "function" || frames.length === 0 || !(duration > 0)) return null;
    const anim = (el as HTMLElement).animate(frames, { duration, fill: "backwards", easing: "linear" });
    const entry: Entry = { anim, el, t0, end: t0 + duration, group };
    this.live.add(entry);
    if (this.running && this.anchor) this.place(entry, perfNow());
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

  /**
   * Stops the animations of `group` (every group when omitted) where they are: each commits what it
   * draws right now to its element's inline style, then is cancelled. A copy of the page made next
   * (the stage's crossfade) shows exactly what was on screen.
   */
  freeze(group?: string): void {
    for (const e of this.live) {
      if (group !== undefined && e.group !== group) continue;
      this.live.delete(e);
      commit(e.anim, e.el);
    }
  }

  /** Whether any animation of `group` is still running at song time `t`. */
  busy(group: string, t = this.song): boolean {
    for (const e of this.live) if (e.group === group && e.end > t) return true;
    return false;
  }

  private reanchor(perf: number, song: number): void {
    this.anchor = { perf, song };
    this.rate = 1;
    this.slewEnd = 0;
    for (const e of this.live) this.place(e, perf);
  }

  private place(e: Entry, perf: number): void {
    const a = this.anchor;
    if (!a) return;
    const song = a.song + (perf - a.perf) * this.rate;
    try {
      e.anim.playbackRate = this.rate;
      // a resolved start time also resumes a paused animation
      e.anim.startTime = perf - (song - e.t0) / this.rate;
    } catch {
      // an engine without settable start times keeps whatever it has
    }
  }
}

/** Commits `anim`'s current values to `el`'s inline style and cancels it (a target that isn't rendered commits nothing). */
export function commit(anim: Animation, el: Element): void {
  try {
    anim.commitStyles();
  } catch {
    // not rendered (detached, display: none): nothing on screen to keep
  }
  try {
    anim.cancel();
  } catch {
    // already gone
  }
  // the inline style changed behind put()'s back
  forget(el);
}

/** A rate change that keeps the current time (the engine applies it at its next frame). */
function setRate(anim: Animation, rate: number): void {
  try {
    if (typeof anim.updatePlaybackRate === "function") anim.updatePlaybackRate(rate);
    else anim.playbackRate = rate;
  } catch {
    // keep the old rate
  }
}

function pauseAt(e: Entry, song: number): void {
  try {
    if (typeof e.anim.pause === "function") e.anim.pause();
    e.anim.playbackRate = 1;
    e.anim.currentTime = song - e.t0;
  } catch {
    // ignore engines that can't hold an animation at a time
  }
}
