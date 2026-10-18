/**
 * One sung line's karaoke, on the compositor. The mode lays the line out as `.kw` word boxes (plain
 * text, kerned, for layout and for the line at rest) inside a row that carries the class `kw-host`.
 * While the row has `has-fx`, each word box shows an overlay drawn over its plain text:
 *
 *   .kw              the word box: its transform is the word's pop (rest: a little small and low)
 *     .kw-txt        the plain text (hidden while the overlay shows; with `place`, split into placed letters)
 *     .kw-fx         the overlay (text-shadow: none throughout, but for the dark copy and the blooms)
 *       .kw-dark     the dark legibility shadow: transparent text whose text-shadow is --ut-dark. It sits
 *                    under everything, outside every clip and mask, so no window ever cuts a shadow.
 *                    Wherever letters move it is split into letters, each moving with its lit twin.
 *       .kl-glow     held syllables: each letter's own, stronger bloom
 *       .kw-glow     the word's bloom (a fill-less copy whose text-shadow glows; opacity animated)
 *       .kw-track    slides across the word, carrying two windows that meet at its feathered edge:
 *         .kw-bwin   the unlit part: the letters in the lyric color (clipped where the feather begins)
 *           .kw-in   ...its contents sliding back, so the letters stay put
 *         .kw-win    the lit part: the letters in the highlight (faded out over the feather, over the base)
 *           .kw-in   ...likewise
 *
 * Each letter sits where the whole word draws it (kerning and letter-spacing kept). Only one copy of
 * a letter shows outside the feather, so a lit letter can hop on its own without its unlit twin
 * peeking out under it: the base copy only moves in held syllables, whose letters rise as they light.
 *
 * Every word's motion is planned (karaoke.ts) and handed to the compositor sharing one window, the
 * line's [origin, end]: Chromium needs a main-thread frame to start a batch and another when it ends,
 * so a line costs two whatever it moves; WebKit hands the same animations to Core Animation. The work
 * is sliced: `prepare` builds and plans the next line in short idle slices ahead of time, `mount` runs
 * a first slice (the words sung by now or within 400 ms) and the rest on the next frames, earliest
 * first. Words not mounted yet hold their pose inline.
 */
import type { Word } from "../../core/lrc";
import { h, put } from "../dom";
import {
  closedWindow,
  FEATHER,
  FULL_TRANSFORM,
  heldParts,
  letterRest,
  OVERHANG,
  partsOf,
  planWord,
  rebase,
  restTransform,
  wordUntil,
  type LetterBox,
  type Part,
  type Track,
  type WordMotion,
  type WordShape,
} from "./karaoke";
import { compositorSteps } from "./keyframes";
import { canvasMeasure, isRtl, measureLetters, roughMeasure, type Measure } from "./letters";
import { LEAD_MS, LEAVE_MS, SETTLE_IN_MS, type MotionParams } from "./params";
import type { SongTimeline } from "./timeline";

export { LEAVE_MS, SETTLE_IN_MS };

/** What a karaoke line needs to know about how it is drawn. */
export interface KaraokeLook {
  /** the row's font size, px */
  size: number;
  /** CSS font shorthand for measuring, e.g. `700 58px "Fraunces", serif` */
  font: string;
  /** CSS letter-spacing of the row, px */
  letterSpacingPx: number;
  /** from motionParams(look) */
  params: MotionParams;
  /** a static placement for every copy of every letter (Arc: letters on its curve); forces the letter split */
  place?: LetterPlacer;
  /** slow stretches step on the song-time beat (PlanOptions.steps); compositorSteps() when absent */
  steps?: boolean;
}

/**
 * Where letter `letter` of word `word` sits, relative to where the word box would draw it: applied to
 * every copy of the letter (base, lit, dark and bloom copies, and the plain text) through the CSS
 * `translate` and `rotate` properties, around the letter's transform-origin (stage.css `.kl`: 50% 64%).
 * Its animated `transform` (a hop) composes on top, so it moves along the letter's own normal.
 */
export type LetterPlacer = (word: number, letter: number, box: LetterBox) => { dx: number; dy: number; rotate: number } | null;

/** An extra track played in the line's batch, rebased onto its window (Lens: each word's fisheye). */
export interface Along {
  el: Element;
  track: Track;
}

/**
 * The first mount slice, run in the paint that brings the line in, takes only the words due within
 * this long of the origin (or of now): the ones already sung after a seek, or starting at once. Every
 * other word waits, held in its rest pose, for the slices on the frames after, so the frame that
 * starts the list's scroll doesn't also start the line's hundred animations.
 */
const FIRST_SLICE_MS = 100;
/** Prepare slices (idle timers) stop taking new words once they have run this long, ms. */
export const SLICE_MS = 6;
/**
 * Mount slices (one per frame) stop taking new words once they have run this long, ms: every word they
 * start adds its layers to that frame's commit and raster, so a frame takes a few words, not a line.
 */
export const MOUNT_SLICE_MS = 2;
/** The overlay reaches this far beyond the word's box (glyph overhangs, the lift, the bloom), in em. */
const PAD_EM = 0.5;

interface Overlay {
  fx: HTMLElement;
  /** the dark copy, and its letters where letters move */
  dark: HTMLElement;
  darkLetters: HTMLElement[];
  /** the word's bloom, and its letters when placed */
  glow: HTMLElement;
  glowLetters: HTMLElement[];
  /** the windows' track, the lit window, and the two windows' contents */
  track: HTMLElement;
  win: HTMLElement;
  inners: HTMLElement[];
  /** letter spans of the base copy (held syllables, placed letters), else none */
  base: HTMLElement[];
  /** letter spans of the lit copy where letters move or are placed, else none */
  lit: HTMLElement[];
  letterGlows: HTMLElement[];
  /** letter transforms at rest (held letters sit a little small and low) */
  letterRest: string[];
}

interface WordView {
  index: number;
  word: Word;
  /** without the trailing space */
  text: string;
  el: HTMLElement;
  parts: Part[];
  /** which parts are held notes under the look's emphasis rule */
  held: boolean[];
  shape: WordShape | null;
  ov: Overlay | null;
  /** the plain text, split into placed letters (with `place`), and what it read before */
  txt: { el: HTMLElement; text: string } | null;
  mounted: boolean;
}

const px = (v: number): string => `${v.toFixed(2)}px`;
const now = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

/** The first child of `el` with class `cls`. */
function childWithClass(el: HTMLElement, cls: string): HTMLElement | undefined {
  const children = el.children;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c?.classList.contains(cls)) return c as HTMLElement;
  }
  return undefined;
}

/** Runs `fn` on the next frame (a timer without frames); returns a canceller. */
export function nextFrame(fn: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(() => fn());
    return () => {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
    };
  }
  const id = setTimeout(fn, 16);
  return () => clearTimeout(id);
}

export class KaraokeLine {
  private readonly views: WordView[] = [];
  private readonly timeline: SongTimeline;
  private readonly group: string;
  private readonly look: KaraokeLook;
  private readonly steps: boolean;
  private measure: Measure | null = null;
  private origin = 0;
  private end = 0;
  private settleIn = false;
  private readonly plans = new Map<string, WordMotion>();
  private cancelSlice: (() => void) | null = null;
  private destroyed = false;

  /** `els[i]` is the `.kw` box of `words[i]`. Nothing is built or measured until prepare or mount asks. */
  constructor(words: readonly Word[], els: readonly HTMLElement[], look: KaraokeLook, timeline: SongTimeline, group: string) {
    this.timeline = timeline;
    this.group = group;
    this.look = look;
    this.steps = look.steps ?? compositorSteps();
    const last = words.length - 1;
    words.forEach((word, i) => {
      const el = els[i];
      if (!el) return;
      const text = word.text.trimEnd();
      this.views.push({
        index: i,
        word,
        text,
        el,
        parts: partsOf(word, word.text),
        held: heldParts(word, word.text, look.params.emphasis, i === last),
        shape: null,
        ov: null,
        txt: null,
        mounted: false,
      });
    });
  }

  /** The song-time window the line's animations share, once mounted. */
  get span(): { origin: number; end: number } {
    return { origin: this.origin, end: this.end };
  }

  /** Song time its last word ends. */
  get sungBy(): number {
    return Math.max(0, ...this.views.map((v) => v.word.end));
  }

  /** Mount slices are still to run. */
  get mounting(): boolean {
    return this.cancelSlice !== null;
  }

  /**
   * Whether its animations still draw song time `t` correctly: not when `t` is before the window's
   * origin (a seek back past it) or the window's animations are gone (pruned once ended, then a seek
   * back into it). Past the window's end the words rest sung, which is right.
   */
  covers(t: number): boolean {
    if (t < this.origin) return false;
    if (t >= this.end || this.mounting) return true;
    return this.timeline.busy(this.group, t);
  }

  /**
   * Builds and plans words ahead, for a line expected to come into focus at `origin` (by default its
   * lead: LEAD_MS before its first word), for at most `budgetMs`. True once every word is ready, so
   * mounting only has animations to start.
   */
  prepare(budgetMs = SLICE_MS, origin = (this.views[0]?.word.start ?? 0) - LEAD_MS): boolean {
    if (this.destroyed) return true;
    const started = now();
    let done = 0;
    for (const v of this.views) {
      if (v.ov && this.plans.has(this.planKey(v, origin, true))) continue;
      // at least one word a slice, however slow the clock says the last one was
      if (done > 0 && now() - started >= budgetMs) return false;
      this.overlayOf(v);
      this.planFor(v, origin, true);
      done++;
    }
    return true;
  }

  /**
   * Starts the line's motion as of song time `t` (the line coming into focus): words already sung
   * show sung, the one being sung joins mid-way, the rest wait at rest. A seek within the line needs
   * nothing more as long as it `covers` the new time: the song timeline moves them all. `settleIn`
   * (the line arrives while playing) eases its words from full size into their rest pose. `along`
   * tracks play in the same batch.
   */
  mount(t: number, settleIn: boolean, along: readonly Along[] = []): void {
    if (this.destroyed) return;
    this.stopSlices();
    this.timeline.cancel(this.group);
    const { params } = this.look;
    const origin = Math.min(t, this.views[0]?.word.start ?? t);
    let end = origin + 1;
    for (const v of this.views) end = Math.max(end, wordUntil(v.word, params));
    for (const a of along) end = Math.max(end, a.track.t0 + a.track.duration);
    this.origin = origin;
    this.end = end;
    this.settleIn = settleIn;
    for (const v of this.views) v.mounted = false;
    // the line's own motion first (Lens's fisheye), then its words
    for (const a of along) this.timeline.play(a.el, rebase(a.track, origin, end), origin, end - origin, this.group);
    const must = Math.max(origin, t) + FIRST_SLICE_MS;
    for (const v of this.views) {
      if (v.word.start >= must) break;
      this.mountWord(v);
    }
    const rest = this.views.filter((v) => !v.mounted);
    for (const v of rest) this.hold(v);
    if (rest.length > 0) this.scheduleSlice();
  }

  /**
   * Stops the line's motion where it ends (every word sung, in place, no bloom): for a line leaving
   * focus once it has been sung, so that its overlay fades out as one still picture rather than a
   * hundred layers the compositor keeps redrawing as the list scrolls. All it cuts short is the last
   * word's springs settling their final pixel.
   */
  finish(): void {
    this.stopSlices();
    this.timeline.cancel(this.group);
    for (const v of this.views) {
      if (v.ov) this.finalStyle(v, v.ov);
      else put(v.el, "transform", FULL_TRANSFORM);
      v.mounted = true;
    }
  }

  /** Stops where it is: what is on screen stays, as inline style (before the stage copies the page). */
  freeze(): void {
    this.stopSlices();
    this.timeline.freeze(this.group);
  }

  /** Removes the overlays (the plain text shows again) and stops their motion. */
  destroy(): void {
    this.stopSlices();
    this.destroyed = true;
    this.timeline.cancel(this.group);
    for (const v of this.views) {
      v.ov?.fx.remove();
      v.ov = null;
      v.el.classList.remove("kw-on");
      put(v.el, "transform", FULL_TRANSFORM);
      put(v.el, "will-change", "auto");
      if (v.txt) v.txt.el.textContent = v.txt.text;
      v.txt = null;
    }
    this.views.length = 0;
  }

  // ---------- slices ----------

  private scheduleSlice(): void {
    if (this.cancelSlice || this.destroyed) return;
    this.cancelSlice = nextFrame(() => {
      this.cancelSlice = null;
      if (this.destroyed) return;
      const started = now();
      let done = 0;
      for (const v of this.views) {
        if (v.mounted) continue;
        if (done > 0 && now() - started >= MOUNT_SLICE_MS) break;
        this.mountWord(v);
        done++;
      }
      if (this.views.some((v) => !v.mounted)) this.scheduleSlice();
    });
  }

  private stopSlices(): void {
    this.cancelSlice?.();
    this.cancelSlice = null;
  }

  // ---------- planning ----------

  /** A word sung as its line arrives never settled into rest: its pop starts from full size. */
  private fromOf(v: WordView, origin: number, settleIn: boolean): "rest" | "full" {
    return settleIn && !(this.moves() && v.word.start - origin >= SETTLE_IN_MS) ? "full" : "rest";
  }

  private planKey(v: WordView, origin: number, settleIn: boolean): string {
    return `${v.index}:${this.fromOf(v, origin, settleIn)}`;
  }

  /** The word's plan for a line starting at `origin`, memoized by the pose its pop starts from. */
  private planFor(v: WordView, origin: number, settleIn: boolean): WordMotion {
    const key = this.planKey(v, origin, settleIn);
    let plan = this.plans.get(key);
    if (!plan) {
      plan = planWord(v.word, v.text, this.shapeOf(v), this.look.params, {
        from: this.fromOf(v, origin, settleIn),
        isLast: v.index === this.views.length - 1,
        steps: this.steps,
      });
      this.plans.set(key, plan);
    }
    return plan;
  }

  /** Words rise, swell and hop (the "full" karaoke with an amplitude). */
  private moves(): boolean {
    return this.look.params.karaoke === "full" && this.look.params.amp > 0;
  }

  private settles(v: WordView): boolean {
    return this.settleIn && this.moves() && v.word.start - this.origin >= SETTLE_IN_MS;
  }

  private mountWord(v: WordView): void {
    const ov = this.overlayOf(v);
    const plan = this.planFor(v, this.origin, this.settleIn);
    const { size, params } = this.look;
    this.layer(v);
    // the resting style is the end state: what shows once the line's animations are over
    this.finalStyle(v, ov);
    const lead = this.settles(v)
      ? [
          { at: this.origin, frame: { transform: FULL_TRANSFORM } },
          { at: this.origin + SETTLE_IN_MS, frame: { transform: restTransform(size, params) } },
        ]
      : [];
    this.play(v.el, plan.pop, lead);
    this.play(ov.track, plan.window);
    for (const inner of ov.inners) this.play(inner, plan.inner);
    this.play(ov.win, plan.litFade);
    this.play(ov.glow, plan.glow);
    plan.letters.forEach((track, j) => {
      if (!track) return;
      const copies = plan.moveBase[j] ? [ov.lit[j], ov.darkLetters[j], ov.base[j], ov.letterGlows[j]] : [ov.lit[j], ov.darkLetters[j]];
      for (const el of copies) if (el) this.play(el, track);
    });
    plan.letterGlows.forEach((track, j) => {
      const g = ov.letterGlows[j];
      if (g && track) this.play(g, track);
    });
    v.mounted = true;
  }

  /** A word waiting for its slice: at rest, nothing lit; still at full size if its line settles in. */
  private hold(v: WordView): void {
    if (v.ov) this.restStyle(v, v.ov);
    const pose = !this.moves() || this.settles(v) ? FULL_TRANSFORM : restTransform(this.look.size, this.look.params);
    put(v.el, "transform", pose);
    this.layer(v);
  }

  /**
   * A word that will pop gets its own layer from the moment its line comes in, not when its slice
   * starts its motion: otherwise every slice would take words out of the row's layer and the whole
   * row would repaint and re-raster again, frame after frame.
   */
  private layer(v: WordView): void {
    if (this.moves()) put(v.el, "will-change", "transform");
  }

  private play(el: Element | undefined, track: Track | null, lead: readonly { at: number; frame: Keyframe }[] = []): void {
    if (!el || !track) return;
    this.timeline.play(el, rebase(track, this.origin, this.end, lead), this.origin, this.end - this.origin, this.group);
  }

  // ---------- building ----------

  private shapeOf(v: WordView): WordShape {
    if (v.shape) return v.shape;
    const { size, font, letterSpacingPx } = this.look;
    this.measure ??= canvasMeasure(font) ?? roughMeasure(size);
    const { width, letters } = measureLetters(v.text, v.parts, this.measure, letterSpacingPx);
    v.shape = { width, size, letters, rtl: isRtl(v.text) };
    return v.shape;
  }

  private overlayOf(v: WordView): Overlay {
    if (!v.ov) v.ov = this.build(v);
    return v.ov;
  }

  private build(v: WordView): Overlay {
    const shape = this.shapeOf(v);
    const { size, params, place } = this.look;
    const full = params.karaoke === "full";
    const split = shape.letters.length >= 2;
    // letters move: every word's letters ripple, a held syllable's rise as they light
    const moves = this.moves() && split;
    const held = full && split && v.held.some(Boolean);
    const placed = place !== undefined;
    const text = v.text;
    const fx = h("span", "kw-fx");
    fx.setAttribute("aria-hidden", "true");
    const letterSpans = (box: HTMLElement, cls = "kl"): HTMLElement[] =>
      shape.letters.map((l) => {
        const sp = h("span", cls, l.text);
        sp.style.left = px(l.x);
        box.append(sp);
        return sp;
      });
    const whole = (box: HTMLElement): HTMLElement[] => {
      box.append(h("span", "kl", text));
      return [];
    };

    // the dark legibility copy, under everything and unclipped
    const dark = h("span", "kw-dark");
    const darkLetters = moves || placed ? letterSpans(dark) : (dark.textContent = text, []);
    // held letters' own blooms
    const letterGlows: HTMLElement[] = [];
    if (held) {
      for (const l of shape.letters) {
        const g = h("span", "kl kl-glow", l.text);
        g.style.left = px(l.x);
        letterGlows.push(g);
      }
    }
    // the word's bloom
    const glow = h("span", "kw-glow");
    const glowLetters = placed ? letterSpans(glow) : (glow.textContent = text, []);

    // The windows, in track coordinates (where the track rests when the word is fully lit). LTR: the
    // lit window runs from PAD_EM before the word to its end plus the overhang, then fades out over the
    // feather. The base window starts, hard-edged, where that fade begins and runs on past the word:
    // over the feather the lit copy fades out over the base copy at full strength, which is a true
    // crossfade (two complementary masks would let the wallpaper through mid-way), and a clip costs the
    // compositor nothing where a second mask would cost an offscreen pass per word. RTL mirrors it.
    const W = shape.width;
    const pad = PAD_EM * size;
    const feather = Math.max(1, FEATHER * W);
    const over = OVERHANG * size;
    const span = pad + W + over + feather;
    const track = h("span", "kw-track");
    const win = h("span", "kw-win");
    const bwin = h("span", "kw-bwin");
    const litLeft = shape.rtl ? -(over + feather) : -pad;
    const baseLeft = shape.rtl ? -(W + 2 * over + feather + pad) : W + over;
    const inners: HTMLElement[] = [];
    for (const [w, left] of [
      [bwin, baseLeft],
      [win, litLeft],
    ] as const) {
      w.style.left = px(left);
      w.style.width = px(span);
      const inner = h("span", "kw-in");
      inner.style.left = px(-left);
      w.append(inner);
      inners.push(inner);
    }
    if (full) {
      // the lit window's mask: opaque, then fading over the feather at the end the wipe moves toward
      const stop = shape.rtl ? ((feather / span) * 100).toFixed(2) : (((span - feather) / span) * 100).toFixed(2);
      const mask = shape.rtl ? `linear-gradient(90deg, transparent 0%, #000 ${stop}%, #000 100%)` : `linear-gradient(90deg, #000 0%, #000 ${stop}%, transparent 100%)`;
      win.style.setProperty("mask-image", mask);
      win.style.setProperty("-webkit-mask-image", mask);
    } else {
      // "fade" never wipes: the base copy stays whole underneath and the lit one fades in over it
      bwin.style.left = px(-pad);
      inners[0]?.style.setProperty("left", px(pad));
    }
    win.classList.add("is-lit");
    // The base copy moves letter by letter only in a held syllable; otherwise it is one run of text,
    // laid out by the browser exactly as the plain text is (ligatures and all).
    const [baseBox, litBox] = inners as [HTMLElement, HTMLElement];
    const base = (held && moves) || placed ? letterSpans(baseBox) : whole(baseBox);
    const lit = moves || placed ? letterSpans(litBox) : whole(litBox);
    track.append(bwin, win);
    fx.append(dark, ...letterGlows, glow, track);
    v.el.append(fx);
    v.el.classList.add("kw-on");
    const ov: Overlay = {
      fx,
      dark,
      darkLetters,
      glow,
      glowLetters,
      track,
      win,
      inners,
      base,
      lit,
      letterGlows,
      letterRest: this.restOf(v, shape),
    };
    if (placed) this.placeLetters(v, shape, ov);
    this.restStyle(v, ov);
    return ov;
  }

  private restOf(v: WordView, shape: WordShape): string[] {
    return letterRest(v.word, v.text, shape, this.look.params, v.index === this.views.length - 1);
  }

  /** `place`: every copy of each letter, and the plain text split into the same letters, placed alike. */
  private placeLetters(v: WordView, shape: WordShape, ov: Overlay): void {
    const place = this.look.place;
    if (!place) return;
    const txtEl = childWithClass(v.el, "kw-txt");
    let txtLetters: HTMLElement[] = [];
    if (txtEl && !v.txt) {
      v.txt = { el: txtEl, text: txtEl.textContent ?? "" };
      txtEl.textContent = "";
      // the word's own run keeps the box its size, unseen; the letters draw it
      txtEl.append(h("span", "kw-hold", v.txt.text));
      txtLetters = shape.letters.map((l) => {
        const sp = h("span", "kl", l.text);
        sp.style.left = px(l.x);
        txtEl.append(sp);
        return sp;
      });
    }
    shape.letters.forEach((box, j) => {
      const p = place(v.index, j, box);
      if (!p) return;
      const translate = `${p.dx.toFixed(2)}px ${p.dy.toFixed(2)}px`;
      const rotate = `${p.rotate.toFixed(3)}deg`;
      for (const el of [ov.darkLetters[j], ov.glowLetters[j], ov.base[j], ov.lit[j], ov.letterGlows[j], txtLetters[j]]) {
        if (!el) continue;
        el.style.setProperty("translate", translate);
        el.style.setProperty("rotate", rotate);
      }
    });
  }

  /** Not sung yet: nothing lit, no glow (the word box keeps whatever pose it has). */
  private restStyle(v: WordView, ov: Overlay): void {
    const shape = this.shapeOf(v);
    const full = this.look.params.karaoke === "full";
    const closed = full ? closedWindow(shape) : 0;
    put(ov.track, "transform", `translateX(${px(closed)})`);
    for (const inner of ov.inners) put(inner, "transform", `translateX(${px(-closed)})`);
    put(ov.win, "opacity", full ? "1" : "0");
    put(ov.glow, "opacity", "0");
    const rest = (i: number): string => ov.letterRest[i] || FULL_TRANSFORM;
    ov.base.forEach((s, i) => put(s, "transform", rest(i)));
    ov.lit.forEach((s, i) => put(s, "transform", rest(i)));
    ov.darkLetters.forEach((s, i) => put(s, "transform", rest(i)));
    ov.letterGlows.forEach((s, i) => {
      put(s, "opacity", "0");
      put(s, "transform", rest(i));
    });
  }

  /** Sung: full size, fully lit, no glow. */
  private finalStyle(v: WordView, ov: Overlay): void {
    put(v.el, "transform", FULL_TRANSFORM);
    put(ov.track, "transform", "translateX(0px)");
    for (const inner of ov.inners) put(inner, "transform", "translateX(0px)");
    put(ov.win, "opacity", "1");
    put(ov.glow, "opacity", "0");
    for (const s of [...ov.base, ...ov.lit, ...ov.darkLetters]) put(s, "transform", FULL_TRANSFORM);
    for (const s of ov.letterGlows) {
      put(s, "opacity", "0");
      put(s, "transform", FULL_TRANSFORM);
    }
  }
}
