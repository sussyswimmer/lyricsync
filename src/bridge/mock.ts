import {
  DEFAULT_SETTINGS,
  type Lyrics,
  type LyricsStatus,
  type MediaProblem,
  type MediaStatus,
  type NowPlaying,
  type Settings,
  type ShortcutAction,
  type Shortcuts,
  type ShortcutsStatus,
} from "../../contract/contract";
import { detectPlatform, loadKeyLayout, mergeShortcuts, normalizeBinding, recordKey, SHORTCUT_ACTIONS, type KeyLayout } from "../core/accelerator";
import { nudgedAfter, songOffsetMs } from "../core/sync";
import neonMonsoon from "../../tests/fixtures/neon-monsoon.lrc?raw";
import paperLanterns from "../../tests/fixtures/paper-lanterns.lrc?raw";
import glassHarbor from "../../tests/fixtures/glass-harbor.lrc?raw";
import ledgerLines from "../../tests/fixtures/demo-ledger-lines.lrc?raw";
import strobeHearts from "../../tests/fixtures/demo-strobe-hearts.lrc?raw";
import glacierNocturne from "../../tests/fixtures/demo-glacier-nocturne.lrc?raw";
import { demoCover } from "./covers";
import type { ArgsOf, Bridge, Command, Commands, Event, Events, ResultOf, Unlisten } from "./types";

/** A fake track. All lyrics are original placeholder text written for Undertone. */
export interface MockTrack {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  /** demo cover index, or null for a track without artwork */
  cover: number | null;
  status: Exclude<LyricsStatus, "loading" | "error">;
  synced: string | null;
  plain: string | null;
}

const LETTERS = [
  "Folded letters in a drawer of summers",
  "Every one begins with your name",
  "I wrote the weather and the price of mangoes",
  "Never once the thing I meant to say",
  "Maybe the ink remembers what I didn't",
].join("\n");

/**
 * Visual QA for scripts and line shapes (C8): Japanese, Chinese with per-character tags, Korean,
 * Vietnamese with stacked diacritics (lower and upper case), a line of about 120 characters, a line
 * of 20 words, a one-word line, and right-to-left lines with punctuation. Original placeholder text.
 */
const SCRIPT_SAMPLER = [
  "[ti:Script Sampler]",
  "[ar:Demo Artist]",
  "[by:Original placeholder lyrics written for Undertone]",
  "[00:01.00]夜明けの駅で、紙の鳥が待っている",
  "[00:05.00]<00:05.00>灯<00:05.40>笼<00:05.80>漂<00:06.20>过<00:06.60>安<00:07.00>静<00:07.40>的<00:07.80>河<00:08.20>面<00:08.90>",
  "[00:09.50]작은 불빛이 창문을 두드려요",
  "[00:13.00]Đèn phố nhỏ vẫn đợi người về, ĐẤT TRỜI rộng như những giấc mơ",
  "[00:18.00]This placeholder line keeps on going well past the point where a lyric would stop, so every style must decide how it fits",
  "[00:25.00]We counted every little window on the hill and every one of them was humming softly back at us tonight",
  "[00:31.00]Breathe",
  "[00:33.00]الضوء يعود إلى البيت، أخيرًا!",
  "[00:36.50]האור חוזר הביתה, נכון?",
  "[00:40.00]",
].join("\n");

const track = (
  title: string,
  durationMs: number,
  cover: number | null,
  status: MockTrack["status"],
  lyrics: { synced?: string; plain?: string } = {},
): MockTrack => ({
  title,
  artist: "Demo Artist",
  album: "Undertone Demo",
  durationMs,
  cover,
  status,
  synced: lyrics.synced ?? null,
  plain: lyrics.plain ?? null,
});

export const MOCK_TRACKS: readonly MockTrack[] = [
  track("Neon Monsoon", 35_000, 0, "found", { synced: neonMonsoon }),
  track("Paper Lanterns", 24_000, 1, "found", { synced: paperLanterns }),
  track("Letters Never Sent", 30_000, 2, "plain-only", { plain: LETTERS }),
  track("Ultraviolet Static", 20_000, 2, "not-found"),
  track("Tidal Interlude", 18_000, null, "instrumental"),
  // Not a lyrics state: visual QA for scripts and line shapes. Cycle every font over it (?track=5).
  track("Script Sampler", 42_000, 0, "found", { synced: SCRIPT_SAMPLER }),
  // The motion demo (?track=6): an intro and a mid-song break long enough for the interlude dots,
  // syllable-timed enhanced LRC, and held line endings that light letter by letter.
  track("Glass Harbor", 38_000, 2, "found", { synced: glassHarbor }),
  // The look demos (?track=7–9): three songs Undertone picks three different looks for, from how
  // they are sung and what their covers look like (src/core/songlook.ts; tests/demo-looks.test.ts).
  // A fast, dense verse under a black-and-white cover: Stack, in Bricolage.
  track("Ledger Lines", 76_000, 3, "found", { synced: ledgerLines }),
  // Short shouted hooks, a club edit and a neon-on-black cover: Poster, in Unbounded capitals.
  track("Strobe Hearts (Club Mix)", 66_000, 4, "found", { synced: strobeHearts }),
  // Sparse, slow lines with long instrumental gaps under a cold, dark cover: Drift, in Instrument Serif.
  track("Glacier Nocturne", 118_000, 5, "found", { synced: glacierNocturne }),
];

/** Built exactly as SPEC defines it. */
export function trackKeyOf(t: Pick<MockTrack, "artist" | "title" | "album" | "durationMs">): string {
  return `${t.artist}|${t.title}|${t.album}|${Math.round(t.durationMs / 1000)}`.toLowerCase();
}

/** Lyrics as the Rust service would report them once loaded. */
export function lyricsOf(t: MockTrack): Lyrics {
  return { trackKey: trackKeyOf(t), status: t.status, synced: t.synced, plain: t.plain, source: "cache" };
}

export interface PlayerState {
  track: number;
  positionMs: number;
  sampledAt: number;
  isPlaying: boolean;
}

/** How long the fake lyrics lookup and artwork fetch take, like the real ones. */
const LOOKUP_MS = 400;
const NOT_FOUND_MS = 900;
const ARTWORK_MS = 250;
const RESYNC_MS = 1000;
export const SEEK_STEP_MS = 5000;

type Emit = <E extends Event>(event: E, payload: Events[E]) => void;

/**
 * A fake player that emits `now-playing` and `lyrics` the way the Rust core does: a sample on every
 * change plus a resync every second while playing, lyrics `loading` then the result, and artwork a
 * moment after the track. Plays the demo tracks in order and moves on at the end of each.
 */
export class MockPlayer {
  private state: PlayerState;
  private readonly emit: Emit;
  private readonly onChange: (state: PlayerState) => void;
  private readonly now: () => number;
  private loaded = false;
  private artwork = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private resync: ReturnType<typeof setInterval> | null = null;
  private ended: ReturnType<typeof setTimeout> | null = null;

  constructor(emit: Emit, initial: PlayerState, onChange: (state: PlayerState) => void = () => {}, now = Date.now) {
    this.emit = emit;
    this.onChange = onChange;
    this.now = now;
    this.state = normalize(initial, now());
    this.startTrack();
  }

  get current(): MockTrack {
    return MOCK_TRACKS[this.state.track] ?? (MOCK_TRACKS[0] as MockTrack);
  }

  get snapshot(): PlayerState {
    return { ...this.state };
  }

  position(now = this.now()): number {
    const { positionMs, sampledAt, isPlaying } = this.state;
    return Math.min(this.current.durationMs, positionMs + (isPlaying ? Math.max(0, now - sampledAt) : 0));
  }

  nowPlaying(now = this.now()): NowPlaying {
    const t = this.current;
    return {
      source: "spotify",
      trackKey: trackKeyOf(t),
      title: t.title,
      artist: t.artist,
      album: t.album,
      durationMs: t.durationMs,
      positionMs: this.position(now),
      sampledAt: now,
      isPlaying: this.state.isPlaying,
      artwork: this.artwork && t.cover !== null ? demoCover(t.cover) : null,
    };
  }

  lyrics(trackKey: string): Lyrics {
    const t = MOCK_TRACKS.find((x) => trackKeyOf(x) === trackKey);
    if (!t) return { trackKey, status: "not-found", synced: null, plain: null, source: "lrclib" };
    if (t === this.current && !this.loaded) return { trackKey, status: "loading", synced: null, plain: null, source: "lrclib" };
    return lyricsOf(t);
  }

  toggle(): void {
    this.set({ isPlaying: !this.state.isPlaying });
  }

  seek(ms: number): void {
    this.set({ positionMs: Math.max(0, Math.min(this.current.durationMs, ms)) });
  }

  seekBy(deltaMs: number): void {
    this.seek(this.position() + deltaMs);
  }

  next(step = 1): void {
    this.select(this.state.track + step);
  }

  select(index: number, positionMs = 0): void {
    this.set({ track: wrap(index), positionMs });
  }

  /** Re-fires the fake lookup for the current track: `loading`, then the result. */
  refetch(): void {
    this.loaded = false;
    this.lookup();
  }

  /** Adopts state from another tab without echoing it back. */
  apply(next: PlayerState): void {
    const same = (Object.keys(next) as (keyof PlayerState)[]).every((k) => next[k] === this.state[k]);
    if (!same) this.commit(next, false);
  }

  dispose(): void {
    this.clearTimers();
    if (this.resync) clearInterval(this.resync);
    this.resync = null;
  }

  private set(patch: Partial<PlayerState>): void {
    const now = this.now();
    this.commit({ ...this.state, positionMs: this.position(now), ...patch, sampledAt: now }, true);
  }

  private commit(proposed: PlayerState, broadcast: boolean): void {
    const next = normalize(proposed, this.now());
    const trackChanged = next.track !== this.state.track;
    this.state = next;
    if (broadcast) this.onChange(this.snapshot);
    if (trackChanged) this.startTrack();
    else this.schedule();
    this.emit("now-playing", this.nowPlaying());
  }

  private startTrack(): void {
    this.clearTimers();
    this.loaded = false;
    this.artwork = false;
    this.lookup();
    if (this.current.cover !== null) {
      this.later(ARTWORK_MS, () => {
        this.artwork = true;
        this.emit("now-playing", this.nowPlaying());
      });
    }
    this.schedule();
  }

  private lookup(): void {
    const key = trackKeyOf(this.current);
    this.emit("lyrics", this.lyrics(key));
    this.later(this.current.status === "not-found" ? NOT_FOUND_MS : LOOKUP_MS, () => {
      this.loaded = true;
      this.emit("lyrics", this.lyrics(key));
    });
  }

  /** Resync every second while playing; move to the next track when this one ends. */
  private schedule(): void {
    if (this.resync) clearInterval(this.resync);
    this.resync = null;
    if (this.ended) clearTimeout(this.ended);
    this.ended = null;
    if (!this.state.isPlaying) return;
    this.resync = setInterval(() => this.emit("now-playing", this.nowPlaying()), RESYNC_MS);
    const left = this.current.durationMs - this.position();
    // Computed from the shared state alone, so every tab advances to the same place at the same time.
    const endsAt = this.state.sampledAt + (this.current.durationMs - this.state.positionMs);
    this.ended = setTimeout(() => {
      this.commit({ track: wrap(this.state.track + 1), positionMs: 0, sampledAt: endsAt, isPlaying: true }, true);
    }, Math.max(0, left));
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.ended) clearTimeout(this.ended);
    this.ended = null;
  }
}

function wrap(index: number): number {
  const n = MOCK_TRACKS.length;
  return ((Math.trunc(Number.isFinite(index) ? index : 0) % n) + n) % n;
}

/**
 * Keeps a player state inside its track. A playing state already past the end (a tab reopened
 * later, a seek or ?t= beyond the end) moves on to the next track once, instead of finishing one
 * track per timer until it catches up with the clock.
 */
function normalize(s: PlayerState, now: number): PlayerState {
  const track = wrap(s.track);
  const duration = MOCK_TRACKS[track]?.durationMs ?? 0;
  const positionMs = Math.max(0, Math.min(duration, Number.isFinite(s.positionMs) ? s.positionMs : 0));
  const sampledAt = Number.isFinite(s.sampledAt) ? s.sampledAt : now;
  if (s.isPlaying && positionMs + Math.max(0, now - sampledAt) >= duration) {
    return { track: wrap(track + 1), positionMs: 0, sampledAt: now, isPlaying: true };
  }
  return { track, positionMs, sampledAt, isPlaying: s.isPlaying };
}

/** Per-song offsets share the global offset's range. */
const OFFSET_LIMIT_MS = 2000;
const FONT_FAMILY_MAX_CHARS = 64;
const MODES = ["arc", "lens", "drift", "stack"] as const satisfies readonly Settings["mode"][];
const SHOW_WHEN = ["playing", "always"] as const satisfies readonly Settings["showWhen"][];
const DISPLAYS = ["primary", "all"] as const satisfies readonly Settings["displays"][];
const MEDIA_PROBLEMS = ["automation-denied", "no-player"] as const satisfies readonly MediaProblem[];
const COLOR_KEYS = ["lyric", "highlight", "dim"] as const satisfies readonly (keyof Settings["colors"])[];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// Each returns the valid value, or undefined so the caller keeps the current one.
const clamp = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined;
const hex = (v: unknown): string | undefined => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined);
/** Not blank, at most 64 characters, both as Rust counts them: Unicode White_Space, code points. */
const family = (v: unknown): string | undefined =>
  typeof v === "string" && !/^\p{White_Space}*$/u.test(v) && [...v].length <= FONT_FAMILY_MAX_CHARS ? v : undefined;
const oneOf = <T extends string>(v: unknown, options: readonly T[]): T | undefined => options.find((o) => o === v);
/** Each entry clamped to ±2000 ms; zero and invalid entries dropped. */
const offsetsOf = (v: unknown): Record<string, number> | undefined => {
  if (!isObject(v)) return undefined;
  const entries = Object.entries(v).flatMap(([key, ms]): [string, number][] => {
    const clamped = clamp(ms, -OFFSET_LIMIT_MS, OFFSET_LIMIT_MS);
    // 0 is a song's own offset since contract v7 (-0 reads as 0)
    return clamped === undefined ? [] : [[key, clamped + 0]];
  });
  return Object.fromEntries(entries);
};

/** `nudgedTracks`: strings only, each once (its last place), the newest NUDGED_TRACKS_MAX. */
const nudgedOf = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  return v.filter((key): key is string => typeof key === "string").reduce<string[]>((list, key) => nudgedAfter(list, key), []);
};

/**
 * What the Rust store does with `update_settings` (X4, `settings::merge_patch`): a shallow merge
 * validated field by field. Unknown keys are dropped, numbers are clamped to the SPEC ranges, and a
 * value of the wrong type or outside an enum keeps the current one. A partial `colors`, `font` or
 * `shortcuts` object changes only the keys it has; a shortcut that isn't usable or that another
 * action has keeps its current binding (`mergeShortcuts`); `trackOffsetsMs` and `nudgedTracks` replace the whole map and list;
 * `version` is ignored.
 */
export function mergeSettings(current: Settings, patch: unknown): Settings {
  const next = structuredClone(current);
  // The settings schema, not the contract: contract v2 left it at 1.
  next.version = DEFAULT_SETTINGS.version;
  if (!isObject(patch)) return next;
  const p = patch;
  next.mode = oneOf(p.mode, MODES) ?? next.mode;
  if (typeof p.autoColor === "boolean") next.autoColor = p.autoColor;
  const colors = p.colors;
  if (isObject(colors)) for (const key of COLOR_KEYS) next.colors[key] = hex(colors[key]) ?? next.colors[key];
  const font = p.font;
  if (isObject(font)) {
    next.font.family = family(font.family) ?? next.font.family;
    next.font.weight = clamp(font.weight, 100, 900) ?? next.font.weight;
  }
  next.size = clamp(p.size, 22, 140) ?? next.size;
  next.curve = clamp(p.curve, -100, 100) ?? next.curve;
  next.yPos = clamp(p.yPos, 0, 100) ?? next.yPos;
  next.glow = clamp(p.glow, 0, 100) ?? next.glow;
  next.opacity = clamp(p.opacity, 20, 100) ?? next.opacity;
  next.showWhen = oneOf(p.showWhen, SHOW_WHEN) ?? next.showWhen;
  next.displays = oneOf(p.displays, DISPLAYS) ?? next.displays;
  next.globalOffsetMs = clamp(p.globalOffsetMs, -OFFSET_LIMIT_MS, OFFSET_LIMIT_MS) ?? next.globalOffsetMs;
  next.trackOffsetsMs = offsetsOf(p.trackOffsetsMs) ?? next.trackOffsetsMs;
  next.nudgedTracks = nudgedOf(p.nudgedTracks) ?? next.nudgedTracks;
  if (typeof p.enabled === "boolean") next.enabled = p.enabled;
  if (typeof p.launchAtLogin === "boolean") next.launchAtLogin = p.launchAtLogin;
  next.shortcuts = mergeShortcuts(next.shortcuts, p.shortcuts);
  next.effects = clamp(p.effects, 0, 100) ?? next.effects;
  if (typeof p.effectsMode === "boolean") next.effectsMode = p.effectsMode;
  if (typeof p.graphics === "boolean") next.graphics = p.graphics;
  return next;
}

/**
 * Stored settings of any shape made valid by the same rules, starting from the defaults
 * (`settings::migrate`). Saved without `graphics` (before contract v8), they keep the pictures and
 * splashes as their Effects mode had them.
 */
export function migrateSettings(stored: unknown): Settings {
  const settings = mergeSettings(DEFAULT_SETTINGS, stored);
  if (!isObject(stored) || !("graphics" in stored)) settings.graphics = settings.effectsMode;
  return settings;
}

/**
 * What the core reports for each shortcut after registering them (contract v3): "off" when shortcuts
 * are off or the action has none, "invalid" when the binding doesn't parse, "unavailable" when
 * another app holds the combination (here: one of `taken`), else "ok".
 */
export function shortcutsStatusOf(shortcuts: Shortcuts, taken: ReadonlySet<string> = new Set()): ShortcutsStatus {
  const state = (action: ShortcutAction): ShortcutsStatus[ShortcutAction] => {
    const binding = shortcuts[action];
    if (!shortcuts.enabled || binding === "") return "off";
    const normalized = normalizeBinding(binding);
    if (!normalized) return "invalid";
    return taken.has(normalized) ? "unavailable" : "ok";
  };
  return { toggleLyrics: state("toggleLyrics"), nudgeEarlier: state("nudgeEarlier"), nudgeLater: state("nudgeLater") };
}

/** How far the nudge shortcuts move the current song, as in the core (`shortcuts::SHORTCUT_NUDGE_MS`). */
export const SHORTCUT_NUDGE_MS = 50;

/**
 * `set_track_offset` (`settings::with_track_offset`): the song's own offset, clamped to ±2000 ms (0
 * included), and the song becomes the most recently nudged; `null` drops its own offset and its
 * place among them, so it follows the learned offset again.
 */
export function withTrackOffset(current: Settings, trackKey: string, ms: number | null): Settings {
  const next = structuredClone(current);
  if (ms === null) {
    delete next.trackOffsetsMs[trackKey];
    next.nudgedTracks = next.nudgedTracks.filter((key) => key !== trackKey);
    return next;
  }
  if (!Number.isFinite(ms)) throw new Error("offset must be finite");
  next.trackOffsetsMs[trackKey] = Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, ms)) + 0;
  next.nudgedTracks = nudgedAfter(next.nudgedTracks, trackKey);
  return next;
}

export interface MockOptions {
  /** Share player and settings with other tabs (overlay + settings side by side). Default true. */
  shared?: boolean;
  /**
   * Space play/pause, ←/→ seek ±5 s, N / Shift+N next/previous track, S opens Settings (as the
   * tray's Settings… does), and the global shortcuts (while this page has focus). Default true.
   */
  keys?: boolean;
  /** Persist across reloads. Default: localStorage when available. */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /**
   * `?track=1&t=5200&paused&settings={"effects":80}` set the starting state,
   * `?media=automation-denied|no-player` starts with that media problem,
   * `?shortcutConflict=toggleLyrics,nudgeLater` makes those actions' starting combinations
   * "unavailable", as if another app held them, and `?loginItem=refuse` refuses every Launch at
   * login change, as the core does when the OS won't change the login item. Default: the page URL.
   */
  params?: URLSearchParams;
}

export interface MockBridge extends Bridge {
  readonly player: MockPlayer;
  /**
   * Stands in for a core that can't see the player: with a problem it reports nothing playing and why
   * (`automation-denied` names Spotify), with null the player again. Shared with the other pages.
   */
  setMedia(problem: MediaProblem | null): void;
  /** True between `suspend_shortcuts(true)` and `suspend_shortcuts(false)`. */
  readonly shortcutsSuspended: boolean;
  dispose(): void;
}

const PLAYER_KEY = "undertone.mock.player";
const SETTINGS_KEY = "undertone.mock.settings";
const CHANNEL = "undertone-mock";

type Message =
  | { type: "player"; state: PlayerState }
  | { type: "settings"; settings: Settings }
  | { type: "media"; problem: MediaProblem | null };

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read<T>(storage: MockOptions["storage"], key: string): T | null {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(storage: MockOptions["storage"], key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or blocked: the mock just forgets on reload
  }
}

/** The mock bridge: the full contract surface over a fake player, for `pnpm dev` in a plain browser. */
export function createMockBridge(options: MockOptions = {}): MockBridge {
  const shared = options.shared ?? true;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const params = options.params ?? new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  const handlers: { [E in Event]: Set<(payload: Events[E]) => void> } = {
    "now-playing": new Set(),
    lyrics: new Set(),
    "settings-changed": new Set(),
    "media-status": new Set(),
    "shortcuts-status": new Set(),
  };
  const emit: Emit = (event, payload) => {
    queueMicrotask(() => {
      for (const handler of handlers[event]) handler(payload);
    });
  };
  const channel = shared && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;
  const post = (message: Message): void => channel?.postMessage(message);

  let settings = migrateSettings(read<unknown>(storage, SETTINGS_KEY));
  const override = params.get("settings");
  if (override) {
    try {
      settings = mergeSettings(settings, JSON.parse(override));
    } catch {
      // ignore a malformed ?settings=
    }
  }

  const now = Date.now();
  const saved = read<PlayerState>(storage, PLAYER_KEY);
  const initial: PlayerState = saved ?? { track: 0, positionMs: 0, sampledAt: now, isPlaying: true };
  if (params.has("track") || params.has("t") || params.has("paused")) {
    initial.track = Number(params.get("track") ?? initial.track) || 0;
    initial.positionMs = Number(params.get("t") ?? 0) || 0;
    initial.sampledAt = now;
    initial.isPlaying = !params.has("paused");
  }

  // Like `?settings`, `?media` applies to this page only and isn't saved; a later `setMedia` is shared.
  let problem: MediaProblem | null = oneOf(params.get("media"), MEDIA_PROBLEMS) ?? null;
  // The player keeps time through a media problem, but nothing it plays is reported, as in the real core.
  const fromPlayer: Emit = (event, payload) => {
    if (problem === null) emit(event, payload);
  };

  const player = new MockPlayer(fromPlayer, initial, (state) => {
    write(storage, PLAYER_KEY, state);
    post({ type: "player", state });
  });
  write(storage, PLAYER_KEY, player.snapshot);

  const mediaStatus = (): MediaStatus => {
    if (problem === null) return { source: player.nowPlaying().source, problem: null };
    return { source: problem === "automation-denied" ? "spotify" : null, problem };
  };
  /** `now-playing` first, then `media-status`, in the order the core sends them. */
  const setProblem = (next: MediaProblem | null, broadcast: boolean): void => {
    // Shared even when this page already has it: another page's `?media` may differ. Receivers don't echo.
    if (broadcast) post({ type: "media", problem: next });
    if (next === problem) return;
    const wasReported = problem === null;
    problem = next;
    // One null when the track goes away (the core never repeats it), the track when it comes back.
    if (wasReported !== (problem === null)) emit("now-playing", problem === null ? player.nowPlaying() : null);
    emit("media-status", mediaStatus());
  };

  // Like `?media`, `?shortcutConflict` applies to this page only: the combinations those actions start
  // with are taken by "another app", so they stay unavailable whichever action is given them later.
  const conflicts = (params.get("shortcutConflict") ?? "").split(",").flatMap((name) => SHORTCUT_ACTIONS.filter((a) => a === name.trim()));
  const taken = new Set(conflicts.map((action) => settings.shortcuts[action]).filter((binding) => binding !== ""));
  let shortcutsStatus = shortcutsStatusOf(settings.shortcuts, taken);
  // Suspending changes no status: the core keeps reporting what is registered, so nothing flashes.
  let suspended = false;

  /** Stores already validated settings; saves, shares and broadcasts them only on a real change. */
  const setSettings = (next: Settings, broadcast: boolean): Settings => {
    if (JSON.stringify(next) !== JSON.stringify(settings)) {
      settings = next;
      write(storage, SETTINGS_KEY, settings);
      if (broadcast) post({ type: "settings", settings });
      emit("settings-changed", structuredClone(settings));
      // A registration pass after every change; the status goes out only when it changed.
      const status = shortcutsStatusOf(settings.shortcuts, taken);
      if (JSON.stringify(status) !== JSON.stringify(shortcutsStatus)) {
        shortcutsStatus = status;
        emit("shortcuts-status", { ...status });
      }
    }
    return structuredClone(settings);
  };

  if (channel) {
    channel.onmessage = (e: MessageEvent<Message>) => {
      if (e.data.type === "player") player.apply(e.data.state);
      else if (e.data.type === "settings") setSettings(mergeSettings(settings, e.data.settings), false);
      else setProblem(oneOf(e.data.problem, MEDIA_PROBLEMS) ?? null, false);
    };
  }

  // Like `?media`, `?loginItem=refuse` applies to this page only (and to a Settings page it opens).
  const refuseLoginItem = params.get("loginItem") === "refuse";
  /** The settings window this page opened, and the address it was opened at. */
  let settingsWindow: Window | null = null;
  let settingsHref = "";

  const commands: { [C in Command]: (args: Commands[C]["args"]) => ResultOf<C> } = {
    get_settings: () => structuredClone(settings),
    update_settings: ({ patch }) => {
      const next = mergeSettings(settings, patch);
      if (!refuseLoginItem || next.launchAtLogin === settings.launchAtLogin) return setSettings(next, true);
      // As the core does when the OS refuses the login item (`settings::runtime::modify_with_login_item`):
      // launchAtLogin keeps its value, the rest of the patch applies, every page hears settings-changed
      // even if nothing else changed (so a switch that moved goes back), and the command fails.
      const before = settings;
      setSettings({ ...next, launchAtLogin: settings.launchAtLogin }, true);
      if (settings === before) emit("settings-changed", structuredClone(settings));
      throw new Error("Couldn't change the login item (?loginItem=refuse)");
    },
    get_now_playing: () => (problem === null ? player.nowPlaying() : null),
    get_media_status: () => mediaStatus(),
    get_shortcuts_status: () => ({ ...shortcutsStatus }),
    suspend_shortcuts: ({ suspended: next }) => {
      suspended = next;
    },
    get_lyrics: ({ trackKey }) => player.lyrics(trackKey),
    refetch_lyrics: ({ trackKey }) => {
      if (trackKey === trackKeyOf(player.current)) player.refetch();
    },
    set_track_offset: ({ trackKey, ms }) => setSettings(withTrackOffset(settings, trackKey, ms), true),
    open_settings: () => {
      if (typeof window === "undefined") return;
      const url = new URL("settings.html", window.location.href);
      // Already the settings page: the core shows the window that is open, never a second one.
      if (url.pathname === new URL(window.location.href).pathname) return;
      url.searchParams.set("mock", "");
      // The settings page opened from here starts with this page's media problem and login item refusal.
      if (problem !== null) url.searchParams.set("media", problem);
      if (refuseLoginItem) url.searchParams.set("loginItem", "refuse");
      // Still open at that address: bring it forward, as the core shows the window. Opening it again
      // would reload it (its scroll, a listening recorder and the preview would start over).
      if (settingsWindow && !settingsWindow.closed && settingsHref === url.href) {
        settingsWindow.focus();
        return;
      }
      settingsWindow = window.open(url, "undertone-settings", "width=380,height=640");
      settingsHref = url.href;
    },
    quit: () => {},
  };

  const platform = detectPlatform(typeof navigator === "undefined" ? undefined : navigator);
  const keys = (options.keys ?? true) && typeof window !== "undefined";
  // Windows matches a letter by what it types, as the recorder saves it (`recordKey`).
  let layout: KeyLayout | null = null;
  if (keys && platform === "windows") {
    void loadKeyLayout(navigator).then((l) => {
      layout = l;
    });
  }
  /** The global shortcuts, as far as a page can have them: they work while it has focus. */
  const onShortcut = (e: KeyboardEvent): boolean => {
    if (suspended || !settings.shortcuts.enabled) return false;
    const pressed = recordKey(e, platform, layout);
    if (pressed.kind !== "combo") return false;
    const action = SHORTCUT_ACTIONS.find((a) => settings.shortcuts[a] === pressed.accelerator && shortcutsStatus[a] === "ok");
    if (!action) return false;
    if (action === "toggleLyrics") {
      setSettings(mergeSettings(settings, { enabled: !settings.enabled }), true);
    } else if (problem === null) {
      // Like the core: a nudge needs a song, and moves its offset within the same ±2000 ms.
      const trackKey = trackKeyOf(player.current);
      const step = action === "nudgeEarlier" ? SHORTCUT_NUDGE_MS : -SHORTCUT_NUDGE_MS;
      setSettings(withTrackOffset(settings, trackKey, songOffsetMs(settings, trackKey) + step), true);
    }
    return true;
  };

  const onKey = (e: KeyboardEvent): void => {
    // The Settings key recorder handles its keys first (and suspends the shortcuts while it listens).
    if (e.defaultPrevented) return;
    if (onShortcut(e)) {
      e.preventDefault();
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("input, select, textarea, button, [contenteditable]")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Space") player.toggle();
    else if (e.key === "ArrowLeft") player.seekBy(-SEEK_STEP_MS);
    else if (e.key === "ArrowRight") player.seekBy(SEEK_STEP_MS);
    else if (e.key.toLowerCase() === "n") player.next(e.shiftKey ? -1 : 1);
    // There's no tray in a browser: S stands in for its Settings… item.
    else if (e.key.toLowerCase() === "s") commands.open_settings({});
    else return;
    e.preventDefault();
  };
  if (keys) window.addEventListener("keydown", onKey);

  return {
    kind: "mock",
    player,
    setMedia(next: MediaProblem | null): void {
      setProblem(next, true);
    },
    get shortcutsSuspended(): boolean {
      return suspended;
    },
    invoke<C extends Command>(command: C, ...args: ArgsOf<C>): Promise<ResultOf<C>> {
      const handler = commands[command];
      // A handler that throws rejects, as a failing Tauri command does.
      return new Promise((resolve) => resolve(handler((args[0] ?? {}) as Commands[C]["args"])));
    },
    listen<E extends Event>(event: E, handler: (payload: Events[E]) => void): Promise<Unlisten> {
      handlers[event].add(handler);
      return Promise.resolve(() => {
        handlers[event].delete(handler);
      });
    },
    dispose(): void {
      player.dispose();
      channel?.close();
      if (keys) window.removeEventListener("keydown", onKey);
    },
  };
}
