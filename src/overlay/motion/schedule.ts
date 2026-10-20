/**
 * When the view moves from line to line (SPEC §2.3). A line is in place for its first word: the view
 * moves to line i at max(the previous line's last word end, line i's start - LEAD_MS), so the list
 * starts its scroll (or Lens and Arc their glide) LEAD_MS before the line is sung, unless the line
 * before is still being sung then. A break's dots hand over to the next line at the same moment
 * (interlude.ts ends each break there).
 */
import type { Line } from "../../core/lrc";
import { interludeAt, type Interlude } from "./interlude";
import { LEAD_MS } from "./params";

export { LEAD_MS };

/** For each line, the song time the view moves to it (never after the line starts). */
export function leadTimes(lines: readonly Pick<Line, "start" | "end" | "words">[]): number[] {
  return lines.map((line, i) => {
    const early = line.start - LEAD_MS;
    const prev = lines[i - 1];
    if (!prev) return early;
    const sung = prev.words[prev.words.length - 1]?.end ?? prev.end;
    return Math.min(line.start, Math.max(sung, early));
  });
}

/** What the view shows at a cue: a line (waiting until it starts), or a break leading into one. */
export interface FocusAt {
  /** index of the line in focus (the one a break leads into), -1 for none (after the last line) */
  line: number;
  /** the line hasn't started yet */
  waiting: boolean;
  /** the break playing, if any */
  interlude: Interlude | null;
}

/**
 * The view's focus at `cue` (the stage's line, which changes at line starts): a break while one plays,
 * else the latest line whose lead has come. Without motion (reduced motion) the view changes with the
 * stage's line, which crossfades it, so there is no lead.
 */
export function focusAt(
  cue: { line: number; waiting: boolean; t: number },
  lines: readonly Pick<Line, "start">[],
  leads: readonly number[],
  interludes: readonly Interlude[],
  motion: boolean,
): FocusAt {
  const il = interludeAt(interludes, cue.t);
  if (il) return { line: il.next, waiting: true, interlude: il };
  if (cue.line < 0) return { line: -1, waiting: false, interlude: null };
  if (!motion) return { line: cue.line, waiting: cue.waiting, interlude: null };
  let line = cue.line;
  while (line + 1 < lines.length && (leads[line + 1] ?? Infinity) <= cue.t) line++;
  const waiting = line !== cue.line ? cue.t < (lines[line]?.start ?? Infinity) : cue.waiting;
  return { line, waiting, interlude: null };
}

/** Ms from `t` to the earliest of `times` after it (Infinity for none). */
export function untilNext(times: readonly number[], t: number): number {
  let next = Infinity;
  for (const at of times) if (at > t && at - t < next) next = at - t;
  return next;
}
