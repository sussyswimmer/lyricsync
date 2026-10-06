// contract/contract.ts
export const CONTRACT_VERSION = 3;

export type Source = "spotify" | "apple-music" | "system";

export interface NowPlaying {
  source: Source;
  /** lowercase `${artist}|${title}|${album}|${round(durationMs/1000)}` */
  trackKey: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  /** playback position at the moment it was read */
  positionMs: number;
  /** epoch ms when positionMs was read; the frontend interpolates from here */
  sampledAt: number;
  isPlaying: boolean;
  /** data:image/...;base64 — Rust fetches remote art so the canvas is never tainted */
  artwork: string | null;
}

/** Why nothing is reported: macOS Automation is off for a running player, or no supported player runs. */
export type MediaProblem = "automation-denied" | "no-player";

export interface MediaStatus {
  /** the player being reported, or the player with the problem; null when none */
  source: Source | null;
  problem: MediaProblem | null;
}

export type LyricsStatus =
  | "loading" | "found" | "plain-only" | "instrumental" | "not-found" | "error";

export interface Lyrics {
  trackKey: string;
  status: LyricsStatus;
  /** raw LRC; may contain enhanced word tags <mm:ss.xx> */
  synced: string | null;
  plain: string | null;
  source: "lrclib" | "cache" | "user";
}

export type Mode = "arc" | "lens" | "drift" | "stack";

/** A global shortcut's action. Added in contract v3. */
export type ShortcutAction = "toggleLyrics" | "nudgeEarlier" | "nudgeLater";

/**
 * Global keyboard shortcuts. Each binding is an accelerator such as "CmdOrCtrl+Alt+Shift+L": one or
 * more of CmdOrCtrl, Control, Alt, Shift and Super, then one key. It needs CmdOrCtrl, Control, Alt
 * or Super, so a shortcut never takes plain typing. "" leaves that action without a shortcut.
 * Added in contract v3.
 */
export interface Shortcuts {
  /** false turns every global shortcut off */
  enabled: boolean;
  toggleLyrics: string;
  /** +50 ms for the current song (lyrics earlier) */
  nudgeEarlier: string;
  /** −50 ms for the current song (lyrics later) */
  nudgeLater: string;
}

/**
 * Whether each shortcut is working. "ok": registered with the OS; "off": shortcuts are off, or the
 * action has none; "unavailable": another app or the OS holds that key combination; "invalid": not a
 * usable key combination. Added in contract v3.
 */
export type ShortcutState = "ok" | "off" | "unavailable" | "invalid";
export type ShortcutsStatus = Record<ShortcutAction, ShortcutState>;

export interface Settings {
  /** the settings schema, still 1: contract v3 only added fields, and stored settings without them
   *  get the defaults */
  version: 1;
  mode: Mode;
  autoColor: boolean;
  colors: { lyric: string; highlight: string; dim: string }; // #rrggbb
  font: { family: string; weight: number };
  size: number;        // 22–140 px at 1x scale
  curve: number;       // -100..100, used by "arc"
  yPos: number;        // 0..100, % of display height
  glow: number;        // 0..100
  opacity: number;     // 20..100
  showWhen: "playing" | "always";
  displays: "primary" | "all";
  globalOffsetMs: number;                  // -2000..2000
  trackOffsetsMs: Record<string, number>;  // keyed by trackKey
  /** false hides the lyrics on every display. The Settings switch, the tray's Hide/Show lyrics and
   *  the toggle shortcut all change this. Added in contract v3. */
  enabled: boolean;
  /** start Undertone at login. Rust keeps the OS login item in step and, at startup, adopts the
   *  login item's real state. Added in contract v3. */
  launchAtLogin: boolean;
  /** Added in contract v3. */
  shortcuts: Shortcuts;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1, mode: "arc", autoColor: true,
  colors: { lyric: "#f1ece3", highlight: "#f2a65a", dim: "#8d93a0" },
  font: { family: "Fraunces", weight: 700 },
  size: 58, curve: 38, yPos: 46, glow: 40, opacity: 100,
  showWhen: "playing", displays: "primary",
  globalOffsetMs: 0, trackOffsetsMs: {},
  enabled: true, launchAtLogin: false,
  shortcuts: {
    enabled: true,
    toggleLyrics: "CmdOrCtrl+Alt+Shift+L",
    nudgeEarlier: "CmdOrCtrl+Alt+Shift+]",
    nudgeLater: "CmdOrCtrl+Alt+Shift+[",
  },
};
