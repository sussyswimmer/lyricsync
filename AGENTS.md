# AGENTS.md — Codex's half of Undertone

Read `SPEC.md` first. It holds the architecture, the contract and the ownership map. This file is your work order.

## Your role

You own **everything that touches the operating system and the network**: the Tauri shell, pinning the overlay to the desktop layer on both OSes, reading what's playing, fetching and caching lyrics, settings persistence, the tray/menu bar, and packaging/CI. Claude Code builds the frontend in parallel.

You got this half because it is long, systems-level, platform-specific work: Win32 and WinRT, AppKit via `objc2`, async Rust, and build pipelines. It needs careful, test-driven iteration more than visual judgment.

**Your paths:** `src-tauri/**`, `.github/workflows/**`, icons, `Info.plist`, bundling config. `contract/contract.ts` and `src-tauri/src/contract.rs` are shared; follow the change process in SPEC.
**Never edit:** `src/**`, `tests/**`, `index.html`, `settings.html` (after M0). Request changes in `docs/HANDOFF.md`.

## Ground rules

- Tauri **v2**. Rust stable, `clippy -D warnings`, `rustfmt`.
- Platform code goes behind `#[cfg(target_os = "...")]` modules with one shared trait each, so the other OS always compiles.
- Never block the main thread. Media polling and HTTP run on `tokio`.
- Emit events only on real change, plus the 1 s resync defined in SPEC.
- Branches named `codex/<task>`. Log each milestone in `docs/HANDOFF.md`.
- **Never commit real lyrics.** Rust test fixtures use original placeholder text.

## Target structure

```
src-tauri/src/
  main.rs · lib.rs        builder, plugins, state, command registration
  contract.rs             serde mirror of contract.ts (camelCase)
  commands.rs             every command from SPEC
  settings.rs             store, defaults, clamp, migrate, broadcast
  tray.rs                 tray / menu bar
  shortcuts.rs
  media/
    mod.rs                trait MediaSource + Watcher (picks source, dedupes, emits)
    windows.rs            SMTC
    macos.rs              Spotify + Music via AppleScript
    artwork.rs            fetch/convert art → data URL (≤ 300 px)
  lyrics/
    mod.rs                Service: lookup, dedupe in-flight, emit
    lrclib.rs             HTTP client
    matching.rs           title normalization + candidate ranking
    cache.rs              disk cache in app data dir
  desktop_layer/
    mod.rs                attach(window, monitor) / detach / reattach_all
    windows.rs            WorkerW / Progman parenting
    macos.rs              NSWindow desktop level
```

## Tasks

### X0 · Scaffold (do first, fast; Claude is waiting)
- `pnpm create tauri-app` with Tauri v2 and the vanilla TypeScript template.
- Vite multi-page config: `index.html` → overlay, `settings.html` → settings.
- Windows in `tauri.conf.json`:
  - `overlay`: transparent, `decorations: false`, `shadow: false`, `skipTaskbar: true`, `focus: false`, `resizable: false`, `visible: false` (shown after attach).
  - `settings`: normal window, about 380×640, hidden at start.
- macOS: enable `macOSPrivateApi` (needed for transparency). Set the activation policy to Accessory (no Dock icon).
- Create `contract/contract.ts` (copy from SPEC) and `contract.rs` with identical shapes. Add a test that serializes `DEFAULT_SETTINGS` and asserts the JSON keys.
- Stub every command and event so the frontend can call them.
- Commit, then log **"M0 done"** in `docs/HANDOFF.md`.

### X1 · Desktop layer (`desktop_layer/`)
**Windows**
1. Find `Progman` and send it `0x052C` (`SendMessageTimeout`) to spawn the `WorkerW` behind the icons.
2. `EnumWindows` to find the window that contains `SHELLDLL_DefView`. The **next** `WorkerW` sibling is the target.
3. **Windows 11 24H2 changed this hierarchy** (the `WorkerW` can now be a child of `Progman`). Detect both layouts. Check how Lively Wallpaper currently handles it, and test on 24H2 if possible.
4. `SetParent(overlay, target)`, then add styles `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`. Size the window to the monitor's full bounds in physical pixels (per-monitor DPI aware v2).
5. Re-attach when Explorer restarts (register for `TaskbarCreated`), and on `WM_DISPLAYCHANGE` and DPI change.

**macOS**
1. Get the `NSWindow` through `objc2` / `objc2-app-kit`.
2. Set the level to `CGWindowLevelForKey(kCGDesktopWindowLevelKey)`. This sits above the wallpaper and below the icons.
3. `ignoresMouseEvents = true`, `opaque = false`, clear background, no shadow.
4. `collectionBehavior = canJoinAllSpaces | stationary | ignoresCycle`.
5. Frame it to `NSScreen.frame`. Re-apply on `NSApplicationDidChangeScreenParametersNotification` and wake.

**Both**
- `displays: "all"` creates one overlay webview per monitor (labels `overlay-<n>`); `"primary"` uses only one.
- Hide the overlays when `showWhen: "playing"` and nothing is playing.
- **Accept:** folders and windows drag over the lyrics; clicking through lands on the desktop; it survives killing Explorer (Windows) and switching Spaces (Mac).

### X2 · Now playing (`media/`)
```rust
#[async_trait] trait MediaSource { async fn snapshot(&self) -> Option<RawTrack>; }
```
**Windows: SMTC** via the `windows` crate (`GlobalSystemMediaTransportControlsSessionManager`)
- Prefer the session whose `SourceAppUserModelId` contains `Spotify`; otherwise use the current session.
- Subscribe to `MediaPropertiesChanged`, `PlaybackInfoChanged` and `TimelinePropertiesChanged`, plus poll every 1 s while playing.
- Timeline updates from Spotify are coarse. Compute `sampledAt` from `LastUpdatedTime`, not from when you read it.
- Thumbnail: read the `IRandomAccessStreamReference` → resize to ≤ 300 px → data URL.

**macOS: AppleScript**, in-process via `NSAppleScript` (not spawning `osascript` each second)
- **Check the app is running first** (`NSWorkspace.runningApplications`). `tell application "Spotify"` launches Spotify if it's closed.
- Spotify: name, artist, album, duration (ms), player position (s), player state, artwork url. Fetch the art over HTTPS → data URL.
- Music: the same fields (duration in s). Art comes from `data of artwork 1 of current track`.
- Add `NSAppleEventsUsageDescription` to `Info.plist`. On denial, emit `null` and log a clear hint the settings window can show later (request a contract field if needed).
- Do **not** use the private MediaRemote framework; recent macOS versions restrict it.

**Watcher**
- Pick the source: a playing Spotify > a playing Music > the most recently active one.
- Build `trackKey` exactly as SPEC defines.
- Emit `now-playing` on change. Treat a jump of more than 1 s against the expected position as a seek.

### X3 · Lyrics (`lyrics/`)
- **Lookup:**
  1. `GET /api/get?track_name&artist_name&album_name&duration` (seconds).
  2. On a 404, `GET /api/search?track_name&artist_name`.
  3. Rank candidates: duration Δ ≤ 2 s, then ≤ 5 s; prefer non-empty `syncedLyrics`; then album match.
  4. Reject anything with Δ > 8 s.
- Send a `User-Agent` like `Undertone/0.1 (+repo url)`, as LRCLIB requests.
- `matching.rs` normalizes titles for the retry. Strip `- Remastered 2011`, `(feat. …)`, `- Live`, `(Radio Edit)` and similar; normalize quotes and diacritics only for comparison.
- Map the result to a `Lyrics` status: `instrumental` flag → `instrumental`; only plain text → `plain-only`; nothing → `not-found`.
- **Cache:** `appDataDir/lyrics/<sha1(trackKey)>.json`. Found results are kept indefinitely; not-found results expire after 7 days. `refetch_lyrics` bypasses the cache.
- Emit `loading` immediately, deduplicate in-flight requests, time out after 6 s → `error`.

### X4 · Settings (`settings.rs`)
- `tauri-plugin-store` → `settings.json`. Defaults come from the contract.
- On every update: clamp each field to the SPEC ranges, validate hex colors, drop unknown keys.
- `migrate()` by `version`.
- Broadcast `settings-changed` to all windows. Apply side effects: overlay count, visibility, autostart.

### X5 · Tray, autostart, shortcuts
- **Tray / menu bar menu:**
  - Show/Hide lyrics
  - Style ▸ Arc / Lens / Drift / Stack (radio items synced with settings)
  - Sync ▸ Earlier 100 ms / Later 100 ms / Reset for this song
  - Refetch lyrics
  - Settings…
  - Launch at login (`tauri-plugin-autostart`)
  - Quit
- `tauri-plugin-single-instance`: a second launch opens Settings.
- Global shortcuts (`tauri-plugin-global-shortcut`):
  - `Cmd/Ctrl+Alt+L` toggle lyrics.
  - `Cmd/Ctrl+Alt+[` / `]` nudge offset ±50 ms.

### X6 · Packaging and CI
- `.github/workflows/release.yml` using `tauri-apps/tauri-action`. Matrix: `macos-latest` (`--target universal-apple-darwin`) and `windows-latest`. Upload `.dmg` and NSIS `.exe` on tags `v*`.
- `ci.yml` on every PR:
  - `cargo fmt --check`, `clippy`, `cargo test` on both OSes.
  - `pnpm i && pnpm test && pnpm build`, so Claude's half is checked too.
- Generate icons with `pnpm tauri icon`. Builds are unsigned for now; document the Gatekeeper and SmartScreen workaround in a `docs/INSTALL.md` stub.

### X7 · Tests and diagnostics
- `cargo test`: `matching.rs` (normalization + ranking table tests), `trackKey`, settings clamp/migrate, cache TTL, contract JSON shape.
- A `undertone --diagnose` CLI flag that prints the detected media sources, the current track, the LRCLIB match with its duration Δ, and the desktop-layer handles. This is the first thing to run when something breaks.

## Handoffs Claude Code depends on (send early)

| Claude needs | By |
|---|---|
| M0 scaffold + stubbed commands/events | first, before anything else |
| Overlay attached on one OS | M1 (finish one OS before starting the other) |
| Real `now-playing` + `lyrics` events | M2 |

## Start here

1. Read `SPEC.md` and open `prototype/undertone.html` to see what the overlay must look like.
2. Do X0 and log **M0 done**.
3. X1 on your primary test OS → X2 → X3 → X1 on the second OS → X4–X7.
