import { DEFAULT_SETTINGS, type Lyrics, type LyricsStatus, type NowPlaying, type Settings } from "../../contract/contract";
import neonMonsoon from "../../tests/fixtures/neon-monsoon.lrc?raw";
import paperLanterns from "../../tests/fixtures/paper-lanterns.lrc?raw";
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

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  options.find((o) => o === v) ?? fallback;

/** What the Rust settings store will do (X4): clamp to SPEC ranges and drop invalid values. */
export function clampSettings(s: Settings): Settings {
  const d = DEFAULT_SETTINGS;
  const offsets: Record<string, number> = {};
  for (const [key, ms] of Object.entries(s.trackOffsetsMs ?? {})) offsets[key] = clamp(ms, -2000, 2000, 0);
  return {
    version: 1,
    mode: oneOf(s.mode, ["arc", "lens", "drift", "stack"], d.mode),
    autoColor: typeof s.autoColor === "boolean" ? s.autoColor : d.autoColor,
    colors: {
      lyric: isHex(s.colors?.lyric) ? s.colors.lyric.toLowerCase() : d.colors.lyric,
      highlight: isHex(s.colors?.highlight) ? s.colors.highlight.toLowerCase() : d.colors.highlight,
      dim: isHex(s.colors?.dim) ? s.colors.dim.toLowerCase() : d.colors.dim,
    },
    font: {
      family: typeof s.font?.family === "string" && s.font.family !== "" ? s.font.family : d.font.family,
      weight: clamp(s.font?.weight, 100, 900, d.font.weight),
    },
    size: clamp(s.size, 22, 140, d.size),
    curve: clamp(s.curve, -100, 100, d.curve),
    yPos: clamp(s.yPos, 0, 100, d.yPos),
    glow: clamp(s.glow, 0, 100, d.glow),
    opacity: clamp(s.opacity, 20, 100, d.opacity),
    showWhen: oneOf(s.showWhen, ["playing", "always"], d.showWhen),
    displays: oneOf(s.displays, ["primary", "all"], d.displays),
    globalOffsetMs: clamp(s.globalOffsetMs, -2000, 2000, d.globalOffsetMs),
    trackOffsetsMs: offsets,
  };
}

export interface MockOptions {
  /** Share player and settings with other tabs (overlay + settings side by side). Default true. */
  shared?: boolean;
  /** Space play/pause, ←/→ seek ±5 s, N / Shift+N next/previous track. Default true. */
  keys?: boolean;
  /** Persist across reloads. Default: localStorage when available. */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** `?track=1&t=5200&paused&settings={"mode":"lens"}` set the starting state. Default: the page URL. */
  params?: URLSearchParams;
}

export interface MockBridge extends Bridge {
  readonly player: MockPlayer;
  dispose(): void;
}

const PLAYER_KEY = "undertone.mock.player";
const SETTINGS_KEY = "undertone.mock.settings";
const CHANNEL = "undertone-mock";

type Message = { type: "player"; state: PlayerState } | { type: "settings"; settings: Settings };

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
  };
  const emit: Emit = (event, payload) => {
    queueMicrotask(() => {
      for (const handler of handlers[event]) handler(payload);
    });
  };
  const channel = shared && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;
  const post = (message: Message): void => channel?.postMessage(message);

  let settings = clampSettings({ ...structuredClone(DEFAULT_SETTINGS), ...read<Settings>(storage, SETTINGS_KEY) });
  const override = params.get("settings");
  if (override) {
    try {
      settings = clampSettings({ ...settings, ...(JSON.parse(override) as Partial<Settings>) });
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

  const player = new MockPlayer(emit, initial, (state) => {
    write(storage, PLAYER_KEY, state);
    post({ type: "player", state });
  });
  write(storage, PLAYER_KEY, player.snapshot);

  const setSettings = (next: Settings, broadcast: boolean): Settings => {
    const clamped = clampSettings(next);
    if (JSON.stringify(clamped) !== JSON.stringify(settings)) {
      settings = clamped;
      write(storage, SETTINGS_KEY, settings);
      if (broadcast) post({ type: "settings", settings });
      emit("settings-changed", structuredClone(settings));
    }
    return structuredClone(settings);
  };

  if (channel) {
    channel.onmessage = (e: MessageEvent<Message>) => {
      if (e.data.type === "player") player.apply(e.data.state);
      else setSettings(e.data.settings, false);
    };
  }

  const commands: { [C in Command]: (args: Commands[C]["args"]) => ResultOf<C> } = {
    get_settings: () => structuredClone(settings),
    update_settings: ({ patch }) => setSettings({ ...settings, ...patch }, true),
    get_now_playing: () => player.nowPlaying(),
    get_lyrics: ({ trackKey }) => player.lyrics(trackKey),
    refetch_lyrics: ({ trackKey }) => {
      if (trackKey === trackKeyOf(player.current)) player.refetch();
    },
    set_track_offset: ({ trackKey, ms }) =>
      setSettings({ ...settings, trackOffsetsMs: { ...settings.trackOffsetsMs, [trackKey]: ms } }, true),
    open_settings: () => {
      if (typeof window === "undefined") return;
      const url = new URL("settings.html", window.location.href);
      url.searchParams.set("mock", "");
      window.open(url, "undertone-settings", "width=380,height=640");
    },
    quit: () => {},
  };

  const onKey = (e: KeyboardEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("input, select, textarea, button, [contenteditable]")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Space") player.toggle();
    else if (e.key === "ArrowLeft") player.seekBy(-SEEK_STEP_MS);
    else if (e.key === "ArrowRight") player.seekBy(SEEK_STEP_MS);
    else if (e.key.toLowerCase() === "n") player.next(e.shiftKey ? -1 : 1);
    else return;
    e.preventDefault();
  };
  const keys = (options.keys ?? true) && typeof window !== "undefined";
  if (keys) window.addEventListener("keydown", onKey);

  return {
    kind: "mock",
    player,
    invoke<C extends Command>(command: C, ...args: ArgsOf<C>): Promise<ResultOf<C>> {
      const handler = commands[command];
      return Promise.resolve(handler((args[0] ?? {}) as Commands[C]["args"]));
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
