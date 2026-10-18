import "../../styles/lens.css";
import type { Line } from "../../core/lrc";
import { h, put } from "../dom";
import { whenFaceLoads } from "../fonts";
import { MIN_TEXT_PX, shadowLayers, snap, textShadow, type Look } from "../look";
import { paintVars } from "../motion/bloom";
import { clamp01 } from "../motion/curve";
import { InterludeDots } from "../motion/dots";
import { findInterludes, type Interlude } from "../motion/interlude";
import { wordUntil } from "../motion/karaoke";
import { compositorSteps, HOLD, holds, keyframesAt, num } from "../motion/keyframes";
import { casedLines } from "../motion/letters";
import { KaraokeLine, SLICE_MS } from "../motion/line";
import { CALM_SCROLL_SPRING, DOTS, LEAD_MS, LITE_SCROLL_MS, motionParams, paramsKey, SCROLL_SPRING, type MotionParams } from "../motion/params";
import { focusAt, leadTimes, untilNext } from "../motion/schedule";
import { playWall, springFrames, WallGlide, type WallFrames } from "../motion/scroll";
import { commit, SongTimeline } from "../motion/timeline";
import { fitRow, lensTransform, OPACITY_MIN, planLens, poseOf, smallestScale, zoomAt, type LensPlan, type LensPose, type RowFit, type Shape } from "./lens-plan";
import type { Cue, ModeRenderer } from "./types";

// The fisheye's geometry lives in lens-plan.ts (pure); these stay importable from here.
export { fitRow, pull, rowWidth, zoomAt, type RowFit, type Shape } from "./lens-plan";

/** The next line sits this many focus sizes below the focus line, at this share of the size. */
const NEXT_DROP = 1.25;
const NEXT_SIZE = 0.4;
/** ...but no larger than this share of the focus line's fitted size (its far words are at 0.5), nor wider than this share of the stage. */
const NEXT_MAX_SHARE = 0.45;
const NEXT_FIT = 0.88;
/** Room the next line keeps below its top, in its own font sizes (descenders), when it would otherwise run off the bottom. */
const NEXT_DEPTH = 1.15;
/** Gliding into focus, the incoming next line rises this many focus sizes into place. */
const NEXT_RISE = 0.5;
/**
 * The line gliding up into focus starts this bright: it was the dim next line a moment ago, and is
 * drawn in the lyric color from the start of the glide.
 */
const ARRIVE_OPACITY = 0.6;
/**
 * Any line change that doesn't glide (a seek, the first line after nothing, a break): the old lines
 * fade out where they are, and the new ones fade in just behind them, as the stage's line crossfade does.
 */
const LINE_OUT_MS = 170;
const LINE_IN_MS = 240;
const LINE_IN_DELAY_MS = 80;
/** A break's slot (the dots) is this tall, in font sizes. */
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
 * Right-to-left blocks (Hebrew, Arabic, Syriac, Thaana, N'Ko and the rest). A line containing any of
 * them takes its visual word order from the browser's bidi layout instead of reading left to right.
 */
const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;

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

/** Where a focus line goes: its row, fitted, centered at `y`, its baseline on the device pixel grid. */
interface Geometry {
  shape: Shape;
  fit: RowFit;
  /** font size under the full lens, px */
  size: number;
  /** center, px from the top of the stage */
  y: number;
  /** baseline, px from the top of the stage */
  baseline: number;
}

/** A focus line: one absolutely placed slot per word (the lens), each holding the word's `.kw` box (the karaoke). */
interface Row extends Geometry {
  index: number;
  el: HTMLDivElement;
  slots: HTMLElement[];
  words: HTMLElement[];
  /** every slot's translateY: its baseline on the line's */
  slotY: number;
  karaoke: KaraokeLine | null;
  plan: LensPlan | null;
}

/** An instrumental break in focus: the dots where the focus line goes. */
interface Break {
  il: Interlude;
  el: HTMLDivElement;
  dots: InterludeDots | null;
  /** song time its dots' motion ends */
  until: number;
}

type Focus = { kind: "line"; row: Row } | { kind: "break"; brk: Break };

/** What the view shows at a cue: a line, a break leading into one, or nothing (after the last line). */
type View = { kind: "line"; index: number } | { kind: "break"; il: Interlude } | { kind: "none" };

/** Where the next line was drawn, so it can grow from there into focus. */
interface NextShown {
  index: number;
  size: number;
  /** its baseline, px from the top of the stage */
  baseline: number;
}

/** An element fading out where it is, taken down once it has (`until`: document-timeline ms). */
interface Leaving {
  el: HTMLElement;
  anim: Animation | null;
  until: number;
  done: () => void;
}

const perfNow = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

const keyOf = (view: View): string => (view.kind === "line" ? `L${view.index}` : view.kind === "break" ? `B${view.il.start}` : "");

/**
 * The next line's font size under a focus line of `focusSize` px: NEXT_SIZE of the look's, at most
 * NEXT_MAX_SHARE of the focus line's, readable, and narrow enough for the stage. `full` is its width
 * set at the look's size.
 */
export function nextSize(full: number, focusSize: number, look: Look): number {
  const fits = full > 0 ? (NEXT_FIT * look.width * look.size) / full : Infinity;
  const preferred = Math.min(look.size * NEXT_SIZE, focusSize * NEXT_MAX_SHARE);
  const readable = Math.min(MIN_TEXT_PX, focusSize * 0.8);
  return Math.min(Math.max(preferred, readable), fits);
}

/**
 * Where the focus line's center goes: at `look.y`, unless the next line (`next` px, null for none)
 * would run off the bottom of the stage there. Then the pair moves up until it fits, but the focus
 * line no higher than resolveLook's top margin.
 */
export function focusCenter(look: Look, focusSize: number, next: number | null): number {
  if (next === null) return look.y;
  const room = look.height - focusSize * NEXT_DROP - next * NEXT_DEPTH - 2;
  return Math.max(Math.min(look.y, room), Math.min(look.size * 0.75, look.height / 2));
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

/** Gap after each visual position: the separator before the logically later of the two neighbors. */
function gapsFor(m: Metrics, space: number): number[] {
  return m.order.map((a, v) => {
    const b = m.order[v + 1];
    return b !== undefined && m.spaced[Math.max(a, b) - 1] ? space : 0;
  });
}

/** A word as measured: its own bidi paragraph, so punctuation lands on the correct side in right-to-left text. */
function wordSpan(text: string, className = ""): HTMLSpanElement {
  const span = h("span", className, text);
  span.dir = "auto";
  return span;
}

function nextElement(): HTMLDivElement {
  const next = h("div", "lens-next");
  next.dir = "auto";
  next.setAttribute("aria-hidden", "true");
  return next;
}

/**
 * Lens: the focus line in one row, magnified like a loupe around the singing position, with the next
 * line small and dim below it.
 *
 * Everything moves on the compositor. Each focus word is a slot carrying the lens (its place, size and
 * fade, planned for the line's whole window in lens-plan.ts) around the word's `.kw` box carrying the
 * karaoke (wipe, pop, ripple, held letters, bloom; motion/line.ts): scales multiply, so the word being
 * sung is the magnified one, rising, with its bloom magnified too. Both play on song time through one
 * SongTimeline, as one batch per line. Line changes come on the lead (LEAD_MS before the line): the
 * next line glides up into focus on a spring while the old focus line fades out where it is; long
 * instrumental breaks show three filling dots where the focus line goes. The page sleeps between
 * line changes: paint never asks for frames, and nextChange names the moments it must be woken for.
 */
export class LensMode implements ModeRenderer {
  /** Nothing happens at a word boundary that the compositor isn't already drawing: sleep through them. */
  readonly wordWakes = false;
  private readonly timeline = new SongTimeline();
  /** slow motion steps on the song-time beat where the engine composites stepped keyframes */
  private readonly steps = compositorSteps();
  private look: Look | null = null;
  private params: MotionParams | null = null;
  private motionKey = "";
  private box: HTMLDivElement | null = null;
  private next: HTMLDivElement | null = null;
  /** the lyric lines, in the look's case */
  private lines: Line[] = [];
  private metrics: Metrics[] = [];
  /** width of a space and the baseline's offset from the top of a 1-line-height box, px at the base size */
  private space = 0;
  private baseline = 0;
  private interludes: Interlude[] = [];
  /** when the view moves to each line (schedule.ts) */
  private leads: number[] = [];
  private focus: Focus | null = null;
  /** the focus's key (keyOf), "" for none; null before the first paint (the next one draws without fades) */
  private current: string | null = null;
  private nextShown: NextShown | null = null;
  /** what showNext last drew the next line for, to draw it again at rest */
  private nextAt: { index: number; focusSize: number; y: number } | null = null;
  /** the next focus line, built (hidden) and planned ahead in idle slices */
  private prepared: Row | null = null;
  private prepareTimer: ReturnType<typeof setTimeout> | null = null;
  /** wall-time animations on the live row and next line (glides, fades in), settled by the next change */
  private glides: { el: HTMLElement; anim: Animation }[] = [];
  private leaving: Leaving[] = [];
  private lastCue: Cue | null = null;
  private lastT = Number.NaN;
  private lastPerf = 0;
  private lastRunning = false;
  /** a retime moved the song onto another focus: paint at once (nextChange 0) */
  private dirty = false;
  /** freeze() stopped everything in place: the next paint sets it going again */
  private frozen = false;
  /** destroy() ran (and no build since): anything still scheduled does nothing */
  private destroyed = false;
  /** bumped on every build and destroy, so a font load that lands late can tell it is stale */
  private generation = 0;
  /** numbers each focus line's animation group, so a line taken down never cancels its successor's */
  private serial = 0;

  /** The stage crossfades line changes only under reduced motion; otherwise Lens moves its lines itself. */
  crossfades(_next?: Cue): boolean {
    return this.look ? !this.look.motion : true;
  }

  /** Under reduced motion a break's dots come and go without motion of Lens's own: the stage crossfades them. */
  cuts(cue: Cue): boolean {
    const look = this.look;
    if (!look || look.motion || this.current === null || cue.line < 0) return false;
    return keyOf(this.viewAt(cue)) !== this.current;
  }

  build(host: HTMLElement, lines: readonly Line[], look: Look): void {
    this.destroy();
    this.destroyed = false;
    this.look = look;
    this.params = motionParams(look);
    this.motionKey = paramsKey(this.params);
    host.textContent = "";
    const box = h("div", "lens");
    box.style.fontFamily = look.font;
    box.style.fontWeight = String(look.weight);
    box.style.fontSize = `${look.size}px`;
    if (look.letterSpacing !== 0) box.style.letterSpacing = `${num(look.letterSpacing, 3)}em`;
    if (look.unsynced) box.classList.add("is-calm");
    const next = nextElement();
    box.append(next);
    host.append(box);
    this.box = box;
    this.next = next;
    const sung = casedLines(lines, look.textCase);
    this.lines = sung;
    this.interludes = look.unsynced ? [] : findInterludes(sung);
    this.leads = leadTimes(sung);
    paintVars(box, look, look.size);
    this.measure(box, sung, look);
    this.remeasureWhenFontsLoad(box, sung, look);
    this.current = null;
    this.lastT = Number.NaN;
  }

  /**
   * A look whose shape didn't change. Colors, glow and bloom only update the CSS variables and the
   * shadows; a change of the motion's energy, snap or Effects plans the focus line again at the
   * current time, and the next line again ahead. Glides in flight carry on.
   */
  restyle(look: Look): void {
    this.look = look;
    const box = this.box;
    if (!box) return;
    paintVars(box, look, look.size);
    const f = this.focus;
    if (f?.kind === "line") this.shade(f.row, look);
    if (this.prepared) this.shade(this.prepared, look);
    const next = this.next;
    const shown = this.nextShown;
    if (next && shown) {
      put(next, "color", look.colors.dim);
      put(next, "text-shadow", textShadow(look, shown.size));
    }
    const params = motionParams(look);
    const key = paramsKey(params);
    if (key === this.motionKey) return;
    this.params = params;
    this.motionKey = key;
    this.dropPrepared();
    if (f?.kind === "line" && f.row.karaoke) {
      const t = this.timeline.position();
      f.row.karaoke.destroy();
      f.row.karaoke = null;
      this.mountRow(f.row, t, false, look);
    } else if (f?.kind === "break") {
      this.startBreak(f.brk, this.timeline.position(), look, true);
    }
    this.schedulePrepare();
  }

  paint(cue: Cue): boolean {
    const look = this.look;
    const box = this.box;
    if (!look || !box) return false;
    this.lastCue = cue;
    const perf = perfNow();
    // where the song-time motion is on screen before this cue moves it (a seek jumps it)
    const shown = this.current === null ? cue.t : this.timeline.position(perf);
    this.sync(cue, perf);
    const jumped = this.jumped(cue, perf);
    this.dirty = false;
    const view = this.viewAt(cue);
    const key = keyOf(view);
    if (key !== this.current) this.change(view, key, cue, look, shown);
    else if (this.frozen || jumped) this.refresh(cue, look, this.frozen);
    if (this.frozen) this.dropLeaving();
    this.frozen = false;
    this.tidy();
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
    if (this.current === null) return;
    if (keyOf(this.viewAt(cue)) !== this.current) {
      this.dirty = true;
      return;
    }
    if (jumped) this.refresh(cue, look, false);
  }

  /**
   * Song ms until this mode needs a paint no line boundary brings: the next line's lead, a break
   * starting or ending, the end of a playback-rate slew; 0 when a retime moved the song onto another
   * focus.
   */
  nextChange(t: number): number {
    if (this.dirty) return 0;
    let next = this.timeline.nextWake();
    if (this.look?.motion !== false) next = Math.min(next, untilNext(this.leads, t));
    for (const il of this.interludes) {
      if (il.start > t) next = Math.min(next, il.start - t);
      if (il.end > t) next = Math.min(next, il.end - t);
    }
    return next;
  }

  /** Commits everything moving to inline style and stops it (before the stage copies the scene). */
  freeze(): void {
    const f = this.focus;
    if (f?.kind === "line") f.row.karaoke?.freeze();
    this.timeline.freeze();
    for (const g of this.glides) commit(g.anim, g.el);
    this.glides = [];
    for (const l of this.leaving) if (l.anim) commit(l.anim, l.el);
    this.frozen = true;
  }

  /** Stops everything and removes the DOM; every timer it set is cleared, and one already due does nothing. */
  destroy(): void {
    this.destroyed = true;
    this.generation++;
    this.timeline.cancel();
    if (this.prepareTimer) clearTimeout(this.prepareTimer);
    this.prepareTimer = null;
    this.dropPrepared();
    const f = this.focus;
    if (f?.kind === "line") f.row.karaoke?.destroy();
    if (f?.kind === "break") f.brk.dots?.stop();
    this.focus = null;
    for (const l of this.leaving.splice(0)) {
      try {
        l.anim?.cancel();
      } catch {
        // already gone
      }
      l.done();
    }
    this.cancelGlides();
    this.box?.remove();
    this.box = null;
    this.next = null;
    this.nextShown = null;
    this.nextAt = null;
    this.current = null;
    this.lines = [];
    this.metrics = [];
    this.leads = [];
    this.interludes = [];
    this.lastCue = null;
  }

  // ---------- the song ----------

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

  /** The view at `cue`: a break while one plays, else the line whose lead has come (schedule.ts). */
  private viewAt(cue: Pick<Cue, "line" | "waiting" | "t">): View {
    const f = focusAt(cue, this.lines, this.leads, this.interludes, this.look?.motion !== false);
    if (f.interlude) return { kind: "break", il: f.interlude };
    if (f.line < 0 || !this.lines[f.line]) return { kind: "none" };
    return { kind: "line", index: f.line };
  }

  // ---------- measuring ----------

  /**
   * Widths taken before the face (or the unicode-range subset a line needs, like Vietnamese) has
   * loaded are the fallback font's. When that's the case, measure again once it's in and redraw.
   */
  private remeasureWhenFontsLoad(box: HTMLDivElement, lines: readonly Line[], look: Look): void {
    const generation = ++this.generation;
    const loading = whenFaceLoads(look.family, look.weight, lines.map((l) => l.text).join(""));
    if (!loading) return;
    void loading.then(
      () => {
        if (generation !== this.generation || this.box !== box || this.destroyed) return;
        this.measure(box, lines, look);
        this.redraw();
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

  /** Where line `index` goes in focus: fitted to the stage, centered so the line after it fits below. */
  private geometry(index: number, look: Look): Geometry | null {
    const m = this.metrics[index];
    if (!m) return null;
    const shape: Shape = { widths: m.widths, order: m.order, gaps: gapsFor(m, this.space) };
    const fit = fitRow(shape, look.size, look.width, this.lensed(look));
    const size = look.size * fit.fit;
    const after = this.lines[index + 1] ? this.metrics[index + 1] : undefined;
    const y = focusCenter(look, size, after ? nextSize(after.full, size, look) : null);
    // a 1em box of the fitted size centered on y at scale 1; its baseline lands on a device pixel
    const baseline = snap(y - size / 2 + this.baseline * fit.fit, look.dpr);
    return { shape, fit, size, y, baseline };
  }

  /** Words move under the lens: with motion, on synced lyrics (the lite tier keeps it). */
  private lensed(look: Look): boolean {
    return look.motion && !look.unsynced;
  }

  // ---------- line changes ----------

  /**
   * Brings `view` into focus. Stepping to the line drawn as the next one while playing, it glides up
   * into focus on a spring while the old focus line fades out where it is, and the line after it rises
   * in below. Any other change fades the old lines out and the new ones in. A fresh build, a change
   * after freeze() (the stage crossfades it) and reduced motion just draw.
   */
  private change(view: View, key: string, cue: Cue, look: Look, shown = cue.t): void {
    const previous = this.current;
    const was = this.nextShown;
    this.current = key;
    const animated = look.motion && previous !== null && !this.frozen;
    const glide = animated && cue.running && previous !== "" && view.kind === "line" && was?.index === view.index;
    this.settleGlides();
    const old = this.focus;
    this.focus = null;
    if (old) this.handOut(old, shown, animated);
    const box = this.box;
    if (!box) return;
    if (view.kind === "none") {
      this.showNext(-1, look.size, look.y, look, animated ? "fade" : "cut");
      return;
    }
    if (view.kind === "break") {
      // where the line before it was (or would be): the next line stays where it is drawn
      const g = (view.il.next > 0 ? this.geometry(view.il.next - 1, look) : null) ?? this.introGeometry(view.il.next, look);
      const brk = this.breakAt(view.il, g.y, look);
      this.focus = { kind: "break", brk };
      this.startBreak(brk, cue.t, look);
      this.showNext(view.il.next, g.size, g.y, look, animated ? "fade" : "cut");
      this.schedulePrepare();
      return;
    }
    const row = this.takePrepared(view.index) ?? this.buildRow(view.index, look);
    if (!row) return;
    put(row.el, "visibility", "visible");
    this.focus = { kind: "line", row };
    this.mountRow(row, cue.t, cue.running, look);
    if (glide && was) this.glideIn(row, was, look);
    else if (animated) this.fadeIn(row.el);
    this.showNext(view.index + 1, row.size, row.y, look, glide ? "glide" : animated ? "fade" : "cut");
    this.schedulePrepare();
  }

  /** A seek that kept the focus (or the first paint after freeze()): the line re-lit if its animations no longer cover the time, the break's dots likewise. */
  private refresh(cue: Cue, look: Look, force: boolean): void {
    const f = this.focus;
    if (!f) return;
    if (force) {
      // freeze() left a glide or a fade in flight where it was, inline: put them where they end
      if (f.kind === "line") {
        put(f.row.el, "transform", "none");
        put(f.row.el, "opacity", "1");
      }
      const at = this.nextAt;
      if (at) this.showNext(at.index, at.focusSize, at.y, look, "cut");
    }
    if (f.kind === "break") {
      this.startBreak(f.brk, cue.t, look, force);
      return;
    }
    const k = f.row.karaoke;
    if (k && (force || !k.covers(cue.t))) this.mountRow(f.row, cue.t, false, look);
  }

  /** Redraws the focus in place, at once (the widths changed under it). */
  private redraw(): void {
    const cue = this.lastCue;
    this.dropPrepared();
    this.settleGlides();
    const f = this.focus;
    this.focus = null;
    if (f?.kind === "line") {
      f.row.el.remove();
      f.row.karaoke?.destroy();
    } else if (f?.kind === "break") {
      f.brk.dots?.stop();
      f.brk.el.remove();
    }
    this.dropLeaving();
    this.current = null;
    this.nextShown = null;
    this.nextAt = null;
    if (this.next) this.next.textContent = "";
    if (cue) this.paint(this.timeline.playing ? { ...cue, t: this.timeline.position() } : cue);
  }

  /**
   * The old focus leaves, as it was on screen at song time `t`: a line holds its lens there and stops
   * its karaoke (sung through, as it shows sung; left early, as plain text), then fades out where it
   * is and is taken down. Its slots keep their layers until then: dropping them now would re-raster
   * the row in the line change's own frame.
   */
  private handOut(old: Focus, t: number, animated: boolean): void {
    if (old.kind === "line") {
      const row = old.row;
      if (row.plan) this.pose(row, row.plan.at(t));
      const k = row.karaoke;
      if (k && t >= k.sungBy) {
        k.finish();
      } else if (k) {
        k.destroy();
        row.karaoke = null;
      }
      // taken off the page first: the overlay's teardown then writes to nothing on screen
      this.retire(row.el, animated, () => {
        row.el.remove();
        row.karaoke?.destroy();
      });
      return;
    }
    const brk = old.brk;
    // gone by the break's end anyway (E): taken down at once then
    this.retire(brk.el, animated && t < brk.until, () => {
      brk.dots?.stop();
      brk.el.remove();
    });
  }

  /** Fades `el` out where it is, then `done`; at once without `fade`. */
  private retire(el: HTMLElement, fade: boolean, done: () => void): void {
    if (!fade || typeof el.animate !== "function") {
      done();
      return;
    }
    el.classList.add("lens-leaving");
    // from wherever it is now (settleGlides left it there inline), out
    const anim = el.animate([{ opacity: 0 }], { duration: LINE_OUT_MS, easing: "ease-out", fill: "forwards" });
    const entry: Leaving = { el, anim, until: perfNow() + LINE_OUT_MS, done };
    this.leaving.push(entry);
    anim.finished.then(
      () => this.release(entry),
      () => undefined,
    );
  }

  private release(entry: Leaving): void {
    const i = this.leaving.indexOf(entry);
    if (i < 0) return;
    this.leaving.splice(i, 1);
    entry.done();
  }

  /** Takes down everything still fading out, at once. */
  private dropLeaving(): void {
    for (const l of this.leaving.splice(0)) {
      try {
        l.anim?.cancel();
      } catch {
        // already gone
      }
      l.done();
    }
  }

  /** Takes down what has faded out by now, should its animation not say so (an engine without `finished`, a hidden page). */
  private tidy(): void {
    const now = perfNow();
    for (const l of [...this.leaving]) if (now >= l.until + LINE_OUT_MS) this.release(l);
    this.glides = this.glides.filter((g) => g.anim.playState !== "finished" && g.anim.playState !== "idle");
  }

  /** Commits the glides and fades in flight on the live elements where they are, so a new change starts from what is on screen. */
  private settleGlides(): void {
    for (const g of this.glides) {
      if (g.anim.playState === "running" || g.anim.playState === "paused") commit(g.anim, g.el);
      else g.anim.cancel();
    }
    this.glides = [];
  }

  private cancelGlides(): void {
    for (const g of this.glides) {
      try {
        g.anim.cancel();
      } catch {
        // already gone
      }
    }
    this.glides = [];
  }

  private track(el: HTMLElement, anim: Animation | null): void {
    if (anim) this.glides.push({ el, anim });
  }

  /** Fades a new line in just behind the old one's fade-out. */
  private fadeIn(el: HTMLElement): void {
    if (typeof el.animate !== "function") return;
    this.track(el, el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: LINE_IN_MS, delay: LINE_IN_DELAY_MS, easing: "ease-out", fill: "backwards" }));
  }

  /** A glide on the document timeline from now, on the line-to-line spring (calm for plain lyrics). */
  private wallGlide(look: Look): WallGlide {
    const now = perfNow();
    const glide = new WallGlide(0, look.unsynced ? CALM_SCROLL_SPRING : SCROLL_SPRING, now);
    glide.to(1, now);
    return glide;
  }

  /** `sample(x)` over a glide: smooth, or in the lite tier each pose held for a 30th of a second. */
  private wallFrames(glide: WallGlide, sample: (x: number) => Keyframe, look: Look): WallFrames {
    if (!(look.power === "lite" && this.steps)) return springFrames(glide, sample);
    const s = glide.samples(LITE_SCROLL_MS);
    const keep = holds([s.xs], [0.002]);
    return { frames: keyframesAt(s.times, keep, (i) => ({ ...sample(s.xs[i] ?? glide.target), easing: HOLD })), duration: s.duration, startTime: s.startTime };
  }

  /**
   * The row grows up into focus from where it was drawn as the next line (its size and baseline), on
   * the line-to-line spring, around the middle of its baseline. It arrives at rest (the lens eases in
   * as its first word starts), brightening from about the next line's dim to the lyric color.
   */
  private glideIn(row: Row, from: NextShown, look: Look): void {
    // it arrives at rest: every word at scale 1, at the at-rest zoom
    const zoom = zoomAt(row.fit, 0, look.width);
    const k = zoom > 0 ? from.size / (look.size * zoom) : 1;
    const dy = from.baseline - row.baseline;
    row.el.style.transformOrigin = `${num(look.width / 2, 2)}px ${num(row.baseline, 2)}px`;
    const glide = this.wallGlide(look);
    const frames = this.wallFrames(
      glide,
      (x) => ({
        transform: `translate(0px, ${num((1 - x) * dy, 2)}px) scale(${num(1 + (1 - x) * (k - 1), 4)})`,
        opacity: num(ARRIVE_OPACITY + (1 - ARRIVE_OPACITY) * clamp01(x), 3),
      }),
      look,
    );
    this.track(row.el, playWall(row.el, frames));
  }

  /**
   * Draws line `index` small and dim below a focus line of `focusSize` px centered at `y` (-1 or a
   * missing line: nothing). "glide": the element rises in from a little below on the spring (it was
   * the line that just moved into focus); "fade": a different line fades out and this one in; "cut":
   * drawn at once.
   */
  private showNext(index: number, focusSize: number, y: number, look: Look, how: "glide" | "fade" | "cut"): void {
    const line = this.lines[index];
    const m = this.metrics[index];
    const shown = this.nextShown;
    const same = shown?.index === (line && m ? index : -1);
    if (how === "fade" && !same && this.next?.textContent) this.next = this.leaveNext(this.next);
    const next = this.next;
    if (!next) return;
    if (!line || !m) {
      next.textContent = "";
      this.nextShown = null;
      this.nextAt = null;
      return;
    }
    const size = nextSize(m.full, focusSize, look);
    // centered from the measured width (not translate(-50%)), so the text sits on whole device pixels
    const x = snap((look.width - (m.full * size) / look.size) / 2, look.dpr);
    const top = snap(y + focusSize * NEXT_DROP, look.dpr);
    const text = line.words.map((w) => w.text).join("").trimEnd();
    if (next.textContent !== text) next.textContent = text;
    put(next, "font-size", `${num(size, 2)}px`);
    put(next, "color", look.colors.dim);
    put(next, "text-shadow", textShadow(look, size));
    put(next, "transform", `translate(${num(x, 2)}px, ${num(top, 2)}px)`);
    put(next, "opacity", "1");
    this.nextShown = { index, size, baseline: top + (this.baseline * size) / look.size };
    this.nextAt = { index, focusSize, y };
    if (how === "glide") {
      const rise = NEXT_RISE * focusSize;
      const frames = this.wallFrames(
        this.wallGlide(look),
        (p) => ({ transform: `translate(${num(x, 2)}px, ${num(top + (1 - p) * rise, 2)}px)`, opacity: num(clamp01(p), 3) }),
        look,
      );
      this.track(next, playWall(next, frames));
    } else if (how === "fade" && !same) {
      this.fadeIn(next);
    }
  }

  /** The next line element fades out where it is; an empty one of its kind takes its place. */
  private leaveNext(el: HTMLDivElement): HTMLDivElement {
    const fresh = nextElement();
    el.after(fresh);
    this.retire(el, true, () => el.remove());
    return fresh;
  }

  // ---------- the focus row ----------

  /** The focus geometry before the first line (an intro break): the look's size, the first line below. */
  private introGeometry(next: number, look: Look): Geometry {
    const m = this.metrics[next];
    const y = focusCenter(look, look.size, m ? nextSize(m.full, look.size, look) : null);
    return { shape: { widths: [], order: [], gaps: [] }, fit: { low: 1, rest: 0, widest: 0, fit: 1 }, size: look.size, y, baseline: y };
  }

  /** Builds line `index`'s row: a slot per word, each placed at the line's baseline, holding the word's `.kw` box. */
  private buildRow(index: number, look: Look, hidden = false): Row | null {
    const line = this.lines[index];
    const g = this.geometry(index, look);
    const box = this.box;
    if (!line || !g || !box) return null;
    const el = h("div", "lens-row kw-host");
    el.dir = "auto";
    if (hidden) put(el, "visibility", "hidden");
    const origin = `0 ${num(this.baseline, 2)}px`;
    const slots: HTMLElement[] = [];
    const words: HTMLElement[] = [];
    for (const w of line.words) {
      const slot = h("span", "lens-slot");
      slot.dir = "auto";
      slot.style.transformOrigin = origin;
      const word = h("span", "kw");
      word.append(h("span", "kw-txt", w.text.trimEnd()));
      slot.append(word);
      el.append(slot);
      slots.push(slot);
      words.push(word);
    }
    // under the next line (and any line fading out), so it never covers them while gliding past
    box.insertBefore(el, box.firstChild);
    const row: Row = { ...g, index, el, slots, words, slotY: g.baseline - this.baseline, karaoke: null, plan: null };
    this.shade(row, look);
    // where it rests: at rest, and in the line's lens once planned (mountRow)
    this.pose(row, poseOf(g.shape, g.fit, look.width, look.dpr, 0, 0));
    return row;
  }

  /**
   * The row's dark legibility shadow (`--ut-dark` on every slot), drawn once for the smallest and
   * faintest the lens makes a word, so far words keep its px floors and full strength and nothing is
   * re-rastered as the lens moves.
   */
  private shade(row: Row, look: Look): void {
    const lensed = this.lensed(look);
    const shadow = drawnShadow(look, smallestScale(row.fit, look.width, lensed), lensed ? OPACITY_MIN : 1);
    for (const slot of row.slots) put(slot, "--ut-dark", shadow);
  }

  /** Every slot's inline style: what shows outside the lens's animations. */
  private pose(row: Row, pose: LensPose): void {
    row.slots.forEach((slot, j) => {
      put(slot, "transform", lensTransform(pose.x[j] ?? 0, row.slotY, pose.scale[j] ?? 1));
      put(slot, "opacity", num(pose.opacity[j] ?? 1, 3));
    });
  }

  /**
   * Starts the row's karaoke and lens as of song time `t`: the lens planned over the line's window
   * (kept if the plan in hand covers it) and played with the karaoke as one batch. A line arriving
   * before its first word eases the lens in from that word; one arriving mid-line has it in full.
   * Plain lyrics rest, with no overlay.
   */
  private mountRow(row: Row, t: number, settleIn: boolean, look: Look): void {
    const line = this.lines[row.index];
    if (!line) return;
    const words = line.words;
    const params = this.params ?? motionParams(look);
    const first = words[0]?.start ?? t;
    const origin = Math.min(t, first);
    let end = origin + 1;
    for (const w of words) end = Math.max(end, wordUntil(w, params));
    const lensed = this.lensed(look);
    if (lensed) {
      const plan = row.plan;
      const covers = plan !== null && plan.end === end && plan.origin <= origin && (plan.rampFrom === null || plan.rampFrom === first);
      if (!covers) row.plan = this.planFor(row, origin, end, t <= first ? first : null, look);
    } else {
      row.plan = null;
    }
    const plan = row.plan;
    this.pose(row, plan ? plan.final : poseOf(row.shape, row.fit, look.width, look.dpr, 0, 0));
    for (const slot of row.slots) put(slot, "will-change", plan ? "transform, opacity" : "auto");
    if (look.unsynced) return;
    row.karaoke ??= this.karaokeFor(row, look);
    row.el.classList.add("has-fx");
    row.karaoke.mount(t, settleIn, plan ? row.slots.map((el, j) => ({ el, track: plan.tracks[j] ?? { t0: origin, duration: end - origin, frames: [] } })) : []);
  }

  private planFor(row: Row, origin: number, end: number, rampFrom: number | null, look: Look): LensPlan {
    return planLens({
      words: this.lines[row.index]?.words ?? [],
      shape: row.shape,
      fit: row.fit,
      width: look.width,
      y: row.slotY,
      dpr: look.dpr,
      origin,
      end,
      rampFrom,
      motion: this.lensed(look),
      steps: this.steps,
      hold: look.power === "lite" && this.steps,
    });
  }

  private karaokeFor(row: Row, look: Look): KaraokeLine {
    return new KaraokeLine(
      this.lines[row.index]?.words ?? [],
      row.words,
      {
        size: look.size,
        font: `${look.weight} ${look.size.toFixed(2)}px ${look.font}`,
        letterSpacingPx: look.letterSpacing * look.size,
        params: this.params ?? motionParams(look),
        steps: this.steps,
      },
      this.timeline,
      `lens${++this.serial}`,
    );
  }

  /** The prepared row, if it is line `index`'s; any other prepared row is dropped. */
  private takePrepared(index: number): Row | null {
    const row = this.prepared;
    this.prepared = null;
    if (row?.index === index) return row;
    if (row) this.dropRow(row);
    return null;
  }

  private dropPrepared(): void {
    if (this.prepareTimer) clearTimeout(this.prepareTimer);
    this.prepareTimer = null;
    const row = this.prepared;
    this.prepared = null;
    if (row) this.dropRow(row);
  }

  private dropRow(row: Row): void {
    row.el.remove();
    row.karaoke?.destroy();
    row.karaoke = null;
  }

  /**
   * Builds the next focus line (hidden) and plans its words and its lens ahead, in idle slices of
   * SLICE_MS starting once this line's own mount has finished, so its line change only has
   * animations to start.
   */
  private schedulePrepare(): void {
    if (this.prepareTimer) clearTimeout(this.prepareTimer);
    this.prepareTimer = null;
    const look = this.look;
    if (this.destroyed || !look || look.unsynced || typeof setTimeout !== "function") return;
    const box = this.box;
    const step = (): void => {
      this.prepareTimer = null;
      const live = this.look;
      // destroyed or rebuilt since: a step that was already due does nothing
      if (this.destroyed || this.box !== box || !box || !live) return;
      const f = this.focus;
      // the line in focus finishes mounting first
      if (f?.kind === "line" && f.row.karaoke?.mounting) {
        this.prepareTimer = setTimeout(step, PREPARE_GAP_MS);
        return;
      }
      const index = f?.kind === "break" ? f.brk.il.next : f?.kind === "line" ? f.row.index + 1 : -1;
      const line = this.lines[index];
      if (!line || line.words.length === 0) return;
      if (this.prepared?.index !== index) {
        this.dropPrepared();
        this.prepared = this.buildRow(index, live, true);
      }
      const row = this.prepared;
      if (!row) return;
      row.karaoke ??= this.karaokeFor(row, live);
      const first = line.words[0]?.start ?? 0;
      const lead = Math.min(first, this.leads[index] ?? first - LEAD_MS);
      if (!row.karaoke.prepare(SLICE_MS, lead)) {
        this.prepareTimer = setTimeout(step, PREPARE_GAP_MS);
        return;
      }
      if (this.lensed(live) && !row.plan) {
        const params = this.params ?? motionParams(live);
        let end = lead + 1;
        for (const w of line.words) end = Math.max(end, wordUntil(w, params));
        row.plan = this.planFor(row, lead, end, first, live);
      }
    };
    this.prepareTimer = setTimeout(step, PREPARE_DELAY_MS);
  }

  // ---------- breaks ----------

  /** A break's slot, centered where the focus line goes. */
  private breakAt(il: Interlude, y: number, look: Look): Break {
    const el = h("div", "lens-break");
    const height = BREAK_EM * look.size;
    el.style.top = `${num(y - height / 2, 2)}px`;
    el.style.height = `${num(height, 2)}px`;
    this.box?.insertBefore(el, this.box.firstChild);
    return { il, el, dots: null, until: il.end };
  }

  /** The break's dots, anchored to its start (a seek into the middle of a break joins it there). */
  private startBreak(brk: Break, t: number, look: Look, force = false): void {
    const group = `dots${brk.il.start}`;
    if (!force && brk.dots && this.timeline.busy(group, t)) return;
    brk.dots ??= new InterludeDots(brk.el, DOTS.em * look.size);
    brk.until = brk.dots.play(brk.il, this.timeline, this.params ?? motionParams(look), group, this.steps);
  }
}

export function createLens(): ModeRenderer {
  return new LensMode();
}
