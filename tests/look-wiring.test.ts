import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Lyrics, type NowPlaying } from "../contract/contract";
import { MOCK_TRACKS, lyricsOf, trackKeyOf, type MockTrack } from "../src/bridge/mock";
import type { ArgsOf, Bridge, Command, Event, Events, ResultOf, Unlisten } from "../src/bridge/types";
import { FONTS } from "../src/core/faces";
import { stripLrc } from "../src/core/lrc";
import { PaletteCache, type CoverStats, type Palette } from "../src/core/palette";
import { lookLabel, pickLook, songFeatures, timingOf, type SongLook } from "../src/core/songlook";
import {
  ARTWORK_GRACE_MS,
  COMMIT_LEAD_MS,
  DECODE_WAIT_MS,
  LOOK_MEMORY,
  LookMemory,
  OverlayController,
  untilSung,
  type ControllerOptions,
} from "../src/overlay/controller";
import { DEFAULT_PICK, pickedOf, type PickedLook } from "../src/overlay/look";
import type { LookChange, LyricStage, StageView } from "../src/overlay/stage";
import { viewFor } from "../src/overlay/view";

// The song's look through the overlay controller (SPEC §4.6): when it commits, how it refines, and
// that it is the picker's own answer for the mock tracks. All lyrics are the mock's original
// placeholder text.

const T0 = 1_760_000_000_000;

/**
 * coverStats of the mock's demo covers (src/bridge/covers.ts) as Chromium samples them at 48×48: the
 * numbers tests/songlook.test.ts pins. In node the covers can't be drawn, so stand-in artwork
 * (`data:demo/N`) decodes to stand-in pixels and reports these.
 */
const DEMO_COVERS: readonly CoverStats[] = [
  { lightness: 0.239, contrast: 0.17, chroma: 0.263, colorfulness: 0.749, warmth: 0.161, gray: 0.084, hue: 0.039 },
  { lightness: 0.579, contrast: 0.273, chroma: 0.22, colorfulness: 0.577, warmth: -0.05, gray: 0.021, hue: 0.373 },
  { lightness: 0.434, contrast: 0.102, chroma: 0.482, colorfulness: 0.721, warmth: -0.616, gray: 0, hue: 0.748 },
  // a stand-in no mock track has: a dark gray cover, which moves Neon Monsoon from Arc to Drift
  { lightness: 0.12, contrast: 0.06, chroma: 0.03, colorfulness: 0.04, warmth: 0, gray: 0.95, hue: null },
];
/** The dark gray stand-in cover. */
const DARK_COVER = "data:demo/3";
const PIXELS = new Uint8ClampedArray(48 * 48 * 4).map((_, i) => [40, 90, 200, 255][i % 4] ?? 0);
const statsOf = (artwork: string | null | undefined): CoverStats | null => {
  const m = /^data:demo\/(\d+)$/u.exec(artwork ?? "");
  return m ? (DEMO_COVERS[Number(m[1])] ?? null) : null;
};

/** Decodes at once, or, while held, once released: a slow decode. */
class DecodeGate {
  held = false;
  reads = 0;
  private queue: (() => void)[] = [];
  read(artwork: string): Promise<ArrayLike<number> | null> {
    this.reads++;
    const px = statsOf(artwork) ? PIXELS : null;
    if (!this.held) return Promise.resolve(px);
    return new Promise((resolve) => this.queue.push(() => resolve(px)));
  }
  release(): void {
    this.held = false;
    for (const go of this.queue.splice(0)) go();
  }
}

/** A palette cache whose covers read as the demo covers do in Chromium. */
class DemoPalettes extends PaletteCache {
  readonly gate: DecodeGate;
  private readonly art = new Map<string, string | null>();
  constructor(gate = new DecodeGate()) {
    super((artwork) => gate.read(artwork));
    this.gate = gate;
  }
  override get(trackKey: string, artwork: string | null): Promise<Palette | null> {
    this.art.set(trackKey, artwork);
    return super.get(trackKey, artwork);
  }
  override cover(trackKey: string): CoverStats | null {
    return super.cover(trackKey) ? statsOf(this.art.get(trackKey)) : null;
  }
}

/** A bridge whose events go straight to the handlers. */
class FakeBridge implements Bridge {
  readonly kind = "tauri" as const;
  private readonly handlers = new Map<Event, Set<(payload: never) => void>>();
  readonly answers: Partial<{ [C in Command]: (...args: ArgsOf<C>) => ResultOf<C> }> = {};

  invoke<C extends Command>(command: C, ...args: ArgsOf<C>): Promise<ResultOf<C>> {
    const answer = this.answers[command] as ((...a: ArgsOf<C>) => ResultOf<C>) | undefined;
    return Promise.resolve(answer ? answer(...args) : (undefined as ResultOf<C>));
  }

  listen<E extends Event>(event: E, handler: (payload: Events[E]) => void): Promise<Unlisten> {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (payload: never) => void);
    this.handlers.set(event, set);
    return Promise.resolve(() => set.delete(handler as (payload: never) => void));
  }

  emit<E extends Event>(event: E, payload: Events[E]): void {
    for (const h of this.handlers.get(event) ?? []) (h as (p: Events[E]) => void)(payload);
  }
}

interface Shown {
  kind: StageView["kind"];
  key: string;
  /** the look the scene came in with */
  look: PickedLook | null | undefined;
}

/** Records the scenes and looks the controller hands over; answers atSafePoint as told. */
class FakeStage {
  scenes: Shown[] = [];
  changes: [PickedLook | null, LookChange][] = [];
  /** the look it draws with now */
  drawn: PickedLook = DEFAULT_PICK;
  /** what atSafePoint answers */
  safe = false;
  wakesForWords = true;
  private readonly listeners = new Set<() => void>();
  show(view: StageView, key: string, look?: PickedLook | null): void {
    this.scenes.push({ kind: view.kind, key, look });
    if (look !== undefined) this.drawn = look ?? DEFAULT_PICK;
  }
  setPickedLook(look: PickedLook | null, how: LookChange = "now"): void {
    this.changes.push([look, how]);
    this.drawn = look ?? DEFAULT_PICK;
  }
  atSafePoint(): boolean {
    return this.safe;
  }
  addSafePointListener(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  /** The stage reaches a safe point: a focus-line change, a break starting. */
  reachSafePoint(): void {
    for (const fn of [...this.listeners]) fn();
  }
  get listening(): number {
    return this.listeners.size;
  }
  /** The last scene shown, and the lyrics scenes. */
  get last(): Shown | undefined {
    return this.scenes[this.scenes.length - 1];
  }
  lyricScenes(key?: string): Shown[] {
    return this.scenes.filter((s) => s.kind === "lyrics" && (key === undefined || s.key === key));
  }
  setPalette(_palette: Palette | null): void {}
  setSettings(): void {}
  setVisible(): void {}
  setPaused(): void {}
  render(): boolean {
    return false;
  }
  nextChange(): number {
    return Infinity;
  }
  retime(): boolean {
    return false;
  }
}

const mock = (title: string): MockTrack => {
  const t = MOCK_TRACKS.find((x) => x.title === title);
  if (!t) throw new Error(`no mock track "${title}"`);
  return t;
};
const art = (t: MockTrack): string | null => (t.cover === null ? null : `data:demo/${t.cover}`);
const playing = (t: MockTrack, over: Partial<NowPlaying> = {}): NowPlaying => ({
  source: "spotify",
  trackKey: trackKeyOf(t),
  title: t.title,
  artist: t.artist,
  album: t.album,
  durationMs: t.durationMs,
  positionMs: 0,
  sampledAt: Date.now(),
  isPlaying: true,
  artwork: null,
  ...over,
});
const loading = (t: MockTrack): Lyrics => ({ trackKey: trackKeyOf(t), status: "loading", synced: null, plain: null, source: "lrclib" });
/** The track's synced lyrics reported as plain text first, as a stale plain-only cache entry would. */
const plainFirst = (t: MockTrack): Lyrics => ({ trackKey: trackKeyOf(t), status: "plain-only", synced: null, plain: stripLrc(t.synced ?? ""), source: "cache" });

/** What the picker itself makes of a mock track: its lyrics as the stage takes them, with or without its cover (or `artwork`). */
function picked(t: MockTrack, withCover: boolean, lyrics: Lyrics = lyricsOf(t), artwork: string | null = art(t)): SongLook {
  const view = viewFor(lyrics, t.durationMs);
  const timeline = view.kind === "lyrics" ? view.timeline : null;
  return pickLook(
    songFeatures({
      track: { trackKey: trackKeyOf(t), title: t.title, album: t.album, durationMs: t.durationMs },
      lines: timeline?.lines ?? [],
      timing: timingOf(lyrics, timeline),
      cover: withCover ? statsOf(artwork) : null,
    }),
  );
}

/** Same on screen: the PickedLook fields. */
const drawnAs = (look: PickedLook | null | undefined): PickedLook | null => (look ? pickedOf(look) : null);

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
async function after(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

interface Rig {
  bridge: FakeBridge;
  stage: FakeStage;
  palettes: DemoPalettes;
  controller: OverlayController;
  heard: (SongLook | null)[];
  /** a track starts (positionMs 0 unless given), its artwork `artwork` (none by default) */
  start(t: MockTrack, over?: Partial<NowPlaying>): Promise<void>;
  lyrics(l: Lyrics): Promise<void>;
  /** the playing track's artwork arrives, `ms` into it */
  artwork(t: MockTrack, over?: Partial<NowPlaying>): Promise<void>;
}

async function rig(options: ControllerOptions = {}, palettes = new DemoPalettes()): Promise<Rig> {
  const bridge = new FakeBridge();
  const stage = new FakeStage();
  const heard: (SongLook | null)[] = [];
  bridge.answers.get_settings = () => structuredClone(DEFAULT_SETTINGS);
  bridge.answers.get_now_playing = () => null;
  // the initial query never beats the events here
  bridge.answers.get_lyrics = ({ trackKey }) => ({ trackKey, status: "loading", synced: null, plain: null, source: "lrclib" });
  const controller = new OverlayController(bridge, stage as unknown as LyricStage, { palettes, onLook: (l) => heard.push(l), ...options });
  await controller.start();
  let startedAt = Date.now();
  let position = 0;
  const sample = (t: MockTrack, over: Partial<NowPlaying>): NowPlaying => {
    const elapsed = Date.now() - startedAt;
    return playing(t, { positionMs: position + elapsed, sampledAt: Date.now(), ...over });
  };
  return {
    bridge,
    stage,
    palettes,
    controller,
    heard,
    async start(t, over = {}) {
      startedAt = Date.now();
      position = over.positionMs ?? 0;
      bridge.emit("now-playing", playing(t, { positionMs: position, sampledAt: startedAt, ...over }));
      await flush();
    },
    async lyrics(l) {
      bridge.emit("lyrics", l);
      await flush();
    },
    async artwork(t, over = {}) {
      bridge.emit("now-playing", sample(t, { artwork: art(t), ...over }));
      await flush();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("untilSung", () => {
  const lines = viewFor(lyricsOf(mock("Paper Lanterns")), 24_000);
  const all = lines.kind === "lyrics" ? lines.timeline.lines : [];

  it("is 0 while a line is sung, the time to the next one between lines, Infinity after the last", () => {
    expect(untilSung(all, 0)).toBe(1000);
    expect(untilSung(all, 1200)).toBe(0);
    // the marked gap (9 s) is no line: the next starts at 12.5 s
    expect(untilSung(all, 9500)).toBe(3000);
    expect(untilSung(all, 60_000)).toBe(Infinity);
    expect(untilSung([], 0)).toBe(Infinity);
  });
});

describe("the provisional look", () => {
  it("covers loading, not found and instrumental: no lyrics, the picker's own answer, drawn at once", async () => {
    const r = await rig();
    const t = mock("Tidal Interlude");
    await r.start(t);
    expect(r.stage.last).toMatchObject({ kind: "loading", key: trackKeyOf(t) });
    expect(r.heard).toHaveLength(1);
    const provisional = r.heard[0];
    expect(provisional?.traits).toContain("no lyrics");
    expect(provisional).toEqual(picked(t, false));
    expect(r.stage.last?.look).toEqual(drawnAs(provisional));
    // a state shows at once, in the provisional look
    await r.lyrics(lyricsOf(t));
    expect(r.stage.last).toMatchObject({ kind: "instrumental", look: drawnAs(provisional) });
    // no artwork, ever: nothing more to know
    await after(5000);
    expect(r.heard).toHaveLength(1);
    expect(r.stage.changes).toEqual([]);
    r.controller.destroy();
  });

  it("takes the cover in as soon as it is decoded, at once (only a state shows)", async () => {
    const r = await rig();
    const t = mock("Ultraviolet Static");
    await r.start(t);
    await r.lyrics(lyricsOf(t));
    expect(r.stage.last?.kind).toBe("not-found");
    await after(250);
    await r.artwork(t);
    const withCover = picked(t, true);
    expect(r.heard[r.heard.length - 1]).toEqual(withCover);
    expect(r.heard[r.heard.length - 1]?.traits).toContain("no lyrics");
    expect(r.stage.changes[r.stage.changes.length - 1]).toEqual([drawnAs(withCover), "now"]);
    r.controller.destroy();
  });
});

describe("commit timing (SPEC §4.6)", () => {
  it("commits at once when the cover is known by the time the lyrics arrive", async () => {
    const r = await rig();
    const t = mock("Paper Lanterns");
    await r.start(t, { artwork: art(t) });
    await r.lyrics(lyricsOf(t));
    const look = picked(t, true);
    expect(r.stage.lyricScenes()).toEqual([{ kind: "lyrics", key: trackKeyOf(t), look: drawnAs(look) }]);
    expect(r.heard[r.heard.length - 1]).toEqual(look);
    expect(r.heard[r.heard.length - 1]).toBe(r.controller.songLook);
    r.controller.destroy();
  });

  it("keeps the loading view while the cover may still come, and commits with it as soon as it is decoded", async () => {
    const r = await rig();
    const t = mock("Glass Harbor"); // first line at 5.4 s
    await r.start(t);
    await after(100);
    await r.lyrics(lyricsOf(t));
    expect(r.stage.lyricScenes()).toEqual([]);
    expect(r.stage.last?.kind).toBe("loading");
    expect(r.heard.every((l) => l?.traits.includes("no lyrics"))).toBe(true);
    await after(400);
    await r.artwork(t);
    const look = picked(t, true);
    expect(r.stage.lyricScenes()).toEqual([{ kind: "lyrics", key: trackKeyOf(t), look: drawnAs(look) }]);
    expect(r.heard[r.heard.length - 1]).toEqual(look);
    expect(look.traits).toContain("cold cover");
    r.controller.destroy();
  });

  it(`commits without a cover ${ARTWORK_GRACE_MS} ms into the track, and an unreadable cover counts as known`, async () => {
    const r = await rig();
    const t = mock("Glass Harbor");
    await r.start(t);
    await r.lyrics(lyricsOf(t));
    await after(ARTWORK_GRACE_MS - 1);
    expect(r.stage.lyricScenes()).toEqual([]);
    await after(1);
    expect(r.stage.lyricScenes()).toEqual([{ kind: "lyrics", key: trackKeyOf(t), look: drawnAs(picked(t, false)) }]);
    r.controller.destroy();

    const u = await rig();
    await u.start(t, { artwork: "data:unreadable" });
    await u.lyrics(lyricsOf(t));
    expect(u.stage.lyricScenes()).toEqual([{ kind: "lyrics", key: trackKeyOf(t), look: drawnAs(picked(t, false)) }]);
    u.controller.destroy();
  });

  it(`never holds lyrics back from a line about to be sung: one being sung or starting within ${COMMIT_LEAD_MS} ms shows at once`, async () => {
    const t = mock("Neon Monsoon"); // first line at 0.8 s
    const early = await rig();
    await early.start(t);
    await after(300);
    await early.lyrics(lyricsOf(t));
    expect(early.stage.lyricScenes()).toEqual([{ kind: "lyrics", key: trackKeyOf(t), look: drawnAs(picked(t, false)) }]);
    early.controller.destroy();

    const mid = await rig();
    await mid.start(t, { positionMs: 12_000 });
    await mid.lyrics(lyricsOf(t));
    expect(mid.stage.lyricScenes()).toHaveLength(1);
    mid.controller.destroy();
  });

  it(`holds lyrics until ${COMMIT_LEAD_MS} ms before the next line at the latest, following seeks and pauses`, async () => {
    const t = mock("Neon Monsoon");
    const r = await rig();
    await r.start(t);
    await r.lyrics(lyricsOf(t));
    await after(800 - COMMIT_LEAD_MS - 1);
    expect(r.stage.lyricScenes()).toEqual([]);
    await after(1);
    expect(r.stage.lyricScenes()).toHaveLength(1);
    r.controller.destroy();

    // paused before the first line: only the grace runs out
    const paused = await rig();
    await paused.start(t, { isPlaying: false });
    await paused.lyrics(lyricsOf(t));
    await after(400);
    expect(paused.stage.lyricScenes()).toEqual([]);
    // a seek into a line shows them at once
    paused.bridge.emit("now-playing", playing(t, { isPlaying: false, positionMs: 5000, sampledAt: Date.now() }));
    await flush();
    expect(paused.stage.lyricScenes()).toHaveLength(1);
    paused.controller.destroy();
  });

  it(`waits for a cover decode already under way, ${DECODE_WAIT_MS} ms at most, rather than commit a look it would refine`, async () => {
    const t = mock("Neon Monsoon");
    // a window opened mid-song: the cover is decoding as the lyrics come
    const gate = new DecodeGate();
    gate.held = true;
    const r = await rig({}, new DemoPalettes(gate));
    await r.start(t, { positionMs: 12_000, artwork: art(t) });
    await r.lyrics(lyricsOf(t));
    expect(r.stage.lyricScenes()).toEqual([]);
    await after(20);
    gate.release();
    await flush();
    expect(r.stage.lyricScenes()).toEqual([{ kind: "lyrics", key: trackKeyOf(t), look: drawnAs(picked(t, true)) }]);
    r.controller.destroy();

    // a decode that takes longer isn't waited for
    const slow = new DecodeGate();
    slow.held = true;
    const s = await rig({}, new DemoPalettes(slow));
    await s.start(t, { positionMs: 12_000, artwork: art(t) });
    await s.lyrics(lyricsOf(t));
    await after(DECODE_WAIT_MS - 1);
    expect(s.stage.lyricScenes()).toEqual([]);
    await after(1);
    expect(s.stage.lyricScenes()).toEqual([{ kind: "lyrics", key: trackKeyOf(t), look: drawnAs(picked(t, false)) }]);
    s.controller.destroy();
  });

  it("drops lyrics still held back when the track changes", async () => {
    const r = await rig();
    const a = mock("Glass Harbor");
    const b = mock("Tidal Interlude");
    await r.start(a);
    await r.lyrics(lyricsOf(a));
    await r.start(b);
    await after(5000);
    expect(r.stage.lyricScenes()).toEqual([]);
    r.controller.destroy();
  });
});

describe("refinement (SPEC §4.6)", () => {
  /** Neon Monsoon committed without its cover (its first line was due): Arc · Fraunces. A dark gray cover makes it Drift · Fraunces. */
  async function committedWithoutCover(): Promise<{ r: Rig; t: MockTrack }> {
    const r = await rig();
    const t = mock("Neon Monsoon");
    await r.start(t);
    await after(300);
    await r.lyrics(lyricsOf(t));
    expect(lookLabel(r.controller.look)).toBe("Arc · Fraunces");
    return { r, t };
  }

  it("brings late artwork in once, only at a safe point, crossfading", async () => {
    const { r, t } = await committedWithoutCover();
    const committed = r.controller.songLook;
    await after(1000);
    await r.artwork(t, { artwork: DARK_COVER });
    // mid-line: nothing changes yet
    expect(r.stage.changes).toEqual([]);
    expect(r.controller.songLook).toBe(committed);
    r.stage.reachSafePoint();
    const refined = picked(t, true, lyricsOf(t), DARK_COVER);
    expect(lookLabel(refined)).toBe("Drift · Fraunces");
    expect(r.stage.changes).toEqual([[drawnAs(refined), "crossfade"]]);
    expect(r.heard[r.heard.length - 1]).toEqual(refined);
    // one refinement per song: a new picture and later safe points change nothing
    await r.artwork(t, { artwork: "data:demo/2" });
    r.stage.reachSafePoint();
    await after(3000);
    r.stage.reachSafePoint();
    expect(r.stage.changes).toHaveLength(1);
    r.controller.destroy();
  });

  it("crossfades a refinement in at once when it comes at a safe point (a break, before the first line)", async () => {
    const { r, t } = await committedWithoutCover();
    r.stage.safe = true;
    await r.artwork(t, { artwork: DARK_COVER });
    expect(r.stage.changes).toEqual([[drawnAs(picked(t, true, lyricsOf(t), DARK_COVER)), "crossfade"]]);
    r.controller.destroy();
  });

  it("brings synced lyrics that replace plain ones in with their scene, once", async () => {
    const r = await rig();
    const t = mock("Neon Monsoon");
    await r.start(t, { artwork: art(t) });
    await r.lyrics(plainFirst(t));
    const plain = picked(t, true, plainFirst(t));
    expect(plain.style).toBe("stack");
    expect(r.stage.lyricScenes()).toEqual([{ kind: "lyrics", key: trackKeyOf(t), look: drawnAs(plain) }]);
    await after(8000);
    await r.lyrics(lyricsOf(t));
    const synced = picked(t, true);
    expect(synced.style).toBe("arc");
    // the scene change is the safe point: the new scene comes in with the new look
    expect(r.stage.lyricScenes()).toEqual([
      { kind: "lyrics", key: trackKeyOf(t), look: drawnAs(plain) },
      { kind: "lyrics", key: trackKeyOf(t), look: drawnAs(synced) },
    ]);
    expect(r.heard[r.heard.length - 1]).toEqual(synced);
    // only the provisional look changed in place (its cover, while "loading" showed)
    const inPlace = r.stage.changes.length;
    expect(r.stage.changes.map(([, how]) => how)).toEqual(["now"]);
    // and that was the one: plain again (a refetch) and back change nothing
    await r.lyrics(plainFirst(t));
    await r.lyrics(lyricsOf(t));
    r.stage.reachSafePoint();
    expect(r.stage.lyricScenes().map((s) => s.look)).toEqual([plain, synced, synced, synced].map(drawnAs));
    expect(r.stage.changes).toHaveLength(inPlace);
    r.controller.destroy();
  });

  it("listens for the stage's safe points itself, and stops when destroyed", async () => {
    const r = await rig();
    expect(r.stage.listening).toBe(1);
    r.controller.destroy();
    expect(r.stage.listening).toBe(0);
  });
});

describe("remembered looks", () => {
  it("give a song played again its committed look at once, without waiting for its cover", async () => {
    const r = await rig();
    const t = mock("Neon Monsoon");
    const other = mock("Paper Lanterns");
    await r.start(t);
    await after(300);
    await r.lyrics(lyricsOf(t));
    await r.artwork(t);
    r.stage.reachSafePoint();
    const final = r.controller.songLook;
    expect(final && lookLabel(final)).toBe("Arc · Fraunces");

    await r.start(other, { artwork: art(other) });
    await r.lyrics(lyricsOf(other));
    expect(r.controller.songLook).toEqual(picked(other, true));

    // played again: the same look from the first moment, the same object onLook heard before
    const heard = r.heard.length;
    await r.start(t);
    expect(r.stage.last).toMatchObject({ kind: "loading", look: drawnAs(final) });
    expect(r.heard[heard]).toBe(final);
    // its lyrics show at once (nothing to wait for), with no cover yet
    await r.lyrics(lyricsOf(t));
    expect(r.stage.lyricScenes(trackKeyOf(t)).map((s) => s.look)).toEqual([drawnAs(picked(t, false)), drawnAs(final)]);
    await r.artwork(t);
    r.stage.reachSafePoint();
    expect(r.controller.songLook).toBe(final);
    r.controller.destroy();
  });

  it(`keep the ${LOOK_MEMORY} most recently used`, () => {
    const memory = new LookMemory();
    const look = (n: number): SongLook => ({ ...picked(mock("Paper Lanterns"), true), curve: n });
    for (let i = 0; i < LOOK_MEMORY; i++) memory.set(`k${i}`, look(i));
    expect(memory.size).toBe(LOOK_MEMORY);
    // a use keeps k0; the next new song pushes out the least recently used, k1
    expect(memory.get("k0")?.curve).toBe(0);
    memory.set("new", look(99));
    expect(memory.size).toBe(LOOK_MEMORY);
    expect(memory.get("k1")).toBeNull();
    expect(memory.get("k0")?.curve).toBe(0);
    expect(memory.get("new")?.curve).toBe(99);
  });

  it("can be shared by controllers, as a window's preview could", async () => {
    const looks = new LookMemory();
    const t = mock("Paper Lanterns");
    const a = await rig({ looks });
    await a.start(t, { artwork: art(t) });
    await a.lyrics(lyricsOf(t));
    a.controller.destroy();
    const b = await rig({ looks });
    await b.start(t);
    expect(b.controller.songLook).toBe(a.controller.songLook);
    b.controller.destroy();
  });
});

describe("what onLook hears", () => {
  it("is the keeper's SongLook itself, with its traits and reason: provisional, then committed; null without a track", async () => {
    const r = await rig();
    const t = mock("Paper Lanterns");
    await r.start(t, { artwork: art(t) });
    await r.lyrics(lyricsOf(t));
    const [provisional, ...rest] = r.heard;
    expect(provisional?.traits).toContain("no lyrics");
    expect(provisional?.reason).toMatch(/^no lyrics.* → /u);
    const committed = rest[rest.length - 1];
    expect(committed).toBe(r.controller.songLook);
    expect(committed?.traits).not.toContain("no lyrics");
    expect(committed?.reason).toBe(picked(t, true).reason);
    expect(committed?.scores.style.arc).toBeGreaterThan(0);
    // resyncs say nothing
    const count = r.heard.length;
    r.bridge.emit("now-playing", playing(t, { artwork: art(t), positionMs: 1000, sampledAt: Date.now() }));
    await flush();
    expect(r.heard).toHaveLength(count);
    r.bridge.emit("now-playing", null);
    expect(r.heard[r.heard.length - 1]).toBeNull();
    expect(r.controller.songLook).toBeNull();
    expect(r.controller.look).toEqual(DEFAULT_PICK);
    r.controller.destroy();
  });
});

describe("forced looks (QA)", () => {
  it("win over every song's pick, part by part, across track changes", async () => {
    const r = await rig();
    r.controller.forceLook({ style: "lens" });
    const sampler = mock("Script Sampler");
    await r.start(sampler, { artwork: art(sampler) });
    await r.lyrics(lyricsOf(sampler));
    const pick = picked(sampler, true);
    expect(pick.style).toBe("stack");
    // the style is forced, the face stays the song's
    expect(r.stage.last).toMatchObject({ kind: "lyrics", look: { ...drawnAs(pick), style: "lens" } });
    // onLook hears the look as drawn, with the song's reasons
    expect(r.heard[r.heard.length - 1]).toEqual({ ...pick, style: "lens" });

    const lanterns = mock("Paper Lanterns");
    await r.start(lanterns, { artwork: art(lanterns) });
    await r.lyrics(lyricsOf(lanterns));
    expect(r.stage.last?.look).toEqual({ ...drawnAs(picked(lanterns, true)), style: "lens" });

    r.controller.forceLook(null);
    expect(r.stage.changes[r.stage.changes.length - 1]).toEqual([drawnAs(picked(lanterns, true)), "now"]);
    expect(r.heard[r.heard.length - 1]).toBe(r.controller.songLook);
    r.controller.destroy();
  });

  it("outlast a refinement too", async () => {
    const r = await rig();
    r.controller.forceLook({ style: "drift", font: "Caveat" });
    const t = mock("Neon Monsoon");
    await r.start(t);
    await after(300);
    await r.lyrics(lyricsOf(t));
    await r.artwork(t);
    r.stage.reachSafePoint();
    expect(r.stage.drawn).toEqual({ ...drawnAs(picked(t, true)), style: "drift", font: { family: "Caveat", weight: 600 } });
    r.controller.destroy();
  });
});

describe("the mock tracks through the controller", () => {
  /** Plays every mock track the way the mock bridge does (artwork 250 ms in, lyrics 400 ms in) and returns the look each is drawn with. */
  async function drawnLooks(): Promise<Map<string, { look: SongLook | null; drawn: PickedLook | null | undefined; kind: StageView["kind"] | undefined }>> {
    const r = await rig();
    const out = new Map<string, { look: SongLook | null; drawn: PickedLook | null | undefined; kind: StageView["kind"] | undefined }>();
    for (const t of MOCK_TRACKS) {
      await r.start(t);
      await after(250);
      if (t.cover !== null) await r.artwork(t);
      await after(150);
      await r.lyrics(lyricsOf(t));
      await after(2000);
      out.set(t.title, { look: r.controller.songLook, drawn: r.stage.last?.look, kind: r.stage.last?.kind });
    }
    r.controller.destroy();
    return out;
  }

  it("draw each song in the picker's own look for it: different songs, different styles", async () => {
    const looks = await drawnLooks();
    const of = (title: string) => looks.get(title);
    for (const t of MOCK_TRACKS) {
      const got = of(t.title);
      expect(got?.look, t.title).toEqual(picked(t, t.cover !== null));
      expect(got?.drawn, t.title).toEqual(drawnAs(got?.look));
    }
    // the script sampler and plain lyrics get the readable list; Paper Lanterns and Glass Harbor their curve
    expect(of("Script Sampler")?.look?.style).toBe("stack");
    expect(FONTS.find((f) => f.family === of("Script Sampler")?.look?.font.family)?.vietnamese).toBe(true);
    expect(of("Letters Never Sent")?.look?.style).toBe("stack");
    expect(of("Letters Never Sent")?.look?.emphasis).toBeNull();
    for (const title of ["Paper Lanterns", "Glass Harbor", "Neon Monsoon"]) expect(lookLabel(of(title)?.look ?? DEFAULT_PICK), title).toBe("Arc · Fraunces");
    // the songs without lyrics keep a provisional look over their state
    expect(of("Ultraviolet Static")).toMatchObject({ kind: "not-found" });
    expect(of("Ultraviolet Static")?.look?.traits).toContain("no lyrics");
    expect(of("Tidal Interlude")).toMatchObject({ kind: "instrumental" });
    const styles = new Set([...looks.values()].filter((l) => l.kind === "lyrics").map((l) => l.drawn?.style));
    expect(styles.size).toBeGreaterThanOrEqual(2);
  });

  it("are deterministic: two windows on the same bridge draw every song alike", async () => {
    const bridge = new FakeBridge();
    bridge.answers.get_settings = () => structuredClone(DEFAULT_SETTINGS);
    bridge.answers.get_now_playing = () => null;
    bridge.answers.get_lyrics = ({ trackKey }) => ({ trackKey, status: "loading", synced: null, plain: null, source: "lrclib" });
    // an overlay and the settings preview: each its own stage, palette cache and keeper
    const stages = [new FakeStage(), new FakeStage()];
    const controllers = [
      new OverlayController(bridge, stages[0] as unknown as LyricStage, { gate: true, palettes: new DemoPalettes() }),
      new OverlayController(bridge, stages[1] as unknown as LyricStage, { followSettings: false, palettes: new DemoPalettes() }),
    ];
    for (const c of controllers) await c.start();
    for (const t of MOCK_TRACKS) {
      bridge.emit("now-playing", playing(t, { sampledAt: Date.now() }));
      await after(250);
      if (t.cover !== null) bridge.emit("now-playing", playing(t, { positionMs: 250, sampledAt: Date.now(), artwork: art(t) }));
      await after(150);
      bridge.emit("lyrics", lyricsOf(t));
      await after(1600);
      expect(controllers[0]?.songLook, t.title).toEqual(controllers[1]?.songLook);
      expect(stages[0]?.scenes, t.title).toEqual(stages[1]?.scenes);
    }
    for (const c of controllers) c.destroy();
  });
});

describe("teardown", () => {
  it("commits nothing after destroy", async () => {
    const r = await rig();
    const t = mock("Glass Harbor");
    await r.start(t);
    await r.lyrics(lyricsOf(t));
    r.controller.destroy();
    await after(5000);
    expect(r.stage.lyricScenes()).toEqual([]);
  });

  it("loading lyrics again for a song shows nothing new until they're in", async () => {
    const r = await rig();
    const t = mock("Paper Lanterns");
    await r.start(t, { artwork: art(t) });
    await r.lyrics(loading(t));
    // nothing playing at start, then the track's "loading", and no second one
    expect(r.stage.scenes.map((s) => s.kind)).toEqual(["none", "loading"]);
    r.controller.destroy();
  });
});
