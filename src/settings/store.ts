import { DEFAULT_SETTINGS, type Settings } from "../../contract/contract";
import type { Bridge } from "../bridge/types";
import { nudgedAfter } from "../core/sync";

/** Edits are saved this long after the last change (C7)... */
export const SAVE_DEBOUNCE_MS = 120;
/** ...or at least this often during a long drag, so the desktop overlay follows the slider. */
export const SAVE_MAX_WAIT_MS = 300;
/** Per-song nudges stay within the global offset's range. */
export const TRACK_OFFSET_LIMIT_MS = 2000;

/** A per-song offset as it is saved: whole ms, within ±`TRACK_OFFSET_LIMIT_MS`. */
export function clampTrackOffset(ms: number): number {
  return Math.max(-TRACK_OFFSET_LIMIT_MS, Math.min(TRACK_OFFSET_LIMIT_MS, Math.round(ms)));
}

/** One save, in the order the user made it. */
export type Write =
  | { kind: "patch"; patch: Partial<Settings> }
  | { kind: "track"; trackKey: string; ms: number | null };

/**
 * Settings from a core older than contract v3 lack `enabled`, `launchAtLogin` and `shortcuts`, from
 * one older than v4, `effects`, from one older than v5, `effectsMode`, from one older than v7,
 * `nudgedTracks`, and from one older than v8, `karaokeMode`; the window shows their defaults.
 * Complete settings come back as the same object.
 */
export function withDefaults(settings: Settings): Settings {
  const s: Partial<Settings> = settings;
  if (
    s.enabled !== undefined &&
    s.launchAtLogin !== undefined &&
    s.shortcuts !== undefined &&
    s.effects !== undefined &&
    s.effectsMode !== undefined &&
    s.nudgedTracks !== undefined &&
    s.karaokeMode !== undefined
  ) {
    return settings;
  }
  const defaults = structuredClone(DEFAULT_SETTINGS);
  return { ...defaults, ...settings, shortcuts: { ...defaults.shortcuts, ...s.shortcuts } };
}

/**
 * Reset to defaults: everything but `version`, per-song offsets and the songs they were learned from
 * (kept, unless Reset also forgets them with its own `trackOffsetsMs: {}, nudgedTracks: []`), and the
 * two switches that aren't about how lyrics look:
 * resetting must neither turn the lyrics back on (or off) nor add or remove the login item. The
 * shortcuts are reset, switch and bindings.
 */
export function defaultsPatch(): Partial<Settings> {
  const patch: Partial<Settings> = structuredClone(DEFAULT_SETTINGS);
  delete patch.version;
  delete patch.trackOffsetsMs;
  delete patch.nudgedTracks;
  delete patch.enabled;
  delete patch.launchAtLogin;
  return patch;
}

/**
 * Settings as they will be once `write` lands. A song's offset (0 included) makes it the most recently
 * nudged; `null` drops its offset and its place, so it follows the learned offset again.
 */
export function applyWrite(settings: Settings, write: Write): Settings {
  if (write.kind === "patch") return { ...settings, ...write.patch };
  const offsets = { ...settings.trackOffsetsMs };
  if (write.ms === null) {
    delete offsets[write.trackKey];
    return { ...settings, trackOffsetsMs: offsets, nudgedTracks: settings.nudgedTracks.filter((key) => key !== write.trackKey) };
  }
  offsets[write.trackKey] = write.ms;
  return { ...settings, trackOffsetsMs: offsets, nudgedTracks: nudgedAfter(settings.nudgedTracks, write.trackKey) };
}

export interface SettingsSyncOptions {
  bridge: Pick<Bridge, "invoke">;
  /** Settings from `get_settings` (or a `settings-changed` that beat it). */
  initial: Settings;
  /** Called with the settings the window should show, after every change from either side. */
  onChange: (view: Settings) => void;
  /** A save the core refused (a login item it couldn't change, say). The window falls back to the core's settings. */
  onError?: (error: unknown, write: Write) => void;
  debounceMs?: number;
  maxWaitMs?: number;
}

/**
 * Keeps the settings window and the Rust store in step.
 *
 * What the window shows is three layers: the last settings Rust reported (`settings-changed` echo or
 * a command's reply), the saves already sent (one at a time, in order), and edits not yet sent. An
 * echo replaces only the bottom layer, so an older value arriving mid-drag can't pull a slider back
 * under the user's pointer. Edits go out debounced as one shallow `update_settings` patch (nested
 * objects are always whole); per-song nudges use `set_track_offset` so they never resend the map.
 *
 * A reply and an echo travel separately, so a reply can land after an echo of a newer change (the
 * toggle shortcut, the tray). The core reads the settings it sends with each echo as the echo goes
 * out, after every change it commits, so an echo that arrived after a write was sent is at least as
 * new as that write's reply: the reply then leaves the bottom layer alone.
 */
export class SettingsSync {
  private base: Settings;
  private pending: Partial<Settings> = {};
  private readonly queue: Write[] = [];
  private busy = false;
  /** Echoes received so far, so a reply can tell whether one came in after its write was sent. */
  private echoes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingAt = 0;
  private disposed = false;
  private readonly bridge: Pick<Bridge, "invoke">;
  private readonly onChange: (view: Settings) => void;
  private readonly onError: (error: unknown, write: Write) => void;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;

  constructor(options: SettingsSyncOptions) {
    this.bridge = options.bridge;
    this.base = withDefaults(options.initial);
    this.onChange = options.onChange;
    this.onError = options.onError ?? (() => {});
    this.debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? SAVE_MAX_WAIT_MS;
  }

  /** The settings to show: what Rust has, plus saves in flight, plus unsent edits. */
  get view(): Settings {
    const sent = this.queue.reduce(applyWrite, this.base);
    return Object.keys(this.pending).length > 0 ? applyWrite(sent, { kind: "patch", patch: this.pending }) : sent;
  }

  /** True while anything is unsaved or on its way. */
  get saving(): boolean {
    return this.busy || this.queue.length > 0 || Object.keys(this.pending).length > 0;
  }

  /** A `settings-changed` echo, from this window or any other. */
  receive(settings: Settings): void {
    if (this.disposed) return;
    this.echoes++;
    this.base = withDefaults(settings);
    this.onChange(this.view);
  }

  /** A user edit: shows at once, saves debounced. Nested objects (colors, font) must be whole. */
  edit(patch: Partial<Settings>): void {
    if (this.disposed) return;
    const now = Date.now();
    if (Object.keys(this.pending).length === 0) this.firstPendingAt = now;
    this.pending = { ...this.pending, ...patch };
    this.onChange(this.view);
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstPendingAt + this.maxWaitMs - now));
    this.timer = setTimeout(() => this.flush(), wait);
  }

  /**
   * A change that saves at once as its own `update_settings` (after any edits made before it): a
   * switch with a side effect, such as Launch at login, whose failure must not take other edits with it.
   */
  editNow(patch: Partial<Settings>): void {
    if (this.disposed) return;
    this.flush();
    this.queue.push({ kind: "patch", patch });
    this.onChange(this.view);
    this.pump();
  }

  /** Sets one song's own offset right away (after any edits made before it); `null` drops it. */
  setTrackOffset(trackKey: string, ms: number | null): void {
    if (this.disposed) return;
    this.flush();
    this.queue.push({ kind: "track", trackKey, ms: ms === null ? null : clampTrackOffset(ms) });
    this.onChange(this.view);
    this.pump();
  }

  /** Sends unsent edits now (window closing, or before an ordered write). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (Object.keys(this.pending).length === 0) return;
    this.queue.push({ kind: "patch", patch: this.pending });
    this.pending = {};
    this.pump();
  }

  dispose(): void {
    this.flush();
    this.disposed = true;
  }

  /** One save at a time, so replies and echoes can't land out of order. */
  private pump(): void {
    if (this.busy) return;
    const write = this.queue[0];
    if (!write) return;
    this.busy = true;
    const echoesBefore = this.echoes;
    const sent =
      write.kind === "patch"
        ? this.bridge.invoke("update_settings", { patch: write.patch })
        : this.bridge.invoke("set_track_offset", { trackKey: write.trackKey, ms: write.ms });
    sent
      .then(
        (settings) => {
          // An echo since this write went out is at least as new as this reply (see the class comment).
          if (this.echoes === echoesBefore) this.base = withDefaults(settings);
        },
        (error: unknown) => this.onError(error, write),
      )
      .finally(() => {
        this.queue.shift();
        this.busy = false;
        if (!this.disposed) this.onChange(this.view);
        this.pump();
      });
  }
}
