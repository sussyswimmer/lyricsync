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

  /**
   * Subscribes first, then reads the initial state, so nothing that happens in between is lost.
   * Events and command replies travel separately, so an event can overtake a reply: once an event has
   * been heard, it is newer than the reply, which is dropped (every later change sends another event).
   * Safe to destroy() while this is still running: it stops at the next step and unsubscribes.
   */
  async start(): Promise<void> {
    const b = this.bridge;
    const keep = (off: Unlisten): boolean => {
      if (this.stopped) off();
      else this.unlisten.push(off);
      return !this.stopped;
    };
    let heardTrack = false;
    let heardSettings = false;
    const onNowPlaying = (np: NowPlaying | null): void => {
      heardTrack = true;
      this.onNowPlaying(np);
    };
    const onSettings = (settings: Settings): void => {
      heardSettings = true;
      this.setSettings(settings);
    };
    if (!keep(await b.listen("now-playing", onNowPlaying))) return;
    if (!keep(await b.listen("lyrics", (l) => this.onLyrics(l)))) return;
    if (this.followSettings) {
      if (!keep(await b.listen("settings-changed", onSettings))) return;
      const settings = await b.invoke("get_settings");
      if (this.stopped) return;
      if (!heardSettings) this.setSettings(settings);
    }
    const np = await b.invoke("get_now_playing");
    if (this.stopped) return;
    if (!heardTrack) this.onNowPlaying(np);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
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
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
  }

  private onNowPlaying(np: NowPlaying | null): void {
    if (this.stopped) return;
    // A sample older than the clock's (one that crossed a newer one in flight) changes nothing, so
    // what this controller believes (playing, paused) always matches what its clock does.
    if (this.clock.update(np, Date.now()) === "ignored") return;
    const before = this.nowPlaying;
    this.nowPlaying = np;
    if (!np) {
      this.lyrics = null;
      this.stage.show({ kind: "none" }, "");
    } else {
      if (np.trackKey !== before?.trackKey) {
        this.lyrics = null;
        this.stage.show({ kind: "loading" }, np.trackKey);
        void this.fetchLyrics(np.trackKey);
      }
      // Once per track and picture. Resyncs (every second while playing) repeat both, and must not
      // keep restarting the grace period of a track that has no artwork.
      if (np.trackKey !== before?.trackKey || np.artwork !== before.artwork) this.updatePalette(np);
    }
    this.update();
  }

  /** Events always apply in order. The initial `get_lyrics` reply only fills in if no event beat it. */
  private onLyrics(lyrics: Lyrics, fromQuery = false): void {
    if (this.stopped) return;
    const np = this.nowPlaying;
    if (!np || lyrics.trackKey !== np.trackKey) return;
    if (fromQuery && this.lyrics?.trackKey === lyrics.trackKey) return;
    if (sameLyrics(this.lyrics, lyrics)) return;
    // A track change already shows "loading"; a second "loading" mustn't fade it out and back in.
    const wasLoading = this.lyrics === null || this.lyrics.status === "loading";
    this.lyrics = lyrics;
    if (lyrics.status === "loading" && wasLoading) return;
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

  /**
   * Album colors follow the artwork. Keeps the last song's colors until this song's art arrives, or
   * for ARTWORK_GRACE_MS after the track starts if it has none, then uses the manual colors.
   */
  private updatePalette(np: NowPlaying): void {
    const { trackKey: key, artwork } = np;
    if (this.artworkTimer) clearTimeout(this.artworkTimer);
    this.artworkTimer = null;
    void this.palettes.get(key, artwork).then((palette) => {
      const current = this.nowPlaying;
      if (current?.trackKey !== key || current.artwork !== artwork) return;
      if (palette || artwork !== null) {
        this.stage.setPalette(palette);
        this.kick();
        return;
      }
      this.artworkTimer = setTimeout(() => {
        this.artworkTimer = null;
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
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    return this.visible && !!this.nowPlaying?.isPlaying && !hidden;
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
