# Undertone — Build Spec

The architecture, the contract between the TypeScript and Rust halves, and the definition of done.

## What it is

A desktop app for **macOS and Windows** that shows the synced lyrics of whatever is playing on the **desktop layer**. That layer is above the wallpaper and below desktop icons and every window. The user can still drag folders and windows over it, and clicks pass straight through.

- Highlights word by word as the song plays.
- Default colors come from the album cover. The user can override every color.
- Fully customizable: style (Arc / Lens / Drift / Stack), font, size, curve, height, glow, opacity.
- Lives in the menu bar (Mac) or system tray (Windows). It has no Dock icon, and no taskbar button except the Settings window's on Windows while it's open.

**Not in v1:** lock screen, Linux, mobile, playback controls, bundled lyrics.

## Reference prototype

`prototype/undertone.html` is a single-file working prototype of the renderer and settings panel. It defines the behavior and default values to port. Open it in a browser before starting. Port its logic into typed modules; don't paste it in wholesale.

## Stack

| Layer | Choice |
|---|---|
| App shell | **Tauri v2**, Rust stable |
| Frontend | **Vite + TypeScript**, no UI framework (the overlay is a per-frame renderer; keep it lean) |
| Package manager | pnpm |
| Persistence | `settings.json` in the app data folder, written by `settings.rs` itself (temp file, fsync, rename), in the `{"settings": …}` shape `tauri-plugin-store` used before |
| Other plugins | `tray-icon` feature, `tauri-plugin-autostart`, `tauri-plugin-single-instance`, `tauri-plugin-global-shortcut` |
| Lyrics source | LRCLIB (`https://lrclib.net/api`), free, no key |
| Tests | `vitest` (TS), `cargo test` (Rust) |

## Architecture

```
┌──────────────────────────── Rust core ────────────────────────────┐
│ media::Watcher ──► NowPlaying ─┐                                   │
│   ├─ windows: SMTC (WinRT)     │                                   │
│   └─ macos: Spotify/Music via  ├─► events ──► all webviews         │
│      AppleScript               │                                   │
│ lyrics::Service (LRCLIB+cache)─┘                                   │
│ settings.rs (settings.json) ──► settings-changed                   │
│ desktop_layer ── pins the overlay window(s) to the desktop layer   │
│ tray / autostart / single-instance / global shortcut               │
└────────────────────────────────────────────────────────────────────┘
┌──────────────────────────── Webviews ─────────────────────────────┐
│ overlay window (one per display): clock ► lrc timing ► renderer   │
│ settings window: controls + live preview                          │
│ core/: lrc parser, word timing, playback clock, palette           │
└────────────────────────────────────────────────────────────────────┘
```

Rule of thumb: **Rust talks to the OS and the network. TypeScript does everything about time, color and drawing.**

## Repo layout

```
undertone/
  SPEC.md                              this file
  prototype/undertone.html             reference, read-only
  contract/contract.ts                 shared contract (TS side)
  src-tauri/src/contract.rs            shared contract (Rust side)
  index.html                           overlay entry
  settings.html                        settings entry
  src/                                 frontend
  tests/                               vitest + fixtures
  vite.config.ts, package.json         frontend tooling
  src-tauri/**                         Rust core
  .github/workflows/                   CI + release
```

## Contract v1

The only coupling between the two halves. Rust structs use `#[serde(rename_all = "camelCase")]` so JSON matches the TS exactly. The contract is v3 today: `contract/contract.ts` is authoritative, and v2 and v3 below only add to v1.

```ts
// contract/contract.ts
export const CONTRACT_VERSION = 1;

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

export interface Settings {
  version: 1;
  mode: Mode;
  autoColor: boolean;
  colors: { lyric: string; highlight: string; dim: string }; // #rrggbb
  font: { family: string; weight: number };
  size: number;        // 22–140 px at 1x scale
  curve: number;       // -100..100, used by "arc"
  yPos: number;        // 0..100, % of the display's work area, without menu bar, Dock or taskbar
  glow: number;        // 0..100
  opacity: number;     // 20..100
  showWhen: "playing" | "always";
  displays: "primary" | "all";
  globalOffsetMs: number;                  // -2000..2000
  trackOffsetsMs: Record<string, number>;  // keyed by trackKey
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1, mode: "arc", autoColor: true,
  colors: { lyric: "#f1ece3", highlight: "#f2a65a", dim: "#8d93a0" },
  font: { family: "Fraunces", weight: 700 },
  size: 58, curve: 38, yPos: 46, glow: 40, opacity: 100,
  showWhen: "playing", displays: "primary",
  globalOffsetMs: 0, trackOffsetsMs: {},
};
```

**Events (Rust → every webview)**

| Event | Payload | When |
|---|---|---|
| `now-playing` | `NowPlaying \| null` | Track change, play/pause, seek, and a resync at least every 1 s while playing. `null` when nothing is playing. |
| `lyrics` | `Lyrics` | `status: "loading"` immediately on track change, then the result. |
| `settings-changed` | `Settings` | After any successful update: from a window, the tray, a global shortcut, or a login-item check that found the OS's state changed. |

**Commands (webview → Rust)**

| Command | Returns |
|---|---|
| `get_settings()` | `Settings` |
| `update_settings(patch: Partial<Settings>)` | `Settings`. Each field is validated and clamped on its own, and an invalid value keeps the current one. A partial `colors`, `font` or `shortcuts` changes only the keys it has; `trackOffsetsMs` replaces the whole map. |
| `get_now_playing()` | `NowPlaying \| null` |
| `get_lyrics(trackKey: string)` | `Lyrics` |
| `refetch_lyrics(trackKey: string)` | `()` (bypasses the cache; result arrives on the `lyrics` event) |
| `set_track_offset(trackKey: string, ms: number)` | `Settings` (`ms` clamped to ±2000; 0 removes the song's entry) |
| `open_settings()` / `quit()` | `()` |

**Contract v2 (additive, 2026-10-06).** `CONTRACT_VERSION = 2`. Nothing above changed; `Settings.version` stays 1.

```ts
/** Why nothing is reported: macOS Automation is off for a running player, or no supported player runs. */
export type MediaProblem = "automation-denied" | "no-player";

export interface MediaStatus {
  /** the player being reported, or the player with the problem; null when none */
  source: Source | null;
  problem: MediaProblem | null;
}
```

| Event / command | Payload / returns | When |
|---|---|---|
| `media-status` event | `MediaStatus` | Right after the `now-playing` it goes with, only when it changed. A reported track (playing or paused) gives `{ source, problem: null }`; otherwise a running player with Automation denied gives `"automation-denied"` (Spotify first), no supported player or media session gives `"no-player"`, and anything else gives `{ source: null, problem: null }`. |
| `get_media_status()` | `MediaStatus` | The last status sent. |

**Contract v3 (additive, 2026-10-06).** `CONTRACT_VERSION = 3`. `Settings.version` stays 1; stored settings without the new fields get their defaults.

```ts
export type ShortcutAction = "toggleLyrics" | "nudgeEarlier" | "nudgeLater";

/** Accelerators such as "CmdOrCtrl+Alt+Shift+L": modifiers (at least one of CmdOrCtrl, Control,
 *  Alt or Super, plus optional Shift) then one key. "" leaves that action without a shortcut. */
export interface Shortcuts {
  enabled: boolean;      // false turns every global shortcut off
  toggleLyrics: string;
  nudgeEarlier: string;  // +50 ms for the current song
  nudgeLater: string;    // −50 ms for the current song
}

export type ShortcutState = "ok" | "off" | "unavailable" | "invalid";
export type ShortcutsStatus = Record<ShortcutAction, ShortcutState>;

// Settings gains:
enabled: boolean;        // default true; false hides the lyrics everywhere
launchAtLogin: boolean;  // default false; the OS login item follows it
shortcuts: Shortcuts;    // defaults: CmdOrCtrl+Alt+Shift+L / ] / [
```

| Event / command | Payload / returns | When |
|---|---|---|
| `shortcuts-status` event | `ShortcutsStatus` | After every registration pass, only when it changed. `"unavailable"` means the OS refused the registration: on Windows, another app's global shortcut or a combination Windows keeps for itself; macOS rarely refuses. Shortcuts that work only inside another app are never detected. |
| `get_shortcuts_status()` | `ShortcutsStatus` | The last status sent. |
| `suspend_shortcuts(suspended: boolean)` | `()` | Settings suspends the global shortcuts while it records a new one, so the old binding doesn't swallow the keys. Rust resumes on `false`, after 30 s, or when Settings hides, is minimized or loses focus. |

`enabled` replaces the tray's runtime-only "Hide lyrics" state: the tray item, the toggle shortcut and the Settings switch all change it, and it persists. `launchAtLogin` changes the login item in the same update (a failure keeps the old value and returns an error). Rust adopts the login item's real state at startup, whenever Settings opens and when the pointer enters the tray icon, and emits `settings-changed` when it differs. On macOS that state includes System Settings' **Allow in the Background** (`login_item.rs`): turning the item on while it is off there fails, and System Settings opens at Login Items. Invalid or duplicate shortcut bindings keep their current value, like every other field. **Reset to defaults** in Settings resets the shortcuts but keeps `enabled` and `launchAtLogin`.

**Changing the contract:** whoever needs the change edits `contract.ts` and `contract.rs` in the same commit, and bumps `CONTRACT_VERSION`. Add fields; don't rename or remove them.

**Auto colors** are computed in TypeScript from `artwork` and never written to settings. `colors` holds the user's manual choice, used when `autoColor` is false.

## Milestones

| | Rust core | Frontend |
|---|---|---|
| **M0** | Scaffold Tauri v2 + Vite multi-page, both contract files, empty windows. | Start immediately on `src/core/` (pure TS needs no scaffold). |
| **M1** | Overlay window pinned to the desktop layer on both OSes, showing a test page. | Overlay renders all 4 styles from the mock bridge in a browser (`pnpm dev`). |
| **M2** | Real now-playing on both OSes + LRCLIB service + cache. | Real bridge wired; clock, timing and colors working end to end. |
| **M3** | Settings store, tray/menu bar, autostart, shortcuts. | Settings window with live preview; all settings apply instantly. |
| **M4** | CI builds for Mac (universal) and Windows; installers; diagnostics. | Polish pass, performance, empty states, README and user guide. |

## Definition of done (v1)

- [ ] On macOS 14+ and Windows 10/11, lyrics render under desktop icons and every window, and clicks pass through to the desktop.
- [ ] Works with Spotify on both OSes and Apple Music on Mac, without logging in to anything.
- [ ] Lyrics appear within 1 s of a track change (instantly when cached).
- [ ] Word highlight stays within ±150 ms of the vocals after the user's offset is applied.
- [ ] Renderer stops its animation loop when paused, hidden, or nothing is playing. CPU stays under 3% while playing on a mid-range laptop.
- [ ] Every setting persists and applies live, including on a second monitor.
- [ ] Survives Explorer restarts, display changes, sleep/wake, and Spotify quitting and relaunching.

## Copyright rule

**Never commit real song lyrics.** Test fixtures use original placeholder lyrics written for this repo, like the demo song in the prototype. Real lyrics are only fetched at runtime and cached in the user's app data folder.
