import "../../styles/arc.css";
import type { Line, Word } from "../../core/lrc";
import { progress } from "../../core/timing";
import { h, put, s } from "../dom";
import { dropShadow, shadowLayers, snap, type Look } from "../look";
import type { Cue, ModeRenderer } from "./types";

/** Previous and next lines at this fraction of the focus size (prototype). */
const SIDE_SCALE = 0.48;
/** ...but no smaller than this many px (or 80% of the focus size, if that is smaller), so tiny sizes keep legible neighbors. */
const SIDE_MIN_PX = 11;
/** Baselines in focus font sizes from the focus baseline: previous above, next below with a little extra room for descenders (prototype). */
const PREV_RISE = -1.25;
const NEXT_DROP = 1.25 + 0.15;
/** The path's control point sits 2 × curve × stage height × BEND above its ends, so the middle of the line rises by half that. */
const BEND = 0.42;
/**
 * The focus baseline sits this many font sizes below `look.y`, so the glyphs (not the baseline) are
 * centered on the chosen height, the way Drift and Stack center their line box. The bend is split
 * evenly around it: raising the curve lifts the middle and lowers the ends by the same amount, so
 * a strong curve doesn't push the lines off the top of the screen.
 */
const BASELINE = 0.35;
/** Each path runs from this fraction of the width to 1 minus it. */
const MARGIN = 0.05;
/** A line longer than this share of its path shrinks to fit... */
const FIT = 0.94;
/** ...but never below this share of its size; past that it runs off the path ends. */
const MIN_FIT = 0.55;
/** Room above and below the baseline curve in each line's SVG band, in font sizes. */
const BAND_ABOVE = 1.3;
const BAND_BELOW = 0.6;
/**
 * With motion on, Arc moves its own lines (the stage's crossfade would leave a fading copy of the
 * old line in place while the same text glides away, doubling every line change). Stepping to the
 * next line, each line glides from where its text just was: the old focus line shrinks up into the
 * previous slot and dims, the old next line grows into focus, a new next line rises in and the old
 * previous line rises out. Slower for unsynced lyrics. Any other change (a seek, the end of the
 * song) is a quick crossfade. Under reduced motion nothing moves and the stage crossfades.
 */
const GLIDE_MS = 460;
const CALM_GLIDE_MS = 800;
const GLIDE_EASING = "cubic-bezier(0.45, 0, 0.2, 1)";
/** The incoming next line rises this many focus sizes into place; the outgoing previous line rises as far out. */
const NEXT_RISE = 0.5;
/** Crossfade for jumps: the old lines go quickly, the new ones come in a little slower so they barely overlap. */
const FADE_OUT_MS = 200;
const FADE_IN_MS = 300;

const XLINK = "http://www.w3.org/1999/xlink";
const XML = "http://www.w3.org/XML/1998/namespace";

/** Counts instances so path ids stay unique when two arcs coexist (song crossfade, settings preview). */
let instances = 0;

interface Slot {
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

/** The focus line's words: the base layer every word is drawn in, and the glow layer that only shows the active one. */
interface Focus {
  words: readonly Word[];
  base: SVGTSpanElement[];
  glow: SVGTSpanElement[];
}

/** One drawn line: an SVG band with its own path and text. */
interface Band {
  svg: SVGSVGElement;
  text: SVGTextElement;
  tspans: SVGTSpanElement[];
}

/** Where a band's text starts its glide, relative to where it ends up. */
interface GlideFrom {
  dy: number;
  scale: number;
  /** fade in as it glides (a line that wasn't on screen) */
  appear: boolean;
}

/** A band on screen, by slot relative to the focus line (-1 previous, 0 focus or its glow copy, 1 next). */
interface Drawn {
  svg: SVGSVGElement;
  k: number;
}

/**
 * Arc: the focus line set on a curve, with the previous line small above and the next one small
 * below, each on a parallel curve. The DOM is rebuilt only when the focus line changes, with the
 * move animated on the compositor (or, under reduced motion, crossfaded by the stage); a frame only
 * recolors words of the focus line.
 */
export class ArcMode implements ModeRenderer {
  private readonly id = ++instances;
  private builds = 0;
  private look: Look | null = null;
  private lines: readonly Line[] = [];
  private box: HTMLDivElement | null = null;
  /** each line's advance at `look.size`, px */
  private lengths: number[] = [];
  /** length of every path (they are vertical translations of one curve), px */
  private pathLength = 0;
  /** line index currently drawn; NaN before the first paint */
  private shown = Number.NaN;
  private focus: Focus | null = null;
  /** bands of the lines around `shown` (not the ones still fading out) */
  private drawn: Drawn[] = [];
  private lastCue: Cue | null = null;

  /** The stage crossfades line changes only under reduced motion; otherwise Arc moves its lines itself. */
  get crossfadeLines(): boolean {
    return this.look ? !this.look.motion : true;
  }

  build(host: HTMLElement, lines: readonly Line[], look: Look): void {
    this.look = look;
    this.lines = lines;
    host.textContent = "";
    const box = h("div", look.motion ? "arc" : "arc arc-still");
    box.style.fontFamily = look.font;
    box.style.fontWeight = String(look.weight);
    host.append(box);
    this.box = box;
    this.shown = Number.NaN;
    this.focus = null;
    this.drawn = [];
    this.measure(look, box);
    this.refitWhenFontsLoad(look, box);
  }

  paint(cue: Cue): boolean {
    const look = this.look;
    if (!look || !this.box) return false;
    this.lastCue = cue;
    if (cue.line !== this.shown) this.showLine(cue.line, look, this.box);
    const focus = this.focus;
    if (!focus) return false;
    const calm = cue.waiting || look.unsynced;
    focus.words.forEach((word, j) => {
      const p = calm ? 0 : progress(word, cue.t);
      const base = focus.base[j];
      if (base) put(base, "fill", p > 0 ? look.colors.highlight : look.colors.lyric);
      const glow = focus.glow[j];
      if (glow) put(glow, "fill-opacity", p > 0 && p < 1 ? "1" : "0");
    });
    return false;
  }

  destroy(): void {
    this.box?.remove();
    this.box = null;
    this.focus = null;
    this.drawn = [];
    this.lastCue = null;
    this.lines = [];
    this.lengths = [];
  }

  /** Measures every line once, in one layout pass, so fitting a line later needs no layout reads. */
  private measure(look: Look, box: HTMLDivElement): void {
    const svg = s("svg", { class: "arc-measure", "aria-hidden": "true" });
    const path = s("path", { d: this.curve(look, look.y) });
    svg.append(path);
    const texts = this.lines.map((line) => {
      const text = s("text", { "font-size": look.size });
      text.setAttributeNS(XML, "xml:space", "preserve");
      text.textContent = line.text;
      svg.append(text);
      return text;
    });
    box.append(svg);
    this.pathLength = path.getTotalLength();
    this.lengths = texts.map((text) => text.getComputedTextLength());
    svg.remove();
  }

  /**
   * The lyric face may still be downloading on the first build (or the subset for accents or another
   * script may be), and fallback metrics would fit lines wrongly. Measure again once it's in.
   */
  private refitWhenFontsLoad(look: Look, box: HTMLDivElement): void {
    if (typeof document === "undefined" || !("fonts" in document)) return;
    const spec = `${look.weight} ${look.size}px ${look.font}`;
    const chars = [...new Set(this.lines.map((l) => l.text).join(""))].join("");
    try {
      if (document.fonts.check(spec, chars)) return;
    } catch {
      return;
    }
    void document.fonts.load(spec, chars).then(
      () => {
        if (this.box !== box) return;
        this.measure(look, box);
        this.shown = Number.NaN;
        if (this.lastCue) this.paint(this.lastCue);
      },
      () => undefined,
    );
  }

  private bend(look: Look): number {
    return look.curve * look.height * BEND;
  }

  /**
   * Path from 5% to 95% of the width whose baseline averages `y`: ends half a bend below it,
   * middle half a bend above (the other way round for a negative curve).
   *
   * SVG drops glyphs that run past the end of a text path, so a line still too long at its smallest
   * fit would lose words in mid-air at 5% and 95%. For such a line, `extend` px of straight track
   * continue each end along its tangent; the text stays centered and runs off the screen edges instead.
   */
  private curve(look: Look, y: number, extend = 0): string {
    const bend = this.bend(look);
    const x0 = snap(look.width * MARGIN, look.dpr);
    const x1 = snap(look.width * (1 - MARGIN), look.dpr);
    const xm = snap(look.width / 2, look.dpr);
    const ends = snap(y + bend / 2, look.dpr);
    const control = snap(y + bend / 2 - 2 * bend, look.dpr);
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

  /** Font size for line `i` drawn at `size`: shrunk so it fits its path, within limits. */
  private fitted(i: number, size: number, look: Look): number {
    const natural = ((this.lengths[i] ?? 0) * size) / look.size;
    const room = this.pathLength * FIT;
    if (room <= 0 || natural <= room) return size;
    return Math.max(size * MIN_FIT, (size * room) / natural);
  }

  /** Focus and neighbor sizes around line `index`: a long focus line that had to shrink takes its neighbors (and their spacing) down with it, so it still leads. */
  private sizes(index: number, look: Look): { focus: number; side: number } {
    const focus = this.fitted(index, look.size, look);
    return { focus, side: Math.max(SIDE_SCALE * focus, Math.min(0.8 * focus, SIDE_MIN_PX)) };
  }

  /** Replaces the drawn lines with the ones around line `index` (nothing for -1). */
  private showLine(index: number, look: Look, box: HTMLDivElement): void {
    const from = this.shown;
    const old = this.drawn;
    const oldWords = this.focus?.base ?? [];
    this.drawn = [];
    this.focus = null;
    this.shown = index;
    // With motion on, Arc animates line changes itself (the stage doesn't crossfade then). Never on
    // the first paint after a build or a refit.
    const moving = look.motion && Number.isFinite(from);
    const step = moving && from >= 0 && index === from + 1;
    const glideMs = look.unsynced ? CALM_GLIDE_MS : GLIDE_MS;
    for (const d of old) {
      // On a step, the old focus and next lines live on as the new previous and focus lines, which
      // start exactly where they were; only the old previous line has somewhere to go.
      if (step && d.k < 0) this.leave(d.svg, -NEXT_RISE * this.sizes(from, look).focus, glideMs);
      else if (moving && !step) this.leave(d.svg, 0, FADE_OUT_MS);
      else d.svg.remove();
    }
    if (index < 0 || !this.lines[index]) return;
    // Fresh ids per build: crossfading copies (the stage's ghost, a band fading out) keep the old ones.
    const prefix = `ut-arc${this.id}-${++this.builds}`;
    const sizes = this.sizes(index, look);
    const baseline = look.y + BASELINE * look.size;
    for (const slot of SLOTS) {
      const i = index + slot.k;
      const line = this.lines[i];
      if (!line) continue;
      const size = slot.k === 0 ? sizes.focus : this.fitted(i, sizes.side, look);
      const y = baseline + slot.rise * sizes.focus;
      const natural = ((this.lengths[i] ?? 0) * size) / look.size;
      const band = this.band(`${prefix}-${slot.name}`, line, size, y, natural, look);
      band.svg.classList.add(`arc-${slot.name}`);
      band.svg.style.filter = dropShadow(look, size);
      box.append(band.svg);
      this.drawn.push({ svg: band.svg, k: slot.k });
      const start = step ? this.glideFrom(slot, index, size, y, baseline, look) : null;
      if (start) this.glide(band.svg, start, glideMs);
      else if (moving) this.appear(band.svg);
      if (slot.k !== 0) {
        band.svg.setAttribute("aria-hidden", "true");
        band.text.style.fill = look.colors.dim;
        // the old focus line dims as it moves up
        if (step && slot.k < 0) band.tspans.forEach((t, j) => easeFill(t, oldWords[j]?.style.fill ?? "", glideMs));
        continue;
      }
      // the old next line brightens as it moves into focus
      if (step) for (const t of band.tspans) easeFill(t, look.colors.dim, glideMs);

      const focus: Focus = { words: line.words, base: band.tspans, glow: [] };
      // SVG can't filter a single tspan, so the active word's glow is a second copy of the line on
      // the same curve, every word transparent but the active one, under a highlight-colored halo.
      if (look.glow > 0 && !look.unsynced) {
        const glow = this.band(`${prefix}-glow`, line, size, y, natural, look);
        glow.svg.classList.add("arc-glow");
        glow.svg.setAttribute("aria-hidden", "true");
        glow.svg.style.filter = glowFilter(look, size);
        glow.text.style.fill = look.colors.highlight;
        for (const t of glow.tspans) put(t, "fill-opacity", "0");
        focus.glow = glow.tspans;
        box.append(glow.svg);
        this.drawn.push({ svg: glow.svg, k: 0 });
        if (start) this.glide(glow.svg, start, glideMs);
        else if (moving) this.appear(glow.svg);
      }
      this.focus = focus;
    }
  }

  /**
   * Where a line drawn at baseline `y` and `size` was a moment ago, when the focus has just stepped
   * from `index - 1` to `index`: the new previous line was the focus line, the new focus line was
   * the next one, and the new next line rises in from a little below.
   */
  private glideFrom(slot: Slot, index: number, size: number, y: number, baseline: number, look: Look): GlideFrom {
    const before = this.sizes(index - 1, look);
    if (slot.k < 0) return { dy: baseline - y, scale: before.focus / size, appear: false };
    if (slot.k === 0) {
      const wasNext = this.fitted(index, before.side, look);
      return { dy: NEXT_DROP * before.focus, scale: wasNext / size, appear: false };
    }
    return { dy: NEXT_RISE * this.sizes(index, look).focus, scale: 1, appear: true };
  }

  /** Runs a band's glide on the compositor; paint() never has to wake up for it. */
  private glide(svg: SVGSVGElement, from: GlideFrom, ms: number): void {
    if (typeof svg.animate !== "function") return;
    const start: Keyframe = { transform: `translateY(${from.dy.toFixed(2)}px) scale(${from.scale.toFixed(4)})` };
    const end: Keyframe = { transform: "none" };
    if (from.appear) {
      start.opacity = 0;
      end.opacity = 1;
    }
    svg.animate([start, end], { duration: ms, easing: GLIDE_EASING });
  }

  /** Fades a band in (a jump to another part of the song). */
  private appear(svg: SVGSVGElement): void {
    if (typeof svg.animate !== "function") return;
    svg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_IN_MS, easing: "ease-in" });
  }

  /** Fades a band out (rising `dy` px if given), then removes it. */
  private leave(svg: SVGSVGElement, dy: number, ms: number): void {
    if (typeof svg.animate !== "function") {
      svg.remove();
      return;
    }
    svg.setAttribute("aria-hidden", "true");
    const anim = svg.animate(
      [
        { transform: "none", opacity: 1 },
        { transform: `translateY(${dy.toFixed(2)}px)`, opacity: 0 },
      ],
      { duration: ms, easing: dy ? GLIDE_EASING : "ease-out", fill: "forwards" },
    );
    const remove = (): void => svg.remove();
    void anim.finished.then(remove, remove);
  }

  /**
   * An SVG band just tall enough for one line on its curve, drawn in stage coordinates. It scales
   * around the middle of its curve, where the text is centered. `natural` is the text's length at
   * `size`; a line longer than its path gets a path that runs on past the screen edges.
   */
  private band(id: string, line: Line, size: number, y: number, natural: number, look: Look): Band {
    const bend = this.bend(look);
    const half = Math.abs(bend) / 2;
    const top = snap(y - half - size * BAND_ABOVE, look.dpr);
    const height = Math.ceil(y + half + size * BAND_BELOW - top);
    const width = Math.max(1, Math.ceil(look.width));
    const svg = s("svg", { class: "arc-line", width, height, viewBox: `0 ${top} ${width} ${height}` });
    svg.style.top = `${top}px`;
    svg.style.transformOrigin = `${(look.width / 2).toFixed(1)}px ${(y - bend / 2 - top).toFixed(1)}px`;
    const extend = natural > this.pathLength ? (natural - this.pathLength) / 2 + size : 0;
    const path = s("path", { id, d: this.curve(look, y, extend) });
    const defs = s("defs");
    defs.append(path);
    const text = s("text", { "font-size": size.toFixed(2), "text-anchor": "middle" });
    text.setAttributeNS(XML, "xml:space", "preserve");
    const textPath = s("textPath", { href: `#${id}`, startOffset: "50%" });
    textPath.setAttributeNS(XLINK, "xlink:href", `#${id}`);
    const tspans = line.words.map((word) => {
      const tspan = s("tspan");
      tspan.textContent = word.text;
      textPath.append(tspan);
      return tspan;
    });
    text.append(textPath);
    svg.append(defs, text);
    return { svg, text, tspans };
  }
}

/**
 * The glow layer's filter: just the highlight halo from `shadowLayers`. The soft dark shadow is
 * already under the base copy of the word; drawing it again here would muddy the glow.
 */
function glowFilter(look: Look, size: number): string {
  const base = shadowLayers(look, size, false).length;
  const halo = shadowLayers(look, size, true).slice(base);
  if (halo.length === 0) return dropShadow(look, size, true);
  return halo.map(([x, y, blur, color]) => `drop-shadow(${x} ${y} ${blur} ${color})`).join(" ");
}

/**
 * Eases a word's color from `from` to whatever paint() makes it. The end keyframe is left implicit,
 * so it follows the word as it changes (the first word of a new focus line starts being sung while
 * the line is still gliding in). Engines without implicit keyframes just switch color.
 */
function easeFill(el: SVGElement, from: string, ms: number): void {
  if (!from || typeof el.animate !== "function") return;
  try {
    el.animate([{ fill: from, offset: 0 }], { duration: ms, easing: "ease-out" });
  } catch {
    // NotSupportedError for partial keyframes: no color ease, nothing else changes
  }
}

export function createArc(): ModeRenderer {
  return new ArcMode();
}
