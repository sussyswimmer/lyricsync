import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../contract/contract";
import type { Bridge } from "../src/bridge/types";
import { SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS, SettingsSync, type Write } from "../src/settings/store";

/*
 * SettingsSync on its own, against a core whose replies the test hands back when it chooses: the
 * debounce and the max wait, one save at a time, echo layering, ordered writes, and a reply that
 * lands after a newer settings-changed echo.
 */

const T0 = 1_760_000_000_000;

interface Call {
  name: string;
  args: Record<string, unknown>;
  at: number;
  resolve(settings: Settings): void;
  reject(error: unknown): void;
}

/** A core that answers each command only when the test says so. */
function deferredCore() {
  const calls: Call[] = [];
  const invoke = (name: string, args: Record<string, unknown> = {}): Promise<Settings> =>
    new Promise((resolve, reject) => calls.push({ name, args, at: Date.now(), resolve, reject }));
  return { bridge: { invoke } as unknown as Pick<Bridge, "invoke">, calls };
}

/** A core that answers at once with the patch applied, like the mock without its echo. */
function instantCore() {
  let settings: Settings = structuredClone(DEFAULT_SETTINGS);
  const calls: { name: string; args: Record<string, unknown>; at: number }[] = [];
  const invoke = (name: string, args: Record<string, unknown> = {}): Promise<Settings> => {
    calls.push({ name, args, at: Date.now() });
    if (name === "update_settings") settings = { ...settings, ...(args["patch"] as Partial<Settings>) };
    return Promise.resolve(structuredClone(settings));
  };
  return { bridge: { invoke } as unknown as Pick<Bridge, "invoke">, calls };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const S0 = (): Settings => structuredClone(DEFAULT_SETTINGS);

function start(bridge: Pick<Bridge, "invoke">, initial: Settings = S0()) {
  const views: Settings[] = [];
  const errors: [unknown, Write][] = [];
  const sync = new SettingsSync({ bridge, initial, onChange: (v) => views.push(v), onError: (e, w) => errors.push([e, w]) });
  return { sync, views, errors };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SettingsSync: when edits go out", () => {
  it("edits within the debounce go out as one patch, after the last one", () => {
    const core = deferredCore();
    const { sync } = start(core.bridge);
    sync.edit({ size: 40 });
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS / 2);
    sync.edit({ glow: 10 });
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS / 2);
    sync.edit({ size: 44, mode: "lens" });
    expect(core.calls).toHaveLength(0);
    // the view has them all at once
    expect(sync.view).toMatchObject({ size: 44, glow: 10, mode: "lens" });
    expect(sync.saving).toBe(true);
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1);
    expect(core.calls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(core.calls.map((c) => [c.name, c.args])).toEqual([["update_settings", { patch: { size: 44, glow: 10, mode: "lens" } }]]);
  });

  it("edits that keep coming still go out by SAVE_MAX_WAIT_MS after the first", () => {
    const core = deferredCore();
    const { sync } = start(core.bridge);
    for (let t = 0; t < SAVE_MAX_WAIT_MS; t += 50) {
      sync.edit({ size: 30 + t / 10 });
      vi.advanceTimersByTime(50);
    }
    expect(core.calls.map((c) => c.at - T0)).toEqual([SAVE_MAX_WAIT_MS]);
  });

  it("a 60 Hz drag still saves at least every SAVE_MAX_WAIT_MS, so the desktop follows the slider", async () => {
    const core = instantCore();
    const { sync } = start(core.bridge);
    for (let t = 0; t <= 1000; t += 16) {
      sync.edit({ size: 22 + Math.round(t / 10) });
      await vi.advanceTimersByTimeAsync(16);
    }
    const times = core.calls.map((c) => c.at - T0);
    expect(times.length).toBeGreaterThanOrEqual(3);
    expect(times[0]).toBeLessThanOrEqual(SAVE_MAX_WAIT_MS);
    for (let i = 1; i < times.length; i++) expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeLessThanOrEqual(SAVE_MAX_WAIT_MS + 16);
    // and the last value goes out once the drag stops
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    const last = core.calls[core.calls.length - 1]?.args["patch"] as Partial<Settings>;
    expect(last.size).toBe(sync.view.size);
  });

  it("flush sends at once, and a flush with nothing pending sends nothing", () => {
    const core = deferredCore();
    const { sync } = start(core.bridge);
    sync.flush();
    expect(core.calls).toHaveLength(0);
    sync.edit({ opacity: 60 });
    sync.flush();
    expect(core.calls).toHaveLength(1);
    // the debounce timer went with it
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 3);
    expect(core.calls).toHaveLength(1);
  });
});

describe("SettingsSync: one save at a time, in order", () => {
  it("doesn't send the next write until the one before it is answered", async () => {
    const core = deferredCore();
    const { sync } = start(core.bridge);
    sync.edit({ size: 40 });
    sync.flush();
    sync.edit({ size: 50 });
    sync.flush();
    expect(core.calls).toHaveLength(1);
    expect(sync.view.size).toBe(50);
    core.calls[0]?.resolve({ ...S0(), size: 40 });
    await settle();
    expect(core.calls).toHaveLength(2);
    expect(core.calls[1]?.args).toEqual({ patch: { size: 50 } });
    // the reply of the first never pulls the view back under the second
    expect(sync.view.size).toBe(50);
    core.calls[1]?.resolve({ ...S0(), size: 50 });
    await settle();
    expect(sync.saving).toBe(false);
  });

  it("setTrackOffset sends earlier edits first, then the offset on its own", async () => {
    const core = deferredCore();
    const { sync } = start(core.bridge);
    sync.edit({ globalOffsetMs: 120 });
    sync.setTrackOffset("a|b|c|200", 2500);
    // shown at once, clamped as the core clamps it
    expect(sync.view.trackOffsetsMs).toEqual({ "a|b|c|200": 2000 });
    expect(sync.view.globalOffsetMs).toBe(120);
    expect(core.calls.map((c) => c.name)).toEqual(["update_settings"]);
    core.calls[0]?.resolve({ ...S0(), globalOffsetMs: 120 });
    await settle();
    expect(core.calls.map((c) => [c.name, c.args])).toEqual([
      ["update_settings", { patch: { globalOffsetMs: 120 } }],
      ["set_track_offset", { trackKey: "a|b|c|200", ms: 2000 }],
    ]);
  });

  it("a refused write reports which one, and the next write still goes out", async () => {
    const core = deferredCore();
    const { sync, errors } = start(core.bridge);
    sync.editNow({ launchAtLogin: true });
    sync.edit({ size: 30 });
    sync.flush();
    core.calls[0]?.reject(new Error("login item"));
    await settle();
    expect(errors.map(([, w]) => w)).toEqual([{ kind: "patch", patch: { launchAtLogin: true } }]);
    expect(sync.view.launchAtLogin).toBe(false);
    expect(core.calls[1]?.args).toEqual({ patch: { size: 30 } });
  });

  it("dispose sends what is pending, then ignores everything", async () => {
    const core = deferredCore();
    const { sync, views } = start(core.bridge);
    sync.edit({ curve: -20 });
    sync.dispose();
    expect(core.calls.map((c) => c.args)).toEqual([{ patch: { curve: -20 } }]);
    const seen = views.length;
    sync.edit({ curve: 10 });
    sync.receive({ ...S0(), curve: 99 });
    core.calls[0]?.resolve({ ...S0(), curve: -20 });
    await settle();
    expect(views).toHaveLength(seen);
    expect(core.calls).toHaveLength(1);
  });
});

describe("SettingsSync: echoes and replies", () => {
  it("an echo replaces only what Rust has: an older value mid-drag can't pull the slider back", () => {
    const core = deferredCore();
    const { sync, views } = start(core.bridge);
    sync.edit({ size: 90 });
    // another window's change, or this window's own earlier save, from before the drag
    sync.receive({ ...S0(), size: 58, mode: "drift" });
    expect(sync.view.size).toBe(90);
    // what the echo changed that the user isn't editing shows at once
    expect(sync.view.mode).toBe("drift");
    expect(views[views.length - 1]?.mode).toBe("drift");
    // and the same for a save in flight
    sync.flush();
    sync.receive({ ...S0(), size: 58 });
    expect(sync.view.size).toBe(90);
  });

  it("a reply with no echo since its write went out is adopted (the core may have clamped the value)", async () => {
    const core = deferredCore();
    const { sync } = start(core.bridge);
    sync.edit({ size: 500 });
    sync.flush();
    expect(sync.view.size).toBe(500);
    core.calls[0]?.resolve({ ...S0(), size: 140 });
    await settle();
    expect(sync.view.size).toBe(140);
  });

  it("a reply that lands after a newer echo keeps the echo (a shortcut turned the lyrics off meanwhile)", async () => {
    const core = deferredCore();
    const { sync, views } = start(core.bridge);
    sync.edit({ size: 80 });
    sync.flush();
    // the core commits the size (S1), then the toggle shortcut turns the lyrics off (S2) before the reply
    // is delivered; both broadcasts read the latest settings, so both carry S2
    const s2: Settings = { ...S0(), size: 80, enabled: false };
    sync.receive(structuredClone(s2));
    sync.receive(structuredClone(s2));
    core.calls[0]?.resolve({ ...S0(), size: 80 });
    await settle();
    expect(sync.view.enabled).toBe(false);
    expect(sync.view.size).toBe(80);
    expect(views[views.length - 1]?.enabled).toBe(false);
  });

  it("a set_track_offset reply racing a shortcut nudge's echo keeps the echo's offset", async () => {
    const core = deferredCore();
    const key = "artist|song|album|200";
    const { sync } = start(core.bridge, { ...S0(), trackOffsetsMs: { [key]: 100 } });
    sync.setTrackOffset(key, 150);
    // the nudge shortcut adds 50 on top, and its echo beats the window's reply
    sync.receive({ ...S0(), trackOffsetsMs: { [key]: 200 } });
    core.calls[0]?.resolve({ ...S0(), trackOffsetsMs: { [key]: 150 } });
    await settle();
    expect(sync.view.trackOffsetsMs).toEqual({ [key]: 200 });
    // so the next +50 from the window starts from 200, not 150
    sync.setTrackOffset(key, (sync.view.trackOffsetsMs[key] ?? 0) + 50);
    await settle();
    expect(core.calls[1]?.args).toEqual({ trackKey: key, ms: 250 });
  });

  it("an echo before the write went out doesn't count against its reply", async () => {
    const core = deferredCore();
    const { sync } = start(core.bridge);
    sync.receive({ ...S0(), glow: 5 });
    sync.edit({ glow: 70 });
    sync.flush();
    core.calls[0]?.resolve({ ...S0(), glow: 70 });
    await settle();
    expect(sync.view.glow).toBe(70);
    expect(sync.saving).toBe(false);
  });
});
