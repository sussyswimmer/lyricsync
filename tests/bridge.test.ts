import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Lyrics, type MediaStatus, type NowPlaying, type Settings } from "../contract/contract";
import { demoCover } from "../src/bridge/covers";
import {
  MOCK_TRACKS,
  MockPlayer,
  SEEK_STEP_MS,
  createMockBridge,
  lyricsOf,
  mergeSettings,
  migrateSettings,
  trackKeyOf,
  withTrackOffset,
  type MockBridge,
  type MockOptions,
  type MockTrack,
  type PlayerState,
} from "../src/bridge/mock";
import type { Event as BridgeEvent, Events } from "../src/bridge/types";

// The Tauri API is mocked for the whole file; only tauri.ts and index.ts reach it.
const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

const T0 = 1_760_000_000_000;
const KEYS = MOCK_TRACKS.map(trackKeyOf);
const key = (i: number): string => KEYS[i] ?? `missing track ${i}`;
function trackAt(i: number): MockTrack {
  const t = MOCK_TRACKS[i];
  if (!t) throw new Error(`no mock track ${i}`);
  return t;
}
const PLAYER_KEY = "undertone.mock.player";
const SETTINGS_KEY = "undertone.mock.settings";

/** Mock events are delivered with queueMicrotask; this lets them land. */
async function tick(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

/** Runs fake timers forward, then lets the queued events land. */
async function advance(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await tick();
}

interface Seen {
  nowPlaying: (NowPlaying | null)[];
  lyrics: Lyrics[];
  settings: Settings[];
  media: MediaStatus[];
  clear(): void;
}

const open: MockBridge[] = [];

/** A mock bridge with no tabs, keys or storage, and every event recorded from construction on. */
async function mock(query = "", options: MockOptions = {}): Promise<{ bridge: MockBridge; seen: Seen }> {
  const bridge = createMockBridge({ shared: false, keys: false, storage: null, params: new URLSearchParams(query), ...options });
  open.push(bridge);
  const seen: Seen = {
    nowPlaying: [],
    lyrics: [],
    settings: [],
    media: [],
    clear() {
      this.nowPlaying.length = 0;
      this.lyrics.length = 0;
      this.settings.length = 0;
      this.media.length = 0;
    },
  };
  // All four subscribe synchronously, before the construction-time `loading` event is delivered.
  await Promise.all([
    bridge.listen("now-playing", (p) => seen.nowPlaying.push(p)),
    bridge.listen("lyrics", (p) => seen.lyrics.push(p)),
    bridge.listen("settings-changed", (p) => seen.settings.push(p)),
    bridge.listen("media-status", (p) => seen.media.push(p)),
  ]);
  return { bridge, seen };
}

function memoryStorage(seed: Record<string, unknown> = {}): Pick<Storage, "getItem" | "setItem"> & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  for (const bridge of open.splice(0)) bridge.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  tauri.invoke.mockReset();
  tauri.listen.mockReset();
});

describe("mock tracks", () => {
  it("builds track keys exactly as SPEC defines them", () => {
    expect(key(0)).toBe("demo artist|neon monsoon|undertone demo|35");
    expect(trackKeyOf({ artist: "A B", title: "Ç", album: "X", durationMs: 1499 })).toBe("a b|ç|x|1");
    expect(new Set(KEYS).size).toBe(MOCK_TRACKS.length);
  });

  it("covers every lyrics state the overlay must handle", () => {
    expect(MOCK_TRACKS.map((t) => t.status).slice(0, 5)).toEqual(["found", "found", "plain-only", "not-found", "instrumental"]);
    expect(MOCK_TRACKS[1]?.synced).toMatch(/<\d\d:\d\d\.\d\d>/u);
    expect(MOCK_TRACKS[0]?.synced).not.toMatch(/<\d\d:\d\d\.\d\d>/u);
    expect(MOCK_TRACKS[4]?.cover).toBeNull();
  });

  it("reports loaded lyrics from the cache", () => {
    const t = trackAt(2);
    expect(lyricsOf(t)).toEqual({ trackKey: key(2), status: "plain-only", synced: null, plain: t.plain, source: "cache" });
  });
});

describe("demo covers", () => {
  it("returns null without a DOM or for an unknown cover", () => {
    expect(demoCover(0)).toBeNull();
    expect(demoCover(99)).toBeNull();
  });
});

describe("mock bridge: initial state", () => {
  it("starts on the first track, playing from 0", async () => {
    const { bridge } = await mock();
    const np = await bridge.invoke("get_now_playing");
    expect(np).toMatchObject({ trackKey: key(0), positionMs: 0, sampledAt: T0, isPlaying: true, source: "spotify" });
    expect(np).toMatchObject({ title: "Neon Monsoon", artist: "Demo Artist", album: "Undertone Demo", durationMs: 35_000 });
    expect(await bridge.invoke("get_settings")).toEqual(DEFAULT_SETTINGS);
  });

  it("reads track, t, paused and settings from the URL", async () => {
    const settings = encodeURIComponent(JSON.stringify({ mode: "lens", size: 999 }));
    const { bridge } = await mock(`?mock&track=1&t=4900&paused&settings=${settings}`);
    const np = await bridge.invoke("get_now_playing");
    expect(np).toMatchObject({ trackKey: key(1), positionMs: 4900, sampledAt: T0, isPlaying: false });
    const s = await bridge.invoke("get_settings");
    expect(s.mode).toBe("lens");
    expect(s.size).toBe(140);
    expect(s.font).toEqual(DEFAULT_SETTINGS.font);
  });

  it("wraps out-of-range track numbers and ignores junk", async () => {
    expect((await mock("?track=7")).bridge.player.snapshot.track).toBe(7 % MOCK_TRACKS.length);
    expect((await mock("?track=-1")).bridge.player.snapshot.track).toBe(MOCK_TRACKS.length - 1);
    expect((await mock("?track=abc&t=xyz")).bridge.player.snapshot).toMatchObject({ track: 0, positionMs: 0 });
  });

  // Regression: a negative ?t= used to be reported as a negative positionMs.
  it("never reports a negative position from a negative ?t=", async () => {
    const { bridge } = await mock("?track=0&t=-5000&paused");
    expect((await bridge.invoke("get_now_playing"))?.positionMs).toBe(0);
  });

  it("ignores a malformed ?settings=", async () => {
    const { bridge } = await mock("?settings=%7Bnot-json");
    expect(await bridge.invoke("get_settings")).toEqual(DEFAULT_SETTINGS);
  });

  it("emits lyrics loading for the first track and no now-playing until something happens", async () => {
    const { seen } = await mock("?paused");
    expect(seen.lyrics).toEqual([{ trackKey: key(0), status: "loading", synced: null, plain: null, source: "lrclib" }]);
    expect(seen.nowPlaying).toEqual([]);
  });
});

describe("mock bridge: playback events", () => {
  it("emits now-playing on toggle, seek and next", async () => {
    const { bridge, seen } = await mock("?track=0&t=2000");
    await advance(300); // past the late artwork event
    seen.clear();

    bridge.player.toggle();
    await tick();
    expect(seen.nowPlaying).toHaveLength(1);
    expect(seen.nowPlaying[0]).toMatchObject({ trackKey: key(0), positionMs: 2300, sampledAt: T0 + 300, isPlaying: false });

    bridge.player.seek(10_000);
    await tick();
    expect(seen.nowPlaying[1]).toMatchObject({ positionMs: 10_000, isPlaying: false });

    bridge.player.toggle();
    bridge.player.next();
    await tick();
    expect(seen.nowPlaying[2]).toMatchObject({ trackKey: key(0), isPlaying: true });
    expect(seen.nowPlaying[3]).toMatchObject({ trackKey: key(1), positionMs: 0, isPlaying: true, artwork: null });
    expect(seen.lyrics.map((l) => [l.trackKey, l.status])).toEqual([[key(1), "loading"]]);
  });

  it("seeks within the track and steps by SEEK_STEP_MS", async () => {
    const { bridge } = await mock("?track=1&t=20000&paused");
    bridge.player.seekBy(SEEK_STEP_MS);
    expect(bridge.player.position()).toBe(24_000);
    bridge.player.seek(-500);
    expect(bridge.player.position()).toBe(0);
    bridge.player.seekBy(SEEK_STEP_MS);
    expect(bridge.player.position()).toBe(5000);
  });

  it("wraps next and previous around the track list", async () => {
    const lastTrack = MOCK_TRACKS.length - 1;
    const { bridge } = await mock(`?track=${lastTrack}&paused`);
    bridge.player.next();
    expect(bridge.player.snapshot.track).toBe(0);
    bridge.player.next(-1);
    expect(bridge.player.snapshot.track).toBe(lastTrack);
    bridge.player.select(1, 3000);
    expect(bridge.player.snapshot).toMatchObject({ track: 1, positionMs: 3000 });
    expect(bridge.player.current.title).toBe("Paper Lanterns");
  });

  it("resyncs every second while playing", async () => {
    const { seen } = await mock("?track=4"); // no artwork, so only resyncs
    await advance(999);
    expect(seen.nowPlaying).toEqual([]);
    await advance(1);
    await advance(2000);
    expect(seen.nowPlaying.map((e) => e?.positionMs)).toEqual([1000, 2000, 3000]);
    expect(seen.nowPlaying.map((e) => e?.sampledAt)).toEqual([T0 + 1000, T0 + 2000, T0 + 3000]);
  });

  it("does not resync while paused", async () => {
    const { bridge, seen } = await mock("?track=4&t=5000&paused");
    await advance(10_000);
    expect(seen.nowPlaying).toEqual([]);
    bridge.player.toggle();
    await advance(1000);
    bridge.player.toggle();
    await tick();
    seen.clear();
    await advance(10_000);
    expect(seen.nowPlaying).toEqual([]);
    expect(bridge.player.position()).toBe(6000);
  });

  it("delivers artwork in a second now-playing a moment after the track (null without a DOM)", async () => {
    const { bridge, seen } = await mock("?track=0&paused");
    await advance(249);
    expect(seen.nowPlaying).toEqual([]);
    await advance(1);
    expect(seen.nowPlaying).toHaveLength(1);
    expect(seen.nowPlaying[0]).toMatchObject({ trackKey: key(0), artwork: null });
    expect((await bridge.invoke("get_now_playing"))?.artwork).toBeNull();
  });

  it("sends no artwork event for a track without a cover", async () => {
    const { seen } = await mock("?track=4&paused");
    await advance(5000);
    expect(seen.nowPlaying).toEqual([]);
  });

  it("clamps the reported position to the duration", async () => {
    const { bridge } = await mock("?track=1&t=23000");
    expect(bridge.player.position(T0 + 60_000)).toBe(24_000);
    expect(bridge.player.nowPlaying(T0 + 500).positionMs).toBe(23_500);
  });
});

describe("mock bridge: lyrics", () => {
  it("reports loading, then the result after the lookup", async () => {
    const { bridge, seen } = await mock("?track=1&paused");
    expect((await bridge.invoke("get_lyrics", { trackKey: key(1) })).status).toBe("loading");
    await advance(399);
    expect(seen.lyrics.map((l) => l.status)).toEqual(["loading"]);
    await advance(1);
    expect(seen.lyrics.map((l) => l.status)).toEqual(["loading", "found"]);
    expect(seen.lyrics[1]).toEqual(lyricsOf(trackAt(1)));
    expect(await bridge.invoke("get_lyrics", { trackKey: key(1) })).toEqual(seen.lyrics[1]);
  });

  it("takes longer to report not-found", async () => {
    const { seen } = await mock("?track=3&paused");
    await advance(400);
    expect(seen.lyrics.map((l) => l.status)).toEqual(["loading"]);
    await advance(499);
    expect(seen.lyrics.map((l) => l.status)).toEqual(["loading"]);
    await advance(1);
    expect(seen.lyrics.map((l) => [l.trackKey, l.status])).toEqual([
      [key(3), "loading"],
      [key(3), "not-found"],
    ]);
  });

  it("reports instrumental tracks", async () => {
    const { seen } = await mock("?track=4&paused");
    await advance(400);
    expect(seen.lyrics.map((l) => l.status)).toEqual(["loading", "instrumental"]);
  });

  it("answers get_lyrics for another track straight from the cache, and not-found for an unknown key", async () => {
    const { bridge } = await mock("?track=0&paused");
    expect(await bridge.invoke("get_lyrics", { trackKey: key(2) })).toMatchObject({ trackKey: key(2), status: "plain-only", synced: null, source: "cache" });
    expect(await bridge.invoke("get_lyrics", { trackKey: "nobody|nothing||0" })).toEqual({
      trackKey: "nobody|nothing||0",
      status: "not-found",
      synced: null,
      plain: null,
      source: "lrclib",
    });
  });

  it("drops a pending result when the track changes before it arrives", async () => {
    const { bridge, seen } = await mock("?track=0&paused");
    await advance(200);
    bridge.player.next();
    await advance(1000);
    expect(seen.lyrics.map((l) => [l.trackKey, l.status])).toEqual([
      [key(0), "loading"],
      [key(1), "loading"],
      [key(1), "found"],
    ]);
  });

  it("refetches the current track: loading, then the result", async () => {
    const { bridge, seen } = await mock("?track=1&paused");
    await advance(400);
    seen.clear();
    await bridge.invoke("refetch_lyrics", { trackKey: key(1) });
    await tick();
    expect(seen.lyrics.map((l) => l.status)).toEqual(["loading"]);
    expect((await bridge.invoke("get_lyrics", { trackKey: key(1) })).status).toBe("loading");
    await advance(400);
    expect(seen.lyrics.map((l) => l.status)).toEqual(["loading", "found"]);
  });

  it("ignores a refetch for a track that isn't playing", async () => {
    const { bridge, seen } = await mock("?track=1&paused");
    await advance(400);
    seen.clear();
    await bridge.invoke("refetch_lyrics", { trackKey: key(0) });
    await advance(2000);
    expect(seen.lyrics).toEqual([]);
  });
});

describe("mock bridge: settings", () => {
  it("returns copies, so callers can't mutate the store", async () => {
    const { bridge } = await mock();
    const s = await bridge.invoke("get_settings");
    s.colors.lyric = "#000000";
    s.trackOffsetsMs["x"] = 5;
    expect(await bridge.invoke("get_settings")).toEqual(DEFAULT_SETTINGS);
  });

  it("merges a patch shallowly: nested objects are replaced whole", async () => {
    const { bridge } = await mock();
    await bridge.invoke("set_track_offset", { trackKey: "a", ms: 100 });
    const next = await bridge.invoke("update_settings", {
      patch: { mode: "drift", font: { family: "Syne", weight: 800 }, trackOffsetsMs: { b: 50 } },
    });
    expect(next.mode).toBe("drift");
    expect(next.font).toEqual({ family: "Syne", weight: 800 });
    expect(next.trackOffsetsMs).toEqual({ b: 50 });
    expect(next.size).toBe(DEFAULT_SETTINGS.size);
    expect(next.colors).toEqual(DEFAULT_SETTINGS.colors);
  });

  it("clamps numbers to the SPEC ranges", async () => {
    const { bridge } = await mock();
    const high = await bridge.invoke("update_settings", {
      patch: { size: 500, curve: 300, yPos: 150, glow: 101, opacity: 120, globalOffsetMs: 9999, font: { family: "Fraunces", weight: 1000 } },
    });
    expect(high).toMatchObject({ size: 140, curve: 100, yPos: 100, glow: 100, opacity: 100, globalOffsetMs: 2000 });
    expect(high.font.weight).toBe(900);
    const low = await bridge.invoke("update_settings", {
      patch: { size: 10, curve: -300, yPos: -1, glow: -5, opacity: 5, globalOffsetMs: -9999, font: { family: "Fraunces", weight: 50 } },
    });
    expect(low).toMatchObject({ size: 22, curve: -100, yPos: 0, glow: 0, opacity: 20, globalOffsetMs: -2000 });
    expect(low.font.weight).toBe(100);
  });

  it("keeps the current color for an invalid one and lowercases valid ones", async () => {
    const { bridge } = await mock();
    const custom = { lyric: "#ffffff", highlight: "#00ff88", dim: "#202020" };
    await bridge.invoke("update_settings", { patch: { colors: custom } });
    const s = await bridge.invoke("update_settings", { patch: { colors: { lyric: "red", highlight: "#ABCDEF", dim: "#12345" } } });
    expect(s.colors).toEqual({ ...custom, highlight: "#abcdef" });
  });

  it("changes only the colors a partial colors object has", async () => {
    const { bridge } = await mock();
    const patch = { colors: { dim: "#010203" } } as unknown as Partial<Settings>;
    const s = await bridge.invoke("update_settings", { patch });
    expect(s.colors).toEqual({ ...DEFAULT_SETTINGS.colors, dim: "#010203" });
  });

  it("keeps the current mode, show-when, displays and auto-color for an invalid value, and ignores version", async () => {
    const { bridge } = await mock();
    await bridge.invoke("update_settings", { patch: { mode: "lens", showWhen: "always", displays: "all", autoColor: false } });
    const bad = { mode: "spiral", showWhen: "sometimes", displays: "left", autoColor: "yes", version: 7 } as unknown as Partial<Settings>;
    const s = await bridge.invoke("update_settings", { patch: bad });
    expect(s).toMatchObject({ mode: "lens", showWhen: "always", displays: "all", autoColor: false, version: 1 });
  });

  it("keeps the current number for a wrong type or a non-finite value", async () => {
    const { bridge } = await mock();
    await bridge.invoke("update_settings", { patch: { size: 80, curve: -20, glow: 10, globalOffsetMs: 250 } });
    const bad = { size: "90", curve: null, glow: Number.NaN, globalOffsetMs: Number.POSITIVE_INFINITY } as unknown as Partial<Settings>;
    const s = await bridge.invoke("update_settings", { patch: bad });
    expect(s).toMatchObject({ size: 80, curve: -20, glow: 10, globalOffsetMs: 250 });
  });

  it("drops unknown keys and ignores a patch that isn't an object", async () => {
    const { bridge, seen } = await mock();
    const unknown = { theme: "dark", Size: 99 } as unknown as Partial<Settings>;
    expect(await bridge.invoke("update_settings", { patch: unknown })).toEqual(DEFAULT_SETTINGS);
    for (const patch of [null, [{ size: 30 }], "size", 30]) {
      expect(await bridge.invoke("update_settings", { patch: patch as unknown as Partial<Settings> })).toEqual(DEFAULT_SETTINGS);
    }
    await tick();
    expect(seen.settings).toEqual([]);
  });

  it("clamps per-track offsets to ±2000 and keeps the others", async () => {
    const { bridge } = await mock();
    await bridge.invoke("set_track_offset", { trackKey: "a", ms: -150 });
    const s = await bridge.invoke("set_track_offset", { trackKey: "b", ms: 5000 });
    expect(s.trackOffsetsMs).toEqual({ a: -150, b: 2000 });
    expect((await bridge.invoke("set_track_offset", { trackKey: "a", ms: -9000 })).trackOffsetsMs).toEqual({ a: -2000, b: 2000 });
  });

  it("removes a song's offset when it is set to zero", async () => {
    const { bridge, seen } = await mock();
    await bridge.invoke("set_track_offset", { trackKey: "a", ms: 100 });
    await bridge.invoke("set_track_offset", { trackKey: "b", ms: -50 });
    expect((await bridge.invoke("set_track_offset", { trackKey: "a", ms: 0 })).trackOffsetsMs).toEqual({ b: -50 });
    expect((await bridge.invoke("set_track_offset", { trackKey: "b", ms: -0 })).trackOffsetsMs).toEqual({});
    await tick();
    seen.clear();
    // Zero for a song without an offset changes nothing.
    await bridge.invoke("set_track_offset", { trackKey: "c", ms: 0 });
    await tick();
    expect(seen.settings).toEqual([]);
  });

  it("rejects a non-finite track offset and changes nothing", async () => {
    const { bridge, seen } = await mock();
    await expect(bridge.invoke("set_track_offset", { trackKey: "a", ms: Number.NaN })).rejects.toThrow(/finite/);
    await expect(bridge.invoke("set_track_offset", { trackKey: "a", ms: Number.POSITIVE_INFINITY })).rejects.toThrow(/finite/);
    expect((await bridge.invoke("get_settings")).trackOffsetsMs).toEqual({});
    await tick();
    expect(seen.settings).toEqual([]);
  });

  it("replaces trackOffsetsMs whole from update_settings, dropping zero and invalid entries", async () => {
    const { bridge } = await mock();
    await bridge.invoke("set_track_offset", { trackKey: "a", ms: 100 });
    const offsets = { b: 50, c: 0, d: 5000, e: "x", f: Number.NaN } as unknown as Record<string, number>;
    const s = await bridge.invoke("update_settings", { patch: { trackOffsetsMs: offsets } });
    expect(s.trackOffsetsMs).toEqual({ b: 50, d: 2000 });
  });

  it("emits settings-changed only for a real change", async () => {
    const { bridge, seen } = await mock();
    await bridge.invoke("update_settings", { patch: { size: DEFAULT_SETTINGS.size } });
    await bridge.invoke("update_settings", { patch: {} });
    await bridge.invoke("update_settings", { patch: { size: 999 } });
    await bridge.invoke("update_settings", { patch: { size: 140 } }); // already clamped to 140
    await tick();
    expect(seen.settings.map((s) => s.size)).toEqual([140]);

    await bridge.invoke("set_track_offset", { trackKey: "k", ms: 50 });
    await bridge.invoke("set_track_offset", { trackKey: "k", ms: 50 });
    await tick();
    expect(seen.settings).toHaveLength(2);
    expect(seen.settings[1]?.trackOffsetsMs).toEqual({ k: 50 });
  });

  it("sends each listener its own copy", async () => {
    const { bridge, seen } = await mock();
    const returned = await bridge.invoke("update_settings", { patch: { glow: 10 } });
    await tick();
    const echoed = seen.settings[0];
    expect(echoed).toEqual(returned);
    expect(echoed).not.toBe(returned);
    if (echoed) echoed.glow = 99;
    expect((await bridge.invoke("get_settings")).glow).toBe(10);
  });
});

// The same rules as the Rust store (src-tauri/src/settings.rs): each field on its own, invalid keeps current.
describe("mergeSettings", () => {
  /** Non-default values everywhere, so "keeps the current value" can't pass by resetting to the default. */
  const custom: Settings = {
    version: 1,
    mode: "lens",
    autoColor: false,
    colors: { lyric: "#ffffff", highlight: "#00ff88", dim: "#202020" },
    font: { family: "Syne", weight: 500 },
    size: 80,
    curve: -20,
    yPos: 70,
    glow: 10,
    opacity: 60,
    showWhen: "always",
    displays: "all",
    globalOffsetMs: 250,
    trackOffsetsMs: { "a|b|c|1": -150 },
  };

  it("keeps valid settings as they are and never mutates its input", () => {
    const current = structuredClone(custom);
    expect(mergeSettings(current, structuredClone(custom))).toEqual(custom);
    expect(mergeSettings(current, {})).toEqual(custom);
    mergeSettings(current, { size: 30, colors: { lyric: "#000000" }, trackOffsetsMs: {} });
    expect(current).toEqual(custom);
  });

  it("keeps the current value of every field for a wrong type", () => {
    for (const junk of ["50", null, [1], true, Number.NaN, Number.NEGATIVE_INFINITY]) {
      const patch = Object.fromEntries(Object.keys(custom).map((k) => [k, junk]));
      const next = mergeSettings(custom, patch);
      // A boolean is a valid autoColor.
      expect(next).toEqual(junk === true ? { ...custom, autoColor: true } : custom);
    }
  });

  it("clamps every number to the SPEC range, ends included", () => {
    const high = mergeSettings(custom, { size: 500, curve: 300, yPos: 150, glow: 101, opacity: 120, globalOffsetMs: 9999, font: { weight: 1000 } });
    expect(high).toMatchObject({ size: 140, curve: 100, yPos: 100, glow: 100, opacity: 100, globalOffsetMs: 2000, font: { family: "Syne", weight: 900 } });
    const low = mergeSettings(custom, { size: 10, curve: -300, yPos: -1, glow: -5, opacity: 5, globalOffsetMs: -9999, font: { weight: 50 } });
    expect(low).toMatchObject({ size: 22, curve: -100, yPos: 0, glow: 0, opacity: 20, globalOffsetMs: -2000, font: { weight: 100 } });
    expect(mergeSettings(custom, { size: 22, opacity: 100, glow: 12.5 })).toMatchObject({ size: 22, opacity: 100, glow: 12.5 });
  });

  it("changes only the keys a partial colors or font object has", () => {
    expect(mergeSettings(custom, { colors: { dim: "#ABCDEF", accent: "#ffffff" } }).colors).toEqual({ ...custom.colors, dim: "#abcdef" });
    expect(mergeSettings(custom, { colors: { lyric: "#fff", highlight: "orange" } }).colors).toEqual(custom.colors);
    expect(mergeSettings(custom, { font: { weight: 300 } }).font).toEqual({ family: "Syne", weight: 300 });
    expect(mergeSettings(custom, { font: { family: "Fraunces", style: "x" } }).font).toEqual({ family: "Fraunces", weight: 500 });
  });

  it("takes a font family that isn't blank and has at most 64 characters", () => {
    // Blank as Rust's `str::trim` reads it (Unicode White_Space): NEL is blank there, a BOM isn't.
    for (const family of ["", "   ", "\u0085 　\t", "x".repeat(65), ["Syne"], 3]) {
      expect(mergeSettings(custom, { font: { family } }).font).toEqual(custom.font);
    }
    expect(mergeSettings(custom, { font: { family: "﻿" } }).font.family).toBe("﻿");
    // Code points, as Rust counts them: 64 astral letters are 128 UTF-16 units.
    const astral = "\u{1d4d0}".repeat(64);
    expect(mergeSettings(custom, { font: { family: astral } }).font.family).toBe(astral);
    expect(mergeSettings(custom, { font: { family: "\u{e9}".repeat(64) } }).font.family).toHaveLength(64);
  });

  it("accepts every enum value exactly, in no other case", () => {
    for (const mode of ["arc", "lens", "drift", "stack"] as const) expect(mergeSettings(custom, { mode }).mode).toBe(mode);
    expect(mergeSettings(custom, { showWhen: "playing", displays: "primary" })).toMatchObject({ showWhen: "playing", displays: "primary" });
    expect(mergeSettings(custom, { mode: "Arc", displays: "All", showWhen: "sometimes" })).toEqual(custom);
  });

  it("ignores version, drops unknown keys and ignores a patch that isn't an object", () => {
    expect(mergeSettings(custom, { version: 7, size: 60 })).toEqual({ ...custom, size: 60 });
    expect(Object.keys(mergeSettings(custom, { theme: "dark" }))).toEqual(Object.keys(custom));
    for (const patch of [null, undefined, [{ size: 30 }], "size", 30]) expect(mergeSettings(custom, patch)).toEqual(custom);
  });

  it("replaces track offsets whole: each clamped, zero and junk entries dropped", () => {
    const s = mergeSettings(custom, { trackOffsetsMs: { a: 5000, b: -10, c: Number.NaN, d: "x", e: 0, f: -0, g: null } });
    expect(s.trackOffsetsMs).toEqual({ a: 2000, b: -10 });
    expect(mergeSettings(custom, { trackOffsetsMs: [5] }).trackOffsetsMs).toEqual(custom.trackOffsetsMs);
  });
});

describe("migrateSettings", () => {
  it("turns nothing or an empty object into the defaults", () => {
    for (const stored of [null, undefined, {}, "settings", [1, 2]]) expect(migrateSettings(stored)).toEqual(DEFAULT_SETTINGS);
  });

  it("repairs a v1 blob field by field, starting from the defaults", () => {
    const stored = {
      version: 1,
      mode: "stack",
      autoColor: "yes",
      colors: { lyric: "#FFEEDD", highlight: "orange" },
      font: { family: "", weight: 950 },
      size: "big",
      curve: -500,
      glow: null,
      opacity: 55,
      showWhen: "never",
      displays: "all",
      globalOffsetMs: 120.5,
      trackOffsetsMs: { "x|y|z|200": 90, zero: 0, junk: "x", far: -7000 },
      legacyTheme: "night",
    };
    expect(migrateSettings(stored)).toEqual({
      ...DEFAULT_SETTINGS,
      mode: "stack",
      colors: { ...DEFAULT_SETTINGS.colors, lyric: "#ffeedd" },
      font: { ...DEFAULT_SETTINGS.font, weight: 900 },
      curve: -100,
      opacity: 55,
      displays: "all",
      globalOffsetMs: 120.5,
      trackOffsetsMs: { "x|y|z|200": 90, far: -2000 },
    });
  });

  it("keeps what it knows from a newer version", () => {
    const stored = { version: 3, mode: "helix", size: 70, colors: { lyric: "#000000", shadow: "#111111" }, lockScreen: true };
    expect(migrateSettings(stored)).toEqual({ ...DEFAULT_SETTINGS, size: 70, colors: { ...DEFAULT_SETTINGS.colors, lyric: "#000000" } });
  });

  it("never hands out the shared defaults object", () => {
    const s = migrateSettings({});
    s.colors.lyric = "#000000";
    s.trackOffsetsMs["x"] = 5;
    expect(DEFAULT_SETTINGS.colors.lyric).toBe("#f1ece3");
    expect(DEFAULT_SETTINGS.trackOffsetsMs).toEqual({});
  });
});

describe("withTrackOffset", () => {
  const base: Settings = { ...structuredClone(DEFAULT_SETTINGS), trackOffsetsMs: { a: -150 } };

  it("sets, clamps and removes a song's offset without touching the others", () => {
    expect(withTrackOffset(base, "k", 50).trackOffsetsMs).toEqual({ a: -150, k: 50 });
    expect(withTrackOffset(base, "k", 5000).trackOffsetsMs).toEqual({ a: -150, k: 2000 });
    expect(withTrackOffset(base, "a", -9000).trackOffsetsMs).toEqual({ a: -2000 });
    expect(withTrackOffset(base, "a", 0).trackOffsetsMs).toEqual({});
    expect(withTrackOffset(base, "a", -0).trackOffsetsMs).toEqual({});
    expect(base.trackOffsetsMs).toEqual({ a: -150 });
  });

  it("throws for a non-finite offset", () => {
    for (const ms of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => withTrackOffset(base, "k", ms)).toThrow(/finite/);
    }
  });
});

describe("mock bridge: auto-advance", () => {
  it("moves to the next track at the end, stamped at the exact end time", async () => {
    const { bridge, seen } = await mock("?track=1&t=23000");
    await advance(999);
    expect(bridge.player.snapshot.track).toBe(1);
    await advance(1);
    expect(bridge.player.snapshot).toEqual({ track: 2, positionMs: 0, sampledAt: T0 + 1000, isPlaying: true });
    expect(last(seen.nowPlaying)).toMatchObject({ trackKey: key(2), positionMs: 0, sampledAt: T0 + 1000, isPlaying: true });
    expect(last(seen.lyrics)).toMatchObject({ trackKey: key(2), status: "loading" });
  });

  it("wraps from the last track to the first", async () => {
    const lastTrack = MOCK_TRACKS.length - 1;
    const { bridge } = await mock(`?track=${lastTrack}&t=${(MOCK_TRACKS[lastTrack]?.durationMs ?? 0) - 500}`);
    await advance(500);
    expect(bridge.player.snapshot.track).toBe(0);
  });

  it("doesn't advance while paused", async () => {
    const { bridge } = await mock("?track=1&t=23900&paused");
    await advance(60_000);
    expect(bridge.player.snapshot.track).toBe(1);
  });

  it("stamps the new track from shared state even when the timer fires late", () => {
    let wall = T0;
    const onChange = vi.fn<(s: PlayerState) => void>();
    const nowPlaying: NowPlaying[] = [];
    const emit = <E extends BridgeEvent>(event: E, payload: Events[E]): void => {
      if (event === "now-playing" && payload) nowPlaying.push(payload as NowPlaying);
    };
    const player = new MockPlayer(emit, { track: 1, positionMs: 23_000, sampledAt: T0, isPlaying: true }, onChange, () => wall);
    wall = T0 + 1900; // a throttled tab: the 1000 ms timer runs 900 ms late
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenLastCalledWith({ track: 2, positionMs: 0, sampledAt: T0 + 1000, isPlaying: true });
    expect(last(nowPlaying)).toMatchObject({ trackKey: key(2), positionMs: 900, sampledAt: T0 + 1900 });
    player.dispose();
  });

  // Regression: a position past the end (?t=, select(), a restored player) used to cascade through
  // every track with setTimeout(0). State is now clamped, and a finished playing state moves on once.
  it("advances at most one track when ?t= is past the end", async () => {
    const { bridge, seen } = await mock("?track=1&t=999999");
    for (let i = 0; i < 100; i++) await advance(1);
    expect(seen.lyrics.filter((l) => l.status === "loading").length).toBeLessThanOrEqual(2);
    expect([1, 2]).toContain(bridge.player.snapshot.track);
  });

  it("advances at most one track after select() past the end", async () => {
    const { bridge, seen } = await mock("?track=0");
    seen.clear();
    bridge.player.select(1, 500_000);
    for (let i = 0; i < 100; i++) await advance(1);
    expect(seen.lyrics.filter((l) => l.status === "loading").length).toBeLessThanOrEqual(2);
  });
});

describe("MockPlayer sync between tabs", () => {
  type Emitted = { event: BridgeEvent; payload: Events[BridgeEvent] };

  function player(initial: PlayerState): { player: MockPlayer; emitted: Emitted[]; onChange: ReturnType<typeof vi.fn<(s: PlayerState) => void>> } {
    const emitted: Emitted[] = [];
    const onChange = vi.fn<(s: PlayerState) => void>();
    const emit = <E extends BridgeEvent>(event: E, payload: Events[E]): void => {
      emitted.push({ event, payload });
    };
    return { player: new MockPlayer(emit, initial, onChange, () => Date.now()), emitted, onChange };
  }

  it("broadcasts its own changes", () => {
    const p = player({ track: 0, positionMs: 0, sampledAt: T0, isPlaying: true });
    p.player.toggle();
    expect(p.onChange).toHaveBeenCalledTimes(1);
    expect(p.onChange).toHaveBeenCalledWith({ track: 0, positionMs: 0, sampledAt: T0, isPlaying: false });
    p.player.dispose();
  });

  it("adopts state from another tab without echoing it back", () => {
    const p = player({ track: 0, positionMs: 0, sampledAt: T0, isPlaying: true });
    p.emitted.length = 0;
    p.player.apply({ track: 3, positionMs: 1000, sampledAt: T0, isPlaying: true });
    expect(p.onChange).not.toHaveBeenCalled();
    expect(p.player.snapshot).toEqual({ track: 3, positionMs: 1000, sampledAt: T0, isPlaying: true });
    expect(p.emitted.map((e) => [e.event, (e.payload as { trackKey: string }).trackKey])).toEqual([
      ["lyrics", key(3)],
      ["now-playing", key(3)],
    ]);
    p.player.dispose();
  });

  it("ignores state it already has, and wraps a foreign track index", () => {
    const p = player({ track: 1, positionMs: 500, sampledAt: T0, isPlaying: false });
    p.emitted.length = 0;
    p.player.apply({ track: 1, positionMs: 500, sampledAt: T0, isPlaying: false });
    expect(p.emitted).toEqual([]);
    p.player.apply({ track: 7, positionMs: 0, sampledAt: T0, isPlaying: false });
    expect(p.player.snapshot.track).toBe(7 % MOCK_TRACKS.length);
    expect(p.onChange).not.toHaveBeenCalled();
    p.player.dispose();
  });

  it("follows a pause from another tab: resyncs stop", () => {
    const p = player({ track: 4, positionMs: 0, sampledAt: T0, isPlaying: true });
    p.player.apply({ track: 4, positionMs: 0, sampledAt: T0, isPlaying: false });
    p.emitted.length = 0;
    vi.advanceTimersByTime(5000);
    expect(p.emitted.filter((e) => e.event === "now-playing")).toEqual([]);
    p.player.dispose();
  });

  it("relays between two shared bridges without echo", async () => {
    vi.useRealTimers();
    const post = vi.spyOn(BroadcastChannel.prototype, "postMessage");
    const a = createMockBridge({ shared: true, keys: false, storage: null, params: new URLSearchParams("?track=1&paused") });
    const b = createMockBridge({ shared: true, keys: false, storage: null, params: new URLSearchParams("?track=1&paused") });
    open.push(a, b);
    const bSettings: Settings[] = [];
    await b.listen("settings-changed", (s) => bSettings.push(s));

    a.player.seek(7000);
    await a.invoke("update_settings", { patch: { mode: "lens" } });
    await vi.waitFor(() => {
      expect(b.player.snapshot.positionMs).toBe(7000);
      expect(bSettings.map((s) => s.mode)).toEqual(["lens"]);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(post).toHaveBeenCalledTimes(2);
    expect(await b.invoke("get_settings")).toMatchObject({ mode: "lens" });
  });
});

describe("mock bridge: storage", () => {
  it("restores the saved player and settings when the URL says nothing", async () => {
    const storage = memoryStorage({
      [PLAYER_KEY]: { track: 2, positionMs: 5000, sampledAt: T0 - 1000, isPlaying: false },
      [SETTINGS_KEY]: { mode: "lens", size: 999 },
    });
    const { bridge } = await mock("", { storage });
    expect(bridge.player.snapshot).toEqual({ track: 2, positionMs: 5000, sampledAt: T0 - 1000, isPlaying: false });
    expect(await bridge.invoke("get_settings")).toMatchObject({ mode: "lens", size: 140 });
  });

  it("lets URL params override the saved player", async () => {
    const storage = memoryStorage({ [PLAYER_KEY]: { track: 2, positionMs: 5000, sampledAt: T0 - 1000, isPlaying: false } });
    const { bridge } = await mock("?t=1200", { storage });
    expect(bridge.player.snapshot).toEqual({ track: 2, positionMs: 1200, sampledAt: T0, isPlaying: true });
  });

  it("persists player and settings changes", async () => {
    const storage = memoryStorage();
    const { bridge } = await mock("?track=1", { storage });
    expect(JSON.parse(storage.data.get(PLAYER_KEY) ?? "null")).toMatchObject({ track: 1, isPlaying: true });
    bridge.player.toggle();
    expect(JSON.parse(storage.data.get(PLAYER_KEY) ?? "null")).toMatchObject({ track: 1, isPlaying: false });
    await bridge.invoke("update_settings", { patch: { glow: 5 } });
    expect(JSON.parse(storage.data.get(SETTINGS_KEY) ?? "null")).toMatchObject({ glow: 5 });
  });

  it("survives corrupt or failing storage", async () => {
    const broken: Pick<Storage, "getItem" | "setItem"> = {
      getItem: (k) => (k === PLAYER_KEY ? "{oops" : null),
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const { bridge } = await mock("", { storage: broken });
    expect(bridge.player.snapshot.track).toBe(0);
    expect((await bridge.invoke("update_settings", { patch: { size: 30 } })).size).toBe(30);
  });

  // Regression: a saved player that was playing when the tab closed used to fast-forward one track at a
  // time (~24 track changes after ten minutes) instead of moving on once.
  it("restores a stale playing state with at most one track change", async () => {
    const storage = memoryStorage({ [PLAYER_KEY]: { track: 0, positionMs: 0, sampledAt: T0 - 10 * 60_000, isPlaying: true } });
    const { seen } = await mock("", { storage });
    for (let i = 0; i < 100; i++) await advance(1);
    const changes = seen.lyrics.filter((l) => l.status === "loading").length;
    expect(changes).toBeLessThanOrEqual(2);
  });
});

describe("mock bridge: media status (contract v2)", () => {
  it("reports the track's player and no problem, and sends nothing while that holds", async () => {
    const { bridge, seen } = await mock("?track=1");
    expect(await bridge.invoke("get_media_status")).toEqual({ source: "spotify", problem: null });
    bridge.player.next();
    await advance(5000);
    expect(seen.nowPlaying.length).toBeGreaterThan(0);
    expect(seen.media).toEqual([]);
  });

  it("?media=automation-denied reports nothing playing because Spotify is denied", async () => {
    const { bridge, seen } = await mock("?media=automation-denied&track=1");
    expect(await bridge.invoke("get_now_playing")).toBeNull();
    expect(await bridge.invoke("get_media_status")).toEqual({ source: "spotify", problem: "automation-denied" });
    // The player keeps time, but none of it is reported: no resyncs, artwork or lyrics.
    await advance(3000);
    expect(seen.nowPlaying).toEqual([]);
    expect(seen.lyrics).toEqual([]);
    expect(seen.media).toEqual([]);
    expect(bridge.player.position()).toBe(3000);
    // Settings still work.
    expect((await bridge.invoke("update_settings", { patch: { size: 70 } })).size).toBe(70);
  });

  it("?media=no-player reports nothing playing and no player", async () => {
    const { bridge } = await mock("?media=no-player");
    expect(await bridge.invoke("get_now_playing")).toBeNull();
    expect(await bridge.invoke("get_media_status")).toEqual({ source: null, problem: "no-player" });
  });

  it("ignores an unknown ?media= value", async () => {
    for (const query of ["?media=denied", "?media=", "?media=NO-PLAYER"]) {
      const { bridge } = await mock(query);
      expect(await bridge.invoke("get_media_status")).toEqual({ source: "spotify", problem: null });
      expect(await bridge.invoke("get_now_playing")).not.toBeNull();
    }
  });

  it("setMedia sends now-playing first, then media-status, and only on a change", async () => {
    const { bridge, seen } = await mock("?track=1&t=2000");
    await advance(300); // past the artwork event
    const order: string[] = [];
    await bridge.listen("now-playing", (np) => order.push(np ? "now-playing" : "now-playing null"));
    await bridge.listen("media-status", (m) => order.push(`media-status ${m.problem ?? "ok"}`));
    seen.clear();

    bridge.setMedia("automation-denied");
    await tick();
    expect(order).toEqual(["now-playing null", "media-status automation-denied"]);
    expect(seen.media).toEqual([{ source: "spotify", problem: "automation-denied" }]);

    // Still nothing playing: a new reason, but no second null.
    bridge.setMedia("no-player");
    bridge.setMedia("no-player");
    await advance(2500);
    expect(seen.nowPlaying).toEqual([null]);
    expect(seen.media).toEqual([
      { source: "spotify", problem: "automation-denied" },
      { source: null, problem: "no-player" },
    ]);
    expect(await bridge.invoke("get_now_playing")).toBeNull();

    order.length = 0;
    bridge.setMedia(null);
    await tick();
    expect(order).toEqual(["now-playing", "media-status ok"]);
    expect(last(seen.nowPlaying)).toMatchObject({ trackKey: key(1), positionMs: 4800, isPlaying: true });
    expect(last(seen.media)).toEqual({ source: "spotify", problem: null });
    expect(await bridge.invoke("get_media_status")).toEqual({ source: "spotify", problem: null });
    // Resyncs are reported again.
    seen.clear();
    await advance(1000);
    expect(seen.nowPlaying).toHaveLength(1);
  });

  it("shares setMedia with the other pages without echo, but not ?media=", async () => {
    vi.useRealTimers();
    const post = vi.spyOn(BroadcastChannel.prototype, "postMessage");
    const a = createMockBridge({ shared: true, keys: false, storage: null, params: new URLSearchParams("?track=1&paused&media=automation-denied") });
    const b = createMockBridge({ shared: true, keys: false, storage: null, params: new URLSearchParams("?track=1&paused") });
    open.push(a, b);
    const bMedia: MediaStatus[] = [];
    const bTrack: (NowPlaying | null)[] = [];
    await b.listen("media-status", (m) => bMedia.push(m));
    await b.listen("now-playing", (np) => bTrack.push(np));
    // `?media` is this page's alone, like `?settings`.
    expect(await b.invoke("get_media_status")).toEqual({ source: "spotify", problem: null });

    a.setMedia("no-player");
    await vi.waitFor(() => expect(bMedia).toEqual([{ source: null, problem: "no-player" }]));
    expect(bTrack).toEqual([null]);
    expect(await b.invoke("get_now_playing")).toBeNull();

    b.setMedia(null);
    await vi.waitFor(async () => expect(await a.invoke("get_media_status")).toEqual({ source: "spotify", problem: null }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(post).toHaveBeenCalledTimes(2);
    expect(bMedia.map((m) => m.problem)).toEqual(["no-player", null]);
  });

  it("setMedia reaches a page whose ?media= differs, even when this page already has that state", async () => {
    vi.useRealTimers();
    const post = vi.spyOn(BroadcastChannel.prototype, "postMessage");
    const settingsPage = createMockBridge({ shared: true, keys: false, storage: null, params: new URLSearchParams("?track=1&paused&media=no-player") });
    const overlay = createMockBridge({ shared: true, keys: false, storage: null, params: new URLSearchParams("?track=1&paused") });
    open.push(settingsPage, overlay);
    const overlayMedia: MediaStatus[] = [];
    await overlay.listen("media-status", (m) => overlayMedia.push(m));

    // The overlay already sees the player; the settings page must follow anyway.
    overlay.setMedia(null);
    await vi.waitFor(async () => expect(await settingsPage.invoke("get_media_status")).toEqual({ source: "spotify", problem: null }));
    expect(await settingsPage.invoke("get_now_playing")).toMatchObject({ trackKey: key(1) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // One post, no echo, and nothing new on the page that didn't change.
    expect(post).toHaveBeenCalledTimes(1);
    expect(overlayMedia).toEqual([]);
  });
});

describe("mock bridge: other commands and lifetime", () => {
  it("does nothing for open_settings and quit outside a browser", async () => {
    const { bridge } = await mock();
    await expect(bridge.invoke("open_settings")).resolves.toBeUndefined();
    await expect(bridge.invoke("quit")).resolves.toBeUndefined();
  });

  it("stops delivering to a handler once unlistened", async () => {
    const { bridge } = await mock("?track=4");
    const got: (NowPlaying | null)[] = [];
    const unlisten = await bridge.listen("now-playing", (p) => got.push(p));
    await advance(1000);
    unlisten();
    await advance(3000);
    expect(got).toHaveLength(1);
  });

  it("stops every timer on dispose", async () => {
    const { bridge, seen } = await mock("?track=0&t=33000");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    bridge.dispose();
    expect(vi.getTimerCount()).toBe(0);
    seen.clear();
    await advance(120_000);
    expect(seen.nowPlaying).toEqual([]);
    expect(seen.lyrics).toEqual([]);
    expect(bridge.player.snapshot.track).toBe(0);
  });
});

describe("mock bridge: keyboard and window", () => {
  type KeyListener = (e: KeyboardEvent) => void;

  class FakeElement {
    private readonly editable: boolean;
    constructor(editable: boolean) {
      this.editable = editable;
    }
    closest(): object | null {
      return this.editable ? {} : null;
    }
  }

  function stubWindow(search = "?mock"): { added: Map<string, KeyListener>; removed: string[]; opened: unknown[][] } {
    const added = new Map<string, KeyListener>();
    const removed: string[] = [];
    const opened: unknown[][] = [];
    const href = `http://localhost:1420/${search}`;
    vi.stubGlobal("Element", FakeElement);
    vi.stubGlobal("location", { search, href });
    vi.stubGlobal("window", {
      location: { search, href },
      addEventListener: (type: string, fn: KeyListener) => added.set(type, fn),
      removeEventListener: (type: string) => removed.push(type),
      open: (...args: unknown[]) => opened.push(args),
    });
    return { added, removed, opened };
  }

  function press(fn: KeyListener | undefined, init: Partial<Record<"code" | "key", string>> & { shiftKey?: boolean; metaKey?: boolean; target?: unknown }): boolean {
    let prevented = false;
    const e = {
      code: "",
      key: "",
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: null,
      ...init,
      preventDefault: () => {
        prevented = true;
      },
    };
    fn?.(e as unknown as KeyboardEvent);
    return prevented;
  }

  it("maps Space, arrows and N to the player", async () => {
    const win = stubWindow();
    const { bridge } = await mock("?track=1&t=10000&paused", { keys: true });
    const onKey = win.added.get("keydown");
    expect(onKey).toBeTypeOf("function");

    expect(press(onKey, { code: "Space", key: " " })).toBe(true);
    expect(bridge.player.snapshot.isPlaying).toBe(true);
    press(onKey, { code: "Space", key: " " });
    expect(press(onKey, { key: "ArrowRight" })).toBe(true);
    expect(bridge.player.position()).toBe(15_000);
    press(onKey, { key: "ArrowLeft" });
    press(onKey, { key: "ArrowLeft" });
    expect(bridge.player.position()).toBe(5000);
    press(onKey, { key: "n" });
    expect(bridge.player.snapshot.track).toBe(2);
    press(onKey, { key: "N", shiftKey: true });
    press(onKey, { key: "N", shiftKey: true });
    expect(bridge.player.snapshot.track).toBe(0);
  });

  it("ignores modified keys, other keys and keys typed into controls", async () => {
    const win = stubWindow();
    const { bridge } = await mock("?track=1&t=10000&paused", { keys: true });
    const onKey = win.added.get("keydown");
    const before = bridge.player.snapshot;
    expect(press(onKey, { key: "ArrowRight", metaKey: true })).toBe(false);
    expect(press(onKey, { key: "x" })).toBe(false);
    expect(press(onKey, { code: "Space", key: " ", target: new FakeElement(true) })).toBe(false);
    expect(bridge.player.snapshot).toEqual(before);
    expect(press(onKey, { code: "Space", key: " ", target: new FakeElement(false) })).toBe(true);
  });

  it("removes the key listener on dispose", async () => {
    const win = stubWindow();
    const { bridge } = await mock("", { keys: true });
    bridge.dispose();
    expect(win.removed).toEqual(["keydown"]);
  });

  it("opens the settings page in mock mode", async () => {
    const win = stubWindow();
    const { bridge } = await mock();
    await bridge.invoke("open_settings");
    expect(win.opened).toHaveLength(1);
    const [url, name, features] = win.opened[0] ?? [];
    expect(String(url)).toBe("http://localhost:1420/settings.html?mock=");
    expect(name).toBe("undertone-settings");
    expect(features).toBe("width=380,height=640");
  });

  it("opens the settings page with this page's media problem", async () => {
    const win = stubWindow("?mock&media=no-player");
    const { bridge } = await mock("?mock&media=no-player");
    await bridge.invoke("open_settings");
    expect(String(win.opened[0]?.[0])).toBe("http://localhost:1420/settings.html?mock=&media=no-player");
    bridge.setMedia("automation-denied");
    await bridge.invoke("open_settings");
    expect(String(win.opened[1]?.[0])).toBe("http://localhost:1420/settings.html?mock=&media=automation-denied");
    bridge.setMedia(null);
    await bridge.invoke("open_settings");
    expect(String(win.opened[2]?.[0])).toBe("http://localhost:1420/settings.html?mock=");
  });
});

describe("tauri bridge", () => {
  it("passes the command and its argument object through unchanged", async () => {
    const { createTauriBridge } = await import("../src/bridge/tauri");
    const bridge = createTauriBridge();
    expect(bridge.kind).toBe("tauri");
    tauri.invoke.mockResolvedValue(DEFAULT_SETTINGS);

    const args = { trackKey: "a|b|c|1", ms: 150 };
    await expect(bridge.invoke("set_track_offset", args)).resolves.toBe(DEFAULT_SETTINGS);
    expect(tauri.invoke).toHaveBeenLastCalledWith("set_track_offset", args);
    expect(tauri.invoke.mock.lastCall?.[1]).toBe(args);

    await bridge.invoke("get_lyrics", { trackKey: "k" });
    expect(tauri.invoke).toHaveBeenLastCalledWith("get_lyrics", { trackKey: "k" });
    await bridge.invoke("update_settings", { patch: { size: 40 } });
    expect(tauri.invoke).toHaveBeenLastCalledWith("update_settings", { patch: { size: 40 } });
  });

  it("passes undefined for commands without arguments", async () => {
    const { createTauriBridge } = await import("../src/bridge/tauri");
    const bridge = createTauriBridge();
    tauri.invoke.mockResolvedValue(null);
    for (const command of ["get_settings", "get_now_playing", "open_settings", "quit"] as const) {
      await bridge.invoke(command);
      expect(tauri.invoke).toHaveBeenLastCalledWith(command, undefined);
      expect(tauri.invoke.mock.lastCall).toHaveLength(2);
    }
  });

  it("rejects when the core rejects", async () => {
    const { createTauriBridge } = await import("../src/bridge/tauri");
    tauri.invoke.mockRejectedValue(new Error("no such track"));
    await expect(createTauriBridge().invoke("refetch_lyrics", { trackKey: "x" })).rejects.toThrow("no such track");
  });

  it("unwraps the event payload and returns the unlisten function", async () => {
    const { createTauriBridge } = await import("../src/bridge/tauri");
    const unlisten = vi.fn();
    let deliver: ((e: { event: string; id: number; payload: unknown }) => void) | undefined;
    tauri.listen.mockImplementation((_name: string, fn: typeof deliver) => {
      deliver = fn;
      return Promise.resolve(unlisten);
    });
    const handler = vi.fn<(l: Lyrics) => void>();
    const result = await createTauriBridge().listen("lyrics", handler);
    expect(tauri.listen).toHaveBeenCalledWith("lyrics", expect.any(Function));
    expect(result).toBe(unlisten);

    const payload: Lyrics = { trackKey: "k", status: "found", synced: "[00:01.00]la", plain: null, source: "lrclib" };
    deliver?.({ event: "lyrics", id: 3, payload });
    expect(handler).toHaveBeenCalledWith(payload);
    expect(handler.mock.lastCall?.[0]).toBe(payload);
  });
});

describe("bridge selection", () => {
  function stubPage(search: string, tauriInternals: boolean): void {
    const win: Record<string, unknown> = {
      location: { search, href: `http://localhost:1420/${search}` },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    if (tauriInternals) win["__TAURI_INTERNALS__"] = {};
    vi.stubGlobal("window", win);
    vi.stubGlobal("location", win["location"]);
  }

  it("uses Tauri inside the app webview", async () => {
    stubPage("", true);
    const { connect, isTauri } = await import("../src/bridge/index");
    expect(isTauri()).toBe(true);
    expect((await connect()).kind).toBe("tauri");
  });

  it("uses the mock in a plain browser or with ?mock", async () => {
    const { connect, isTauri } = await import("../src/bridge/index");
    stubPage("", false);
    expect(isTauri()).toBe(false);
    stubPage("?mock", true);
    expect(isTauri()).toBe(false);
    const bridge = await connect();
    expect(bridge.kind).toBe("mock");
    (bridge as MockBridge).dispose();
  });
});

describe("mock bridge: default storage", () => {
  it("uses localStorage when the page has it", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: { mode: "drift" } });
    vi.stubGlobal("localStorage", storage);
    const bridge = createMockBridge({ shared: false, keys: false, params: new URLSearchParams() });
    open.push(bridge);
    expect((await bridge.invoke("get_settings")).mode).toBe("drift");
    expect(storage.data.has(PLAYER_KEY)).toBe(true);
  });

  it("runs without storage when localStorage is blocked", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      const bridge = createMockBridge({ shared: false, keys: false, params: new URLSearchParams("?track=2") });
      open.push(bridge);
      expect(bridge.player.snapshot.track).toBe(2);
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});

describe("demo covers with a canvas", () => {
  interface FakeCanvas {
    width: number;
    height: number;
    getContext(kind: string): unknown;
    toDataURL(type: string): string;
  }

  /** A document whose canvases record 2D calls. A fresh covers module is loaded so its cache starts empty. */
  async function withCanvas(context: boolean): Promise<{ covers: typeof import("../src/bridge/covers"); canvases: FakeCanvas[]; calls: string[] }> {
    const canvases: FakeCanvas[] = [];
    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_target, prop) => (..._args: unknown[]) => {
          calls.push(String(prop));
          return { addColorStop: () => {} };
        },
        set: (_target, prop) => {
          calls.push(`=${String(prop)}`);
          return true;
        },
      },
    );
    vi.stubGlobal("document", {
      createElement: (tag: string): FakeCanvas => {
        expect(tag).toBe("canvas");
        const canvas: FakeCanvas = {
          width: 0,
          height: 0,
          getContext: (kind) => (kind === "2d" && context ? ctx : null),
          toDataURL: (type) => `data:${type};base64,cover${canvases.length}`,
        };
        canvases.push(canvas);
        return canvas;
      },
    });
    vi.resetModules();
    return { covers: await import("../src/bridge/covers"), canvases, calls };
  }

  it("draws every cover once at 240 px and caches the data URL", async () => {
    const { covers, canvases, calls } = await withCanvas(true);
    expect(covers.COVER_COUNT).toBe(3);
    const urls = Array.from({ length: covers.COVER_COUNT }, (_, i) => covers.demoCover(i));
    expect(urls).toEqual(["data:image/png;base64,cover1", "data:image/png;base64,cover2", "data:image/png;base64,cover3"]);
    expect(canvases.map((c) => [c.width, c.height])).toEqual([
      [240, 240],
      [240, 240],
      [240, 240],
    ]);
    expect(calls).toContain("fillRect");
    const drawn = calls.length;
    expect(covers.demoCover(1)).toBe(urls[1]);
    expect(canvases).toHaveLength(3);
    expect(calls).toHaveLength(drawn);
  });

  it("returns null for an unknown cover or when there is no 2D context", async () => {
    const { covers, canvases } = await withCanvas(false);
    expect(covers.demoCover(-1)).toBeNull();
    expect(covers.demoCover(covers.COVER_COUNT)).toBeNull();
    expect(canvases).toHaveLength(0);
    expect(covers.demoCover(0)).toBeNull();
    expect(canvases).toHaveLength(1);
  });
});
