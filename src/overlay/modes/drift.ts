import type { Line } from "../../core/lrc";
import { progress } from "../../core/timing";
import { h, put } from "../dom";
import { snap, textShadow, type Look } from "../look";
import type { Cue, ModeRenderer } from "./types";

/** Line pitch in font sizes, from the prototype. */
const PITCH = 1.15;
/** Lines further than this from the focus are hidden. */
const REACH = 3.5;
/** Scroll time to the next line; slower for unsynced lyrics. */
const EASE_MS = 520;
const CALM_EASE_MS = 900;
/** A jump further than this (a seek) cuts instead of scrolling through every line. */
const MAX_GLIDE = 3;

interface Row {
  el: HTMLDivElement;
  spans: HTMLSpanElement[];
  line: Line;
  /** stacking position in px at full size, from the top of the song */
  at: number;
}

const easeInOut = (x: number): number => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

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
  private shown = 0;
  private from = 0;
  private target = -1;
  private startedAt = 0;

  constructor(depth: number) {
    this.depth = depth;
  }

  get crossfadeLines(): boolean {
    return this.look ? !this.look.motion : false;
  }

  build(host: HTMLElement, lines: readonly Line[], look: Look): void {
    this.look = look;
    host.textContent = "";
    const box = h("div", "drift");
    box.style.fontFamily = look.font;
    box.style.fontWeight = String(look.weight);
    box.style.fontSize = `${look.size}px`;
    box.style.perspective = `${look.size * 15.5}px`;
    box.style.textShadow = textShadow(look, look.size);
    box.style.color = look.colors.dim;
    this.rows = lines.map((line) => {
      const el = h("div", "drift-row");
      el.style.top = `${look.y}px`;
      const spans = line.words.map((w) => {
        const span = h("span", "", w.text);
        el.append(span);
        return span;
      });
      put(el, "visibility", "hidden");
      box.append(el);
      return { el, spans, line, at: 0 };
    });
    host.append(box);
    this.box = box;

    // Wrapped lines take more room. Measure here in one layout pass, never per frame.
    const lineHeight = look.size * 1.12;
    const heights = this.rows.map((row) => row.el.offsetHeight);
    let at = 0;
    this.rows.forEach((row, i) => {
      const visual = Math.max(1, Math.round((heights[i] ?? 0) / lineHeight));
      const prev = Math.max(1, Math.round((heights[i - 1] ?? lineHeight) / lineHeight));
      if (i > 0) at += (look.size * PITCH * (prev + visual)) / 2;
      row.at = at;
    });
    this.target = -1;
  }

  paint(cue: Cue): boolean {
    const look = this.look;
    const box = this.box;
    if (!look || !box) return false;
    put(box, "opacity", cue.line < 0 ? "0" : "1");
    if (cue.line < 0) return false;

    const now = performance.now();
    if (cue.line !== this.target) {
      const glide = look.motion && this.target >= 0 && Math.abs(cue.line - this.shown) <= MAX_GLIDE;
      this.from = glide ? this.shown : cue.line;
      this.target = cue.line;
      this.startedAt = now;
    }
    const ease = look.unsynced ? CALM_EASE_MS : EASE_MS;
    const k = Math.min(1, (now - this.startedAt) / ease);
    this.shown = this.from + (this.target - this.from) * easeInOut(k);

    const lo = Math.floor(this.shown);
    const a = this.rows[lo]?.at ?? 0;
    const b = this.rows[lo + 1]?.at ?? a;
    const center = a + (b - a) * (this.shown - lo);
    const zUnit = look.size * 2.4 * this.depth;

    this.rows.forEach((row, i) => {
      const off = i - this.shown;
      const dist = Math.abs(off);
      if (dist > REACH) {
        put(row.el, "visibility", "hidden");
        return;
      }
      put(row.el, "visibility", "visible");
      const scale = 1 - Math.min(dist, 1) * 0.42;
      const y = snap(row.at - center, look.dpr);
      put(
        row.el,
        "transform",
        `translate3d(-50%, calc(-50% + ${y}px), ${(-dist * zUnit).toFixed(1)}px) rotateX(${(-off * 14 * this.depth).toFixed(2)}deg) scale(${scale.toFixed(4)})`,
      );
      put(row.el, "opacity", Math.max(0, 1 - dist * 0.3).toFixed(3));
      this.paintWords(row, i === cue.line ? cue : null, look);
    });
    return k < 1;
  }

  destroy(): void {
    this.box?.remove();
    this.box = null;
    this.rows = [];
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
      const p = cue.waiting || look.unsynced ? 0 : progress(word, cue.t);
      put(span, "color", p > 0 ? look.colors.highlight : look.colors.lyric);
      put(span, "text-shadow", p > 0 && p < 1 ? textShadow(look, look.size, true) : "");
    });
  }
}

export function createDrift(depth: number): ModeRenderer {
  return new DriftMode(depth);
}
