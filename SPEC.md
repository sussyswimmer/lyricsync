# Undertone — Build Spec

Shared source of truth for both agents. Claude Code reads `CLAUDE.md`, Codex reads `AGENTS.md`, and both read this file first.

## What it is

A desktop app for **macOS and Windows** that shows the synced lyrics of whatever is playing on the **desktop layer**. That layer is above the wallpaper and below desktop icons and every window. The user can still drag folders and windows over it, and clicks pass straight through.

- Highlights word by word as the song plays, and the words move as they're sung. Lyrics timed by line only (no word tags) are swept word by word at the pace the song is sung around each line (`core/timing.ts` singingPace, paceWords), so a pause after a line doesn't slow the sweep.
- A look picked for each song: the style (Arc / Lens / Drift / Stack / Poster / Spotlight), the font and the motion's character come from the song's lyrics and their timing, its title and its cover (`src/core/songlook.ts`). The user doesn't choose them.
- Default colors come from the album cover: its most vivid color highlights, its overall tone tints the lyrics and the other lines, and gray covers get grays (`core/palette.ts`). The sung letters are filled with a gradient from the highlight into the cover's other main color (`Palette.accent`: the heaviest hue at least 40° away, a muted one counting by its area; `--ut-hl2`, `background-clip: text` in `stage.css`), or into the highlight's neighbor on the color wheel (`accentFor`). The user can override every color.
- Always in the middle of the screen, clear of the menu bar, Dock and taskbar. Customizable: size, effects (how much the words move), glow, opacity and colors.
- Effects mode (on by default): each song moves its own way (rise, bounce, sway, wave, pulse or drop), its big moments splash (droplets, sparks, confetti, ripples or glints), and words that name something drawable bring a bundled picture into the line that moves with the song: it hops word to word, flies or drives across, floats, falls, bursts, orbits, rolls or dances (`src/core/flair.ts`, `src/core/wordpics.ts`, `src/overlay/motion/decor.ts`, `src/overlay/motion/routes.ts`).
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
┌──────────────────────── Rust core (Codex) ────────────────────────┐
│ media::Watcher ──► NowPlaying ─┐                                   │
│   ├─ windows: SMTC (WinRT)     │                                   │
│   └─ macos: Spotify/Music via  ├─► events ──► all webviews         │
│      AppleScript               │                                   │
│ lyrics::Service (LRCLIB+cache)─┘                                   │
│ settings.rs (settings.json) ──► settings-changed                   │
│ desktop_layer ── pins the overlay window(s) to the desktop layer   │
│ tray / autostart / single-instance / global shortcut               │
└────────────────────────────────────────────────────────────────────┘
┌──────────────────────── Webviews (Claude Code) ───────────────────┐
│ overlay window (one per display): clock ► lrc timing ► renderer   │
│ settings window: controls + live preview                          │
│ core/: lrc parser, word timing, playback clock, palette           │
└────────────────────────────────────────────────────────────────────┘
```

Rule of thumb: **Rust talks to the OS and the network. TypeScript does everything about time, color and drawing.**

## Repo layout and ownership

```
undertone/
  SPEC.md · CLAUDE.md · AGENTS.md      shared (edit only by agreement)
  docs/HANDOFF.md                      shared log, both append
  prototype/undertone.html             reference, read-only
  contract/contract.ts                 shared contract (TS side)
  src-tauri/src/contract.rs            shared contract (Rust side)
  index.html                           overlay entry          ─┐
  settings.html                        settings entry          │
  src/                                 frontend                ├─ CLAUDE CODE
  tests/                               vitest + fixtures       │
  vite.config.ts, package.json         frontend tooling       ─┘  (after M0)
  src-tauri/** (except contract.rs)    Rust core              ─┐
  .github/workflows/                   CI + release            ├─ CODEX
  app icons, Info.plist, bundling      packaging              ─┘
```

**Never edit the other agent's paths.** If you need something from the other side, add a request to `docs/HANDOFF.md` and work against the mock until it lands.

Since 2026-10-06, Claude Code owns the whole repo at Maxwell's request (`docs/HANDOFF.md`, "Taking over the rest of the native side"); `AGENTS.md` is kept as the original work order.

## Contract v1

The only coupling between the two halves. Rust structs use `#[serde(rename_all = "camelCase")]` so JSON matches the TS exactly. The contract is v8 today: `contract/contract.ts` is authoritative, v2, v3, v4, v5, v7 and v8 below only add to v1, and v6 stops reading one field.

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
| `update_settings(patch: Partial<Settings>)` | `Settings`. Each field is validated and clamped on its own, and an invalid value keeps the current one. A partial `colors`, `font` or `shortcuts` changes only the keys it has; `trackOffsetsMs` and `nudgedTracks` replace the whole map and list. |
| `get_now_playing()` | `NowPlaying \| null` |
| `get_lyrics(trackKey: string)` | `Lyrics` |
| `refetch_lyrics(trackKey: string)` | `()` (bypasses the cache; result arrives on the `lyrics` event) |
| `set_track_offset(trackKey: string, ms: number \| null)` | `Settings` (`ms` clamped to ±2000 and kept, 0 included, and the song becomes the newest of `nudgedTracks`; `null` removes the song's entry and its place, since v7) |
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

**Contract v4 (additive, 2026-10-18).** `CONTRACT_VERSION = 4`. `Settings.version` stays 1; stored settings without `effects` read as 50. No event or command changed.

```ts
// Settings gains:
/** How much lyrics move as they're sung, 0..100; 50 is as picked for the song. */
effects: number;         // default 50

// Still validated and stored, but not read since v4:
mode: Mode;                                 // Undertone picks the style per song
font: { family: string; weight: number };   // the face is picked per song
curve: number;                              // Arc's curve is picked per song

// Still read, with a new meaning:
/** 0..100. Scales the bloom the song's look asks for (0 subtle, 40 as picked, 100 strongest) and
 *  softens the dark shadow. */
glow: number;
```

Undertone picks each song's look itself: the style, the face, Arc's curve and the motion's character, from the lyrics and their timing, the title and the cover (`src/core/songlook.ts`). The user scales it with Size, **Effects** and Glow, and doesn't choose it. Settings' Effects slider and the tray's **Effects ▸** Calm (20) / Balanced (50) / Lively (85) both write `effects` through `update_settings`. For QA, `--look=<style>[,<family>[,<curve>]]` on the app's command line and `?look=` on the overlay page force a look; neither is ever stored.

**Contract v5 (additive, 2026-10-19).** `CONTRACT_VERSION = 5`. `Settings.version` stays 1; stored settings without `effectsMode` read as `true`. No event or command changed.

```ts
// Settings gains:
/** Effects mode: each song moves its own way, big moments splash, and words that name something
 *  get a tiny picture. false: every word rises, nothing else is added. */
effectsMode: boolean;    // default true
```

Effects mode adds a **flair** to each song's picked look (`SongLook.flair`, chosen in `src/core/songlook.ts` from the same features as the rest of the look, plus what the lyrics mention): a `move` for most lines and an `accent` move for the hooks (lines sung more than once), each one of `rise` (the v4 motion), `bounce`, `sway`, `wave`, `pulse` or `drop` (`overlay/motion/params.ts` moveTuning), and a `splash` of `drops`, `sparks`, `confetti`, `ripple` or `glints`. `core/flair.ts` plans each line's decor: a splash on a held note, a hook's last word or a shouted line's (at most one a line, 5 s apart), and the pictures `core/wordpics.ts` matches (140 realistic pictures, each called by its own list of English words and phrases; one a line at most, 4 s apart, the same one 20 s apart). The pictures are bundled WebP files in `src/overlay/pictures/`, made once with Higgsfield. Each takes part in its line (`overlay/motion/routes.ts`): it hops from word to word as each is sung, flies or drives across, lifts off, floats up, falls with copies, bursts into copies, orbits, rolls off the end or dances on its word, from where the line's words are (the line's host element; modes that place words with transforms say where, KaraokeLook.spot), in the line's own picture layers (`.kw-pics`), until the line is sung (2.6 to 9 s). Some also live while they show (`overlay/motion/decor.ts` planPictureLife): a flame flickers in its own glow and a big one throws embers, a lamp or the sun or moon glows, a star twinkles, a heart beats, wings flap. Extras run on transform and opacity on the song timeline, each on its own window (`overlay/motion/line.ts`); none in the lite tier or for unsynced lyrics; without motion, pictures only fade and nothing splashes. Settings › Look's **Effects mode** switch and the tray's **Effects ▸ Effects mode** write `effectsMode`. For QA, `?flair=move[,accent[,splash]]` on the overlay page forces a flair; it is never stored.

**Contract v6 (2026-10-19).** `CONTRACT_VERSION = 6`. Nothing added or removed; `Settings.version` stays 1. No event or command changed.

```ts
// Still validated and stored, but not read since v6:
yPos: number;            // the lyrics always sit in the middle of the display's work area
```

The current line is centered on the overlay, which covers the display's work area: on macOS the screen below the menu bar and clear of the Dock, on Windows the monitor without the taskbar. In Arc the song's widest line is centered, its middle as far above the middle of the overlay as its ends below (`arcGeometry`'s `extent`), and shorter lines share its middle; in Lens the line coming next hangs below the centered one. Settings has no Height slider; Size sets how large the lyrics are.

**Contract v7 (additive, 2026-10-20).** `CONTRACT_VERSION = 7`. `Settings.version` stays 1; stored settings without `nudgedTracks` read as `[]`. `set_track_offset` also takes `ms: null`.

```ts
// Settings gains:
/** The songs whose sync was set most recently, oldest first, at most 9. */
nudgedTracks: string[];  // default []
// and trackOffsetsMs keeps a 0: it is a song's own offset now
```

**Learned sync.** A song you nudge keeps its own offset; any other song starts from what the songs you nudged last have in common (`src/core/sync.ts` `learnedOffsetMs`, `settings.rs` `learned_offset_ms`, the same rule): the middle of their own offsets, from two songs on, and with an even number the middle value nearer 0. So a correction you would make for every song (headphones that play late, say) is made once or twice, and one song with badly timed lyrics doesn't pull the others. A song's sync is `globalOffsetMs` plus its own offset or, without one, the learned one. "Reset this song" (`ms: null`) drops its own offset and its place among the nudged songs; Reset to defaults with "Also clear sync" empties both.

**Contract v8 (additive, 2026-10-20).** `CONTRACT_VERSION = 8`. `Settings.version` stays 1; stored settings without `karaokeMode` read as `false`. Effects mode is now off by default, and settings saved before v8 (without `karaokeMode`) have `effectsMode` turned off once as they load (`settings::migrate`, the mock's `migrateSettings`): until v8 it was on by default, so a stored `true` doesn't say anyone chose it.

```ts
// Settings gains:
/** Karaoke mode: a dot bounces onto each word of the line as it's sung. */
karaokeMode: boolean;    // default false
// and effectsMode's default is now false
```

**Karaoke mode.** Each sung line's karaoke (`overlay/motion/line.ts`) adds a dot (`.kw-ball`) to the layer over its words. `routes.ts` `planBall` plans it on the song's clock: it drops onto the line's first word just before it's sung, lands on each word exactly as that word starts, waits there while it's sung, and hops to the next in an arc as tall as the hop is long; after the last word it fades out where it is. In every style it lands on the word's own top (Poster's too, where pictures sit over the block). Under reduced motion and the lite tier it moves from word to word without arcing. Plain lyrics without timing get no dot.

**Changing the contract:** whoever needs the change edits `contract.ts` and `contract.rs` in the same commit, bumps `CONTRACT_VERSION`, and logs it in `docs/HANDOFF.md`. Add fields; don't rename or remove them.

**Auto colors** are computed in TypeScript from `artwork` and never written to settings. `colors` holds the user's manual choice, used when `autoColor` is false.

## Milestones

| | Codex | Claude Code |
|---|---|---|
| **M0** | Scaffold Tauri v2 + Vite multi-page, both contract files, empty windows. Push, then log "M0 done". | Start immediately on `src/core/` (pure TS needs no scaffold). |
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

## HANDOFF.md format

Append; never rewrite the other agent's entries.

```
## 2026-10-06 · Codex · M1
Done: desktop_layer attaches on Win11 23H2 + macOS 15.
Needs from Claude: nothing.
Contract: unchanged (v1).
```
