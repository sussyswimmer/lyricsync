# Undertone

Undertone shows the synced lyrics of the song you're playing on your desktop, between the wallpaper and your icons. Windows and folders sit on top of the lyrics, and clicks go straight through to the desktop. Words light up as they're sung, and the colors come from the album cover unless you pick your own. It lives in the menu bar on macOS and the system tray on Windows, with no Dock icon or taskbar button.

- **Players:** Spotify on macOS 14+ and Windows 10/11, and the Music app (Apple Music) on macOS. On Windows, other players that show up in the Windows media controls work too.
- **Lyrics:** fetched from [LRCLIB](https://lrclib.net), a free community lyrics database. No account and no API key.
- **Styles:** Arc, Lens, Drift and Stack, with your choice of font, size, curve, height, glow and opacity. [docs/USER_GUIDE.md](docs/USER_GUIDE.md) explains every setting.

**Not in v1:** the lock screen, Linux, mobile, playback controls (Undertone only reads what's playing) and bundled lyrics (lyrics are fetched when a song plays, never shipped with the app).

> **Status: pre-release.** The lyric renderer and settings run in a browser against a mock player. The native side (desktop layer, now playing, LRCLIB, tray, installers) is still being built. Progress is logged in [docs/HANDOFF.md](docs/HANDOFF.md).

## Install

Download the latest build from [GitHub Releases](https://github.com/sussyswimmer/lyricsync/releases):

- **macOS:** the `.dmg`. One universal build covers Apple silicon and Intel Macs. Open it and drag Undertone to Applications.
- **Windows:** the `-setup.exe` (NSIS installer).

Builds aren't code-signed yet, so macOS and Windows warn you the first time you open Undertone. To get past the warning:

- **macOS 14 (Sonoma):** in Applications, Control-click (or right-click) Undertone, choose **Open**, then click **Open** in the warning.
- **macOS 15 (Sequoia) and later:** open Undertone once and close the warning. Then go to **System Settings → Privacy & Security**, scroll down to **Security**, and click **Open Anyway** next to the message about Undertone. Click **Open Anyway** again and enter your password. This also works on macOS 14.
- **If macOS says Undertone "is damaged and can't be opened":** run `xattr -dr com.apple.quarantine /Applications/Undertone.app` in Terminal, then open it again.
- **Windows:** when SmartScreen shows "Windows protected your PC", click **More info**, then **Run anyway**.

You only need to do this once for each version you download.

After launch, Undertone shows up as an icon in the menu bar (macOS) or the system tray (Windows). Start a song and the lyrics appear on your desktop.

## Permissions

### macOS: Automation

The first time Undertone reads Spotify or Music, macOS asks whether **Undertone** may control **Spotify** (or **Music**). Click **OK**.

- **Why it's needed:** macOS has no public way for an app to see what another app is playing. Undertone asks Spotify and Music directly, through Apple Events, for the title, artist, album, length, position, play state and cover art. It only reads. It never starts, pauses or skips anything, and it checks that the player is already running before asking, so it never launches Spotify or Music by itself.
- **If you click Don't Allow:** Undertone can't see what that app is playing, so you get no lyrics for it. Nothing else breaks.
- **To turn it back on:** open **System Settings → Privacy & Security → Automation**, find **Undertone**, and switch on **Spotify** and/or **Music**. If Undertone or the player is missing from that list, or switching it on doesn't help, reset Undertone's Automation permission in Terminal with `tccutil reset AppleEvents com.undertone.desktop`, quit and reopen Undertone, and play a song to get the prompt again.

macOS asks once per player, so you may see the prompt a second time when you first use the other app.

### Windows

Nothing to grant. Undertone reads the system media session, the same information Windows shows in its media controls next to the volume slider. When several apps are playing, it prefers Spotify.

### Network

Undertone sends the title, artist, album and length of the current song to `lrclib.net` to look up lyrics. For Spotify on macOS, it also downloads the cover art from Spotify's image server. Lyrics are cached on your computer so the same song loads instantly next time.

## Using Undertone

### Menu bar / tray menu

| Item | What it does |
|---|---|
| **Show/Hide lyrics** | Hides the lyrics or brings them back. |
| **Style ▸** Arc / Lens / Drift / Stack | Switches the lyric style. The checkmark follows the setting. |
| **Sync ▸** Earlier 100 ms / Later 100 ms | Moves this song's lyrics earlier or later. Undertone remembers it for this song. |
| **Sync ▸** Reset for this song | Clears this song's sync nudge. |
| **Refetch lyrics** | Looks the current song up on LRCLIB again, skipping the cache. |
| **Settings…** | Opens the settings window. |
| **Launch at login** | Starts Undertone when you log in. |
| **Quit** | Quits Undertone. |

Opening Undertone again while it's already running (from Applications or the Start menu) opens the settings window.

### Keyboard shortcuts

These work from any app.

| macOS | Windows | What it does |
|---|---|---|
| ⌘⌥L | Ctrl+Alt+L | Show or hide the lyrics |
| ⌘⌥[ | Ctrl+Alt+[ | Nudge this song 50 ms later |
| ⌘⌥] | Ctrl+Alt+] | Nudge this song 50 ms earlier |

### Settings

The settings window has a live preview at the top that plays the current song, or a short demo when nothing is playing. Every change applies right away, on the desktop and in the preview. See [docs/USER_GUIDE.md](docs/USER_GUIDE.md) for what each setting does.

## Troubleshooting

### No lyrics, or the wrong song

- **"No lyrics for this song"** means LRCLIB has nothing that matches. Undertone looks the song up by title, artist, album and length, then falls back to a search by title and artist. It rejects any result whose length differs from your track by more than 8 seconds, so live versions, remasters and regional releases sometimes miss. Undertone remembers a miss for 7 days so it doesn't keep asking. **Refetch lyrics** asks again right away.
- **"Couldn't load lyrics"** means the lookup failed: no connection, or LRCLIB didn't answer within 6 seconds. Check your connection, then use **Refetch lyrics**.
- **Wrong lyrics:** **Refetch lyrics** skips the cache, which fixes lyrics that were corrected on LRCLIB since Undertone saved them. If LRCLIB's best match is itself wrong, refetching returns the same thing. Lyrics on LRCLIB are submitted by the community; [lrclib.net](https://lrclib.net) explains how to add or correct them.
- **Lyrics but no word highlight:** LRCLIB only has unsynced text for this song. Undertone paces the lines evenly across the song instead (see "Plain (unsynced) lyrics" in the [user guide](docs/USER_GUIDE.md#loading-missing-and-unsynced-lyrics)).

### Lyrics are early or late

Positive offsets make lyrics appear **earlier**; negative offsets make them appear **later**.

- **Every song is off by about the same amount** (for example, Bluetooth headphones that delay the sound): move the **All songs** slider in Settings → Sync, the global offset. If lyrics run ahead of the singer, move it toward Later (below 0).
- **One song is off:** nudge just that song with **Sync ▸ Earlier/Later 100 ms** in the menu, ⌘⌥[ / ⌘⌥] (Ctrl+Alt+[ / ] on Windows) for 50 ms steps, or the −100 / −50 / +50 / +100 buttons under **This song** in Settings → Sync. Undertone remembers the nudge for that song. **Reset for this song** in the menu, or **Reset this song** in Settings, clears it.

The song's nudge is added on top of the All songs offset. When a song's lyrics are timed by line only, Undertone estimates where each word falls, so judge the sync by when each line starts.

### Nothing shows up

1. **Is a song playing?** With **Show lyrics: While playing** (the default), lyrics hide when you pause and when nothing is playing. Choose **Always** to keep them up while paused.
2. **Are the lyrics hidden?** Use **Show/Hide lyrics** in the menu, or ⌘⌥L / Ctrl+Alt+L.
3. **Is a window covering them?** The lyrics sit under every window, so a maximized or full-screen window hides them. Move windows aside or show the desktop.
4. **Is the player supported?** On macOS, Undertone reads the Spotify app and the Music app only (not players in a web browser). On Windows, the player must show up in the Windows media controls.
5. **On macOS, was Automation denied?** See [Permissions](#macos-automation).
6. **Are they faint?** Check **Opacity** and your colors in Settings, or turn on **Match album colors**.

### Lyrics on the wrong monitor

**Show on: Primary display** (the default) shows lyrics only on your main display: on macOS, the one with the menu bar (set it in System Settings → Displays); on Windows, the one marked "Make this my main display" in Settings → System → Display. Choose **All displays** to show them on every monitor. Each screen scales the lyrics to its own height.

### After an Explorer restart, sleep or a display change

Undertone reattaches the lyrics to the desktop by itself when Windows Explorer restarts, when your computer wakes from sleep, and when displays are connected, removed or rearranged. It also picks up again when Spotify quits and relaunches. If the lyrics don't come back, quit Undertone from the menu and open it again, then report the problem with the diagnostics below.

### Reporting a bug

Run Undertone from a terminal with `--diagnose`. It prints the media sources it detected, the current track, the LRCLIB match with its length difference, and the desktop-layer window handles. Paste that output into your bug report.

- **macOS** (Terminal): `/Applications/Undertone.app/Contents/MacOS/undertone --diagnose`
- **Windows** (PowerShell): find the folder with `undertone.exe` (right-click Undertone in the Start menu and choose **Open file location**; if that opens a folder of shortcuts, do it again on the Undertone shortcut), open PowerShell there and run `.\undertone.exe --diagnose`.

## Development

Use Node 24+, pnpm 11 and Rust stable (`rust-toolchain.toml` selects the stable channel with clippy and rustfmt). For the desktop app, install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS: WebView2 and MSVC on Windows, Xcode command line tools on macOS.

```sh
pnpm install --frozen-lockfile
pnpm test                 # vitest
pnpm coverage             # vitest with coverage of src/core, src/bridge and the overlay's view.ts, look.ts and stage.ts
pnpm build                # tsc, then vite build into dist/
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
pnpm tauri dev            # the desktop app
```

`pnpm tauri dev` enables the `desktop` Cargo feature. Native checks must use it too: run `cargo check --features desktop` and `cargo clippy --features desktop -- -D warnings` from `src-tauri`. Linux can run the frontend and the portable Rust tests, but it isn't a supported desktop target. In cloud tasks, reuse the existing checkout; don't create a worktree unless asked.

The Rust commands are still stubs in places: settings live in memory until persistence lands (X4), now playing is `null` until the media watcher lands (X2), and lyrics lookup reports `error` until the LRCLIB service lands (X3). The frontend listens to events first, then reads the initial settings and playback through commands.

### Frontend in a browser

`pnpm dev` serves the frontend at <http://localhost:1420>. In a plain browser there is no Tauri, so both pages run against the **mock bridge**, a fake player that sends the same events as the Rust core. Open the overlay at <http://localhost:1420/> and the settings window at <http://localhost:1420/settings.html> side by side: they share the player and settings, so a change in one shows up in the other.

The mock plays six demo tracks with original placeholder lyrics:

| # | Track | Shows |
|---|---|---|
| 0 | Neon Monsoon | line-synced LRC (word timing estimated), 35 s |
| 1 | Paper Lanterns | enhanced LRC with real per-word timing, 24 s |
| 2 | Letters Never Sent | plain lyrics only (unsynced style) |
| 3 | Ultraviolet Static | not found |
| 4 | Tidal Interlude | instrumental, no cover art |
| 5 | Script Sampler | scripts and line shapes for visual QA: Japanese, Chinese, Korean, Vietnamese, right-to-left, very long and one-word lines, 42 s |

Keys in mock mode (ignored while a form control has focus):

| Key | Action |
|---|---|
| Space | Play / pause |
| ← / → | Seek −5 s / +5 s |
| N / Shift+N | Next / previous track |

URL parameters (combine them with `&`):

| Parameter | Effect |
|---|---|
| `?mock` | Use the mock even inside the Tauri webview. A plain browser always uses it. |
| `?track=N` | Start on demo track N (0–5). |
| `?t=MS` | Start at this position, in ms. |
| `?paused` | Start paused. |
| `?settings=JSON` | URL-encoded JSON patch over the saved settings, e.g. `%7B%22mode%22%3A%22lens%22%7D` for `{"mode":"lens"}`. |
| `?wallpaper=dusk\|light\|busy\|none` | Stand-in wallpaper behind the overlay page (default `dusk`). |

For example, <http://localhost:1420/?mock&track=1&t=4900&settings=%7B%22mode%22%3A%22arc%22%7D> opens Paper Lanterns mid-line in Arc.

`?settings` applies only to the page it's on and isn't saved, so the other page keeps the saved settings until you change one. Give both pages the same `?settings=`, or make the change in the settings window, to keep them matching. The patch is shallow: a nested object such as `colors` is replaced whole, and any field you leave out of it falls back to its default.

The mock remembers the player and settings in `localStorage`. `track`, `t` and `paused` override the saved player; run `localStorage.clear()` in the devtools console to start fresh. On the overlay page, `window.undertone` exposes `{ bridge, stage, controller }` for poking at it from the console, for example `undertone.bridge.player.select(1, 5000)`.

### Layout

```
contract/contract.ts   shared types (mirrored in src-tauri/src/contract.rs)
src/bridge/            Tauri bridge, mock bridge, and the switch between them
src/core/              LRC parser, word timing, playback clock, album palette (pure TS)
src/overlay/           the lyric stage, controller, empty states and fonts
src/overlay/modes/     arc, lens, drift (stack is drift without depth)
src/settings/          settings window and its live preview
src/styles/            CSS
tests/                 vitest suites; tests/fixtures/ holds original placeholder LRC
src-tauri/             Rust core: media, lyrics, settings, tray, desktop layer
prototype/             undertone.html, the reference prototype
```

[SPEC.md](SPEC.md) holds the architecture and the contract between the TypeScript and Rust halves. To change the contract, edit `contract.ts` and `contract.rs` in the same commit, bump `CONTRACT_VERSION`, and log it in `docs/HANDOFF.md`; add fields rather than renaming or removing them. [CLAUDE.md](CLAUDE.md) and [AGENTS.md](AGENTS.md) are the work orders for the frontend and the Rust core.

**Never commit real song lyrics.** Fixtures and demo tracks use original placeholder text written for this repo. Real lyrics are only fetched at runtime and cached on the user's machine.
