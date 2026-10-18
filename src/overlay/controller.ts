import { DEFAULT_SETTINGS, type Lyrics, type NowPlaying, type Settings } from "../../contract/contract";
import { PlaybackClock } from "../core/clock";
import { PaletteCache } from "../core/palette";
import type { Bridge, Unlisten } from "../bridge/types";
import { cleanOverride, DEFAULT_PICK, withOverride, type LookOverride, type PickedLook } from "./look";
import type { LookChange, LyricStage } from "./stage";
import { sameLyrics, viewFor } from "./view";

/** Longest the loop sleeps between word boundaries, so a slewing clock or a missed event can't strand it. */
const MAX_SLEEP_MS = 250;
/**
 * The same for a mode whose words run on the compositor (stage.wakesForWords false): its motion is
 * anchored to the song and follows every player sample without a frame (stage.retime), so it only
 * needs waking for its own events (stage.nextChange). Each frame it skips saves a main-thread restyle
 * and commit of every animation in flight.
 */
const IDLE_SLEEP_MS = 1000;
/**
 * Busy frames (a glide, Lens following the sung word) start at most this often. requestAnimationFrame
 * runs at the display's refresh rate, 120 or 144 times a second on many Windows laptops, and a Lens
 * frame restyles every word of its line. Just over one 120 Hz frame: a display up to 100 Hz still gets
 * every frame, 120 and 144 Hz ones every other (60 and 72 fps), a 240 Hz one every third (80 fps).
 */
const BUSY_FRAME_MS = 8.6;
/** Wait before asking again when the first lyrics query for a track answers `error`. */
const QUERY_RETRY_MS = 1500;
/** A track whose artwork hasn't arrived by now gets the manual colors instead of the last song's. */
const ARTWORK_GRACE_MS = 1500;

const now = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

export interface ControllerOptions {
  /**
   * Hide the stage and stop drawing when the lyrics are turned off (`enabled`) or `showWhen` says so
   * (the overlay). The settings preview leaves it off, so it keeps playing while the user customizes.
   */
  gate?: boolean;
  /** Take settings from the bridge (default) or only from `setSettings` (a preview showing unsaved values). */
  followSettings?: boolean;
  palettes?: PaletteCache;
  /**
   * Called with the look in effect whenever it changes: the picked look with any forced parts, as the
   * stage draws it; null while there is no track.
   */
  onLook?: (look: PickedLook | null) => void;
}

/**
 * Drives a stage from a bridge: playback clock, lyrics, album colors, the look, visibility, and the
 * frame loop. The loop runs only while a track is playing and the stage is visible; between the
 * stage's changes it sleeps instead of drawing identical frames, and frames that move (a glide, the
 * Lens fisheye) come at most every BUSY_FRAME_MS, however fast the display refreshes. A player sample
 * that changes nothing on screen reaches a compositor-drawn stage without a frame (stage.retime).
 */
export class OverlayController {
  readonly clock = new PlaybackClock();
  private readonly bridge: Bridge;
  private readonly stage: LyricStage;
  private readonly gate: boolean;
  private readonly followSettings: boolean;
  private readonly palettes: PaletteCache;
  private readonly onLook: ((look: PickedLook | null) => void) | undefined;
  private settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private nowPlaying: NowPlaying | null = null;
  private lyrics: Lyrics | null = null;
  /** the song's picked look (a LookKeeper's, later); DEFAULT_PICK while there is none */
  private picked: PickedLook | null = null;
  /** parts of the look forced for QA (`?look=`, `--look`, the console) */
  private override: LookOverride | null = null;
  /** the look last reported through onLook, as a key ("" for null) */
  private reported = "";
  private unlisten: Unlisten[] = [];
  private raf = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** performance.now() the pending timer fires at (Infinity without one) */
  private wakeAt = Infinity;
  /** After a busy frame: the earliest the next frame may begin (performance.now() clock), else null. */
  private paceUntil: number | null = null;
  /** A frame has been passed over since the last kick(): this display refreshes faster than BUSY_FRAME_MS. */
  private fastDisplay = false;
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
    this.onLook = options.onLook;
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

  /** The look in effect: the song's pick (DEFAULT_PICK without one) with any forced parts. */
  get look(): PickedLook {
    return withOverride(this.picked ?? DEFAULT_PICK, this.override);
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
    this.clock.setOffsets(settings);
    this.stage.setSettings(settings);
    this.update();
  }

  /**
   * The song's picked look (null: none, DEFAULT_PICK draws). "crossfade" brings a new shape in behind
   * a still copy of the old one (a refinement at a safe point); "now" swaps at once.
   */
  setPickedLook(look: PickedLook | null, how: LookChange = "now"): void {
    this.picked = look;
    this.applyLook(how);
  }

  /**
   * Forces parts of the look for every song on this page (QA: `?look=`, `--look`, the console):
   * the style, a bundled face (at its own weight), Arc's curve (-100..100). Null forces nothing.
   */
  forceLook(override: LookOverride | null): void {
    this.override = cleanOverride(override);
    this.applyLook("now");
  }

  /**
   * The stage reached a safe point (StageOptions.onSafePoint): a look refinement waiting for one can
   * crossfade in now. Nothing waits for one yet; the song look keeper lands here.
   */
  safePoint(): void {
    // no pending refinement without a look keeper
  }

  /** Paints one frame now (after anything changed while the loop is asleep). */
  kick(): void {
    if (this.stopped) return;
    this.clearTimer();
    this.paceUntil = null;
    // the window may be on another display by now
    this.fastDisplay = false;
    if (!this.raf && typeof requestAnimationFrame === "function") this.raf = requestAnimationFrame(this.tick);
  }

  destroy(): void {
    this.stopped = true;
    for (const off of this.unlisten) off();
    this.unlisten = [];
    if (this.raf) cancelAnimationFrame(this.raf);
    this.clearTimer();
    if (this.artworkTimer) clearTimeout(this.artworkTimer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
  }

  private applyLook(how: LookChange): void {
    this.stage.setPickedLook(this.look, how);
    this.report();
    this.kick();
  }

  /** Tells onLook about the look in effect when it changed (null while there is no track). */
  private report(): void {
    const look = this.nowPlaying ? this.look : null;
    const key = look ? JSON.stringify(look) : "";
    if (key === this.reported) return;
    this.reported = key;
    this.onLook?.(look);
  }

  private onNowPlaying(np: NowPlaying | null): void {
    if (this.stopped) return;
    // A sample older than the clock's (one that crossed a newer one in flight) changes nothing, so
    // what this controller believes (playing, paused) always matches what its clock does.
    const wall = Date.now();
    const result = this.clock.update(np, wall);
    if (result === "ignored") return;
    const before = this.nowPlaying;
    this.nowPlaying = np;
    // A resync that changes nothing on screen (same song, still playing, the same artwork, within the
    // clock's slew range) needs no frame when the stage draws its words on the compositor: those
    // follow the sample on their own (stage.retime). A stage that paints words itself, or any real
    // change, gets a frame.
    const quiet =
      result === "slew" &&
      this.stage.wakesForWords === false &&
      np !== null &&
      before !== null &&
      np.trackKey === before.trackKey &&
      np.isPlaying === before.isPlaying &&
      np.artwork === before.artwork;
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
    if (np?.trackKey !== before?.trackKey) this.report();
    this.update(!quiet);
    if (quiet) this.retime(wall);
  }

  /**
   * A quiet sample: the stage's song-time motion follows it without a frame (a slew, a jump), unless
   * the stage says a paint is due after all. The wake may come sooner now (a slew ends, the song
   * moved on): the sleeping loop is woken for it.
   */
  private retime(wall: number): void {
    if (!this.animating) return;
    const t = this.clock.position(wall);
    if (this.stage.retime(t, this.clock.rate(wall), this.clock.target(wall))) {
      this.kick();
      return;
    }
    if (this.raf || !this.timer) return;
    const ms = Math.max(0, Math.min(IDLE_SLEEP_MS, this.stage.nextChange(t)) - 4);
    if (now() + ms < this.wakeAt - 1) this.wake(ms);
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

  /**
   * The initial query, in case the `lyrics` event for this track was missed. An `error` reply can just
   * mean the core hasn't registered the track yet, so ask once more before believing it; any event
   * for the track in between wins.
   */
  private async fetchLyrics(trackKey: string, retried = false): Promise<void> {
    try {
      const lyrics = await this.bridge.invoke("get_lyrics", { trackKey });
      if (lyrics.status === "error" && !retried) {
        await new Promise((resolve) => setTimeout(resolve, QUERY_RETRY_MS));
        if (this.stopped || this.nowPlaying?.trackKey !== trackKey || this.lyrics?.trackKey === trackKey) return;
        await this.fetchLyrics(trackKey, true);
        return;
      }
      this.onLyrics(lyrics, true);
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
      // destroyed meanwhile: nothing more for the stage, and no grace timer left behind
      if (this.stopped || current?.trackKey !== key || current.artwork !== artwork) return;
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

  private update(paint = true): void {
    const np = this.nowPlaying;
    // `enabled` is new in contract v3: settings without it (an older core) count as on.
    const on = this.settings.enabled !== false;
    const visible = !this.gate || (np !== null && on && (this.settings.showWhen === "always" || np.isPlaying));
    const changed = visible !== this.visible;
    this.visible = visible;
    this.stage.setVisible(this.visible);
    this.stage.setPaused(!np?.isPlaying);
    if (paint || changed) this.kick();
  }

  private get animating(): boolean {
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    return this.visible && !!this.nowPlaying?.isPlaying && !hidden;
  }

  /**
   * One frame. `time` is when the frame began (its vsync), on performance.now()'s clock. After a busy
   * frame, the next may begin BUSY_FRAME_MS later at the earliest. A frame that began before then is
   * passed over, which marks a display faster than that (fastDisplay); from then on the loop waits on a
   * timer rather than requesting frames and skipping them, so the page doesn't wake at the display's
   * rate. A slower display (up to about 116 Hz) asks for the next frame directly: a timer there would
   * only make each frame hang on timer precision, which Windows coarsens to 8 ms on battery. kick()
   * paints at the next frame regardless (something changed) and checks the display's rate again.
   */
  private readonly tick = (time: number): void => {
    this.raf = 0;
    if (this.stopped) return;
    const start = now();
    // an engine whose timestamp isn't on that clock: count from now
    const frame = time <= start && start - time < 100 ? time : start;
    if (this.paceUntil !== null && frame < this.paceUntil) {
      this.fastDisplay = true;
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    this.paceUntil = null;
    const wall = Date.now();
    const t = this.clock.position(wall);
    const busy = this.stage.render(t, this.clock.rate(wall), this.clock.target(wall));
    if (!this.animating) return;
    if (busy) {
      this.paceUntil = frame + BUSY_FRAME_MS;
      const due = Math.ceil(this.paceUntil - now());
      if (this.fastDisplay && due > 0) this.wake(due);
      else this.raf = requestAnimationFrame(this.tick);
      return;
    }
    const wait = Math.min(this.stage.wakesForWords === false ? IDLE_SLEEP_MS : MAX_SLEEP_MS, this.stage.nextChange(t));
    this.wake(Math.max(0, wait - 4));
  };

  /** Asks for a frame once `ms` have passed (replacing a pending wait). kick() and destroy() cancel it. */
  private wake(ms: number): void {
    this.clearTimer();
    this.wakeAt = now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wakeAt = Infinity;
      this.raf = requestAnimationFrame(this.tick);
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wakeAt = Infinity;
  }
}
