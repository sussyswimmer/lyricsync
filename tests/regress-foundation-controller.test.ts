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
  render(): boolean {
    return false;
  }
  nextChange(): number {
    return Infinity;
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
