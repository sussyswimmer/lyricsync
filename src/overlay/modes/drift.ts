import type { Line } from "../../core/lrc";
import { wordState } from "../../core/timing";
import { h, put } from "../dom";
import { MIN_TEXT_PX, snap, textShadow, type Look } from "../look";
import type { Cue, ModeRenderer } from "./types";

/** Line box height in font sizes (`.drift-row` in styles/stage.css). */
const LINE_HEIGHT = 1.12;
/** Distance between the centers of two one-row lines, in font sizes, from the prototype. */
const PITCH = 1.15;
/** Neighbors shrink to this share of the focus size (prototype)... */
const NEIGHBOR_SCALE = 0.58;
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
/** Scroll time to the next line; slower for unsynced lyrics. */
const EASE_MS = 520;
const CALM_EASE_MS = 900;
/** A jump further than this (a seek) cuts instead of scrolling through every line. */
const MAX_GLIDE = 3;

interface Row {
  el: HTMLDivElement;
  spans: HTMLSpanElement[];
  line: Line;
  /** font size, px: the look's, or less for a line that would wrap taller than the stage allows */
  size: number;
  /** measured box height at full scale, px */
  height: number;
  /** text-shadow of this row's active word */
  glow: string;
}

const easeInOut = (x: number): number => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

/**
 * Scale of the lines around the focus: NEIGHBOR_SCALE, raised at small sizes so they still draw
 * MIN_TEXT_PX tall once Drift's depth has pushed them back.
 */
export function neighborScale(size: number, depth: number): number {
  const recede = PERSPECTIVE / (PERSPECTIVE + RECEDE * depth);
  return Math.min(NEIGHBOR_MAX_SCALE, Math.max(NEIGHBOR_SCALE, MIN_TEXT_PX / (size * recede)));
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
 * Where each line's center lands on screen, in px from the focus position, with the song scrolled to
 * `shown` (fractional while gliding). Lines stack slot after slot, each slot its box height times
 * `perPx`, shrunk by the line's own depth projection, so lines further back sit closer together the
 * way a receding surface does, and none ever overlaps another. Only lines within REACH get a place.
 */
export function stackOffsets(heights: readonly number[], shown: number, depth: number, perPx: number): Map<number, number> {
  const out = new Map<number, number>();
  const n = heights.length;
  if (n === 0) return out;
  const lo = Math.max(0, Math.min(n - 1, Math.floor(shown)));
  const frac = Math.max(0, Math.min(1, shown - lo));
  const first = Math.max(0, Math.ceil(shown - REACH));
  const last = Math.min(n - 1, Math.floor(shown + REACH));
  const slot = (i: number): number => (heights[i] ?? 0) * perPx * projection(Math.abs(i - shown), depth);
  const at = new Map<number, number>([[lo, 0]]);
  for (let i = lo + 1; i <= Math.max(last, lo + 1) && i < n; i++) at.set(i, (at.get(i - 1) ?? 0) + (slot(i - 1) + slot(i)) / 2);
  for (let i = lo - 1; i >= first; i--) at.set(i, (at.get(i + 1) ?? 0) - (slot(i) + slot(i + 1)) / 2);
  const center = (at.get(lo + 1) ?? 0) * frac;
  for (let i = first; i <= last; i++) out.set(i, (at.get(i) ?? 0) - center);
  return out;
}

/**
 * Drift: the song as a vertical stack that glides up one line at a time, with neighbors receding in
 * 3D. Stack is the same with `depth` 0. Every line is built once; a frame only moves rows and
 * recolors words of the focus line.
 */
export class DriftMode implements ModeRenderer {
  private readonly depth: number;
  private look: Look | null = null;
  private box: HTMLDivElement | null = null;
  private rows: Row[] = [];
  /** each row's `height`, for the per-frame layout */
  private heights: number[] = [];
  private shown = 0;
  private from = 0;
  private target = -1;
  private startedAt = 0;
  /** whether the last paint was during playback */
  private running = true;

  constructor(depth: number) {
    this.depth = depth;
  }

  /**
   * The stage crossfades line changes under reduced motion, and while paused: a glide needs frames,
   * and none follow a paused paint, so Drift cuts and the crossfade covers it.
   */
  get crossfadeLines(): boolean {
    return this.look ? !this.look.motion || !this.running : false;
  }

  build(host: HTMLElement, lines: readonly Line[], look: Look): void {
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
    this.rows = lines.map((line) => {
      const el = h("div", "drift-row");
      el.dir = "auto";
      el.style.top = `${look.y}px`;
      const spans = line.words.map((w) => {
        const span = h("span", "", w.text);
        el.append(span);
        return span;
      });
      put(el, "visibility", "hidden");
      box.append(el);
      return { el, spans, line, size: look.size, height: 0, glow: "" };
    });
    host.append(box);
    this.box = box;
    this.measure(look);
    this.restyle(look);
    this.target = -1;
  }

  restyle(look: Look): void {
    this.look = look;
    const box = this.box;
    if (!box) return;
    box.style.color = look.colors.dim;
    box.style.textShadow = textShadow(look, look.size);
    for (const row of this.rows) {
      if (row.size !== look.size) row.el.style.textShadow = textShadow(look, row.size);
      row.glow = textShadow(look, row.size, true);
    }
  }

  paint(cue: Cue): boolean {
    const look = this.look;
    const box = this.box;
    if (!look || !box) return false;
    this.running = cue.running;
    put(box, "opacity", cue.line < 0 ? "0" : "1");
    if (cue.line < 0) return false;

    const now = performance.now();
    if (cue.line !== this.target) {
      const glide = look.motion && cue.running && this.target >= 0 && Math.abs(cue.line - this.shown) <= MAX_GLIDE;
      this.from = glide ? this.shown : cue.line;
      this.target = cue.line;
      this.startedAt = now;
    }
    // Paused, no frame follows this one: land where any glide in flight was headed.
    if (!cue.running) this.from = this.target;
    const k = this.from === this.target ? 1 : Math.min(1, (now - this.startedAt) / (look.unsynced ? CALM_EASE_MS : EASE_MS));
    this.shown = this.from + (this.target - this.from) * easeInOut(k);
    if (k >= 1) this.from = this.target;
    this.place(cue, look);
    // Busy only while actually gliding: a cut or a fresh build moves nothing after its first frame.
    return k < 1;
  }

  destroy(): void {
    this.box?.remove();
    this.box = null;
    this.rows = [];
    this.heights = [];
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
      row.height = Math.max(heights[i] ?? 0, row.size * LINE_HEIGHT);
    });
    this.heights = this.rows.map((row) => row.height);
  }

  /** Moves every row to where the song is scrolled to, and colors the focus line. */
  private place(cue: Cue, look: Look): void {
    const rows = this.rows;
    const shown = this.shown;
    const depth = this.depth;
    const low = neighborScale(look.size, depth);
    const offsets = stackOffsets(this.heights, shown, depth, slotPerPx(low));
    // Keep the whole focus block on screen, however many rows it wraps to: a tall line moves the
    // stack away from the edge it would run off.
    const lo = Math.max(0, Math.min(rows.length - 1, Math.floor(shown)));
    const hLo = rows[lo]?.height ?? 0;
    const hHi = rows[lo + 1]?.height ?? hLo;
    const half = (hLo + (hHi - hLo) * (shown - lo)) / 2;
    const room = half + look.size * EDGE_PAD;
    const center = room * 2 > look.height ? look.height / 2 : Math.min(look.height - room, Math.max(room, look.y));
    const shift = center - look.y;
    const zUnit = look.size * RECEDE * depth;

    rows.forEach((row, i) => {
      const at = offsets.get(i);
      const off = i - shown;
      const dist = Math.abs(off);
      if (at === undefined || dist > REACH) {
        put(row.el, "visibility", "hidden");
        return;
      }
      put(row.el, "visibility", "visible");
      const scale = 1 - Math.min(dist, 1) * (1 - low);
      // `at` is where the row should appear; the perspective (its origin on look.y) pulls a row `dist`
      // lines back toward look.y by projection(dist), so place it that much further out.
      const y = snap(shift + at, look.dpr) / projection(dist, depth);
      put(
        row.el,
        "transform",
        `translate3d(-50%, calc(-50% + ${y.toFixed(2)}px), ${(-dist * zUnit).toFixed(1)}px) rotateX(${(-off * TILT * depth).toFixed(2)}deg) scale(${scale.toFixed(4)})`,
      );
      put(row.el, "opacity", Math.max(0, 1 - dist * 0.3).toFixed(3));
      this.paintWords(row, i === cue.line ? cue : null, look);
    });
  }

  /** Focus line: sung words in highlight, the active one glowing, the rest in lyric color. Others dim. */
  private paintWords(row: Row, cue: Cue | null, look: Look): void {
    row.spans.forEach((span, j) => {
      const word = row.line.words[j];
      if (!cue || !word) {
        put(span, "color", look.colors.dim);
        put(span, "text-shadow", "");
        return;
      }
      const state = cue.waiting || look.unsynced ? "upcoming" : wordState(word, cue.t);
      put(span, "color", state === "upcoming" ? look.colors.lyric : look.colors.highlight);
      put(span, "text-shadow", state === "active" ? row.glow : "");
    });
  }
}

export function createDrift(depth: number): ModeRenderer {
  return new DriftMode(depth);
}
