import "../../styles/lens.css";
import type { Line, Word } from "../../core/lrc";
import { progress } from "../../core/timing";
import { h, put } from "../dom";
import { snap, textShadow, type Look } from "../look";
import type { Cue, ModeRenderer } from "./types";

/**
 * The fisheye, from the prototype. For word j at distance d = j + 0.5 - a from the singing position a:
 * k = exp(-d² / SPREAD), scale = SCALE_MIN + (SCALE_MAX - SCALE_MIN)·k, opacity = OPACITY_MIN + (1 - OPACITY_MIN)·k.
 */
const SPREAD = 1.4;
const SCALE_MIN = 0.5;
const SCALE_MAX = 1.35;
/**
 * The prototype fades far words to 0.4. Opacity takes their dark legibility shadow down with them,
 * though, and on light or busy wallpapers the upcoming words (already at half size) all but vanish.
 * 0.6 keeps the falloff and keeps them readable.
 */
const OPACITY_MIN = 0.6;
/** Far words and the next line stay at least this many px tall (when the base size allows), so small sizes stay readable. */
const MIN_TEXT_PX = 11;
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
 * Stepping to the next line, the old next line grows up into focus (its fisheye blooming on the way)
 * and the new next line rises in from a little below, while the stage crossfades. Without it two
 * different lines dissolve through each other in both places. Runs on the compositor; slower for
 * unsynced lyrics; never under reduced motion.
 */
const GLIDE_MS = 460;
const CALM_GLIDE_MS = 800;
const GLIDE_EASING = "cubic-bezier(0.45, 0, 0.2, 1)";
/** The incoming next line rises this many focus sizes into place. */
const NEXT_RISE = 0.5;
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
interface Shape {
  /** per word, by logical index */
  widths: readonly number[];
  /** logical indices, left to right */
  order: readonly number[];
  /** space after the word at each visual position at scale 1 (0 after the last, and between CJK characters) */
  gaps: readonly number[];
}

/** The line in focus, built for drawing. Sizes are already fitted to the stage width. */
interface Focus extends Shape {
  words: readonly Word[];
  spans: HTMLSpanElement[];
  /** translateY shared by every word, putting the baseline on the device pixel grid */
  y: number;
  shadow: string;
  glow: string;
  /** smallest fisheye scale: SCALE_MIN, raised at small sizes so far words stay readable */
  low: number;
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
function pull(j: number, a: number): number {
  const d = j + 0.5 - a;
  return Math.exp(-(d * d) / SPREAD);
}

/** The smallest fisheye scale for a line at `size` px. */
function lowScale(size: number): number {
  return Math.min(0.85, Math.max(SCALE_MIN, MIN_TEXT_PX / size));
}

/** Width of a row of words at the given scales (by logical index). A space takes the mean scale of the two words beside it. */
function rowWidth(row: Shape, scales: readonly number[]): number {
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

/** The widest a row gets: at rest, and (with a lens) anywhere the singing position can be. */
function widestRow(row: Shape, low: number | null): number {
  const n = row.widths.length;
  const scales = new Array<number>(n).fill(1);
  let widest = rowWidth(row, scales);
  if (low === null) return widest;
  const steps = n * SAMPLES_PER_WORD;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * n;
    for (let j = 0; j < n; j++) scales[j] = low + (SCALE_MAX - low) * pull(j, a);
    widest = Math.max(widest, rowWidth(row, scales));
  }
  return widest;
}

/** Base size factor that keeps the row's widest moment within ROW_FIT of the stage. */
function fitFor(row: Shape, low: number | null, width: number): number {
  const widest = widestRow(row, low);
  return width > 0 && widest > 0 ? Math.min(1, (ROW_FIT * width) / widest) : 1;
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

/**
 * Lens: the focus line in one row, magnified like a loupe around the singing position, with the next
 * line small and dim below it. Words are measured once per build; a frame only moves and recolors the
 * words of the focus line through transforms, so it never triggers layout. The DOM holds just the
 * focus line and the next one, rebuilt as the focus moves (the stage crossfades between them while
 * the next line glides up into focus).
 */
export class LensMode implements ModeRenderer {
  readonly crossfadeLines = true;
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
  private glides: Animation[] = [];
  private lastCue: Cue | null = null;
  /** bumped on every build and destroy, so a font load that lands late can tell it is stale */
  private generation = 0;

  build(host: HTMLElement, lines: readonly Line[], look: Look): void {
    this.look = look;
    this.lines = lines;
    this.current = -2;
    this.focus = null;
    this.nextShown = null;
    host.textContent = "";
    const box = h("div", "lens");
    box.style.fontFamily = look.font;
    box.style.fontWeight = String(look.weight);
    const row = h("div", "lens-row");
    const next = h("div", "lens-next");
    next.dir = "auto";
    next.setAttribute("aria-hidden", "true");
    box.append(row, next);
    host.append(box);
    this.box = box;
    this.row = row;
    this.next = next;
    this.measure(box, lines, look);
    this.remeasureWhenFontsLoad(box, lines, look);
  }

  paint(cue: Cue): boolean {
    const look = this.look;
    if (!look) return false;
    this.lastCue = cue;
    if (cue.line !== this.current) this.mount(cue.line, cue.t, look);
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
      const p = calm ? 0 : progress(word, t);
      const active = p > 0 && p < 1;
      singing ||= active;
      put(span, "color", p > 0 ? look.colors.highlight : look.colors.lyric);
      put(span, "text-shadow", active ? f.glow : f.shadow);
      put(span, "opacity", (1 + lens * (OPACITY_MIN + (1 - OPACITY_MIN) * k - 1)).toFixed(3));
    }

    // Lay the row out along x by hand, in visual order: scaled widths, centered, each word scaled around its baseline.
    const still = lens === 0;
    let x = (look.width - rowWidth(f, f.scales)) / 2;
    for (let v = 0; v < n; v++) {
      const j = f.order[v] ?? v;
      const span = f.spans[j];
      const s = f.scales[j] ?? 1;
      if (span) {
        const at = still ? snap(x, look.dpr) : x;
        put(span, "transform", `translate(${at.toFixed(2)}px, ${f.y.toFixed(2)}px) scale(${s.toFixed(4)})`);
      }
      const right = f.order[v + 1];
      x += s * (f.widths[j] ?? 0) + ((f.gaps[v] ?? 0) * (s + (right === undefined ? s : (f.scales[right] ?? s)))) / 2;
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
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    if (!fonts) return;
    const spec = `${look.weight} ${look.size}px ${look.font}`;
    const sample = lines.map((l) => l.text).join(" ") || " ";
    try {
      if (fonts.check(spec, sample)) return;
    } catch {
      return;
    }
    void fonts.load(spec, sample).then(
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

  /** Builds the DOM for a new focus line and the line after it. -1 (or a missing line) shows nothing. */
  private mount(index: number, t: number, look: Look): void {
    const previous = this.current;
    const was = this.nextShown;
    this.current = index;
    this.focus = null;
    this.nextShown = null;
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
    // The floor on far words depends on the fitted size, and the fit on the floor: settle it in two passes.
    const lensed = look.motion && !look.unsynced;
    let low = lowScale(look.size);
    let fit = fitFor(shape, lensed ? low : null, look.width);
    if (lensed && lowScale(look.size * fit) > low) {
      low = lowScale(look.size * fit);
      fit = fitFor(shape, low, look.width);
    }
    const size = look.size * fit;
    const base = this.baseline * fit;
    const spans = line.words.map((w) => {
      const span = row.appendChild(wordSpan(w.text.trimEnd(), "lens-word"));
      span.style.fontSize = `${size}px`;
      span.style.transformOrigin = `0 ${base.toFixed(2)}px`;
      return span;
    });
    // a 1em box centered on look.y at scale 1; its baseline lands on a device pixel
    const y = snap(look.y - size / 2 + base, look.dpr) - base;
    const glide = look.motion && previous >= 0 && index === previous + 1 && was?.index === index;
    this.focus = {
      words: line.words,
      spans,
      widths: m.widths.map((w) => w * fit),
      order: m.order,
      gaps: shape.gaps.map((g) => g * fit),
      y,
      shadow: textShadow(look, size),
      glow: textShadow(look, size, true),
      low,
      // gliding in, the lens blooms over the glide (unsynced lines never get a lens)
      rampFrom: glide ? t : null,
      rampMs: GLIDE_MS,
      scales: new Array<number>(n).fill(1),
    };
    this.mountNext(index + 1, size, look, glide);
    if (glide && was) {
      // Grow from where this line just was, as the next line, around the middle of its baseline.
      const baseline = y + base;
      row.style.transformOrigin = `${(look.width / 2).toFixed(2)}px ${baseline.toFixed(2)}px`;
      this.glide(row, `translate(0px, ${(was.baseline - baseline).toFixed(2)}px) scale(${(was.size / size).toFixed(4)})`, "none", look);
    }
  }

  private mountNext(index: number, focusSize: number, look: Look, glide: boolean): void {
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
    if (glide) this.glide(next, `translate(${x}px, ${(top + NEXT_RISE * focusSize).toFixed(2)}px)`, to, look);
  }

  /** Runs a glide on the compositor (Web Animations aren't cloned into the stage's crossfade ghost). */
  private glide(el: HTMLElement, from: string, to: string, look: Look): void {
    if (typeof el.animate !== "function") return;
    this.glides.push(
      el.animate([{ transform: from }, { transform: to }], {
        duration: look.unsynced ? CALM_GLIDE_MS : GLIDE_MS,
        easing: GLIDE_EASING,
      }),
    );
  }

  private stopGlides(): void {
    for (const anim of this.glides) anim.cancel();
    this.glides = [];
  }
}

export function createLens(): ModeRenderer {
  return new LensMode();
}
