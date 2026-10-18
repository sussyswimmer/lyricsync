import { DEFAULT_SETTINGS, type Settings } from "../../contract/contract";
import type { Line } from "../core/lrc";
import type { Palette } from "../core/palette";
import { lineAt, type Timeline } from "../core/timing";
import { h } from "./dom";
import { cjkLang, fontFor, loadFont, type CjkLang } from "./fonts";
import { DEFAULT_PICK, resolveLook, type Look, type PickedLook } from "./look";
import { createMode } from "./modes";
import type { Cue, ModeRenderer } from "./modes/types";
import { LEAD_MS } from "./motion/params";
import { detectPower, type Power } from "./motion/power";
import { untilNext } from "./motion/schedule";
import { LOADING_DELAY_MS, SCENE_FADE_IN_MS, SCENE_FADE_OUT_MS, buildState, type StateKind } from "./states";
import "../styles/stage.css";

export type StageView = { kind: "none" } | { kind: StateKind } | { kind: "lyrics"; timeline: Timeline };

/** Old song out, then new song in (C6). */
const FADE_OUT_MS = SCENE_FADE_OUT_MS;
const FADE_IN_MS = SCENE_FADE_IN_MS;
/**
 * Crossfade between lines for modes that redraw per line, and for everything under reduced motion.
 * The old line drops out fast and the new one comes in just behind it, so two different lines are
 * never both readable in the same place.
 */
const LINE_OUT_MS = 170;
const LINE_IN_MS = 240;
const LINE_IN_DELAY_MS = 80;
/**
 * After the last word of a line, wait this long before showing the next line as upcoming. Only matters
 * when the LRC has no empty stamp marking a long instrumental break.
 */
export const LINGER_MS = 2500;
/** A rest between two lines at least this long is a break: a safe point for a look refinement. */
export const SAFE_BREAK_MS = 2000;

/** Lyric lines (gaps dropped) plus what the stage needs to place a time on them quickly. */
interface CueMap {
  all: readonly Line[];
  lyrics: Line[];
  /** for each line in `all`: its index in `lyrics`, or -1 for a gap */
  lyricOf: number[];
  /** for each line in `all`: index in `lyrics` of the first lyric line after it, or -1 */
  nextLyric: number[];
  /** every time something visible changes (word starts and ends, line starts, linger ends), sorted */
  boundaries: number[];
  /** the same without word starts and ends, for modes that draw words on their own (wordWakes false) */
  lineBoundaries: number[];
  /** rests of SAFE_BREAK_MS or more between lines: from a line's last word to the next line's start, sorted */
  breaks: { start: number; end: number }[];
  /** their start times */
  breakStarts: number[];
  unsynced: boolean;
}

export function cueMap(timeline: Timeline): CueMap {
  const all = timeline.lines;
  const lyrics: Line[] = [];
  const lyricOf = all.map((line) => (line.words.length > 0 ? lyrics.push(line) - 1 : -1));
  const nextLyric: number[] = new Array<number>(all.length).fill(-1);
  let next = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    nextLyric[i] = next;
    const li = lyricOf[i] ?? -1;
    if (li >= 0) next = li;
  }
  const times = new Set<number>();
  const lineTimes = new Set<number>();
  const breaks: { start: number; end: number }[] = [];
  all.forEach((line, i) => {
    times.add(line.start);
    lineTimes.add(line.start);
    // Unsynced lyrics draw no per-word change and never linger: only line starts matter.
    if (timeline.unsynced) return;
    for (const w of line.words) {
      times.add(w.start);
      times.add(w.end);
    }
    const last = line.words[line.words.length - 1];
    const li = lyricOf[i] ?? -1;
    if (!last || li < 0) return;
    // The linger hands over to the next line only while this line is still the one playing: before
    // the next stamp (a line or an empty gap stamp), and only when there is a next lyric line.
    const nextStamp = all[i + 1]?.start ?? Infinity;
    if (li + 1 < lyrics.length && last.end + LINGER_MS < nextStamp) {
      times.add(last.end + LINGER_MS);
      lineTimes.add(last.end + LINGER_MS);
    }
    const nextLine = lyrics[li + 1];
    if (nextLine && nextLine.start - last.end >= SAFE_BREAK_MS) breaks.push({ start: last.end, end: nextLine.start });
  });
  const sorted = (set: Set<number>): number[] => [...set].sort((a, b) => a - b);
  breaks.sort((a, b) => a.start - b.start);
  return {
    all,
    lyrics,
    lyricOf,
    nextLyric,
    boundaries: sorted(times),
    lineBoundaries: sorted(lineTimes),
    breaks,
    breakStarts: breaks.map((b) => b.start),
    unsynced: timeline.unsynced,
  };
}

/** Which line is in focus at `t`, and whether it is still waiting to start. */
export function cueAt(map: CueMap, t: number): Omit<Cue, "running"> {
  const i = lineAt(map.all, t);
  if (i < 0) return { line: map.lyrics.length > 0 ? 0 : -1, waiting: true, t };
  const li = map.lyricOf[i] ?? -1;
  if (li >= 0) {
    const line = map.lyrics[li];
    const lastEnd = line?.words[line.words.length - 1]?.end ?? -Infinity;
    if (!map.unsynced && li + 1 < map.lyrics.length && t >= lastEnd + LINGER_MS) return { line: li + 1, waiting: true, t };
    return { line: li, waiting: false, t };
  }
  const n = map.nextLyric[i] ?? -1;
  return { line: n, waiting: n >= 0, t };
}

/**
 * Time from `t` to the next visible change, in ms (Infinity when nothing else will change). Every
 * span is [start, end): a boundary at exactly `t` has already happened, as `wordState` paints it.
 */
export function untilNextChange(map: CueMap, t: number, words = true): number {
  const b = words ? map.boundaries : map.lineBoundaries;
  let lo = 0;
  let hi = b.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((b[mid] ?? Infinity) <= t) lo = mid + 1;
    else hi = mid;
  }
  const next = b[lo];
  return next === undefined ? Infinity : next - t;
}

/** Whether `t` is exactly one of the map's boundaries. */
function onBoundary(map: CueMap, t: number, words = true): boolean {
  const b = words ? map.boundaries : map.lineBoundaries;
  let lo = 0;
  let hi = b.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((b[mid] ?? Infinity) < t) lo = mid + 1;
    else hi = mid;
  }
  return b[lo] === t;
}

interface Scene {
  el: HTMLDivElement;
  view: StageView;
  key: string;
  mode: ModeRenderer | null;
  cues: CueMap | null;
  /** the song's CJK language, which picks the font stack's CJK families (one per song, so lines measure alike) */
  lang: CjkLang | null;
  /** performance.now() when the scene appeared; rebuilt state animations resume from here */
  shownAt: number;
  /** performance.now() when it starts fading in, once whatever it replaced has faded out */
  revealAt: number;
}

export interface StageOptions {
  /**
   * Stage height that counts as 1× for `Settings.size`. Default 1080; the settings preview can zoom in.
   * A function is asked on every layout (the overlay's follows its screen).
   */
  referenceHeight?: number | (() => number);
  /** Called when the stage needs a fresh frame on its own (fonts loaded, resized, motion preference flipped). */
  onInvalidate?: () => void;
  /**
   * Called at a moment a look change can crossfade in without breaking a line in the middle (SPEC
   * §4.6): a lyrics scene's first paint before its first line, every focus-line change, and the start
   * of a break of SAFE_BREAK_MS or more. `atSafePoint` answers the same question at any time.
   * `addSafePointListener` hears the same moments (an OverlayController listens that way).
   */
  onSafePoint?: () => void;
}

/** How setPickedLook brings a new look in: at once, or crossfading the scene (freeze, copy, rebuild). */
export type LookChange = "now" | "crossfade";

const now = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * What a look change means for a mode (SPEC §2.7): `shape` (the style, face, sizes, placement,
 * curve, letter-spacing, case, motion, power, unsynced, dpr, emphasis) needs a rebuild; `paint` (the
 * colors, glow and bloom, and the motion's energy, snap and Effects) only a restyle, which re-plans
 * the focus line when the motion changed. Opacity is neither: the stage root applies it. `mode`
 * replaces the look's style (callers from before the style was part of the look).
 */
export function lookKeys(look: Look, mode = look.style): { shape: string; paint: string } {
  const { colors, glow, bloom, energy, snap, effects, opacity, style, ...shape } = look;
  void opacity;
  void style;
  return { shape: JSON.stringify([shape, mode]), paint: JSON.stringify([colors, glow, bloom, energy, snap, effects]) };
}

/** An element's opacity as drawn right now, running fades included. */
function opacityOf(el: HTMLElement): number {
  if (typeof getComputedStyle !== "function") return 1;
  const value = Number.parseFloat(getComputedStyle(el).opacity);
  return Number.isFinite(value) ? value : 1;
}

/** Stops the stage's own fades on an element (it holds whatever its own opacity is). */
function stopFades(el: HTMLElement): void {
  if (typeof el.getAnimations !== "function") return;
  for (const anim of el.getAnimations()) anim.cancel();
}

/**
 * The lyric stage: one per overlay window, and a small one in the settings preview. Owns the DOM,
 * the current mode, song-to-song fades and per-line crossfades, and the picked look it draws with.
 * Knows nothing about the bridge or the clock: the controller hands it views, looks and positions.
 */
export class LyricStage {
  private readonly host: HTMLElement;
  private readonly root: HTMLDivElement;
  private readonly options: StageOptions;
  private readonly power: Power;
  private settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private palette: Palette | null = null;
  private picked: PickedLook = DEFAULT_PICK;
  private scene: Scene | null = null;
  private lastCue: Cue | null = null;
  private lastT = Number.NaN;
  private shapeKey = "";
  private paintKey = "";
  private paused = false;
  /** the boundary nextChange last asked an extra frame for */
  private followedUp = Number.NaN;
  /** performance.now() when everything that was on screen before the current scene has faded out */
  private clearAt = 0;
  private fontKey = "";
  private fontTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  /** addSafePointListener's listeners, on top of StageOptions.onSafePoint */
  private readonly safeListeners = new Set<() => void>();
  private readonly resize: ResizeObserver | null;
  private readonly motionQuery: MediaQueryList | null;
  private readonly onMotion = (): void => this.rebuild();
  /** Matches the device pixel ratio the layout was snapped to; see watchDpr. */
  private dprQuery: MediaQueryList | null = null;
  private readonly onDpr = (): void => {
    this.watchDpr();
    this.rebuild();
  };
  /** A face (or a script subset of one, e.g. Vietnamese) finished loading: measured layouts redo themselves. */
  private readonly onFontsLoaded = (): void => {
    if (this.fontTimer) return;
    this.fontTimer = setTimeout(() => {
      this.fontTimer = null;
      this.rebuild(true);
    }, 0);
  };

  constructor(host: HTMLElement, options: StageOptions = {}) {
    this.host = host;
    this.options = options;
    this.power = detectPower();
    host.classList.add("ut-stage");
    this.root = h("div", "ut-root");
    host.append(this.root);
    this.resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.rebuild()) : null;
    this.resize?.observe(host);
    this.motionQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    this.motionQuery?.addEventListener("change", this.onMotion);
    this.watchDpr();
    if (typeof document !== "undefined" && "fonts" in document) document.fonts.addEventListener("loadingdone", this.onFontsLoaded);
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
    this.root.style.opacity = String(settings.opacity / 100);
    this.loadFace();
    this.rebuild();
  }

  setPalette(palette: Palette | null): void {
    this.palette = palette;
    if (this.settings.autoColor) this.rebuild();
  }

  /** The look the stage draws with: the song's pick (DEFAULT_PICK until one is set). */
  get pickedLook(): PickedLook {
    return this.picked;
  }

  /**
   * Draws with `look` (null: DEFAULT_PICK) from now on. A change of shape (the style, face, size...)
   * rebuilds the scene: at once, or with "crossfade" behind a still copy of what was on screen that
   * fades out (freeze, copy, rebuild). Colors, glow and the motion's character only restyle. Only
   * lyrics crossfade: a state rebuilds where its animation was (buildState), since a copy of it would
   * start its animation over (a chip that had faded out would show again as the copy fades).
   */
  setPickedLook(look: PickedLook | null, how: LookChange = "now"): void {
    const next = look ?? DEFAULT_PICK;
    if (JSON.stringify(next) === JSON.stringify(this.picked)) return;
    this.picked = next;
    this.loadFace();
    const scene = this.scene;
    if (how === "crossfade" && scene && scene.view.kind === "lyrics") {
      const fresh = this.look(scene);
      if (lookKeys(fresh).shape !== this.shapeKey) {
        this.ghost(scene);
        this.build(scene, fresh);
        this.options.onInvalidate?.();
        return;
      }
    }
    this.rebuild();
  }

  /**
   * Shows a view for a track. A new key or a different view fades the old content out first, and the
   * new one in once nothing old is left on screen. Something that never became visible (a loading
   * state still in its quiet first 600 ms) is simply dropped and holds nothing up.
   *
   * With a `look` (null: DEFAULT_PICK), the new scene is drawn with it, as setPickedLook would from
   * then on, while the old one fades out as it was drawn: a song comes in with its own look.
   */
  show(view: StageView, key: string, look?: PickedLook | null): void {
    const old = this.scene;
    if (old && old.key === key && old.view === view) {
      if (look !== undefined) this.setPickedLook(look);
      return;
    }
    if (look !== undefined) {
      this.picked = look ?? DEFAULT_PICK;
      this.loadFace();
    }
    const t = now();
    const scene: Scene = {
      el: h("div", "ut-scene"),
      view,
      key,
      mode: null,
      cues: view.kind === "lyrics" ? cueMap(view.timeline) : null,
      lang: view.kind === "lyrics" ? cjkLang(view.timeline.lines.map((l) => l.text).join("\n")) : null,
      shownAt: t,
      revealAt: t,
    };
    if (scene.lang) scene.el.lang = scene.lang;
    this.root.append(scene.el);
    this.scene = scene;
    this.lastCue = null;
    this.lastT = Number.NaN;
    this.shapeKey = "";
    this.build(scene);
    if (old) {
      const drop = (): void => {
        old.mode?.destroy();
        old.el.remove();
      };
      if (onScreen(old, t)) {
        this.clearAt = Math.max(this.clearAt, t + FADE_OUT_MS);
        void this.fade(old.el, null, 0, FADE_OUT_MS, 0, "ease-in").then(drop);
      } else {
        drop();
      }
    }
    if (view.kind !== "none") {
      const delay = Math.max(0, this.clearAt - t);
      scene.revealAt = t + delay;
      void this.fade(scene.el, 0, 1, FADE_IN_MS, delay, "ease-out");
    }
    this.options.onInvalidate?.();
  }

  /** Paused (or stopped): the next paints get `running: false`, and state animations hold still. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.host.toggleAttribute("data-paused", paused);
  }

  /** Fades the whole stage in or out (showWhen gating). */
  setVisible(visible: boolean): void {
    this.host.classList.toggle("ut-hidden", !visible);
  }

  /**
   * Paints position `t`. Returns true while it needs another frame regardless of word timing. `rate`
   * is how fast song time runs right now (PlaybackClock.rate): 1 playing, 0 paused, near 1 slewing;
   * `target` where the clock is converging (PlaybackClock.target), `t` when absent.
   */
  render(t: number, rate = this.paused ? 0 : 1, target = t): boolean {
    const scene = this.scene;
    if (!scene?.mode || !scene.cues) return false;
    const cue = this.cueOf(scene.cues, t, rate, target);
    const last = this.lastCue;
    const lastT = this.lastT;
    if (last && (cue.line !== last.line ? scene.mode.crossfades(cue) : scene.mode.cuts?.(cue) === true)) this.ghost(scene);
    this.lastCue = cue;
    this.lastT = t;
    const busy = scene.mode.paint(cue);
    if (this.watchesSafePoints && this.scene === scene && this.safeAt(scene.cues, cue, last, lastT)) this.safePoint();
    return busy;
  }

  /**
   * Calls `fn` at every safe point too (see StageOptions.onSafePoint), until the returned function is
   * called. An OverlayController listens this way, so a stage built without the option (the settings
   * preview's) still brings a song's look refinement in at the same moments as the overlay.
   */
  addSafePointListener(fn: () => void): () => void {
    this.safeListeners.add(fn);
    return () => {
      this.safeListeners.delete(fn);
    };
  }

  /**
   * A clock sample between paints (the controller's quiet resyncs): the mode brings its song-time
   * motion onto it without a frame. True when it does need a paint after all: the stage's line moved,
   * or the mode's own focus did.
   */
  retime(t: number, rate = this.paused ? 0 : 1, target = t): boolean {
    const scene = this.scene;
    if (!scene?.mode || !scene.cues) return false;
    const cue = this.cueOf(scene.cues, t, rate, target);
    const last = this.lastCue;
    if (!last || cue.line !== last.line || cue.waiting !== last.waiting) return true;
    scene.mode.retime?.(cue);
    return (scene.mode.nextChange?.(t) ?? Infinity) <= 0;
  }

  /**
   * Whether a look change could crossfade in at `t` without cutting into a line: no lyrics on screen
   * (a state, or lyrics still waiting for the scene before them to fade out), before the first line,
   * or inside a break of SAFE_BREAK_MS or more (before the next line's lead).
   */
  atSafePoint(t: number): boolean {
    const scene = this.scene;
    const cues = scene?.cues;
    if (!scene || !cues || now() < scene.revealAt) return true;
    const first = cues.lyrics[0];
    if (!first || t < first.start - LEAD_MS) return true;
    return cues.breaks.some((b) => t >= b.start && t < b.end - LEAD_MS);
  }

  /**
   * Whether the current scene needs frames at word boundaries (false: its mode draws words on the
   * compositor, see ModeRenderer.wordWakes). States and modes that paint words themselves do.
   */
  get wakesForWords(): boolean {
    return this.scene?.mode?.wordWakes !== false;
  }

  /**
   * Ms of song time until the next word or line boundary; the controller can sleep that long. A frame
   * that lands exactly on a boundary gets another one straight after (0). Painted by `wordState`, a
   * word is already lit at its first millisecond, but a renderer that lights a word only once
   * `progress` is above 0 would otherwise show it unlit until the loop next wakes, up to 250 ms on.
   * That costs one extra frame on the rare exact hit, once per boundary, so it never spins.
   */
  nextChange(t: number): number {
    const cues = this.scene?.cues;
    if (!cues) return Infinity;
    const mode = this.scene?.mode;
    const words = mode?.wordWakes !== false;
    if (t !== this.followedUp && onBoundary(cues, t, words)) {
      this.followedUp = t;
      return 0;
    }
    const own = mode?.nextChange?.(t) ?? Infinity;
    const safe = this.watchesSafePoints ? untilNext(cues.breakStarts, t) : Infinity;
    return Math.min(untilNextChange(cues, t, words), Math.max(0, own), safe);
  }

  destroy(): void {
    this.destroyed = true;
    this.safeListeners.clear();
    this.resize?.disconnect();
    this.motionQuery?.removeEventListener("change", this.onMotion);
    this.dprQuery?.removeEventListener("change", this.onDpr);
    this.dprQuery = null;
    if (typeof document !== "undefined" && "fonts" in document) document.fonts.removeEventListener("loadingdone", this.onFontsLoaded);
    if (this.fontTimer) clearTimeout(this.fontTimer);
    this.fontTimer = null;
    this.scene?.mode?.destroy();
    this.root.remove();
    this.host.classList.remove("ut-stage", "ut-hidden");
  }

  /** Someone wants to hear of safe points (onSafePoint, addSafePointListener): breaks starting are woken for. */
  private get watchesSafePoints(): boolean {
    return this.options.onSafePoint !== undefined || this.safeListeners.size > 0;
  }

  private safePoint(): void {
    this.options.onSafePoint?.();
    for (const fn of [...this.safeListeners]) fn();
  }

  private cueOf(cues: CueMap, t: number, rate: number, target: number): Cue {
    const running = !this.paused;
    return { ...cueAt(cues, t), running, rate: running ? rate : 0, target: Number.isFinite(target) ? target : t };
  }

  /** A safe point at this paint: the scene's first paint before its first line, a line change, a long break starting. */
  private safeAt(cues: CueMap, cue: Cue, last: Cue | null, lastT: number): boolean {
    if (!last) return cue.t < (cues.lyrics[0]?.start ?? Infinity);
    if (cue.line !== last.line) return true;
    return cues.breakStarts.some((s) => s > lastT && s <= cue.t);
  }

  /**
   * Layouts are snapped to device pixels. A window that moves to a screen of another scale (the
   * settings window dragged to another display, an overlay kept across a primary-display change) may
   * keep its CSS size, so no resize says so: listen for the current ratio to stop matching instead,
   * then for the new one.
   */
  private watchDpr(): void {
    this.dprQuery?.removeEventListener("change", this.onDpr);
    const ratio = typeof devicePixelRatio === "number" ? devicePixelRatio : 0;
    this.dprQuery = typeof matchMedia === "function" && ratio > 0 ? matchMedia(`(resolution: ${ratio}dppx)`) : null;
    this.dprQuery?.addEventListener("change", this.onDpr);
  }

  /** Measured layouts (lens, arc fitting, wrapped drift rows) need the real face: build again once the picked one is in. */
  private loadFace(): void {
    const { family, weight } = this.picked.font;
    const key = `${family}/${weight}`;
    if (key === this.fontKey) return;
    this.fontKey = key;
    const face = fontFor(family);
    void loadFont(face, weight || face.weight).then(() => {
      if (this.fontKey === key) this.rebuild(true);
    });
  }

  private look(scene: Scene): Look {
    const option = this.options.referenceHeight;
    const reference = typeof option === "function" ? option() : option;
    return resolveLook(
      this.settings,
      this.palette,
      {
        width: this.host.clientWidth,
        height: this.host.clientHeight,
        dpr: typeof devicePixelRatio === "number" ? devicePixelRatio : 1,
        motion: !reducedMotion(),
        unsynced: scene.cues?.unsynced ?? false,
        lang: scene.lang,
        power: this.power,
        ...(reference ? { referenceHeight: reference } : {}),
      },
      this.picked,
    );
  }

  /**
   * Brings the current scene up to date with the look: nothing to do, a restyle when only the paint
   * changed (a slider drag mustn't tear down and re-measure the mode, or cut a glide short), or a
   * rebuild. `force` always rebuilds.
   */
  private rebuild(force = false): void {
    const scene = this.scene;
    // a face or a font subset that finishes loading after destroy() builds nothing
    if (!scene || this.destroyed) return;
    const look = this.look(scene);
    const keys = lookKeys(look);
    if (!force && keys.shape === this.shapeKey) {
      if (keys.paint === this.paintKey) return;
      if (scene.mode?.restyle) {
        this.paintKey = keys.paint;
        scene.mode.restyle(look);
        this.options.onInvalidate?.();
        return;
      }
    }
    this.build(scene, look);
    this.options.onInvalidate?.();
  }

  private build(scene: Scene, look = this.look(scene)): void {
    const keys = lookKeys(look);
    this.shapeKey = keys.shape;
    this.paintKey = keys.paint;
    scene.mode?.destroy();
    scene.mode = null;
    scene.el.textContent = "";
    this.lastCue = null;
    this.lastT = Number.NaN;
    const { view, cues } = scene;
    if (view.kind === "lyrics") {
      scene.mode = createMode(look.style);
      scene.mode.build(scene.el, cues?.lyrics ?? [], look);
    } else if (view.kind !== "none") {
      buildState(scene.el, view.kind, look, now() - scene.shownAt);
    }
  }

  /**
   * Leaves a still copy of the scene fading out on top while the mode draws what comes next. The mode
   * first freezes its motion where it is, so the copy shows what was on screen. The copy starts from
   * however visible the scene is right now (it may itself be fading in), and the scene's own fade
   * restarts under it, so nothing ever jumps to full brightness. A scene that hasn't started fading in
   * yet has nothing on screen to fade: it just changes.
   */
  private ghost(scene: Scene): void {
    if (now() < scene.revealAt) return;
    const el = scene.el;
    const shown = opacityOf(el);
    stopFades(el);
    if (shown > 0.01) {
      scene.mode?.freeze?.();
      const copy = el.cloneNode(true) as HTMLElement;
      copy.classList.add("ut-ghost");
      copy.setAttribute("aria-hidden", "true");
      el.after(copy);
      void this.fade(copy, shown, 0, LINE_OUT_MS, 0, "ease-out").then(() => copy.remove());
    }
    void this.fade(el, 0, 1, LINE_IN_MS, LINE_IN_DELAY_MS, "ease-out");
  }

  /** Fades `el` between opacities; `from` null starts from wherever it is now (taking over any fade in progress). */
  private fade(el: HTMLElement, from: number | null, to: number, duration: number, delay: number, easing: string): Promise<void> {
    if (typeof el.animate !== "function") {
      el.style.opacity = String(to);
      return Promise.resolve();
    }
    if (from === null) {
      from = opacityOf(el);
      stopFades(el);
    }
    const anim = el.animate([{ opacity: from }, { opacity: to }], {
      duration,
      delay,
      easing,
      // fading in: hold transparent through the delay, then hand back to the element's own opacity
      fill: to > from ? "backwards" : "forwards",
    });
    return anim.finished.then(
      () => undefined,
      () => undefined,
    );
  }
}

/** Whether any of a scene is on screen at `t`: it has started fading in, and has something to show by now. */
function onScreen(scene: Scene, t: number): boolean {
  if (scene.view.kind === "none" || t <= scene.revealAt) return false;
  return scene.view.kind !== "loading" || t - scene.shownAt >= LOADING_DELAY_MS;
}
