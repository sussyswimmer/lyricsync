import "../../styles/lens.css";
import type { Line, Word } from "../../core/lrc";
import { progress, wordState } from "../../core/timing";
import { h, put } from "../dom";
import { whenFaceLoads } from "../fonts";
import { MIN_TEXT_PX, shadowLayers, snap, textShadow, type Look } from "../look";
import type { Cue, ModeRenderer } from "./types";

/**
 * The fisheye, from the prototype. For word j at distance d = j + 0.5 - a from the singing position a:
 * k = exp(-d² / SPREAD), scale = SCALE_MIN + (SCALE_MAX - SCALE_MIN)·k, opacity = OPACITY_MIN + (1 - OPACITY_MIN)·k.
 */
const SPREAD = 1.4;
const SCALE_MIN = 0.5;
const SCALE_MAX = 1.35;
/**
 * The prototype fades far words to 0.4; 0.6 keeps the falloff and keeps them readable. The fade is
 * the element's opacity, so hues stay true, but it must not take the word's dark legibility shadow
 * with it: each word's shadow is drawn for its drawn size and fade (see drawnShadow), so a far word
 * keeps a full-strength halo of at least the px floors on light and busy wallpapers.
 */
const OPACITY_MIN = 0.6;
/**
 * The far words' shadow comes in this many steps, from in focus (0) to farthest; a word takes the
 * nearest. A step changes the word's text-shadow, which costs a re-raster of that word, so only a
 * few happen as the lens passes; the difference between neighboring steps is too small to see.
 */
const SHADOW_STEPS = 3;
/** The focus row never gets wider than this share of the stage; long lines get a smaller base size. */
const ROW_FIT = 0.92;
/** The next line sits this many focus sizes below the focus line, at this share of the size. */
const NEXT_DROP = 1.25;
const NEXT_SIZE = 0.4;
/** ...but no larger than this share of the focus line's fitted size (its far words are at 0.5), nor wider than this share of the stage. */
const NEXT_MAX_SHARE = 0.45;
const NEXT_FIT = 0.88;
/** A line that was shown at rest while waiting eases into the fisheye over this long as it starts. */
const RAMP_MS = 320;
/**
 * Stepping to the next line, the old next line grows up into focus (its fisheye blooming on the way,
 * its color easing from dim), the old focus line fades out where it is, and the new next line rises
 * in from a little below. Lens draws this itself instead of the stage's whole-scene crossfade, which
 * would keep a copy of the old next line under the same text gliding up. Runs on the compositor;
 * slower for unsynced lyrics; never under reduced motion (the stage crossfades there).
 */
const GLIDE_MS = 460;
const CALM_GLIDE_MS = 800;
const GLIDE_EASING = "cubic-bezier(0.45, 0, 0.2, 1)";
/** The incoming next line rises this many focus sizes into place. */
const NEXT_RISE = 0.5;
/**
 * Any other line change (a seek, the first line after nothing): the old lines fade out where they
 * are, and the new ones fade in just behind them, as the stage's line crossfade does.
 */
const LINE_OUT_MS = 170;
const LINE_IN_MS = 240;
const LINE_IN_DELAY_MS = 80;
/** Lens positions sampled per word when finding the widest a row can get. */
const SAMPLES_PER_WORD = 8;
/**
 * Right-to-left blocks (Hebrew, Arabic, Syriac, Thaana, N'Ko and the rest). A line containing any of
 * them takes its visual word order from the browser's bidi layout instead of reading left to right.
 */
const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;

/** One lyric line's measurements at the look's base size. */
interface Metrics {
  /** advance width of each word on its own, without its trailing space, px */
  widths: number[];
  /** whether a space follows the word (CJK characters run together) */
  spaced: boolean[];
  /** logical word indices from left to right on screen (reversed runs for right-to-left text) */
  order: number[];
  /** advance width of the whole line set as one run of text, as the next line draws it, px */
  full: number;
}

/** A row of words in visual order: what the layout and the fit need. */
export interface Shape {
  /** per word, by logical index */
  widths: readonly number[];
  /** logical indices, left to right */
  order: readonly number[];
  /** space after the word at each visual position at scale 1 (0 after the last, and between CJK characters) */
  gaps: readonly number[];
}

/**
 * A row's fit to the stage width. At rest every word is at scale 1; under the lens far words shrink
 * to `low` and the words around the singing position grow to SCALE_MAX, so a long row is much
 * narrower lensed than at rest. Each state gets its own fit, and the row moves between them as the
 * lens eases in (see zoomAt): fitting the lens to the at-rest width left long lines tiny, filling
 * half the stage.
 */
export interface RowFit {
  /** smallest fisheye scale: SCALE_MIN, raised at small sizes so far words stay readable */
  low: number;
  /** width at rest, every word at scale 1, px at the base size */
  rest: number;
  /** the widest the lensed row gets anywhere the singing position can be, px at the base size (`rest` without a lens) */
  widest: number;
  /** base size factor under the full lens, at most 1 (the at-rest fit without a lens) */
  fit: number;
}

/** The line in focus, built for drawing. Widths and gaps are at the base size; `zoomAt` fits them to the stage each frame. */
interface Focus extends Shape, RowFit {
  words: readonly Word[];
  spans: HTMLSpanElement[];
  /** translateY shared by every word, putting the baseline on the device pixel grid */
  y: number;
  /** the dark shadow at each step of the lens's fade, SHADOW_STEPS of them from in focus to farthest (see shadowsFor) */
  shadows: string[];
  /** the active word's shadow and halo */
  glow: string;
  /** song time the lens starts easing in from (a line shown at rest, or one gliding into focus); null: in place */
  rampFrom: number | null;
  rampMs: number;
  /** scratch: this frame's scale per word */
  scales: number[];
}

/** Where the next line was drawn, so it can grow from there into focus. */
interface NextShown {
  index: number;
  size: number;
  /** its baseline, px from the top of the stage */
  baseline: number;
}

const easeOut = (x: number): number => 1 - (1 - x) ** 3;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** How strongly the lens pulls word j with the singing position at a: 1 at the center, falling off to 0. */
export function pull(j: number, a: number): number {
  const d = j + 0.5 - a;
  return Math.exp(-(d * d) / SPREAD);
}

/** The smallest fisheye scale for a line at `size` px. */
function lowScale(size: number): number {
  return Math.min(0.85, Math.max(SCALE_MIN, MIN_TEXT_PX / size));
}

/** Width of a row of words at the given scales (by logical index). A space takes the mean scale of the two words beside it. */
export function rowWidth(row: Shape, scales: readonly number[]): number {
  const { widths, order, gaps } = row;
  let total = 0;
  for (let v = 0; v < order.length; v++) {
    const j = order[v] ?? 0;
    const s = scales[j] ?? 1;
    const right = order[v + 1];
    const t = right === undefined ? s : (scales[right] ?? s);
    total += s * (widths[j] ?? 0) + ((gaps[v] ?? 0) * (s + t)) / 2;
  }
  return total;
}

/** The widest a fully lensed row gets, anywhere the singing position can be. */
function lensedWidest(row: Shape, low: number): number {
  const n = row.widths.length;
  const scales = new Array<number>(n).fill(1);
  const steps = n * SAMPLES_PER_WORD;
  let widest = 0;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * n;
    for (let j = 0; j < n; j++) scales[j] = low + (SCALE_MAX - low) * pull(j, a);
    widest = Math.max(widest, rowWidth(row, scales));
  }
  return widest;
}

/** Fits a row measured at `size` px into a stage `width` px wide, at rest and (when `lensed`) under the lens. */
export function fitRow(row: Shape, size: number, width: number, lensed: boolean): RowFit {
  const rest = rowWidth(row, new Array<number>(row.widths.length).fill(1));
  const fitTo = (w: number): number => (width > 0 && w > 0 ? Math.min(1, (ROW_FIT * width) / w) : 1);
  let low = lowScale(size);
  if (!lensed) return { low, rest, widest: rest, fit: fitTo(rest) };
  // The floor on far words depends on the fitted size, and the fit on the floor: settle it in two passes.
  let widest = lensedWidest(row, low);
  const settled = lowScale(size * fitTo(widest));
  if (settled > low) {
    low = settled;
    widest = lensedWidest(row, low);
  }
  return { low, rest, widest, fit: fitTo(widest) };
}

/**
 * The row's base size factor with the lens eased in by `lens` (0 at rest, 1 full): the lensed fit,
 * or less while the at-rest width still needs it. Each word's scale moves linearly with `lens`, and
 * so does the row's width, so it never passes ROW_FIT of the stage on the way.
 */
export function zoomAt(f: RowFit, lens: number, width: number): number {
  const widest = (1 - lens) * f.rest + lens * f.widest;
  return width > 0 && widest > 0 ? Math.min(f.fit, (ROW_FIT * width) / widest) : f.fit;
}

/** A px length from shadowLayers, divided by the transform's scale it will be drawn under. */
const unscaled = (v: string, scale: number): string => `${(Number.parseFloat(v) / scale).toFixed(2)}px`;

/** An rgba() color with its alpha divided by `opacity` (at most 1), so it lands at its own alpha under that opacity. */
function unfade(color: string, opacity: number): string {
  const m = /^(rgba\(.*,\s*)([\d.]+)\)$/.exec(color);
  if (!m || opacity >= 1) return color;
  return `${m[1] ?? ""}${Math.min(1, Number(m[2]) / Math.max(opacity, 0.01)).toFixed(3)})`;
}

/**
 * `text-shadow` for a word set at `look.size` and drawn under a transform of `scale` with element
 * opacity `opacity`, so that on screen it is the shadow `shadowLayers` gives text of its drawn size:
 * the transform would otherwise shrink the shadow with the word (to sub-pixel at half size), and the
 * opacity would fade it with the word. Far words then keep the px floors and the full-strength dark
 * halo that makes light text read on light wallpapers.
 */
export function drawnShadow(look: Look, scale: number, opacity: number, active = false): string {
  const s = scale > 0 ? scale : 1;
  return shadowLayers(look, look.size * s, active)
    .map(([x, y, blur, color]) => `${unscaled(x, s)} ${unscaled(y, s)} ${unscaled(blur, s)} ${unfade(color, opacity)}`)
    .join(", ");
}

/**
 * The shadow for each step of the lens's fade, and the active word's glow, for a row fitted by `f`.
 * A step is drawn for the smallest a word at its fade gets (a far word while the lens is still
 * easing in, at the at-rest zoom), so the px floors hold however the line moves.
 */
function shadowsFor(look: Look, f: RowFit): { shadows: string[]; glow: string } {
  const zoom = zoomAt(f, 0, look.width);
  const shadows: string[] = [];
  for (let i = 0; i < SHADOW_STEPS; i++) {
    const fade = i / (SHADOW_STEPS - 1);
    shadows.push(drawnShadow(look, (1 - fade * (1 - f.low)) * zoom, 1 - (1 - OPACITY_MIN) * fade));
  }
  return { shadows, glow: drawnShadow(look, zoom, 1, true) };
}

/** Index of the word being sung (or next to be), and the singing position: that index plus its progress. */
function singingAt(words: readonly Word[], t: number): number {
  let i = 0;
  while (i < words.length && t >= (words[i]?.end ?? -Infinity)) i++;
  const word = words[i];
  return word ? i + progress(word, t) : words.length;
}

/** Gap after each visual position: the separator before the logically later of the two neighbors. */
function gapsFor(m: Metrics, space: number): number[] {
  return m.order.map((a, v) => {
    const b = m.order[v + 1];
    return b !== undefined && m.spaced[Math.max(a, b) - 1] ? space : 0;
  });
}

/** A word as drawn (and measured): its own bidi paragraph, so punctuation lands on the correct side in right-to-left text. */
function wordSpan(text: string, className = ""): HTMLSpanElement {
  const span = h("span", className, text);
  span.dir = "auto";
  return span;
}

function rowElement(): HTMLDivElement {
  return h("div", "lens-row");
}

function nextElement(): HTMLDivElement {
  const next = h("div", "lens-next");
  next.dir = "auto";
  next.setAttribute("aria-hidden", "true");
  return next;
}

/**
 * Lens: the focus line in one row, magnified like a loupe around the singing position, with the next
 * line small and dim below it. Words are measured once per build; a frame only moves and recolors the
 * words of the focus line through transforms, so it never triggers layout. The DOM holds just the
 * focus line and the next one, rebuilt as the focus moves: the next line glides up into focus while
 * the old focus line fades out (the stage crossfades instead under reduced motion).
 */
export class LensMode implements ModeRenderer {
  private look: Look | null = null;
  private box: HTMLDivElement | null = null;
  private row: HTMLDivElement | null = null;
  private next: HTMLDivElement | null = null;
  private lines: readonly Line[] = [];
  private metrics: Metrics[] = [];
  /** width of a space and the baseline's offset from the top of a 1-line-height box, px at the base size */
  private space = 0;
  private baseline = 0;
  private current = -2;
  private focus: Focus | null = null;
  private nextShown: NextShown | null = null;
  /** the line change's animations on the live row and next line (and their words), cancelled by the next change */
  private glides: { el: Element; anim: Animation }[] = [];
  private lastCue: Cue | null = null;
  /** bumped on every build and destroy, so a font load that lands late can tell it is stale */
  private generation = 0;

  /** The stage crossfades line changes only under reduced motion; otherwise Lens moves its lines itself (see mount). */
  get crossfadeLines(): boolean {
    return this.look ? !this.look.motion : true;
  }

  build(host: HTMLElement, lines: readonly Line[], look: Look): void {
    this.look = look;
    this.lines = lines;
    this.current = -2;
    this.focus = null;
    this.nextShown = null;
    this.glides = [];
    host.textContent = "";
    const box = h("div", "lens");
    box.style.fontFamily = look.font;
    box.style.fontWeight = String(look.weight);
    const row = rowElement();
    const next = nextElement();
    box.append(row, next);
    host.append(box);
    this.box = box;
    this.row = row;
    this.next = next;
    this.measure(box, lines, look);
    this.remeasureWhenFontsLoad(box, lines, look);
  }

  /** New colors or glow: new shadows and next-line style; the next paint recolors the words. Glides in flight carry on. */
  restyle(look: Look): void {
    this.look = look;
    const f = this.focus;
    if (f) {
      const { shadows, glow } = shadowsFor(look, f);
      f.shadows = shadows;
      f.glow = glow;
    }
    const next = this.next;
    const shown = this.nextShown;
    if (next && shown) {
      next.style.color = look.colors.dim;
      next.style.textShadow = textShadow(look, shown.size);
    }
  }

  paint(cue: Cue): boolean {
    const look = this.look;
    if (!look) return false;
    this.lastCue = cue;
    if (cue.line !== this.current) this.mount(cue.line, cue.t, cue.running, look);
    const f = this.focus;
    if (!f) return false;

    const t = cue.t;
    const words = f.words;
    const n = words.length;
    const calm = cue.waiting || look.unsynced;
    const lensOn = look.motion && !calm;
    if (calm) {
      // shown at rest: the lens eases in once the line starts
      f.rampFrom = words[0]?.start ?? t;
      f.rampMs = RAMP_MS;
    } else if (!cue.running) {
      // paused: no frame follows this one to finish easing in
      f.rampFrom = null;
    }
    const ramp = f.rampFrom === null ? 1 : (t - f.rampFrom) / f.rampMs;
    const lens = lensOn ? easeOut(clamp01(ramp)) : 0;
    const a = lens > 0 ? singingAt(words, t) : 0;

    let singing = false;
    for (let j = 0; j < n; j++) {
      const span = f.spans[j];
      const word = words[j];
      if (!span || !word) continue;
      const k = lens > 0 ? pull(j, a) : 1;
      f.scales[j] = 1 + lens * (f.low + (SCALE_MAX - f.low) * k - 1);
      // how far the lens has faded the word: 0 in focus (or without a lens), 1 farthest
      const fade = lens * (1 - k);
      const state = calm ? "upcoming" : wordState(word, t);
      const active = state === "active";
      singing ||= active;
      put(span, "color", state === "upcoming" ? look.colors.lyric : look.colors.highlight);
      put(span, "text-shadow", active ? f.glow : (f.shadows[Math.round(fade * (SHADOW_STEPS - 1))] ?? ""));
      put(span, "opacity", (1 - (1 - OPACITY_MIN) * fade).toFixed(3));
    }

    // Lay the row out along x by hand, in visual order: scaled widths, centered, each word scaled around its baseline.
    const zoom = zoomAt(f, lens, look.width);
    const still = lens === 0;
    let x = (look.width - rowWidth(f, f.scales) * zoom) / 2;
    for (let v = 0; v < n; v++) {
      const j = f.order[v] ?? v;
      const span = f.spans[j];
      const s = f.scales[j] ?? 1;
      if (span) {
        const at = still ? snap(x, look.dpr) : x;
        put(span, "transform", `translate(${at.toFixed(2)}px, ${f.y.toFixed(2)}px) scale(${(s * zoom).toFixed(4)})`);
      }
      const right = f.order[v + 1];
      x += zoom * (s * (f.widths[j] ?? 0) + ((f.gaps[v] ?? 0) * (s + (right === undefined ? s : (f.scales[right] ?? s)))) / 2);
    }
    return lensOn && (singing || (ramp >= 0 && ramp < 1));
  }

  destroy(): void {
    this.generation++;
    this.stopGlides();
    this.box?.remove();
    this.box = null;
    this.row = null;
    this.next = null;
    this.focus = null;
    this.nextShown = null;
    this.lines = [];
    this.metrics = [];
  }

  /**
   * Widths taken before the face (or the unicode-range subset a line needs, like Vietnamese) has
   * loaded are the fallback font's. When that's the case, measure again once it's in and redraw.
   */
  private remeasureWhenFontsLoad(box: HTMLDivElement, lines: readonly Line[], look: Look): void {
    const generation = ++this.generation;
    const loading = whenFaceLoads(look.font, look.weight, lines.map((l) => l.text).join(""));
    if (!loading) return;
    void loading.then(
      () => {
        if (generation !== this.generation || this.box !== box) return;
        this.measure(box, lines, look);
        this.current = -2;
        if (this.lastCue) this.paint(this.lastCue);
      },
      () => undefined,
    );
  }

  /**
   * Measures every line at the base size in one layout pass: each word on its own (it is drawn on its
   * own, so letters must not join or kern across words, as Arabic would), the whole line as one run
   * (the next line's width), the visual word order of lines with right-to-left text, a space and the
   * baseline. Rects are divided by the stage's own scale, so a transformed preview measures right.
   */
  private measure(box: HTMLDivElement, lines: readonly Line[], look: Look): void {
    const probe = h("div", "lens-measure");
    probe.setAttribute("aria-hidden", "true");
    probe.style.fontSize = `${look.size}px`;
    const rows = lines.map((line) => {
      const iso = probe.appendChild(h("div", "lens-iso"));
      const alone = line.words.map((w) => iso.appendChild(wordSpan(w.text.trimEnd())));
      // The line as it would flow: the browser's bidi algorithm puts its words in visual order.
      const flow = probe.appendChild(h("div"));
      flow.dir = "auto";
      const last = line.words.length - 1;
      const placed = RTL.test(line.text)
        ? line.words.map((w, j) => {
            const span = flow.appendChild(h("span", "", w.text.trimEnd()));
            if (j < last && /\s$/u.test(w.text)) flow.append(" ");
            return span;
          })
        : null;
      if (!placed) flow.textContent = line.words.map((w) => w.text).join("").trimEnd();
      return { alone, flow, placed };
    });
    const ref = h("div");
    const space = ref.appendChild(h("span", "", " "));
    const mark = ref.appendChild(h("i", "lens-baseline"));
    probe.append(ref);
    box.append(probe);

    const zoom = box.offsetWidth > 0 ? box.getBoundingClientRect().width / box.offsetWidth : 1;
    const unit = zoom > 0 ? 1 / zoom : 1;
    this.space = space.getBoundingClientRect().width * unit;
    this.baseline = (mark.getBoundingClientRect().top - ref.getBoundingClientRect().top) * unit;
    this.metrics = rows.map(({ alone, flow, placed }, i) => {
      const words = lines[i]?.words ?? [];
      const order = words.map((_, j) => j);
      if (placed) {
        const centers = placed.map((span) => {
          const r = span.getBoundingClientRect();
          return r.left + r.width / 2;
        });
        order.sort((a, b) => (centers[a] ?? 0) - (centers[b] ?? 0));
      }
      return {
        widths: alone.map((s) => s.getBoundingClientRect().width * unit),
        spaced: words.map((w) => /\s$/u.test(w.text)),
        order,
        full: flow.getBoundingClientRect().width * unit,
      };
    });
    probe.remove();
  }

  /**
   * Builds the DOM for a new focus line and the line after it. -1 (or a missing line) shows nothing.
   *
   * Under motion a line change on screen moves itself (the stage's crossfade would ghost the whole
   * scene, old next line included, under the same text gliding up). Stepping to the next line, the
   * old focus line fades out where it is and the old next line glides up into focus; any other change
   * fades the old lines out and the new ones in. A fresh build (previous -2) just draws.
   *
   * Only during playback does a step glide: the lens blooms over the glide frame by frame, and no
   * frames follow a paused paint, so a paused step (a seek or a step onto the next line) would leave
   * the row flat until playback resumed. Paused, it changes like a jump, with the full lens at once.
   */
  private mount(index: number, t: number, running: boolean, look: Look): void {
    const previous = this.current;
    const was = this.nextShown;
    this.current = index;
    this.focus = null;
    this.nextShown = null;
    const change = look.motion && previous !== -2;
    const glide = change && running && previous >= 0 && index === previous + 1 && was?.index === index;
    if (change) {
      this.row = this.leave(this.row, rowElement);
      // gliding, the next line's text is what moves up into focus: its element stays for the new next line
      if (!glide) this.next = this.leave(this.next, nextElement);
    }
    this.stopGlides();
    const row = this.row;
    const next = this.next;
    if (!row || !next) return;
    row.textContent = "";
    next.textContent = "";
    const line = this.lines[index];
    const m = this.metrics[index];
    if (!line || !m) return;

    const n = line.words.length;
    const shape: Shape = { widths: m.widths, order: m.order, gaps: gapsFor(m, this.space) };
    const fit = fitRow(shape, look.size, look.width, look.motion && !look.unsynced);
    // the line's size under the full lens: where its baseline sits, and how far below the next line goes
    const size = look.size * fit.fit;
    const spans = line.words.map((w) => {
      const span = row.appendChild(wordSpan(w.text.trimEnd(), "lens-word"));
      span.style.fontSize = `${look.size}px`;
      span.style.transformOrigin = `0 ${this.baseline.toFixed(2)}px`;
      return span;
    });
    // a 1em box of the fitted size centered on look.y at scale 1; its baseline lands on a device pixel
    const baseline = snap(look.y - size / 2 + this.baseline * fit.fit, look.dpr);
    this.focus = {
      ...shape,
      ...fit,
      ...shadowsFor(look, fit),
      words: line.words,
      spans,
      y: baseline - this.baseline,
      // gliding in, the lens blooms over the glide (unsynced lines never get a lens)
      rampFrom: glide ? t : null,
      rampMs: GLIDE_MS,
      scales: new Array<number>(n).fill(1),
    };
    this.mountNext(index + 1, size, look, change, glide);
    const ms = look.unsynced ? CALM_GLIDE_MS : GLIDE_MS;
    if (glide && was) {
      // Grow from where this line just was, as the next line, around the middle of its baseline. It
      // starts at rest (the lens blooms as it goes), at the at-rest zoom.
      const from = look.size * zoomAt(fit, 0, look.width);
      row.style.transformOrigin = `${(look.width / 2).toFixed(2)}px ${baseline.toFixed(2)}px`;
      this.animate(row, [{ transform: `translate(0px, ${(was.baseline - baseline).toFixed(2)}px) scale(${(was.size / from).toFixed(4)})` }, { transform: "none" }], {
        duration: ms,
        easing: GLIDE_EASING,
      });
      // ...and from the next line's dim color to whatever each word is painted (CSS color transitions off meanwhile)
      row.classList.add("lens-arriving");
      let last: Animation | null = null;
      for (const span of spans) last = this.animate(span, [{ color: look.colors.dim, offset: 0 }], { duration: ms, easing: "ease-out" });
      if (last) {
        void last.finished.then(
          () => row.classList.remove("lens-arriving"),
          () => undefined,
        );
      } else {
        row.classList.remove("lens-arriving");
      }
    } else if (change) {
      this.fadeIn(row);
    }
  }

  private mountNext(index: number, focusSize: number, look: Look, change: boolean, glide: boolean): void {
    const next = this.next;
    const line = this.lines[index];
    const m = this.metrics[index];
    if (!next || !line || !m) return;
    const fits = m.full > 0 ? (NEXT_FIT * look.width * look.size) / m.full : Infinity;
    const preferred = Math.min(look.size * NEXT_SIZE, focusSize * NEXT_MAX_SHARE);
    const readable = Math.min(MIN_TEXT_PX, focusSize * 0.8);
    const size = Math.min(Math.max(preferred, readable), fits);
    next.textContent = line.words.map((w) => w.text).join("").trimEnd();
    next.style.fontSize = `${size}px`;
    next.style.color = look.colors.dim;
    next.style.textShadow = textShadow(look, size);
    // centered from the measured width (not translate(-50%)), so the text sits on whole device pixels
    const x = snap((look.width - (m.full * size) / look.size) / 2, look.dpr);
    const top = snap(look.y + focusSize * NEXT_DROP, look.dpr);
    const to = `translate(${x}px, ${top}px)`;
    next.style.transform = to;
    this.nextShown = { index, size, baseline: top + (this.baseline * size) / look.size };
    if (glide) {
      this.animate(next, [{ transform: `translate(${x}px, ${(top + NEXT_RISE * focusSize).toFixed(2)}px)` }, { transform: to }], {
        duration: look.unsynced ? CALM_GLIDE_MS : GLIDE_MS,
        easing: GLIDE_EASING,
      });
    }
    if (change) this.fadeIn(next);
  }

  /**
   * Fades out an element leaving the screen, where it is (any glide it is in carries on), and returns
   * an empty one of its kind to draw into, just above it. An empty element has nothing to fade: it stays.
   */
  private leave(el: HTMLDivElement | null, make: () => HTMLDivElement): HTMLDivElement | null {
    if (!el?.textContent) return el;
    this.glides = this.glides.filter((g) => !el.contains(g.el));
    el.classList.add("lens-leaving");
    const fresh = make();
    el.after(fresh);
    if (typeof el.animate === "function") {
      // from wherever it is now (it may itself be fading in), out
      const done = (): void => el.remove();
      void el.animate([{ opacity: 0 }], { duration: LINE_OUT_MS, easing: "ease-out", fill: "forwards" }).finished.then(done, done);
    } else {
      el.remove();
    }
    return fresh;
  }

  /** Fades a new line in just behind the old one's fade-out. */
  private fadeIn(el: HTMLElement): void {
    this.animate(el, [{ opacity: 0 }, { opacity: 1 }], { duration: LINE_IN_MS, delay: LINE_IN_DELAY_MS, easing: "ease-out", fill: "backwards" });
  }

  /** Runs a line change's animation on the compositor where it can (Web Animations aren't cloned into the stage's crossfade ghost). */
  private animate(el: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
    if (typeof el.animate !== "function") return null;
    const anim = el.animate(frames, options);
    this.glides.push({ el, anim });
    return anim;
  }

  private stopGlides(): void {
    for (const { anim } of this.glides) anim.cancel();
    this.glides = [];
    this.row?.classList.remove("lens-arriving");
  }
}

export function createLens(): ModeRenderer {
  return new LensMode();
}
