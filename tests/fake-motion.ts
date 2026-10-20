/*
 * Web Animations fakes for the motion engine's tests, and for Lens's and Arc's (import, don't copy):
 *
 * - FakeAnimation keeps time the way an engine does, on the document timeline as performance.now()
 *   tells it (tests mock that clock): start time, current time, playback rate, a rate change that keeps
 *   the current time, pause, cancel, and commitStyles writing what it draws at its current time into
 *   its target's inline style.
 * - FakeAnimationHost (a base class) and animatable() (for an existing object) give an element
 *   `animate` and `getAnimations`.
 * - fakeContext2d() / withCanvas(): a canvas 2D context whose measureText gives every character `em`
 *   of the font size in the CSS font shorthand, so canvasMeasure works in node; with `ink`, also the
 *   bounding boxes canvasInk reads. Call resetMeasure() (motion/letters.ts) after stubbing, so the next
 *   measurer picks the canvas up.
 *
 * Not a test file itself.
 */

/** What commitStyles writes to: a style with setProperty, or plain properties. */
interface StyleLike {
  setProperty?(name: string, value: string): void;
  [key: string]: unknown;
}

interface Target {
  style?: StyleLike;
}

const perfNow = (): number => performance.now();
const NUMBER = /-?\d+(?:\.\d+)?(?:e-?\d+)?/giu;

/** Two CSS values `p` of the way from `a` to `b`: numbers in equal-shaped strings interpolate, others step. */
export function interpolate(a: unknown, b: unknown, p: number): string {
  if (typeof a === "number" && typeof b === "number") return String(a + (b - a) * p);
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  const na = sa.match(NUMBER) ?? [];
  const nb = sb.match(NUMBER) ?? [];
  if (na.length !== nb.length || sa.replace(NUMBER, "#") !== sb.replace(NUMBER, "#")) return p < 1 ? sa : sb;
  let i = 0;
  return sa.replace(NUMBER, () => {
    const x = Number(na[i]);
    const y = Number(nb[i]);
    i++;
    const v = x + (y - x) * p;
    return String(Math.round(v * 10000) / 10000);
  });
}

/** The keyframes' offsets, filling in missing ones evenly (as engines do). */
export function offsetsOf(frames: readonly Keyframe[]): number[] {
  const n = frames.length;
  return frames.map((f, i) => (typeof f.offset === "number" ? f.offset : n > 1 ? i / (n - 1) : 0));
}

/** Every animated property's value at progress `p` (0..1) through `frames` (linear between keyframes). */
export function valuesAt(frames: readonly Keyframe[], p: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (frames.length === 0) return out;
  const offsets = offsetsOf(frames);
  const props = new Set<string>();
  for (const f of frames) for (const k of Object.keys(f)) if (k !== "offset" && k !== "easing" && k !== "composite") props.add(k);
  for (const prop of props) {
    const keyed = frames.map((f, i) => ({ at: offsets[i] ?? 0, v: (f as Record<string, unknown>)[prop] })).filter((k) => k.v !== undefined);
    const first = keyed[0];
    const last = keyed[keyed.length - 1];
    if (!first || !last) continue;
    if (p <= first.at) out[prop] = String(first.v);
    else if (p >= last.at) out[prop] = String(last.v);
    else {
      for (let i = 0; i + 1 < keyed.length; i++) {
        const a = keyed[i];
        const b = keyed[i + 1];
        if (!a || !b || p > b.at) continue;
        out[prop] = interpolate(a.v, b.v, b.at > a.at ? (p - a.at) / (b.at - a.at) : 1);
        break;
      }
    }
  }
  return out;
}

export class FakeAnimation {
  readonly keyframes: Keyframe[];
  readonly options: KeyframeAnimationOptions;
  readonly target: Target | null;
  readonly effect: { target: Target | null };
  readonly finished: Promise<void>;
  cancelled = false;
  /** how many times each was called, for tests that count decisions */
  rateUpdates = 0;
  startTimeSets = 0;
  commits = 0;
  private start: number | null = null;
  private held: number | null = 0;
  private rate = 1;
  private isPaused = false;
  private reject: (e: Error) => void = () => undefined;

  constructor(keyframes: Keyframe[], options: KeyframeAnimationOptions, target: Target | null = null) {
    this.keyframes = keyframes;
    this.options = options;
    this.target = target;
    this.effect = { target };
    this.finished = new Promise<void>((_, reject) => {
      this.reject = reject;
    });
    // Engines create this promise when it is first asked for; one nobody asked for never rejects unheard.
    this.finished.catch(() => undefined);
  }

  get duration(): number {
    return Number(this.options.duration ?? 0);
  }

  get paused(): boolean {
    return this.isPaused;
  }

  get playState(): AnimationPlayState {
    if (this.cancelled) return "idle";
    if (this.isPaused) return "paused";
    const t = this.currentTime ?? 0;
    return t >= this.duration ? "finished" : "running";
  }

  get startTime(): number | null {
    return this.start;
  }

  /** A resolved start time plays it (also out of a pause), holding nothing. */
  set startTime(value: number | null) {
    this.startTimeSets++;
    this.start = value;
    if (value !== null) {
      this.isPaused = false;
      this.held = null;
    }
  }

  get currentTime(): number | null {
    if (this.start === null || this.isPaused) return this.held;
    return (perfNow() - this.start) * this.rate;
  }

  set currentTime(value: number | null) {
    if (value === null) return;
    if (this.start === null || this.isPaused) this.held = value;
    else this.start = perfNow() - value / this.rate;
  }

  get playbackRate(): number {
    return this.rate;
  }

  /** Changing the rate keeps the current time where it is. */
  set playbackRate(value: number) {
    const t = this.currentTime;
    this.rate = value;
    if (t !== null) this.currentTime = t;
  }

  /** Engines apply it at their next frame; here at once, keeping the current time. */
  updatePlaybackRate(value: number): void {
    this.rateUpdates++;
    this.playbackRate = value;
  }

  pause(): void {
    this.held = this.currentTime ?? 0;
    this.isPaused = true;
    this.start = null;
  }

  cancel(): void {
    this.cancelled = true;
    this.reject(new Error("AbortError"));
  }

  /** What it draws right now, per property (linear between keyframes; before its start, the first). */
  values(): Record<string, string> {
    const d = this.duration;
    const t = this.currentTime ?? 0;
    return valuesAt(this.keyframes, d > 0 ? Math.min(1, Math.max(0, t / d)) : 1);
  }

  /** Writes what it draws right now into its target's inline style. */
  commitStyles(): void {
    this.commits++;
    const style = this.target?.style;
    if (!style) return;
    for (const [prop, value] of Object.entries(this.values())) {
      if (typeof style.setProperty === "function") style.setProperty(prop, value);
      else style[prop] = value;
    }
  }
}

/** `animate` and `getAnimations` for an element class: extend this. */
export class FakeAnimationHost {
  animations: FakeAnimation[] = [];
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): FakeAnimation {
    const anim = new FakeAnimation(keyframes, options, this as Target);
    this.animations.push(anim);
    return anim;
  }
  getAnimations(): FakeAnimation[] {
    return this.animations.filter((a) => !a.cancelled);
  }
}

export interface Animated {
  animations: FakeAnimation[];
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): FakeAnimation;
  getAnimations(): FakeAnimation[];
}

/** Gives an existing object `animate` and `getAnimations`. */
export function animatable<T extends object>(el: T): T & Animated {
  const animations: FakeAnimation[] = [];
  return Object.assign(el, {
    animations,
    animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): FakeAnimation {
      const anim = new FakeAnimation(keyframes, options, el as Target);
      animations.push(anim);
      return anim;
    },
    getAnimations(): FakeAnimation[] {
      return animations.filter((a) => !a.cancelled);
    },
  });
}

/** Every running (not cancelled) animation among `els`. */
export function liveAnimations(els: readonly { getAnimations(): FakeAnimation[] }[]): FakeAnimation[] {
  return els.flatMap((e) => e.getAnimations());
}

/** The font size of a CSS font shorthand (`700 58px "Fraunces", serif`), 16 when it has none. */
export function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/u.exec(font);
  return m ? Number(m[1]) : 16;
}

export interface FakeContext2d {
  font: string;
  measured: number;
  measureText(text: string): Partial<TextMetrics> & { width: number };
}

/**
 * A 2D context for canvasMeasure: every character `em` of the font size wide, and each pair in
 * `kern` (e.g. {"AV": -0.06}) that many em tighter, the way a real font kerns.
 */
/** Where one character's ink reaches past its box, in font sizes (FakeInk.chars), and the font's box. */
export interface FakeInk {
  chars: Readonly<Record<string, { left?: number; right?: number; up?: number; down?: number }>>;
  /** the font's ascent and descent, in font sizes */
  ascent: number;
  descent: number;
}

export function fakeContext2d(em = 0.5, kern: Readonly<Record<string, number>> = {}, ink?: FakeInk): FakeContext2d {
  const ctx: FakeContext2d = {
    font: "16px sans-serif",
    measured: 0,
    measureText(text: string): Partial<TextMetrics> & { width: number } {
      ctx.measured++;
      const size = fontPx(ctx.font);
      let width = [...text].length * em * size;
      for (const [pair, k] of Object.entries(kern)) {
        let at = text.indexOf(pair);
        while (at >= 0) {
          width += k * size;
          at = text.indexOf(pair, at + 1);
        }
      }
      if (!ink) return { width };
      // each character drawn `em` on from the last, its ink as `ink.chars` says (or inside its box)
      const boxes = [...text].map((c, i) => {
        const o = ink.chars[c] ?? {};
        return { left: (o.left ?? 0) - i * em, right: (i + 1) * em + (o.right ?? 0), up: o.up ?? 0.7, down: o.down ?? 0.1 };
      });
      const most = (f: (b: (typeof boxes)[number]) => number): number => Math.max(...boxes.map(f)) * size;
      return {
        width,
        actualBoundingBoxLeft: most((b) => b.left),
        actualBoundingBoxRight: most((b) => b.right),
        actualBoundingBoxAscent: most((b) => b.up),
        actualBoundingBoxDescent: most((b) => b.down),
        fontBoundingBoxAscent: ink.ascent * size,
        fontBoundingBoxDescent: ink.descent * size,
      };
    },
  };
  return ctx;
}

/**
 * `doc` (a fake document) whose createElement("canvas") hands out a canvas with `ctx`; every other
 * tag goes to the fake's own createElement.
 */
export function withCanvas<D extends { createElement(tag: string): unknown }>(doc: D, ctx: FakeContext2d = fakeContext2d()): D {
  const create = doc.createElement.bind(doc);
  return Object.assign(doc, {
    createElement: (tag: string): unknown => (tag === "canvas" ? { getContext: (kind: string) => (kind === "2d" ? ctx : null) } : create(tag)),
  });
}
