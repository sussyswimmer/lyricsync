# Undertone

Undertone shows the synced lyrics of the song you're playing on your desktop, between the wallpaper and your icons. Windows and folders sit on top of the lyrics, and clicks go straight through to the desktop. Undertone picks a look for each song, the style and the font, from how it's sung and what its cover looks like. Words light up and move as they're sung, and the colors come from the album cover unless you pick your own. It lives in the menu bar on macOS and the system tray on Windows, with no Dock icon, and on Windows no taskbar button except while Settings is open.

- **Players:** Spotify on macOS 14+ and Windows 10/11, and the Music app (Apple Music) on macOS. On Windows, other players that show up in the Windows media controls work too.
- **Lyrics:** fetched from [LRCLIB](https://lrclib.net), a free community lyrics database. No account and no API key.
- **A look for each song:** Arc, Lens, Drift or Stack, in one of eight fonts, picked by Undertone for every song. They always sit in the middle of the screen; you set the size, effects (how much the words move), glow, opacity and colors. [docs/USER_GUIDE.md](docs/USER_GUIDE.md) explains every setting.
- **Effects mode** (on by default): each song moves its own way. Words rise, bounce, sway, wave, pulse or drop into place. A song's big moments splash: droplets, sparks, confetti, ripples or glints. A word that names something you can picture, such as *iced tea*, *rain*, *roses*, *a guitar* or *the moon*, gets a tiny realistic picture beside it as it's sung, and some come alive: a flame flickers and glows, a heart beats, a star twinkles. The 140 pictures come with the app, so this works offline. Turn the switch off in **Settings › Look** or the tray's **Effects ▸** menu to give every song the same calm rise.

**Not in v1:** the lock screen, Linux, mobile, playback controls (Undertone only reads what's playing) and bundled lyrics (lyrics are fetched when a song plays, never shipped with the app).

> **Status: pre-release.** Every part of v1 is built. A first run on a real Mac (macOS 26, Spotify) showed the song, cover art and lyrics arriving and the overlay sitting on the desktop. The rest of the Mac checks, Apple Music and Windows haven't been run yet, so expect rough edges. Progress is logged in [docs/HANDOFF.md](docs/HANDOFF.md).

## Install

Released versions will be on [GitHub Releases](https://github.com/sussyswimmer/lyricsync/releases): the `.dmg` for macOS (one universal build for Apple silicon and Intel Macs) or the `-setup.exe` for Windows. Nothing is released yet, so for now take a test build from a CI run's artifacts, as [docs/INSTALL.md](docs/INSTALL.md#download) explains.

Builds aren't code-signed yet, so macOS and Windows warn you the first time you open Undertone. In short: on macOS, open it once, then click **Open Anyway** in **System Settings → Privacy & Security**; on Windows, click **More info**, then **Run anyway**. **[docs/INSTALL.md](docs/INSTALL.md)** has the full steps for each macOS version and Windows, the fix for "Undertone is damaged", WebView2, test builds from CI, updating and uninstalling.

After launch, Undertone shows up as an icon in the menu bar (macOS) or the system tray (Windows). The first time, the settings window opens too. Start a song and the lyrics appear on your desktop.

## Permissions

### macOS: Automation

The first time Undertone reads Spotify or Music, macOS asks whether **Undertone** may control **Spotify** (or **Music**). Click **OK**.

- **Why it's needed:** macOS has no public way for an app to see what another app is playing. Undertone asks Spotify and Music directly, through Apple Events, for the title, artist, album, length, position, play state and cover art. It only reads. It never starts, pauses or skips anything, and it checks that the player is already running before asking, so it never launches Spotify or Music by itself.
- **If you click Don't Allow:** Undertone can't see what that app is playing, so you get no lyrics for it. While that app is open, the settings window says so at the top ("Undertone can't see what Spotify is playing.") and names the switch to turn on. Nothing else breaks.
- **To turn it back on:** open **System Settings → Privacy & Security → Automation**, find **Undertone**, and switch on **Spotify** and/or **Music**. Undertone notices within about 10 seconds, without a restart, and the notice in Settings goes away. If Undertone or the player is missing from that list, or switching it on doesn't help, reset Undertone's Automation permission in Terminal with `tccutil reset AppleEvents com.undertone.desktop`, quit and reopen Undertone, and play a song to get the prompt again.

macOS asks once per player, so you may see the prompt a second time when you first use the other app.

### Windows

Nothing to grant. Undertone reads the system media session, the same information Windows shows in its media controls next to the volume slider. When several apps are playing, it prefers Spotify.

### Network

Undertone sends the title, artist, album and length of the current song to `lrclib.net` to look up lyrics. For Spotify on macOS, it also downloads the cover art from Spotify's image server. Lyrics are cached on your computer so the same song loads instantly next time.

If you set a proxy by hand in your system's network settings, Undertone uses it. A proxy set up automatically (a PAC script or WPAD) isn't supported.

## Using Undertone

### Menu bar / tray menu

| Item | What it does |
|---|---|
| **Hide lyrics** / **Show lyrics** | Hides the lyrics or brings them back, the same as **Lyrics on the desktop** in Settings. Undertone remembers it. |
| **Effects ▸** Calm / Balanced / Lively | How much the words move as they're sung, the same as **Effects** in Settings › Look: Calm sets 20, Balanced 50 (the default), Lively 85. The checkmark follows the setting, also when you set it in Settings. |
| **Effects ▸** Effects mode | Turns Effects mode on or off, the same as the switch in Settings › Look: each song's own motion, splashes and word pictures. |
| **Sync ▸** Earlier 100 ms / Later 100 ms | Moves this song's lyrics earlier or later. Undertone remembers it for this song. |
| **Sync ▸** Reset for this song | Clears this song's sync nudge. |
| **Refetch lyrics** | Looks the current song up on LRCLIB again, skipping the cache. |
| **Settings…** | Opens the settings window. |
| **Launch at login** | Starts Undertone when you log in, the same as the switch in Settings › General. |
| **Quit Undertone** | Quits Undertone. |

**Sync** and **Refetch lyrics** are greyed out while no song is loaded. **Reset for this song** shows the current nudge, for example "Reset for this song (150 ms earlier)".

Opening Undertone again while it's already running (from Applications or the Start menu) opens the settings window.

### Keyboard shortcuts

These work from any app. They are the defaults: you can change each one, remove it, or turn them all off in **Settings › Shortcuts**.

| macOS | Windows | What it does |
|---|---|---|
| ⌥⇧⌘L | Ctrl+Alt+Shift+L | Show or hide the lyrics |
| ⌥⇧⌘[ | Ctrl+Alt+Shift+[ | Nudge this song 50 ms later |
| ⌥⇧⌘] | Ctrl+Alt+Shift+] | Nudge this song 50 ms earlier |

If one of them clashes with another app (JetBrains IDEs use ⌥⇧⌘L / Ctrl+Alt+Shift+L, and on Windows some keyboard layouts type characters with AltGr, which counts as Ctrl+Alt), record a different one. Settings warns under a shortcut only when the system refuses it: on Windows, when another app already has it as a global shortcut or Windows keeps it for itself; on a Mac this is rare. Shortcuts that work only inside another app, like JetBrains' Reformat File, can't be detected. The [user guide](docs/USER_GUIDE.md#shortcuts) explains how.

### Settings

The settings window has a live preview at the top that plays the current song, or a short demo when nothing is playing. Under it, **Picked for this song** names the style and font Undertone picked for that song, and why: you don't choose them. **General** turns the lyrics on or off and sets **Launch at login**; **Look** has the **Effects mode** switch (each song's own motion, splashes and word pictures) and sets the size, **Effects** (from Calm to Lively: how much words rise, swell and ripple), glow and opacity; **Shortcuts**, near the bottom, changes the keyboard shortcuts. Every change applies right away, on the desktop and in the preview. See [docs/USER_GUIDE.md](docs/USER_GUIDE.md) for what each setting does.

## Troubleshooting

### No lyrics, or the wrong song

- **"No lyrics for this song"** means LRCLIB has nothing that matches. Undertone looks the song up by title, artist, album and length, then the same without the album (a player's album name often differs from LRCLIB's), then searches by title and artist. Songs by several artists match however the credits are written ("A & B", "A, B", "A feat. B", "A x B"). It rejects any result whose length differs from your track by more than 8 seconds, so live versions, remasters and regional releases sometimes miss. Undertone remembers a miss for 7 days so it doesn't keep asking. **Refetch lyrics** asks again right away.
- **"Couldn't load lyrics"** means the lookup failed: no connection, or no answer from LRCLIB within 15 seconds. LRCLIB's search often answers "busy, try again in a second", so Undertone asks it up to four times before giving up. It then tries again by itself after 5, 20 and 60 seconds, and the lyrics appear as soon as one try works. If they don't, check your connection (and your proxy, see [Network](#network)), then use **Refetch lyrics**.
- **Wrong lyrics:** **Refetch lyrics** skips the cache, which fixes lyrics that were corrected on LRCLIB since Undertone saved them. If LRCLIB's best match is itself wrong, refetching returns the same thing. Lyrics on LRCLIB are submitted by the community; [lrclib.net](https://lrclib.net) explains how to add or correct them.
- **Lyrics but no word highlight, drifting from the singer:** LRCLIB only has unsynced text for this song. Undertone looks for a synced version of the same song (another album or edition) right away and switches to it if it finds one. Without one, it can only guess the pace, by the length of each line and the gaps between verses, so it drifts when the singer speeds up or slows down. The lines around the current one stay easy to read meanwhile (see "Plain (unsynced) lyrics" in the [user guide](docs/USER_GUIDE.md#loading-missing-and-unsynced-lyrics)). When you play the song more than 30 days later, Undertone looks for synced lyrics again; **Refetch lyrics** looks right away. Synced lyrics whose timestamps would keep one line up for most of the song are shown the same way.

### Lyrics are early or late

Positive offsets make lyrics appear **earlier**; negative offsets make them appear **later**.

- **Every song is off by about the same amount** (for example, Bluetooth headphones that delay the sound): move the **All songs** slider in Settings → Sync, the global offset. If lyrics run ahead of the singer, move it toward Later (below 0).
- **One song is off:** nudge just that song with **Sync ▸ Earlier/Later 100 ms** in the menu, ⌥⇧⌘[ / ⌥⇧⌘] (Ctrl+Alt+Shift+[ / ] on Windows, unless you've changed them) for 50 ms steps, or the −100 / −50 / +50 / +100 buttons under **This song** in Settings → Sync. Undertone remembers the nudge for that song. **Reset for this song** in the menu, or **Reset this song** in Settings, clears it.

The song's nudge is added on top of the All songs offset. Most songs' lyrics are timed by line only: Undertone then works out when each word is sung, at the pace the song is being sung, so judge the sync by when each line starts. Lyrics timed word by word follow every word exactly.

### Nothing shows up

1. **Is a song playing?** With **When: While playing** (the default, in Settings › Behavior), lyrics hide when you pause and when nothing is playing. Choose **Always** to keep them up while paused.
2. **Are the lyrics turned off?** Then the preview in Settings says **Off on the desktop**. Switch on **Lyrics on the desktop** in Settings › General, choose **Show lyrics** in the menu, or press ⌥⇧⌘L / Ctrl+Alt+Shift+L (the default shortcut).
3. **Is a window covering them?** The lyrics sit under every window, so a maximized or full-screen window hides them. Move windows aside or show the desktop.
4. **Is the player supported?** On macOS, Undertone reads the Spotify app and the Music app only (not players in a web browser). On Windows, the player must show up in the Windows media controls. When Undertone finds no such player open, **This song** in Settings → Sync says **No music app open**.
5. **On macOS, was Automation denied?** Then the settings window shows a notice at the top, such as "Undertone can't see what Spotify is playing.", with the switch to turn on. See [Permissions](#macos-automation).
6. **On macOS, does Settings play the demo song while Spotify or Music plays, with no notice at the top?** Then macOS hasn't given Undertone an answer yet. It should ask whether Undertone may control the player a few seconds after you open Undertone; click **OK**. If no prompt appears and Undertone isn't listed under System Settings → Privacy & Security → Automation, quit Undertone from the menu, run `tccutil reset AppleEvents com.undertone.desktop` in Terminal, open Undertone again and play a song.
7. **Are they faint?** Check **Opacity** and your colors in Settings, or turn on **Match album colors**.

### Lyrics on the wrong monitor

**Where: Primary display** (the default, in Settings › Behavior) shows lyrics only on your main display: on macOS, the one with the menu bar (set it in System Settings → Displays); on Windows, the one marked "Make this my main display" in Settings → System → Display. Choose **All displays** to show them on every monitor. Each screen scales the lyrics to its own height.

### After an Explorer restart, sleep or a display change

Undertone reattaches the lyrics to the desktop by itself when Windows Explorer restarts, when your computer wakes from sleep, and when displays are connected, removed or rearranged. It also picks up again when Spotify quits and relaunches. If the lyrics don't come back, quit Undertone from the menu and open it again, then report the problem with the diagnostics below.

### Settings went back to the defaults

Undertone keeps your settings, including each song's sync nudge, in `settings.json` in its data folder: `~/Library/Application Support/com.undertone.desktop` on macOS, `%APPDATA%\com.undertone.desktop` on Windows. It saves the file in one step, so a crash can't leave half a file. If the file still can't be read, Undertone renames it to `settings.corrupt-<number>.json` in the same folder, starts from the defaults and opens the settings window. Cached lyrics are kept.

### Reporting a bug

Run Undertone with `--diagnose`. It reports what Undertone sees right now: the media sources it found and which one it picked, the current track, the LRCLIB match with its length difference, your settings with the login item as your system keeps it, the lyrics cache, your displays and the desktop-layer window handles. It never includes lyric text, and it works while Undertone is running. The report is also saved to your temp folder as `undertone-diagnose-<date>-<time>.txt`, with the path on its last line. Attach that file to your bug report.

- **macOS** (Terminal): `open -n -a Undertone --args --diagnose`. The report opens in TextEdit. Running `/Applications/Undertone.app/Contents/MacOS/undertone --diagnose` prints it in Terminal instead, but then macOS checks Terminal's Automation permission rather than Undertone's, so the Automation lines may not match what the app sees.
- **Windows** (PowerShell): find the folder with `undertone.exe` (right-click Undertone in the Start menu and choose **Open file location**; if that opens a folder of shortcuts, do it again on the Undertone shortcut), open PowerShell there and run `.\undertone.exe --diagnose | Out-Host`, so PowerShell waits for the report. In Command Prompt, use `undertone.exe --diagnose | more`. Started from a shortcut, the report opens in your default text editor.

Undertone also keeps a log of what went wrong while it ran, such as a lyrics lookup that failed or a shortcut it couldn't register. It may name songs, but never holds lyric text. `--diagnose` ends with its last 60 lines under **Recent log**; if you can, attach the whole file too:

- **macOS:** `~/Library/Logs/com.undertone.desktop/undertone.log`
- **Windows:** `%LOCALAPPDATA%\com.undertone.desktop\logs\undertone.log`

When the log reaches 512 KB it moves to `undertone.1.log` next to it, replacing the one before.

## Development

Use Node 24+, pnpm 11 and Rust stable (`rust-toolchain.toml` selects the stable channel with clippy and rustfmt). For the desktop app, install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS: WebView2 and MSVC on Windows, Xcode command line tools on macOS.

```sh
pnpm install --frozen-lockfile
pnpm test                 # vitest
pnpm coverage             # vitest with coverage of src/core, src/bridge, src/overlay/motion and the overlay's view.ts, look.ts and stage.ts; fails below 90% on lrc.ts, timing.ts or clock.ts, or below 85% (75% of branches) on songlook.ts and the motion engine (CI runs this)
pnpm build                # tsc, then vite build into dist/
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
pnpm tauri dev            # the desktop app
node scripts/notices.mjs  # regenerate THIRD_PARTY_NOTICES.txt after changing dependencies
```

`THIRD_PARTY_NOTICES.txt` lists every font, JavaScript package and Rust crate the installers ship, with its license. The installers copy it next to the app, and **Settings › Licenses** shows it. CI's **Third-party notices** job runs `node scripts/notices.mjs --check` and fails when the file is out of date.

`pnpm tauri dev` enables the `desktop` Cargo feature. Native checks must use it too: run `cargo check --features desktop` and `cargo clippy --features desktop -- -D warnings` from `src-tauri`. Linux can run the frontend and the portable Rust tests, but it isn't a supported desktop target. In cloud tasks, reuse the existing checkout; don't create a worktree unless asked.

The Rust core in `src-tauri/src` has `media/` (now playing: the Windows media session, and AppleScript for Spotify and Music on macOS), `lyrics/` (LRCLIB and the cache), `settings.rs` (settings.json), `login_item.rs` (launch at login: macOS's Allow in the Background, and pointing the login item at a moved app on both OSes), `applog.rs` (the runtime log), `desktop_layer/`, `tray.rs`, `shortcuts.rs` and `diagnose.rs` (`--diagnose`). Native code builds only for Windows and macOS with the `desktop` feature; the decisions behind it are plain functions tested on every OS. The frontend listens to events first, then reads the initial settings and playback through commands.

Debug builds read four more flags: `--media-test` prints each now-playing and lyrics event, `--overlay-probe` prints every 2 s whether each page is visible and drawing, `--desktop-layer-test` shows a test line in place of the lyrics, even with nothing playing, and `--desktop-layer-all` shows the overlay on every display. Pass them with two `--`, as in `pnpm tauri dev -- -- --media-test`. [docs/NOW_PLAYING.md](docs/NOW_PLAYING.md) and [docs/DESKTOP_LAYER.md](docs/DESKTOP_LAYER.md) explain them, and [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) lists the checks a real Mac and PC still need.

Every build, release included, also reads `--look=<style>[,<family>[,<curve>]]`. It makes every overlay draw with that style (`arc`, `lens`, `drift` or `stack`) instead of the look Undertone picks for each song, optionally in that face (a family name such as `Instrument Serif`) and, for Arc, with that curve (−100 to 100). An empty part keeps the pick, as in `--look=arc,,-50`. It's for checking one style on purpose, as the CPU checks in [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) do, and it's never saved; a malformed value is ignored (the log says why). Quit Undertone first, then start it with the flag: `pnpm tauri dev -- -- --look=lens`, `open -a Undertone --args --look=lens` on macOS, or `undertone.exe --look=lens` on Windows. In a browser, the overlay page's `?look=` does the same.

### Frontend in a browser

`pnpm dev` serves the frontend at <http://localhost:1420>. In a plain browser there is no Tauri, so both pages run against the **mock bridge**, a fake player that sends the same events as the Rust core. Open the overlay at <http://localhost:1420/> and the settings window at <http://localhost:1420/settings.html> side by side: they share the player and settings, so a change in one shows up in the other.

The mock plays ten demo tracks with original placeholder lyrics:

| # | Track | Shows |
|---|---|---|
| 0 | Neon Monsoon | line-synced LRC (words paced to the song), 35 s |
| 1 | Paper Lanterns | enhanced LRC with real per-word timing, 24 s |
| 2 | Letters Never Sent | plain lyrics only (unsynced style) |
| 3 | Ultraviolet Static | not found |
| 4 | Tidal Interlude | instrumental, no cover art |
| 5 | Script Sampler | scripts and line shapes for visual QA: Japanese, Chinese, Korean, Vietnamese, right-to-left, very long and one-word lines, 42 s |
| 6 | Glass Harbor | the motion demo: syllable-timed enhanced LRC, held line endings that light letter by letter, and an intro and a mid-song break long enough for the interlude dots, 38 s |
| 7 | Ledger Lines | a look demo: a fast, dense verse under a black-and-white cover, which Undertone sets as Stack in Bricolage, 76 s |
| 8 | Strobe Hearts (Club Mix) | a look demo: short shouted hooks, a club edit and a neon-on-black cover, set as Lens in Unbounded capitals, 66 s |
| 9 | Glacier Nocturne | a look demo: sparse, slow lines with long instrumental breaks under a cold, dark cover, set as Drift in Instrument Serif, 118 s |

Keys in mock mode (ignored while a form control has focus):

| Key | Action |
|---|---|
| Space | Play / pause |
| ← / → | Seek −5 s / +5 s |
| N / Shift+N | Next / previous track |
| S | Open Settings, as the tray's **Settings…** does (it carries this page's `?media` and `?loginItem`) |

The global shortcuts work too, while the page has focus: the default ⌥⇧⌘L / Ctrl+Alt+Shift+L turns the lyrics off and on (the overlay page hides them, the settings preview shows **Off on the desktop**), and the nudges change the current song's offset. They follow what you record in Settings › Shortcuts, and pause while Settings listens for a new one.

URL parameters (combine them with `&`):

| Parameter | Effect |
|---|---|
| `?mock` | Use the mock even inside the Tauri webview. A plain browser always uses it. |
| `?track=N` | Start on demo track N (0–9). |
| `?t=MS` | Start at this position, in ms. |
| `?paused` | Start paused. |
| `?settings=JSON` | URL-encoded JSON patch over the saved settings, e.g. `%7B%22effects%22%3A80%7D` for `{"effects":80}`. In the mock, `mode`, `font` and `curve` in it force a look like `?look=` (the app no longer reads them). |
| `?look=STYLE[,FAMILY[,CURVE]]` | On the overlay page, with either bridge: draw every song in that style (`arc`, `lens`, `drift` or `stack`), optionally in that font family and, for Arc, with that curve (−100 to 100), instead of the look Undertone picks. An empty part keeps the pick: `?look=lens`, `?look=lens,Syne`, `?look=arc,,-50`. Never saved. |
| `?power=full\|lite` | On the overlay page: force the full motion, or the lighter drawing Undertone uses on computers without graphics acceleration (detected otherwise). Effects mode's splashes and pictures need the full motion. |
| `?flair=MOVE[,ACCENT[,SPLASH]]` | On the overlay page, with either bridge: force the song's Effects mode flair instead of the one Undertone picks. MOVE and ACCENT are each `rise`, `bounce`, `sway`, `wave`, `pulse` or `drop`; ACCENT is how the song's repeated lines (its hooks) move, and follows MOVE when left out. SPLASH is `drops`, `sparks`, `confetti`, `ripple` or `glints`. An empty part keeps the pick: `?flair=bounce`, `?flair=sway,pulse,confetti`, `?flair=,,drops`. Never saved. |
| `?shortcutConflict=toggleLyrics,nudgeLater` | Act as if another app held the combinations those actions start with: they report `"unavailable"` in `shortcuts-status`, and Settings warns under them. Recording a different combination clears the warning. Actions: `toggleLyrics`, `nudgeEarlier`, `nudgeLater`. |
| `?media=automation-denied\|no-player` | Act like a core that can't see the player: nothing playing, and `media-status` says why (`automation-denied` names Spotify). The settings window then shows its Automation notice, or **No music app open** under This song, and its preview plays the demo song as the app does. |
| `?loginItem=refuse` | Act like a core whose system refuses the login item: a **Launch at login** change fails, the rest of the change applies, and Settings shows its note under the switch. |
| `?wallpaper=dusk\|light\|busy\|none` | Stand-in wallpaper behind the overlay page (default `dusk`). |

For example, <http://localhost:1420/?mock&track=1&t=4900&look=arc> opens Paper Lanterns mid-line in Arc, whatever Undertone would pick for it, and <http://localhost:1420/?mock&track=8> plays Strobe Hearts in the look Undertone picks (Lens, in Unbounded). <http://localhost:1420/?mock&track=9&t=7000&flair=,,drops> plays Glacier Nocturne just before its snowflake picture and its first splash.

`?settings` applies only to the page it's on and isn't saved, so the other page keeps the saved settings until you change one. Give both pages the same `?settings=`, or make the change in the settings window, to keep them matching. The patch is applied like `update_settings`: inside `colors`, `font` or `shortcuts` only the keys you give change, and the rest keep their saved values. `trackOffsetsMs` replaces the whole map, and invalid values are ignored.

`?media` and `?loginItem` work the same way: they apply only to their page and aren't saved, so without them the mock reports the demo player and accepts the login item as usual. The settings window the overlay page opens (press S) inherits both. To change the media problem while both pages are open, run `undertone.bridge.setMedia("no-player")` (or `"automation-denied"`, or `null` to see the player again) in either page's console; the other page follows.

The mock remembers the player and settings in `localStorage`. `track`, `t` and `paused` override the saved player; run `localStorage.clear()` in the devtools console to start fresh. On the overlay page, `window.undertone` exposes `{ bridge, stage, controller }` for poking at it from the console, for example `undertone.bridge.player.select(1, 5000)`.

### Layout

```
contract/contract.ts   shared types (mirrored in src-tauri/src/contract.rs)
src/bridge/            Tauri bridge, mock bridge, and the switch between them
src/core/              LRC parser, word timing, playback clock, album palette, the look picker (pure TS)
src/overlay/           the lyric stage, controller, empty states and fonts
src/overlay/pictures/  Effects mode's word pictures (WebP), matched to words by src/core/wordpics.ts
src/overlay/modes/     arc, lens, drift (stack is drift without depth)
src/settings/          settings window and its live preview
src/styles/            CSS
tests/                 vitest suites; tests/fixtures/ holds original placeholder LRC
src-tauri/             Rust core: media, lyrics, settings, tray, desktop layer
prototype/             undertone.html, the reference prototype
```

[SPEC.md](SPEC.md) holds the architecture and the contract between the TypeScript and Rust halves; the contract is v6. To change the contract, edit `contract.ts` and `contract.rs` in the same commit, bump `CONTRACT_VERSION`, and log it in `docs/HANDOFF.md`; add fields rather than renaming or removing them. [CLAUDE.md](CLAUDE.md) and [AGENTS.md](AGENTS.md) are the original work orders for the frontend and the Rust core.

**Never commit real song lyrics.** Fixtures and demo tracks use original placeholder text written for this repo. Real lyrics are only fetched at runtime and cached on the user's machine.

## Acknowledgements

Lyrics come from [LRCLIB](https://lrclib.net). The word pictures in `src/overlay/pictures/` were made for Undertone with [Higgsfield](https://higgsfield.ai) image generation and ship with the app. The lyric fonts (Fraunces, Instrument Serif, Syne, Unbounded, Bricolage Grotesque, Caveat and JetBrains Mono) and the settings window's font, Figtree, are bundled under the SIL Open Font License 1.1. **Settings › Licenses** shows the notices of every font and library Undertone includes, and `THIRD_PARTY_NOTICES.txt` next to the app holds the same text.
