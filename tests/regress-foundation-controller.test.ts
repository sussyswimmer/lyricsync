import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Lyrics, type NowPlaying, type Settings } from "../contract/contract";
import type { ArgsOf, Bridge, Command, Event, Events, ResultOf, Unlisten } from "../src/bridge/types";
import { PaletteCache, type Palette } from "../src/core/palette";
import { OverlayController } from "../src/overlay/controller";
import type { SongLook } from "../src/core/songlook";
import { DEFAULT_PICK, pickedOf, type PickedLook } from "../src/overlay/look";
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
  /** What nextChange returns: song time to the next word boundary, Infinity when nothing will change... */
  next = Infinity;
  /** ...or, when set, the song time of the next change, which nextChange counts down to as a real stage's does. */
  nextAt: number | null = null;
  /** When each paint happened (fake wall-clock ms). */
  frames: number[] = [];
  /** The clock's target handed with each paint. */
  targets: number[] = [];
  render(t: number, _rate?: number, target = t): boolean {
    this.frames.push(Date.now());
    this.targets.push(target);
    // painted at (or past) its next change: there is none after it
    if (this.nextAt !== null && t >= this.nextAt) this.nextAt = null;
    return this.busy;
  }
  nextChange(t: number): number {
    return this.nextAt === null ? this.next : this.nextAt - t;
  }
  /** false: words drawn on the compositor (Stack, Drift), so quiet resyncs go through retime. */
  wakesForWords: boolean | undefined = undefined;
  /** Each retime: song time, rate, target. */
  retimes: [number, number, number][] = [];
  /** What retime answers: true when a paint is due after all. */
  retimeAnswer = false;
  retime(t: number, rate: number, target: number): boolean {
    this.retimes.push([t, rate, target]);
    return this.retimeAnswer;
  }
  /** Each look the controller handed over, and how. */
  looks: [PickedLook | null, string][] = [];
  setPickedLook(look: PickedLook | null, how = "now"): void {
    this.looks.push([look, how]);
  }
  /** What atSafePoint answers. */
  safe = false;
  atSafePoint(): boolean {
    return this.safe;
  }
  private readonly safeListeners = new Set<() => void>();
  addSafePointListener(fn: () => void): () => void {
    this.safeListeners.add(fn);
    return () => {
      this.safeListeners.delete(fn);
    };
  }
  /** The stage reaches a safe point (a line change, a break starting). */
  reachSafePoint(): void {
    for (const fn of [...this.safeListeners]) fn();
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
 * A display (a vsync every 16 ms unless told otherwise) and the page's visibility, for the frame loop:
 * at every vsync of fake time, the frames requested by then run, given the vsync's time on
 * performance.now()'s clock as browsers do. With `latency`, a frame's callbacks run that many ms after
 * its vsync, after any timers due by then, as on a busy main thread. Frames keep running while the
 * page is hidden (an embedded webview may keep ticking a hidden window), so a test sees the controller
 * stop by itself, not the browser throttle it. Whole ms only: fake timers carry fractions oddly.
 */
class FakeDisplay {
  visibility: DocumentVisibilityState = "visible";
  /** Vsyncs so far. */
  vsyncs = 0;
  /** Frame callbacks run so far: how often the page woke for a frame. */
  callbacks = 0;
  private frameMs: number;
  private readonly latency: number;
  /** fake ms run so far, and when the next vsync is */
  private elapsed = 0;
  private nextVsync: number;
  private readonly queued = new Map<number, FrameRequestCallback>();
  private readonly listeners = new Set<() => void>();
  private lastId = 0;

  constructor(frameMs = 16, latency = 0) {
    this.frameMs = frameMs;
    this.latency = latency;
    this.nextVsync = frameMs;
  }

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

  /** The window moves to a display with a vsync every `frameMs`, from the next vsync on. */
  moveTo(frameMs: number): void {
    this.frameMs = frameMs;
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

  /** Lets `ms` pass: timers fire when due, and at every vsync (each 16 ms by default) the frames requested by then run. */
  run(ms: number): void {
    const end = this.elapsed + ms;
    while (this.nextVsync + this.latency <= end) {
      this.advanceTo(this.nextVsync);
      const time = performance.now();
      this.advanceTo(this.nextVsync + this.latency);
      this.nextVsync += this.frameMs;
      this.vsyncs++;
      const due = [...this.queued.values()];
      this.queued.clear();
      this.callbacks += due.length;
      for (const cb of due) cb(time);
    }
    this.advanceTo(end);
  }

  private advanceTo(at: number): void {
    if (at <= this.elapsed) return;
    vi.advanceTimersByTime(at - this.elapsed);
    this.elapsed = at;
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

  // Regression (busy-at-display-rate): a busy stage (Lens follows the sung word through every line)
  // asked for every display frame, so a 120 or 144 Hz display drew it two or more times as often as a
  // 60 Hz one, against the CPU budget.
  // Whole-ms stand-ins for 60, 100, 120, 144 and 240 Hz: every frame up to 100 Hz, then every other or third.
  it.each([
    [16, 62],
    [10, 100],
    [8, 62],
    [7, 71],
    [4, 83],
  ])("with a vsync every %s ms, draws a busy stage about %s times a second", async (frameMs, fps) => {
    display = new FakeDisplay(frameMs);
    display.install();
    const { stage, controller } = await playing();
    const woke = display.callbacks;
    const times = paintsIn(stage, 1000);
    expect(times.length).toBeGreaterThanOrEqual(fps - 1);
    expect(times.length).toBeLessThanOrEqual(fps + 2);
    // it waits on a timer, not by asking for frames it then skips
    expect(display.callbacks - woke).toBeLessThanOrEqual(times.length + 1);
    // never two frames closer than BUSY_FRAME_MS (8.6 ms), never a frame skipped that could be drawn
    for (const gap of gaps(times)) expect(gap).toBeGreaterThanOrEqual(Math.min(frameMs, 9));
    for (const gap of gaps(times)) expect(gap).toBeLessThanOrEqual(Math.max(frameMs, 8.6 + frameMs));
    controller.destroy();
  });

  it("passes over a frame that began before the wait was over, on a busy main thread", async () => {
    // a 125 Hz display whose frames run 2 ms late, after the timer that asked for them
    display = new FakeDisplay(8, 2);
    display.install();
    const { stage, controller } = await playing();
    const times = paintsIn(stage, 1000);
    expect(times.length).toBeLessThanOrEqual(63);
    for (const gap of gaps(times)) expect(gap).toBe(16);
    controller.destroy();
  });

  /**
   * Timers that end at the first tick of a `tick` ms grid at or after they're due, off the vsync grid,
   * like Windows' timer interrupt: WebView2 runs it every 8 ms on battery.
   */
  const coarseTimers = (tick: number): void => {
    const fine = globalThis.setTimeout;
    const origin = performance.now() + 3;
    vi.stubGlobal("setTimeout", ((cb: () => void, ms = 0) => {
      const at = performance.now() + ms;
      return fine(cb, origin + Math.ceil((at - origin) / tick) * tick - performance.now());
    }) as unknown as typeof setTimeout);
  };

  // Regression (busy-frame-timer): after every busy frame the loop waited on a timer for the cap, even
  // on a display too slow to need it, so a frame came only if the timer fired in time to ask for the
  // next vsync. With an 8 ms timer a 77 Hz display drew a busy stage 48 times a second, a 91 Hz one 57.
  it.each([17, 13, 11])("with a coarse timer, draws a busy stage at every frame of a display that needs no cap (a vsync every %s ms)", async (frameMs) => {
    display = new FakeDisplay(frameMs);
    display.install();
    coarseTimers(8);
    const { stage, controller } = await playing();
    const times = paintsIn(stage, 1000);
    expect(times.length).toBeGreaterThanOrEqual(Math.floor(1000 / frameMs) - 1);
    for (const gap of gaps(times)) expect(gap).toBe(frameMs);
    controller.destroy();
  });

  it("with a coarse timer, still caps a busy stage on a fast display, on a timer", async () => {
    display = new FakeDisplay(8);
    display.install();
    coarseTimers(8);
    const { stage, controller } = await playing();
    const woke = display.callbacks;
    const times = paintsIn(stage, 1000);
    expect(times.length).toBeLessThanOrEqual(63);
    for (const gap of gaps(times)) expect(gap).toBeGreaterThanOrEqual(9);
    expect(display.callbacks - woke).toBeLessThanOrEqual(times.length + 1);
    controller.destroy();
  });

  it("checks the display's rate again on a kick, for a window moved from a fast display to a slower one", async () => {
    display = new FakeDisplay(8);
    display.install();
    coarseTimers(8);
    const { bridge, stage, controller } = await playing();
    display.moveTo(13);
    paintsIn(stage, 100);
    // the core's resync, every second while playing
    bridge.emit("now-playing", track("a", { positionMs: 1000 }));
    paintsIn(stage, 100);
    const times = paintsIn(stage, 1000);
    expect(times.length).toBeGreaterThanOrEqual(75);
    for (const gap of gaps(times)) expect(gap).toBe(13);
    controller.destroy();
  });

  it("on a fast display, still sleeps between word boundaries and paints a change at the next frame", async () => {
    display = new FakeDisplay(8);
    display.install();
    const { bridge, stage, controller } = await playing();
    paintsIn(stage, 2);
    bridge.emit("settings-changed", { ...structuredClone(DEFAULT_SETTINGS), glow: 90 });
    expect(paintsIn(stage, 8)).toHaveLength(1);
    stage.busy = false;
    stage.next = 100;
    paintsIn(stage, 300);
    const times = paintsIn(stage, 2000);
    expect(times.length).toBeGreaterThanOrEqual(19);
    expect(times.length).toBeLessThanOrEqual(21);
    for (const gap of gaps(times)) expect(gap).toBeLessThanOrEqual(100 + 8);
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

  it("hides and stops a gated overlay while the lyrics are turned off; an ungated preview keeps playing", async () => {
    const settings = (enabled: boolean): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), enabled });
    for (const gate of [true, false]) {
      const { bridge, stage, controller } = await playing(gate);
      bridge.emit("settings-changed", settings(false));
      expect(stage.visible, `gate ${gate}`).toBe(!gate);
      paintsIn(stage, 16);
      if (gate) {
        expect(paintsIn(stage, 5000)).toHaveLength(0);
        expect(display.pending).toBe(0);
      } else {
        expect(paintsIn(stage, 1000).length).toBeGreaterThanOrEqual(60);
      }
      // under Always too: off is off
      bridge.emit("settings-changed", { ...settings(false), showWhen: "always" });
      expect(stage.visible, `gate ${gate}`).toBe(!gate);

      bridge.emit("settings-changed", settings(true));
      expect(stage.visible).toBe(true);
      expect(paintsIn(stage, 1000).length, `gate ${gate}`).toBeGreaterThanOrEqual(60);
      controller.destroy();
    }
  });

  it("counts settings without `enabled` (a core older than contract v3) as on", async () => {
    const { bridge, stage, controller } = await playing();
    const old: Partial<Settings> = structuredClone(DEFAULT_SETTINGS);
    delete old.enabled;
    bridge.emit("settings-changed", old as Settings);
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

// SPEC §2.7: a player sample that changes nothing on screen reaches a stage drawing its words on the
// compositor without a frame (stage.retime); the stage's own wakes (a slew ending) wake the loop.
describe("quiet resyncs", () => {
  let display: FakeDisplay;

  beforeEach(() => {
    display = new FakeDisplay();
    display.install();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const paintsIn = (stage: FakeStage, ms: number): number[] => {
    const from = stage.frames.length;
    display.run(ms);
    return stage.frames.slice(from);
  };

  /** A gated controller playing track "a" from 0, its stage drawing words on the compositor (or not). */
  async function playing(compositor = true): Promise<ReturnType<typeof setup> & { started: number; resync: (errorMs: number) => void }> {
    const env = setup(true);
    env.stage.wakesForWords = compositor ? false : undefined;
    await env.controller.start();
    const started = Date.now();
    env.bridge.emit("now-playing", np("a", { artwork: "data:cover", sampledAt: started }));
    await settle();
    display.run(100);
    // the player's resync: where it says the song is, `errorMs` off the clock's own extrapolation
    const resync = (errorMs: number): void => {
      const at = Date.now();
      env.bridge.emit("now-playing", np("a", { artwork: "data:cover", positionMs: at - started + errorMs, sampledAt: at }));
    };
    return { ...env, started, resync };
  }

  it("go through retime, with the clock's target, and paint nothing", async () => {
    const { stage, controller, resync, started } = await playing();
    stage.next = Infinity;
    paintsIn(stage, 1500);
    const painted = stage.frames.length;
    stage.retimes = [];
    resync(60);
    expect(stage.retimes).toHaveLength(1);
    const [t, rate, target] = stage.retimes[0] ?? [0, 0, 0];
    const song = Date.now() - started;
    expect(t).toBeCloseTo(song, 6);
    // the clock follows the middle of its readings: the first (on time) and this one, 60 ms ahead
    expect(target).toBeCloseTo(song + 30, 6);
    expect(rate).toBeCloseTo(1 + 30 / 300, 6);
    expect(stage.frames).toHaveLength(painted);
    expect(paintsIn(stage, 200)).toEqual([]);
    controller.destroy();
  });

  it("paint after all when the stage says one is due", async () => {
    const { stage, controller, resync } = await playing();
    stage.next = Infinity;
    paintsIn(stage, 1500);
    stage.retimeAnswer = true;
    resync(20);
    expect(paintsIn(stage, 16)).toHaveLength(1);
    controller.destroy();
  });

  it("wake the loop sooner when the stage's next change comes closer (a slew ending)", async () => {
    const { stage, controller, resync, started } = await playing();
    stage.next = Infinity;
    paintsIn(stage, 1100);
    // asleep for its 1 s idle wait; the resync starts a slew that ends in 300 ms
    stage.nextAt = Date.now() - started + 300;
    resync(80);
    const times = paintsIn(stage, 600);
    expect(times.length).toBeGreaterThanOrEqual(1);
    expect((times[0] ?? 0) - Date.now() + 600).toBeLessThanOrEqual(300 + 16);
    controller.destroy();
  });

  it("check in once a second without a frame while nothing is due, and frame for what is", async () => {
    const { stage, controller, started } = await playing();
    stage.next = Infinity;
    paintsIn(stage, 300);
    stage.retimes = [];
    // asleep: each check-in follows the clock (retime) and sleeps on
    expect(paintsIn(stage, 5000)).toEqual([]);
    expect(stage.retimes.length).toBeGreaterThanOrEqual(4);
    expect(stage.retimes.length).toBeLessThanOrEqual(6);
    // a change 2.5 s on: the check-ins before it sleep on, and it is painted within a frame of it
    const due = Date.now() + 2500;
    stage.nextAt = due - started;
    const times = paintsIn(stage, 3000);
    expect(times).toHaveLength(1);
    expect(Math.abs((times[0] ?? 0) - due)).toBeLessThanOrEqual(16);
    // a check-in that finds a paint due (the stage's retime says so) frames at once
    stage.nextAt = null;
    stage.retimeAnswer = true;
    const answered = paintsIn(stage, 1100);
    expect(answered).toHaveLength(1);
    controller.destroy();
  });

  it("frame at every safety wake when the stage paints words itself", async () => {
    const { stage, controller } = await playing(false);
    stage.next = Infinity;
    paintsIn(stage, 300);
    expect(paintsIn(stage, 1000).length).toBeGreaterThanOrEqual(3);
    expect(stage.retimes).toEqual([]);
    controller.destroy();
  });

  it("still get a frame each when the stage paints words itself, or for a real change", async () => {
    const { bridge, stage, controller, resync } = await playing(false);
    stage.next = Infinity;
    paintsIn(stage, 300);
    resync(60);
    expect(stage.retimes).toEqual([]);
    expect(paintsIn(stage, 16)).toHaveLength(1);
    // a pause is a real change on any stage
    stage.wakesForWords = false;
    bridge.emit("now-playing", np("a", { artwork: "data:cover", isPlaying: false, positionMs: 5000, sampledAt: Date.now() }));
    expect(paintsIn(stage, 16)).toHaveLength(1);
    controller.destroy();
  });

  it("hand every frame the clock's target", async () => {
    const { stage, controller, resync } = await playing(false);
    stage.next = Infinity;
    paintsIn(stage, 300);
    // 200 ms ahead: the clock converges on 100 ms ahead, the middle of its two readings
    resync(200);
    paintsIn(stage, 16);
    // the frame's target is where the clock is converging, ahead of the position it still slews from
    const target = stage.targets[stage.targets.length - 1] ?? 0;
    const at = stage.frames[stage.frames.length - 1] ?? 0;
    expect(target).toBeCloseTo(controller.clock.target(at), 6);
    expect(target - controller.clock.position(at)).toBeGreaterThan(50);
    controller.destroy();
  });
});

// The song's look in full (commit timing, refinement, memory) is tests/look-wiring.test.ts's.
describe("the look", () => {
  it("is DEFAULT_PICK until a track brings its own; onLook hears the song's look, forced parts win, null without a track", async () => {
    const bridge = new FakeBridge();
    bridge.answers.get_settings = () => structuredClone(DEFAULT_SETTINGS);
    bridge.answers.get_now_playing = () => null;
    bridge.answers.get_lyrics = () => lyrics("x");
    const stage = new FakeStage();
    const heard: (SongLook | null)[] = [];
    const controller = new OverlayController(bridge, stage as unknown as LyricStage, { palettes: new PaletteCache(async () => null), onLook: (l) => heard.push(l) });
    await controller.start();
    expect(controller.look).toEqual(DEFAULT_PICK);
    expect(controller.songLook).toBeNull();
    expect(heard).toEqual([]);
    bridge.emit("now-playing", np("a"));
    // the track's provisional look: no lyrics yet
    expect(heard).toHaveLength(1);
    const provisional = heard[0] ?? null;
    expect(provisional?.traits).toContain("no lyrics");
    expect(controller.songLook).toBe(provisional);
    const song = pickedOf(provisional ?? DEFAULT_PICK);
    expect(controller.look).toEqual(song);
    // resyncs of the same track say nothing
    bridge.emit("now-playing", np("a", { positionMs: 1000 }));
    expect(heard).toHaveLength(1);

    controller.forceLook({ style: "lens" });
    expect(stage.looks[stage.looks.length - 1]).toEqual([{ ...song, style: "lens" }, "now"]);
    expect(heard[heard.length - 1]).toEqual({ ...provisional, style: "lens" });
    // the same again changes nothing anyone hears
    controller.forceLook({ style: "lens" });
    expect(heard).toHaveLength(2);
    // nothing valid in it: no override, and onLook has the keeper's own look again
    controller.forceLook({ style: "flow" as PickedLook["style"] });
    expect(controller.look).toEqual(song);
    expect(heard[heard.length - 1]).toBe(provisional);
    // forced parts stay forced; the rest is the song's
    controller.forceLook({ style: "drift", font: "Caveat" });
    expect(controller.look).toEqual({ ...song, style: "drift", font: { family: "Caveat", weight: 600 } });
    // nothing waits for a safe point
    const count = stage.looks.length;
    stage.reachSafePoint();
    controller.safePoint();
    expect(stage.looks).toHaveLength(count);

    bridge.emit("now-playing", null);
    expect(heard[heard.length - 1]).toBeNull();
    expect(controller.songLook).toBeNull();
    controller.destroy();
  });
});

// Regression (palette-after-teardown): a palette worked out after the controller was destroyed still
// went to the stage, and a track without art still armed its grace timer.
describe("teardown", () => {
  it("hands the stage nothing that arrives after destroy", async () => {
    const { bridge, stage, controller } = setup();
    await controller.start();
    bridge.emit("now-playing", np("a", { artwork: "data:cover" }));
    controller.destroy();
    await settle();
    expect(stage.palettes).toHaveLength(0);

    const other = setup();
    await other.controller.start();
    other.bridge.emit("now-playing", np("b"));
    other.controller.destroy();
    await settle();
    vi.advanceTimersByTime(5000);
    await settle();
    expect(other.stage.palettes).toHaveLength(0);
  });
});
