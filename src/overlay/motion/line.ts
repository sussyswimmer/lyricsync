/**
 * One sung line's karaoke, on the compositor. The mode lays the line out as `.kw` word boxes (plain
 * text, kerned, for layout and for the line at rest). While the line is in focus each box gets an
 * overlay drawn over its plain text:
 *
 *   .kw            the word box: its transform is the word's pop (rest: a little small and low)
 *     .kw-txt      the plain text (hidden while the overlay shows)
 *     .kw-fx       the overlay
 *       .kl-glow   emphasized words: each letter's own bloom
 *       .kw-glow   the word's bloom (a fill-less copy whose text-shadow glows; opacity animated)
 *       .kw-base   the letters in the upcoming color, each placed where the whole word draws it
 *       .kw-win    the lit window: slides over the word, a feathered mask on its leading edge...
 *         .kw-in   ...while its contents slide back, so the lit letters stay put
 *
 * Every word's motion is planned once (karaoke.ts) when it is about to be sung and handed to the
 * compositor through the song timeline; between word starts nothing here runs.
 */
import type { Word } from "../../core/lrc";
import { h, put } from "../dom";
import { closedWindow, emphasized, FEATHER, letterRest, OVERHANG, partsOf, planWord, restTransform, type Part, type Track, type WordMotion, type WordShape } from "./karaoke";
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
}

/** Words that start within this long are planned and handed to the compositor ahead of time. */
export const LOOKAHEAD_MS = 60;
/** A line coming into focus eases its upcoming words into their rest pose over this long. */
const SETTLE_IN_MS = 380;
/** The overlay reaches this far beyond the word's box (glyph overhangs, the lift, the bloom), in em. */
const PAD_EM = 0.5;

interface WordView {
  word: Word;
  /** without the trailing space */
  text: string;
  el: HTMLElement;
  parts: Part[];
  emphasis: boolean;
  shape: WordShape;
  fx: HTMLElement;
  glow: HTMLElement;
  win: HTMLElement;
  inner: HTMLElement;
  base: HTMLElement[];
  lit: HTMLElement[];
  letterGlows: HTMLElement[];
  /** letter transforms at rest (emphasized letters sit a little small and low) */
  letterRest: string[];
  /** "rest": not yet handed over; "live": its tracks are on the timeline or done */
  state: "rest" | "live";
  until: number;
}

const px = (v: number): string => `${v.toFixed(2)}px`;

export class KaraokeLine {
  private readonly views: WordView[] = [];
  private readonly timeline: SongTimeline;
  private readonly group: string;
  private look: KaraokeLook;
  private next = 0;

  /** `els[i]` is the `.kw` box of `words[i]`. */
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
      const shape: WordShape = { width, size: look.size, letters, rtl: isRtl(text) };
      this.views.push(this.mount(word, text, el, parts, shape));
    });
  }

  /** Song time by which every word's motion has finished. */
  get until(): number {
    return Math.max(0, ...this.views.map((v) => Math.max(v.until, v.word.end)));
  }

  /**
   * Puts every word in its state at song time `t` (after a mount or a seek): sung words lit, the rest
   * at rest. `settleIn` eases words that were standing at full size (the line was out of focus) into
   * their rest pose instead of snapping them there.
   */
  resync(t: number, settleIn = false): void {
    this.timeline.cancel(this.group);
    this.next = 0;
    for (const v of this.views) this.rest(v);
    if (settleIn && this.look.motion) {
      const rest = restTransform(this.look.size);
      for (const v of this.views) {
        if (v.word.start <= t + LOOKAHEAD_MS) continue;
        this.timeline.play(v.el, [{ transform: "translate(0px, 0px) scale(1)" }, { transform: rest }], t, SETTLE_IN_MS, this.group);
      }
    }
    this.update(t);
  }

  /** Hands words that are about to start to the compositor. Cheap when nothing starts. */
  update(t: number): void {
    while (this.next < this.views.length) {
      const v = this.views[this.next];
      if (!v || v.word.start > t + LOOKAHEAD_MS) break;
      this.start(v, t);
      this.next++;
    }
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

  private mount(word: Word, text: string, el: HTMLElement, parts: Part[], shape: WordShape): WordView {
    const { size } = this.look;
    const fx = h("span", "kw-fx");
    fx.setAttribute("aria-hidden", "true");
    const emphasis = emphasized(word, word.text);
    const letterGlows: HTMLElement[] = [];
    if (emphasis && shape.letters.length > 1) {
      for (const l of shape.letters) {
        const g = h("span", "kl kl-glow", l.text);
        g.style.left = px(l.x);
        letterGlows.push(g);
        fx.append(g);
      }
    }
    const glow = h("span", "kw-glow", text);
    const baseBox = h("span", "kw-base");
    const base = shape.letters.map((l) => {
      const s = h("span", "kl", l.text);
      s.style.left = px(l.x);
      baseBox.append(s);
      return s;
    });
    // The window: from PAD_EM before the word to the end of the travel, feathered on its leading edge.
    const pad = PAD_EM * size;
    const feather = FEATHER * shape.width;
    const over = OVERHANG * size;
    const win = h("span", "kw-win");
    const inner = h("span", "kw-in");
    const winWidth = pad + shape.width + over + feather;
    win.style.width = px(winWidth);
    win.style.left = px(shape.rtl ? -(over + feather) : -pad);
    const stop = ((winWidth - feather) / winWidth) * 100;
    const mask = `linear-gradient(${shape.rtl ? "270deg" : "90deg"}, #000 0%, #000 ${stop.toFixed(2)}%, transparent 100%)`;
    win.style.setProperty("mask-image", mask);
    win.style.setProperty("-webkit-mask-image", mask);
    inner.style.left = px(shape.rtl ? over + feather : pad);
    const lit = shape.letters.map((l) => {
      const s = h("span", "kl", l.text);
      s.style.left = px(l.x);
      inner.append(s);
      return s;
    });
    win.append(inner);
    fx.append(glow, baseBox, win);
    el.append(fx);
    const rest = letterRest(word, word.text, shape, this.look.motion);
    return { word, text, el, parts, emphasis, shape, fx, glow, win, inner, base, lit, letterGlows, letterRest: rest, state: "rest", until: word.end };
  }

  /** Not sung yet: small and low, nothing lit, no glow. */
  private rest(v: WordView): void {
    v.state = "rest";
    const motion = this.look.motion;
    put(v.el, "transform", motion ? restTransform(this.look.size) : "none");
    const closed = motion ? closedWindow(v.shape) : 0;
    put(v.win, "transform", `translateX(${px(closed)})`);
    put(v.inner, "transform", `translateX(${px(-closed)})`);
    put(v.win, "opacity", motion ? "1" : "0");
    put(v.glow, "opacity", "0");
    v.base.forEach((s, i) => put(s, "transform", v.letterRest[i] || "none"));
    v.lit.forEach((s, i) => put(s, "transform", v.letterRest[i] || "none"));
    v.letterGlows.forEach((s, i) => {
      put(s, "opacity", "0");
      put(s, "transform", v.letterRest[i] || "none");
    });
  }

  /** Sung or being sung: the resting style is the end state, and the motion runs over it until it settles. */
  private start(v: WordView, t: number): void {
    v.state = "live";
    put(v.el, "transform", "none");
    put(v.win, "transform", "translateX(0px)");
    put(v.inner, "transform", "translateX(0px)");
    put(v.win, "opacity", "1");
    put(v.glow, "opacity", "0");
    for (const s of [...v.base, ...v.lit]) put(s, "transform", "none");
    for (const s of v.letterGlows) {
      put(s, "opacity", "0");
      put(s, "transform", "none");
    }
    // Words long over (a seek, a mount mid-line) only need their end state.
    if (t > v.word.end + 4000) return;
    const plan = planWord(v.word, v.text, v.shape, { energy: this.look.energy, motion: this.look.motion });
    v.until = plan.until;
    if (t >= plan.until) return;
    this.play(v.el, plan.pop);
    this.play(v.win, plan.window);
    this.play(v.inner, plan.inner);
    this.play(v.win, plan.litFade);
    this.play(v.glow, plan.glow);
    plan.letters.forEach((track, i) => {
      const b = v.base[i];
      const l = v.lit[i];
      const g = v.letterGlows[i];
      if (b) this.play(b, track);
      if (l) this.play(l, track);
      if (g) this.play(g, track);
    });
    plan.letterGlows.forEach((track, i) => {
      const g = v.letterGlows[i];
      if (g) this.play(g, track);
    });
  }

  private play(el: Element, track: Track | null): void {
    if (track) this.timeline.play(el, track.frames, track.t0, track.duration, this.group);
  }
}

export type { WordMotion };
