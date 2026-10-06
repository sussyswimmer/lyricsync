# Undertone

Undertone shows the synced lyrics of the song you're playing on your desktop, between the wallpaper and your icons. Windows and folders sit on top of the lyrics, and clicks go straight through to the desktop. Words light up as they're sung, and the colors come from the album cover unless you pick your own. It lives in the menu bar on macOS and the system tray on Windows, with no Dock icon or taskbar button.

- **Players:** Spotify on macOS 14+ and Windows 10/11, and the Music app (Apple Music) on macOS. On Windows, other players that show up in the Windows media controls work too.
- **Lyrics:** fetched from [LRCLIB](https://lrclib.net), a free community lyrics database. No account and no API key.
- **Styles:** Arc, Lens, Drift and Stack, with your choice of font, size, curve, height, glow and opacity. [docs/USER_GUIDE.md](docs/USER_GUIDE.md) explains every setting.

**Not in v1:** the lock screen, Linux, mobile, playback controls (Undertone only reads what's playing) and bundled lyrics (lyrics are fetched when a song plays, never shipped with the app).

> **Status: pre-release.** Every part of v1 is built, but the desktop app hasn't been tested on a real Mac or Windows PC yet, so expect rough edges. Progress is logged in [docs/HANDOFF.md](docs/HANDOFF.md).

## Install

Released versions will be on [GitHub Releases](https://github.com/sussyswimmer/lyricsync/releases): the `.dmg` for macOS (one universal build for Apple silicon and Intel Macs) or the `-setup.exe` for Windows. Nothing is released yet, so for now take a test build from a CI run's artifacts, as [docs/INSTALL.md](docs/INSTALL.md#download) explains.

Builds aren't code-signed yet, so macOS and Windows warn you the first time you open Undertone. In short: on macOS, open it once, then click **Open Anyway** in **System Settings → Privacy & Security**; on Windows, click **More info**, then **Run anyway**. **[docs/INSTALL.md](docs/INSTALL.md)** has the full steps for each macOS version and Windows, the fix for "Undertone is damaged", WebView2, test builds from CI, updating and uninstalling.

After launch, Undertone shows up as an icon in the menu bar (macOS) or the system tray (Windows). Start a song and the lyrics appear on your desktop.

## Permissions

### macOS: Automation

The first time Undertone reads Spotify or Music, macOS asks whether **Undertone** may control **Spotify** (or **Music**). Click **OK**.

- **Why it's needed:** macOS has no public way for an app to see what another app is playing. Undertone asks Spotify and Music directly, through Apple Events, for the title, artist, album, length, position, play state and cover art. It only reads. It never starts, pauses or skips anything, and it checks that the player is already running before asking, so it never launches Spotify or Music by itself.
- **If you click Don't Allow:** Undertone can't see what that app is playing, so you get no lyrics for it. While that app is open, the settings window says so at the top ("Undertone can't see what Spotify is playing.") and names the switch to turn on. Nothing else breaks.
- **To turn it back on:** open **System Settings → Privacy & Security → Automation**, find **Undertone**, and switch on **Spotify** and/or **Music**. Undertone notices within about 5 seconds, without a restart, and the notice in Settings goes away. If Undertone or the player is missing from that list, or switching it on doesn't help, reset Undertone's Automation permission in Terminal with `tccutil reset AppleEvents com.undertone.desktop`, quit and reopen Undertone, and play a song to get the prompt again.

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
| **Quit Undertone** | Quits Undertone. |

**Sync** and **Refetch lyrics** are greyed out while no song is loaded. **Reset for this song** shows the current nudge, for example "Reset for this song (150 ms earlier)".

Opening Undertone again while it's already running (from Applications or the Start menu) opens the settings window.

### Keyboard shortcuts

These work from any app.

| macOS | Windows | What it does |
|---|---|---|
| ⌘⌥⇧L | Ctrl+Alt+Shift+L | Show or hide the lyrics |
| ⌘⌥⇧[ | Ctrl+Alt+Shift+[ | Nudge this song 50 ms later |
| ⌘⌥⇧] | Ctrl+Alt+Shift+] | Nudge this song 50 ms earlier |

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
- **One song is off:** nudge just that song with **Sync ▸ Earlier/Later 100 ms** in the menu, ⌘⌥⇧[ / ⌘⌥⇧] (Ctrl+Alt+Shift+[ / ] on Windows) for 50 ms steps, or the −100 / −50 / +50 / +100 buttons under **This song** in Settings → Sync. Undertone remembers the nudge for that song. **Reset for this song** in the menu, or **Reset this song** in Settings, clears it.

The song's nudge is added on top of the All songs offset. When a song's lyrics are timed by line only, Undertone estimates where each word falls, so judge the sync by when each line starts.

### Nothing shows up

1. **Is a song playing?** With **Show lyrics: While playing** (the default), lyrics hide when you pause and when nothing is playing. Choose **Always** to keep them up while paused.
2. **Are the lyrics hidden?** Use **Show/Hide lyrics** in the menu, or ⌘⌥⇧L / Ctrl+Alt+Shift+L.
3. **Is a window covering them?** The lyrics sit under every window, so a maximized or full-screen window hides them. Move windows aside or show the desktop.
4. **Is the player supported?** On macOS, Undertone reads the Spotify app and the Music app only (not players in a web browser). On Windows, the player must show up in the Windows media controls. When Undertone finds no such player open, **This song** in Settings → Sync says **No music app open**.
5. **On macOS, was Automation denied?** Then the settings window shows a notice at the top, such as "Undertone can't see what Spotify is playing.", with the switch to turn on. See [Permissions](#macos-automation).
6. **Are they faint?** Check **Opacity** and your colors in Settings, or turn on **Match album colors**.

### Lyrics on the wrong monitor

**Show on: Primary display** (the default) shows lyrics only on your main display: on macOS, the one with the menu bar (set it in System Settings → Displays); on Windows, the one marked "Make this my main display" in Settings → System → Display. Choose **All displays** to show them on every monitor. Each screen scales the lyrics to its own height.

### After an Explorer restart, sleep or a display change

Undertone reattaches the lyrics to the desktop by itself when Windows Explorer restarts, when your computer wakes from sleep, and when displays are connected, removed or rearranged. It also picks up again when Spotify quits and relaunches. If the lyrics don't come back, quit Undertone from the menu and open it again, then report the problem with the diagnostics below.

### Reporting a bug

Run Undertone with `--diagnose`. It reports what Undertone sees right now: the media sources it found and which one it picked, the current track, the LRCLIB match with its length difference, your settings, the lyrics cache, your displays and the desktop-layer window handles. It never includes lyric text, and it works while Undertone is running. The report is also saved to your temp folder as `undertone-diagnose-<date>-<time>.txt`, with the path on its last line. Attach that file to your bug report.

- **macOS** (Terminal): `open -n -a Undertone --args --diagnose`. The report opens in TextEdit. Running `/Applications/Undertone.app/Contents/MacOS/undertone --diagnose` prints it in Terminal instead, but then macOS checks Terminal's Automation permission rather than Undertone's, so the Automation lines may not match what the app sees.
- **Windows** (PowerShell): find the folder with `undertone.exe` (right-click Undertone in the Start menu and choose **Open file location**; if that opens a folder of shortcuts, do it again on the Undertone shortcut), open PowerShell there and run `.\undertone.exe --diagnose | Out-Host`, so PowerShell waits for the report. In Command Prompt, use `undertone.exe --diagnose | more`. Started from a shortcut, the report opens in your default text editor.

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

The Rust core in `src-tauri/src` has `media/` (now playing: the Windows media session, and AppleScript for Spotify and Music on macOS), `lyrics/` (LRCLIB and the cache), `settings.rs` (the settings store), `desktop_layer/`, `tray.rs`, `shortcuts.rs` and `diagnose.rs` (`--diagnose`). Native code builds only for Windows and macOS with the `desktop` feature; the decisions behind it are plain functions tested on every OS. The frontend listens to events first, then reads the initial settings and playback through commands.

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
| `?media=automation-denied\|no-player` | Act like a core that can't see the player: nothing playing, and `media-status` says why (`automation-denied` names Spotify). The settings window then shows its Automation notice, or **No music app open** under This song, and its preview plays the demo song as the app does. |
| `?wallpaper=dusk\|light\|busy\|none` | Stand-in wallpaper behind the overlay page (default `dusk`). |

For example, <http://localhost:1420/?mock&track=1&t=4900&settings=%7B%22mode%22%3A%22arc%22%7D> opens Paper Lanterns mid-line in Arc.

`?settings` applies only to the page it's on and isn't saved, so the other page keeps the saved settings until you change one. Give both pages the same `?settings=`, or make the change in the settings window, to keep them matching. The patch is shallow: a nested object such as `colors` is replaced whole, and any field you leave out of it falls back to its default.

`?media` works the same way: it applies only to its page and isn't saved, so without it the mock reports the demo player as usual. The settings window that the overlay page opens inherits it. To change it while both pages are open, run `undertone.bridge.setMedia("no-player")` (or `"automation-denied"`, or `null` to see the player again) in either page's console; the other page follows.

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
