// contract/contract.ts
export const CONTRACT_VERSION = 9;

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

/**
 * The Style setting (contract v9): "auto" lets Undertone pick each song's style; any other name
 * draws every song in that style (its face, curve and motion stay the song's own). The names are
 * the styles Settings › Style offers (src/core/songlook.ts STYLES, the retired Arc, Drift and Stack
 * not among them); the core only stores them.
 */
export type StyleChoice = "auto" | "slant" | "pop" | "reel" | "cascade" | "tape" | "spotlight" | "wave" | "reveal" | "collage" | "lens" | "poster";

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
  /** the settings schema, still 1: contracts v3, v4, v5, v7, v8 and v9 only added fields, and stored
   *  settings without them get the defaults; v6 only stopped reading `yPos` */
  version: 1;
  /** Not read since v4: Undertone picks the style per song. Still validated and stored. */
  mode: Mode;
  autoColor: boolean;
  colors: { lyric: string; highlight: string; dim: string }; // #rrggbb
  /** Not read since v4: the face is picked per song. Still validated and stored. */
  font: { family: string; weight: number };
  size: number;        // 22–140 px at 1x scale
  /** Not read since v4: Arc's curve is picked per song. Still validated and stored. */
  curve: number;       // -100..100
  /** Not read since v6: the lyrics always sit in the middle of the display's work area (without
   *  menu bar, Dock or taskbar). Still validated and stored. */
  yPos: number;        // 0..100
  /** 0..100. Scales the bloom the song's look asks for (0 subtle, 40 as picked, 100 strongest) and
   *  softens the dark shadow. */
  glow: number;
  opacity: number;     // 20..100
  showWhen: "playing" | "always";
  displays: "primary" | "all";
  globalOffsetMs: number;                  // -2000..2000
  /** Each nudged song's own offset on top of `globalOffsetMs`, -2000..2000, keyed by trackKey. Since
   *  v7, 0 is an offset of its own; a song without an entry follows the learned offset. */
  trackOffsetsMs: Record<string, number>;
  /** The songs whose sync was set most recently, oldest first, at most 9. A song without an offset of
   *  its own starts from what theirs have in common (src/core/sync.ts `learnedOffsetMs`). Added in
   *  contract v7. */
  nudgedTracks: string[];
  /** false hides the lyrics on every display. The Settings switch, the tray's Hide/Show lyrics and
   *  the toggle shortcut all change this. Added in contract v3. */
  enabled: boolean;
  /** start Undertone at login. Rust keeps the OS login item in step and, at startup, adopts the
   *  login item's real state. Added in contract v3. */
  launchAtLogin: boolean;
  /** Added in contract v3. */
  shortcuts: Shortcuts;
  /** How much lyrics move as they're sung, 0..100; 50 is as picked for the song. Added in contract v4. */
  effects: number;
  /** Text effects (called Effects mode before contract v8): each song's words move their own way
   *  (not every word floats up). false: every word rises. Added in contract v5; until v8 it also
   *  turned the pictures and splashes on and off, which `graphics` does now. */
  effectsMode: boolean;
  /** Graphics: words that name something take part in the line as a picture, and big moments
   *  splash. Added in contract v8: settings saved without it keep their `effectsMode`'s value. */
  graphics: boolean;
  /** The style every song is drawn in, or "auto" for the one Undertone picks per song. Added in
   *  contract v9: settings saved without it read as "auto". */
  style: StyleChoice;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1, mode: "arc", autoColor: true,
  colors: { lyric: "#f1ece3", highlight: "#f2a65a", dim: "#8d93a0" },
  font: { family: "Fraunces", weight: 700 },
  size: 58, curve: 38, yPos: 46, glow: 40, opacity: 100,
  showWhen: "playing", displays: "primary",
  globalOffsetMs: 0, trackOffsetsMs: {}, nudgedTracks: [],
  enabled: true, launchAtLogin: false,
  shortcuts: {
    enabled: true,
    toggleLyrics: "CmdOrCtrl+Alt+Shift+L",
    nudgeEarlier: "CmdOrCtrl+Alt+Shift+]",
    nudgeLater: "CmdOrCtrl+Alt+Shift+[",
  },
  effects: 50,
  effectsMode: true,
  graphics: true,
  style: "auto",
};
