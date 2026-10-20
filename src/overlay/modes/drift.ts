import type { LineDecor } from "../../core/flair";
import type { Line } from "../../core/lrc";
import { h, put } from "../dom";
import { MIN_TEXT_PX, rgba, snap, textShadow, type Look } from "../look";
import { paintVars } from "../motion/bloom";
import { clamp01 } from "../motion/curve";
import { picturesOf, songDecor } from "../motion/decor";
import { InterludeDots } from "../motion/dots";
import { findInterludes, type Interlude } from "../motion/interlude";
import { compositorSteps, HOLD, holds, keyframesAt, num, SAMPLE_MS, thin } from "../motion/keyframes";
import { casedLines } from "../motion/letters";
import { KaraokeLine, nextFrame, SLICE_MS } from "../motion/line";
import {
  BLUR_STEPS,
  CALM_SCROLL_SPRING,
  DOTS,
  DRIFT_BLUR_EM,
  DRIFT_NEIGHBOR_SCALE,
  DRIFT_PERSPECTIVE_EM,
  DRIFT_RECEDE_EM,
  DRIFT_TILT_DEG,
  LEAVE_MS,
  LITE_FADE_STEPS,
  LITE_SCROLL_MS,
  LineMoves,
  MAX_GLIDE_LINES,
  motionParams,
  paramsKey,
  REACH,
  SCROLL_SPRING,
  STACK_BLUR_EM,
  STACK_NEIGHBOR_SCALE,
  SUNG_LEVEL,
  UPCOMING_LEVEL,
  type MotionParams,
} from "../motion/params";
import { focusAt, leadTimes, untilNext } from "../motion/schedule";
import { playWall, WallGlide } from "../motion/scroll";
import { commit, SongTimeline } from "../motion/timeline";
import { warmPictures } from "../pictures";
import type { Cue, ModeRenderer } from "./types";

/** Line box height in font sizes (`.drift-row` in styles/stage.css). */
const LINE_HEIGHT = 1.12;
/** Distance between the centers of two one-row lines, in font sizes, from the prototype. */
const PITCH = 1.15;
/** Neighbors stay no smaller than MIN_TEXT_PX on screen, as long as that takes at most this share. */
const NEIGHBOR_MAX_SCALE = 0.85;
/** Least room between the focus line and a one-row neighbor, in font sizes, however large neighbors get. */
const MIN_GAP = 0.265;
/** A wrapped line taller than this share of the stage is set smaller so it fits. */
const MAX_ROW_SHARE = 0.45;
/** An instrumental break's slot (the dots) is this tall, in font sizes. */
const BREAK_EM = 1.05;
/** A jump of the song further than this while playing is a seek: the focus line's words are put straight. */
const SEEK_MS = 250;
/** ...and while paused (or pausing), any move further than this. */
const PAUSED_SEEK_MS = 50;
/** The next line is prepared from this long after a line change, once that change's frames are out... */
const PREPARE_DELAY_MS = 600;
/** ...in idle slices this far apart. */
const PREPARE_GAP_MS = 40;
/**
 * After a line change, the line leaving focus stops still and the rows that only step their distance
 * blur are restyled, this many per frame (each repaints and re-rasters its row).
 */
const JOBS_PER_FRAME = 3;
/** The scroll's keyframes are thinned to this much of a px of position and of opacity, and of scale. */
const SCROLL_THIN = { y: 0.25, opacity: 0.004, scale: 0.002 };
/**
 * Wall-time animations this close to their end (ms) have all but arrived: the scroll is well under a
 * pixel from rest, a fade all but transparent. They are dropped then, in a frame that has other work
 * (the line that left focus handing back, then being taken down), rather than left to end by
 * themselves: Chromium spends frames of their own on animations ending.
 */
export const RELEASE_MS = 60;
/**
 * The line leaving focus hands back to its plain text this long after the change at the earliest (ms),
 * clear of the change's busiest frames, and fades out over this long at the least.
 */
const HAND_BACK_MIN_MS = 200;
const FADE_MIN_MS = 300;
/** A frame this close to a hand-back's time (ms) takes it rather than waking again for it. */
const HAND_BACK_SLACK_MS = 24;

/** A line that left focus (song times). */
interface Leaving {
  line: KaraokeLine;
  row: Row;
  at: number;
  /** sung through as it left: it stops still (once) before it hands back */
  sung: boolean;
  /** when it hands back to its plain text, its overlay fading out... */
  handBack: number;
  /** ...and when it is taken down, in the frame that lets go of the list's scroll at rest */
  until: number;
  handed: boolean;
}

interface Row {
  el: HTMLDivElement;
  /** the `.kw` box of each word */
  words: HTMLElement[];
  /**
   * each word's plain text (`.kw-txt`): a row's state colors and blurs these, not the row, so that a
   * restyle recalculates a span per word rather than every copy in the karaoke overlay beneath
   */
  txts: HTMLElement[];
  /** the line as drawn: in the look's case */
  line: Line;
  index: number;
  /** font size, px: the look's, or less for a line that would wrap taller than the stage allows */
  size: number;
  /** measured box height at full scale, px */
  box: number;
  /** slot height: the box, at least one line tall */
  height: number;
  /** last applied state, so a focus change restyles only the rows it touches */
  state: string;
}

interface Break {
  el: HTMLDivElement;
  il: Interlude;
  dots: InterludeDots | null;
  /** song time its dots' motion ends */
  until: number;
}

type Slot = { kind: "line"; row: Row } | { kind: "break"; brk: Break };

/** A slot's place in the stack for the layout: its height, and whether it folds away when out of focus. */
export interface SlotSpec {
  height: number;
  collapsible: boolean;
}

/** Where a slot lands: px from the focus position, and its signed distance from the focus in lines. */
export interface Placed {
  at: number;
  off: number;
}

/**
 * One slot's style with the list at some scroll position, as numbers: transformOf writes it out, for
 * the keyframes a scroll keeps only.
 */
interface SlotStyle {
  opacity: number;
  off: number;
  y: number;
  scale: number;
  /** Drift's depth (px, toward the back) and tilt (deg); 0 in Stack */
  z: number;
  tilt: number;
}

/** A slot's transform: flat for Stack, with Drift's depth and tilt. */
function transformOf(s: SlotStyle, depth: number): string {
  return depth > 0
    ? `translate3d(0px, ${num(s.y, 2)}px, ${num(s.z, 1)}px) rotateX(${num(s.tilt, 2)}deg) scale(${num(s.scale, 4)})`
    : `translate(0px, ${num(s.y, 2)}px) scale(${num(s.scale, 4)})`;
}

const perfNow = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

/**
 * Scale of the lines around the focus: `base` (Drift's neighbors by default), raised at small sizes so
 * they still draw MIN_TEXT_PX tall once Drift's depth has pushed them back.
 */
export function neighborScale(size: number, depth: number, base = DRIFT_NEIGHBOR_SCALE): number {
  const recede = DRIFT_PERSPECTIVE_EM / (DRIFT_PERSPECTIVE_EM + DRIFT_RECEDE_EM * depth);
  return Math.min(Math.max(NEIGHBOR_MAX_SCALE, base), Math.max(base, MIN_TEXT_PX / (size * recede)));
}

/**
 * Each line's slot, per px of its box height: PITCH for one row, widened when neighbors are larger
 * than Drift's so a one-row neighbor still keeps MIN_GAP from a one-row focus line. A line never
 * draws taller than its slot, so lines never overlap, however many rows they wrap to.
 */
export function slotPerPx(low: number): number {
  return Math.max(PITCH, (LINE_HEIGHT / 2) * (1 + low) + MIN_GAP) / LINE_HEIGHT;
}

/** How much a line `dist` lines from the focus shrinks on screen from Drift's depth (1 for Stack). */
export function projection(dist: number, depth: number): number {
  return DRIFT_PERSPECTIVE_EM / (DRIFT_PERSPECTIVE_EM + DRIFT_RECEDE_EM * depth * dist);
}

/**
 * Where each slot's center lands on screen, in px from the focus position, with the song scrolled to
 * `shown` (a fractional slot index while moving). Slots stack one after another, each its height
 * times `perPx`, shrunk by its own depth projection, so slots further back sit closer together the
 * way a receding surface does, and none ever overlaps another. A collapsible slot (an instrumental
 * break) only takes room as the focus nears it: it opens as the song scrolls onto it and folds away
 * as it scrolls on, and distances are counted as if folded slots weren't there. Only slots within
 * `reach` lines get a place.
 */
export function placeSlots(slots: readonly SlotSpec[], shown: number, depth: number, perPx: number, reach = REACH): Map<number, Placed> {
  const out = new Map<number, Placed>();
  const n = slots.length;
  if (n === 0) return out;
  const lo = Math.max(0, Math.min(n - 1, Math.floor(shown)));
  const frac = Math.max(0, Math.min(1, shown - lo));
  // only slots near the focus can be in reach (each one is at least a line, folded breaks aside)
  const span = Math.ceil(reach) * 2 + 4;
  const first = Math.max(0, lo - span);
  const last = Math.min(n - 1, lo + span + 1);
  const presence = (i: number): number => (slots[i]?.collapsible ? clamp01(1 - Math.abs(shown - i)) : 1);
  const center = new Map<number, number>([[first, 0]]);
  for (let i = first + 1; i <= last; i++) center.set(i, (center.get(i - 1) ?? 0) + (presence(i - 1) + presence(i)) / 2);
  const cLo = center.get(lo) ?? 0;
  const focus = cLo + ((center.get(lo + 1) ?? cLo) - cLo) * frac;
  const dist = (i: number): number => Math.abs((center.get(i) ?? 0) - focus);
  const size = (i: number): number => (slots[i]?.height ?? 0) * presence(i) * perPx * projection(dist(i), depth);
  const at = new Map<number, number>([[lo, 0]]);
  for (let i = lo + 1; i <= last; i++) at.set(i, (at.get(i - 1) ?? 0) + (size(i - 1) + size(i)) / 2);
  for (let i = lo - 1; i >= first; i--) at.set(i, (at.get(i + 1) ?? 0) - (size(i) + size(i + 1)) / 2);
  const shift = (at.get(lo + 1) ?? 0) * frac;
  for (let i = first; i <= last; i++) {
    const off = (center.get(i) ?? 0) - focus;
    if (Math.abs(off) > reach || (slots[i]?.collapsible && presence(i) <= 0)) continue;
    out.set(i, { at: (at.get(i) ?? 0) - shift, off });
  }
  return out;
}

/**
 * Where each line's center lands on screen, in px from the focus position, with the song scrolled to
 * `shown`: placeSlots for lines alone (none of them folds away).
 */
export function stackOffsets(heights: readonly number[], shown: number, depth: number, perPx: number): Map<number, number> {
  const placed = placeSlots(
    heights.map((height) => ({ height, collapsible: false })),
    shown,
    depth,
    perPx,
  );
  return new Map([...placed].map(([i, p]) => [i, p.at]));
}

/**
 * Untimed lyrics (`calm`, paced by guesswork): the line in focus is only a guess, so the lines next to
 * it are nearly as bright...
 */
export const CALM_NEAR_LEVEL = 0.82;
/** ...and those this many lines from it are drawn sharp, in the lyric color, so they read as easily. */
export const CALM_SHARP_LINES = 2;

/**
 * Brightness of a line `off` lines from the focus (negative: already sung). `calm` (untimed lyrics):
 * neighbors stay readable, fading out gently toward REACH, so whichever line is really being sung
 * reads well even when the guess is a line or two off.
 */
export function lineLevel(off: number, calm = false): number {
  const d = Math.abs(off);
  if (d >= REACH) return 0;
  if (calm) {
    if (d <= 1) return 1 - (1 - CALM_NEAR_LEVEL) * d;
    return CALM_NEAR_LEVEL * (1 - ((d - 1) / (REACH - 1)) ** 1.6);
  }
  const near = off < 0 ? SUNG_LEVEL : UPCOMING_LEVEL;
  if (d <= 1) return 1 - (1 - near) * d;
  return near * (1 - (d - 1) / (REACH - 1));
}

/** Blur steps for a line `off` lines from the focus. */
function blurStep(off: number): number {
  return Math.min(BLUR_STEPS, Math.max(1, Math.round(Math.abs(off))));
}

/**
 * Drift: the song as a vertical list that springs to each line just before it is sung, neighbors
 * receding in 3D. Stack is the same list flat (`depth` 0), its neighbors nearly full size. Lines
 * around the focus are dimmer and softer the further away they are; the focus line sings karaoke
 * (motion/line.ts); long instrumental breaks show three filling dots where the next line will be.
 *
 * Everything moves on the compositor. The karaoke and the dots are planned as keyframes when they
 * begin and kept on song time by a SongTimeline; the scroll is a WallGlide on the document timeline,
 * started from what is on screen. The page sleeps between line changes: paint never asks for frames,
 * and nextChange names the moments it must be woken for.
 */
export class DriftMode implements ModeRenderer {
  /** Nothing happens at a word boundary that the compositor isn't already drawing: sleep through them. */
  readonly wordWakes = false;
  private readonly depth: number;
  private readonly timeline = new SongTimeline();
  /** slow motion steps on the song-time beat where the engine composites stepped keyframes */
  private readonly steps = compositorSteps();
  private look: Look | null = null;
  private params: MotionParams | null = null;
  private motionKey = "";
  private box: HTMLDivElement | null = null;
  /** the lyric lines, in the look's case */
  private lines: Line[] = [];
  /** each line's flair (Effects mode), by line index */
  private decor: LineDecor[] = [];
  private readonly moves = new LineMoves();
  private rows: Row[] = [];
  private breaks: Break[] = [];
  private slots: Slot[] = [];
  private specs: SlotSpec[] = [];
  private slotOfLine: number[] = [];
  private interludes: Interlude[] = [];
  /** when the view moves to each line (schedule.ts) */
  private leads: number[] = [];
  /** the slot in focus, -1 before the first paint */
  private target = -1;
  /** the scroll (slot units) on the document timeline, and its animations in flight */
  private glide: WallGlide | null = null;
  private scrolls: { el: HTMLElement; anim: Animation }[] = [];
  /** document-timeline time the scroll's animations end at (0: none in flight) */
  private scrollEnd = 0;
  /** slots shown (visible, layered) right now */
  private readonly shown = new Set<number>();
  private karaoke: { line: KaraokeLine; row: Row } | null = null;
  /** the next line's overlay and plans, made ahead in idle slices */
  private prepared: { line: KaraokeLine; row: Row } | null = null;
  private prepareTimer: ReturnType<typeof setTimeout> | null = null;
  /** lines that left focus at song time `at`: lit until `handBack`, then fading until `until` */
  private leaving: Leaving[] = [];
  private lastT = Number.NaN;
  private lastPerf = 0;
  private lastRunning = false;
  /** a retime moved the song onto another focus: paint at once (nextChange 0) */
  private dirty = false;
  /** freeze() stopped everything in place: the next paint sets it going again */
  private frozen = false;
  /** destroy() ran (and no build since): anything still scheduled does nothing */
  private destroyed = false;
  /** what a line change left for the frames after it (restate's `spread`), and the frame that runs it */
  private later: (() => void)[] = [];
  private cancelLater: (() => void) | null = null;

  constructor(depth: number) {
    this.depth = depth;
  }

  /**
   * The stage crossfades the cut under reduced motion; while paused (a glide while paused would show
   * a line the song isn't at); and on a jump further than MAX_GLIDE_LINES lines (a seek, a repeated
   * song starting over). Not when the song ends: the stack fades out by itself.
   */
  crossfades(next: Cue): boolean {
    const look = this.look;
    if (!look) return false;
    if (!look.motion || !next.running) return true;
    if (next.line < 0 || this.target < 0) return false;
    return Math.abs(this.lineOfSlot(this.focusSlot(next)) - this.focusLine()) > MAX_GLIDE_LINES;
  }

  /** The list cuts to a break or a line within the stage's line (reduced motion, paused, far): crossfade it. */
  cuts(cue: Cue): boolean {
    const look = this.look;
    if (!look || this.target < 0 || cue.line < 0) return false;
    const focus = this.focusSlot(cue);
    if (focus === this.target) return false;
    return !look.motion || !cue.running || Math.abs(this.lineOfSlot(focus) - this.focusLine()) > MAX_GLIDE_LINES;
  }

  build(host: HTMLElement, lines: readonly Line[], look: Look): void {
    this.destroy();
    this.destroyed = false;
    this.look = look;
    this.params = motionParams(look);
    this.motionKey = paramsKey(this.params);
    host.textContent = "";
    const box = h("div", "drift");
    box.style.fontFamily = look.font;
    box.style.fontWeight = String(look.weight);
    box.style.fontSize = `${look.size}px`;
    if (look.letterSpacing !== 0) box.style.letterSpacing = `${num(look.letterSpacing, 3)}em`;
    box.style.perspective = `${look.size * DRIFT_PERSPECTIVE_EM}px`;
    // Recede toward the focus line, in the middle of the stage: with the vanishing point elsewhere,
    // lines on the far side of it would fold back over the focus line.
    box.style.perspectiveOrigin = `50% ${look.y.toFixed(1)}px`;
    if (look.unsynced) box.classList.add("is-calm");
    const sung = casedLines(lines, look.textCase);
    this.lines = sung;
    this.decor = songDecor(sung, look);
    warmPictures(picturesOf(this.decor));
    this.interludes = look.unsynced ? [] : findInterludes(sung);
    this.leads = leadTimes(sung);
    this.rows = sung.map((line, index) => {
      const el = h("div", "drift-row kw-host");
      el.dir = "auto";
      el.style.top = `${look.y}px`;
      const words: HTMLElement[] = [];
      const txts: HTMLElement[] = [];
      for (const w of line.words) {
        const text = w.text.trimEnd();
        const word = h("span", "kw");
        // No transform of its own out of focus: an identity transform on every word box made the
        // compositor draw about one more render pass every frame (letters, under their animated
        // word box, do rest on an identity transform; see line.ts restStyle).
        const txt = h("span", "kw-txt", text);
        word.append(txt);
        el.append(word);
        // the space between words sits outside the word boxes, where line breaking can use it
        if (text !== w.text) el.append(h("span", "", " "));
        words.push(word);
        txts.push(txt);
      }
      put(el, "visibility", "hidden");
      box.append(el);
      return { el, words, txts, line, index, size: look.size, box: 0, height: 0, state: "" };
    });
    this.breaks = this.interludes.map((il) => {
      const el = h("div", "drift-break");
      el.style.top = `${look.y}px`;
      el.style.height = `${(BREAK_EM * look.size).toFixed(2)}px`;
      put(el, "visibility", "hidden");
      box.append(el);
      return { el, il, dots: null, until: 0 };
    });
    // slots in song order: each break just before the line it leads into
    this.slots = [];
    this.slotOfLine = [];
    let b = 0;
    this.rows.forEach((row, i) => {
      while (b < this.breaks.length && (this.breaks[b]?.il.next ?? Infinity) <= i) {
        const brk = this.breaks[b++];
        if (brk) this.slots.push({ kind: "break", brk });
      }
      this.slotOfLine[i] = this.slots.length;
      this.slots.push({ kind: "line", row });
    });
    host.append(box);
    this.box = box;
    this.measure(look);
    this.restyle(look);
    this.target = -1;
    this.lastT = Number.NaN;
  }

  /**
   * A look whose shape didn't change. Colors, glow and bloom only update the CSS variables; a change
   * of the motion's energy, snap or Effects plans the focus line again at the current time, and the
   * next line again ahead.
   */
  restyle(look: Look): void {
    this.look = look;
    const box = this.box;
    if (!box) return;
    this.flushLater();
    paintVars(box, look, look.size);
    for (const row of this.rows) if (row.size !== look.size) paintVars(row.el, look, row.size);
    box.style.color = look.colors.dim;
    box.style.textShadow = textShadow(look, look.size);
    for (const row of this.rows) {
      const state = row.state;
      row.state = "";
      if (state) this.styleRow(row, state);
    }
    const params = motionParams(look);
    const key = paramsKey(params);
    if (key === this.motionKey) return;
    this.params = params;
    this.motionKey = key;
    this.replan(look);
  }

  paint(cue: Cue): boolean {
    const look = this.look;
    const box = this.box;
    if (!look || !box) return false;
    const perf = perfNow();
    this.sync(cue, perf);
    const jumped = this.jumped(cue, perf);
    this.dirty = false;
    put(box, "opacity", cue.line < 0 ? "0" : "1");
    if (cue.line < 0) return false;
    const focus = this.focusSlot(cue);
    if (focus !== this.target) {
      this.moveTo(focus, cue, look);
    } else {
      if (this.frozen) this.resume(look);
      if (jumped || this.frozen) this.refreshFocus(cue, look);
    }
    this.frozen = false;
    this.tidy(cue);
    this.timeline.prune(cue.t);
    return false;
  }

  /** A clock sample between paints: the timeline follows it; a seek within the line re-lights it. */
  retime(cue: Cue): void {
    const look = this.look;
    if (!look || !this.box) return;
    const perf = perfNow();
    this.sync(cue, perf);
    const jumped = this.jumped(cue, perf);
    if (cue.line < 0) return;
    if (this.focusSlot(cue) !== this.target) {
      this.dirty = true;
      return;
    }
    if (jumped) this.refreshFocus(cue, look);
  }

  /**
   * Song ms until this mode needs a paint no line boundary brings: the next line's lead, a break
   * starting or ending, a leaving overlay to drop, the end of a playback-rate slew; 0 when a retime
   * moved the song onto another focus.
   */
  nextChange(t: number): number {
    if (this.dirty) return 0;
    let next = this.timeline.nextWake();
    if (this.look?.motion !== false) next = Math.min(next, untilNext(this.leads, t));
    for (const il of this.interludes) {
      if (il.start > t) next = Math.min(next, il.start - t);
      if (il.end > t) next = Math.min(next, il.end - t);
    }
    for (const l of this.leaving) next = Math.min(next, Math.max(0, (l.handed ? l.until : l.handBack) - t));
    return next;
  }

  /** Commits everything moving to inline style and stops it (before the stage copies the scene). */
  freeze(): void {
    this.flushLater();
    this.karaoke?.line.freeze();
    for (const l of this.leaving) l.line.freeze();
    this.timeline.freeze();
    for (const s of this.scrolls) commit(s.anim, s.el);
    this.scrolls = [];
    this.scrollEnd = 0;
    this.frozen = true;
  }

  /** Stops everything and removes the DOM; every timer it set is cleared, and one already due does nothing. */
  destroy(): void {
    this.destroyed = true;
    this.timeline.cancel();
    if (this.prepareTimer) clearTimeout(this.prepareTimer);
    this.prepareTimer = null;
    this.cancelLater?.();
    this.cancelLater = null;
    this.later = [];
    this.prepared?.line.destroy();
    this.prepared = null;
    this.karaoke?.line.destroy();
    this.karaoke = null;
    for (const l of this.leaving) l.line.destroy();
    this.leaving = [];
    for (const brk of this.breaks) brk.dots?.stop();
    this.cancelScrolls();
    this.glide = null;
    this.shown.clear();
    this.box?.remove();
    this.box = null;
    this.rows = [];
    this.breaks = [];
    this.slots = [];
    this.specs = [];
    this.lines = [];
    this.decor = [];
    this.leads = [];
  }

  private sync(cue: Cue, perf: number): void {
    this.timeline.sync({ t: cue.t, running: cue.running, rate: cue.rate ?? (cue.running ? 1 : 0), target: cue.target ?? cue.t }, perf);
  }

  /** Whether the song moved since the last paint or retime by more than playing explains: a seek. */
  private jumped(cue: Cue, perf: number): boolean {
    const last = this.lastT;
    const expected = this.lastRunning ? last + (perf - this.lastPerf) : last;
    const both = cue.running && this.lastRunning;
    this.lastT = cue.t;
    this.lastPerf = perf;
    this.lastRunning = cue.running;
    if (Number.isNaN(last)) return false;
    return Math.abs(cue.t - expected) > (both ? SEEK_MS : PAUSED_SEEK_MS);
  }

  private lineOfSlot(i: number): number {
    const slot = this.slots[i];
    if (!slot) return -1;
    return slot.kind === "line" ? slot.row.index : slot.brk.il.next;
  }

  /** The lyric line the list is on (a break counts as the line it leads into). */
  private focusLine(): number {
    return this.lineOfSlot(this.target);
  }

  /** The slot to bring into focus at `cue`: a break while one plays, else the line whose lead has come. */
  private focusSlot(cue: Pick<Cue, "line" | "waiting" | "t">): number {
    const f = focusAt(cue, this.lines, this.leads, this.interludes, this.look?.motion !== false);
    if (f.interlude) {
      const il = f.interlude;
      const at = this.slots.findIndex((s) => s.kind === "break" && s.brk.il === il);
      if (at >= 0) return at;
    }
    return f.line >= 0 ? (this.slotOfLine[f.line] ?? -1) : -1;
  }

  /**
   * Measures every row in one layout pass, never per frame. A line that wraps taller than
   * MAX_ROW_SHARE of the stage gets a smaller font (wrapped height grows about with the square of
   * the size), checked once more after the change.
   */
  private measure(look: Look): void {
    const limit = look.height * MAX_ROW_SHARE;
    let heights = this.rows.map((row) => row.el.offsetHeight);
    for (let pass = 0; pass < 2 && limit > 0; pass++) {
      let changed = false;
      this.rows.forEach((row, i) => {
        const height = heights[i] ?? 0;
        if (height <= limit) return;
        row.size = Math.max(1, row.size * Math.sqrt(limit / height));
        row.el.style.fontSize = `${row.size.toFixed(2)}px`;
        changed = true;
      });
      if (!changed) break;
      heights = this.rows.map((row) => row.el.offsetHeight);
    }
    this.rows.forEach((row, i) => {
      row.box = heights[i] ?? 0;
      row.height = Math.max(row.box, row.size * LINE_HEIGHT);
    });
    this.specs = this.slots.map((s) =>
      s.kind === "line" ? { height: s.row.height, collapsible: false } : { height: BREAK_EM * look.size, collapsible: true },
    );
  }

  private low(look: Look): number {
    return neighborScale(look.size, this.depth, this.depth > 0 ? DRIFT_NEIGHBOR_SCALE : STACK_NEIGHBOR_SCALE);
  }

  /**
   * Every slot's style with the list scrolled to `shown`, for the slots within reach. The focus line
   * is centered on look.y, the middle of the stage, so even the tallest one (MAX_ROW_SHARE) fits.
   */
  private layout(shown: number, look: Look): Map<number, SlotStyle> {
    const depth = this.depth;
    const low = this.low(look);
    const placed = placeSlots(this.specs, shown, depth, slotPerPx(low));
    const zUnit = look.size * DRIFT_RECEDE_EM * depth;
    const out = new Map<number, SlotStyle>();
    for (const [i, p] of placed) {
      const slot = this.slots[i];
      if (!slot) continue;
      const dist = Math.abs(p.off);
      const scale = 1 - Math.min(dist, 1) * (1 - low);
      const box = slot.kind === "line" ? slot.row.box || slot.row.height : BREAK_EM * look.size;
      // `at` is where the slot should appear; the perspective (its origin on look.y) pulls a slot
      // `dist` lines back toward look.y by projection(dist), so place it that much further out.
      const y = snap(p.at, look.dpr) / projection(dist, depth) - box / 2;
      out.set(i, {
        opacity: slot.kind === "line" ? lineLevel(p.off, look.unsynced) : 1,
        off: p.off,
        y,
        scale,
        z: -dist * zUnit,
        tilt: -p.off * DRIFT_TILT_DEG * depth,
      });
    }
    return out;
  }

  private elOf(slot: Slot): HTMLDivElement {
    return slot.kind === "line" ? slot.row.el : slot.brk.el;
  }

  /** A slot in reach: drawn, on its own compositor layer. */
  private reveal(i: number, el: HTMLElement): void {
    this.shown.add(i);
    put(el, "visibility", "visible");
    put(el, "will-change", "transform, opacity");
  }

  /** A slot out of reach: not drawn, no layer. */
  private conceal(i: number, el: HTMLElement): void {
    this.shown.delete(i);
    put(el, "visibility", "hidden");
    put(el, "will-change", "auto");
  }

  /** Brings slot `focus` into focus: springs the list there (or cuts), and hands the karaoke over. */
  private moveTo(focus: number, cue: Cue, look: Look): void {
    const from = this.target;
    const fromLine = this.focusLine();
    this.target = focus;
    const glide = look.motion && cue.running && from >= 0 && Math.abs(this.lineOfSlot(focus) - fromLine) <= MAX_GLIDE_LINES;
    if (glide) this.scroll(look);
    else this.cut(look);
    this.restate(cue, glide);
  }

  /** The list at rest on the focus slot: every slot's own style, nothing animated. */
  private settle(look: Look): void {
    const layout = this.layout(this.target, look);
    this.slots.forEach((slot, i) => {
      const el = this.elOf(slot);
      const at = layout.get(i);
      if (!at) {
        this.conceal(i, el);
        return;
      }
      this.reveal(i, el);
      put(el, "transform", transformOf(at, this.depth));
      put(el, "opacity", num(at.opacity, 3));
    });
  }

  /** A cut to the focus slot: the scroll stops where it is headed. */
  private cut(look: Look): void {
    this.cancelScrolls();
    const spec = look.unsynced ? CALM_SCROLL_SPRING : SCROLL_SPRING;
    if (this.glide) this.glide.cut(this.target);
    else this.glide = new WallGlide(this.target, spec);
    this.settle(look);
  }

  /** After freeze(): a scroll caught in flight carries on from where it stopped, else the list rests. */
  private resume(look: Look): void {
    if (this.glide?.moving()) this.scroll(look);
    else this.settle(look);
  }

  private cancelScrolls(): void {
    for (const s of this.scrolls) {
      try {
        s.anim.cancel();
      } catch {
        // already gone
      }
    }
    this.scrolls = [];
    this.scrollEnd = 0;
  }

  /**
   * Drops the scroll's animations once it has come to rest (RELEASE_MS from their end, or a frame
   * later): every slot already carries its final style inline.
   */
  private releaseScrolls(): void {
    if (this.scrolls.length > 0 && perfNow() >= this.scrollEnd - 2 * RELEASE_MS) this.cancelScrolls();
  }

  /**
   * The scroll as keyframes on the document timeline: the spring released from the position and
   * velocity on screen right now toward the focus slot, sampled to rest, every slot it moves laid out
   * at each sample. Slots end on the same style settle() gives them.
   */
  private scroll(look: Look): void {
    const now = perfNow();
    const spec = look.unsynced ? CALM_SCROLL_SPRING : SCROLL_SPRING;
    this.glide ??= new WallGlide(this.target, spec, now);
    this.glide.to(this.target, now, spec);
    this.cancelScrolls();
    // the lite tier holds each place for a 30th of a second (LITE_SCROLL_MS), every row on the same beat
    const hold = look.power === "lite" && this.steps;
    const s = this.glide.samples(hold ? LITE_SCROLL_MS : SAMPLE_MS);
    const frames = s.xs.map((x) => this.layout(x, look));
    const final = this.layout(this.target, look);
    this.slots.forEach((slot, i) => {
      const el = this.elOf(slot);
      const seen = final.has(i) || frames.some((f) => f.has(i));
      if (!seen) {
        this.conceal(i, el);
        return;
      }
      this.reveal(i, el);
      const end = final.get(i);
      put(el, "opacity", num(end?.opacity ?? 0, 3));
      if (end) put(el, "transform", transformOf(end, this.depth));
      // where a slot is out of reach at a sample, it holds its nearest known place at no opacity
      let last = end ?? frames.find((f) => f.has(i))?.get(i) ?? null;
      const styles = new Array<SlotStyle | null>(s.times.length);
      for (let k = s.times.length - 1; k >= 0; k--) {
        const at = frames[k]?.get(i);
        if (at) last = at;
        styles[k] = last;
      }
      const opacity = frames.map((f) => f.get(i)?.opacity ?? 0);
      const ys = styles.map((st) => st?.y ?? 0);
      const scales = styles.map((st) => st?.scale ?? 1);
      const tolerance = [SCROLL_THIN.y, SCROLL_THIN.opacity, SCROLL_THIN.scale];
      const keep = hold ? holds([ys, opacity, scales], tolerance) : thin(s.times, [ys, opacity, scales], tolerance);
      const depth = this.depth;
      const anim = playWall(el, {
        frames: keyframesAt(s.times, keep, (k) => {
          const st = styles[k];
          const f: Keyframe = { transform: st ? transformOf(st, depth) : "none", opacity: num(opacity[k] ?? 0, 3) };
          if (hold) f.easing = HOLD;
          return f;
        }),
        duration: s.duration,
        startTime: s.startTime,
      });
      if (anim) this.scrolls.push({ el, anim });
    });
    this.scrollEnd = s.startTime + s.duration;
  }

  /**
   * Row states around the new focus, the karaoke handed to the focus line, the break's dots started.
   * `spread` (a glide while playing): this frame restyles only the new focus; the line leaving it
   * stops still, then the rows that only step their distance blur (nearest first) follow on the next
   * frames, JOBS_PER_FRAME at a time, while the list is moving anyway, and the line leaving hands back
   * to its plain text as the new one starts (tidy, handBack). Each of them repaints and re-rasters its
   * row, and all at once, on top of the scroll and the karaoke's handover, made the frame that starts a
   * line change the longest of the song.
   */
  private restate(cue: Cue, spread = false): void {
    const look = this.look;
    if (!look) return;
    const focusSlot = this.slots[this.target];
    const focusRow = focusSlot?.kind === "line" ? focusSlot.row : null;
    const layout = this.layout(this.target, look);
    // what a glide leaves for the frames after this one, in order: the line leaving focus stopping
    // still, then the rows that only step their blur, nearest first
    this.flushLater();
    const later: { job: () => void; dist: number }[] = [];
    // The line leaving focus keeps its overlay, lit, as the list scrolls (the scroll dims the row).
    // Sung through (the usual way out) it stops still first, in the first frame the change leaves
    // free; as the new line starts (a frame there is anyway) it hands back to its plain text, its
    // overlay fading out until the list comes to rest, and is taken down in the frame that lets go of
    // the scroll (tidy, handBack). Without a glide it hands back now, at once.
    let leavingRow: Row | null = null;
    if (this.karaoke && this.karaoke.row !== focusRow) {
      const { line, row } = this.karaoke;
      leavingRow = row;
      const rest = spread ? Math.max(LEAVE_MS, this.scrollEnd - RELEASE_MS - perfNow()) : 0;
      const start = focusSlot?.kind === "line" ? focusSlot.row.line.start : focusSlot?.kind === "break" ? focusSlot.brk.il.start : cue.t;
      const handBack = spread ? Math.min(Math.max(start, cue.t + HAND_BACK_MIN_MS), cue.t + rest - FADE_MIN_MS) : cue.t;
      const leaving: Leaving = { line, row, at: cue.t, sung: cue.t >= line.sungBy, handBack, until: cue.t + rest, handed: false };
      this.leaving.push(leaving);
      this.karaoke = null;
      if (spread && leaving.sung) later.push({ job: () => this.stopLeaving(leaving), dist: -1 });
    }
    this.slots.forEach((slot) => {
      if (slot.kind !== "line" || slot.row === leavingRow) return;
      const row = slot.row;
      const state = this.stateOf(row, layout, focusRow);
      // the focus line, and a row never styled yet (coming into reach), change now
      if (!spread || row === focusRow || row.state === "") this.styleRow(row, state);
      else if (row.state !== state) later.push({ job: () => this.styleRow(row, state), dist: this.distOf(row, layout) });
    });
    this.queueLater(later.sort((a, b) => a.dist - b.dist).map((l) => l.job));
    if (focusRow && !look.unsynced && (!this.karaoke || this.karaoke.row !== focusRow)) {
      // a line coming back while still fading out takes its overlay back
      const back = this.leaving.findIndex((l) => l.row === focusRow);
      if (back >= 0) this.leaving.splice(back, 1)[0]?.line.destroy();
      const ready = this.prepared?.row === focusRow ? this.prepared.line : null;
      if (!ready) this.prepared?.line.destroy();
      this.prepared = null;
      const line = ready ?? this.karaokeFor(focusRow, look);
      focusRow.el.classList.add("has-fx");
      this.karaoke = { line, row: focusRow };
      line.mount(cue.t, cue.running);
    }
    if (focusSlot?.kind === "break") this.startBreak(focusSlot.brk, cue.t, look);
    this.schedulePrepare();
  }

  private karaokeFor(row: Row, look: Look): KaraokeLine {
    const decor = this.decor[row.index];
    return new KaraokeLine(
      row.line.words,
      row.words,
      {
        size: row.size,
        font: `${look.weight} ${row.size.toFixed(2)}px ${look.font}`,
        letterSpacingPx: look.letterSpacing * row.size,
        lineHeight: LINE_HEIGHT,
        params: this.moves.paramsFor(look, this.params ?? motionParams(look), decor?.move ?? "rise"),
        steps: this.steps,
        ...(decor ? { decor: decor.words } : {}),
        ball: look.karaokeMode && !look.unsynced,
      },
      this.timeline,
      `kw${row.index}`,
    );
  }

  /** New motion parameters: the focus line planned again at the current time, the next one again ahead. */
  private replan(look: Look): void {
    this.prepared?.line.destroy();
    this.prepared = null;
    const t = this.timeline.position();
    const k = this.karaoke;
    if (k) {
      k.line.destroy();
      const line = this.karaokeFor(k.row, look);
      this.karaoke = { line, row: k.row };
      line.mount(t, false);
    }
    const slot = this.slots[this.target];
    if (slot?.kind === "break") this.startBreak(slot.brk, t, look, true);
    this.schedulePrepare();
  }

  /**
   * Builds the next line's overlay (hidden until it is in focus) and plans its words ahead, in idle
   * slices of SLICE_MS starting once this line's own mount has finished, so the next line change only
   * has animations to start.
   */
  private schedulePrepare(): void {
    if (this.prepareTimer) clearTimeout(this.prepareTimer);
    this.prepareTimer = null;
    const look = this.look;
    if (this.destroyed || !look || look.unsynced || typeof setTimeout !== "function") return;
    const box = this.box;
    const step = (): void => {
      this.prepareTimer = null;
      // destroyed or rebuilt since: a step that was already due does nothing
      if (this.destroyed || this.box !== box || !box) return;
      // the line in focus finishes mounting first
      if (this.karaoke?.line.mounting) {
        this.prepareTimer = setTimeout(step, PREPARE_GAP_MS);
        return;
      }
      const next = this.rows[this.focusLine() + (this.slots[this.target]?.kind === "break" ? 0 : 1)];
      if (!next || next === this.karaoke?.row || next.line.words.length === 0) return;
      if (this.prepared?.row !== next) {
        this.prepared?.line.destroy();
        this.prepared = { line: this.karaokeFor(next, look), row: next };
      }
      if (!this.prepared.line.prepare(SLICE_MS, this.leads[next.index])) this.prepareTimer = setTimeout(step, PREPARE_GAP_MS);
    };
    this.prepareTimer = setTimeout(step, PREPARE_DELAY_MS);
  }

  /** After a seek that kept the focus: the focus line re-lit if its animations no longer cover the time, the break's dots likewise. */
  private refreshFocus(cue: Cue, look: Look): void {
    const slot = this.slots[this.target];
    if (slot?.kind === "break") {
      this.startBreak(slot.brk, cue.t, look);
      return;
    }
    const k = this.karaoke;
    if (k && !k.line.covers(cue.t)) k.line.mount(cue.t, false);
  }

  /** A row's look for its state: the focus line crisp in the lyric color, others dim and softer with distance. */
  private styleRow(row: Row, state: string): void {
    if (row.state === state) return;
    const look = this.look;
    if (!look) return;
    const was = row.state;
    row.state = state;
    const focus = state === "focus";
    row.el.classList.toggle("is-focus", focus);
    const shadow = textShadow(look, row.size);
    let color = look.colors.lyric;
    let textShadowOf = shadow;
    // untimed lyrics' near neighbors stay sharp, in the lyric color (CALM_SHARP_LINES)
    if (!focus && !state.startsWith("near")) {
      const step = Number(state.split(":")[1] ?? BLUR_STEPS);
      const blur = Math.max(0.6, step * (this.depth > 0 ? DRIFT_BLUR_EM : STACK_BLUR_EM) * row.size);
      color = "transparent";
      textShadowOf = `0 0 ${blur.toFixed(2)}px ${rgba(look.colors.dim, 1)}, ${shadow}`;
    }
    // on the words' plain text only: the overlay draws its own colors and shadows, and an inherited
    // change on the row would recalculate every copy in it
    for (const txt of row.txts) {
      put(txt, "color", color);
      put(txt, "text-shadow", textShadowOf);
    }
    // Out of focus every word stands at full size; the focus line's karaoke poses its own words.
    if (!focus && was !== "" && was !== "focus") return;
    if (!focus) for (const w of row.words) put(w, "transform", "none");
  }

  /**
   * The line that left focus hands back to its plain text, in its state now, its overlay fading out
   * until it is taken down (SPEC §2.3; LEAVE_MS at least as a rule): in steps in the lite tier, at once
   * without motion or with the song stopped or gone back. Sung through (the usual way out) it stopped
   * still already; leaving early (a seek back) it kept moving with the song until now.
   */
  private handBack(l: Leaving, live: boolean, t: number): void {
    const look = this.look;
    this.stopLeaving(l);
    l.handed = true;
    if (!live || look?.motion === false) l.until = t;
    // the fade would end RELEASE_MS after the overlay is taken down: all but transparent by then
    const fade = l.until > t ? l.until - t + RELEASE_MS : 0;
    l.line.fadeOut(fade, look?.power === "lite" && this.steps ? LITE_FADE_STEPS : 0);
    l.row.el.classList.remove("has-fx");
    if (look) this.styleRow(l.row, this.stateOf(l.row, this.layout(this.target, look), this.karaoke?.row ?? null));
  }

  /** Removes a leaving line's overlay; its row draws its plain text in its state again. */
  private dropOverlay(l: Leaving): void {
    l.line.destroy();
    const state = l.row.state;
    l.row.state = "";
    this.styleRow(l.row, state);
  }

  /** A line sung through stops still as it leaves (once): its words leave their layers, the row draws them. */
  private stopLeaving(l: Leaving): void {
    if (!l.sung || !this.leaving.includes(l)) return;
    l.sung = false;
    l.line.finish();
  }

  /** A row's state with the list on `layout` around `focusRow`: focus, or its distance blur above or below. */
  private stateOf(row: Row, layout: Map<number, SlotStyle>, focusRow: Row | null): string {
    if (row === focusRow) return "focus";
    const i = this.slotOfLine[row.index] ?? -1;
    const off = layout.get(i)?.off;
    if (off === undefined) return i < this.target ? "past" : "up";
    if (this.look?.unsynced && Math.round(Math.abs(off)) <= CALM_SHARP_LINES) return off < 0 ? "near:past" : "near:up";
    return off < 0 ? `past:${blurStep(off)}` : `up:${blurStep(off)}`;
  }

  private distOf(row: Row, layout: Map<number, SlotStyle>): number {
    const off = layout.get(this.slotOfLine[row.index] ?? -1)?.off;
    return off === undefined ? Infinity : Math.abs(off);
  }

  /** Runs `jobs` over the next frames, JOBS_PER_FRAME a frame, in order. */
  private queueLater(jobs: (() => void)[]): void {
    this.later = jobs;
    if (jobs.length === 0) return;
    const step = (): void => {
      this.cancelLater = null;
      if (this.destroyed) return;
      for (const job of this.later.splice(0, JOBS_PER_FRAME)) job();
      if (this.later.length > 0) this.cancelLater = nextFrame(step);
    };
    this.cancelLater = nextFrame(step);
  }

  /** Every job still waiting, now: before another line change, a new look, or the stage's still copy. */
  private flushLater(): void {
    this.cancelLater?.();
    this.cancelLater = null;
    for (const job of this.later.splice(0)) job();
  }

  /** The break's dots, anchored to its start (a seek into the middle of a break joins it there). */
  private startBreak(brk: Break, t: number, look: Look, force = false): void {
    const group = `dots${brk.il.start}`;
    if (!force && brk.dots && this.timeline.busy(group, t)) return;
    brk.dots ??= new InterludeDots(brk.el, DOTS.em * look.size);
    brk.until = brk.dots.play(brk.il, this.timeline, this.params ?? motionParams(look), group, this.steps);
  }

  /** Drops overlays that have faded out, dots whose break is over, and layers of slots a glide left behind. */
  private tidy(cue: Cue): void {
    if (this.leaving.length > 0) {
      let dropped = false;
      this.leaving = this.leaving.filter((l) => {
        // the song stopped, or went back before the change: at once
        const live = cue.running && cue.t >= l.at;
        if (!l.handed) {
          if (live && cue.t < l.handBack - HAND_BACK_SLACK_MS) return true;
          this.handBack(l, live, cue.t);
        }
        if (live && cue.t < l.until) return true;
        this.dropOverlay(l);
        dropped = true;
        return false;
      });
      // the list has come to rest: the same frame lets go of its scroll
      if (dropped) this.releaseScrolls();
    }
    const focus = this.slots[this.target];
    const focusBreak = focus?.kind === "break" ? focus.brk : null;
    for (const brk of this.breaks) {
      if (brk.dots && brk !== focusBreak && (cue.t >= brk.until || cue.t < brk.il.start)) {
        brk.dots.stop();
        brk.dots = null;
      }
    }
    const look = this.look;
    if (look && this.shown.size > 0 && !this.glide?.moving()) {
      const layout = this.layout(this.target, look);
      for (const i of [...this.shown]) {
        const slot = this.slots[i];
        if (slot && !layout.has(i)) this.conceal(i, this.elOf(slot));
      }
    }
  }
}

export function createDrift(depth: number): ModeRenderer {
  return new DriftMode(depth);
}
