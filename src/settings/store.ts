import type { Settings } from "../../contract/contract";
import type { Bridge } from "../bridge/types";

/** Edits are saved this long after the last change (C7)... */
export const SAVE_DEBOUNCE_MS = 120;
/** ...or at least this often during a long drag, so the desktop overlay follows the slider. */
export const SAVE_MAX_WAIT_MS = 300;
/** Per-song nudges stay within the global offset's range. */
export const TRACK_OFFSET_LIMIT_MS = 2000;

/** One save, in the order the user made it. */
export type Write =
  | { kind: "patch"; patch: Partial<Settings> }
  | { kind: "track"; trackKey: string; ms: number };

/** Settings as they will be once `write` lands. A zero track offset reads the same as none. */
export function applyWrite(settings: Settings, write: Write): Settings {
  if (write.kind === "patch") return { ...settings, ...write.patch };
  const offsets = { ...settings.trackOffsetsMs };
  if (write.ms === 0) delete offsets[write.trackKey];
  else offsets[write.trackKey] = write.ms;
  return { ...settings, trackOffsetsMs: offsets };
}

export interface SettingsSyncOptions {
  bridge: Pick<Bridge, "invoke">;
  /** Settings from `get_settings` (or a `settings-changed` that beat it). */
  initial: Settings;
  /** Called with the settings the window should show, after every change from either side. */
  onChange: (view: Settings) => void;
  onError?: (error: unknown) => void;
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
 */
export class SettingsSync {
  private base: Settings;
  private pending: Partial<Settings> = {};
  private readonly queue: Write[] = [];
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingAt = 0;
  private disposed = false;
  private readonly bridge: Pick<Bridge, "invoke">;
  private readonly onChange: (view: Settings) => void;
  private readonly onError: (error: unknown) => void;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;

  constructor(options: SettingsSyncOptions) {
    this.bridge = options.bridge;
    this.base = options.initial;
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
    this.base = settings;
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

  /** Sets one song's offset right away (after any edits made before it). */
  setTrackOffset(trackKey: string, ms: number): void {
    if (this.disposed) return;
    this.flush();
    const clamped = Math.max(-TRACK_OFFSET_LIMIT_MS, Math.min(TRACK_OFFSET_LIMIT_MS, Math.round(ms)));
    this.queue.push({ kind: "track", trackKey, ms: clamped });
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
    const sent =
      write.kind === "patch"
        ? this.bridge.invoke("update_settings", { patch: write.patch })
        : this.bridge.invoke("set_track_offset", { trackKey: write.trackKey, ms: write.ms });
    sent
      .then(
        (settings) => {
          this.base = settings;
        },
        (error: unknown) => this.onError(error),
      )
      .finally(() => {
        this.queue.shift();
        this.busy = false;
        if (!this.disposed) this.onChange(this.view);
        this.pump();
      });
  }
}
