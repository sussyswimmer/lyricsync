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
}

/**
 * A lyric style. The stage owns the host element, the clock and transitions between songs;
 * a mode only draws lines.
 *
 * - `build` creates DOM. It runs on new lyrics, a settings or palette change, or a resize. It may
 *   read layout (measure text) here, never in `paint`.
 * - `paint` runs every frame and only mutates styles (use `put` from `../dom` so unchanged values
 *   aren't rewritten). Returns true while something moves independently of word timing (an easing
 *   in flight, a fisheye following progress); false lets the stage sleep until the next word boundary.
 */
export interface ModeRenderer {
  build(host: HTMLElement, lines: readonly Line[], look: Look): void;
  paint(cue: Cue): boolean;
  destroy(): void;
  /** True when the stage should crossfade the old line out as the focus line changes (modes that redraw per line). */
  readonly crossfadeLines: boolean;
}
