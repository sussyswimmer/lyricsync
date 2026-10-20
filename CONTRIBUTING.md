# Contributing to Undertone

Thanks for helping out. A clear bug report with diagnostics is as useful as a pull request, so every kind of contribution counts.

- **Something broken?** [Report a bug](https://github.com/sussyswimmer/lyricsync/issues/new?template=bug_report.yml). [Reporting a bug](docs/TROUBLESHOOTING.md#reporting-a-bug) shows how to get the diagnostics report that makes it quick to find.
- **An idea?** [Suggest a feature](https://github.com/sussyswimmer/lyricsync/issues/new?template=feature_request.yml).
- **A security problem?** Please don't describe it in an issue. Follow [SECURITY.md](SECURITY.md) instead.

Everyone who takes part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development

Use Node 24+, pnpm 11 and Rust stable (`rust-toolchain.toml` selects the stable channel with clippy and rustfmt). For the desktop app, install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS: WebView2 and MSVC on Windows, Xcode command line tools on macOS.

```sh
pnpm install --frozen-lockfile
pnpm test                 # vitest
pnpm coverage             # vitest with coverage of src/core, src/bridge and the overlay's view.ts, look.ts and stage.ts; fails below 90% on lrc.ts, timing.ts or clock.ts (CI runs this)
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
| S | Open Settings, as the tray's **Settings…** does (it carries this page's `?media` and `?loginItem`) |

The global shortcuts work too, while the page has focus: the default ⌥⇧⌘L / Ctrl+Alt+Shift+L turns the lyrics off and on (the overlay page hides them, the settings preview shows **Off on the desktop**), and the nudges change the current song's offset. They follow what you record in Settings › Shortcuts, and pause while Settings listens for a new one.

URL parameters (combine them with `&`):

| Parameter | Effect |
|---|---|
| `?mock` | Use the mock even inside the Tauri webview. A plain browser always uses it. |
| `?track=N` | Start on demo track N (0–5). |
| `?t=MS` | Start at this position, in ms. |
| `?paused` | Start paused. |
| `?settings=JSON` | URL-encoded JSON patch over the saved settings, e.g. `%7B%22mode%22%3A%22lens%22%7D` for `{"mode":"lens"}`. |
| `?shortcutConflict=toggleLyrics,nudgeLater` | Act as if another app held the combinations those actions start with: they report `"unavailable"` in `shortcuts-status`, and Settings warns under them. Recording a different combination clears the warning. Actions: `toggleLyrics`, `nudgeEarlier`, `nudgeLater`. |
| `?media=automation-denied\|no-player` | Act like a core that can't see the player: nothing playing, and `media-status` says why (`automation-denied` names Spotify). The settings window then shows its Automation notice, or **No music app open** under This song, and its preview plays the demo song as the app does. |
| `?loginItem=refuse` | Act like a core whose system refuses the login item: a **Launch at login** change fails, the rest of the change applies, and Settings shows its note under the switch. |
| `?wallpaper=dusk\|light\|busy\|none` | Stand-in wallpaper behind the overlay page (default `dusk`). |

For example, <http://localhost:1420/?mock&track=1&t=4900&settings=%7B%22mode%22%3A%22arc%22%7D> opens Paper Lanterns mid-line in Arc.

`?settings` applies only to the page it's on and isn't saved, so the other page keeps the saved settings until you change one. Give both pages the same `?settings=`, or make the change in the settings window, to keep them matching. The patch is applied like `update_settings`: inside `colors`, `font` or `shortcuts` only the keys you give change, and the rest keep their saved values. `trackOffsetsMs` replaces the whole map, and invalid values are ignored.

`?media` and `?loginItem` work the same way: they apply only to their page and aren't saved, so without them the mock reports the demo player and accepts the login item as usual. The settings window the overlay page opens (press S) inherits both. To change the media problem while both pages are open, run `undertone.bridge.setMedia("no-player")` (or `"automation-denied"`, or `null` to see the player again) in either page's console; the other page follows.

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
scripts/               third-party notices, the tray icon, the README banner and images
assets/                the README banner, screenshots and demo GIF
```

## The contract between the halves

[SPEC.md](SPEC.md) holds the architecture and the contract between the TypeScript and Rust halves. To change the contract, edit `contract.ts` and `contract.rs` in the same commit, bump `CONTRACT_VERSION`, and log it in `docs/HANDOFF.md`; add fields rather than renaming or removing them. [CLAUDE.md](CLAUDE.md) and [AGENTS.md](AGENTS.md) are the original work orders for the frontend and the Rust core.

The frontend (everything about time, color and drawing) and the Rust core (everything that talks to the OS and the network) meet only at that contract. Keep a pull request to one side when you can.

## Branches, commits and pull requests

- One change per branch and per pull request into `main`.
- Commit messages start with the area they touch, then say what changed in plain words, for example `Overlay: wait on a timer between busy frames only on fast displays` or `Lyrics: keep good sync when translations or a pasted copy sit unstamped`.
- Before you push, run the checks under [Development](#development). CI runs them on every push (the Rust ones on macOS and Windows) and builds both installers.
- **Visible change?** Say how you checked it (the mock bridge in a browser is enough for most of the frontend) and add a screenshot or a short recording to the pull request.
- **User-visible change?** Add a line under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- **Docs follow the code.** The README, [docs/USER_GUIDE.md](docs/USER_GUIDE.md) and [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) describe the app as it is now. `tests/regress-docs.test.ts` checks every relative link in the docs and the facts they repeat from the code (defaults, demo tracks, flags, shortcuts), so a change that breaks one fails `pnpm test`.
- [docs/HANDOFF.md](docs/HANDOFF.md) is the running log of the project's milestones. Add an entry when you change the contract or finish a piece of work someone else will build on.

The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) has the same checklist.

## Product rules

These hold for every change, in code and in docs:

- **Never commit real song lyrics.** Fixtures and demo tracks use original placeholder text written for this repo. Real lyrics are only fetched at runtime and cached on the user's machine.
- Undertone only reads what's playing. It never plays, pauses or skips anything, and it never launches a player by itself.
- The only network requests are the lyrics lookup on LRCLIB and, for Spotify on macOS, the cover art from Spotify's image server. No accounts, no API keys, no telemetry.
- The app works offline with what it has cached. Fonts are bundled (`@fontsource/*`, SIL Open Font License only), never loaded from the web.
- No made-up numbers, testimonials or badges anywhere.

## Refreshing the README images

The images in `assets/` are made from the app itself, so they can be remade whenever the look changes:

- `scripts/banner.py` writes `assets/banner.svg`, the banner and social preview, with its lettering outlined from the bundled Fraunces and Figtree. It needs `pip install fonttools brotli uharfbuzz` and `pnpm install`.
- `scripts/readme-media.mjs` renders `assets/banner.png` from that SVG, and takes the screenshots of the four styles, the settings window in light and dark, and `assets/demo.gif`, from the real pages on the mock bridge. Start `pnpm dev` first. It needs Playwright with Chromium, and ffmpeg for the GIF; the comment at its top shows how to run one part at a time.

## License

Undertone is [MIT licensed](LICENSE). By contributing, you agree that your contributions are licensed under the same terms.
