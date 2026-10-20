/**
 * The interlude dots' DOM and motion, the same in every style: Stack and Drift put them in a slot of
 * the list where the next line will be, Lens in its focus row, Arc at the apex of its curve.
 *
 *   .ut-dots     the group (pop in, breathing, swell, pop out; its opacity)
 *     .ut-dot    × 3, in the lyric color (lift, size, brightness)
 *       b        its halo in the highlight color (stage.css: --ut-dot-bloom), fading in as it fills
 */
import { h, put } from "../dom";
import { planDots, type Interlude } from "./interlude";
import { compositorSteps } from "./keyframes";
import { DOTS, type MotionParams } from "./params";
import type { SongTimeline } from "./timeline";

export class InterludeDots {
  /** the group element, inside the host it was made for */
  readonly el: HTMLElement;
  private readonly host: HTMLElement;
  private readonly dotPx: number;
  private readonly dots: HTMLElement[] = [];
  private readonly glows: HTMLElement[] = [];
  private playing: { timeline: SongTimeline; group: string } | null = null;

  /** Three dots `dotPx` across (DOTS.em of the row's font size), appended to `host`. */
  constructor(host: HTMLElement, dotPx: number) {
    this.host = host;
    this.dotPx = dotPx;
    const el = h("div", "ut-dots");
    el.setAttribute("aria-hidden", "true");
    const px = `${dotPx.toFixed(2)}px`;
    for (let d = 0; d < 3; d++) {
      const dot = h("i", "ut-dot");
      dot.style.width = px;
      dot.style.height = px;
      const glow = h("b");
      dot.append(glow);
      el.append(dot);
      this.dots.push(dot);
      this.glows.push(glow);
    }
    el.style.gap = `${(dotPx * DOTS.gap).toFixed(2)}px`;
    host.append(el);
    this.el = el;
  }

  /**
   * Plays the break `il` on `timeline` under `group` (anything already playing there is replaced), and
   * returns the song time the motion has ended by. A seek into the middle of the break joins it there.
   */
  play(il: Interlude, timeline: SongTimeline, params: MotionParams, group: string, steps = compositorSteps()): number {
    this.cancel();
    if (this.el.parentNode !== this.host) this.host.append(this.el);
    const plan = planDots(il, this.dotPx, params, steps);
    const el = this.el;
    // at rest (outside the break) the group is gone; dots that don't move just fade, at full size
    put(el, "opacity", "0");
    put(el, "transform", plan.group.transform ? "scale(0)" : "none");
    if (plan.group.transform) timeline.play(el, plan.group.transform.frames, plan.group.transform.t0, plan.group.transform.duration, group);
    timeline.play(el, plan.group.opacity.frames, plan.group.opacity.t0, plan.group.opacity.duration, group);
    plan.dots.forEach((track, d) => {
      const dot = this.dots[d];
      if (dot) timeline.play(dot, track.frames, track.t0, track.duration, group);
    });
    plan.glows.forEach((track, d) => {
      const glow = this.glows[d];
      if (glow) timeline.play(glow, track.frames, track.t0, track.duration, group);
    });
    this.playing = { timeline, group };
    return plan.until;
  }

  /** Stops the dots and takes them off the page (play() brings them back). */
  stop(): void {
    this.cancel();
    this.el.remove();
  }

  private cancel(): void {
    const p = this.playing;
    if (p) p.timeline.cancel(p.group);
    this.playing = null;
  }
}
