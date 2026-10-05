import { DEFAULT_SETTINGS, type Lyrics, type NowPlaying, type Settings } from "../../contract/contract";
import { PlaybackClock } from "../core/clock";
import { PaletteCache } from "../core/palette";
import type { Bridge, Unlisten } from "../bridge/types";
import type { LyricStage } from "./stage";
import { sameLyrics, viewFor } from "./view";

/** Longest the loop sleeps between word boundaries, so a slewing clock or a missed event can't strand it. */
const MAX_SLEEP_MS = 250;
/** A track whose artwork hasn't arrived by now gets the manual colors instead of the last song's. */
const ARTWORK_GRACE_MS = 1500;

export interface ControllerOptions {
  /** Hide the stage when `showWhen` says so and stop drawing (the overlay). The settings preview leaves it off. */
  gate?: boolean;
  /** Take settings from the bridge (default) or only from `setSettings` (a preview showing unsaved values). */
  followSettings?: boolean;
  palettes?: PaletteCache;
}

/**
 * Drives a stage from a bridge: playback clock, lyrics, album colors, visibility, and the frame loop.
 * The loop runs only while a track is playing and the stage is visible; between word boundaries it
 * sleeps instead of drawing identical frames.
 */
export class OverlayController {
  readonly clock = new PlaybackClock();
  private readonly bridge: Bridge;
  private readonly stage: LyricStage;
  private readonly gate: boolean;
  private readonly followSettings: boolean;
  private readonly palettes: PaletteCache;
  private settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private nowPlaying: NowPlaying | null = null;
  private lyrics: Lyrics | null = null;
  private unlisten: Unlisten[] = [];
  private raf = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private artworkTimer: ReturnType<typeof setTimeout> | null = null;
  private visible = false;
  private stopped = false;
  private readonly onVisibility = (): void => this.kick();

  constructor(bridge: Bridge, stage: LyricStage, options: ControllerOptions = {}) {
    this.bridge = bridge;
    this.stage = stage;
    this.gate = options.gate ?? false;
    this.followSettings = options.followSettings ?? true;
    this.palettes = options.palettes ?? new PaletteCache();
  }

  /** Subscribes first, then reads the initial state, so nothing that happens in between is lost. */
  async start(): Promise<void> {
    const b = this.bridge;
    this.unlisten.push(await b.listen("now-playing", (np) => this.onNowPlaying(np)));
    this.unlisten.push(await b.listen("lyrics", (l) => this.onLyrics(l)));
    if (this.followSettings) {
      this.unlisten.push(await b.listen("settings-changed", (s) => this.setSettings(s)));
      this.setSettings(await b.invoke("get_settings"));
    }
    this.onNowPlaying(await b.invoke("get_now_playing"));
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  get track(): NowPlaying | null {
    return this.nowPlaying;
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
    this.clock.setOffsets(settings);
    this.stage.setSettings(settings);
    this.update();
  }

  /** Paints one frame now (after anything changed while the loop is asleep). */
  kick(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.raf && typeof requestAnimationFrame === "function") this.raf = requestAnimationFrame(this.tick);
  }

  destroy(): void {
    this.stopped = true;
    for (const off of this.unlisten) off();
    this.unlisten = [];
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.timer) clearTimeout(this.timer);
    if (this.artworkTimer) clearTimeout(this.artworkTimer);
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  private onNowPlaying(np: NowPlaying | null): void {
    const before = this.nowPlaying?.trackKey ?? null;
    this.nowPlaying = np;
    this.clock.update(np, Date.now());
    if (!np) {
      this.lyrics = null;
      this.stage.show({ kind: "none" }, "");
    } else {
      if (np.trackKey !== before) {
        this.lyrics = null;
        this.stage.show({ kind: "loading" }, np.trackKey);
        void this.fetchLyrics(np.trackKey);
      }
      this.updatePalette(np);
    }
    this.update();
  }

  /** Events always apply in order. The initial `get_lyrics` reply only fills in if no event beat it. */
  private onLyrics(lyrics: Lyrics, fromQuery = false): void {
    const np = this.nowPlaying;
    if (!np || lyrics.trackKey !== np.trackKey) return;
    if (fromQuery && this.lyrics?.trackKey === lyrics.trackKey) return;
    if (sameLyrics(this.lyrics, lyrics)) return;
    this.lyrics = lyrics;
    this.stage.show(viewFor(lyrics, np.durationMs), np.trackKey);
    this.kick();
  }

  private async fetchLyrics(trackKey: string): Promise<void> {
    try {
      this.onLyrics(await this.bridge.invoke("get_lyrics", { trackKey }), true);
    } catch {
      // the lyrics event will still arrive
    }
  }

  /** Album colors follow the artwork. Keeps the last song's colors until this song's art arrives. */
  private updatePalette(np: NowPlaying): void {
    const key = np.trackKey;
    void this.palettes.get(key, np.artwork).then((palette) => {
      if (this.nowPlaying?.trackKey !== key) return;
      if (palette || np.artwork !== null) {
        this.stage.setPalette(palette);
        this.kick();
        return;
      }
      if (this.artworkTimer) clearTimeout(this.artworkTimer);
      this.artworkTimer = setTimeout(() => {
        if (this.nowPlaying?.trackKey === key && this.nowPlaying.artwork === null) {
          this.stage.setPalette(null);
          this.kick();
        }
      }, ARTWORK_GRACE_MS);
    });
  }

  private update(): void {
    const np = this.nowPlaying;
    this.visible = !this.gate || (np !== null && (this.settings.showWhen === "always" || np.isPlaying));
    this.stage.setVisible(this.visible);
    this.stage.setPaused(!np?.isPlaying);
    this.kick();
  }

  private get animating(): boolean {
    return this.visible && !!this.nowPlaying?.isPlaying && document.visibilityState !== "hidden";
  }

  private readonly tick = (): void => {
    this.raf = 0;
    if (this.stopped) return;
    const t = this.clock.position(Date.now());
    const busy = this.stage.render(t);
    if (!this.animating) return;
    if (busy) {
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    const wait = Math.min(MAX_SLEEP_MS, this.stage.nextChange(t));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.raf = requestAnimationFrame(this.tick);
    }, Math.max(0, wait - 4));
  };
}
