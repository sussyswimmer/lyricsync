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
 * Glyphs may draw past their boxes (WordInk). The wipe runs from before the word's ink to past it, and
 * every run of text in the overlay (`.kl`, `.kw-run`) is padded out by the word's bleed (--kb-x,
 * --kb-y, stage.css): WebKit sizes a moving letter's layer by its box, not its ink, and cut what
 * overhung it off with a hard edge.
 *
 * Every word's motion is planned (karaoke.ts) and handed to the compositor sharing one window, the
 * line's [origin, end]: Chromium needs a main-thread frame to start a batch and another when it ends,
 * so a line costs two whatever it moves; WebKit hands the same animations to Core Animation. The work
 * is sliced: `prepare` builds and plans the next line in short idle slices ahead of time, `mount` runs
 * a first slice (the words sung by now or within 400 ms) and the rest on the next frames, earliest
 * first. Words not mounted yet hold their pose inline.
 *
 * Effects mode adds a word's extras (decor.ts) to its overlay, each on its own song-time window: a
 * splash under the copies (`.kw-splash`, its pieces `.kw-sp`), a picture above the word (`.kw-pic`)
 * and, for a picture that lives, its light under the copies (`.kw-aura`, with `.kw-aura-glow` and a
 * flame's `.kw-ember`s). They rest invisible; a line leaving focus once sung stops them where they are,
 * to fade out with it.
 */
import type { WordDecor } from "../../core/flair";
import type { Word } from "../../core/lrc";
import { h, put } from "../dom";
import { pictureUrl } from "../pictures";
import { PICTURE_EM, picturePose, planPicture, planPictureLife, planSplash, seedOf, type Particle } from "./decor";
import {
  closedWindow,
  FEATHER,
  FULL_TRANSFORM,
  fullTransform,
  heldParts,
  leadOf,
  letterRest,
  partsOf,
  planWord,
  rebase,
  restTransform,
  trailOf,
  wordUntil,
  type LetterBox,
  type Part,
  type Track,
  type WordMotion,
  type WordShape,
} from "./karaoke";
import { compositorSteps } from "./keyframes";
import { canvasInk, canvasMeasure, isRtl, measureLetters, roughMeasure, type InkMeasure, type Measure } from "./letters";
import { LEAD_MS, LEAVE_MS, SETTLE_IN_MS, type MotionParams } from "./params";
import { commit, type SongTimeline } from "./timeline";

export { LEAVE_MS, SETTLE_IN_MS };

/** What a karaoke line needs to know about how it is drawn. */
export interface KaraokeLook {
  /** the row's font size, px */
  size: number;
  /** CSS font shorthand for measuring, e.g. `700 58px "Fraunces", serif` */
  font: string;
  /** CSS letter-spacing of the row, px */
  letterSpacingPx: number;
  /** CSS line-height of the row, in font sizes: each letter's box is this tall (default 1) */
  lineHeight?: number;
  /** from motionParams(look) */
  params: MotionParams;
  /** a static placement for every copy of every letter (Arc: letters on its curve); forces the letter split */
  place?: LetterPlacer;
  /** slow stretches step on the song-time beat (PlanOptions.steps); compositorSteps() when absent */
  steps?: boolean;
  /** Effects mode: the words with a picture or a splash, by word index (core/flair.ts LineDecor.words) */
  decor?: ReadonlyMap<number, WordDecor>;
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
export const MOUNT_SLICE_MS = 3;
/** The overlay reaches this far beyond the word's box (glyph overhangs, the lift, the bloom), in em. */
const PAD_EM = 0.5;
/** Ink is reached with this much to spare, px (antialiased edges). */
const BLEED_MARGIN = 1;

/**
 * How far every run of text in a word's overlay is padded out (stage.css `.kl`, `.kw-run`), px:
 * sideways by the furthest any glyph overhangs its own box, up and down by what the tallest and
 * deepest glyphs draw past a `lineHeight`-tall box. 0 where nothing overhangs, or nothing was measured.
 */
export function bleedOf(shape: WordShape, lineHeight: number): { x: number; y: number } {
  const ink = shape.ink;
  if (!ink) return { x: 0, y: 0 };
  const halfLeading = (lineHeight - (ink.ascent + ink.descent)) / 2;
  const past = Math.max(ink.above, ink.below) - halfLeading;
  return {
    x: ink.side > 0 ? Math.ceil(ink.side) + BLEED_MARGIN : 0,
    y: ink.ascent + ink.descent > 0 && past > 0 ? Math.ceil(past) + BLEED_MARGIN : 0,
  };
}

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

/** A word's extras (Effects mode): its picture and splash pieces, and their motion. */
interface Extras {
  pic: HTMLElement | null;
  picTrack: Track | null;
  /** a living picture's own motion (decor.ts planPictureLife) */
  picLife: Track | null;
  /** its light, moving with it; the light's flicker or breath; the embers rising through it */
  aura: HTMLElement | null;
  glow: { el: HTMLElement; track: Track } | null;
  embers: { el: HTMLElement; track: Track }[];
  pieces: HTMLElement[];
  particles: Particle[];
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
  /** the word box carries a bleed (--kb-x, --kb-y) for its runs of text */
  bled: boolean;
  /** what Effects mode adds to it, and the elements and motion built for that */
  decor: WordDecor | undefined;
  extras: Extras | null;
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
  /** the extras' animations: each on its own window, kept apart from the line's shared one */
  private readonly extrasGroup: string;
  private readonly look: KaraokeLook;
  private readonly steps: boolean;
  private measure: Measure | null = null;
  private ink: InkMeasure | null | undefined;
  private origin = 0;
  private end = 0;
  /** the song time the line was last mounted at: extras over by then aren't started */
  private mountedAt = 0;
  private settleIn = false;
  private readonly plans = new Map<string, WordMotion>();
  private cancelSlice: (() => void) | null = null;
  private destroyed = false;
  /** the overlays' fade-out (fadeOut), on the document timeline */
  private fades: { el: HTMLElement; anim: Animation }[] = [];

  /** `els[i]` is the `.kw` box of `words[i]`. Nothing is built or measured until prepare or mount asks. */
  constructor(words: readonly Word[], els: readonly HTMLElement[], look: KaraokeLook, timeline: SongTimeline, group: string) {
    this.timeline = timeline;
    this.group = group;
    this.extrasGroup = `${group}+fx`;
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
        bled: false,
        decor: look.decor?.get(i),
        extras: null,
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
   * mounting only has animations to start. Every overlay is built first, so the page renders the
   * new DOM once rather than after every slice; the planning after it touches no DOM.
   */
  prepare(budgetMs = SLICE_MS, origin = (this.views[0]?.word.start ?? 0) - LEAD_MS): boolean {
    if (this.destroyed) return true;
    const started = now();
    let done = 0;
    // at least one word a slice, however slow the clock says the last one was
    const out = (): boolean => done > 0 && now() - started >= budgetMs;
    for (const v of this.views) {
      if (v.ov) continue;
      if (out()) return false;
      this.overlayOf(v);
      done++;
    }
    for (const v of this.views) {
      if (this.plans.has(this.planKey(v, origin, true))) continue;
      if (out()) return false;
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
    this.timeline.cancel(this.extrasGroup);
    this.mountedAt = t;
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
    // the extras stop where they are, and fade out with the overlay
    this.timeline.freeze(this.extrasGroup);
    this.timeline.cancel(this.group);
    for (const v of this.views) {
      if (v.ov) this.finalStyle(v, v.ov);
      else put(v.el, "transform", "none");
      v.mounted = true;
    }
  }

  /**
   * Fades every word's overlay out over `ms` of wall time, as the line hands back to its plain text:
   * smoothly, or in `steps` even jumps (the first at once). The overlay's own resting opacity (the row
   * without `has-fx`: 0) shows once it ends. destroy() cancels it: a line taken down just before the
   * fade ends leaves Chromium no animation ending to service, which costs frames of their own.
   */
  fadeOut(ms: number, steps = 0): void {
    if (this.destroyed || !(ms > 0)) return;
    const easing = steps > 0 ? `steps(${Math.round(steps)}, start)` : "ease-out";
    for (const v of this.views) {
      const fx = v.ov?.fx;
      if (!fx || typeof fx.animate !== "function") continue;
      this.fades.push({ el: fx, anim: fx.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing }) });
    }
  }

  /** Stops where it is: what is on screen stays, as inline style (before the stage copies the page). */
  freeze(): void {
    this.stopSlices();
    this.timeline.freeze(this.group);
    this.timeline.freeze(this.extrasGroup);
    for (const f of this.fades.splice(0)) commit(f.anim, f.el);
  }

  /** Removes the overlays (the plain text shows again) and stops their motion. */
  destroy(): void {
    this.stopSlices();
    this.destroyed = true;
    this.timeline.cancel(this.group);
    this.timeline.cancel(this.extrasGroup);
    for (const f of this.fades.splice(0)) {
      try {
        f.anim.cancel();
      } catch {
        // already gone
      }
    }
    for (const v of this.views) {
      v.ov?.fx.remove();
      v.ov = null;
      v.el.classList.remove("kw-on");
      put(v.el, "transform", "none");
      put(v.el, "will-change", "auto");
      if (v.bled) {
        put(v.el, "--kb-x", "");
        put(v.el, "--kb-y", "");
      }
      if (v.txt) v.txt.el.textContent = v.txt.text;
      v.txt = null;
      v.extras = null;
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
        index: v.index,
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
          { at: this.origin, frame: { transform: fullTransform(params) } },
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
    this.playExtras(v);
    v.mounted = true;
  }

  /**
   * Starts a word's extras on their own windows (not the line's: a picture outlasts its line's motion),
   * from a clean inline style: a line that left focus froze them there. Those already over are left be.
   */
  private playExtras(v: WordView): void {
    const x = v.extras;
    if (!x) return;
    const start = (el: HTMLElement, track: Track): void => {
      put(el, "opacity", "");
      put(el, "transform", "");
      put(el, "scale", "");
      if (track.t0 + track.duration > this.mountedAt) this.timeline.play(el, track.frames, track.t0, track.duration, this.extrasGroup);
    };
    if (x.pic && x.picTrack) start(x.pic, x.picTrack);
    if (x.pic && x.picLife) start(x.pic, x.picLife);
    if (x.aura && x.picTrack) start(x.aura, x.picTrack);
    if (x.glow) start(x.glow.el, x.glow.track);
    for (const e of x.embers) start(e.el, e.track);
    x.pieces.forEach((el, i) => {
      const p = x.particles[i];
      if (p) start(el, p.track);
    });
  }

  /** A word waiting for its slice: at rest, nothing lit; still at full size if its line settles in. */
  private hold(v: WordView): void {
    if (v.ov) this.restStyle(v, v.ov);
    const pose = !this.moves() ? "none" : this.settles(v) ? fullTransform(this.look.params) : restTransform(this.look.size, this.look.params);
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
    if (this.ink === undefined) this.ink = canvasInk(font);
    const { width, letters, ink } = measureLetters(v.text, v.parts, this.measure, letterSpacingPx, this.ink ?? undefined);
    v.shape = { width, size, letters, rtl: isRtl(v.text), ...(ink ? { ink } : {}) };
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
    const whole = (box: HTMLElement, cls = "kl"): HTMLElement[] => {
      box.append(h("span", cls, text));
      return [];
    };
    // every run of text is padded out by the word's bleed, so no layer is smaller than its ink
    const bleed = bleedOf(shape, (this.look.lineHeight ?? 1) * size);
    if (bleed.x > 0 || bleed.y > 0) {
      put(v.el, "--kb-x", px(bleed.x));
      put(v.el, "--kb-y", px(bleed.y));
      v.bled = true;
    }

    // the dark legibility copy, under everything and unclipped
    const dark = h("span", "kw-dark");
    const darkLetters = moves || placed ? letterSpans(dark) : whole(dark, "kw-run");
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
    const glowLetters = placed ? letterSpans(glow) : whole(glow, "kw-run");

    // The windows, in track coordinates (where the track rests when the word is fully lit). LTR: the
    // lit window runs from PAD_EM before the word to its end plus the overhang (past its last glyph's
    // ink), then fades out over the feather. The base window starts, hard-edged, where that fade begins
    // and runs on past the word: over the feather the lit copy fades out over the base copy at full
    // strength, which is a true crossfade (two complementary masks would let the wallpaper through
    // mid-way), and a clip costs the compositor nothing where a second mask would cost an offscreen pass
    // per word. RTL mirrors it.
    const W = shape.width;
    const pad = Math.max(PAD_EM * size, leadOf(shape) + bleed.x);
    const feather = Math.max(1, FEATHER * W);
    const over = trailOf(shape);
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
    // a splash and a picture's light go under every copy (neither ever covers the word), a picture over them
    const { splash, aura, pic } = this.extrasOf(v, shape);
    fx.append(...(splash ? [splash] : []), ...(aura ? [aura] : []), dark, ...letterGlows, glow, track, ...(pic ? [pic] : []));
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

  /**
   * Effects mode's extras for a word that has any (WordView.extras): the box of its splash's pieces,
   * and its picture above the word. Each rests invisible (stage.css). Placed letters (Arc) carry them
   * along with the word's middle letter.
   */
  private extrasOf(v: WordView, shape: WordShape): { splash: HTMLElement | null; aura: HTMLElement | null; pic: HTMLElement | null } {
    const decor = v.decor;
    if (!decor || (!decor.picture && !decor.splash)) return { splash: null, aura: null, pic: null };
    const { size, params, place } = this.look;
    const seed = seedOf(`${v.index}|${v.text}|${Math.round(v.word.start)}`);
    const mid = shape.letters[Math.floor(shape.letters.length / 2)];
    const anchor = place && mid ? place(v.index, shape.letters.indexOf(mid), mid) : null;
    const at = (el: HTMLElement, dx: number, dy: number, rotate: number): void => {
      if (dx !== 0 || dy !== 0) el.style.setProperty("translate", `${px(dx)} ${px(dy)}`);
      if (rotate !== 0) el.style.setProperty("rotate", `${rotate.toFixed(2)}deg`);
    };
    const x: Extras = { pic: null, picTrack: null, picLife: null, aura: null, glow: null, embers: [], pieces: [], particles: [] };
    let splash: HTMLElement | null = null;
    if (decor.splash && params.karaoke === "full") {
      x.particles = planSplash(decor.splash, v.word.start, size, shape.width, params.amp, seed);
      if (x.particles.length > 0) {
        const box = h("span", "kw-splash");
        box.setAttribute("aria-hidden", "true");
        at(box, anchor?.dx ?? 0, anchor?.dy ?? 0, anchor?.rotate ?? 0);
        for (const p of x.particles) {
          const piece = h("span", `kw-sp ${p.cls}`);
          piece.style.width = px(p.w);
          piece.style.height = px(p.h);
          piece.style.marginLeft = px(-p.w / 2);
          piece.style.marginTop = px(-p.h / 2);
          box.append(piece);
          x.pieces.push(piece);
        }
        splash = box;
      }
    }
    const url = decor.picture ? pictureUrl(decor.picture) : null;
    if (url && decor.picture) {
      // Above the word, unless the line wraps and the word is on a later row: the row above is the
      // line's own text then, so the picture goes under the word instead.
      const below = this.onLaterRow(v);
      const pic = h("img", below ? "kw-pic is-below" : "kw-pic");
      pic.src = url;
      pic.alt = "";
      pic.decoding = "async";
      pic.draggable = false;
      const side = PICTURE_EM * size;
      const pose = picturePose(size, seed, below);
      const box = (el: HTMLElement): void => {
        el.style.width = px(side);
        el.style.height = px(side);
        el.style.marginLeft = px(-side / 2);
        at(el, pose.dx + (anchor?.dx ?? 0), pose.dy + (anchor?.dy ?? 0), pose.tilt + (anchor?.rotate ?? 0));
      };
      box(pic);
      const amp = params.karaoke === "full" ? params.amp : 0;
      x.pic = pic;
      x.picTrack = planPicture(v.word.start, size, amp, below);
      const life = planPictureLife(decor.picture, v.word.start, side, amp, seed);
      x.picLife = life.pic;
      if (life.aura) {
        // the picture's light: placed and moving like the picture, glowing in its color
        const aura = h("span", below ? "kw-aura is-below" : "kw-aura");
        aura.setAttribute("aria-hidden", "true");
        aura.style.setProperty("--aura", life.aura.color);
        box(aura);
        const glow = h("span", "kw-aura-glow");
        aura.append(glow);
        x.glow = { el: glow, track: life.aura.track };
        for (const e of life.embers) {
          const ember = h("span", e.cls);
          ember.style.width = px(e.w);
          ember.style.height = px(e.h);
          ember.style.marginLeft = px(-e.w / 2);
          aura.append(ember);
          x.embers.push({ el: ember, track: e.track });
        }
        x.aura = aura;
      }
    }
    v.extras = x.pic || x.pieces.length > 0 ? x : null;
    return { splash, aura: x.aura, pic: x.pic };
  }

  /**
   * Whether the word sits on a later row than the line's first word (the line wraps): one layout read,
   * made only for a word that shows a picture. Unknown (no layout) counts as the first row.
   */
  private onLaterRow(v: WordView): boolean {
    const first = this.views[0]?.el;
    const top = v.el.offsetTop;
    const firstTop = first?.offsetTop;
    return typeof top === "number" && typeof firstTop === "number" && top - firstTop > 0.5 * this.look.size;
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
    // letters rest on an identity transform, never "none": a letter that gains or loses a transform as
    // its motion starts or ends has its word laid out again
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
    put(v.el, "transform", "none");
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
