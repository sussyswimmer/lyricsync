# Development

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

Debug builds read four more flags: `--media-test` prints each now-playing and lyrics event, `--overlay-probe` prints every 2 s whether each page is visible and drawing, `--desktop-layer-test` shows a test line in place of the lyrics, even with nothing playing, and `--desktop-layer-all` shows the overlay on every display. Pass them with two `--`, as in `pnpm tauri dev -- -- --media-test`. [docs/NOW_PLAYING.md](NOW_PLAYING.md) and [docs/DESKTOP_LAYER.md](DESKTOP_LAYER.md) explain them, and [docs/ACCEPTANCE.md](ACCEPTANCE.md) lists the checks a real Mac and PC still need.

Every build, release included, also reads `--look=<style>[,<family>[,<curve>]]`. It makes every overlay draw with that style (`arc`, `lens`, `drift`, `stack`, `poster`, `spotlight`, `wave`, `reveal`, `collage` or `reel`) instead of the look Undertone picks for each song, optionally in that face (a family name such as `Instrument Serif`) and, for Arc, with that curve (−100 to 100). An empty part keeps the pick, as in `--look=arc,,-50`. It's for checking one style on purpose, as the CPU checks in [docs/ACCEPTANCE.md](ACCEPTANCE.md) do, and it's never saved; a malformed value is ignored (the log says why). Quit Undertone first, then start it with the flag: `pnpm tauri dev -- -- --look=lens`, `open -a Undertone --args --look=lens` on macOS, or `undertone.exe --look=lens` on Windows. In a browser, the overlay page's `?look=` does the same.

## Frontend in a browser

`pnpm dev` serves the frontend at <http://localhost:1420>. In a plain browser there is no Tauri, so both pages run against the **mock bridge**, a fake player that sends the same events as the Rust core. Open the overlay at <http://localhost:1420/> and the settings window at <http://localhost:1420/settings.html> side by side: they share the player and settings, so a change in one shows up in the other.

The mock plays eleven demo tracks with original placeholder lyrics:

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
| 8 | Strobe Hearts (Club Mix) | a look demo: short shouted hooks, a club edit and a neon-on-black cover, set as a Poster in Unbounded capitals, 66 s |
| 9 | Glacier Nocturne | a look demo: sparse, slow lines with long instrumental breaks under a cold, dark cover, set as Drift in Instrument Serif, 118 s |
| 10 | Dial Tone Avenue | a look demo: a mid-tempo late-night song, timed word by word, full of words that carry a sign (city, phone, started, left, dance…), under the cold, dark cover again, set as Reel in Space Grotesk, 120 s |

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
| `?track=N` | Start on demo track N (0–10). |
| `?t=MS` | Start at this position, in ms. |
| `?paused` | Start paused. |
| `?settings=JSON` | URL-encoded JSON patch over the saved settings, e.g. `%7B%22effects%22%3A80%7D` for `{"effects":80}`. In the mock, `mode`, `font` and `curve` in it force a look like `?look=` (the app no longer reads them). |
| `?look=STYLE[,FAMILY[,CURVE]]` | On the overlay page, with either bridge: draw every song in that style (`arc`, `lens`, `drift`, `stack`, `poster`, `spotlight`, `wave`, `reveal`, `collage` or `reel`), optionally in that font family and, for Arc, with that curve (−100 to 100), instead of the look Undertone picks. An empty part keeps the pick: `?look=lens`, `?look=lens,Syne`, `?look=arc,,-50`. Never saved. |
| `?power=full\|lite` | On the overlay page: force the full motion, or the lighter drawing Undertone uses on computers without graphics acceleration (detected otherwise). Graphics (the splashes, the pictures and the words answering them) need the full motion: headless Chromium reports `lite`, so add `?power=full` to see them there. |
| `?flair=MOVE[,ACCENT[,SPLASH]]` | On the overlay page, with either bridge: force the song's flair (its Text effects moves and its splash) instead of the one Undertone picks. MOVE and ACCENT are each `rise`, `bounce`, `sway`, `wave`, `pulse` or `drop`; ACCENT is how the song's repeated lines (its hooks) move, and follows MOVE when left out. SPLASH is `drops`, `sparks`, `confetti`, `ripple` or `glints`. An empty part keeps the pick: `?flair=bounce`, `?flair=sway,pulse,confetti`, `?flair=,,drops`. Never saved. |
| `?shortcutConflict=toggleLyrics,nudgeLater` | Act as if another app held the combinations those actions start with: they report `"unavailable"` in `shortcuts-status`, and Settings warns under them. Recording a different combination clears the warning. Actions: `toggleLyrics`, `nudgeEarlier`, `nudgeLater`. |
| `?media=automation-denied\|no-player` | Act like a core that can't see the player: nothing playing, and `media-status` says why (`automation-denied` names Spotify). The settings window then shows its Automation notice, or **No music app open** under This song, and its preview plays the demo song as the app does. |
| `?loginItem=refuse` | Act like a core whose system refuses the login item: a **Launch at login** change fails, the rest of the change applies, and Settings shows its note under the switch. |
| `?wallpaper=dusk\|light\|busy\|none` | Stand-in wallpaper behind the overlay page (default `dusk`). |

For example, <http://localhost:1420/?mock&track=1&t=4900&look=arc> opens Paper Lanterns mid-line in Arc, whatever Undertone would pick for it, and <http://localhost:1420/?mock&track=8> plays Strobe Hearts in the look Undertone picks (Poster, in Unbounded). <http://localhost:1420/?mock&track=9&t=7000&flair=,,drops> plays Glacier Nocturne just before its snowflake picture and its first splash. <http://localhost:1420/?mock&track=10&t=7000> plays Dial Tone Avenue, the Reel demo, one word at a time with a sign beside the words that name something.

`?settings` applies only to the page it's on and isn't saved, so the other page keeps the saved settings until you change one. Give both pages the same `?settings=`, or make the change in the settings window, to keep them matching. The patch is applied like `update_settings`: inside `colors`, `font` or `shortcuts` only the keys you give change, and the rest keep their saved values. `trackOffsetsMs` replaces the whole map, and invalid values are ignored.

`?media` and `?loginItem` work the same way: they apply only to their page and aren't saved, so without them the mock reports the demo player and accepts the login item as usual. The settings window the overlay page opens (press S) inherits both. To change the media problem while both pages are open, run `undertone.bridge.setMedia("no-player")` (or `"automation-denied"`, or `null` to see the player again) in either page's console; the other page follows.

The mock remembers the player and settings in `localStorage`. `track`, `t` and `paused` override the saved player; run `localStorage.clear()` in the devtools console to start fresh. On the overlay page, `window.undertone` exposes `{ bridge, stage, controller }` for poking at it from the console, for example `undertone.bridge.player.select(1, 5000)`.

## Layout

```
contract/contract.ts   shared types (mirrored in src-tauri/src/contract.rs)
src/bridge/            Tauri bridge, mock bridge, and the switch between them
src/core/              LRC parser, word timing, playback clock, album palette, the look picker (pure TS)
src/overlay/           the lyric stage, controller, empty states and fonts
src/overlay/pictures/  Graphics' word pictures (WebP), matched to words by src/core/wordpics.ts
src/overlay/modes/     arc, lens (poster, spotlight, wave, reveal, collage and reel are lens with another layout: slot-layouts.ts), drift (stack is drift without depth)
src/settings/          settings window and its live preview
src/styles/            CSS
tests/                 vitest suites; tests/fixtures/ holds original placeholder LRC
src-tauri/             Rust core: media, lyrics, settings, tray, desktop layer
prototype/             undertone.html, the reference prototype
```

[SPEC.md](../SPEC.md) holds the architecture and the contract between the TypeScript and Rust halves; the contract is v9. To change the contract, edit `contract.ts` and `contract.rs` in the same commit, bump `CONTRACT_VERSION`, and log it in `docs/HANDOFF.md`; add fields rather than renaming or removing them. [CLAUDE.md](../CLAUDE.md) and [AGENTS.md](../AGENTS.md) are the original work orders for the frontend and the Rust core.

**Never commit real song lyrics.** Fixtures and demo tracks use original placeholder text written for this repo. Real lyrics are only fetched at runtime and cached on the user's machine.
