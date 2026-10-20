import type { Line } from "../../core/lrc";
import type { Look } from "../look";

/** Where the song is, as the stage hands it to a mode each frame. */
export interface Cue {
  /** Index into the lyric lines (gaps removed) of the line in focus, or -1 for none (after the last line). */
  line: number;
  /** True while the focus line hasn't started yet (intro, instrumental gap): show it as upcoming, nothing sung. */
  waiting: boolean;
  /** Position in ms (clock time, offsets applied). */
  t: number;
  /**
   * False while playback is paused or stopped. No further frames follow such a paint until the next
   * event (a seek, play), so a mode must reach its resting frame in it: finish or skip any easing
   * that is driven by frames rather than by the compositor.
   */
  running: boolean;
  /**
   * Song ms per wall ms right now: 1 while playing, 0 paused, a little off 1 while the clock slews
   * toward a new sample.
   */
  rate?: number;
  /**
   * Where the clock is converging (its latest sample extrapolated, offsets applied, without the slew
   * blend); `t` when absent. Modes that hand motion to the compositor follow this one, by their
   * SongTimeline's re-anchor policy.
   */
  target?: number;
}

/**
 * A lyric style. The stage owns the host element, the clock and transitions between songs;
 * a mode only draws lines.
 *
 * - `build` creates DOM. It runs on new lyrics, a layout-affecting look change, or a resize. It may
 *   read layout (measure text) here, never in `paint`.
 * - `paint` runs on the frames the stage asks for and only mutates styles (use `put` from `../dom`
 *   so unchanged values aren't rewritten). Returns true while something moves independently of word
 *   timing (an easing in flight, a fisheye following progress); false lets the stage sleep until the
 *   next word boundary. Word states follow `wordState` from core/timing ([start, end) is active),
 *   the rule the stage schedules frames by.
 * - `restyle` (optional) takes a look whose shape didn't change (colors, glow and bloom; the motion's
 *   energy, snap and Effects) without rebuilding or measuring, and keeps any motion in flight. Modes
 *   without it are rebuilt.
 *
 * Every addition below is optional, so a mode that doesn't use one is unaffected.
 */
export interface ModeRenderer {
  /**
   * False when the mode draws word timing without the page's help (its motion is handed to the
   * compositor ahead of time): the stage then wakes only for line changes and `nextChange`, not at
   * every word's start and end. Default true.
   */
  readonly wordWakes?: boolean;
  build(host: HTMLElement, lines: readonly Line[], look: Look): void;
  paint(cue: Cue): boolean;
  restyle?(look: Look): void;
  /**
   * A clock sample that changed nothing the stage paints for (same line, still playing): bring the
   * mode's song-time motion onto it, without a frame. A mode whose own focus should change for it
   * says so through `nextChange` (0).
   */
  retime?(cue: Cue): void;
  /**
   * Song ms until the mode needs a paint that no word or line boundary brings (Infinity for none):
   * its own events, such as a line's lead, an instrumental break starting, or the end of a slew.
   * The stage wakes for the nearer of the two.
   */
  nextChange?(t: number): number;
  /**
   * Commits every running animation's current values to inline style and stops them, so a copy of
   * the scene shows what was on screen (the stage's crossfade clone).
   */
  freeze?(): void;
  destroy(): void;
  /**
   * True when the stage should crossfade the old line out as the focus line changes to `next`'s, for
   * a change the mode doesn't animate itself. Asked before the paint that shows `next`.
   */
  crossfades(next: Cue): boolean;
  /**
   * True when painting `cue` cuts the mode's own focus somewhere else without motion of its own while
   * the stage's line stays the same (a break's dots coming in under reduced motion): the stage
   * crossfades that too. Asked before the paint.
   */
  cuts?(cue: Cue): boolean;
}
