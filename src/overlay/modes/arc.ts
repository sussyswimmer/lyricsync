import "../../styles/arc.css";
import type { Line } from "../../core/lrc";
import { h, put, s } from "../dom";
import { whenFaceLoads } from "../fonts";
import { dropShadow, MIN_TEXT_PX, snap, type Look } from "../look";
import { paintVars } from "../motion/bloom";
import { clamp01 } from "../motion/curve";
import { InterludeDots } from "../motion/dots";
import { findInterludes, type Interlude } from "../motion/interlude";
import { compositorSteps, HOLD, holds, keyframesAt, num, SAMPLE_MS, sampleTimes, thin } from "../motion/keyframes";
import { canvasMeasure, casedLines, graphemes, isRtl as hasRtl, roughMeasure, type Measure } from "../motion/letters";
import { KaraokeLine, nextFrame, SLICE_MS } from "../motion/line";
import { CALM_SCROLL_SPRING, DOTS, LITE_SCROLL_MS, motionParams, paramsKey, SCROLL_SPRING, SUNG_LEVEL, type MotionParams } from "../motion/params";
import { focusAt, leadTimes, untilNext } from "../motion/schedule";
import { playWall, WallGlide } from "../motion/scroll";
import { commit, SongTimeline } from "../motion/timeline";
import { arcLength, arcPlacer, frameTransform, reach, visualOffsets, wordFrames, type ArcCurve, type ArcWord, type WordFrame, type WordRun } from "./arc-place";
import type { Cue, ModeRenderer } from "./types";

export { arcLength, reach } from "./arc-place";

/**
 * Previous and next lines at this fraction of the focus size (prototype), but no smaller than
 * MIN_TEXT_PX (or 80% of the focus size, if that is smaller), so tiny sizes keep legible neighbors.
 */
const SIDE_SCALE = 0.48;
/** Baselines in focus font sizes from the focus baseline: previous above, next below with a little extra room for descenders (prototype). */
const PREV_RISE = -1.25;
const NEXT_DROP = 1.25 + 0.15;
/**
 * The middle of each path rises curve × span × BEND above its ends (the prototype's arch). The span
 * is the stage height, or 9/16 of its width when that is smaller, so a portrait display gets the
 * same shape as a landscape one rather than a horseshoe.
 */
const BEND = 0.42;
/**
 * The focus baseline sits this many font sizes below `look.y`, so the glyphs (not the baseline) are
 * centered on the chosen height, the way Drift and Stack center their line box. The bend is split
 * evenly around it: raising the curve lifts the middle and lowers the ends by the same amount.
 */
const BASELINE = 0.35;
/**
 * resolveLook keeps `look.y` this many font sizes from the top and bottom of the stage, which keeps
 * a flat line whole on screen. Arc keeps both extremes of its curve (the middle and the ends) inside
 * that same range, moving the line in from the edge, so a strong curve stays on screen at any Height.
 */
const EDGE = 0.75;
/** Each path runs from this fraction of the width to 1 minus it. */
const MARGIN = 0.05;
/** A line longer than this share of its path shrinks to fit... */
const FIT = 0.94;
/**
 * ...but, shrunk to this share of its size, it may fill its whole path rather than FIT of it. It never
 * runs past the path's ends, which stay on screen: only a line still too long at MIN_TEXT_PX does (or
 * at this share of its size, where that is smaller: small sizes on a small stage, like the settings
 * preview, shrink as far as this share). On a display narrower than 16:9 the share drops in
 * proportion: the size follows the stage height, so an ordinary line on a portrait display needs to
 * shrink further to fit its width.
 */
const MIN_FIT = 0.55;
/** Glyph extents in font sizes, for keeping neighbors clear of the focus line: capitals above the baseline, descenders below. */
const CAP = 0.72;
const DESCENT = 0.22;
/**
 * Neighbors are vertical translations of the focus line's curve, which spread apart toward the ends.
 * A neighbor on the outer side of the curve (the previous line over an arch, the next one under a
 * sag) that is longer than the focus line would hang beside the focus line's ends and read as part of
 * its row. It moves out until its ends clear the focus line's ink, by at most this many focus sizes;
 * past that its own curve flattens instead.
 */
const MAX_PUSH = 1;
/** Room above and below the baseline curve in each neighbor's SVG band, in font sizes... */
const BAND_ABOVE = 1.3;
const BAND_BELOW = 0.6;
/** ...and beyond the text's ends, in font sizes plus px (its shadow, a glyph's overhang, a measuring error). */
const BAND_SIDE_PAD = 1;
const BAND_SIDE_PX = 12;
/** `.arc-focus`'s line-height (styles/arc.css): each word box, and each letter's box in it, is this many font sizes tall. */
const LINE_HEIGHT = 1.2;
/** Where the baseline sits in a word box, in font sizes from its top, when nothing can be measured (no layout: tests). */
const FALLBACK_BASELINE = 0.94;

/**
 * A line coming into view from nowhere (the new next line, or the previous one stepping back) moves
 * this many focus sizes into place, transparent for the first APPEAR_HOLD of the way, so it never
 * draws through the line gliding out of its slot. A line leaving view is gone by LEAVE_BY of the way.
 */
const NEXT_RISE = 0.5;
const APPEAR_HOLD = 0.4;
const LEAVE_BY = 0.5;
/**
 * The focus line arrives from its neighbor's place, where that band drew it a moment ago: the band
 * goes at once and the line takes over there at this opacity, brightening to full by ARRIVE_BY of the
 * way (the neighbor was dim).
 */
const ARRIVING_LEVEL = 0.6;
const ARRIVE_BY = 0.6;
/**
 * The line leaving focus glides, word by word, onto the neighbor band that will draw it, dimming to
 * LEAVING_LEVEL as it goes. Once the glide is within HAND_BACK_SETTLE of rest (where the two copies
 * line up) the band shows under it and the line fades out over HAND_BACK_MS: the band takes over.
 */
const LEAVING_LEVEL = SUNG_LEVEL;
const HAND_BACK_SETTLE = 0.02;
const HAND_BACK_MS = 260;
/** The band under a line handing back is in place by this share of HAND_BACK_MS, so the two never thin out together. */
const BAND_IN_SHARE = 0.4;
/** The interlude dots' middle sits this many font sizes above the focus baseline at the curve's apex. */
const DOTS_RISE = 0.32;
/** A jump of the song further than this while playing is a seek: the focus line's words are put straight. */
const SEEK_MS = 250;
/** ...and while paused (or pausing), any move further than this. */
const PAUSED_SEEK_MS = 50;
/** The next line is prepared from this long after a line change, in idle slices this far apart. */
const PREPARE_DELAY_MS = 600;
const PREPARE_GAP_MS = 40;
/**
 * Wall-time animations this close to their end (ms) have all but arrived. They are dropped then, in
 * the frame that takes the leaving line down, rather than left to end by themselves: Chromium spends
 * frames of its own on animations ending.
 */
const RELEASE_MS = 60;
/**
 * Keyframes of a word's glide are kept where a straight line would miss by more than this: px, px,
 * degrees, scale (a 300 px word's ends: under half a pixel). Every keyframe of every word is parsed in
 * the frame that starts a line change, so no tighter than the eye needs.
 */
const FRAME_THIN = [0.5, 0.5, 0.15, 0.003];
/** ...and of a band's: px, scale, opacity. */
const BAND_THIN = [0.5, 0.003, 0.006];
const OPACITY_THIN = [0.004];

/**
 * Right-to-left blocks (Hebrew, Arabic, Syriac, Thaana, N'Ko and the rest), as in Lens. A line whose
 * first letter is in one of them is laid out right to left, the way `dir="auto"` resolves HTML text.
 */
const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;

const XLINK = "http://www.w3.org/1999/xlink";
const XML = "http://www.w3.org/XML/1998/namespace";

/** Counts instances so path ids stay unique when two arcs coexist (song crossfade, settings preview). */
let instances = 0;

const perfNow = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());
const lerp = (a: number, b: number, x: number): number => a + (b - a) * x;

export interface Slot {
  name: "prev" | "focus" | "next";
  /** line index relative to the focus line */
  k: number;
  /** baseline offset from the focus baseline, in focus font sizes */
  rise: number;
}

/** Drawing order: neighbors first, focus on top. */
const SLOTS: readonly Slot[] = [
  { name: "prev", k: -1, rise: PREV_RISE },
  { name: "next", k: 1, rise: NEXT_DROP },
  { name: "focus", k: 0, rise: 0 },
];

/** One line laid out around a focus line: its slot, size and curve. */
export interface Placed {
  slot: Slot;
  /** line index */
  i: number;
  /** font size, px */
  size: number;
  /** the text's advance at `size`, px */
  natural: number;
  /** baseline at the middle of its path, px from the top */
  mid: number;
  /** its path's bend (the shared one unless an outer neighbor had to flatten), px */
  bend: number;
}

/** Where a band's text starts its glide, relative to where it ends up. */
export interface GlideFrom {
  dy: number;
  scale: number;
  /** fade in as it glides (a line that wasn't on screen) */
  appear: boolean;
}

/** The curve every line of one build shares. */
export interface ArcGeometry {
  /** how far the middle of each path rises above its ends, px (negative: sinks below them) */
  bend: number;
  /** the focus line's baseline at the middle of its path, px from the top */
  mid: number;
  /** the share of its size from which a shrinking line may fill its whole path (MIN_FIT, for this aspect ratio) */
  minFit: number;
}

/** A run of text on a curve, for keeping neighbors apart: its font size and advance, px. */
export interface Run {
  size: number;
  length: number;
}

/**
 * The shared curve for a look. The bend scales with the smaller of the stage height and 9/16 of its
 * width, so every aspect ratio gets the same shape. The focus line's middle sits where the Height
 * puts it, the bend split evenly around it, unless that takes the line off screen: `look.y` keeps a
 * flat line whole on screen, and a curved one moves in from the top or bottom until both its middle
 * and its ends (as far as `extent`, a share of the half-width, the widest focus line of the song
 * reaches) are inside the same range. A curve too deep for the stage at this size gets flatter rather
 * than cut off.
 */
export function arcGeometry(look: Look, extent = 1): ArcGeometry {
  const span = Math.min(look.height, (look.width * 9) / 16);
  const wanted = look.curve * Math.max(0, span) * BEND;
  const edge = Math.min(look.size * EDGE, look.height / 2);
  const room = Math.max(0, look.height - 2 * edge);
  const bend = Math.sign(wanted) * Math.min(Math.abs(wanted), room);
  // the range resolveLook allows a flat line's baseline, and how far the text's ends sink below its middle
  const top = edge + BASELINE * look.size;
  const bottom = look.height - edge + BASELINE * look.size;
  const sink = bend * Math.min(1, Math.max(0, extent)) ** 2;
  const mid = look.y + BASELINE * look.size - bend / 2;
  const aspect = look.height > 0 ? (look.width * 9) / (look.height * 16) : 1;
  return {
    bend,
    mid: Math.min(Math.max(mid, top - Math.min(0, sink)), bottom - Math.max(0, sink)),
    minFit: MIN_FIT * Math.min(1, Math.max(0, aspect)),
  };
}

/**
 * How far a neighbor on the outer side of the curve (`rise` focus sizes from the focus baseline:
 * negative above an arch, positive below a sag) moves out, and the bend its own path takes, so its
 * ends stay clear of the focus line's ink beside them. See MAX_PUSH.
 */
export function clearNeighbor(bend: number, halfWidth: number, rise: number, focus: Run, side: Run): { push: number; bend: number } {
  const b = Math.abs(bend);
  const near = reach(focus.length, halfWidth, bend);
  // the gap between the two lines' ink where they line up: baseline gap less the glyphs facing each other
  const facing = rise < 0 ? CAP * focus.size + DESCENT * side.size : DESCENT * focus.size + CAP * side.size;
  const slack = Math.abs(rise) * focus.size - facing;
  // A point a share s of the half-width out from the middle sits b·s² below it (above, under a sag),
  // so the neighbor's ends sink this much further than the focus line's do.
  const far = reach(side.length, halfWidth, bend);
  const need = b * (far * far - near * near) - slack;
  if (need <= 0) return { push: 0, bend };
  const most = MAX_PUSH * focus.size;
  if (need <= most) return { push: need, bend };
  // Flatten the neighbor's own path until its ends clear the focus line from the pushed position.
  // A flatter path carries the same text a little further out, but its ends still sink less: find
  // the deepest bend that clears.
  const room = b * near * near + slack + most;
  let lo = 0;
  let hi = b;
  for (let n = 0; n < 30; n++) {
    const flat = (lo + hi) / 2;
    const out = reach(side.length, halfWidth, flat);
    if (flat * out * out <= room) lo = flat;
    else hi = flat;
  }
  return { push: most, bend: Math.sign(bend) * lo };
}

/** Whether a line reads right to left: its first letter is from a right-to-left script. */
export function isRtl(text: string): boolean {
  const first = /\p{L}/u.exec(text)?.[0];
  return first !== undefined && RTL.test(first);
}

/**
 * Where a placed line starts its glide when the focus has just stepped to a neighbor: where the same
 * line was drawn in the layout `before` (the old focus line is the new previous line, the old next
 * line the new focus line), its middle and size carried over. A line that wasn't drawn (the new next
 * line) rises in from NEXT_RISE focus sizes below.
 */
export function glideFrom(p: Placed, before: readonly Placed[], focusSize: number): GlideFrom {
  const was = before.find((b) => b.i === p.i);
  if (!was) return { dy: NEXT_RISE * focusSize, scale: 1, appear: true };
  return { dy: was.mid - p.mid, scale: was.size / p.size, appear: false };
}

/** A band gliding in from `from`, `x` of the way there (the spring's position: past 1 while it overshoots). */
export function glideAt(from: GlideFrom, x: number): { dy: number; scale: number; opacity: number } {
  return {
    dy: from.dy * (1 - x),
    scale: from.scale + (1 - from.scale) * x,
    opacity: from.appear ? clamp01((x - APPEAR_HOLD) / (1 - APPEAR_HOLD)) : 1,
  };
}

/** A band moving `dy` px out of view, `x` of the way: gone by LEAVE_BY. */
export function leaveAt(dy: number, x: number): { dy: number; opacity: number } {
  return { dy: dy * x, opacity: 1 - clamp01(x / LEAVE_BY) };
}

/** A view of the song: a line in focus, or an instrumental break before line `il.next`, its dots at the apex. */
type View = { kind: "line"; i: number } | { kind: "break"; il: Interlude };

/** A neighbor (or, for unsynced lyrics, the focus line): an SVG band with its own path and text. */
interface Band {
  svg: SVGSVGElement;
  text: SVGTextElement;
  p: Placed;
  /** wall-time animations it runs (its glide) */
  anims: Animation[];
}

/** The focus line's words as HTML on the curve, each word a `.kw` box in an `.arc-word` frame. */
interface Group {
  i: number;
  el: HTMLDivElement;
  words: HTMLElement[];
  boxes: HTMLElement[];
  /** font size, px (the line fitted to its path) */
  size: number;
  shape: LineShape;
  /** each word's frame in focus */
  frames: WordFrame[];
  line: KaraokeLine | null;
  /** wall-time animations: its words' glides and its opacity */
  anims: { el: Element; anim: Animation }[];
  /** the glide it is on: where its words are shown comes from it */
  motion: { spring: WallGlide; from: WordFrame[]; fromScale: number; to: WordFrame[]; toScale: number } | null;
}

/** A line's words along it: offsets in visual order and advances, px, and the line's advance. */
interface LineShape {
  words: ArcWord[];
  total: number;
}

interface Dots {
  host: HTMLDivElement;
  dots: InterludeDots;
  il: Interlude;
  /** song time their motion ends */
  until: number;
}

/** What is on screen for one view. */
interface Drawn {
  slot: number;
  layout: Placed[];
  prev: Band | null;
  next: Band | null;
  /** the focus line with its karaoke (synced lyrics) */
  group: Group | null;
  /** the focus line as a band (unsynced lyrics: calm, no overlay) */
  calm: Band | null;
  dots: Dots | null;
}

/** Something on its way out: removed once the song passes `until`, or goes back before `at`. */
interface Leaving {
  el: Element;
  group: Group | null;
  band: Band | null;
  at: number;
  until: number;
}

/** A line change's spring, released now and sampled to rest. */
interface Glide {
  spring: WallGlide;
  /** document-timeline time of the release */
  start: number;
  times: number[];
  xs: number[];
  duration: number;
  /** the lite tier holds each sample (LITE_SCROLL_MS apart) */
  hold: boolean;
  /** ms after the release a line leaving focus hands back to its band */
  handBack: number;
}

/**
 * Arc: the focus line set on a curve, with the previous line small above and the next one small
 * below, each on a parallel curve.
 *
 * The focus line is HTML: every word a karaoke box (motion/line.ts) in a frame turned to the curve,
 * every letter in it placed on the curve itself (arc-place.ts), so the wipe, the pop, the letters'
 * ripple and the bloom all run on the compositor, each letter hopping along its own normal. The dim
 * neighbors stay SVG `textPath` bands, drop-shadowed, rasterized once per line change.
 *
 * Line changes start at the lead (LEAD_MS before the line is sung) and run on a spring (SCROLL_SPRING)
 * sampled into keyframes on the document timeline: the new focus line's words glide up from where the
 * next band drew them, the old focus line's words glide onto the previous band and hand back to it,
 * the old previous line rises out and the new next one rises in. Instrumental breaks show the dots at
 * the curve's apex. The page sleeps between line changes: paint never asks for frames, and nextChange
 * names the moments it must be woken for.
 */
export class ArcMode implements ModeRenderer {
  /** Nothing happens at a word boundary that the compositor isn't already drawing: sleep through them. */
  readonly wordWakes = false;
  private readonly id = ++instances;
  private readonly timeline = new SongTimeline();
  /** slow motion steps on the song-time beat where the engine composites stepped keyframes */
  private readonly steps = compositorSteps();
  private builds = 0;
  private serial = 0;
  private look: Look | null = null;
  private params: MotionParams | null = null;
  private motionKey = "";
  /** the lyric lines, in the look's case */
  private lines: Line[] = [];
  private box: HTMLDivElement | null = null;
  /** the shared curve, resolved per build */
  private geo: ArcGeometry = { bend: 0, mid: 0, minFit: MIN_FIT };
  /** each line's advance at `look.size`, px */
  private lengths: number[] = [];
  /** length of the shared path (neighbors are vertical translations of it, unless one had to flatten), px */
  private pathLength = 0;
  /** a word box's baseline, in font sizes from its top (measured per build) */
  private baseline = FALLBACK_BASELINE;
  private shapes = new Map<string, LineShape>();
  private interludes: Interlude[] = [];
  /** when the view moves to each line (schedule.ts) */
  private leads: number[] = [];
  private views: View[] = [];
  private slotOfLine: number[] = [];
  /** the view on screen, -1 before the first paint */
  private target = -1;
  private drawn: Drawn | null = null;
  private leaving: Leaving[] = [];
  /** the next focus line, built and planned ahead in idle slices */
  private prepared: Group | null = null;
  private prepareTimer: ReturnType<typeof setTimeout> | null = null;
  /** document-timeline time the current line change's glides end (0: none) */
  private glideEnd = 0;
  private lastCue: Cue | null = null;
  private lastT = Number.NaN;
  private lastPerf = 0;
  private lastRunning = false;
  /** a retime moved the song onto another view: paint at once (nextChange 0) */
  private dirty = false;
  /** freeze() stopped everything in place: the next paint draws afresh */
  private frozen = false;
  private destroyed = false;
  /** what a line change left for the frame after it, and the frame that runs it */
  private later: (() => void)[] = [];
  private cancelLater: (() => void) | null = null;

  /**
   * The stage crossfades a cut: under reduced motion, while paused (a glide while paused would show
   * a line the song isn't at), and on a jump further than one view (a seek). Not when the song ends:
   * Arc fades out by itself.
   */
  crossfades(next: Cue): boolean {
    const look = this.look;
    if (!look) return false;
    if (!look.motion || !next.running) return true;
    if (next.line < 0 || this.target < 0) return false;
    return Math.abs(this.viewAt(next) - this.target) > 1;
  }

  /** Arc cuts to a break or a line within the stage's line (reduced motion, paused, far): crossfade it. */
  cuts(cue: Cue): boolean {
    const look = this.look;
    if (!look || this.target < 0 || cue.line < 0) return false;
    const view = this.viewAt(cue);
    if (view === this.target) return false;
    return !look.motion || !cue.running || Math.abs(view - this.target) > 1;
  }

  build(host: HTMLElement, lines: readonly Line[], look: Look): void {
    this.destroy();
    this.destroyed = false;
    this.look = look;
    this.params = motionParams(look);
    this.motionKey = paramsKey(this.params);
    host.textContent = "";
    const box = h("div", "arc");
    box.style.fontFamily = look.font;
    box.style.fontWeight = String(look.weight);
    host.append(box);
    this.box = box;
    this.lines = casedLines(lines, look.textCase);
    this.interludes = look.unsynced ? [] : findInterludes(this.lines);
    this.leads = leadTimes(this.lines);
    // views in song order: each break just before the line it leads into
    this.views = [];
    this.slotOfLine = [];
    let b = 0;
    this.lines.forEach((_, i) => {
      while (b < this.interludes.length && (this.interludes[b]?.next ?? Infinity) <= i) {
        const il = this.interludes[b++];
        if (il) this.views.push({ kind: "break", il });
      }
      this.slotOfLine[i] = this.views.length;
      this.views.push({ kind: "line", i });
    });
    // the bend, for measuring the path; measure() then places the focus line
    this.geo = arcGeometry(look);
    this.measure(look, box);
    this.refitWhenFontsLoad(look, box);
  }

  /**
   * New colors, glow or bloom, or new motion: nothing is measured or rebuilt, and glides in flight
   * carry on. Colors only update the bands' fills and filters and the karaoke's CSS variables; new
   * motion parameters plan the focus line again at the current time, and the next line again ahead.
   */
  restyle(look: Look): void {
    this.look = look;
    if (!this.box) return;
    for (const band of this.bands()) this.paintBand(band, look);
    for (const g of this.groups()) paintVars(g.el, look, g.size);
    const dots = this.drawn?.dots;
    if (dots) paintVars(dots.host, look, look.size);
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
    this.lastCue = cue;
    const perf = perfNow();
    this.sync(cue, perf);
    const jumped = this.jumped(cue, perf);
    this.dirty = false;
    put(box, "opacity", cue.line < 0 ? "0" : "1");
    if (cue.line < 0) return false;
    const view = this.viewAt(cue);
    if (view !== this.target || this.frozen || !this.drawn) this.moveTo(view, cue, look);
    else if (jumped) this.refreshFocus(cue, look);
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
    if (this.viewAt(cue) !== this.target) {
      this.dirty = true;
      return;
    }
    if (jumped) this.refreshFocus(cue, look);
  }

  /**
   * Song ms until this mode needs a paint no line boundary brings: the next line's lead, a break
   * starting or ending, a leaving line to take down, the end of a playback-rate slew; 0 when a retime
   * moved the song onto another view.
   */
  nextChange(t: number): number {
    if (this.dirty) return 0;
    let next = this.timeline.nextWake();
    if (this.look?.motion !== false) next = Math.min(next, untilNext(this.leads, t));
    for (const il of this.interludes) {
      if (il.start > t) next = Math.min(next, il.start - t);
      if (il.end > t) next = Math.min(next, il.end - t);
    }
    for (const l of this.leaving) next = Math.min(next, Math.max(0, l.until - t));
    return next;
  }

  /** Commits everything moving to inline style and stops it (before the stage copies the scene). */
  freeze(): void {
    this.flushLater();
    this.drawn?.group?.line?.freeze();
    for (const l of this.leaving) l.group?.line?.freeze();
    this.timeline.freeze();
    for (const band of this.bands()) this.commitAnims(band.anims.map((anim) => ({ el: band.svg, anim })));
    for (const band of this.bands()) band.anims = [];
    for (const g of this.groups()) {
      this.commitAnims(g.anims);
      g.anims = [];
      g.motion = null;
    }
    this.glideEnd = 0;
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
    if (this.prepared) this.dropGroup(this.prepared);
    this.prepared = null;
    for (const l of this.leaving) this.dropLeaving(l);
    this.leaving = [];
    if (this.drawn) this.clearDrawn(this.drawn);
    this.drawn = null;
    this.box?.remove();
    this.box = null;
    this.lastCue = null;
    this.lines = [];
    this.lengths = [];
    this.leads = [];
    this.views = [];
    this.slotOfLine = [];
    this.interludes = [];
    this.shapes.clear();
    this.target = -1;
    this.lastT = Number.NaN;
  }

  // ---------- song time ----------

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

  /** The view to show at `cue`: a break while one plays, else the line whose lead has come. */
  private viewAt(cue: Pick<Cue, "line" | "waiting" | "t">): number {
    const f = focusAt(cue, this.lines, this.leads, this.interludes, this.look?.motion !== false);
    if (f.interlude) {
      const il = f.interlude;
      const at = this.views.findIndex((v) => v.kind === "break" && v.il === il);
      if (at >= 0) return at;
    }
    return f.line >= 0 ? (this.slotOfLine[f.line] ?? -1) : -1;
  }

  // ---------- measuring and placing ----------

  /**
   * Measures every line once on a canvas (no layout read), and the word box's baseline once (one
   * layout read per build), so laying a line out later needs neither.
   */
  private measure(look: Look, box: HTMLDivElement): void {
    this.shapes.clear();
    const halfWidth = this.halfWidth(look);
    this.pathLength = 2 * arcLength(halfWidth, halfWidth, this.geo.bend);
    this.lengths = this.lines.map((_, i) => this.shapeOf(i, look.size, look).total);
    this.baseline = this.probeBaseline(box);
    // the bend stays; the focus line's place depends on how far the song's widest line reaches
    this.geo = arcGeometry(look, this.widest(look));
  }

  /**
   * Where the baseline sits in a word box, in font sizes from its top: an empty inline-block sits on
   * the baseline, so its offset is the baseline's. Measured at 100 px for precision.
   */
  private probeBaseline(box: HTMLDivElement): number {
    const group = h("div", "arc-focus arc-probe");
    group.style.fontSize = "100px";
    const word = h("div", "arc-word");
    const kw = h("span", "kw");
    const mark = h("span", "arc-mark");
    kw.append(h("span", "kw-txt", "Hg"), mark);
    word.append(kw);
    group.append(word);
    box.append(group);
    const at = Number(mark.offsetTop);
    const height = Number(kw.offsetHeight);
    group.remove();
    return Number.isFinite(at) && at > 0 && height > 0 ? at / 100 : FALLBACK_BASELINE;
  }

  /** How far the song's widest focus line reaches along the path, a share of its half-width. */
  private widest(look: Look): number {
    const halfWidth = this.halfWidth(look);
    let most = 0;
    for (let i = 0; i < this.lines.length; i++) {
      most = Math.max(most, reach(this.natural(i, this.fitted(i, look.size, look), look), halfWidth, this.geo.bend));
    }
    return most;
  }

  /**
   * The lyric face may still be downloading on the first build (or the subset for accents or another
   * script may be), and fallback metrics would fit and place lines wrongly. Measure again once it's in,
   * and draw the view afresh. Asking is cached (see whenFaceLoads): a Size drag rebuilds on every step.
   */
  private refitWhenFontsLoad(look: Look, box: HTMLDivElement): void {
    const loading = whenFaceLoads(look.family, look.weight, this.lines.map((l) => l.text).join(""));
    if (!loading) return;
    void loading.then(
      () => {
        // a restyle since then kept the layout but brought new colors
        const current = this.look;
        if (this.box !== box || !current || this.destroyed) return;
        this.measure(current, box);
        if (this.prepared) this.dropGroup(this.prepared);
        this.prepared = null;
        const last = this.lastCue;
        if (!last || last.line < 0 || this.target < 0) return;
        const cue = { ...last, t: this.timeline.playing ? this.timeline.position() : last.t };
        this.target = this.viewAt(cue);
        this.cut(this.target, cue, current);
        this.schedulePrepare();
      },
      () => undefined,
    );
  }

  private fontAt(look: Look, size: number): string {
    return `${look.weight} ${size.toFixed(2)}px ${look.font}`;
  }

  /**
   * Line `i` at font `size`: each word's advance and where it starts (visual order), and the line's
   * advance with every space and letter-spacing in it, measured the way the karaoke measures its words
   * (canvas, same font), so the placement and the karaoke's letters agree.
   */
  private shapeOf(i: number, size: number, look: Look): LineShape {
    const key = `${i}@${size.toFixed(3)}`;
    const hit = this.shapes.get(key);
    if (hit) return hit;
    const line = this.lines[i];
    const measure: Measure = canvasMeasure(this.fontAt(look, size)) ?? roughMeasure(size);
    const spacing = look.letterSpacing * size;
    const count = (text: string): number => (spacing === 0 ? 0 : graphemes(text).length);
    const runs: WordRun[] = (line?.words ?? []).map((w) => {
      const text = w.text.trimEnd();
      const width = measure(text) + spacing * Math.max(0, count(text) - 1);
      const full = measure(w.text) + spacing * count(w.text);
      const rtl = hasRtl(text);
      return { width, space: Math.max(0, full - width), rtl, ltr: !rtl && /\p{L}/u.test(text) };
    });
    const { at, total } = visualOffsets(runs, isRtl(line?.text ?? ""));
    const shape: LineShape = { words: runs.map((r, j) => ({ at: at[j] ?? 0, width: r.width })), total };
    this.shapes.set(key, shape);
    return shape;
  }

  /** Half the horizontal span of every path, px. */
  private halfWidth(look: Look): number {
    return (snap(look.width * (1 - MARGIN), look.dpr) - snap(look.width * MARGIN, look.dpr)) / 2;
  }

  /** The parabola through `mid` with this `bend`, as the bands' paths draw it. */
  private curveOf(look: Look, mid: number, bend: number): ArcCurve {
    const x0 = snap(look.width * MARGIN, look.dpr);
    const x1 = snap(look.width * (1 - MARGIN), look.dpr);
    return { xm: (x0 + x1) / 2, mid, bend, halfWidth: (x1 - x0) / 2 };
  }

  /**
   * Path from 5% to 95% of the width through `mid` at the middle of the stage, its ends `bend` px
   * below that (above, for a negative bend).
   *
   * SVG drops glyphs that run past the end of a text path, so a line still too long at MIN_TEXT_PX
   * (see fitted) would lose words in mid-air at 5% and 95%. For such a line, `extend` px of straight
   * track continue each end along its tangent; the text stays centered and runs off the screen edges instead.
   */
  private curve(look: Look, mid: number, bend: number, extend = 0): string {
    const x0 = snap(look.width * MARGIN, look.dpr);
    const x1 = snap(look.width * (1 - MARGIN), look.dpr);
    const xm = snap(look.width / 2, look.dpr);
    const ends = snap(mid + bend, look.dpr);
    const control = snap(mid - bend, look.dpr);
    const arc = `${x0} ${ends} Q ${xm} ${control} ${x1} ${ends}`;
    if (extend <= 0) return `M ${arc}`;
    // the tangents at the ends point from the control point through each end
    const dx = x1 - xm;
    const dy = ends - control;
    const unit = Math.hypot(dx, dy) || 1;
    const ex = snap((extend * dx) / unit, look.dpr);
    const ey = snap((extend * dy) / unit, look.dpr);
    return `M ${x0 - ex} ${ends + ey} L ${arc} L ${x1 + ex} ${ends + ey}`;
  }

  /**
   * Font size for line `i` drawn at `size`: shrunk so it fits its path (see FIT and MIN_FIT), and never
   * longer than the path, down to MIN_TEXT_PX or `minFit` of its size, whichever is smaller. Flooring
   * at MIN_TEXT_PX alone kept a long line in the settings preview (size 15, neighbors 11) from
   * shrinking at all, and it ran off both edges of the stage.
   */
  private fitted(i: number, size: number, look: Look): number {
    const natural = this.natural(i, size, look);
    const room = this.pathLength * FIT;
    if (room <= 0 || natural <= room) return size;
    const fit = Math.max(size * this.geo.minFit, (size * room) / natural);
    return Math.max(Math.min(size * this.geo.minFit, MIN_TEXT_PX), Math.min(fit, (size * this.pathLength) / natural));
  }

  /** Line `i`'s advance at `size`, px. */
  private natural(i: number, size: number, look: Look): number {
    return ((this.lengths[i] ?? 0) * size) / look.size;
  }

  /**
   * The lines drawn around a focus (line `focus`, or a break's dots, which are `around.size` tall and
   * `around.length` long), laid out: the focus line on the shared curve at `geo.mid`, its neighbors on
   * translated copies above and below, sized from the focus (a long focus line that had to shrink takes
   * its neighbors and their spacing down with it, so it still leads). The neighbor on the outer side of
   * the curve moves out (and, past MAX_PUSH, flattens) when it is long enough to hang beside the focus.
   */
  private around(prev: number, focus: number | null, next: number, around: Run, look: Look): Placed[] {
    const geo = this.geo;
    const halfWidth = this.halfWidth(look);
    const side = Math.max(SIDE_SCALE * around.size, Math.min(0.8 * around.size, MIN_TEXT_PX));
    const placed: Placed[] = [];
    for (const slot of SLOTS) {
      const i = slot.k < 0 ? prev : slot.k > 0 ? next : focus;
      if (i === null || !this.lines[i]) continue;
      const size = slot.k === 0 ? around.size : this.fitted(i, side, look);
      const natural = this.natural(i, size, look);
      let mid = geo.mid + slot.rise * around.size;
      let bend = geo.bend;
      // above an arch (rise < 0, bend > 0) or below a sag
      if (slot.k !== 0 && slot.rise * geo.bend < 0) {
        const clear = clearNeighbor(geo.bend, halfWidth, slot.rise, around, { size, length: natural });
        mid += Math.sign(slot.rise) * clear.push;
        bend = clear.bend;
      }
      placed.push({ slot, i, size, natural, mid, bend });
    }
    return placed;
  }

  /** The layout of view `slot`. */
  private layoutOf(slot: number, look: Look): Placed[] {
    const view = this.views[slot];
    if (!view) return [];
    if (view.kind === "line") {
      const size = this.fitted(view.i, look.size, look);
      return this.around(view.i - 1, view.i, view.i + 1, { size, length: this.natural(view.i, size, look) }, look);
    }
    const n = view.il.next;
    return this.around(n - 1, null, n, { size: look.size, length: (3 + 2 * DOTS.gap) * DOTS.em * look.size }, look);
  }

  /** The focus size a layout is built around (a break's: the look's). */
  private focusSize(layout: readonly Placed[], look: Look): number {
    return layout.find((p) => p.slot.k === 0)?.size ?? look.size;
  }

  /** Line `i`'s words' frames on the path through `p` (a neighbor's place), and the scale from focus size. */
  private framesAt(g: Group, p: Placed, look: Look): { frames: WordFrame[]; scale: number } {
    const k = p.size / g.size;
    const words = g.shape.words.map((w) => ({ at: w.at * k, width: w.width * k }));
    return { frames: wordFrames(this.curveOf(look, p.mid, p.bend), words, g.shape.total * k), scale: k };
  }

  // ---------- drawing ----------

  /** Brings view `slot` on screen: a glide to a neighboring view while playing with motion, else a cut. */
  private moveTo(slot: number, cue: Cue, look: Look): void {
    const from = this.target;
    this.target = slot;
    const glide = look.motion && cue.running && !this.frozen && this.drawn !== null && from >= 0 && Math.abs(slot - from) === 1;
    if (glide) this.step(slot, cue, look);
    else this.cut(slot, cue, look);
    this.schedulePrepare();
  }

  /** Draws view `slot` at rest: whatever was drawn goes at once (the stage crossfades a cut when it asked to). */
  private cut(slot: number, cue: Cue, look: Look): void {
    this.flushLater();
    for (const l of this.leaving) this.dropLeaving(l);
    this.leaving = [];
    if (this.drawn) this.clearDrawn(this.drawn);
    this.drawn = null;
    this.glideEnd = 0;
    const layout = this.layoutOf(slot, look);
    const drawn: Drawn = { slot, layout, prev: null, next: null, group: null, calm: null, dots: null };
    for (const p of layout) {
      if (p.slot.k < 0) drawn.prev = this.newBand(p, look);
      else if (p.slot.k > 0) drawn.next = this.newBand(p, look);
      else if (look.unsynced) drawn.calm = this.newBand(p, look, true);
      else {
        const g = this.takeGroup(p.i, look);
        put(g.el, "opacity", "1");
        this.focusOn(g, cue, look);
        drawn.group = g;
      }
    }
    const view = this.views[slot];
    if (view?.kind === "break") drawn.dots = this.startDots(view.il, look);
    this.drawn = drawn;
  }

  /**
   * A step to the neighboring view (either way): each line glides from where it was drawn to where it
   * goes. The focus line arrives from its band's place, word by word; the line leaving focus glides
   * onto its band's place and hands back to it; a line coming into view rises (or sinks) in; one
   * leaving view rises (or sinks) out. Lines that keep their place stay as they are.
   */
  private step(slot: number, cue: Cue, look: Look): void {
    const old = this.drawn;
    if (!old) {
      this.cut(slot, cue, look);
      return;
    }
    this.flushLater();
    const glide = this.glideNow(look);
    const before = old.layout;
    const after = this.layoutOf(slot, look);
    const size = this.focusSize(after, look);
    const forward = slot > old.slot;
    const drawn: Drawn = { slot, layout: after, prev: null, next: null, group: null, calm: null, dots: null };
    // bands of the old view that are taken over in place (and so must not be removed below)
    const kept = new Set<Band>();
    const oldBand = (p: Placed): Band | null => (p.slot.k < 0 ? old.prev : p.slot.k > 0 ? old.next : old.calm);
    for (const p of after) {
      const was = before.find((b) => b.i === p.i) ?? null;
      if (p.slot.k === 0 && !look.unsynced) {
        // the focus line: HTML words, from where the band drew them (or rising in)
        const back = this.leaving.findIndex((l) => l.group?.i === p.i);
        if (back >= 0) this.dropLeaving(this.leaving.splice(back, 1)[0] as Leaving);
        const g = this.takeGroup(p.i, look);
        this.focusOn(g, cue, look);
        if (was) {
          const start = this.framesAt(g, was, look);
          this.glideGroup(g, start.frames, start.scale, g.frames, 1, glide, (x) => lerp(ARRIVING_LEVEL, 1, clamp01(x / ARRIVE_BY)));
        } else {
          const dy = (forward ? 1 : -1) * NEXT_RISE * size;
          const start = g.frames.map((f) => ({ ...f, y: f.y + dy }));
          this.glideGroup(g, start, 1, g.frames, 1, glide, (x) => clamp01((x - APPEAR_HOLD) / (1 - APPEAR_HOLD)));
        }
        put(g.el, "opacity", "1");
        drawn.group = g;
        continue;
      }
      let band: Band;
      const prior = was ? oldBand(was) : null;
      if (was?.slot.k === 0 && old.group) {
        // the line leaving focus: its words glide onto this band, which takes over once they are there
        band = this.newBand(p, look, p.slot.k === 0);
        this.handBack(old.group, p, band, glide, cue, look);
        old.group = null;
      } else if (was && prior && same(was, p) && was.slot.k === p.slot.k) {
        band = prior;
        kept.add(prior);
      } else {
        band = this.newBand(p, look, p.slot.k === 0);
        const from = was ? glideFrom(p, before, size) : { dy: (p.slot.k < 0 ? -1 : 1) * NEXT_RISE * size, scale: 1, appear: true };
        this.glideBand(band, from, glide);
      }
      if (p.slot.k < 0) drawn.prev = band;
      else if (p.slot.k > 0) drawn.next = band;
      else drawn.calm = band;
    }
    // lines leaving view: up and out past the top (forward), down and out past the bottom (back)
    const prevNow = after.find((p) => p.slot.k < 0);
    const nextNow = after.find((p) => p.slot.k > 0);
    const travel = forward ? (prevNow ? prevNow.mid - this.geo.mid : -NEXT_RISE * size) : nextNow ? nextNow.mid - this.geo.mid : NEXT_RISE * size;
    for (const b of before) {
      if (after.some((a) => a.i === b.i)) continue;
      const band = oldBand(b);
      if (band) {
        kept.add(band);
        this.leaveBand(band, travel, glide, cue);
      } else if (b.slot.k === 0 && old.group) {
        this.fadeGroup(old.group, glide, cue);
        old.group = null;
      }
    }
    // what the arriving focus line took over from (its band), and anything else not carried on, goes now
    for (const band of [old.prev, old.next, old.calm]) if (band && !kept.has(band)) this.dropBand(band);
    if (old.group) this.dropGroup(old.group);
    if (old.dots) this.stopDots(old.dots);
    const view = this.views[slot];
    if (view?.kind === "break") drawn.dots = this.startDots(view.il, look);
    this.drawn = drawn;
    this.glideEnd = glide.start + glide.duration;
  }

  /** The spring of a line change, released now from one view (0) toward the next (1), sampled to rest. */
  private glideNow(look: Look): Glide {
    const now = perfNow();
    const spec = look.unsynced ? CALM_SCROLL_SPRING : SCROLL_SPRING;
    const spring = new WallGlide(0, spec, now);
    spring.to(1, now, spec);
    // the lite tier holds each place for a 30th of a second (LITE_SCROLL_MS), every element on the same beat
    const hold = look.power === "lite" && this.steps;
    const every = hold ? LITE_SCROLL_MS : SAMPLE_MS;
    const settle = spring.samples(every).duration;
    const grid = sampleTimes(settle, every);
    let handBack = 0;
    for (let k = grid.length - 1; k >= 0; k--) {
      if (Math.abs(spring.at(grid[k] ?? 0).x - 1) > HAND_BACK_SETTLE) {
        handBack = grid[Math.min(grid.length - 1, k + 1)] ?? settle;
        break;
      }
    }
    const duration = Math.max(settle, handBack + HAND_BACK_MS);
    const times = sampleTimes(duration, every);
    const xs = times.map((ms) => spring.at(ms).x);
    xs[xs.length - 1] = 1;
    return { spring, start: now, times, xs, duration, hold, handBack };
  }

  /**
   * Plays `values` (channels, as a function of the glide's position and its ms) on `el` as keyframes
   * built by `frame`, thinned to `tolerance` per channel (held on the beat in the lite tier).
   */
  private play(el: Element, glide: Glide, values: (x: number, ms: number) => number[], frame: (v: readonly number[]) => Keyframe, tolerance: readonly number[]): Animation | null {
    const rows = glide.times.map((ms, k) => values(glide.xs[k] ?? 1, ms));
    const channels = tolerance.map((_, c) => rows.map((r) => r[c] ?? 0));
    const keep = glide.hold ? holds(channels, tolerance) : thin(glide.times, channels, tolerance);
    return playWall(el, {
      frames: keyframesAt(glide.times, keep, (k) => {
        const f = frame(rows[k] ?? []);
        if (glide.hold) f.easing = HOLD;
        return f;
      }),
      duration: glide.duration,
      startTime: glide.start,
    });
  }

  /** A band gliding into its place from `from` (see glideAt). */
  private glideBand(band: Band, from: GlideFrom, glide: Glide): void {
    if (!from.appear && Math.abs(from.dy) < 0.01 && Math.abs(from.scale - 1) < 1e-4) return;
    const anim = this.play(
      band.svg,
      glide,
      (x) => {
        const v = glideAt(from, x);
        return [v.dy, v.scale, v.opacity];
      },
      (v) => {
        const f: Keyframe = { transform: `translateY(${num(v[0] ?? 0, 2)}px) scale(${num(v[1] ?? 1, 4)})` };
        if (from.appear) f.opacity = num(v[2] ?? 1, 3);
        return f;
      },
      BAND_THIN,
    );
    if (anim) band.anims.push(anim);
  }

  /** A band moving `dy` px out of view (see leaveAt), taken down once the glide is over. */
  private leaveBand(band: Band, dy: number, glide: Glide, cue: Cue): void {
    this.stopAnims(band.anims.map((anim) => ({ el: band.svg, anim })));
    band.anims = [];
    band.svg.setAttribute("aria-hidden", "true");
    const anim = this.play(
      band.svg,
      glide,
      (x) => {
        const v = leaveAt(dy, x);
        return [v.dy, 1, v.opacity];
      },
      (v) => ({ transform: `translateY(${num(v[0] ?? 0, 2)}px)`, opacity: num(v[2] ?? 0, 3) }),
      BAND_THIN,
    );
    if (anim) band.anims.push(anim);
    put(band.svg, "opacity", "0");
    this.leaving.push({ el: band.svg, group: null, band, at: cue.t, until: cue.t + glide.duration - RELEASE_MS });
  }

  /**
   * The line leaving focus glides, word by word, onto `p` (its new place as a neighbor), dimming as it
   * goes; once it is all but there, `band` (the neighbor that draws it from now on) shows under it and
   * it fades out. A line sung through stops its karaoke in the frame after the change.
   */
  private handBack(g: Group, p: Placed, band: Band, glide: Glide, cue: Cue, look: Look): void {
    const start = this.shownFrames(g);
    const end = this.framesAt(g, p, look);
    const hb = glide.handBack;
    const at = lerp(1, LEAVING_LEVEL, clamp01(glide.spring.at(hb).x));
    this.glideGroup(g, start.frames, start.scale, end.frames, end.scale, glide, (x, ms) =>
      ms < hb ? lerp(1, LEAVING_LEVEL, clamp01(x)) : at * (1 - clamp01((ms - hb) / HAND_BACK_MS)),
    );
    put(g.el, "opacity", "0");
    const anim = this.play(band.svg, glide, (_, ms) => [clamp01((ms - hb) / (HAND_BACK_MS * BAND_IN_SHARE))], (v) => ({ opacity: num(v[0] ?? 1, 3) }), OPACITY_THIN);
    if (anim) band.anims.push(anim);
    this.leaving.push({ el: g.el, group: g, band: null, at: cue.t, until: cue.t + glide.duration - RELEASE_MS });
    const line = g.line;
    if (line && cue.t >= line.sungBy) this.queueLater(() => line.finish());
  }

  /** A focus line leaving view altogether (no neighbor draws it next): it fades out where it is shown. */
  private fadeGroup(g: Group, glide: Glide, cue: Cue): void {
    const shown = this.shownFrames(g);
    this.stopAnims(g.anims);
    g.anims = [];
    g.motion = null;
    const base = this.baseline * g.size;
    g.words.forEach((wrap, j) => {
      const f = shown.frames[j];
      if (f) put(wrap, "transform", frameTransform(f, g.shape.words[j]?.width ?? 0, base, shown.scale === 1 ? undefined : shown.scale));
    });
    const fade = this.play(g.el, glide, (x) => [1 - clamp01(x / LEAVE_BY)], (v) => ({ opacity: num(v[0] ?? 0, 3) }), OPACITY_THIN);
    if (fade) g.anims.push({ el: g.el, anim: fade });
    put(g.el, "opacity", "0");
    this.leaving.push({ el: g.el, group: g, band: null, at: cue.t, until: cue.t + glide.duration - RELEASE_MS });
  }

  /**
   * Glides a group's words from `from` (scaled by `fromScale` about their frames) to `to`, and its
   * opacity along `opacity`: the words' final frames and the group's final opacity are the caller's
   * to set inline.
   */
  private glideGroup(
    g: Group,
    from: readonly WordFrame[],
    fromScale: number,
    to: readonly WordFrame[],
    toScale: number,
    glide: Glide,
    opacity: (x: number, ms: number) => number,
  ): void {
    this.stopAnims(g.anims);
    g.anims = [];
    g.motion = { spring: glide.spring, from: [...from], fromScale, to: [...to], toScale };
    const base = this.baseline * g.size;
    g.words.forEach((wrap, j) => {
      const a = from[j];
      const b = to[j];
      const width = g.shape.words[j]?.width ?? 0;
      if (!a || !b) return;
      put(wrap, "transform", frameTransform(b, width, base, toScale === 1 ? undefined : toScale));
      const anim = this.play(
        wrap,
        glide,
        (x) => [lerp(a.x, b.x, x), lerp(a.y, b.y, x), lerp(a.angle, b.angle, x), lerp(fromScale, toScale, x)],
        (v) => ({ transform: frameTransform({ x: v[0] ?? 0, y: v[1] ?? 0, angle: v[2] ?? 0 }, width, base, v[3] ?? 1) }),
        FRAME_THIN,
      );
      if (anim) g.anims.push({ el: wrap, anim });
    });
    const fade = this.play(g.el, glide, (x, ms) => [opacity(x, ms)], (v) => ({ opacity: num(v[0] ?? 1, 3) }), OPACITY_THIN);
    if (fade) g.anims.push({ el: g.el, anim: fade });
  }

  /** Where a group's words are drawn right now: along the glide it is on, or in focus. */
  private shownFrames(g: Group): { frames: WordFrame[]; scale: number } {
    const m = g.motion;
    if (!m) return { frames: g.frames, scale: 1 };
    const x = m.spring.state().x;
    if (Math.abs(x - 1) < 1e-4) return { frames: m.to, scale: m.toScale };
    const frames = m.to.map((b, j) => {
      const a = m.from[j] ?? b;
      return { x: lerp(a.x, b.x, x), y: lerp(a.y, b.y, x), angle: lerp(a.angle, b.angle, x) };
    });
    return { frames, scale: lerp(m.fromScale, m.toScale, x) };
  }

  /** An SVG band for placed line `p`: dim and in the background as a neighbor, in the lyric color as an unsynced focus line. */
  private newBand(p: Placed, look: Look, focus = false): Band {
    const line = this.lines[p.i] as Line;
    const id = `ut-arc${this.id}-${++this.builds}-${p.slot.name}`;
    const band = this.band(id, line, p, look);
    // (an unsynced focus line is a band too: `arc-calm`, not the HTML group's `arc-focus`)
    band.svg.classList.add(p.slot.k === 0 ? "arc-calm" : `arc-${p.slot.name}`);
    if (!focus) band.svg.setAttribute("aria-hidden", "true");
    this.paintBand(band, look);
    this.box?.append(band.svg);
    return band;
  }

  private paintBand(band: Band, look: Look): void {
    put(band.svg, "filter", dropShadow(look, band.p.size));
    put(band.text, "fill", band.p.slot.k === 0 ? look.colors.lyric : look.colors.dim);
  }

  /**
   * An SVG band just tall enough for one placed line on its curve, drawn in stage coordinates. It
   * scales around the middle of its curve, where the text is centered. A line longer than its path
   * gets a path that runs on past the screen edges. A right-to-left line is laid out right to left,
   * so punctuation and embedded runs land where its readers expect them.
   */
  private band(id: string, line: Line, p: Placed, look: Look): Band {
    const { size, mid, bend, natural } = p;
    const halfWidth = this.halfWidth(look);
    // a flattened neighbor's path is a little shorter than the shared one
    const length = bend === this.geo.bend ? this.pathLength : 2 * arcLength(halfWidth, halfWidth, bend);
    const extend = natural > length ? (natural - length) / 2 + size : 0;
    // Just big enough for its text and shadow: the filter rasterizes the band's whole box, so a short
    // line on a stage-wide band cost the raster of the stage's width (and the bend's whole height). The
    // text still draws past it if an estimate is short (overflow: visible); a line running off its path
    // keeps the stage's width.
    const r = extend > 0 ? 1 : reach(natural, halfWidth, bend);
    const ends = mid + bend * r * r;
    const pad = BAND_SIDE_PAD * size + BAND_SIDE_PX;
    const xm = this.curveOf(look, mid, bend).xm;
    const left = extend > 0 ? 0 : Math.max(0, Math.floor(xm - r * halfWidth - pad));
    const right = extend > 0 ? look.width : Math.min(look.width, Math.ceil(xm + r * halfWidth + pad));
    const top = snap(Math.min(mid, ends, extend > 0 ? mid + bend : mid) - size * BAND_ABOVE, look.dpr);
    const height = Math.ceil(Math.max(mid, ends, extend > 0 ? mid + bend : mid) + size * BAND_BELOW - top);
    const width = Math.max(1, Math.ceil(right - left));
    const svg = s("svg", { class: "arc-line", width, height, viewBox: `${left} ${top} ${width} ${height}` });
    svg.style.left = `${left}px`;
    svg.style.top = `${top}px`;
    svg.style.transformOrigin = `${(look.width / 2 - left).toFixed(1)}px ${(mid - top).toFixed(1)}px`;
    const path = s("path", { id, d: this.curve(look, mid, bend, extend) });
    const defs = s("defs");
    defs.append(path);
    const text = s("text", { "font-size": size.toFixed(2), "text-anchor": "middle" });
    text.setAttributeNS(XML, "xml:space", "preserve");
    if (look.letterSpacing !== 0) text.setAttribute("letter-spacing", `${num(look.letterSpacing, 3)}em`);
    if (isRtl(line.text)) text.setAttribute("direction", "rtl");
    const textPath = s("textPath", { href: `#${id}`, startOffset: "50%" });
    textPath.setAttributeNS(XLINK, "xlink:href", `#${id}`);
    textPath.textContent = line.text;
    text.append(textPath);
    svg.append(defs, text);
    return { svg, text, p, anims: [] };
  }

  /**
   * The HTML focus line for line `i`: its words in frames on the shared curve, hidden (opacity 0) until
   * it comes into focus; built ahead by schedulePrepare when it can be.
   */
  private newGroup(i: number, look: Look): Group {
    const line = this.lines[i] as Line;
    const size = this.fitted(i, look.size, look);
    const shape = this.shapeOf(i, size, look);
    const frames = wordFrames(this.curveOf(look, this.geo.mid, this.geo.bend), shape.words, shape.total);
    const el = h("div", "arc-focus kw-host");
    el.style.fontSize = `${size.toFixed(2)}px`;
    if (look.letterSpacing !== 0) el.style.letterSpacing = `${num(look.letterSpacing, 3)}em`;
    paintVars(el, look, size);
    put(el, "opacity", "0");
    const base = this.baseline * size;
    const words: HTMLElement[] = [];
    const boxes: HTMLElement[] = [];
    line.words.forEach((w, j) => {
      const wrap = h("div", "arc-word");
      wrap.dir = "auto";
      const kw = h("span", "kw");
      kw.append(h("span", "kw-txt", w.text.trimEnd()));
      wrap.append(kw);
      const f = frames[j];
      if (f) put(wrap, "transform", frameTransform(f, shape.words[j]?.width ?? 0, base));
      el.append(wrap);
      words.push(wrap);
      boxes.push(kw);
    });
    this.box?.append(el);
    return { i, el, words, boxes, size, shape, frames, line: null, anims: [], motion: null };
  }

  /** Line `i`'s focus group: the one prepared ahead if it is that line's, else a new one. */
  private takeGroup(i: number, look: Look): Group {
    const ready = this.prepared;
    this.prepared = null;
    if (ready?.i === i) return ready;
    if (ready) this.dropGroup(ready);
    return this.newGroup(i, look);
  }

  /** Its karaoke: every letter placed on the shared curve. */
  private karaokeFor(g: Group, look: Look): KaraokeLine {
    const line = this.lines[g.i] as Line;
    const curve = this.curveOf(look, this.geo.mid, this.geo.bend);
    const metrics = { baseline: this.baseline * g.size, lineHeight: LINE_HEIGHT * g.size, spacing: look.letterSpacing * g.size };
    return new KaraokeLine(
      line.words,
      g.boxes,
      {
        size: g.size,
        font: this.fontAt(look, g.size),
        letterSpacingPx: look.letterSpacing * g.size,
        lineHeight: LINE_HEIGHT,
        params: this.params ?? motionParams(look),
        place: arcPlacer(curve, g.shape.words, g.frames, g.shape.total, metrics),
        steps: this.steps,
      },
      this.timeline,
      `kw${g.i}.${++this.serial}`,
    );
  }

  /** The group comes into focus at `cue`: its overlay shows and its karaoke starts. */
  private focusOn(g: Group, cue: Cue, look: Look): void {
    g.el.classList.add("has-fx");
    g.line ??= this.karaokeFor(g, look);
    g.line.mount(cue.t, cue.running);
  }

  /** New motion parameters: the focus line planned again at the current time, the next one again ahead. */
  private replan(look: Look): void {
    if (this.prepared) this.dropGroup(this.prepared);
    this.prepared = null;
    const t = this.timeline.position();
    const g = this.drawn?.group;
    if (g) {
      g.line?.destroy();
      g.line = this.karaokeFor(g, look);
      g.line.mount(t, false);
    }
    const view = this.views[this.target];
    const dots = this.drawn?.dots;
    if (view?.kind === "break" && dots) dots.until = dots.dots.play(dots.il, this.timeline, this.params ?? motionParams(look), `dots${dots.il.start}`, this.steps);
    this.schedulePrepare();
  }

  /** The line that comes into focus after the one on screen (a break's: the line it leads into). */
  private nextLine(): number {
    const view = this.views[this.target];
    if (!view) return -1;
    const i = view.kind === "line" ? view.i + 1 : view.il.next;
    return i < this.lines.length ? i : -1;
  }

  /**
   * Builds the next focus line (hidden) and plans its words ahead, in idle slices of SLICE_MS starting
   * once this line's own mount has finished, so the next line change only has animations to start.
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
      if (this.drawn?.group?.line?.mounting) {
        this.prepareTimer = setTimeout(step, PREPARE_GAP_MS);
        return;
      }
      const i = this.nextLine();
      if (i < 0 || this.drawn?.group?.i === i) return;
      const current = this.look ?? look;
      if (this.prepared?.i !== i) {
        if (this.prepared) this.dropGroup(this.prepared);
        const g = this.newGroup(i, current);
        g.line = this.karaokeFor(g, current);
        this.prepared = g;
      }
      if (!this.prepared.line?.prepare(SLICE_MS, this.leads[i])) this.prepareTimer = setTimeout(step, PREPARE_GAP_MS);
    };
    this.prepareTimer = setTimeout(step, PREPARE_DELAY_MS);
  }

  /** After a seek that kept the view: the focus line re-lit if its animations no longer cover the time, a break's dots likewise. */
  private refreshFocus(cue: Cue, look: Look): void {
    const dots = this.drawn?.dots;
    if (dots) {
      if (!this.timeline.busy(`dots${dots.il.start}`, cue.t)) dots.until = dots.dots.play(dots.il, this.timeline, this.params ?? motionParams(look), `dots${dots.il.start}`, this.steps);
      return;
    }
    const line = this.drawn?.group?.line;
    if (line && !line.covers(cue.t)) line.mount(cue.t, false);
  }

  /** The break's dots at the curve's apex, anchored to its start (a seek into the middle of a break joins it there). */
  private startDots(il: Interlude, look: Look): Dots {
    const host = h("div", "arc-dots");
    host.style.top = `${(this.geo.mid - DOTS_RISE * look.size).toFixed(2)}px`;
    paintVars(host, look, look.size);
    this.box?.append(host);
    const dots = new InterludeDots(host, DOTS.em * look.size);
    const until = dots.play(il, this.timeline, this.params ?? motionParams(look), `dots${il.start}`, this.steps);
    return { host, dots, il, until };
  }

  private stopDots(d: Dots): void {
    d.dots.stop();
    d.host.remove();
  }

  // ---------- taking down ----------

  /** Drops lines that have left (their glides are over, or the song went back before they left) and lets go of the glides at rest. */
  private tidy(cue: Cue): void {
    if (this.leaving.length === 0) return;
    let dropped = false;
    this.leaving = this.leaving.filter((l) => {
      if (cue.t >= l.at && cue.t < l.until) return true;
      this.dropLeaving(l);
      dropped = true;
      return false;
    });
    // the view has come to rest: the same frame lets go of its glides (every element holds its final style)
    if (dropped && this.glideEnd > 0 && perfNow() >= this.glideEnd - 2 * RELEASE_MS) {
      for (const band of [this.drawn?.prev, this.drawn?.next, this.drawn?.calm]) {
        if (!band) continue;
        this.stopAnims(band.anims.map((anim) => ({ el: band.svg, anim })));
        band.anims = [];
      }
      const g = this.drawn?.group;
      if (g) {
        this.stopAnims(g.anims);
        g.anims = [];
        g.motion = null;
      }
      this.glideEnd = 0;
    }
  }

  private dropLeaving(l: Leaving): void {
    if (l.group) this.dropGroup(l.group);
    if (l.band) this.dropBand(l.band);
  }

  private dropGroup(g: Group): void {
    this.stopAnims(g.anims);
    g.anims = [];
    g.motion = null;
    g.line?.destroy();
    g.line = null;
    g.el.remove();
  }

  private dropBand(band: Band): void {
    this.stopAnims(band.anims.map((anim) => ({ el: band.svg, anim })));
    band.anims = [];
    band.svg.remove();
  }

  private clearDrawn(d: Drawn): void {
    for (const band of [d.prev, d.next, d.calm]) if (band) this.dropBand(band);
    if (d.group) this.dropGroup(d.group);
    if (d.dots) this.stopDots(d.dots);
  }

  private stopAnims(anims: readonly { el: Element; anim: Animation }[]): void {
    for (const { anim } of anims) {
      try {
        anim.cancel();
      } catch {
        // already gone
      }
    }
  }

  private commitAnims(anims: readonly { el: Element; anim: Animation }[]): void {
    for (const { el, anim } of anims) commit(anim, el);
  }

  /** Every band on screen or on its way out. */
  private bands(): Band[] {
    const d = this.drawn;
    const out: Band[] = [];
    for (const band of [d?.prev, d?.next, d?.calm]) if (band) out.push(band);
    for (const l of this.leaving) if (l.band) out.push(l.band);
    return out;
  }

  /** Every focus group: on screen, on its way out, or prepared. */
  private groups(): Group[] {
    const out: Group[] = [];
    if (this.drawn?.group) out.push(this.drawn.group);
    for (const l of this.leaving) if (l.group) out.push(l.group);
    if (this.prepared) out.push(this.prepared);
    return out;
  }

  /** Runs `job` on the next frame (after the change's own), in order with any others. */
  private queueLater(job: () => void): void {
    this.later.push(job);
    if (this.cancelLater) return;
    this.cancelLater = nextFrame(() => {
      this.cancelLater = null;
      if (this.destroyed) return;
      for (const j of this.later.splice(0)) j();
    });
  }

  /** Every job still waiting, now: before another line change, a cut, or the stage's still copy. */
  private flushLater(): void {
    this.cancelLater?.();
    this.cancelLater = null;
    for (const job of this.later.splice(0)) job();
  }
}

/** Two placements of a line that draw it identically. */
function same(a: Placed, b: Placed): boolean {
  return Math.abs(a.mid - b.mid) < 0.01 && Math.abs(a.size - b.size) < 0.001 && Math.abs(a.bend - b.bend) < 0.01;
}

export function createArc(): ModeRenderer {
  return new ArcMode();
}
