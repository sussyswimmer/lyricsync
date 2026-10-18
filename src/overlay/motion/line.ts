/**
 * One sung line's karaoke, on the compositor. The mode lays the line out as `.kw` word boxes (plain
 * text, kerned, for layout and for the line at rest). While the line is in focus each box gets an
 * overlay drawn over its plain text:
 *
 *   .kw              the word box: its transform is the word's pop (rest: a little small and low)
 *     .kw-txt        the plain text (hidden while the overlay shows)
 *     .kw-fx         the overlay
 *       .kl-glow     emphasized words: each letter's own bloom
 *       .kw-glow     the word's bloom (a fill-less copy whose text-shadow glows; opacity animated)
 *       .kw-track    slides across the word, carrying two windows that meet at its feathered edge:
 *         .kw-bwin   the unlit part: the letters in the upcoming color (clipped where the feather begins)
 *           .kw-in   ...its contents sliding back, so the letters stay put
 *         .kw-win    the lit part: the letters in the highlight (faded out over the feather, over the base)
 *           .kw-in   ...likewise
 *
 * Each letter sits where the whole word draws it (kerning kept). Only one copy of a letter shows
 * outside the feather, so a letter that has been lit can hop on its own without its unlit twin
 * peeking out under it: the base copy only moves for held syllables, whose letters rise as they light.
 *
 * When the line comes into focus every word's motion is planned (karaoke.ts) and handed to the
 * compositor in one batch: all of the line's animations share one start (the line's origin) and one
 * end, holding still until their word comes. Chromium needs a main-thread frame to start a batch and
 * another when it ends, so a line costs two, however many words and letters it moves; WebKit hands
 * the same animations to Core Animation. Between them the page does nothing at all.
 */
import type { Word } from "../../core/lrc";
import { h, put } from "../dom";
import {
  closedWindow,
  emphasized,
  FEATHER,
  FULL_TRANSFORM,
  letterRest,
  OVERHANG,
  partsOf,
  planWord,
  rebase,
  restTransform,
  type Part,
  type Track,
  type WordMotion,
  type WordShape,
} from "./karaoke";
import { canvasMeasure, isRtl, measureLetters, roughMeasure } from "./letters";
import type { SongTimeline } from "./timeline";

/** What a karaoke line needs to know about how it is drawn. */
export interface KaraokeLook {
  /** the row's font size, px */
  size: number;
  /** CSS font shorthand for measuring, e.g. `700 58px "Fraunces", serif` */
  font: string;
  /** false under prefers-reduced-motion */
  motion: boolean;
  /** 0..1 (songEnergy) */
  energy: number;
  /** slow stretches step on the song-time beat (MotionOptions.steps) */
  steps?: boolean;
}

/** A line coming into focus eases its upcoming words into their rest pose over this long. */
export const SETTLE_IN_MS = 380;
/** The overlay reaches this far beyond the word's box (glyph overhangs, the lift, the bloom), in em. */
const PAD_EM = 0.5;

interface WordView {
  word: Word;
  /** without the trailing space */
  text: string;
  el: HTMLElement;
  parts: Part[];
  shape: WordShape;
  fx: HTMLElement;
  glow: HTMLElement;
  /** the windows' track, the lit window, and the two windows' contents */
  track: HTMLElement;
  win: HTMLElement;
  inners: HTMLElement[];
  base: HTMLElement[];
  lit: HTMLElement[];
  letterGlows: HTMLElement[];
  /** letter transforms at rest (emphasized letters sit a little small and low) */
  letterRest: string[];
}

const px = (v: number): string => `${v.toFixed(2)}px`;

export class KaraokeLine {
  private readonly views: WordView[] = [];
  private readonly timeline: SongTimeline;
  private readonly group: string;
  private readonly look: KaraokeLook;
  private origin = 0;
  private end = 0;
  private readonly plans = new Map<string, WordMotion>();

  /** `els[i]` is the `.kw` box of `words[i]`. Builds the overlays; `mount` starts the motion. */
  constructor(words: readonly Word[], els: readonly HTMLElement[], look: KaraokeLook, timeline: SongTimeline, group: string) {
    this.timeline = timeline;
    this.group = group;
    this.look = look;
    const measure = canvasMeasure(look.font) ?? roughMeasure(look.size);
    words.forEach((word, i) => {
      const el = els[i];
      if (!el) return;
      const text = word.text.trimEnd();
      const parts = partsOf(word, word.text);
      const { width, letters } = measureLetters(text, parts, measure);
      this.views.push(this.build(word, text, el, parts, { width, size: look.size, letters, rtl: isRtl(text) }));
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

  /**
   * Stops the line's motion where it ends (every word sung, in place, no bloom): for a line leaving
   * focus once it has been sung, so that its overlay fades out as one still picture rather than a
   * hundred layers the compositor keeps redrawing as the list scrolls. All it cuts short is the last
   * word's springs settling their final pixel.
   */
  finish(): void {
    this.timeline.cancel(this.group);
  }

  /**
   * Plans every word and starts the line's animations at once, as of song time `t` (the line coming
   * into focus): words already sung show sung, the one being sung joins mid-way, the rest wait at
   * rest. A seek within the line needs nothing more: the song timeline moves them all. `settleIn`
   * (the line arrives while playing) eases its words from full size into their rest pose.
   */
  mount(t: number, settleIn: boolean): void {
    this.timeline.cancel(this.group);
    const origin = this.originAt(t);
    const { motion, size } = this.look;
    const settles = (v: WordView): boolean => settleIn && motion && v.word.start - origin >= SETTLE_IN_MS;
    const plans = this.plansFor(origin, settleIn);
    this.origin = origin;
    this.end = Math.max(origin + 1, ...plans.map((p) => p.until));
    this.views.forEach((v, i) => {
      const plan = plans[i];
      if (!plan) return;
      // the resting style is the end state: what shows once the line's animations are over
      this.finalStyle(v);
      const lead = settles(v)
        ? [
            { at: origin, frame: { transform: FULL_TRANSFORM } },
            { at: origin + SETTLE_IN_MS, frame: { transform: restTransform(size) } },
          ]
        : [];
      this.play(v.el, plan.pop, lead);
      this.play(v.track, plan.window);
      for (const inner of v.inners) this.play(inner, plan.inner);
      this.play(v.win, plan.litFade);
      this.play(v.glow, plan.glow);
      plan.letters.forEach((track, j) => {
        const moves = plan.moveBase[j] ? [v.lit[j], v.base[j], v.letterGlows[j]] : [v.lit[j]];
        for (const el of moves) if (el) this.play(el, track);
      });
      plan.letterGlows.forEach((track, j) => {
        const g = v.letterGlows[j];
        if (g) this.play(g, track);
      });
    });
  }

  /**
   * Plans every word ahead of time for a line coming into focus as its first word starts (the usual
   * case), so that the line change itself only starts animations. A different arrival re-plans just
   * the words whose starting pose differs.
   */
  prepare(): void {
    const first = this.views[0]?.word.start ?? 0;
    this.plansFor(first, true);
  }

  /** Where a line coming into focus at `t` starts its shared animation window. */
  private originAt(t: number): number {
    return Math.min(t, this.views[0]?.word.start ?? t);
  }

  /** Each word's plan for a line starting at `origin`, memoized by the pose its pop starts from. */
  private plansFor(origin: number, settleIn: boolean): WordMotion[] {
    const { motion, energy, steps } = this.look;
    return this.views.map((v, i) => {
      // a word sung as its line arrives never settled into rest: its pop starts from full size
      const from = settleIn && !(motion && v.word.start - origin >= SETTLE_IN_MS) ? "full" : "rest";
      const key = `${i}:${from}`;
      let plan = this.plans.get(key);
      if (!plan) {
        plan = planWord(v.word, v.text, v.shape, { energy, motion, from, steps: steps === true });
        this.plans.set(key, plan);
      }
      return plan;
    });
  }

  /** Removes the overlays (the plain text shows again) and stops their motion. */
  destroy(): void {
    this.timeline.cancel(this.group);
    for (const v of this.views) {
      v.fx.remove();
      if (this.look.motion) put(v.el, "transform", "none");
    }
    this.views.length = 0;
  }

  private build(word: Word, text: string, el: HTMLElement, parts: Part[], shape: WordShape): WordView {
    const { size, motion } = this.look;
    const fx = h("span", "kw-fx");
    fx.setAttribute("aria-hidden", "true");
    const letterGlows: HTMLElement[] = [];
    if (emphasized(word, word.text) && shape.letters.length > 1) {
      for (const l of shape.letters) {
        const g = h("span", "kl kl-glow", l.text);
        g.style.left = px(l.x);
        letterGlows.push(g);
        fx.append(g);
      }
    }
    const glow = h("span", "kw-glow", text);
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
    // the lit window's mask: opaque, then fading over the feather at the end the wipe moves toward
    const stop = shape.rtl ? ((feather / span) * 100).toFixed(2) : (((span - feather) / span) * 100).toFixed(2);
    const mask = shape.rtl ? `linear-gradient(90deg, transparent 0%, #000 ${stop}%, #000 100%)` : `linear-gradient(90deg, #000 0%, #000 ${stop}%, transparent 100%)`;
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
    if (motion) {
      win.style.setProperty("mask-image", mask);
      win.style.setProperty("-webkit-mask-image", mask);
    }
    win.classList.add("is-lit");
    if (!motion) {
      // Reduced motion never wipes: the base copy stays whole underneath and the lit one fades in over it.
      bwin.style.left = px(-pad);
      inners[0]?.style.setProperty("left", px(pad));
    }
    const letterSpans = (box: HTMLElement | undefined): HTMLElement[] =>
      shape.letters.map((l) => {
        const sp = h("span", "kl", l.text);
        sp.style.left = px(l.x);
        box?.append(sp);
        return sp;
      });
    // The base copy only moves letter by letter in a held syllable; otherwise it is one run of text,
    // laid out by the browser exactly as the plain text is.
    const held = emphasized(word, word.text) && shape.letters.length > 1;
    const base = held ? letterSpans(inners[0]) : [];
    if (!held) inners[0]?.append(h("span", "kl", text));
    const lit = letterSpans(inners[1]);
    track.append(bwin, win);
    fx.append(glow, track);
    el.append(fx);
    const view: WordView = { word, text, el, parts, shape, fx, glow, track, win, inners, base, lit, letterGlows, letterRest: letterRest(word, word.text, shape, motion) };
    this.restStyle(view);
    return view;
  }

  /** Not sung yet: nothing lit, no glow (until the line mounts its motion; the word box stays as it is). */
  private restStyle(v: WordView): void {
    const motion = this.look.motion;
    const closed = motion ? closedWindow(v.shape) : 0;
    put(v.track, "transform", `translateX(${px(closed)})`);
    for (const inner of v.inners) put(inner, "transform", `translateX(${px(-closed)})`);
    put(v.win, "opacity", motion ? "1" : "0");
    put(v.glow, "opacity", "0");
    v.base.forEach((s, i) => put(s, "transform", v.letterRest[i] || "none"));
    v.lit.forEach((s, i) => put(s, "transform", v.letterRest[i] || "none"));
    v.letterGlows.forEach((s, i) => {
      put(s, "opacity", "0");
      put(s, "transform", v.letterRest[i] || "none");
    });
  }

  /** Sung: full size, fully lit, no glow. */
  private finalStyle(v: WordView): void {
    put(v.el, "transform", "none");
    put(v.track, "transform", "translateX(0px)");
    for (const inner of v.inners) put(inner, "transform", "translateX(0px)");
    put(v.win, "opacity", "1");
    put(v.glow, "opacity", "0");
    for (const s of [...v.base, ...v.lit]) put(s, "transform", "none");
    for (const s of v.letterGlows) {
      put(s, "opacity", "0");
      put(s, "transform", "none");
    }
  }

  private play(el: Element, track: Track | null, lead: readonly { at: number; frame: Keyframe }[] = []): void {
    if (!track) return;
    this.timeline.play(el, rebase(track, this.origin, this.end, lead), this.origin, this.end - this.origin, this.group);
  }
}
