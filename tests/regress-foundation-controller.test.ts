import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Lyrics, type NowPlaying, type Settings } from "../contract/contract";
import type { ArgsOf, Bridge, Command, Event, Events, ResultOf, Unlisten } from "../src/bridge/types";
import { PaletteCache, type Palette } from "../src/core/palette";
import { OverlayController } from "../src/overlay/controller";
import type { LyricStage, StageView } from "../src/overlay/stage";

const T0 = 1_760_000_000_000;

/** A bridge whose events go straight to the handlers, and whose command replies wait until released. */
class FakeBridge implements Bridge {
  readonly kind = "tauri" as const;
  private readonly handlers = new Map<Event, Set<(payload: never) => void>>();
  private readonly pending: { command: Command; resolve: (v: unknown) => void; value: () => unknown }[] = [];
  readonly answers: Partial<{ [C in Command]: () => ResultOf<C> }> = {};
  holdReplies = false;

  invoke<C extends Command>(command: C, ..._args: ArgsOf<C>): Promise<ResultOf<C>> {
    const answer = this.answers[command] as (() => ResultOf<C>) | undefined;
    const value = (): unknown => (answer ? answer() : undefined);
    if (!this.holdReplies) return Promise.resolve(value() as ResultOf<C>);
    return new Promise((resolve) => this.pending.push({ command, resolve: resolve as (v: unknown) => void, value }));
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

  /** Sends the held reply to `command`, as it was when the command was sent. */
  release(command: Command, value?: unknown): void {
    const i = this.pending.findIndex((p) => p.command === command);
    const [p] = this.pending.splice(i, 1);
    p?.resolve(value === undefined ? p.value() : value);
  }

  get waiting(): Command[] {
    return this.pending.map((p) => p.command);
  }
}

/** Records what the controller asks of the stage. */
class FakeStage {
  shows: string[] = [];
  palettes: (Palette | null)[] = [];
  settings: Settings[] = [];
  visible: boolean | null = null;
  paused: boolean | null = null;
  show(view: StageView, key: string): void {
    this.shows.push(`${view.kind} ${key}`);
  }
  setPalette(palette: Palette | null): void {
    this.palettes.push(palette);
  }
  setSettings(settings: Settings): void {
    this.settings.push(settings);
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
  }
  setPaused(paused: boolean): void {
    this.paused = paused;
  }
  /** What render returns: true while the stage has motion of its own in flight (a glide, Lens following a word). */
  busy = false;
  /** What nextChange returns: song time to the next word boundary, Infinity when nothing will change. */
  next = Infinity;
  /** When each paint happened (fake wall-clock ms). */
  frames: number[] = [];
  render(): boolean {
    this.frames.push(Date.now());
    return this.busy;
  }
  nextChange(): number {
    return this.next;
  }
}

const np = (trackKey: string, over: Partial<NowPlaying> = {}): NowPlaying => ({
  source: "spotify",
  trackKey,
  title: trackKey,
  artist: "Demo Artist",
  album: "Undertone Demo",
  durationMs: 60_000,
  positionMs: 0,
  sampledAt: Date.now(),
  isPlaying: true,
  artwork: null,
  ...over,
});

const lyrics = (trackKey: string): Lyrics => ({ trackKey, status: "loading", synced: null, plain: null, source: "lrclib" });

/** A cover's pixels: all one color, so the palette is deterministic. */
const PIXELS = new Uint8ClampedArray(48 * 48 * 4).map((_, i) => [40, 90, 200, 255][i % 4] ?? 0);

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function setup(gate = false): { bridge: FakeBridge; stage: FakeStage; controller: OverlayController } {
  const bridge = new FakeBridge();
  const stage = new FakeStage();
  bridge.answers.get_settings = () => structuredClone(DEFAULT_SETTINGS);
  bridge.answers.get_now_playing = () => null;
  bridge.answers.get_lyrics = () => lyrics("x");
  const palettes = new PaletteCache(async (art) => (art === "data:cover" ? PIXELS : null));
  const controller = new OverlayController(bridge, stage as unknown as LyricStage, { gate, palettes });
  return { bridge, stage, controller };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

// Regression (no-artwork-palette): every resync re-armed the 1.5 s artwork grace period, so while
// playing it never ran out, and a track without artwork kept the last album's colors all song.
describe("album colors for a track without artwork", () => {
  it("switch to the manual colors 1.5 s into the track, although resyncs keep coming", async () => {
    const { bridge, stage, controller } = setup();
    await controller.start();
    bridge.emit("now-playing", np("a", { artwork: "data:cover" }));
    await settle();
    expect(stage.palettes).toHaveLength(1);
    expect(stage.palettes[0]).not.toBeNull();

    bridge.emit("now-playing", np("b"));
    await settle();
    for (let ms = 250; ms <= 3000; ms += 250) {
      vi.advanceTimersByTime(250);
      // the core resyncs every second while playing
      if (ms % 1000 === 0) bridge.emit("now-playing", np("b", { positionMs: ms }));
      await settle();
      if (ms < 1500) expect(stage.palettes, `at ${ms} ms`).toHaveLength(1);
    }
    expect(stage.palettes).toHaveLength(2);
    expect(stage.palettes[1]).toBeNull();
    controller.destroy();
  });

  it("keeps the last colors when the art turns up within the grace period", async () => {
    const { bridge, stage, controller } = setup();
    await controller.start();
    bridge.emit("now-playing", np("a", { artwork: "data:cover" }));
    await settle();
    bridge.emit("now-playing", np("b"));
    await settle();
    vi.advanceTimersByTime(1000);
    bridge.emit("now-playing", np("b", { artwork: "data:cover", positionMs: 1000 }));
    await settle();
    vi.advanceTimersByTime(3000);
    await settle();
    expect(stage.palettes.filter((p) => p === null)).toHaveLength(0);
    expect(stage.palettes).toHaveLength(2);
    controller.destroy();
  });

  it("looks the palette up once per track and picture, not on every resync", async () => {
    const { bridge, controller } = setup();
    const palettes = new PaletteCache(async () => PIXELS);
    const get = vi.spyOn(palettes, "get");
    const c = new OverlayController(bridge, new FakeStage() as unknown as LyricStage, { palettes });
    controller.destroy();
    await c.start();
    bridge.emit("now-playing", np("a", { artwork: "data:cover" }));
    for (let i = 1; i <= 5; i++) bridge.emit("now-playing", np("a", { artwork: "data:cover", positionMs: i * 1000 }));
    await settle();
    expect(get).toHaveBeenCalledTimes(1);
    c.destroy();
  });
});

// Regression (controller-start-race): replies to get_settings / get_now_playing overwrote newer
// events that had overtaken them, and a sample the clock dropped as stale still became `track`.
describe("start-up races between events and replies", () => {
  it("keeps a pause that arrived before the older get_now_playing reply", async () => {
    const { bridge, stage, controller } = setup(true);
    bridge.holdReplies = true;
    const started = controller.start();
    await settle();
    bridge.release("get_settings");
    await settle();
    expect(bridge.waiting).toEqual(["get_now_playing"]);
    // the reply was taken while playing; the pause event overtakes it
    const reply = np("a", { isPlaying: true, sampledAt: T0 - 1000 });
    bridge.emit("now-playing", np("a", { isPlaying: false, positionMs: 2000, sampledAt: T0 }));
    bridge.release("get_now_playing", reply);
    await started;
    expect(controller.track?.isPlaying).toBe(false);
    expect(controller.clock.isPlaying).toBe(false);
    expect(stage.paused).toBe(true);
    expect(stage.visible).toBe(false);
    controller.destroy();
  });

  it("doesn't flip back to the previous song when its reply lands after the new song's event", async () => {
    const { bridge, stage, controller } = setup();
    bridge.holdReplies = true;
    const started = controller.start();
    await settle();
    bridge.release("get_settings");
    await settle();
    bridge.emit("now-playing", np("b"));
    bridge.release("get_now_playing", np("a", { sampledAt: T0 - 50 }));
    await started;
    expect(controller.track?.trackKey).toBe("b");
    expect(stage.shows).toEqual(["loading b"]);
    controller.destroy();
  });

  it("keeps a settings change that arrived before the get_settings reply", async () => {
    const { bridge, stage, controller } = setup();
    bridge.holdReplies = true;
    const started = controller.start();
    await settle();
    expect(bridge.waiting).toEqual(["get_settings"]);
    bridge.emit("settings-changed", { ...structuredClone(DEFAULT_SETTINGS), mode: "lens" });
    bridge.release("get_settings", { ...structuredClone(DEFAULT_SETTINGS), mode: "arc" });
    await settle();
    bridge.release("get_now_playing");
    await started;
    expect(stage.settings.map((s) => s.mode)).toEqual(["lens"]);
    controller.destroy();
  });

  it("applies the replies when no event beat them", async () => {
    const { bridge, stage, controller } = setup();
    bridge.answers.get_now_playing = () => np("a");
    await controller.start();
    expect(stage.settings).toHaveLength(1);
    expect(stage.shows).toEqual(["loading a"]);
    expect(controller.track?.trackKey).toBe("a");
    controller.destroy();
  });

  it("ignores a sample older than the clock's, so track and clock never disagree", async () => {
    const { bridge, controller } = setup();
    await controller.start();
    bridge.emit("now-playing", np("a", { isPlaying: false, sampledAt: T0 }));
    bridge.emit("now-playing", np("a", { isPlaying: true, sampledAt: T0 - 500 }));
    expect(controller.track?.isPlaying).toBe(false);
    expect(controller.clock.isPlaying).toBe(false);
    controller.destroy();
  });
});

// The core's get_lyrics answers `error` for a track it hasn't registered yet, and now-playing can reach
// the overlay first: the error chip would flash before the real lookup's events arrive.
describe("an error reply to the first lyrics query", () => {
  const failed = (trackKey: string): Lyrics => ({ trackKey, status: "error", synced: null, plain: null, source: "lrclib" });
  const found = (trackKey: string): Lyrics => ({ trackKey, status: "found", synced: "[00:01.00]placeholder words here", plain: null, source: "lrclib" });

  it("is asked once more before it shows", async () => {
    const { bridge, stage, controller } = setup();
    let calls = 0;
    bridge.answers.get_lyrics = () => (++calls === 1 ? failed("a") : found("a"));
    await controller.start();
    bridge.emit("now-playing", np("a"));
    await settle();
    expect(stage.shows).toEqual(["none ", "loading a"]);
    vi.advanceTimersByTime(1500);
    await settle();
    expect(calls).toBe(2);
    expect(stage.shows).toEqual(["none ", "loading a", "lyrics a"]);
  });

  it("shows when the second answer is an error too", async () => {
    const { bridge, stage, controller } = setup();
    bridge.answers.get_lyrics = () => failed("a");
    await controller.start();
    bridge.emit("now-playing", np("a"));
    await settle();
    vi.advanceTimersByTime(1500);
    await settle();
    expect(stage.shows).toEqual(["none ", "loading a", "error a"]);
  });

  it("gives way to a lyrics event that arrives while it waits", async () => {
    const { bridge, stage, controller } = setup();
    let calls = 0;
    bridge.answers.get_lyrics = () => {
      calls++;
      return failed("a");
    };
    await controller.start();
    bridge.emit("now-playing", np("a"));
    await settle();
    bridge.emit("lyrics", found("a"));
    await settle();
    vi.advanceTimersByTime(1500);
    await settle();
    expect(calls).toBe(1);
    expect(stage.shows).toEqual(["none ", "loading a", "lyrics a"]);
  });

  it("is dropped when the track changed while it waited", async () => {
    const { bridge, stage, controller } = setup();
    let calls = 0;
    bridge.answers.get_lyrics = () => {
      calls++;
      return failed("a");
    };
    await controller.start();
    bridge.emit("now-playing", np("a"));
    await settle();
    bridge.answers.get_lyrics = () => lyrics("b");
    bridge.emit("now-playing", np("b"));
    await settle();
    vi.advanceTimersByTime(1500);
    await settle();
    expect(calls).toBe(1);
    expect(stage.shows).toEqual(["none ", "loading a", "loading b"]);
  });
});

/**
 * A 60 Hz display and the page's visibility, for the frame loop: every 16 ms of fake time, the frames
 * requested by then run. They keep running while the page is hidden (an embedded webview may keep
 * ticking a hidden window), so a test sees the controller stop by itself, not the browser throttle it.
 */
class FakeDisplay {
  visibility: DocumentVisibilityState = "visible";
  /** Vsyncs so far. */
  vsyncs = 0;
  private sinceVsync = 0;
  private readonly queued = new Map<number, FrameRequestCallback>();
  private readonly listeners = new Set<() => void>();
  private lastId = 0;

  install(): void {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
      this.queued.set(++this.lastId, cb);
      return this.lastId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
      this.queued.delete(id);
    });
    const visibility = (): DocumentVisibilityState => this.visibility;
    const listeners = this.listeners;
    vi.stubGlobal("document", {
      get visibilityState(): DocumentVisibilityState {
        return visibility();
      },
      addEventListener(type: string, fn: () => void): void {
        if (type === "visibilitychange") listeners.add(fn);
      },
      removeEventListener(type: string, fn: () => void): void {
        if (type === "visibilitychange") listeners.delete(fn);
      },
    });
  }

  /** Hides or shows the page (the tray's Hide lyrics, a minimized settings window), as browsers announce it. */
  setVisibility(visibility: DocumentVisibilityState): void {
    this.visibility = visibility;
    for (const fn of [...this.listeners]) fn();
  }

  /** Frames requested and not run yet. */
  get pending(): number {
    return this.queued.size;
  }

  get listening(): number {
    return this.listeners.size;
  }

  /** Lets `ms` pass: timers fire when due, and at every vsync (each 16 ms) the frames requested by then run. */
  run(ms: number): void {
    for (let left = ms; left > 0; ) {
      const step = Math.min(left, 16 - this.sinceVsync);
      vi.advanceTimersByTime(step);
      left -= step;
      this.sinceVsync += step;
      if (this.sinceVsync < 16) continue;
      this.sinceVsync = 0;
      this.vsyncs++;
      const due = [...this.queued.values()];
      this.queued.clear();
      for (const cb of due) cb(Date.now());
    }
  }
}

const gaps = (times: number[]): number[] => times.slice(1).map((t, i) => t - (times[i] ?? t));

// DoD (C6 performance budget): the frame loop runs only while a track plays and the stage can be seen.
// It stops on pause, a hidden page, showWhen gating and a null track, and starts again on the way back.
// Between word boundaries, and with nothing to sing, it sleeps instead of drawing identical frames.
describe("the frame loop", () => {
  let display: FakeDisplay;

  beforeEach(() => {
    display = new FakeDisplay();
    display.install();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** When the stage painted over the next `ms`. */
  const paintsIn = (stage: FakeStage, ms: number): number[] => {
    const from = stage.frames.length;
    display.run(ms);
    return stage.frames.slice(from);
  };

  const track = (key: string, over: Partial<NowPlaying> = {}): NowPlaying => np(key, { artwork: "data:cover", ...over });

  /** A controller playing track "a" (gated, as overlay/main.ts makes the overlay's), its stage wanting every frame. */
  async function playing(gate = true): Promise<ReturnType<typeof setup>> {
    const env = setup(gate);
    env.stage.busy = true;
    await env.controller.start();
    env.bridge.emit("now-playing", track("a"));
    await settle();
    display.run(100);
    return env;
  }

  it("draws every frame while playing, one paint per frame however many events arrive", async () => {
    const { bridge, stage, controller } = await playing();
    expect(paintsIn(stage, 1000).length).toBeGreaterThanOrEqual(60);
    // resyncs and settings changes kick the loop; none of them starts a second one
    const vsyncs = display.vsyncs;
    let painted = 0;
    for (let i = 1; i <= 10; i++) {
      bridge.emit("now-playing", track("a", { positionMs: i * 100 }));
      bridge.emit("settings-changed", { ...structuredClone(DEFAULT_SETTINGS), glow: i });
      painted += paintsIn(stage, 100).length;
    }
    expect(painted).toBe(display.vsyncs - vsyncs);
    controller.destroy();
  });

  it("stops on pause after painting the paused frame, and starts again on resume", async () => {
    // the overlay (gated) and the settings preview (never gated, so it stays visible while paused)
    for (const gate of [true, false]) {
      const { bridge, stage, controller } = await playing(gate);
      bridge.emit("now-playing", track("a", { isPlaying: false, positionMs: 2000 }));
      expect(stage.paused).toBe(true);
      expect(stage.visible, `gate ${gate}`).toBe(!gate);
      expect(paintsIn(stage, 16)).toHaveLength(1);
      expect(paintsIn(stage, 10_000), `gate ${gate}`).toHaveLength(0);
      expect(display.pending).toBe(0);

      bridge.emit("now-playing", track("a", { positionMs: 2000 }));
      expect(stage.paused).toBe(false);
      expect(paintsIn(stage, 1000).length, `gate ${gate}`).toBeGreaterThanOrEqual(60);
      controller.destroy();
    }
  });

  it("doesn't start for a track that arrives paused", async () => {
    const { bridge, stage, controller } = setup(true);
    stage.busy = true;
    await controller.start();
    bridge.emit("now-playing", track("a", { isPlaying: false }));
    await settle();
    expect(paintsIn(stage, 10_000)).toHaveLength(1);
    expect(display.pending).toBe(0);
    controller.destroy();
  });

  it("stops while the page is hidden, and starts again when it is shown", async () => {
    const { bridge, stage, controller } = await playing();
    display.setVisibility("hidden");
    expect(paintsIn(stage, 16).length).toBeLessThanOrEqual(1);
    // the core resyncs every second while playing: each may paint once, none restarts the loop
    let painted = 0;
    for (let s = 1; s <= 10; s++) {
      bridge.emit("now-playing", track("a", { positionMs: s * 1000 }));
      painted += paintsIn(stage, 1000).length;
    }
    expect(painted).toBeLessThanOrEqual(10);
    expect(display.pending).toBe(0);

    display.setVisibility("visible");
    expect(paintsIn(stage, 1000).length).toBeGreaterThanOrEqual(60);
    controller.destroy();
  });

  it("hides and stops a gated overlay on pause under While playing; under Always it shows the paused frame and stays still", async () => {
    const { bridge, stage, controller } = await playing();
    const settings = (showWhen: Settings["showWhen"]): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), showWhen });
    bridge.emit("now-playing", track("a", { isPlaying: false, positionMs: 2000 }));
    expect(stage.visible).toBe(false);
    paintsIn(stage, 16);
    expect(paintsIn(stage, 5000)).toHaveLength(0);

    bridge.emit("settings-changed", settings("always"));
    expect(stage.visible).toBe(true);
    expect(paintsIn(stage, 5000)).toHaveLength(1);

    bridge.emit("settings-changed", settings("playing"));
    expect(stage.visible).toBe(false);
    bridge.emit("now-playing", track("a", { positionMs: 2000 }));
    expect(stage.visible).toBe(true);
    expect(paintsIn(stage, 1000).length).toBeGreaterThanOrEqual(60);
    controller.destroy();
  });

  it("stops when the track goes away, and starts again with the next one", async () => {
    // the overlay (gated) and the settings preview (never gated)
    for (const gate of [true, false]) {
      const { bridge, stage, controller } = await playing(gate);
      bridge.emit("now-playing", null);
      expect(stage.visible, `gate ${gate}`).toBe(!gate);
      expect(paintsIn(stage, 16).length).toBeLessThanOrEqual(1);
      expect(paintsIn(stage, 10_000), `gate ${gate}`).toHaveLength(0);
      expect(display.pending).toBe(0);

      bridge.emit("now-playing", track("b"));
      await settle();
      expect(stage.visible).toBe(true);
      expect(paintsIn(stage, 1000).length, `gate ${gate}`).toBeGreaterThanOrEqual(60);
      controller.destroy();
    }
  });

  it("sleeps between word boundaries, waking for each one rather than every frame", async () => {
    const { bridge, stage, controller } = await playing();
    stage.busy = false;
    stage.next = 100;
    paintsIn(stage, 300);
    const times = paintsIn(stage, 2000);
    expect(times.length).toBeLessThanOrEqual(21);
    // and it does wake for each boundary, within a frame of it, not at the 250 ms safety wake
    expect(times.length).toBeGreaterThanOrEqual(17);
    for (const gap of gaps(times)) expect(gap).toBeGreaterThanOrEqual(96);
    for (const gap of gaps(times)) expect(gap).toBeLessThanOrEqual(100 + 16);
    // a change while it sleeps is painted at the next frame, not when the sleep ends
    bridge.emit("settings-changed", { ...structuredClone(DEFAULT_SETTINGS), glow: 90 });
    expect(paintsIn(stage, 16)).toHaveLength(1);
    controller.destroy();
  });

  it("with nothing to sing (loading, not found, instrumental, after the last line) only wakes every 250 ms", async () => {
    const { stage, controller } = await playing();
    stage.busy = false;
    stage.next = Infinity;
    paintsIn(stage, 300);
    const times = paintsIn(stage, 10_000);
    expect(times.length).toBeGreaterThan(0);
    expect(times.length).toBeLessThanOrEqual(Math.ceil(10_000 / 246));
    for (const gap of gaps(times)) expect(gap).toBeGreaterThanOrEqual(246);
    controller.destroy();
  });

  it("draws nothing once destroyed, and stops listening for visibility changes", async () => {
    const { bridge, stage, controller } = await playing();
    expect(display.listening).toBe(1);
    controller.destroy();
    expect(display.listening).toBe(0);
    expect(display.pending).toBe(0);
    bridge.emit("now-playing", track("b"));
    display.setVisibility("hidden");
    display.setVisibility("visible");
    expect(paintsIn(stage, 5000)).toHaveLength(0);
  });
});
