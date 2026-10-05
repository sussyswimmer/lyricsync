import "../../styles/arc.css";
import type { Line, Word } from "../../core/lrc";
import { wordState } from "../../core/timing";
import { h, put, s } from "../dom";
import { whenFaceLoads } from "../fonts";
import { dropShadow, MIN_TEXT_PX, shadowLayers, snap, type Look } from "../look";
import type { Cue, ModeRenderer } from "./types";

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
 * ...but never below this share of its size; past that it runs off the path ends. On a display
 * narrower than 16:9 the floor drops in proportion: the size follows the stage height, so an ordinary
 * line on a portrait display needs to shrink further to fit its width.
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
/** The incoming next line rises this many focus sizes into place. */
const NEXT_RISE = 0.5;
/** Crossfade for jumps: the old lines go quickly, the new ones come in a little slower so they barely overlap. */
const FADE_OUT_MS = 200;
const FADE_IN_MS = 300;

/**
 * Shares of a step's glide (in eased progress) that keep the moving lines from drawing through each
 * other: the incoming next line stays transparent until the old next line has grown up out of its
 * slot, and the outgoing previous line is gone before the old focus line shrinks up into its slot.
 */
const APPEAR_HOLD = 0.4;
const LEAVE_BY = 0.5;
/**
 * The two lines that change color on a step (the old focus line dimming, the old next line
 * brightening) settle in this share of the glide. The glide runs on the compositor, but every frame
 * of a color change re-rasters the line's filtered band.
 */
const FILL_SHARE = 0.45;

/**
 * Right-to-left blocks (Hebrew, Arabic, Syriac, Thaana, N'Ko and the rest), as in Lens. A line whose
 * first letter is in one of them is laid out right to left, the way `dir="auto"` resolves HTML text.
 */
const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;

const XLINK = "http://www.w3.org/1999/xlink";
const XML = "http://www.w3.org/XML/1998/namespace";

/** Counts instances so path ids stay unique when two arcs coexist (song crossfade, settings preview). */
let instances = 0;

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
  /** the smallest share of its size a line shrinks to before it runs off the path ends */
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
 * Length along a path with this `bend` from its middle to `x` px either side. The paths are
 * parabolas: y = bend × (x / halfWidth)² from the middle.
 */
export function arcLength(x: number, halfWidth: number, bend: number): number {
  const a = halfWidth > 0 ? Math.abs(bend) / (halfWidth * halfWidth) : 0;
  if (a < 1e-9) return x;
  return (x * Math.sqrt(1 + 4 * a * a * x * x) + Math.asinh(2 * a * x) / (2 * a)) / 2;
}

/** How far a text `length` px long, centered on a path with this `bend`, reaches to either side: a share of the half-width, 0..1. */
export function reach(length: number, halfWidth: number, bend: number): number {
  if (halfWidth <= 0 || length <= 0) return 0;
  const target = length / 2;
  if (arcLength(halfWidth, halfWidth, bend) <= target) return 1;
  let lo = 0;
  let hi = halfWidth;
  for (let n = 0; n < 40; n++) {
    const x = (lo + hi) / 2;
    if (arcLength(x, halfWidth, bend) < target) lo = x;
    else hi = x;
  }
  return (lo + hi) / 2 / halfWidth;
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

/** A band on screen, by slot relative to the focus line (-1 previous, 0 focus or its glow copy, 1 next). */
interface Drawn {
  svg: SVGSVGElement;
  text: SVGTextElement;
  k: number;
  /** its font size, px, which its shadow is drawn for */
  size: number;
  /** the focus line's glow copy */
  glow: boolean;
}

/** Whether a look draws the active word's glow, which takes a band of its own (see showLine). */
const glows = (look: Look): boolean => look.glow > 0 && !look.unsynced;

/** Everything in a look but what restyle() takes (colors, glow) and the stage applies (opacity): two looks with the same key lay out the same. */
function layoutKey(look: Look): string {
  const { colors, glow, opacity, ...layout } = look;
  return JSON.stringify(layout);
}

/**
 * Arc: the focus line set on a curve, with the previous line small above and the next one small
 * below, each on a parallel curve. The DOM is rebuilt only when the focus line changes, with the
 * move animated on the compositor (or, under reduced motion, crossfaded by the stage); a frame only
 * recolors words of the focus line. New colors or glow restyle the bands in place.
 */
export class ArcMode implements ModeRenderer {
  private readonly id = ++instances;
  private builds = 0;
  private look: Look | null = null;
  private lines: readonly Line[] = [];
  private host: HTMLElement | null = null;
  private box: HTMLDivElement | null = null;
  /** the shared curve, resolved per build */
  private geo: ArcGeometry = { bend: 0, mid: 0, minFit: MIN_FIT };
  /** each line's advance at `look.size`, px */
  private lengths: number[] = [];
  /** length of the shared path (neighbors are vertical translations of it, unless one had to flatten), px */
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
    this.host = host;
    host.textContent = "";
    const box = h("div", "arc");
    box.style.fontFamily = look.font;
    box.style.fontWeight = String(look.weight);
    host.append(box);
    this.box = box;
    // the bend, for measuring the path; measure() then places the focus line
    this.geo = arcGeometry(look);
    this.shown = Number.NaN;
    this.focus = null;
    this.drawn = [];
    this.measure(look, box);
    this.refitWhenFontsLoad(look, box);
  }

  /**
   * New colors or glow, without measuring: each band's shadow, the glow copy's halo and the
   * neighbors' fill change in place, and the next paint recolors the focus line's words. Glides in
   * flight carry on. The glow copy exists only while there is a glow, so glow reaching or leaving 0
   * rebuilds, as does anything that moves the layout (the stage rebuilds for that itself).
   */
  restyle(look: Look): void {
    const was = this.look;
    const host = this.host;
    if (!was || !host || !this.box) {
      this.look = look;
      return;
    }
    if (glows(look) !== glows(was) || layoutKey(look) !== layoutKey(was)) {
      this.build(host, this.lines, look);
      if (this.lastCue) this.paint(this.lastCue);
      return;
    }
    this.look = look;
    for (const d of this.drawn) {
      put(d.svg, "filter", d.glow ? glowFilter(look, d.size) : dropShadow(look, d.size));
      if (d.glow) put(d.text, "fill", look.colors.highlight);
      else if (d.k !== 0) put(d.text, "fill", look.colors.dim);
    }
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
      const state = calm ? "upcoming" : wordState(word, cue.t);
      const base = focus.base[j];
      if (base) put(base, "fill", state === "upcoming" ? look.colors.lyric : look.colors.highlight);
      const glow = focus.glow[j];
      if (glow) put(glow, "fill-opacity", state === "active" ? "1" : "0");
    });
    return false;
  }

  destroy(): void {
    this.box?.remove();
    this.box = null;
    this.host = null;
    this.focus = null;
    this.drawn = [];
    this.lastCue = null;
    this.lines = [];
    this.lengths = [];
  }

  /** Measures every line once, in one layout pass, so fitting a line later needs no layout reads. */
  private measure(look: Look, box: HTMLDivElement): void {
    const svg = s("svg", { class: "arc-measure", "aria-hidden": "true" });
    const path = s("path", { d: this.curve(look, this.geo.mid, this.geo.bend) });
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
    // the bend stays; the focus line's place depends on how far the song's widest line reaches
    this.geo = arcGeometry(look, this.widest(look));
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
   * script may be), and fallback metrics would fit lines wrongly. Measure again once it's in. Asking
   * is cached (see whenFaceLoads): a Size drag rebuilds on every step.
   */
  private refitWhenFontsLoad(look: Look, box: HTMLDivElement): void {
    const loading = whenFaceLoads(look.font, look.weight, this.lines.map((l) => l.text).join(""));
    if (!loading) return;
    void loading.then(
      () => {
        // a restyle since then kept the layout but brought new colors
        const current = this.look;
        if (this.box !== box || !current) return;
        this.measure(current, box);
        this.shown = Number.NaN;
        if (this.lastCue) this.paint(this.lastCue);
      },
      () => undefined,
    );
  }

  /** Half the horizontal span of every path, px. */
  private halfWidth(look: Look): number {
    return (snap(look.width * (1 - MARGIN), look.dpr) - snap(look.width * MARGIN, look.dpr)) / 2;
  }

  /**
   * Path from 5% to 95% of the width through `mid` at the middle of the stage, its ends `bend` px
   * below that (above, for a negative bend).
   *
   * SVG drops glyphs that run past the end of a text path, so a line still too long at its smallest
   * fit would lose words in mid-air at 5% and 95%. For such a line, `extend` px of straight track
   * continue each end along its tangent; the text stays centered and runs off the screen edges instead.
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

  /** Font size for line `i` drawn at `size`: shrunk so it fits its path, within limits. */
  private fitted(i: number, size: number, look: Look): number {
    const natural = this.natural(i, size, look);
    const room = this.pathLength * FIT;
    if (room <= 0 || natural <= room) return size;
    return Math.max(size * this.geo.minFit, (size * room) / natural);
  }

  /** Focus and neighbor sizes around line `index`: a long focus line that had to shrink takes its neighbors (and their spacing) down with it, so it still leads. */
  private sizes(index: number, look: Look): { focus: number; side: number } {
    const focus = this.fitted(index, look.size, look);
    return { focus, side: Math.max(SIDE_SCALE * focus, Math.min(0.8 * focus, MIN_TEXT_PX)) };
  }

  /**
   * The lines around focus line `index`, laid out: the focus line on the shared curve at `geo.mid`,
   * its neighbors on translated copies above and below. The neighbor on the outer side of the curve
   * moves out (and, past MAX_PUSH, flattens) when it is long enough to hang beside the focus line.
   */
  private place(index: number, look: Look): Placed[] {
    const geo = this.geo;
    const sizes = this.sizes(index, look);
    const halfWidth = this.halfWidth(look);
    const focus: Run = { size: sizes.focus, length: this.natural(index, sizes.focus, look) };
    const placed: Placed[] = [];
    for (const slot of SLOTS) {
      const i = index + slot.k;
      if (!this.lines[i]) continue;
      const size = slot.k === 0 ? sizes.focus : this.fitted(i, sizes.side, look);
      const natural = this.natural(i, size, look);
      let mid = geo.mid + slot.rise * sizes.focus;
      let bend = geo.bend;
      // above an arch (rise < 0, bend > 0) or below a sag
      if (slot.k !== 0 && slot.rise * geo.bend < 0) {
        const clear = clearNeighbor(geo.bend, halfWidth, slot.rise, focus, { size, length: natural });
        mid += Math.sign(slot.rise) * clear.push;
        bend = clear.bend;
      }
      placed.push({ slot, i, size, natural, mid, bend });
    }
    return placed;
  }

  /** Line `i`'s advance at `size`, px. */
  private natural(i: number, size: number, look: Look): number {
    return ((this.lengths[i] ?? 0) * size) / look.size;
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
    const placed = index >= 0 && this.lines[index] ? this.place(index, look) : [];
    // On a step, the old focus and next lines live on as the new previous and focus lines, which
    // start exactly where they were; only the old previous line has somewhere to go. It rises out as
    // far as the old focus line rises into its place, so the two keep their distance.
    const rise = placed.find((p) => p.slot.k < 0);
    const travel = rise ? this.geo.mid - rise.mid : NEXT_RISE * look.size;
    for (const d of old) {
      if (step && d.k < 0) this.leave(d.svg, -travel, glideMs);
      else if (moving && !step) this.leave(d.svg, 0, FADE_OUT_MS);
      else d.svg.remove();
    }
    if (placed.length === 0) return;
    // Fresh ids per build: crossfading copies (the stage's ghost, a band fading out) keep the old ones.
    const prefix = `ut-arc${this.id}-${++this.builds}`;
    // on a step, where each line was drawn a moment ago
    const before = step ? this.place(from, look) : [];
    const focusSize = this.sizes(index, look).focus;
    for (const p of placed) {
      const line = this.lines[p.i];
      if (!line) continue;
      const k = p.slot.k;
      const band = this.band(`${prefix}-${p.slot.name}`, line, p, look);
      band.svg.classList.add(`arc-${p.slot.name}`);
      put(band.svg, "filter", dropShadow(look, p.size));
      box.append(band.svg);
      this.drawn.push({ svg: band.svg, text: band.text, k, size: p.size, glow: false });
      const start = step ? glideFrom(p, before, focusSize) : null;
      if (start) this.glide(band.svg, start, glideMs);
      else if (moving) this.appear(band.svg);
      if (k !== 0) {
        band.svg.setAttribute("aria-hidden", "true");
        put(band.text, "fill", look.colors.dim);
        // the old focus line dims as it moves up
        if (step && k < 0) band.tspans.forEach((t, j) => easeFill(t, oldWords[j]?.style.fill ?? "", glideMs * FILL_SHARE));
        continue;
      }
      // the old next line brightens as it moves into focus
      if (step) for (const t of band.tspans) easeFill(t, look.colors.dim, glideMs * FILL_SHARE);

      const focus: Focus = { words: line.words, base: band.tspans, glow: [] };
      // SVG can't filter a single tspan, so the active word's glow is a second copy of the line on
      // the same curve, every word transparent but the active one, under a highlight-colored halo.
      if (glows(look)) {
        const glow = this.band(`${prefix}-glow`, line, p, look);
        glow.svg.classList.add("arc-glow");
        glow.svg.setAttribute("aria-hidden", "true");
        put(glow.svg, "filter", glowFilter(look, p.size));
        put(glow.text, "fill", look.colors.highlight);
        for (const t of glow.tspans) put(t, "fill-opacity", "0");
        focus.glow = glow.tspans;
        box.append(glow.svg);
        this.drawn.push({ svg: glow.svg, text: glow.text, k: 0, size: p.size, glow: true });
        if (start) this.glide(glow.svg, start, glideMs);
        else if (moving) this.appear(glow.svg);
      }
      this.focus = focus;
    }
  }

  /**
   * Runs a band's glide on the compositor; paint() never has to wake up for it. A band that appears
   * (the new next line) stays transparent until the gliding focus line has left its slot, so the two
   * never draw through each other.
   */
  private glide(svg: SVGSVGElement, from: GlideFrom, ms: number): void {
    if (typeof svg.animate !== "function") return;
    svg.animate(glideFrames(from), { duration: ms, easing: GLIDE_EASING });
  }

  /** Fades a band in (a jump to another part of the song). */
  private appear(svg: SVGSVGElement): void {
    if (typeof svg.animate !== "function") return;
    svg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_IN_MS, easing: "ease-in" });
  }

  /** Fades a band out (rising `dy` px if given, gone halfway), then removes it. */
  private leave(svg: SVGSVGElement, dy: number, ms: number): void {
    if (typeof svg.animate !== "function") {
      svg.remove();
      return;
    }
    svg.setAttribute("aria-hidden", "true");
    const anim = svg.animate(leaveFrames(dy), { duration: ms, easing: dy ? GLIDE_EASING : "ease-out", fill: "forwards" });
    const remove = (): void => svg.remove();
    void anim.finished.then(remove, remove);
  }

  /**
   * An SVG band just tall enough for one placed line on its curve, drawn in stage coordinates. It
   * scales around the middle of its curve, where the text is centered. A line longer than its path
   * gets a path that runs on past the screen edges. A right-to-left line is laid out right to left,
   * so punctuation and embedded runs land where its readers expect them.
   */
  private band(id: string, line: Line, p: Placed, look: Look): Band {
    const { size, mid, bend, natural } = p;
    const top = snap(Math.min(mid, mid + bend) - size * BAND_ABOVE, look.dpr);
    const height = Math.ceil(Math.max(mid, mid + bend) + size * BAND_BELOW - top);
    const width = Math.max(1, Math.ceil(look.width));
    const svg = s("svg", { class: "arc-line", width, height, viewBox: `0 ${top} ${width} ${height}` });
    svg.style.top = `${top}px`;
    svg.style.transformOrigin = `${(look.width / 2).toFixed(1)}px ${(mid - top).toFixed(1)}px`;
    const halfWidth = this.halfWidth(look);
    // a flattened neighbor's path is a little shorter than the shared one
    const length = bend === this.geo.bend ? this.pathLength : 2 * arcLength(halfWidth, halfWidth, bend);
    const extend = natural > length ? (natural - length) / 2 + size : 0;
    const path = s("path", { id, d: this.curve(look, mid, bend, extend) });
    const defs = s("defs");
    defs.append(path);
    const text = s("text", { "font-size": size.toFixed(2), "text-anchor": "middle" });
    text.setAttributeNS(XML, "xml:space", "preserve");
    if (isRtl(line.text)) text.setAttribute("direction", "rtl");
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
 * Where a placed line starts its glide when the focus has just stepped forward one line: where the
 * same line was drawn in the layout `before` (the old focus line is the new previous line, the old
 * next line the new focus line), its middle and size carried over. A line that wasn't drawn (the
 * new next line) rises in from NEXT_RISE focus sizes below.
 */
export function glideFrom(p: Placed, before: readonly Placed[], focusSize: number): GlideFrom {
  const was = before.find((b) => b.i === p.i);
  if (!was) return { dy: NEXT_RISE * focusSize, scale: 1, appear: true };
  return { dy: was.mid - p.mid, scale: was.size / p.size, appear: false };
}

/** Keyframes for a band gliding in from `from`; one that appears stays transparent for the first APPEAR_HOLD of the glide. */
export function glideFrames(from: GlideFrom): Keyframe[] {
  const start: Keyframe = { transform: `translateY(${from.dy.toFixed(2)}px) scale(${from.scale.toFixed(4)})`, offset: 0 };
  const end: Keyframe = { transform: "none", offset: 1 };
  if (!from.appear) return [start, end];
  return [{ ...start, opacity: 0 }, { opacity: 0, offset: APPEAR_HOLD }, { ...end, opacity: 1 }];
}

/** Keyframes for a band fading out: rising `dy` px and gone by LEAVE_BY of the way (a step), or fading in place (a jump). */
export function leaveFrames(dy: number): Keyframe[] {
  if (!dy) return [{ opacity: 1 }, { opacity: 0 }];
  return [
    { transform: "none", opacity: 1, offset: 0 },
    { opacity: 0, offset: LEAVE_BY },
    { transform: `translateY(${dy.toFixed(2)}px)`, opacity: 0, offset: 1 },
  ];
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
