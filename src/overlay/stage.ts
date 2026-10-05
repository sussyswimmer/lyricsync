import { DEFAULT_SETTINGS, type Settings } from "../../contract/contract";
import type { Line } from "../core/lrc";
import type { Palette } from "../core/palette";
import { lineAt, type Timeline } from "../core/timing";
import { h } from "./dom";
import { fontFor, loadFont } from "./fonts";
import { resolveLook, type Look } from "./look";
import { createMode } from "./modes";
import type { Cue, ModeRenderer } from "./modes/types";
import { buildState, type StateKind } from "./states";

export type StageView = { kind: "none" } | { kind: StateKind } | { kind: "lyrics"; timeline: Timeline };

/** Old song out, then new song in (C6). */
const FADE_OUT_MS = 250;
const FADE_IN_MS = 450;
/** Crossfade between lines for modes that redraw per line, and for everything under reduced motion. */
const LINE_FADE_MS = 280;
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
export function cueAt(map: CueMap, t: number): Cue {
  const i = lineAt(map.all, t);
  if (i < 0) return { line: map.lyrics.length > 0 ? 0 : -1, waiting: true, t };
  const li = map.lyricOf[i] ?? -1;
  if (li >= 0) {
    const line = map.lyrics[li];
    const lastEnd = line?.words[line.words.length - 1]?.end ?? -Infinity;
    if (!map.unsynced && li + 1 < map.lyrics.length && t > lastEnd + LINGER_MS) return { line: li + 1, waiting: true, t };
    return { line: li, waiting: false, t };
  }
  const n = map.nextLyric[i] ?? -1;
  return { line: n, waiting: n >= 0, t };
}

/** Time from `t` to the next visible change, in ms (Infinity when nothing else will change). */
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

interface Scene {
  el: HTMLDivElement;
  view: StageView;
  key: string;
  mode: ModeRenderer | null;
  cues: CueMap | null;
}

export interface StageOptions {
  /** Stage height that counts as 1× for `Settings.size`. Default 1080; the settings preview can zoom in. */
  referenceHeight?: number;
  /** Called when the stage needs a fresh frame on its own (fonts loaded, resized, motion preference flipped). */
  onInvalidate?: () => void;
}

const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  private lookKey = "";
  private readonly resize: ResizeObserver | null;
  private readonly motionQuery: MediaQueryList | null;
  private readonly onMotion = (): void => this.rebuild();

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
  }

  setSettings(settings: Settings): void {
    const fontChanged = settings.font.family !== this.settings.font.family || settings.font.weight !== this.settings.font.weight;
    this.settings = settings;
    this.root.style.opacity = String(settings.opacity / 100);
    if (fontChanged) {
      const family = settings.font.family;
      void loadFont(fontFor(family), settings.font.weight).then(() => {
        // Measured layouts (lens, wrapped drift rows) need the real face, so build again once it's in.
        if (this.settings.font.family === family) this.rebuild(true);
      });
    }
    this.rebuild();
  }

  setPalette(palette: Palette | null): void {
    this.palette = palette;
    if (this.settings.autoColor) this.rebuild();
  }

  /** Shows a view for a track. A new key or a different view fades the old content out first. */
  show(view: StageView, key: string): void {
    const old = this.scene;
    if (old && old.key === key && old.view === view) return;
    const scene: Scene = {
      el: h("div", "ut-scene"),
      view,
      key,
      mode: null,
      cues: view.kind === "lyrics" ? cueMap(view.timeline) : null,
    };
    this.root.append(scene.el);
    this.scene = scene;
    this.lastCue = null;
    this.lookKey = "";
    this.build(scene);
    if (old) {
      this.fade(old.el, 1, 0, FADE_OUT_MS, 0).then(() => {
        old.mode?.destroy();
        old.el.remove();
      });
    }
    if (view.kind !== "none") void this.fade(scene.el, 0, 1, FADE_IN_MS, old && old.view.kind !== "none" ? FADE_OUT_MS : 0);
    this.options.onInvalidate?.();
  }

  setPaused(paused: boolean): void {
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
    const cue = cueAt(scene.cues, t);
    const last = this.lastCue;
    if (last && cue.line !== last.line && scene.mode.crossfadeLines) this.ghost(scene.el);
    this.lastCue = cue;
    return scene.mode.paint(cue);
  }

  /** Ms of song time until the next word or line boundary; the controller can sleep that long. */
  nextChange(t: number): number {
    return this.scene?.cues ? untilNextChange(this.scene.cues, t) : Infinity;
  }

  destroy(): void {
    this.resize?.disconnect();
    this.motionQuery?.removeEventListener("change", this.onMotion);
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

  /** Rebuilds the current scene if anything that affects drawing changed (or always, with `force`). */
  private rebuild(force = false): void {
    const scene = this.scene;
    if (!scene) return;
    const look = this.look(scene);
    const key = JSON.stringify([look, this.settings.mode]);
    if (!force && key === this.lookKey) return;
    this.build(scene, look);
    this.options.onInvalidate?.();
  }

  private build(scene: Scene, look = this.look(scene)): void {
    this.lookKey = JSON.stringify([look, this.settings.mode]);
    scene.mode?.destroy();
    scene.mode = null;
    scene.el.textContent = "";
    this.lastCue = null;
    const { view, cues } = scene;
    if (view.kind === "lyrics") {
      scene.mode = createMode(this.settings.mode);
      scene.mode.build(scene.el, cues?.lyrics ?? [], look);
    } else if (view.kind !== "none") {
      buildState(scene.el, view.kind, look);
    }
  }

  /** Leaves a copy of the current line fading out on top while the mode draws the next one. */
  private ghost(el: HTMLElement): void {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.classList.add("ut-ghost");
    copy.setAttribute("aria-hidden", "true");
    el.after(copy);
    void this.fade(copy, 1, 0, LINE_FADE_MS, 0).then(() => copy.remove());
    void this.fade(el, 0, 1, LINE_FADE_MS, 0);
  }

  private fade(el: HTMLElement, from: number, to: number, duration: number, delay: number): Promise<void> {
    if (typeof el.animate !== "function") {
      el.style.opacity = String(to);
      return Promise.resolve();
    }
    const anim = el.animate([{ opacity: from }, { opacity: to }], {
      duration,
      delay,
      easing: to > from ? "ease-out" : "ease-in",
      // fading in: hold transparent through the delay, then hand back to the element's own opacity
      fill: to > from ? "backwards" : "forwards",
    });
    return anim.finished.then(
      () => undefined,
      () => undefined,
    );
  }
}
