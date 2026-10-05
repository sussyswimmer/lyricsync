import { DEFAULT_SETTINGS, type Mode, type Settings } from "../../contract/contract";
import type { Line } from "../core/lrc";
import type { Palette } from "../core/palette";
import { lineAt, type Timeline } from "../core/timing";
import { h } from "./dom";
import { fontFor, loadFont } from "./fonts";
import { resolveLook, type Look } from "./look";
import { createMode } from "./modes";
import type { Cue, ModeRenderer } from "./modes/types";
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
  for (const line of all) {
    times.add(line.start);
    // Unsynced lyrics draw no per-word change and never linger: only line starts matter.
    if (timeline.unsynced) continue;
    for (const w of line.words) {
      times.add(w.start);
      times.add(w.end);
    }
    const last = line.words[line.words.length - 1];
    if (last) times.add(last.end + LINGER_MS);
  }
  return { all, lyrics, lyricOf, nextLyric, boundaries: [...times].sort((a, b) => a - b), unsynced: timeline.unsynced };
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
export function untilNextChange(map: CueMap, t: number): number {
  const b = map.boundaries;
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
function onBoundary(map: CueMap, t: number): boolean {
  const b = map.boundaries;
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
  /** performance.now() when the scene appeared; rebuilt state animations resume from here */
  shownAt: number;
  /** performance.now() when it starts fading in, once whatever it replaced has faded out */
  revealAt: number;
}

export interface StageOptions {
  /** Stage height that counts as 1× for `Settings.size`. Default 1080; the settings preview can zoom in. */
  referenceHeight?: number;
  /** Called when the stage needs a fresh frame on its own (fonts loaded, resized, motion preference flipped). */
  onInvalidate?: () => void;
}

const now = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * What a look change means for a mode: `shape` (fonts, sizes, placement, motion) needs a rebuild,
 * `paint` (colors, glow) only a restyle. Opacity is neither: the stage root applies it.
 */
export function lookKeys(look: Look, mode: Mode): { shape: string; paint: string } {
  const { colors, glow, opacity, ...shape } = look;
  return { shape: JSON.stringify([shape, mode]), paint: JSON.stringify([colors, glow]) };
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
 * the current mode, song-to-song fades and per-line crossfades. Knows nothing about the bridge or
 * the clock: the controller hands it views and positions.
 */
export class LyricStage {
  private readonly host: HTMLElement;
  private readonly root: HTMLDivElement;
  private readonly options: StageOptions;
  private settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private palette: Palette | null = null;
  private scene: Scene | null = null;
  private lastCue: Cue | null = null;
  private shapeKey = "";
  private paintKey = "";
  private paused = false;
  /** the boundary nextChange last asked an extra frame for */
  private followedUp = Number.NaN;
  /** performance.now() when everything that was on screen before the current scene has faded out */
  private clearAt = 0;
  private fontKey = "";
  private fontTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly resize: ResizeObserver | null;
  private readonly motionQuery: MediaQueryList | null;
  private readonly onMotion = (): void => this.rebuild();
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
    host.classList.add("ut-stage");
    this.root = h("div", "ut-root");
    host.append(this.root);
    this.resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.rebuild()) : null;
    this.resize?.observe(host);
    this.motionQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    this.motionQuery?.addEventListener("change", this.onMotion);
    if (typeof document !== "undefined" && "fonts" in document) document.fonts.addEventListener("loadingdone", this.onFontsLoaded);
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
    this.root.style.opacity = String(settings.opacity / 100);
    const fontKey = `${settings.font.family}/${settings.font.weight}`;
    if (fontKey !== this.fontKey) {
      // Measured layouts (lens, arc fitting, wrapped drift rows) need the real face, including the
      // first one: build again once it's in.
      this.fontKey = fontKey;
      void loadFont(fontFor(settings.font.family), settings.font.weight).then(() => {
        if (this.fontKey === fontKey) this.rebuild(true);
      });
    }
    this.rebuild();
  }

  setPalette(palette: Palette | null): void {
    this.palette = palette;
    if (this.settings.autoColor) this.rebuild();
  }

  /**
   * Shows a view for a track. A new key or a different view fades the old content out first, and the
   * new one in once nothing old is left on screen. Something that never became visible (a loading
   * state still in its quiet first 600 ms) is simply dropped and holds nothing up.
   */
  show(view: StageView, key: string): void {
    const old = this.scene;
    if (old && old.key === key && old.view === view) return;
    const t = now();
    const scene: Scene = {
      el: h("div", "ut-scene"),
      view,
      key,
      mode: null,
      cues: view.kind === "lyrics" ? cueMap(view.timeline) : null,
      shownAt: t,
      revealAt: t,
    };
    this.root.append(scene.el);
    this.scene = scene;
    this.lastCue = null;
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

  /** Paints position `t`. Returns true while it needs another frame regardless of word timing. */
  render(t: number): boolean {
    const scene = this.scene;
    if (!scene?.mode || !scene.cues) return false;
    const cue: Cue = { ...cueAt(scene.cues, t), running: !this.paused };
    const last = this.lastCue;
    if (last && cue.line !== last.line && scene.mode.crossfadeLines) this.ghost(scene);
    this.lastCue = cue;
    return scene.mode.paint(cue);
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
    if (t !== this.followedUp && onBoundary(cues, t)) {
      this.followedUp = t;
      return 0;
    }
    return untilNextChange(cues, t);
  }

  destroy(): void {
    this.resize?.disconnect();
    this.motionQuery?.removeEventListener("change", this.onMotion);
    if (typeof document !== "undefined" && "fonts" in document) document.fonts.removeEventListener("loadingdone", this.onFontsLoaded);
    if (this.fontTimer) clearTimeout(this.fontTimer);
    this.scene?.mode?.destroy();
    this.root.remove();
    this.host.classList.remove("ut-stage", "ut-hidden");
  }

  private look(scene: Scene): Look {
    return resolveLook(this.settings, this.palette, {
      width: this.host.clientWidth,
      height: this.host.clientHeight,
      dpr: typeof devicePixelRatio === "number" ? devicePixelRatio : 1,
      motion: !reducedMotion(),
      unsynced: scene.cues?.unsynced ?? false,
      ...(this.options.referenceHeight ? { referenceHeight: this.options.referenceHeight } : {}),
    });
  }

  /**
   * Brings the current scene up to date with the look: nothing to do, a restyle when only colors or
   * glow changed (a slider drag mustn't tear down and re-measure the mode, or cut a glide short), or
   * a rebuild. `force` always rebuilds.
   */
  private rebuild(force = false): void {
    const scene = this.scene;
    if (!scene) return;
    const look = this.look(scene);
    const keys = lookKeys(look, this.settings.mode);
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
    const keys = lookKeys(look, this.settings.mode);
    this.shapeKey = keys.shape;
    this.paintKey = keys.paint;
    scene.mode?.destroy();
    scene.mode = null;
    scene.el.textContent = "";
    this.lastCue = null;
    const { view, cues } = scene;
    if (view.kind === "lyrics") {
      scene.mode = createMode(this.settings.mode);
      scene.mode.build(scene.el, cues?.lyrics ?? [], look);
    } else if (view.kind !== "none") {
      buildState(scene.el, view.kind, look, now() - scene.shownAt);
    }
  }

  /**
   * Leaves a copy of the current line fading out on top while the mode draws the next one. The copy
   * starts from however visible the scene is right now (it may itself be fading in), and the scene's
   * own fade restarts under it, so nothing ever jumps to full brightness. A scene that hasn't started
   * fading in yet has nothing on screen to fade: its line just changes.
   */
  private ghost(scene: Scene): void {
    if (now() < scene.revealAt) return;
    const el = scene.el;
    const shown = opacityOf(el);
    stopFades(el);
    if (shown > 0.01) {
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
