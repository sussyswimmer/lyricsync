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
}

/**
 * A lyric style. The stage owns the host element, the clock and transitions between songs;
 * a mode only draws lines.
 *
 * - `build` creates DOM. It runs on new lyrics, a layout-affecting settings change, or a resize. It
 *   may read layout (measure text) here, never in `paint`.
 * - `paint` runs every frame and only mutates styles (use `put` from `../dom` so unchanged values
 *   aren't rewritten). Returns true while something moves independently of word timing (an easing
 *   in flight, a fisheye following progress); false lets the stage sleep until the next word boundary.
 *   Word states follow `wordState` from core/timing ([start, end) is active), the rule the stage
 *   schedules frames by.
 * - `restyle` (optional) takes new colors or glow when nothing else changed, without rebuilding or
 *   measuring, and keeps any motion in flight. Modes without it are rebuilt.
 */
export interface ModeRenderer {
  build(host: HTMLElement, lines: readonly Line[], look: Look): void;
  paint(cue: Cue): boolean;
  restyle?(look: Look): void;
  destroy(): void;
  /** True when the stage should crossfade the old line out as the focus line changes (modes that redraw per line). */
  readonly crossfadeLines: boolean;
}
