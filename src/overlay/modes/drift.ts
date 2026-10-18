import type { Line } from "../../core/lrc";
import { h, put } from "../dom";
import { MIN_TEXT_PX, rgba, snap, textShadow, type Look } from "../look";
import { bloomShadow, dotBloom } from "../motion/bloom";
import { clamp01 } from "../motion/curve";
import { findInterludes, interludeAt, planDots, type Interlude } from "../motion/interlude";
import { PLAN_MS, songEnergy, type Track } from "../motion/karaoke";
import { compositorSteps, keyframesAt, num, sampleTimes, thin } from "../motion/keyframes";
import { KaraokeLine } from "../motion/line";
import { Glide, type SpringSpec, type SpringState } from "../motion/spring";
import { SongTimeline } from "../motion/timeline";
import type { Cue, ModeRenderer } from "./types";

/** Line box height in font sizes (`.drift-row` in styles/stage.css). */
const LINE_HEIGHT = 1.12;
/** Distance between the centers of two one-row lines, in font sizes, from the prototype. */
const PITCH = 1.15;
/** Drift's neighbors shrink to this share of the focus size (prototype)... */
const NEIGHBOR_SCALE = 0.58;
/** ...Stack's stay nearly whole: lines read as one list, told apart by brightness and blur. */
const STACK_NEIGHBOR_SCALE = 0.8;
/** ...but no smaller than MIN_TEXT_PX on screen, as long as that takes at most this share. */
const NEIGHBOR_MAX_SCALE = 0.85;
/** Least room between the focus line and a one-row neighbor, in font sizes, however large neighbors get. */
const MIN_GAP = 0.265;
/** Drift's depth: the perspective distance, and how far back each line of distance steps, in font sizes. */
const PERSPECTIVE = 15.5;
const RECEDE = 2.4;
/** Degrees a line tilts per line of distance. */
const TILT = 14;
/** Lines further than this from the focus are hidden. */
const REACH = 3.5;
/** A wrapped line taller than this share of the stage is set smaller so it fits. */
const MAX_ROW_SHARE = 0.45;
/**
 * Room kept between the focus line's box and the stage edges, in font sizes. resolveLook keeps a
 * one-row line's center 0.75 sizes from the edges: half its box plus this. A taller wrapped line
 * moves the whole stack inward to keep the same room.
 */
const EDGE_PAD = 0.75 - LINE_HEIGHT / 2;
/** A jump further than this many lines (a seek) cuts instead of scrolling through every line. */
const MAX_GLIDE = 3;
/** The list follows the song with an underdamped spring: a soft overshoot, then it settles. */
const SCROLL_SPRING: SpringSpec = { hz: 1.45, damping: 0.68 };
/** Unsynced lyrics move calmly: no overshoot. */
const CALM_SPRING: SpringSpec = { hz: 0.75, damping: 1 };
/** Brightness of the lines next to the focus: sung lines stay a little brighter than upcoming ones. */
const SUNG_LEVEL = 0.58;
const UPCOMING_LEVEL = 0.46;
/** Blur per line of distance, in font sizes (1.25 px at 56 px), up to BLUR_STEPS lines. */
const BLUR_EM = 0.0223;
const BLUR_STEPS = 4;
/** An instrumental break's slot (the dots) is this tall, in font sizes, and its dots this wide. */
const BREAK_EM = 1.05;
const DOT_EM = 0.4;
/** A jump of the song further than this is a seek: the focus line's words are put straight. */
const SEEK_MS = 250;
/** A line leaving focus keeps its overlay this long, while it fades back to plain text. */
const LEAVE_MS = 420;
/** The next line is prepared this long after a line change, once that change's frames are out. */
const PREPARE_DELAY_MS = 600;

interface Row {
  el: HTMLDivElement;
  /** the `.kw` box of each word */
  words: HTMLElement[];
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
  dots: HTMLElement[];
  glows: HTMLElement[];
  group: HTMLElement | null;
  /** song time its dots' motion ends */
  until: number;
  played: boolean;
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
 * Scale of the lines around the focus: `base` (Drift's NEIGHBOR_SCALE by default), raised at small
 * sizes so they still draw MIN_TEXT_PX tall once Drift's depth has pushed them back.
 */
export function neighborScale(size: number, depth: number, base = NEIGHBOR_SCALE): number {
  const recede = PERSPECTIVE / (PERSPECTIVE + RECEDE * depth);
  return Math.min(Math.max(NEIGHBOR_MAX_SCALE, base), Math.max(base, MIN_TEXT_PX / (size * recede)));
}

/**
 * Each line's slot, per px of its box height: PITCH for one row, widened when neighbors are larger
 * than NEIGHBOR_SCALE so a one-row neighbor still keeps MIN_GAP from a one-row focus line. A line
 * never draws taller than its slot, so lines never overlap, however many rows they wrap to.
 */
export function slotPerPx(low: number): number {
  return Math.max(PITCH, (LINE_HEIGHT / 2) * (1 + low) + MIN_GAP) / LINE_HEIGHT;
}

/** How much a line `dist` lines from the focus shrinks on screen from Drift's depth (1 for Stack). */
export function projection(dist: number, depth: number): number {
  return PERSPECTIVE / (PERSPECTIVE + RECEDE * depth * dist);
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

/** Brightness of a line `off` lines from the focus (negative: already sung). */
export function lineLevel(off: number): number {
  const d = Math.abs(off);
  if (d >= REACH) return 0;
  const near = off < 0 ? SUNG_LEVEL : UPCOMING_LEVEL;
  if (d <= 1) return 1 - (1 - near) * d;
  return near * (1 - (d - 1) / (REACH - 1));
}

/**
 * Drift: the song as a vertical list that springs up one line at a time, neighbors receding in 3D.
 * Stack is the same list flat (`depth` 0), its neighbors nearly full size. Lines around the focus are
 * dimmer and softer the further away they are; the focus line sings karaoke (motion/line.ts); long
 * instrumental breaks show three filling dots where the next line will be.
 *
 * Nearly everything moves on the compositor: every motion is planned as keyframes when it begins
 * (a line change, a word start, a break) and anchored to song time by a SongTimeline. Between word
 * starts the page does nothing; paint asks for frames only while the clock slews.
 */
export class DriftMode implements ModeRenderer {
  /** Nothing happens at a word boundary that the compositor isn't already drawing: sleep through them. */
  readonly wordWakes = false;
  private readonly depth: number;
  private readonly timeline = new SongTimeline();
  /** slow motion steps on the song-time beat where the engine composites stepped keyframes */
  private readonly steps = compositorSteps();
  private look: Look | null = null;
  private box: HTMLDivElement | null = null;
  private rows: Row[] = [];
  private breaks: Break[] = [];
  private slots: Slot[] = [];
  private specs: SlotSpec[] = [];
  private slotOfLine: number[] = [];
  private interludes: Interlude[] = [];
  private energy = 0.4;
  /** the slot in focus, -1 before the first paint */
  private target = -1;
  /** the scroll spring in flight (slot units), and the song time it was released at */
  private glide: Glide | null = null;
  private glideAt = 0;
  private karaoke: { line: KaraokeLine; row: Row } | null = null;
  /** the next line's overlay and plans, made ahead in a task of their own */
  private prepared: { line: KaraokeLine; row: Row } | null = null;
  private prepareTimer: ReturnType<typeof setTimeout> | null = null;
  private leaving: { line: KaraokeLine; row: Row; at: number }[] = [];
  private lastT = Number.NaN;
  private lastRunning = false;

  constructor(depth: number) {
    this.depth = depth;
  }

  /**
   * The stage crossfades the cut under reduced motion; while paused (a scroll needs the clock to run);
   * and on a jump further than MAX_GLIDE lines (a seek, a repeated song starting over). Not when the
   * song ends: the stack fades out by itself.
   */
  crossfades(next: Cue): boolean {
    const look = this.look;
    if (!look) return false;
    if (!look.motion || !next.running) return true;
    return next.line >= 0 && this.target >= 0 && Math.abs(next.line - this.focusLine()) > MAX_GLIDE;
  }

  build(host: HTMLElement, lines: readonly Line[], look: Look): void {
    this.destroy();
    this.look = look;
    host.textContent = "";
    const box = h("div", "drift");
    box.style.fontFamily = look.font;
    box.style.fontWeight = String(look.weight);
    box.style.fontSize = `${look.size}px`;
    box.style.perspective = `${look.size * PERSPECTIVE}px`;
    // Recede toward the focus line, not the middle of the stage: with the vanishing point elsewhere,
    // lines on the far side of it would fold back over the focus line at a high or low Height.
    box.style.perspectiveOrigin = `50% ${look.y.toFixed(1)}px`;
    if (look.unsynced) box.classList.add("is-calm");
    this.interludes = look.unsynced ? [] : findInterludes(lines);
    this.energy = songEnergy(lines);
    this.rows = lines.map((line, index) => {
      const el = h("div", "drift-row");
      el.dir = "auto";
      el.style.top = `${look.y}px`;
      const words: HTMLElement[] = [];
      for (const w of line.words) {
        const text = w.text.trimEnd();
        const word = h("span", "kw");
        word.append(h("span", "kw-txt", text));
        el.append(word);
        // the space between words sits outside the word boxes, where line breaking can use it
        if (text !== w.text) el.append(h("span", "", " "));
        words.push(word);
      }
      put(el, "visibility", "hidden");
      box.append(el);
      return { el, words, line, index, size: look.size, box: 0, height: 0, state: "" };
    });
    this.breaks = this.interludes.map((il) => {
      const el = h("div", "drift-break");
      el.style.top = `${look.y}px`;
      el.style.height = `${(BREAK_EM * look.size).toFixed(2)}px`;
      put(el, "visibility", "hidden");
      box.append(el);
      return { el, il, dots: [], glows: [], group: null, until: 0, played: false };
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

  restyle(look: Look): void {
    this.look = look;
    const box = this.box;
    if (!box) return;
    box.style.setProperty("--ut-lyric", look.colors.lyric);
    box.style.setProperty("--ut-hl", look.colors.highlight);
    box.style.setProperty("--ut-dim", look.colors.dim);
    box.style.setProperty("--ut-bloom", bloomShadow(look.colors.highlight, look.glow));
    box.style.setProperty("--ut-bloom-strong", bloomShadow(look.colors.highlight, look.glow, true));
    box.style.setProperty("--ut-dot-bloom", dotBloom(look.colors.highlight, look.glow, DOT_EM * look.size));
    box.style.color = look.colors.dim;
    box.style.textShadow = textShadow(look, look.size);
    for (const row of this.rows) {
      const state = row.state;
      row.state = "";
      if (state) this.styleRow(row, state);
    }
  }

  paint(cue: Cue): boolean {
    const look = this.look;
    const box = this.box;
    if (!look || !box) return false;
    const sync = this.timeline.sync({ t: cue.t, running: cue.running, rate: cue.rate ?? (cue.running ? 1 : 0) });
    const jumped = Number.isNaN(this.lastT) ? false : cue.running && this.lastRunning ? Math.abs(sync.moved) > SEEK_MS : cue.t !== this.lastT;
    this.lastT = cue.t;
    this.lastRunning = cue.running;
    put(box, "opacity", cue.line < 0 ? "0" : "1");
    if (cue.line < 0) return false;

    const focus = this.focusSlot(cue);
    if (focus !== this.target) this.moveTo(focus, cue, look);
    else if (!cue.running && this.glide) this.land(look);
    else if (jumped) this.refreshFocus(cue);
    this.tidy(cue);
    this.timeline.prune(cue.t);
    return sync.slewing && cue.running;
  }

  /** Song ms until this mode needs a paint that no word boundary brings: the next break starting. */
  nextChange(t: number): number {
    let next = Infinity;
    for (const il of this.interludes) if (il.start > t) next = Math.min(next, il.start - t);
    for (const l of this.leaving) next = Math.min(next, Math.max(0, l.at + LEAVE_MS - t));
    return next;
  }

  destroy(): void {
    this.timeline.cancel();
    if (this.prepareTimer) clearTimeout(this.prepareTimer);
    this.prepareTimer = null;
    this.prepared?.line.destroy();
    this.prepared = null;
    this.karaoke?.line.destroy();
    this.karaoke = null;
    for (const l of this.leaving) l.line.destroy();
    this.leaving = [];
    this.glide = null;
    this.box?.remove();
    this.box = null;
    this.rows = [];
    this.breaks = [];
    this.slots = [];
    this.specs = [];
  }

  /** The lyric line the list is on (a break counts as the line it leads into). */
  private focusLine(): number {
    const slot = this.slots[this.target];
    if (!slot) return -1;
    return slot.kind === "line" ? slot.row.index : slot.brk.il.next;
  }

  /** The slot to bring into focus at `cue`: a break while one plays, else the cue's line. */
  private focusSlot(cue: Cue): number {
    const il = interludeAt(this.interludes, cue.t);
    if (il) {
      const at = this.slots.findIndex((s) => s.kind === "break" && s.brk.il === il);
      if (at >= 0) return at;
    }
    return this.slotOfLine[cue.line] ?? -1;
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
    return neighborScale(look.size, this.depth, this.depth > 0 ? NEIGHBOR_SCALE : STACK_NEIGHBOR_SCALE);
  }

  /**
   * Every slot's transform and opacity with the list scrolled to `shown`, for the slots within reach.
   * A tall focus line moves the whole list away from the edge it would run off.
   */
  private layout(shown: number, look: Look): Map<number, { transform: string; opacity: number; off: number }> {
    const depth = this.depth;
    const low = this.low(look);
    const placed = placeSlots(this.specs, shown, depth, slotPerPx(low));
    const n = this.slots.length;
    const lo = Math.max(0, Math.min(n - 1, Math.floor(shown)));
    const hLo = this.specs[lo]?.height ?? 0;
    const hHi = this.specs[lo + 1]?.height ?? hLo;
    const half = (hLo + (hHi - hLo) * (shown - lo)) / 2;
    const room = half + look.size * EDGE_PAD;
    const center = room * 2 > look.height ? look.height / 2 : Math.min(look.height - room, Math.max(room, look.y));
    const shift = center - look.y;
    const zUnit = look.size * RECEDE * depth;
    const out = new Map<number, { transform: string; opacity: number; off: number }>();
    for (const [i, p] of placed) {
      const slot = this.slots[i];
      if (!slot) continue;
      const dist = Math.abs(p.off);
      const scale = 1 - Math.min(dist, 1) * (1 - low);
      const box = slot.kind === "line" ? slot.row.box || slot.row.height : BREAK_EM * look.size;
      // `at` is where the slot should appear; the perspective (its origin on look.y) pulls a slot
      // `dist` lines back toward look.y by projection(dist), so place it that much further out.
      const y = snap(shift + p.at, look.dpr) / projection(dist, depth) - box / 2;
      const transform = `translate3d(0px, ${num(y, 2)}px, ${num(-dist * zUnit, 1)}px) rotateX(${num(-p.off * TILT * depth, 2)}deg) scale(${num(scale, 4)})`;
      out.set(i, { transform, opacity: slot.kind === "line" ? lineLevel(p.off) : 1, off: p.off });
    }
    return out;
  }

  /** Brings slot `focus` into focus: springs the list there (or cuts), and hands the karaoke over. */
  private moveTo(focus: number, cue: Cue, look: Look): void {
    const from = this.target;
    const fromLine = this.focusLine();
    this.target = focus;
    const slot = this.slots[focus];
    const line = slot ? (slot.kind === "line" ? slot.row.index : slot.brk.il.next) : -1;
    const glide = look.motion && cue.running && from >= 0 && Math.abs(line - fromLine) <= MAX_GLIDE;
    this.timeline.cancel("scroll");
    if (glide) {
      const now: SpringState = this.glide ? this.glide.at(cue.t - this.glideAt) : { x: from, v: 0 };
      this.glide = new Glide(now, focus, look.unsynced ? CALM_SPRING : SCROLL_SPRING);
      this.glideAt = cue.t;
      this.scroll(look);
    } else {
      this.glide = null;
      this.settle(look);
    }
    this.restate(cue);
  }

  /** Paused mid-scroll: no frame follows, so land where the list was headed. */
  private land(look: Look): void {
    this.timeline.cancel("scroll");
    this.glide = null;
    this.settle(look);
  }

  /** The list at rest on the focus slot: every slot's own style, nothing animated. */
  private settle(look: Look): void {
    const layout = this.layout(this.target, look);
    this.slots.forEach((slot, i) => {
      const el = slot.kind === "line" ? slot.row.el : slot.brk.el;
      const at = layout.get(i);
      if (!at) {
        put(el, "visibility", "hidden");
        return;
      }
      put(el, "visibility", "visible");
      put(el, "transform", at.transform);
      put(el, "opacity", num(at.opacity, 3));
    });
  }

  /**
   * The scroll as keyframes: the spring sampled from release to rest, and every slot it moves laid
   * out at each sample. Slots end on the same style settle() gives them.
   */
  private scroll(look: Look): void {
    const glide = this.glide;
    if (!glide) return;
    const duration = Math.min(2600, Math.max(200, glide.settle(0.002)));
    const times = sampleTimes(duration, PLAN_MS);
    const frames = times.map((ms) => this.layout(glide.at(ms).x, look));
    const final = this.layout(this.target, look);
    this.slots.forEach((slot, i) => {
      const el = slot.kind === "line" ? slot.row.el : slot.brk.el;
      const seen = frames.some((f) => f.has(i)) || final.has(i);
      if (!seen) {
        put(el, "visibility", "hidden");
        return;
      }
      put(el, "visibility", "visible");
      const end = final.get(i);
      put(el, "opacity", num(end?.opacity ?? 0, 3));
      if (end) put(el, "transform", end.transform);
      // where a slot is out of reach at a sample, it holds its nearest known place at no opacity
      let last = end?.transform ?? frames.find((f) => f.has(i))?.get(i)?.transform ?? "none";
      const transforms: string[] = new Array<string>(times.length);
      for (let k = times.length - 1; k >= 0; k--) {
        const at = frames[k]?.get(i);
        if (at) last = at.transform;
        transforms[k] = last;
      }
      const opacity = frames.map((f) => f.get(i)?.opacity ?? 0);
      // thin on the opacity and on the (numeric) vertical position, which is what moves
      const ys = transforms.map((t) => Number(/translate3d\(0px, (-?[\d.]+)px/u.exec(t)?.[1] ?? 0));
      const keep = thin(times, [ys, opacity], [0.25, 0.004]);
      const track: Track = {
        t0: this.glideAt,
        duration,
        frames: keyframesAt(times, keep, (k) => ({ transform: transforms[k] ?? "none", opacity: num(opacity[k] ?? 0, 3) })),
      };
      this.timeline.play(el, track.frames, track.t0, track.duration, "scroll");
    });
  }

  /** Row states around the new focus, the karaoke handed to the focus line, the break's dots started. */
  private restate(cue: Cue): void {
    const look = this.look;
    if (!look) return;
    const focusSlot = this.slots[this.target];
    const focusRow = focusSlot?.kind === "line" ? focusSlot.row : null;
    const layout = this.layout(this.target, look);
    // the line leaving focus fades back to plain text, then drops its overlay
    if (this.karaoke && this.karaoke.row !== focusRow) {
      const { line, row } = this.karaoke;
      row.el.classList.remove("has-fx");
      this.leaving.push({ line, row, at: cue.t });
      this.karaoke = null;
    }
    this.slots.forEach((slot, i) => {
      if (slot.kind !== "line") return;
      const row = slot.row;
      const off = layout.get(i)?.off;
      const state = row === focusRow ? "focus" : off === undefined ? (i < this.target ? "past" : "up") : off < 0 ? `past:${blurStep(off)}` : `up:${blurStep(off)}`;
      this.styleRow(row, state);
    });
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
    if (focusSlot?.kind === "break") this.startBreak(focusSlot.brk, cue, look);
    this.schedulePrepare();
  }

  private karaokeFor(row: Row, look: Look): KaraokeLine {
    return new KaraokeLine(
      row.line.words,
      row.words,
      { size: row.size, font: `${look.weight} ${row.size.toFixed(2)}px ${look.font}`, motion: look.motion, energy: this.energy, steps: this.steps },
      this.timeline,
      `kw${row.index}`,
    );
  }

  /**
   * Builds the next line's overlay (hidden until it is in focus) and plans its words a moment after
   * this line change, in a task of its own, so the next change only has animations to start.
   */
  private schedulePrepare(): void {
    if (this.prepareTimer) clearTimeout(this.prepareTimer);
    this.prepareTimer = null;
    const look = this.look;
    if (!look || look.unsynced || typeof setTimeout !== "function") return;
    const box = this.box;
    this.prepareTimer = setTimeout(() => {
      this.prepareTimer = null;
      if (this.box !== box || !box) return;
      const slot = this.slots[this.target];
      const next = slot ? this.rows[(slot.kind === "line" ? slot.row.index : slot.brk.il.next - 1) + 1] : undefined;
      if (!next || next === this.prepared?.row || next === this.karaoke?.row || next.line.words.length === 0) return;
      this.prepared?.line.destroy();
      const line = this.karaokeFor(next, look);
      line.prepare();
      this.prepared = { line, row: next };
    }, PREPARE_DELAY_MS);
  }

  /** After a seek that kept the focus: the focus line's words and the break's dots to the new time. */
  private refreshFocus(cue: Cue): void {
    // the focus line's animations span the whole line: the song timeline has already moved them
    const slot = this.slots[this.target];
    const look = this.look;
    if (slot?.kind === "break" && look) {
      slot.brk.played = false;
      this.startBreak(slot.brk, cue, look);
    }
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
    if (focus) {
      put(row.el, "color", look.colors.lyric);
      put(row.el, "text-shadow", shadow);
    } else {
      const step = Number(state.split(":")[1] ?? BLUR_STEPS);
      const blur = Math.max(0.6, step * BLUR_EM * row.size);
      put(row.el, "color", "transparent");
      put(row.el, "text-shadow", `0 0 ${blur.toFixed(2)}px ${rgba(look.colors.dim, 1)}, ${shadow}`);
    }
    // Out of focus every word stands at full size; the focus line's karaoke poses its own words.
    if (!focus && was !== "" && was !== "focus") return;
    if (!focus) for (const w of row.words) put(w, "transform", "none");
  }

  /** The break's dots, anchored to its start (a seek into the middle of a break joins it there). */
  private startBreak(brk: Break, cue: Cue, look: Look): void {
    if (brk.played && this.timeline.busy(`dots${brk.il.start}`, cue.t)) return;
    this.timeline.cancel(`dots${brk.il.start}`);
    const dotPx = DOT_EM * look.size;
    if (!brk.group) {
      const group = h("div", "ut-dots");
      group.setAttribute("aria-hidden", "true");
      for (let d = 0; d < 3; d++) {
        const dot = h("i", "ut-dot");
        dot.style.width = `${dotPx.toFixed(2)}px`;
        dot.style.height = `${dotPx.toFixed(2)}px`;
        const glow = h("b");
        dot.append(glow);
        group.append(dot);
        brk.dots.push(dot);
        brk.glows.push(glow);
      }
      group.style.gap = `${(dotPx * 0.55).toFixed(2)}px`;
      brk.el.append(group);
      brk.group = group;
    }
    const plan = planDots(brk.il, dotPx, look.motion, this.steps);
    const key = `dots${brk.il.start}`;
    const group = brk.group;
    // at rest (outside the break) the group is gone
    put(group, "transform", "scale(0)");
    put(group, "opacity", "0");
    this.timeline.play(group, plan.group.transform.frames, plan.group.transform.t0, plan.group.transform.duration, key);
    this.timeline.play(group, plan.group.opacity.frames, plan.group.opacity.t0, plan.group.opacity.duration, key);
    plan.dots.forEach((track, d) => {
      const dot = brk.dots[d];
      if (dot) this.timeline.play(dot, track.frames, track.t0, track.duration, key);
    });
    plan.glows.forEach((track, d) => {
      const glow = brk.glows[d];
      if (glow) this.timeline.play(glow, track.frames, track.t0, track.duration, key);
    });
    brk.until = plan.until;
    brk.played = true;
  }

  /** Drops overlays that have faded out, and dots whose break is over. */
  private tidy(cue: Cue): void {
    if (this.leaving.length > 0) {
      this.leaving = this.leaving.filter((l) => {
        if (cue.running && cue.t < l.at + LEAVE_MS && cue.t >= l.at) return true;
        l.line.destroy();
        const state = l.row.state;
        l.row.state = "";
        this.styleRow(l.row, state);
        return false;
      });
    }
    for (const brk of this.breaks) {
      if (brk.group && (cue.t >= brk.until || cue.t < brk.il.start) && this.slots[this.target]?.kind !== "break") {
        this.timeline.cancel(`dots${brk.il.start}`);
        brk.group.remove();
        brk.group = null;
        brk.dots = [];
        brk.glows = [];
        brk.played = false;
      }
    }
  }
}

/** Blur steps for a line `off` lines from the focus. */
function blurStep(off: number): number {
  return Math.min(BLUR_STEPS, Math.max(1, Math.round(Math.abs(off))));
}

export function createDrift(depth: number): ModeRenderer {
  return new DriftMode(depth);
}
