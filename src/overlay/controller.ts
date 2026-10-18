import { DEFAULT_SETTINGS, type Lyrics, type NowPlaying, type Settings } from "../../contract/contract";
import { PlaybackClock } from "../core/clock";
import type { Line } from "../core/lrc";
import { PaletteCache } from "../core/palette";
import { LookKeeper, timingOf, type SongInput, type SongLook, type Timing } from "../core/songlook";
import type { Bridge, Unlisten } from "../bridge/types";
import { cleanOverride, DEFAULT_PICK, pickedOf, withOverride, type LookOverride, type PickedLook } from "./look";
import type { LookChange, LyricStage, StageView } from "./stage";
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
 * Such a loop, woken by its timer, asks for a frame only with an event due within this long (it wakes
 * a little ahead of each); otherwise it follows the clock without one and sleeps on (checkIn).
 */
const DUE_MS = 12;
/**
 * Busy frames (a glide, Lens following the sung word) start at most this often. requestAnimationFrame
 * runs at the display's refresh rate, 120 or 144 times a second on many Windows laptops, and a Lens
 * frame restyles every word of its line. Just over one 120 Hz frame: a display up to 100 Hz still gets
 * every frame, 120 and 144 Hz ones every other (60 and 72 fps), a 240 Hz one every third (80 fps).
 */
const BUSY_FRAME_MS = 8.6;
/** Wait before asking again when the first lyrics query for a track answers `error`. */
const QUERY_RETRY_MS = 1500;
/**
 * A track whose artwork hasn't arrived by now gets the manual colors instead of the last song's, and
 * its look commits without a cover (SPEC §4.6).
 */
export const ARTWORK_GRACE_MS = 1500;
/**
 * Lyrics wait for the song's cover (so its look commits once, with it) only while no line is sung
 * within this long: they're never held back from a line about to be sung (SPEC §4.6)...
 */
export const COMMIT_LEAD_MS = 600;
/**
 * ...except by a cover decode already under way, which takes a few ms: lyrics wait for it this long
 * at most, from the decode's start. A window opened mid-song (the settings preview) asks for the
 * lyrics and decodes the cover at the same time; without this wait it would commit a look the cover
 * then refines at the next line change.
 */
export const DECODE_WAIT_MS = 100;
/** Committed looks kept per trackKey (LookMemory), so a song played again looks the same at once. */
export const LOOK_MEMORY = 32;

const now = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

type LyricsView = Extract<StageView, { kind: "lyrics" }>;

/** What a song without lyrics (yet) gives the look picker. */
const NO_LYRICS: { lines: readonly Line[]; timing: Timing } = { lines: [], timing: "none" };

/** Ms of song time from `t` until a lyric line is being sung: 0 while one is, Infinity after the last. */
export function untilSung(lines: readonly Line[], t: number): number {
  for (const line of lines) {
    if (line.words.length === 0 || line.end <= t) continue;
    return Math.max(0, line.start - t);
  }
  return Infinity;
}

/**
 * The looks songs were committed with (SPEC §4.6), most recently used last, LOOK_MEMORY at most: a
 * song played again in the same session gets the same look at once. One per controller unless the
 * same one is handed to several (ControllerOptions.looks).
 */
export class LookMemory {
  private readonly looks = new Map<string, SongLook>();
  private readonly limit: number;

  constructor(limit = LOOK_MEMORY) {
    this.limit = limit;
  }

  /** The look the song was committed with, if it is remembered (which counts as a use). */
  get(trackKey: string): SongLook | null {
    const look = this.looks.get(trackKey);
    if (!look) return null;
    this.looks.delete(trackKey);
    this.looks.set(trackKey, look);
    return look;
  }

  set(trackKey: string, look: SongLook): void {
    this.looks.delete(trackKey);
    this.looks.set(trackKey, look);
    for (const oldest of this.looks.keys()) {
      if (this.looks.size <= this.limit) break;
      this.looks.delete(oldest);
    }
  }

  get size(): number {
    return this.looks.size;
  }
}

export interface ControllerOptions {
  /**
   * Hide the stage and stop drawing when the lyrics are turned off (`enabled`) or `showWhen` says so
   * (the overlay). The settings preview leaves it off, so it keeps playing while the user customizes.
   */
  gate?: boolean;
  /** Take settings from the bridge (default) or only from `setSettings` (a preview showing unsaved values). */
  followSettings?: boolean;
  palettes?: PaletteCache;
  /** The looks songs were committed with, kept across tracks. Default: this controller's own. */
  looks?: LookMemory;
  /**
   * Hears the song's look whenever it changes (SPEC §4.6): the LookKeeper's SongLook itself, with the
   * traits and reason the "Picked for this song" card shows. A look whose traits include "no lyrics"
   * is provisional: it covers loading, not found and instrumental, until lyrics commit the song's
   * look. Under a QA override (forceLook) it is a copy with the forced parts in place, as the stage
   * draws it. Null while there is no track.
   */
  onLook?: (look: SongLook | null) => void;
}

/**
 * Drives a stage from a bridge: playback clock, lyrics, album colors, the song's look, visibility,
 * and the frame loop. The loop runs only while a track is playing and the stage is visible; between
 * the stage's changes it sleeps instead of drawing identical frames, and frames that move (a glide,
 * the Lens fisheye) come at most every BUSY_FRAME_MS, however fast the display refreshes. A player
 * sample that changes nothing on screen reaches a compositor-drawn stage without a frame
 * (stage.retime).
 *
 * The song's look (SPEC §4.6) comes from a LookKeeper, one per track, offered everything known about
 * the song as it arrives: the track (a provisional look, while only a state shows), its lyrics and
 * its cover. The first look with lyrics is committed when the cover's fate is known, when a line is
 * about to be sung, or ARTWORK_GRACE_MS into the track, whichever comes first; until then the stage
 * keeps showing "loading". A better look that comes after (late artwork, plain lyrics upgraded to
 * synced ones) crossfades in once, at the stage's next safe point. Committed looks are remembered
 * (LookMemory), so a song played again looks the same at once. Everything is deterministic: every
 * window that plays the same song from the same bridge data, the settings preview included, gives it
 * the same look.
 */
export class OverlayController {
  readonly clock = new PlaybackClock();
  private readonly bridge: Bridge;
  private readonly stage: LyricStage;
  private readonly gate: boolean;
  private readonly followSettings: boolean;
  private readonly palettes: PaletteCache;
  private readonly memory: LookMemory;
  private readonly onLook: ((look: SongLook | null) => void) | undefined;
  private settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private nowPlaying: NowPlaying | null = null;
  private lyrics: Lyrics | null = null;
  /** parts of the look forced for QA (`?look=`, `--look`, the console) */
  private override: LookOverride | null = null;
  /** the look last reported through onLook, as a key ("" for null) */
  private reported = "";
  // ---- the song's look (SPEC §4.6), reset on every track change ----
  /** the playing song's keeper; a fresh one per track */
  private keeper = new LookKeeper();
  /** the playing song's look: its keeper's, or the one it was committed with before; null without a track */
  private song: SongLook | null = null;
  /** the song's look has lyrics behind it: committed, or remembered */
  private committed = false;
  /** remembered from an earlier play: final, so the keeper sits this play out */
  private replay = false;
  /** what the song's lyrics give the picker: the stage's lines and how they're timed */
  private input = NO_LYRICS;
  /** performance.now() at the track change, which ARTWORK_GRACE_MS counts from */
  private trackStart = 0;
  /** the cover's fate is known: decoded, unreadable, or missing for ARTWORK_GRACE_MS */
  private coverKnown = false;
  /** performance.now() the cover decode under way began; null with none */
  private decodingSince: number | null = null;
  /** lyrics that came before the song's look could commit; shown once it can */
  private held: LyricsView | null = null;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly offSafePoint: (() => void) | null;
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
    this.memory = options.looks ?? new LookMemory();
    this.onLook = options.onLook;
    // Listens itself, so a stage built without StageOptions.onSafePoint still refines a song's look.
    this.offSafePoint = typeof stage.addSafePointListener === "function" ? stage.addSafePointListener(() => this.safePoint()) : null;
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

  /** The look the stage draws with: the song's (DEFAULT_PICK without a track) with any forced parts. */
  get look(): PickedLook {
    return pickedOf(withOverride(this.song ?? DEFAULT_PICK, this.override));
  }

  /**
   * The playing song's look as its keeper picked it (no forced parts): provisional until its lyrics
   * commit it (traits include "no lyrics"). Null without a track.
   */
  get songLook(): SongLook | null {
    return this.song;
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
    this.clock.setOffsets(settings);
    this.stage.setSettings(settings);
    this.update();
    // a sync offset moves the song under the clock: a line may now be about to be sung
    if (this.held) this.considerHeld();
  }

  /**
   * Forces parts of the look for every song on this page (QA: `?look=`, `--look`, the console):
   * the style, a bundled face (at its own weight), Arc's curve (-100..100). Null forces nothing. It
   * outlasts track changes; whatever isn't forced stays the song's.
   */
  forceLook(override: LookOverride | null): void {
    this.override = cleanOverride(override);
    this.apply("now");
  }

  /**
   * The stage reached a safe point (it calls this itself, see addSafePointListener): a refinement of
   * the song's look waiting for one crossfades in now. At most one per song (the keeper's rule).
   */
  safePoint(): void {
    if (this.stopped || !this.keeper.waiting) return;
    if (this.settle()) this.apply("crossfade");
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
    this.clearCommitTimer();
    if (this.artworkTimer) clearTimeout(this.artworkTimer);
    this.offSafePoint?.();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
  }

  /** Draws with the look in effect from now on, and says so. */
  private apply(how: LookChange): void {
    this.stage.setPickedLook(this.look, how);
    this.report();
    this.kick();
  }

  /**
   * Tells onLook about the song's look when it changed, or the track did (null while there is none):
   * the keeper's SongLook itself, or under an override a copy with the forced parts.
   */
  private report(): void {
    const np = this.nowPlaying;
    const song = np ? this.song : null;
    const look = song && this.override ? { ...song, ...this.look } : song;
    const key = np && look ? `${np.trackKey}\n${JSON.stringify(look)}` : "";
    if (key === this.reported) return;
    this.reported = key;
    this.onLook?.(look);
  }

  // ---------- the song's look (SPEC §4.6) ----------

  /** A new track: a fresh keeper, and the look the song was committed with before, if any. */
  private beginTrack(np: NowPlaying): void {
    this.clearCommitTimer();
    this.keeper = new LookKeeper();
    this.held = null;
    this.input = NO_LYRICS;
    this.trackStart = now();
    this.coverKnown = false;
    this.decodingSince = null;
    this.song = this.memory.get(np.trackKey);
    this.replay = this.song !== null;
    this.committed = this.replay;
  }

  /** No track: no look. */
  private endTrack(): void {
    this.clearCommitTimer();
    this.keeper = new LookKeeper();
    this.held = null;
    this.input = NO_LYRICS;
    this.song = null;
    this.replay = false;
    this.committed = false;
  }

  /** Everything known about the playing song, for its keeper. */
  private songInput(np: NowPlaying): SongInput {
    return { track: np, lines: this.input.lines, timing: this.input.timing, cover: this.palettes.cover(np.trackKey) };
  }

  /** Brings a refinement waiting for a safe point into the song's look (the caller draws it). True when there was one. */
  private settle(): boolean {
    const np = this.nowPlaying;
    const next = np ? this.keeper.settle() : null;
    if (!np || !next) return false;
    this.song = next;
    this.memory.set(np.trackKey, next);
    return true;
  }

  /** A refinement that came while the stage is at a safe point crossfades in at once; otherwise it waits for one. */
  private settleIfSafe(): void {
    if (!this.keeper.waiting || !this.stage.atSafePoint(this.clock.position(Date.now()))) return;
    if (this.settle()) this.apply("crossfade");
  }

  /** The cover's fate is known (decoded, unreadable, or missing): the song's look can count on it. */
  private coverSettled(np: NowPlaying): void {
    this.coverKnown = true;
    this.decodingSince = null;
    if (this.replay) return;
    if (this.held) {
      this.considerHeld();
      return;
    }
    const look = this.keeper.offer(this.songInput(np));
    if (this.committed) {
      // committed: a better look waits for a safe point (the keeper's), unless this is one
      this.settleIfSafe();
    } else if (JSON.stringify(look) !== JSON.stringify(this.song)) {
      // provisional (only a state shows): replaced freely. A cover known to be missing tells nothing
      // new, and the same look picked again keeps the object onLook already has.
      this.song = look;
      this.apply("now");
    }
  }

  /**
   * Shows a view of the song's lyrics. A state (loading, not found, instrumental, error) shows at
   * once, in the look in effect. The first lyrics wait until the song's look can commit
   * (considerHeld). Later lyrics (plain upgraded to synced) come in a new scene, a safe point for the
   * refinement they may bring.
   */
  private showView(np: NowPlaying, view: StageView): void {
    if (view.kind === "lyrics") {
      this.input = { lines: view.timeline.lines, timing: timingOf(this.lyrics, view.timeline) };
      if (!this.committed) {
        this.held = view;
        this.considerHeld();
        return;
      }
      if (!this.replay) this.keeper.offer(this.songInput(np));
    } else {
      // a later answer replaces lyrics still held back
      this.held = null;
      this.clearCommitTimer();
    }
    // the stage brings a new scene in (the old one fades out first): a safe point
    if (this.keeper.waiting) this.settle();
    this.stage.show(view, np.trackKey, this.look);
    this.report();
    this.kick();
  }

  /** Commits the song's look with the lyrics held back, and shows them in it, as soon as it may; else checks again when it might. */
  private considerHeld(): void {
    const np = this.nowPlaying;
    const view = this.held;
    if (!np || !view || this.stopped) return;
    this.clearCommitTimer();
    const wait = this.commitWait(view.timeline.lines);
    if (wait > 0) {
      this.commitTimer = setTimeout(() => {
        this.commitTimer = null;
        this.considerHeld();
      }, Math.max(1, Math.ceil(wait)));
      return;
    }
    this.held = null;
    this.committed = true;
    this.song = this.keeper.offer(this.songInput(np));
    this.memory.set(np.trackKey, this.song);
    this.stage.show(view, np.trackKey, this.look);
    this.report();
    this.kick();
  }

  /**
   * 0 when the song's look may commit (SPEC §4.6): its cover's fate is known, ARTWORK_GRACE_MS have
   * passed since the track changed, or a line is being sung or starts within COMMIT_LEAD_MS (then only
   * a cover decode under way for less than DECODE_WAIT_MS is waited for). Otherwise how long until one
   * of these may hold, ms (the cover may come sooner).
   */
  private commitWait(lines: readonly Line[]): number {
    const key = this.nowPlaying?.trackKey;
    if (this.coverKnown || (key !== undefined && this.palettes.cover(key) !== null)) return 0;
    const grace = this.trackStart + ARTWORK_GRACE_MS - now();
    if (grace <= 0) return 0;
    const sung = untilSung(lines, this.clock.position(Date.now()));
    if (sung <= COMMIT_LEAD_MS) return this.decodingSince === null ? 0 : Math.max(0, Math.min(grace, this.decodingSince + DECODE_WAIT_MS - now()));
    return Math.min(grace, this.clock.isPlaying ? sung - COMMIT_LEAD_MS : Infinity);
  }

  private clearCommitTimer(): void {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = null;
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
      this.endTrack();
      this.stage.show({ kind: "none" }, "", this.look);
    } else {
      const fresh = np.trackKey !== before?.trackKey;
      if (fresh) {
        this.lyrics = null;
        this.beginTrack(np);
      }
      // Once per track and picture. Resyncs (every second while playing) repeat both, and must not
      // keep restarting the grace period of a track that has no artwork.
      if (np.trackKey !== before?.trackKey || np.artwork !== before.artwork) this.updatePalette(np);
      if (fresh) {
        // a provisional look until lyrics commit one (a remembered song has its own already), with
        // the cover when this song's has been decoded before
        if (!this.replay) this.song = this.keeper.offer(this.songInput(np));
        this.stage.show({ kind: "loading" }, np.trackKey, this.look);
        void this.fetchLyrics(np.trackKey);
      } else if (this.held) {
        // a seek, a pause or a resume can bring a line closer, or put it off
        this.considerHeld();
      }
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
    if (now() + ms < this.wakeAt - 1) this.wake(ms, true);
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
    this.showView(np, viewFor(lyrics, np.durationMs));
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
   * for ARTWORK_GRACE_MS after the track starts if it has none, then uses the manual colors. The same
   * decode gives the song's look its cover (PaletteCache.cover): known once the decode is done, or
   * known to be missing once the grace is over.
   */
  private updatePalette(np: NowPlaying): void {
    const { trackKey: key, artwork } = np;
    if (this.artworkTimer) clearTimeout(this.artworkTimer);
    this.artworkTimer = null;
    this.decodingSince = artwork === null ? null : now();
    void this.palettes.get(key, artwork).then((palette) => {
      const current = this.nowPlaying;
      // destroyed meanwhile: nothing more for the stage, and no grace timer left behind
      if (this.stopped || current?.trackKey !== key || current.artwork !== artwork) return;
      if (palette || artwork !== null) {
        this.stage.setPalette(palette);
        this.coverSettled(current);
        this.kick();
        return;
      }
      this.artworkTimer = setTimeout(() => {
        this.artworkTimer = null;
        const still = this.nowPlaying;
        if (this.stopped || still?.trackKey !== key || still.artwork !== null) return;
        this.stage.setPalette(null);
        this.coverSettled(still);
        this.kick();
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
    // the paint itself asked for the next frame (a look refinement at a safe point): that one's due
    if (this.raf || this.stopped) return;
    if (!this.animating) return;
    if (busy) {
      this.paceUntil = frame + BUSY_FRAME_MS;
      const due = Math.ceil(this.paceUntil - now());
      if (this.fastDisplay && due > 0) this.wake(due);
      else this.raf = requestAnimationFrame(this.tick);
      return;
    }
    const compositor = this.stage.wakesForWords === false;
    const wait = Math.min(compositor ? IDLE_SLEEP_MS : MAX_SLEEP_MS, this.stage.nextChange(t));
    this.wake(Math.max(0, wait - 4), compositor);
  };

  /**
   * Asks for a frame once `ms` have passed (replacing a pending wait). kick() and destroy() cancel it.
   * A `check`ed wait (a compositor-run stage asleep) first checks in, and may sleep on instead.
   */
  private wake(ms: number, check = false): void {
    this.clearTimer();
    this.wakeAt = now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wakeAt = Infinity;
      if (check && this.checkIn()) return;
      this.raf = requestAnimationFrame(this.tick);
    }, ms);
  }

  /**
   * A compositor-run stage's loop, woken from its sleep (the IDLE_SLEEP_MS check-in, or the wait for an
   * event that a slew has since moved): the stage follows the clock without a frame (stage.retime), and
   * the loop sleeps on unless something is due within DUE_MS. A frame here would restyle every
   * animation in flight and change nothing. True when it went back to sleep.
   */
  private checkIn(): boolean {
    if (this.stopped || !this.animating || this.stage.wakesForWords !== false) return false;
    const wall = Date.now();
    const t = this.clock.position(wall);
    if (this.stage.retime(t, this.clock.rate(wall), this.clock.target(wall))) return false;
    const next = this.stage.nextChange(t);
    if (next <= DUE_MS) return false;
    this.wake(Math.max(0, Math.min(IDLE_SLEEP_MS, next) - 4), true);
    return true;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wakeAt = Infinity;
  }
}
