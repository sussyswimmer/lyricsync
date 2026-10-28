# Handoff log

Shared between Claude Code and Codex. Append new entries at the bottom; never edit the other agent's entries. Format is in `SPEC.md`.

## 2026-10-05 · Maxwell · Kickoff
Repo created with SPEC.md, CLAUDE.md, AGENTS.md and the prototype.
Codex starts with X0 (scaffold). Claude Code starts with C1–C3 (core logic, no scaffold needed).
Contract: v1.

## 2026-10-05 · Codex · M0
M0 done.
Done: X0 scaffold committed on `codex/scaffold` (`b69ebc2`), pushed, and merged into `main`. Tauri v2 + vanilla TypeScript; Vite overlay/settings entry points; transparent, hidden overlay and hidden 380×640 settings window; macOS private API and Accessory activation policy; matching contract v1 shapes/defaults; all eight command names registered and all three event payloads stubbed.
Validation: `pnpm test` (1 passed), `pnpm build`, `cargo test --locked` (2 passed), `cargo fmt --check`, portable Clippy and Windows desktop cross-target Clippy with `-D warnings` passed. Chromium opened the reference prototype and both scaffold pages without page errors. Windows cross-check used `x86_64-pc-windows-gnu`; it is not a native GUI/runtime test. macOS cross-check is blocked by the Linux host's missing Apple SDK/Objective-C toolchain. Native Windows/macOS window startup remains unverified.
Needs from Claude: frontend work can proceed in the owned paths. Both pages are deliberately empty shells. Subscribe to events, then query initial state with commands. Settings are in-memory stubs (full clamping/persistence is X4), playback returns null (X2), lyrics return `error` until X3; refetch emits `loading` then `error`. Desktop Cargo checks need `--features desktop`; Tauri CLI enables it automatically. Linux runs only frontend and portable Rust checks; it is not a product target.
Contract: unchanged (v1), initialized in TypeScript and Rust. No real lyrics added.

## 2026-10-05 · Claude Code · C1–C3
Done: `src/core/lrc.ts` (LRC + enhanced `<mm:ss.xx>` word tags, multi-stamp lines, `[offset:]`, gaps, CRLF/BOM/junk), `src/core/timing.ts` (syllable-weighted fallback word timing with 600 ms last-word hold and 1.6 s cap, plain-lyric pacing flagged `unsynced`, `lineAt`/`progress` helpers), `src/core/clock.ts` (interpolated, offset-corrected clock: snap > 400 ms, slew within, freeze on pause, reset on track change). 90 tests; core coverage 100% lines, 93% branches (`pnpm coverage`, new script). Fixtures are original placeholder lyrics.
Notes: `Word.text` keeps its trailing space so a line's words join back to `Line.text`; Chinese/Japanese/Korean lines split per character. `clock.ts` imports `NowPlaying`/`Settings` types from the contract.
Needs from Codex: nothing.
Contract: unchanged (v1).

## 2026-10-05 · Claude Code · C4
Done: `src/core/palette.ts`. Ports the prototype's `extract()` (48×48 sample, 4-bit buckets, dominant → lyric/dim tint, most vivid common color → highlight) with guaranteed legibility (lyric L ≥ 0.85; highlight L 0.6–0.75, S ≥ 0.55; checked across 300 random covers). Gray covers fall back to the default warm white plus the most colorful pixel, or the default highlight. `PaletteCache` computes once per trackKey and recomputes if artwork arrives later. Artwork decodes through `<img>` + canvas, which the current CSP allows (`img-src data:`); verified in Chromium against the prototype's covers. 110 tests pass.
Needs from Codex: nothing. Keep `img-src data:` in the CSP; album colors depend on it.
Contract: unchanged (v1).

## 2026-10-05 · Codex · X1 in progress
Done: first Windows desktop-layer implementation on `codex/desktop-layer`, separate from the M0 scaffold on `main`. Classic WorkerW and Windows 11 24H2 raised-desktop discovery; layered/click-through/nonactivating styles; PerMonitorV2 manifest and physical monitor coordinates; primary/all display reconciliation; TaskbarCreated/display/DPI/wake hooks; async retry and idle visibility policy. Reviewed current Lively desktop hierarchy behavior and documented the source reference. Debug-only native diagnostic page avoids changes to frontend-owned files.
Validation: 5 portable Rust tests passed; rustfmt, portable Clippy and Windows desktop cross-target Clippy (`x86_64-pc-windows-gnu`, `-D warnings`) passed. No frontend or shared contract changes after M0. Native Explorer restart, click-through, mixed-DPI/multi-monitor acceptance and macOS implementation remain pending; M1 is NOT done. Follow `docs/DESKTOP_LAYER.md` on Windows before moving to the second OS, as AGENTS.md requests. Linux cannot perform this native acceptance.
Needs from Claude: nothing for X1; continue against the M0 contract. X2's watcher will need to call `desktop_layer::set_playing(bool)` on playback changes. Full settings persistence and media integration remain later milestones.
Contract: unchanged (v1).

## 2026-10-05 · Codex · X2 Windows implementation
Done: `codex/now-playing` builds on the X1 branch with Windows SMTC session discovery, playback/source selection, manager and session subscriptions, one-second polling/resync, cached `get_now_playing`, and overlay visibility updates. Timestamp conversion preserves SMTC `LastUpdatedTime`; the portable watcher detects track/play/pause/seek changes and suppresses duplicate idle events. Thumbnail reads are asynchronous and bounded, use WinRT agile references, and produce PNG data URLs no larger than 300 px without upscaling. Stale artwork results are guarded by session/track/generation identity. Debug-only `--media-test` logs event timing/state without dumping artwork or lyrics.
Validation: `cargo test --locked` passed 17 tests; formatting and Clippy `--all-targets -- -D warnings` passed on the Linux portable target and Windows desktop cross-target (`x86_64-pc-windows-gnu`, `--features desktop`). Tests cover exact track keys, source priority, Windows epoch conversion, coarse timeline samples, seeks, pause/idle suppression, periodic resync during pending metadata, resync after intervening changes, invalid snapshots, and image limits/resizing. No frontend-owned files or shared contract files changed.
Outstanding: Native SMTC/Spotify and desktop-layer acceptance require Windows; follow `docs/NOW_PLAYING.md` and `docs/DESKTOP_LAYER.md`. macOS now-playing is not implemented yet. X3 lyrics remain stubs; M2 is NOT done. The next implementation step is X3 (LRCLIB matching/cache), followed by the second-OS work in AGENTS.md's sequence. `main` remains the merged M0 scaffold; X1/X2 are separate pending native validation.
Needs from Claude: use `get_now_playing` for initial state and listen to `now-playing`; preserve the supplied `sampledAt` when interpolating. Artwork may arrive in a later update for the same track. No contract change required.
Contract: unchanged (v1). No real lyrics committed.

## 2026-10-05 · Codex · X3 implementation
Done: `codex/lyrics` adds LRCLIB exact/search lookup, conservative title normalization and duration/synced-text/album ranking; bounded HTTPS responses; status mapping; atomic SHA-1 disk cache with indefinite positive results and seven-day negative expiry; shared in-flight lookups, forced refetch promotion and a six-second deadline. The Windows watcher starts lookup on track changes, all webviews receive keyed lyrics events, and get/refetch commands now use the real service. Recent metadata is bounded to 64 tracks and provider concurrency to four.
Validation: 33 Rust tests passed, 0 failed; 1 optional live probe ignored in the normal suite. Local HTTP tests exercise query encoding, User-Agent, get/search/retry, failures and an end-to-end service/cache restart with the server offline. Cache, concurrency, cancellation, force promotion and expiry tests passed. rustfmt and portable/Windows cross-target Clippy `--all-targets -- -D warnings` passed. No frontend-owned files or contract files changed; fixtures contain only original placeholder text.
Outstanding: Live HTTPS probe is blocked by cloud proxy CONNECT 403 for lrclib.net. Added only lrclib.net to the environment draft's custom allowlist; review/save in environment settings and publish before retrying. Draft persistence is confirmed; live egress is not. Native Windows playback/lyrics acceptance and macOS implementation remain pending, so M2 is NOT done. Instructions and the optional live test are in docs/LYRICS.md.
Needs from Claude: handle loading and terminal lyrics payloads by trackKey (old-track results may arrive later), subscribe before querying initial state, and use refetch_lyrics for retries. Unknown uncached keys cannot be looked up without observed metadata. Settings are still an X4 stub; the README's historical M0-stub paragraph can be updated during the frontend documentation pass.
Contract: unchanged (v1). Main remains the M0 handoff; X1–X3 are on the implementation branches.

## 2026-10-05 · Claude Code · C5
Done: typed bridge in `src/bridge/`. `types.ts` maps every contract v1 command and event, so `invoke` and `listen` are typed end to end (args camelCase, as Tauri sends them). `tauri.ts` is a thin `@tauri-apps/api` wrapper. `mock.ts` is a fake player that emits `now-playing` and `lyrics` the way the Rust core will (resync every second, `loading` then the result, artwork a moment after the track) and clamps settings the way X4 will. `index.ts` picks Tauri inside the app and the mock in a plain browser or with `?mock`. Six demo tracks with original placeholder lyrics: line-synced, enhanced word tags, plain-only, not-found, instrumental without artwork, and a script sampler (Japanese, Chinese, Korean, Vietnamese, right-to-left, very long and one-word lines) for visual QA. Mock keys: Space, ←/→, N/Shift+N. `?track`, `?t`, `?paused`, `?settings=` and `?wallpaper=` set a starting state. Player and settings sync across tabs, so the overlay and settings pages stay in step in one browser.
Needs from Codex: nothing for C5. What the real events must do to match the mock is under M2 status and C7 below.
Contract: unchanged (v1).

## 2026-10-05 · Claude Code · C6 (M1 frontend)
Done: the overlay renders all four styles from the mock bridge in a browser (`pnpm dev`).
- `overlay/controller.ts`: bridge → playback clock, lyrics, album colors and `showWhen` gating. It subscribes first, then reads the initial state; an event that beats a command reply wins. The frame loop runs only while playing and visible, and sleeps until the next word or line boundary instead of drawing every frame.
- `overlay/stage.ts`: owns the DOM. The old song fades out over 250 ms, then the new one fades in; per-line crossfades; reduced motion gets crossfades only. `overlay/look.ts`: settings + palette → px and colors; `size` scales with display height (1080 px = 1×); every lyric carries a soft dark shadow. `overlay/states.ts`: loading (nothing for 600 ms, then a faint pulse), the not-found and error chips (about 4 s, then a fade), and a breathing ♪.
- Modes: Arc (SVG `textPath`; the focus line stays whole on screen at any Height and Curve; the next line glides into focus), Lens (fisheye around the sung word, transforms only per frame), Drift (3D) and Stack (Drift without depth).
- Fonts are bundled from `@fontsource` (OFL). `vite.config.ts` never inlines font files as `data:` URLs, so every subset loads from `'self'` under the current CSP.
- Deliberate departures from the prototype: Lens fades far words to 0.6 (not 0.4) so they stay legible on light wallpapers; Arc shrinks long lines to 55% at most, then lets them run off the edges.

Needs from Codex:
1. X1 on Windows: with the overlay parented under WorkerW, confirm that `document.visibilityState` stays `"visible"` and `requestAnimationFrame` keeps firing. The renderer stops its loop when the page reports hidden (the CPU budget), so if WebView2 occlusion detection marks the desktop-layer window hidden, the lyrics freeze. If it does, turn occlusion and throttling off for the overlay webviews, or tell me and I'll change the gate.
2. macOS WKWebView: Lens puts `will-change: transform` on words. Check that the magnified word stays sharp; if it blurs, tell me (it's one rule in `src/styles/lens.css`).
3. CSP: nothing to change now (fonts are handled on our side, above). If you add a `font-src`, keep `'self'` in it. Keep `img-src 'self' data:`: album colors decode artwork through an `<img>`.

Contract: unchanged (v1).

## 2026-10-05 · Claude Code · M2 status
Done: the frontend half of M2. The Tauri bridge is wired to every contract v1 command and event. Clock, word timing and album colors run end to end against the mock. Against the Rust stubs on `main` the app starts, reads settings and shows nothing, because `get_now_playing` is `null`.
Not done: M2 is NOT done. It needs real now playing (X2: Windows is on `codex/now-playing`, macOS is pending) and the LRCLIB service (X3) on `main`. Once they land I'll check the ±150 ms sync target against real songs.
Merging: `codex/desktop-layer` and `codex/now-playing` append their X1 and X2 entries after C4, so this file will conflict when they merge. Keep both sides' entries.
Needs from Codex:
1. X2: as your X2 entry says. `sampledAt` is when `positionMs` was read (SMTC `LastUpdatedTime`), and the clock interpolates from it. Send a resync at least every second while playing. Artwork may arrive in a later update for the same track; colors follow it.
2. X3 `get_lyrics(trackKey)` (checked against `codex/lyrics` at 3aa04b9): the overlay calls it right after every track change in case it missed the `lyrics` event (`src/overlay/controller.ts`). Awaiting the in-flight or fresh lookup is fine. The one gap: for a key the service hasn't registered yet it answers `error`, and if `now-playing` for that track reaches the webview before the watcher has handed the track to the lyrics service, the overlay would flash "Couldn't load lyrics". Please register the track (or start its lookup) before emitting `now-playing` for it. The overlay now asks once more after 1.5 s before believing an `error` reply, so this is a guard, not a crash.

Contract: unchanged (v1).

## 2026-10-05 · Claude Code · C7 (M3 frontend)
Done: settings window (`settings.html`, `src/settings/`), 380×640, light and dark.
- The live preview at the top runs the real overlay modes on the current track. When nothing is playing it plays a demo (the two synced mock songs on a private player), and it rides out the brief "nothing playing" between songs.
- Controls for every `Settings` field: style, Match album colors (editing a color turns it off), a font picker that shows each face, Size, Curve, Height, Glow, Opacity, Show lyrics, Show on, the All songs offset (±2000 ms), and This song nudges (−100 / −50 / +50 / +100 ms, Reset this song) through `set_track_offset`. Reset to defaults asks in-window first and can also clear per-song nudges.
- Saves go through `update_settings`, debounced 120 ms and at most 300 ms apart during a drag. Patches carry whole nested objects (`colors`, `font`) and never `trackOffsetsMs`. The window re-renders from the `settings-changed` echo; edits not yet saved stay on top of older echoes, and unsaved edits flush on blur, hide and close.

Needs from Codex:
1. Settings close → hide, not destroy. On `main` the OS close button destroys the `settings` webview, and the next `open_settings` (tray, second launch) fails with "settings window unavailable". `codex/desktop-layer` and `codex/now-playing` already handle `CloseRequested` with `prevent_close()` + `hide()` in `desktop_layer/controller.rs`, but `desktop_layer::start` only runs under `cfg(target_os = "windows")`. Do the same on macOS, and land it on `main`.
2. X4 settings store: clamp to the SPEC ranges, drop invalid values, return the clamped `Settings` and emit `settings-changed` to every webview (the window re-renders from that echo). Keep `update_settings` a shallow top-level merge: the window always sends whole `colors` and `font` objects and never sends `trackOffsetsMs`, so a stale map can't clobber a tray nudge. Open question: for an invalid enum value (say `mode: "spiral"`) the mock falls back to the default; keeping the current value is friendlier. Your call; tell me and I'll match the mock.
3. `set_track_offset(trackKey, ms)`: when `ms` is 0, remove the key. "Reset this song" and "Reset to defaults → Also clear sync" both send 0, and today the key stays (`commands.rs` always inserts). Keep returning `Settings` and emitting `settings-changed`.
4. X5: confirm the semantics README and USER_GUIDE describe. Tray and shortcut nudges change the per-song offset through `set_track_offset`, not `globalOffsetMs`. `Cmd/Ctrl+Alt+]` is +50 ms (lyrics earlier) and `[` is −50 ms (later); tray Earlier/Later 100 ms likewise. Positive means earlier everywhere.
5. `tauri.conf.json`: give the settings window a `minWidth`/`minHeight` of about 360×480. It's resizable, and the layout adapts down to that.
6. Native check on both OSes: `<input type="color">` opens the system picker in the settings window (NSColorPanel in WKWebView, the WebView2 picker on Windows). The swatches depend on it.
7. Nice to have, contract v2 (additive): with macOS Automation denied, Settings can't tell "permission denied" from "nothing playing" (both `null`). Proposal: a `media-status` event and `get_media_status()` returning `{ source: Source | null, problem: "automation-denied" | "no-player" | null }`. I'll add the hint in Settings.

Contract: unchanged (v1).

## 2026-10-05 · Claude Code · C8 (M4 frontend)
Done: `README.md` (what it is, install with the unsigned-build steps inline, the macOS Automation permission, menu and shortcuts, troubleshooting, and development with the mock bridge) and `docs/USER_GUIDE.md` (every setting in plain words).
- Tests: 402 vitest tests, all in node. `pnpm coverage` covers `src/core`, `src/bridge` and the overlay's pure modules (`view.ts`, `look.ts`, `stage.ts`). `lrc.ts`, `timing.ts` and `clock.ts` are at 100% of lines (93%, 94% and 96% of branches); everything covered is at 97% of lines.
- Visual QA with the mock bridge: all four styles over the three demo covers on the dusk, light and busy stand-in wallpapers; long, one-word, Chinese, Japanese, Korean, Vietnamese and right-to-left lines (mock track 5, Script Sampler); a portrait display; reduced motion; the settings window at 380×640 in light and dark.
- Fixed in the review round: Arc keeps its whole curve on screen at any Height, keeps its shape on portrait displays, moves a long neighbor clear of the focus line and lays out right-to-left lines right to left; Lens fits long lines under the lens instead of shrinking them to a band, and far words keep their dark shadow; Drift and Stack never overlap wrapped lines and set very tall ones smaller; a word lights at its first millisecond; a color or glow change restyles every style in place without a rebuild, so settings drags run at 60 fps (Arc was at 21–26 fps); a paused step in Lens shows the full lens; small text keeps a shadow floor; the not-found chip holds 4 s once it is visible; an event that overtakes a command reply wins; settings sync buttons keep keyboard focus, the panel rides out the gap between songs, and the settings preview keeps lyrics below its header bar at low Height.

Needs from Codex:
1. X1/X7: a native CPU check of the SPEC budget (under 3% while playing, on a mid-range laptop) with the real overlay on both OSes, in each style. I measured the loop only in Chromium: it sleeps between word boundaries and stops when paused, hidden or idle.
2. X6 `docs/INSTALL.md` doesn't exist yet. README now carries short Gatekeeper and SmartScreen steps inline instead of linking it; tell me when it lands and I'll link it.
3. X7 `undertone --diagnose`: Windows release builds use `windows_subsystem = "windows"`, so nothing prints. Use `AttachConsole(ATTACH_PARENT_PROCESS)`, or write the report to a file and print its path. Handle the flag before `tauri-plugin-single-instance`, or a second launch with `--diagnose` just opens Settings. README assumes the macOS binary is `Undertone.app/Contents/MacOS/undertone` (no `mainBinaryName` override); please confirm.
4. X6 CI: `packageManager` is pnpm 11, so run `corepack enable` (or `pnpm/action-setup` v11) before `pnpm i`.
5. README's troubleshooting describes X3 as AGENTS.md specifies it: lookup by title, artist, album and length with a title and artist search fallback, rejection past an 8 s length difference, misses cached for 7 days, and a 6 s timeout. Tell me if any of that changes.

Already fine on your side: event names and payloads, camelCase command args, `core:default` (event listen) for every window, `sampledAt` from SMTC `LastUpdatedTime`, artwork arriving after the track, PNG data URLs no larger than 300 px.
Contract: unchanged (v1).

## 2026-10-06 · Claude Code · Taking over the rest of the native side
At Maxwell's request (Codex hasn't moved since X3), Claude Code is building the remaining Rust work on `claude/keen-edison-ey08zd`: X4 settings store, X5 tray/menu bar + shortcuts + autostart + single-instance, X1 and X2 on macOS, X6 CI and packaging, X7 `--diagnose`.
Done: merged `codex/lyrics` (X1–X3) into the branch; a shared skeleton (plugins registered with single-instance first, `state.rs` AppState, `settings.rs`, Settings close → hide on every OS, module entry points). Everything lints clean with `-D warnings` for Linux, `x86_64-pc-windows-gnu` and `aarch64-apple-darwin` (check only; macOS C deps go through zig cc since there is no Apple SDK here).
Needs from Codex: please don't start X4–X7 or the macOS halves of X1/X2 on your branches; review on this branch is welcome. Native acceptance on real machines (docs/DESKTOP_LAYER.md, docs/NOW_PLAYING.md, docs/LYRICS.md) still can't be done from this Linux container.
Contract: unchanged (v1).

## 2026-10-06 · Codex · Integrated X1–X3 review
Done: reviewed integration at `5ac01b3` on `codex/backend-review`, respecting Claude's takeover of X4–X7 and the macOS halves. Fixed a Windows initial-state race: register the lyrics job before updating `AppState.now_playing`, so a concurrent `get_now_playing` followed by `get_lyrics` cannot see an unregistered new track. The event path already registered before emitting; both paths now share that ordering. Normalized the preceding entry's `Done:` heading to satisfy the existing documentation test without changing its meaning.
Validation: 402 frontend tests, production build, 33 portable Rust tests (one optional live test excluded), rustfmt, portable Clippy and Windows desktop cross-target Clippy all passed. The optional live LRCLIB probe also passed separately with original nonexistent metadata; HTTPS returned the expected 404. The earlier proxy blocker is resolved and docs/LYRICS.md is updated. No frontend-owned files or contract changes.
Needs from Claude: bring in the review commit from `codex/backend-review`; preserve lyrics registration before both cached now-playing publication and event emission when adding the macOS adapter. Continue the remaining native work on your branch. Native desktop behavior, visibility/animation, color pickers, playback sync and CPU acceptance still require actual Windows/macOS machines; M1/M2 remain unverified. This review does not certify the unfinished X4–X7 skeleton.
Contract: unchanged (v1). Main remains the M0 scaffold.

## 2026-10-06 · Claude Code · X1–X2 on macOS, X4–X7
Done: the rest of the native side, on `claude/keen-edison-ey08zd`. It lints clean with `-D warnings` on Linux, `x86_64-pc-windows-gnu` and `aarch64-apple-darwin` (check only; nothing links), and 127 portable Rust tests pass. None of it has run on a real Mac or Windows PC yet.
- X4 `settings.rs`: tauri-plugin-store `settings.json` in the app data folder, under the key `settings`. Each field is checked on its own: unknown keys are dropped, numbers are clamped to the SPEC ranges, and a wrong type or an unknown enum value keeps the current value. That answers C7 request 2's open question, and the mock now does the same. `migrate()` turns any stored shape into valid settings and rewrites the file only when that changed it. Every change is saved, then `settings-changed` goes to every webview and the tray. `set_track_offset(key, 0)` removes the key (C7 request 3). The desktop layer refreshes only when `showWhen` or `displays` change, so slider drags don't blink the Windows overlay.
- X5 `tray.rs`, `shortcuts.rs`: the AGENTS.md menu. The Style check and the Hide/Show label follow settings and the shortcut; Sync and Refetch are greyed out with no song; Reset shows the current nudge; Launch at login reads the real autostart state. Shortcuts ⌘/Ctrl+Alt+L, ] (+50 ms, earlier) and [ (−50 ms, later) register one by one, so one that another app owns doesn't block the others. Positive means earlier everywhere (C7 request 4). Original tray icons: a macOS template and an amber tile for Windows. A second launch opens Settings, and on macOS so does opening the app again while it runs.
- X1 on macOS, `desktop_layer/macos.rs`: one controller now drives both OSes. Overlays sit at the desktop window level: click-through, clear, no shadow, on every Space, framed to the matching NSScreen, and re-applied on display changes, wake and Space switches. Overlays are non-focusable on both OSes. Hide lyrics and play/pause now reach the overlays right away instead of on the next 1 s tick.
- X2 on macOS, `media/macos.rs` and `media/applescript.rs`: Spotify and Music through in-process NSAppleScript, only while the player is already running. Automation consent is asked off the main thread, so the prompt never freezes the app. Denial publishes `null` and logs one hint. Spotify artwork comes over HTTPS, Music artwork from the track; both become PNGs of at most 300 px. Player notifications wake the poll on play, pause and track changes. Windows and macOS now share one now-playing loop.
- X6 `.github/workflows/ci.yml` and `release.yml`: CI runs `pnpm test` and `pnpm build` (pnpm through corepack, C8 request 4), then fmt, clippy and tests on macOS and Windows, then unsigned universal `.dmg` and NSIS `.exe` artifacts. A `v*` tag makes one draft release. `tauri.conf.json` has the bundle metadata, the settings window's 360×480 minimum (C7 request 5) and an ad-hoc macOS signature; `Info.plist` carries the Automation usage string. `docs/INSTALL.md` is linked from the README (C8 request 2).
- X7 `undertone --diagnose`: runs before the app and before single-instance. It prints, and saves to `undertone-diagnose-<timestamp>.txt` in the temp folder, the media sources and which one is picked, the current track, the LRCLIB match with its length Δ (no lyric text), settings, the cache, displays and the desktop-layer handles. Windows release builds attach to the parent console (C8 request 3).

CI: the first run on this branch ([run 37407943135](https://github.com/sussyswimmer/lyricsync/actions/runs/37407943135)) is green on GitHub's `macos-latest` and `windows-latest`: fmt, clippy `-D warnings` and `cargo test --features desktop` (the MSVC-embedded Common Controls manifest in `build.rs` lets the desktop test executables load on Windows), plus an unsigned universal `.dmg` and an NSIS `.exe` as run artifacts.
Not verified: the native code now builds, links and passes its unit tests on both OSes, but no one has run the app on a real Mac or Windows PC yet. The acceptance steps are in docs/DESKTOP_LAYER.md, docs/NOW_PLAYING.md and docs/INSTALL.md.
Open: (shortcuts and `media-status` are resolved in the next entry.) The app icon is an original design (`src-tauri/icons/app-icon.svg`, regenerate with `pnpm tauri icon`).
Needs from Codex: nothing. Review and a native acceptance pass on real machines are welcome.
Contract: unchanged (v1).

## 2026-10-06 · Claude Code · Shortcuts with Shift, contract v2 `media-status`
Done: the two items left open above.
- Every global shortcut now includes Shift: ⌘⌥⇧L / Ctrl+Alt+Shift+L, and `[` / `]` for the ±50 ms nudge. This deliberately departs from AGENTS.md's Cmd/Ctrl+Alt. Windows reports AltGr as Ctrl+Alt, so Ctrl+Alt hotkeys swallowed AltGr characters (German \, Polish ł, French ]). On macOS, ⌘⌥L is Downloads in Finder and Safari and Reformat Code in JetBrains IDEs, and ⌘⌥[ / ] move or fold lines in Xcode and VS Code. Adding Shift reduces the clashes but doesn't remove them: AltGr+Shift still types on some layouts (Polish Ł), and JetBrains uses Ctrl/⌘+Alt+Shift+L for Reformat File. The full fix would be configurable shortcuts. README and USER_GUIDE updated.
- Contract v2 (C7 request 7): the `media-status` event and the `get_media_status()` command carry `MediaStatus { source, problem: "automation-denied" | "no-player" | null }`. SPEC.md lists the rules. `Settings.version` stays 1 (Rust now has its own `SETTINGS_VERSION`), so stored settings load unchanged.
  - macOS fills it from the running players and their Automation answer. That answer is now kept for the whole process, so a reconnect neither asks again nor hides a denial for a moment.
  - Windows counts any media session as a player.
  - Settings shows a notice when Automation is off ("Undertone can't see what Spotify is playing", with the System Settings path) and "No music app open" when there's no player. The mock simulates both with `?media=automation-denied|no-player` or `undertone.bridge.setMedia(...)`.
Tests: 435 vitest, 132 Rust; clean on Linux and the Windows/macOS cross-checks. I looked at the notice in light and dark at 360 and 380 px.
Not verified: the Automation-denied and no-player detection on a real Mac or Windows PC (steps in docs/NOW_PLAYING.md).
Needs from Codex: nothing.
Contract: v2 (additive: `MediaProblem`, `MediaStatus`, `media-status`, `get_media_status`).

## 2026-10-06 · Claude Code · Fixes from a requirement-by-requirement audit
Done: an audit of every C1–C8, X0–X7 and SPEC item against the code (about 400 items, each gap re-checked by a skeptic, then a completeness critic) found no missing feature and the issues below, all fixed:
- Overlay freezing under other windows (C6 request 1). The renderer pauses while the page reports hidden. WebView2 and WebKit can report a covered window as hidden, so the lyrics could stop while visible.
  - Windows: every webview passes the same `--disable-features=…,CalculateNativeWinOcclusion` (one constant; tests check tauri.conf.json and every runtime builder). `desktop_layer::set_shown` now drives `SetIsVisible`, so a hidden overlay or a closed or minimized Settings window still stops drawing.
  - macOS: overlays send WebKit's `_setWindowOcclusionDetectionEnabled:NO`, only if the view supports it, and use `backgroundThrottling: "disabled"`.
  - The debug `--desktop-layer-test` page counts frames and how often the page went hidden, so this can be checked by eye.
- Windows overlay styles: tao rewrote them on every show and hide, dropping WS_CHILD and WS_EX_TOOLWINDOW and adding WS_EX_APPWINDOW. WM_STYLECHANGING now enforces them while attached (`desktop_layer/styles.rs`, unit-tested).
- Windows overlay blinked on every play/pause: each one ran hide, re-attach, show. Now a pass touches only what is wrong, and a correctly attached overlay is never re-attached. A DPI or work-area change re-frames overlays parented under Explorer.
- Windows trackKey race: SMTC can send a new title before the new duration. A pure, tested `Settle` waits up to 300 ms for the missing half.
- Settings commands ran on the main thread and wrote settings.json there. They now run off it. `settings::commit` keeps concurrent changes ordered, and `settings-changed` always carries the latest settings. The tray nudge reads and writes the offset in one change.
- Lyrics: a track with no length, title or artist (streams, ads, podcasts) is not-found instead of an error chip, and an LRCLIB 400 from /api/get falls back to search.
- Music artwork asks for `raw data` first. `image` now also decodes bmp, gif and tiff.
- Tests:
  - Rust: contract JSON shape for every type and enum value, checked against contract.ts.
  - Frontend: the frame loop's stop and start rules (pause, hidden, showWhen, null track, sleeping with nothing to sing), with mutation checks.
  - Reduced motion: the loading dots hold still instead of pulsing.
- Docs:
  - The dev flags need a second `--`: `pnpm tauri dev -- -- --media-test`. A docs test guards this.
  - LYRICS.md is current.
  - README no longer promises a release that doesn't exist yet.
  - USER_GUIDE explains that words inside a line are exact only for word-timed lyrics.
Tests: 453 vitest, 159 Rust. Clean on Linux and in the Windows and macOS cross-checks.
Decisions you can reverse:
- Settings keeps a taskbar button while it is open (SPEC says the app has none). tao re-adds the button every time a hidden window is shown, so removing it would mean patching it after each show.
- SPEC's ±150 ms word sync holds at line starts for line-timed lyrics; words inside a line are estimated.
First real-machine run (Maxwell, macOS 26.5, merged into this branch):
- The AppleScript `st` reserved-word bug is fixed. Before it, every read failed and no track was ever reported.
- With Spotify, the track, artwork and LRCLIB lyrics arrive, and the overlay sits at the desktop window level.
- The `--overlay-probe` dev flag showed WebKit pausing a fully covered overlay. The occlusion change above is meant to stop that, which a re-run of `pnpm tauri dev -- -- --overlay-probe` should confirm.
Not verified: Windows, Apple Music, and the rest of the acceptance steps in docs/DESKTOP_LAYER.md, NOW_PLAYING.md and LYRICS.md.
Needs from Codex: nothing.
Contract: unchanged (v2).

## 2026-10-06 · Claude Code · Settings: lyrics on/off, launch at login, custom shortcuts (contract v3)
Done: at Maxwell's request, a Settings area to turn Undertone on and off and customize it. Contract v3 is additive (SPEC.md lists it).
- **General** (top of Settings):
  - "Lyrics on the desktop" is `Settings.enabled`. It persists and replaces the runtime-only `lyrics_hidden`; the tray's Hide/Show lyrics, the toggle shortcut and the switch all change it. When it's off, the preview shows an "Off on the desktop" pill.
  - "Launch at login" is `Settings.launchAtLogin`. The login item changes in the same update; a refusal keeps the old value and shows a note. The real login-item state is adopted at startup, when Settings opens and on tray hover.
- **Shortcuts** (before Reset):
  - An on/off switch and a key recorder per action: Esc cancels, Delete clears, and a duplicate is turned down.
  - The recorder also turns down combinations every app relies on (⌘/Ctrl+C/V/X/Z/A/S/W/Q/Tab, ⌘Space, Alt+Tab, Alt+F4). On Windows it notes when a Ctrl+Alt binding may block an AltGr character.
  - Per-row warnings come from `shortcuts-status`.
  - While recording, `suspend_shortcuts(true)` frees the keys. Rust resumes on false, after 30 s, or when Settings closes, minimizes or loses focus.
  - Registration runs off the main thread: re-registering from a shortcut handler would deadlock the plugin.
  - On Windows a letter is recorded as the letter it types, read from the keyboard layout (`navigator.keyboard`), because that's how Windows registers it. macOS records the key position.
- "When" and "Where" are the new labels for the old Behavior rows. **Reset to defaults** resets shortcuts but keeps the on/off switch and the login item.
- One accelerator grammar, CmdOrCtrl, Control, Super, Alt, Shift and then one key, is shared by Rust's `merge_patch` and the TS validator. `tests/fixtures/accelerators.json` holds both the accept/reject table and the clash-merge cases, and both languages run it.
- Settings changes are refused until the saved settings are loaded. Without that, a second launch on macOS could save the defaults over settings.json.
- `--diagnose` prints the switches and each binding.
Tests: 660 vitest, 183 Rust. Clean on Linux and in the Windows and macOS cross-checks. I looked at it in Chromium in light and dark at 360 and 380 px.
Known gaps:
- On macOS, turning Undertone off under System Settings › "Allow in the Background" isn't visible to the app: the autostart plugin only checks that its LaunchAgent plist exists.
- On non-US Windows layouts, the default `[` and `]` may sit on other keys.
- F21–F24 can't be registered on macOS.
Not verified: registration, conflicts, suspend and resume, the login item, and hiding the overlays when lyrics are off, all on a real Mac and PC.
Needs from Codex: nothing.
Contract: v3 (additive: `Settings.enabled`, `launchAtLogin`, `shortcuts`; `ShortcutAction`, `ShortcutState`, `ShortcutsStatus`; `shortcuts-status`, `get_shortcuts_status`, `suspend_shortcuts`).

## 2026-10-15 · Claude Code · Fixes from the field-readiness audit
Done: an audit of the code and docs in 8 areas (known gaps, docs drift, overlay, Settings window, Rust media and lyrics, Rust shell, SPEC compliance, visual QA) found 66 verified findings. Six groups fixed them on `claude/friendly-mayer-shv80u` (`git log 76a086d..HEAD`), and a docs pass brought every doc up to date.
- **Desktop layer:**
  - Windows: `windows.manifest` declares Windows 8 to 11. Windows lets an app make a layered child window only then, so before this the overlay likely failed to attach on every real PC.
  - macOS: overlays can't be hidden, so ⌘H in Settings or Hide Others in another app no longer takes the lyrics away.
  - Overlays cover each display's work area, clear of the menu bar, notch, Dock and taskbar, so Height 0% and 100% stay readable. Size still counts the whole screen.
  - `--desktop-layer-test` follows the lyrics switch again. Settings can't be maximized or go full screen, and stops at 560 px wide.
  - Webviews may only listen to events (no more `core:default`), so a page can't forge `settings-changed` or `now-playing` for the others. The one other permission is Tauri's debug-only devtools hotkey (`core:webview:allow-internal-toggle-devtools`); release builds have no such command. Rust tests check command, argument and event names against `src/bridge/types.ts`.
- **App shell:**
  - A runtime log, `undertone.log` (macOS `~/Library/Logs/com.undertone.desktop`, Windows `%LOCALAPPDATA%\com.undertone.desktop\logs`), never with lyric text. Setup failures, panics and every failure message go there (the debug flags' output stays on stderr), and `--diagnose` ends with its last 60 lines.
  - `settings.rs` writes `settings.json` itself (temp file, fsync, rename) in the format tauri-plugin-store used, which is gone. An unreadable file is moved to `settings.corrupt-<secs>.json` instead of overwritten.
  - Settings opens on the first launch, and when the saved settings were lost.
  - macOS Launch at login follows System Settings' Allow in the Background (`login_item.rs`, `SMAppService.statusForLegacyURL`). Turning it on while that's off is refused, and System Settings opens at Login Items.
  - LRCLIB and Spotify artwork use the OS proxy settings (not PAC or WPAD).
  - `THIRD_PARTY_NOTICES.txt` (fonts, JavaScript and crates; `scripts/notices.mjs`, checked by CI) ships next to the app, and **Settings › Licenses** shows it.
- **Overlay:**
  - Arc shrinks a long line until it fits its curve: no more words off the screen edges.
  - Lens keeps the next line on screen at Height 95% and up.
  - Busy frames (Lens following a word, Drift glides) start at least 8.6 ms apart: every frame, with no timer, on displays up to about 116 Hz; about 60 fps at 120 Hz and 72 at 144 Hz, where a frame is passed over.
  - Synced LRC whose timing would hold one line all song is paced like plain lyrics. One stray word tag no longer discards a line's word timing.
  - Chinese, Japanese and Korean lyrics are set in their own language's system faces, chosen once per song.
  - Drift and Stack crossfade a jump of more than three lines. The stage re-snaps when the pixel ratio changes. The not-found chip is at least 5.4:1 over white. Drift rows balance their wraps.
  - `pnpm coverage` enforces 90% on `lrc.ts`, `timing.ts` and `clock.ts`, and CI runs it.
- **Settings window:**
  - A command reply no longer overwrites a newer `settings-changed` echo.
  - The recorder turns down Find, New, Open, Print, New tab and Redo everywhere, Ctrl+Y on Windows, and ⌘H, ⌘M, ⌘, ⌘` and F21–F24 on a Mac. On Windows it warns when the keyboard layout may put a saved `[` or `]` on another key.
  - In the app: no browser context menu, reload, print or find. Light mode states reach 3:1, and Windows Contrast themes show the selection, switches and sliders.
  - The font picker says when a face draws Vietnamese accents in a system font. Reset with "Also clear sync" is one save. A refused Launch at login is announced once.
  - Mock: S opens Settings, and `?loginItem=refuse` refuses Launch at login. `tests/settings-sync.test.ts` covers the save logic.
- **Now playing:**
  - Artwork is a JPEG of at most 160 px (a PNG when the cover is see-through): about 8 KB per `now-playing` event instead of about 200 KB. This replaces the PNG of at most 300 px that earlier entries describe.
  - Windows: another app's metadata change no longer blanks the cover.
  - macOS: a player that is still launching isn't read, so it can't stall the main thread for 2 s. AppleScript numbers in Arabic and Persian formats parse.
- **Lyrics:**
  - A transient failure (network, timeout, 5xx, 429) is asked again once after `Retry-After`, then retried quietly after 5, 20 and 60 s on the current track. The lyrics appear when one try works, with no second loading view.
  - A lookup for a song the user already skipped sends no request. A null or malformed LRCLIB record is skipped. Artist credits match as sets, and "(with X)" is stripped from titles.
  - A plain-only result older than 30 days is rechecked quietly when the song plays, and upgrades live to synced lyrics.
  - The user agent carries Cargo's version, and a test keeps `tauri.conf.json`, `package.json` and `Cargo.toml` on one version.
- **Docs:**
  - README, SPEC, INSTALL, USER_GUIDE, DESKTOP_LAYER, NOW_PLAYING and LYRICS match the code.
  - New `docs/ACCEPTANCE.md`: numbered real-machine steps per OS for contract v3, for the Definition of done's CPU, sync and latency lines, and for this session's fixes.
  - SPEC's ownership section records that Claude Code owns the whole repo since 2026-10-06.
  - `tests/regress-docs.test.ts` now checks every Markdown file at the root and in docs/, that a present-tense "contract is vN" names `CONTRACT_VERSION`, that every command-line flag is documented outside this log, and that SPEC names every command and event.
  - The `yPos` comment in both contract files now says work area.
Review round: four reviewers read the whole code diff, and a skeptic re-checked each finding. Nine minor defects were confirmed and fixed:
- Arc's new text floor kept long lines from shrinking in the small settings preview; they shrink to fit there again.
- Unstamped translation rows, or a pasted copy of the lyrics under the synced block, could flip good synced LRC to unsynced; those rows no longer count as untimed.
- The busy-frame cap waited on a timer even on 60–100 Hz displays, where coarse timers dropped frames; it waits only once a frame has been passed over.
- Windows kept the previous song's cover for a whole song that has no thumbnail; a song without one now shows none.
- macOS let a quick quit-and-relaunch of a player be read while still launching; the launch gate now follows the process, not the app.
- Every second launch wrote a false "started" line to the log before handing over; only the instance that stays logs it.
- The narrowed capability blocked Tauri's debug devtools hotkey; it's allowed again, and `pnpm tauri dev` keeps Settings' context menu for Inspect Element.
- On Japanese (JIS) keyboards Settings warned about both default nudges, which already sit on the keys labeled [ and ]; JIS now uses its own key positions.
- In the mock, S reloaded an open Settings tab; it brings it forward, as the core does.
Also: `--diagnose` decodes LRCLIB search records one at a time, like the app, and Windows-only CI failed on two source-reading tests in a CRLF checkout, now fixed.
Tests: 775 vitest (24 files), 238 Rust (1 ignored: the live LRCLIB probe). `pnpm build` is clean, and CI is green on macOS and Windows.
Decisions you can reverse:
- Settings keeps its taskbar button on Windows while it is open. SPEC, README and INSTALL now say so.
- macOS Launch at login keeps the autostart plugin's LaunchAgent and reads its real state, instead of moving to `SMAppService.mainApp`.
- Arc shrinks long lines to fit. This reverses the C6 departure ("55% at most, then lets them run off the edges").
- Busy frames are capped near 60 fps on high-refresh displays (`BUSY_FRAME_MS` in `overlay/controller.ts`). C8 said the loop sleeps between word boundaries, which didn't hold for Lens.
- Undertone writes `settings.json` itself instead of through tauri-plugin-store.
- Overlays are framed to the work area, so `yPos` is a share of the work area.
Known gaps (the previous entry's list, updated):
- Closed, pending a Mac: turning Undertone off under Allow in the Background is now visible to the app.
- Narrowed: on non-US Windows layouts the default `[` and `]` may still sit on other keys, but Settings now warns under them (Latin layouts; others keep the US keys).
- Narrowed: F21–F24 still can't be registered on macOS, but the recorder now turns them down there.
- New: shortcut conflicts are rarely reported on macOS, and shortcuts inside another app are never detected (the docs now say so). A login item left pointing at a deleted app can still show as on (a moved one: see follow-up 2). An older echo landing after a write was sent can show an old value until the write's own echo; a full fix needs a revision number in the contract. PAC and WPAD proxies aren't supported.
Not verified: none of this session's changes has run on a real Mac or PC. `docs/ACCEPTANCE.md` has the steps. The ones most likely to surprise:
- Windows: the overlay attaches with the new manifest (`layered yes`, no `SetLayeredWindowAttributes` error) and follows the taskbar's work area. WebView2 honors the browser-key guard, `navigator.keyboard.getLayoutMap` and the Contrast-theme styles.
- macOS: ⌘H and ⌥⌘H keep the lyrics, and whether ⌘H and ⌘M reach the recorder at all. The overlay re-frames when the Dock moves or resizes (if AppKit sends no screen-parameters notice then, only at the next wake or Space change). ServiceManagement links, and `statusForLegacyURL` reports Allow in the Background. `isFinishedLaunching` turns true for Spotify and Music. Whether AppleScript writes Arabic-Indic digits at all.
- Both: release builds write the log; the first launch opens and focuses Settings; a corrupt `settings.json` is moved aside; the pages work with only the listen permissions; JPEG covers render; Lens CPU on 120 and 144 Hz and ProMotion displays; the CJK faces; Size on a secondary display; the quiet retry after sleep and wake; the system proxy.
- Still from before: the Definition of done's CPU budget, ±150 ms sync and 1 s latency, the v3 shortcut and login-item checks, and the re-run of `--overlay-probe` for the covered-overlay fix.
Follow-ups, not done:
1. macOS: hide the app when Settings closes, so focus goes back to the previous app (audit finding 26). Needs a Mac to check.
2. Done on 2026-10-16 (finding 47): at startup, a login item that's on but starts another copy (the app was moved) is turned on again through the plugin, which writes this copy's path. `login_item::refresh` decides: it compares the program the item starts (macOS: the plist's first `ProgramArguments` string; Windows: the Run value's path, ignoring case) with this copy's, rewrites only when they differ, so macOS doesn't announce a background item on every launch, and never from an App Translocation path, a disk image or the temp folder, which it logs. A development build (`pnpm tauri dev`, which shares the app's name) never touches the item, and on Windows a Run value in either hive (HKCU, HKLM) that starts this copy counts, so a stale one in the other hive can't cause a rewrite at every start. Not run on a Mac or PC yet (ACCEPTANCE.md §4).
3. `--diagnose`: done on 2026-10-16 (`diagnose.rs`). A macOS player whose newest process hasn't finished launching is listed as "running; still launching, not read" and gets no Apple event, with the app's 10 s grace counted from its launch date. An exact `/api/get` answer that isn't a usable record is logged as "unusable record, searching" and search runs, as in the app. It prints the live login item under the stored `launchAtLogin` (macOS: the plist, its program and `statusForLegacyURL` by name; Windows: the Run value, its program and Task Manager's StartupApproved state) and what the next start changes.
4. `release.yml`: done on 2026-10-16. The draft step checks the tag against `tauri.conf.json`, `package.json` and `Cargo.toml`, and names every file that disagrees.
5. macOS: detect clashes with system shortcuts (HIToolbox `CopySymbolicHotKeys`).
Needs from Codex: nothing.
Contract: unchanged (v3). Only the `yPos` comment changed, in both files.

## 2026-10-18 · Claude Code · proto/compositor (the prototype v4 is built on)
Done: Beautiful-Lyrics-like motion for Drift and Stack, played by the compositor. `src/overlay/motion/` is an engine any style can use: springs solved in closed form and planned ahead as keyframes; a `SongTimeline` that keeps Web Animations on song time through play, pause, seek and clock slews; `KaraokeLine` (a soft-edged wipe per syllable, a pop, a bloom in the highlight color, a letter ripple scaled by how fast the song is sung, held syllables lit letter by letter); instrumental-break dots. Drift and Stack show several lines with distance dim and blur, scroll on a spring, and put three filling dots where the next line will be during an intro or a gap of 3 s or more. A line's animations start and end together, so the page sleeps through words (`ModeRenderer.wordWakes = false` and `nextChange`, 1 s idle sleep); slow motion steps on a shared 20 Hz song-time beat in Chromium (WebKit keeps it linear: stepped keyframes would leave Core Animation). Parser: syllable tags inside a word become `Word.parts`. Mock: track 6, "Glass Harbor" (original placeholder lyrics). Glow 0 turns the bloom off, like the halo in the other styles. USER_GUIDE describes the new motion.
Measured against `claude/friendly-mayer-shv80u` in one session (headless Chromium without a GPU, medians of 3 runs of 20 s). Singing: main thread 1.58% → 1.94% (Stack and Drift), page rAF callbacks 14.4/s → 1.35/s, total CPU 11.8% → 40.1% (Stack) and 11.2% → 42.1% (Drift). Held note: main 0.42% → 0.50%, total 2.3% → 16.1–16.7%. The totals are the software compositor drawing every frame on the CPU (gpu process 6–7% → 30–32%); on GPU-composited machines that work moves to the GPU, which wasn't measurable here.
Not verified: WebKit (WKWebView should give the same animations to Core Animation) and any machine with a GPU.
Needs from Codex: nothing.
Contract: unchanged (v3).

## 2026-10-18 · Claude Code · v4: Beautiful-Lyrics-style motion, and a look picked for each song (contract v4)
Done: Maxwell's feedback on the first real look was that the lyrics felt bland ("each letter should be moving more", "the glow is disappointing"), that Undertone should pick the style and the font for each song instead of asking, and that its sync and animation should feel like Beautiful Lyrics (BL). BL has no license, so none of its code, CSS or comments were used: its motion was studied from its promo video and its renderer's behavior, and re-implemented from scratch. Two engine prototypes were built and judged (planned compositor animations against a per-frame spring painter); v4 takes the first, with four ideas from the second. Everything below is on `claude/friendly-mayer-shv80u`; it supersedes the proto/compositor entry above where they differ (Glow 0 now keeps a faint bloom).
- **Motion engine** (`src/overlay/motion/`):
  - When a line comes into focus, its motion is solved in closed form (springs chasing target curves) and played by the compositor as Web Animations of `transform` and `opacity`. `SongTimeline` keeps them on song time: a pause holds them, a seek re-anchors them, a clock correction of up to 400 ms slews their playback rate, and a larger one jumps. The page sleeps between line changes (`wordWakes = false`) and checks the clock without drawing a frame.
  - Each word fills with the highlight color behind a soft edge, syllable by syllable (`Word.parts`, from enhanced LRC tags), rises and swells on springs, and its letters hop as the color reaches them. A three-layer bloom in the highlight color follows the sung word. A syllable held for about a second or more (the look's emphasis rule) lights and lifts letter by letter while its halo builds.
  - A dark copy of each word sits under everything, unclipped, so the legibility shadow never shows hard edges on a light wallpaper.
  - Instrumental intros and breaks of 3 s or more show three dots that fill one after another, breathe, then swell and pop out just before the next line.
  - Lines move 300 ms before they start (the lead), on a 1.5 Hz spring released from the position actually shown, so seeks of up to three lines glide both ways. Longer jumps, changes while paused and reduced motion crossfade.
  - Amplitude: A = energy × (Effects ÷ 50) ÷ 0.3, capped at 2.5, in units of BL's own motion. A typical song (energy about 0.45) at Effects 50 moves about 1.5 times as much as BL, because the feedback asked for more motion than before. Upcoming words never wait smaller than BL's 0.95, so word gaps stay even.
  - Lite tier (`motion/power.ts`): when the machine composites in software (no WebGL context, or a software renderer such as SwiftShader, llvmpipe or Microsoft Basic Render Driver: VMs, Remote Desktop), words fade instead of moving and the fades and glides step. The overlay page shows the tier as `data-power` on `<html>`.
- **The four styles on the engine:**
  - **Stack** is the BL-like list: neighbors at 0.92 size, fainter and softer with distance.
  - **Drift** is that list tilted back in 3D.
  - **Lens** plans its fisheye as one track per word (`modes/lens-plan.ts`), multiplied with the karaoke, so the magnified word is the one being lit and rising. It no longer restyles every word every frame.
  - **Arc** sets its current line as HTML letters placed on the curve (`modes/arc-place.ts`, within 0.6 px and 0.03° of Chromium's own SVG text on a path), with the full karaoke. The neighbor lines stay SVG `textPath` bands, and the glow band is gone.
- **The look per song** (`src/core/songlook.ts`, `src/core/faces.ts`):
  - From the lyrics and their timing (pace, held notes, gaps, line length, repetition, shouting, script), the title (words like "Acoustic" or "Club Mix") and the cover's colors and light (`coverStats` in `core/palette.ts`), it picks the style, the face, Arc's curve, the motion's energy and snap, the glow, the emphasis rule, a size scale, letter spacing and capitals, with a reason in plain words. A face is never picked without the song's letters (`FontChoice` gains `cyrillic` and `greek`). Plain lyrics always get the calm Stack.
  - The controller owns a `LookKeeper`. The look is committed once the cover is known, a line is about to be sung, or 1.5 s have passed. A late cover or synced lyrics replacing plain ones may refine it once, at a line change or a break, with a crossfade. The last 32 looks are remembered, so a replayed song looks the same at once.
  - `?look=style[,family[,curve]]` on the overlay page and `--look=` on the app force a look for testing; neither is stored.
- **Settings, tray and contract:**
  - The Style group, the Font group and the Curve slider are gone. Under the preview, a "Picked for this song" card names the look (the face in that face) and why. Layout becomes **Look**: Size, Height, **Effects** (new: Calm to Lively, default 50), Glow (0 now keeps a faint bloom) and Opacity. The tray's Style ▸ becomes Effects ▸ Calm (20) · Balanced (50) · Lively (85).
  - Contract v4 adds `effects` (TS and Rust; settings saved without it read as 50). `mode`, `font` and `curve` are still validated and stored, but the overlay no longer reads them.
  - Three new demo songs with original lyrics show three looks: Ledger Lines (Stack · Bricolage), Strobe Hearts (Club Mix) (Lens · Unbounded, in capitals) and Glacier Nocturne (Drift · Instrument Serif). The settings preview's demo plays Glass Harbor and these three.
- **Docs:** README, SPEC.md ("What it is" and a Contract v4 section), USER_GUIDE (a new Look section, Effects, Glow) and LYRICS.md are updated. `docs/ACCEPTANCE.md` checks the CPU budget per style through `--look`, and has new sections for the motion on WebKit and WebView2, the lite tier, and the look picked per song. `pnpm coverage` now covers the motion engine and the picker, with floors of 85% (75% of branches).
Measured, in one session against `4317805` (headless Chromium with software compositing, medians of 3 runs of 20 s, harness word-tag fixture, song 5–25 s):

| Style | Main thread % | rAF callbacks/s | Total CPU %, full tier | Total CPU %, lite tier |
|---|---|---|---|---|
| Stack | 2.02 → 2.36 (1.17×) | 14.1 → 1.9 | 14.1 → 61.3 | 14.1 → 17.5 (1.24×) |
| Drift | 2.10 → 2.39 (1.14×) | 14.3 → 2.0 | 14.0 → 58.8 | 14.0 → 14.2 (1.01×) |
| Lens | 6.45 → 2.62 (0.41×) | 55.2 → 1.3 | 24.2 → 57.8 | 24.2 → 23.2 (0.96×) |
| Arc | 3.00 → 2.97 (0.99×) | 7.7 → 1.6 | 24.2 → 73.4 | 24.2 → 18.3 (0.76×) |

100% is one core. The longest main-thread task, at a line change, is 27–42 ms (it was 1–4 ms).

How to read it: the main thread is what carries over to a real machine. The totals are dominated by the GPU process compositing every animated layer on the CPU, which a real GPU does instead; the lite tier is what such a machine gets. Lens now draws about once a second instead of 55 times while someone sings.
Tests: 1118 vitest (31 files), 261 Rust (1 ignored). `pnpm build`, `pnpm coverage`, `cargo fmt`, clippy (also for the Windows and macOS targets) and the notices check pass.
Decisions you can reverse:
- The Glow slider stays (0 is faint, never off). The design study had suggested folding it into Effects.
- No fifth "Flow" style: Stack is the BL-like list, because the picker wanted Stack and Flow for the same songs.
- Motion is livelier than BL by default (A = 1.5 at a typical song); `BL_ENERGY` in `motion/params.ts` sets it.
- The lite tier's rule (no WebGL context, or a software renderer).
- The tray's Effects presets are 20, 50 and 85.
Known gaps:
- Line changes cost long main-thread tasks on this box: about 18–36 ms on Neon Monsoon and 36–66 ms on Script Sampler's 20-word line, mostly committing the new line's layers (about 14 per word) and parsing its `element.animate` calls. Mounting words just ahead of their time, with fewer layers per word, would spread it out.
- Arc splits each word's bloom copy into letters (one blur per letter); a whole-word bloom would raster faster. After a cut, a word whose overlay isn't built yet shows straight in its frame for a few frames.
- `rebase()` in `motion/karaoke.ts` holds frames before a track's window instead of interpolating them; no current caller depends on it.
- A window that saw plain lyrics, then synced ones, then a late cover can keep a different final look than a window opened later, because the keeper refines once.
Not verified: none of v4 has run on a real Mac or PC, and WebKit hasn't run it at all. `docs/ACCEPTANCE.md` §7, §10 and §11 have the steps. The ones that matter most: the CPU budget per style on a mid-range laptop, the masks and blurs staying smooth under Core Animation and WebView2, and the lite tier on a VM.
Needs from Codex: nothing.
Contract: v4 (`effects` added; `mode`, `font` and `curve` no longer read by the overlay).

## 2026-10-19 · Claude Code · macOS 26: the Automation check could hang, so Undertone never asked
Done: Maxwell installed the v4 build on a MacBook (macOS 26.5.2) and got no lyrics while the Spotify app played. Settings kept playing the demo song, no notice showed, Undertone wasn't listed under Automation, the log had only "started" lines, and `--diagnose` stopped right after its header.
- **Cause:** `AEDeterminePermissionToAutomateTarget` never returned, without showing the prompt. Undertone asked it on a blocking thread before any script ran, so the player stayed "waiting for consent" forever, and that state isn't logged. The report called the same function (without prompting) on its main thread and stopped there. Other apps hit the same hang: [Threek#19](https://github.com/LPFchan/Threek/issues/19) on macOS 26, and SpamSieve 3.0.3 calls it a longstanding bug ([mjtsai](https://mjtsai.com/blog/2023/12/27/spamsieve-3-0-3/)).
- **Fix** (`media/macos.rs`, `media/applescript.rs`): the consent check first asks `AEDeterminePermissionToAutomateTarget` without prompting, on its own thread with a 2 s limit (`QUIET_CHECK_WAIT`); after one hang the run stops calling it, and logs that once. When the user hasn't decided, or that check didn't answer, `/usr/bin/osascript` sends the player one Apple event (`consent_probe`: `get player state`, only if it runs). macOS attributes it to Undertone, the process that started `osascript`, so the prompt names Undertone and the answer is kept for Undertone. The probe waits up to 120 s (`PROBE_WAIT`), then gives up with -1712, which now counts as "not answered" and asks again. Each distinct probe answer is logged once, so the next report shows how the question went. Reads still run in-process through NSAppleScript.
- `Consent::RECHECK` goes from 5 s to 10 s, since a check may now start `osascript`; README, USER_GUIDE and NOW_PLAYING say 10 s.
- `--diagnose` runs its check on a thread with the same 2 s limit and reports "did not answer the Automation check" instead of hanging; it still never prompts.
- README "Nothing shows up" gains the case "Settings plays the demo song while Spotify plays, with no notice", with the `tccutil reset AppleEvents com.undertone.desktop` fallback; INSTALL links to it.
Tests: 1118 vitest (31 files), 263 Rust (1 ignored; new: the probe's script, `osascript` answers and -1712 asking again). `pnpm build`, `cargo fmt`, clippy (also for the Windows and macOS targets) and the notices check pass.
Not verified: no Mac here. The fix compiles and passes Clippy for aarch64-apple-darwin, and the probe's script and answer parsing are unit-tested, but the prompt itself is untested. In particular: that the prompt names Undertone rather than osascript, and that `osascript`'s Apple event isn't caught by the same hang. `docs/NOW_PLAYING.md` macOS step 8 has the check.
Needs from Codex: nothing.
Contract: unchanged (v4).

## 2026-10-19 · Claude Code · Letters cut off where they draw past their box (WebKit)
Done: with the Automation fix in, Maxwell saw lyrics on the Mac, in Caveat, with letters "glitched": the crossbar of a word's last "t" ended in a hard vertical edge, a white sliver sat a few pixels past it, and the top of a final "s" was cut.
- **Cause:** a glyph may draw past its advance (Caveat's t, f, l and d reach 0.09 to 0.21 em past it). Every letter that hops is a layer of its own, and WebKit sizes a layer by its box, not its ink, so the lit copy's overhang was cut at the letter's edge. The wipe also stopped 0.06 em past the word's advance, so the base window, which starts there, showed the unlit copy's overhang: the white sliver. Chromium draws the ink, so none of this showed in the v4 checks.
- **Fix:** `motion/letters.ts` measures each word's ink on the canvas (`canvasInk`, `wordInk`: `actualBoundingBox*` against the advance and `fontBoundingBox*`), and `WordShape.ink` carries it.
  - **Bleed:** `KaraokeLine` sets `--kb-x` and `--kb-y` on the word box (`bleedOf`): sideways the furthest any letter (or the whole word) overhangs its own box, and up and down what the tallest and deepest glyphs draw past a box of the mode's line-height (`KaraokeLook.lineHeight`: Drift and Stack 1.12, Lens 1, Arc 1.2), each rounded up with a pixel to spare. In `stage.css`, every run of text in the overlay (`.kl`, and the new `.kw-run`, which now holds the whole word in the dark and bloom copies) is padded out by it and pulled back by negative margins, its transform-origin corrected, so nothing moves. The plain text gets the same padding while its word has an overlay, since the word box is still a layer when a line hands back to it.
  - **Wipe:** `karaoke.ts` `trailOf` and `leadOf` replace the fixed `OVERHANG` (now the minimum): the wipe starts before ink that leads the word and ends a pixel past its last glyph, and the windows and `closedWindow` follow.
- **Checked** in Chromium, with letter layers clipped to their boxes to stand in for WebKit (`overflow: hidden` on the windows' letters): before, "Hold" read "Hola" and every final t lost its crossbar, in all four styles; after, every letter is whole. With nothing clipped, all four styles are pixel-identical before and after. Script Sampler's Vietnamese line in Fraunces is unchanged, with a 2 to 3 px bleed.
Tests: 1123 vitest (31 files; new: ink measuring, the wipe past overhangs, the bleed, a karaoke line's padding and its clean-up). `pnpm build` and `pnpm coverage` pass.
Not verified: on a real Mac. `docs/ACCEPTANCE.md` §10 step 8 has the check.
Needs from Codex: nothing.
Contract: unchanged (v4).

## 2026-10-19 · Claude Code · Lines lit as a whole, lookups that survive a busy LRCLIB, colors that look like the cover
Done: three reports from Maxwell after the first real use.
- **"When the singer speeds up it stays on the same speed":** most LRCLIB lyrics are timed by line only, and the karaoke swept each such line at the pace `timeWords` guesses, which drifts whenever the singer speeds up or slows down. Now:
  - `parseLrc` and `pacePlain` flag a line whose word times are a guess (`Line.estimated`).
  - The modes draw `karaokeWords(line)` (`core/timing.ts`): an estimated line's words each fill in one quick syllable (`WORD_FILL_MS`, 120 ms), one after another, within `LINE_FILL_MS` (400 ms, at most half the line) of its start, and each stays sung (risen, glowing) to the line's end. Lines timed word by word are unchanged. Nothing else reads the presentation timing: the stage's cues and the picker still see the estimates.
  - `planWord` takes the ripple's hold from the wipe's own duration (the last syllable's end), so a quick fill in a long word hops as quickly as it lights.
  - Lens magnifies no word on an estimated line (the row rests), and the picker never sets a line-timed song in Lens. Neon Monsoon, line-timed, is now Arc · Fraunces without its cover as with it, so `look-wiring`'s refinement tests use a stand-in dark gray cover that moves it to Drift.
- **"Couldn't load lyrics for a lot of the songs":** LRCLIB's `/api/get` answers 503 (not 404) to metadata it can't match exactly, such as an album name or a length it has differently, which is common with Spotify's metadata, and `/api/search` answers 503 with `retry-after: 1` about half the time (measured from here, through Cloudflare). `lookup` propagated the exact lookup's error with `?`, so the search never ran. Now:
  - A failed exact lookup is a miss.
  - `/api/get` is asked again without the album.
  - The search is asked up to `SEARCH_ATTEMPTS` (4) times while it answers busy.
  - The lookup's `DEADLINE` goes from 6 s to 15 s.
  - Live, with album names and lengths unlike LRCLIB's for five songs, three rounds: 14 of 15 found in 0.3 to 3.5 s. The miss was a made-up length no version on LRCLIB has. The old client would have answered error for all 15.
- **"I want the lyrics color to match the album cover":** `paletteOf` left the lyric color near white (lightness 0.92, saturation ≤ 0.3) and the dim color gray whatever the cover, and gave black-and-white covers the default amber. Now:
  - The highlight keeps the vivid color's own saturation (0.56 to 0.95, lightness 0.6 to 0.74).
  - The lyric and dim colors take the cover's tone: the chroma- and share-weighted mean hue of its colorful pixels. Their tint is as strong as those pixels' saturation, times how well their hues agree, times how much of the cover they take (in full from 30%). The lyric is at lightness 0.84 to 0.87 and saturation up to 0.72; the dim at lightness 0.66.
  - A highlight of the lyrics' own hue is held at lightness ≤ 0.66, so sung words stay distinct.
  - Gray covers get grays: a near-white highlight (0.96) over light gray lyrics (0.74) and a gray dim (0.56), or their colorful accent as the highlight.
  - Checked by eye on 15 real covers, fetched for a local check only and not committed.
Tests: 1131 vitest (new: the `estimated` flag, `karaokeWords`, the hop hold, Lens resting on an estimated line, the picker never choosing Lens for line timing, and the palette rewritten for the new rules with legibility over 300 random covers). 265 Rust (1 ignored; new: a busy exact lookup still searches, the album-less exact lookup, search retries, the 15 s deadline). `pnpm build`, `pnpm coverage`, `cargo fmt`, clippy (also for the Windows and macOS targets) and the notices check pass.
Decisions you can reverse:
- Line-level lighting for every line without word tags, rather than a better guess at word times. The fill's speed (`LINE_FILL_MS`, `WORD_FILL_MS`) is in `core/timing.ts`.
- No Lens for line-timed songs.
- The lyric color may go to lightness 0.84 (the C4 rule said 0.85), and gray covers' lyrics to 0.74.
Not verified: on a real Mac or PC. `docs/ACCEPTANCE.md` §10 steps 9 and 10 have the checks.
Needs from Codex: nothing.
Contract: unchanged (v4).


## 2026-10-19 · Claude Code · Effects mode: each song's own motion, splashes and word pictures (contract v5)
Done: Maxwell asked for different effects for different songs ("not every text has to be a float up"), splash effects, tiny pictures near words that name something ("if a song is talking about ice tea, generate a graphic of ice tea… tiny, so it doesn't take up too much"), and an on/off switch for all of it.
- **Contract v5:** `Settings.effectsMode` (default true; settings saved without it read as true). TS, the mock store and Rust (`contract.rs`, `merge_patch`, migration tests) agree. Settings › Look has an **Effects mode** switch at the top with a caption that says what it does. The tray's **Effects ▸** menu has an **Effects mode** check item under the three levels. Reset to defaults turns it back on.
- **A flair per song** (`core/flair.ts`, picked in `core/songlook.ts` `flairOf` from the same axes as the look, with a trackKey-hash nudge so similar songs differ):
  - a `move` for most lines and an `accent` move for the hooks (lines the song repeats, `hookLines`).
  - Six moves (`overlay/motion/params.ts` `moveTuning`): **rise** (the v4 motion, unchanged), **bounce**, **sway** (a tilt that swings back through rest, alternating sides, in its own transform list `liftTiltScale`), **wave** (taller, slower letter hops), **pulse** (a quick swell, no lift) and **drop** (waits above the line and drops in).
  - Each mode works a line's parameters out through `LineMoves`. Lens keeps rise's swell for every move (`riseSwell`) and turns a pulse into a bounce, because its fisheye already enlarges the sung word.
  - A `splash` of **drops**, **sparks**, **confetti**, **ripple** or **glints**, chosen by what the lyrics mention (`themesOf`: water, fire, party, night) and the pace.
- **Splashes** (`overlay/motion/decor.ts` `planSplash`):
  - They mark a held note (the look's held-note rule, on word-timed lines only), a hook's last word, or a shouted line's last word. At most one a line, 5 s apart (`planDecor`).
  - 2 to 12 pieces, seeded per word, sampled at 30 fps and thinned, on transform and opacity only.
  - They sit under every copy of the word, so a burst never covers it.
- **Word pictures:**
  - **How they were made:** 49 small stickers generated with Higgsfield. The model was GPT Image 2.5 at medium quality with a transparent background, in one glossy-3D-emoji style; that style was picked from a four-way test on iced tea and cost about 26 credits.
  - **Files:** trimmed and scaled to 160 px WebP (377 kB together) in `src/overlay/pictures/`, bundled with the app (`overlay/pictures.ts`).
  - **Matching** (`core/wordpics.ts`):
    - Literal English words and phrases of up to three words, plus plurals, possessives and a dropped g. The longest phrase wins ("broken heart" over "heart"), and the picture goes on the phrase's last word.
    - Words with several meanings ("ring", "wave", "tear", "ice", "present") only count inside a phrase.
    - At most one picture a line, 6 s apart, and the same picture 25 s apart.
  - **On screen** (`KaraokeLine`):
    - The picture pops in above the word as it's sung, floats about 2.4 s and fades. It sits under the word instead on a wrapped line's later row (one `offsetTop` read, only for that word).
    - Without motion it only fades. Pictures are fetched and decoded when the song's lyrics are drawn.
  - **Lifecycle:** extras run on their own song-timeline windows (group `<line>+fx`), so the line's shared window doesn't stretch. A sung line leaving focus freezes them, and they fade out with its overlay; a re-mount starts them over.
  - **Off:** there is no decor with Effects mode off, for unsynced lyrics, or in the lite tier.
- **QA:** `?flair=move[,accent[,splash]]` on the overlay page forces a flair (never stored). Each lyrics scene carries `data-flair`. Checked in Chromium with `?power=full`, in all four styles:
  - Pictures above words (Drift, Stack, Lens and Arc) and under a wrapped second row (Stack).
  - Every splash kind mid-burst; the first round was too small and too slow to read, and was retuned.
  - Reduced motion: pictures still, no splash.
  - Lens no longer pushes a swelling word into its neighbors.
  - Settings in light and dark.
  - Main-thread time over 20 s with Effects mode on against off, in headless Chromium with software compositing: +0.1 points for Strobe Hearts and +0.4 for Glacier Nocturne.
Tests: 1186 vitest in 33 files. New: `wordpics.test.ts`, `flair.test.ts`, KaraokeLine extras and the sway tilt in `motion.test.ts`, the switch in `settings-look.test.ts`, the v5 contract and the mock store, and the look keys. Coverage is 98.6% of statements; flair.ts 99%, wordpics.ts 99%, decor.ts 99%. 267 Rust tests (1 ignored), including v5 migration, merge, the contract and the tray item. `pnpm build`, `cargo fmt`, clippy (also for the Windows and macOS targets) and the notices check pass.
Decisions you can reverse:
- Effects mode is on by default.
- Only bundled pictures; nothing is generated while a song plays.
- The pacing limits: `PICTURE_GAP_MS`, `SAME_PICTURE_GAP_MS` and `SPLASH_GAP_MS`.
- Splashes on held notes, hooks and shouted lines.
- Lens never pulses.
Not verified: on a real Mac or PC. `docs/ACCEPTANCE.md` §12 has the checks, and §7 now notes that the CPU runs include Effects mode.
Needs from Codex: nothing.
Contract: v5 (`effectsMode`).


## 2026-10-19 · Claude Code · Lyrics without timing: a synced version looked for, better pacing, a readable sheet
Done: Maxwell again: "when the singer speeds up and slows down the lyrics can't catch up because they stay on a fixed tempo".
- **What still had a fixed tempo:** since the line-level lighting above, a song with line timestamps lights each line as the singer starts it, at whatever pace they sing. A live probe of LRCLIB for 8 popular songs found 20 records each, all synced, none plain-only, so that covers most songs. What was left: songs whose closest LRCLIB match is plain text, which `pacePlain` spread evenly from 0:00 to the end, so every line drifted as the singer's pace changed.
- **A synced version, looked for at once** (Rust, `lyrics/`):
  - `Provider::synced` (by default none) asks LRCLIB for a synced version of the same song: the exact record (it may have gained timing since), the exact lookup without the album, then the records a search finds under the title and under its `retry_title` form. `matching::best_synced` ranks only the records with synced lyrics that aren't instrumental, by the usual rules, so another album, or a length a duration band further off (still within 8 s), wins over plain text.
  - The service asks it as the quiet follow-up right after any plain-only answer for the playing track. Before, only a cached plain-only answer older than 30 days was rechecked, and with the same lookup that had found plain text. A synced answer replaces the plain text live and is cached. With none, the plain text stays and its 30 days start again; a failure leaves it due for the next play.
  - Cache entries are format version 2. A version 1 plain-only entry, saved before this follow-up existed, is served and due at once, so songs already played get the search at their next play.
- **Better pacing when there is no timing at all** (`pacePlain`): the first line waits for an intro (6% of the song, 2 to 14 s) and the last ends before an outro (7%, 3 to 18 s). Each line takes time by its syllables plus a breath, and a blank row between stanzas is a pause as long as an average line. A short song with many lines gives up its intro and outro first, so every line keeps at least 1.2 s.
- **A readable sheet** (the calm list unsynced lyrics get): the guess can still be a line or two off, so the two lines each side of the current one are drawn sharp in the lyric color, the next ones at 82% fading gently (`lineLevel(off, calm)`, `CALM_NEAR_LEVEL`, `CALM_SHARP_LINES`), instead of dimmed and blurred like a timed song's neighbors.
Tests: 1190 vitest in 33 files. New: `pacePlain`'s intro, outro, syllable weights and stanza pauses; the calm `lineLevel`; unsynced near rows drawn sharp. Coverage is 98.6% of statements. 276 Rust tests (1 ignored). New: `best_synced`; `synced` finding a version by search or the exact record that gained timing, finding none, a failed search as a transient error, nothing asked for an untitled track; a plain answer replaced live; no synced version, asked about once; only the playing track asked about; the version 1 cache entry. `pnpm build`, `cargo fmt`, clippy (also for the Windows and macOS targets) and the notices check pass.
Decisions you can reverse:
- A synced version from another album or edition, or with a length up to 8 s off, is preferred to the exact match's plain text.
- The plain pacing constants in `core/timing.ts`: `PLAIN_INTRO`, `PLAIN_OUTRO`, `PLAIN_MIN_LINE_MS`, and the breath and stanza weights.
- Two sharp neighbors each side for unsynced lyrics.
Not verified: on a real Mac or PC. `docs/ACCEPTANCE.md` §11 step 3 has the checks.
Needs from Codex: nothing.
Contract: unchanged (v5).


## 2026-10-19 · Claude Code · Lyrics always in the middle, no Height setting (contract v6)
Done: Maxwell: "ensure that lyrics are always centered, no option for height, only size".
- **Contract v6:** nothing added or removed. `Settings.yPos` is still validated and stored (TS, the mock store, Rust) but not read since v6, as `mode`, `font` and `curve` haven't been since v4. Settings saved by older builds keep their value; it moves nothing.
- **Placement** (`resolveLook`): `look.y` is always the middle of the stage. On the desktop that is the middle of the display's work area (below the menu bar, clear of the Dock and the taskbar); in the settings preview, the middle of the miniature desktop under its menu bar.
  - Drift and Stack center the focus line on it. The code that moved a tall focus line in from an edge (`EDGE_PAD`) went with the Height: a line is at most 45% of the stage, so it always fits.
  - Arc centers the song's widest line, its middle as far above the middle as its ends below (`arcGeometry(look, extent)`); shorter lines share its middle, so lines don't move up and down from one to the next. The clamp that moved the curve in from the top or bottom went with the Height; the bend's limit still keeps a deep curve whole.
  - Lens centers the focus line, and still moves the pair up on a stage too short for the next line below it (`focusCenter`).
  - The loading pulse, the ♪ and the not-found chip were already drawn at `look.y`.
- **Settings › Look:** Effects mode, Size, Effects, Glow and Opacity; the Height slider is gone.
- **Checked** in Chromium with the mock bridge and a stored `yPos` of 10, on a 900 px stage: the focus line's center is at 450.3 px in Drift and Stack, 450.5 in Lens, and 448.7, 453.1 and 447.1 in Arc at curves 38, −60 and 100. In the settings preview (light and dark) it is at 120.6 in a stage whose middle is 122.
Tests: 1189 vitest in 33 files. Changed or new: placement in the middle whatever `yPos` says, Arc centering the widest line, Lens's next line on a short stage, the Look group without Height, the guide without a Height section, and no stage rebuild for a `yPos` change. Coverage is 98.6% of statements. 276 Rust tests (1 ignored). `pnpm build`, `cargo fmt` and clippy pass.
Decisions you can reverse:
- `yPos` stays in the contract, unread, rather than removed (SPEC: add fields, don't remove them).
- Arc centers the song's widest line rather than each line, so every line keeps the same height.
Not verified: on a real Mac or PC. `docs/ACCEPTANCE.md` §13 has the checks.
Needs from Codex: nothing.
Contract: v6 (`yPos` no longer read).


## 2026-10-19 · Claude Code · Word by word again, at the song's own pace
Done: Maxwell, on the build that lit whole lines: "now it's not even syncing by word, it's just syncing the entire section like sentence … I want it to sync by the word like the previous build". Before that build he had said the word sweep "can't catch up because it stays on a fixed tempo" when the singer speeds up and slows down.
- **A word sweep again** for lines timed by line only. The modes draw `line.words` again (`karaokeWords`, `LINE_FILL_MS` and `WORD_FILL_MS` are gone), Lens magnifies the guessed word again, and the picker may set a line-timed song in Lens again (Neon Monsoon is Lens · Bricolage without its cover, as before 07dbaf5).
- **Paced to the song** (`core/timing.ts`). The old estimate spread a line's words over all the time up to the next line, so where the singer paused after a line the sweep crawled through the pause, fell behind, and jumped at the next line. Now:
  - `singingPace` reads how fast the song is sung around each line. A line's rate is its beats (word weights: syllables plus half a beat a word) over the time until the next line starts. The pace near a line is the 70th percentile (`PACE_QUANTILE`) of the rates of the lines up to 4 either side (`PACE_WINDOW`): a pause only makes a line read slower, so a high share of the nearby rates is the singing pace, and the window follows a song from a slow verse into a fast chorus.
  - `paceWords` sings a line at that pace: for as long as its beats take, or the whole line when it has less room (the singer hurried), split by weight as before (`timeWords`). When there's room left, the last word holds up to 600 ms more, and the rest is a pause.
  - `parseLrc` works out the pace for the whole song, then times each line without word tags.
- **Measured** on the line timing of 20 popular songs from LRCLIB (none of their 400 versions has word tags; fetched for a local check only, not committed): the median line sweeps as before (it fills its slot); a quarter of the lines, those followed by a pause, now finish more than 20% sooner than before, and 5% in under half the old time.
Tests: 1192 vitest in 33 files. New: `beatsOf`, `singingPace` (pauses, speeding up and slowing down, the quantile, gaps), `paceWords`, `parseLrc` pacing a line before a pause, and Lens magnifying a guessed word. The whole-line tests are gone, and the look-wiring and picker tests are back to Lens for line-timed songs. `pnpm build` passes.
Decisions you can reverse:
- `PACE_QUANTILE` (0.7) and `PACE_WINDOW` (4).
- Lens may be picked for line-timed songs again.
Not verified: on a real Mac or PC. `docs/ACCEPTANCE.md` §10 step 9 has the check.
Needs from Codex: nothing.
Contract: unchanged (v6).


## 2026-10-19 · Claude Code · Realistic word pictures, nearly three times as many, some alive
Done: Maxwell: "the graphics … are too basic and too cartoony, they should be more mature and more common; maybe the flame can have a little effect, and there should be more of them."
- **A new library** (`src/overlay/pictures/`): 140 photorealistic pictures on transparent backgrounds, as 160 px WebP files (884 KB together). They were generated with Higgsfield (GPT Image 2.5, medium quality, transparent background) after a style test of photorealistic, cinematic and painted versions of a flame, iced tea, a rose and the moon; the photorealistic ones won because they read as real things at 30 px.
  - The set: 47 of the 49 before, redone (sparkles became a sparkler, and sunset's words now call the sun), and 93 new subjects, the things songs mention most. Drinks and food (whiskey, tequila, a milkshake, a burger, popcorn, ice cubes), love (a bouquet, a sunflower, perfume, a teddy bear), the sky (clouds, an umbrella, a galaxy, the Earth, a rocket, fireworks), fire and light (a campfire, a lighter, a match, a light bulb, a lantern, a street lamp, smoke), places (a city, a house, a castle, a lighthouse, a bridge, a mountain, trees, a cactus, a sailboat, an anchor), travel (a truck, a motorcycle, a paper plane, a train, a suitcase, a map, a compass), home (an hourglass, a key, a door, a window, a bed, a mirror, a polaroid, a book, a pen), clothes and jewelry (sunglasses, heels, sneakers, boots, a cowboy hat, a dress, a leather jacket, a watch, pearls, gold bars), games and things (dice, cards, a clover, a trophy, a balloon, a bottle, a laptop, a TV), music (a microphone, headphones, a radio, a cassette, a piano, a drum, a saxophone) and animals (a bird, a dove, a raven, a wolf, a snake, a horse, a dog, a cat, a lion, a tiger, a bee).
  - 68 credits, plus 6 for the style test. The generator left a faint pale halo around four (the dice, compass, lemon and ring); processing fades out their wide, faint alpha, and only theirs.
- **More of them** (`core/wordpics.ts`): 678 words and phrases instead of about 370, written out from the same list as the prompts. Pictures may show 4 s apart (was 6), and the same one again after 20 s (was 25). Words that often mean something else in lyrics are left out or count only in a phrase: "shades" (of gray), "jet" (black), "kicks", "pine" (for you), "pickup" (line). "Head over heels" calls the heart, not the heels.
- **Living pictures** (`overlay/motion/decor.ts` planPictureLife, KaraokeLine's extras). With motion, on the picture's own window:
  - A flame (fire, a campfire, a candle, a lighter, a match) flickers on its `scale`, sampled every 80 ms and seeded, in its own glow (`.kw-aura`, under the word's copies, moving with the picture). Fire and a campfire throw 3 and 4 embers.
  - A light bulb, a lantern, a street lamp, the sun and the moon glow, with a slow breath.
  - A star, a sparkler, fireworks and a diamond twinkle; a heart beats three times; a butterfly beats its wings.
  - Transform and opacity only, as everything else. None without motion, in the lite tier or with Effects mode off. The pose keeps `translate` and `rotate` inline, so a picture's own motion is on `scale` only: no sway or bob.
- **Checked** in Chromium with the mock bridge, with a demo song's lyrics swapped in the page for original test lines: the lighter flickers in a warm glow, a campfire's embers rise, the heart beats, and the rain cloud and the others pop in as before.
Tests: 1198 vitest in 33 files. New: living pictures in a line (a flame's flicker, light and embers, all stopped as the line leaves; a heart's beat with no light; nothing without motion) and planPictureLife (every kind, tracks over the picture's window, seeded, embers only from big flames, wing and heart beats). Changed: the word tests for the new vocabulary and gaps, and two transport tests whose fixture line ("Paper lanterns…") now shows a picture on its own window. Coverage is 98.6% of statements. `pnpm build` passes.
Decisions you can reverse:
- The photorealistic style.
- The 4 s and 20 s gaps.
- Which pictures live.
- The size is unchanged (0.6 of the line's size).
Not verified: on a real Mac or PC. `docs/ACCEPTANCE.md` §12 step 3 has the check.
Needs from Codex: nothing.
Contract: unchanged (v6).


## 2026-10-19 · Claude Code · Held notes, pictures that move with the song, Poster and Spotlight, a new README
Done: Maxwell: "make the github pretty … a nice download … show pictures", then "way too much writing", "the text layout is always the same curved and then vertical", "the little animations … just float above", and "when the singer drags out a word … the words continue and don't stay on that word".
- **Held notes** (`core/timing.ts`): in lyrics timed by line only, the slot's spare time goes to the words a singer is likely to hold (the last word, a word before a comma or a dash, a stretched "sooo" or "~", "oh" and "yeah", an open vowel), with `holdWeight` and `holdBudget`. A word holds for at most `HELD_WORD_MS` (4 s). Word-tagged lyrics are untouched.
- **Pictures that join in** (`overlay/motion/routes.ts`): a picture travels its line on song time instead of sitting over its word. Most hop from word to word, landing on each as it starts; birds and planes fly across, cars and animals drive along the tops of the words, a rocket lifts off, hearts and balloons float up, rain and leaves fall with copies, stars and fireworks burst, the sun and moon circle, dice roll off, a flame or a guitar dances in place. Pictures sit in line-level layers (`.kw-pics`, `.kw-route`), positioned from where each mode draws its words (`KaraokeLook.spot`). A picture is 1.2 font sizes across, of its word as it is sung (`KaraokeLook.scaleOf`, at most 2×), so it is as big as the swollen word in Lens, Poster and Spotlight. In Poster's block (`SlotLayout.blocks`) pictures travel over the block's top row, so a picture for a word in a lower row doesn't cover the row above it.
- **Two new styles** on Lens's slot engine (`overlay/modes/slot-layouts.ts`): **Poster** sets a short line as a block of rows in big type, tilted in one of seven compositions; **Spotlight** shows one huge word at a time and slides the line through it. The picker scores both; one-line styles within 0.1 of each other are chosen by the track's hash, so similar songs vary. `Style` adds them on the TypeScript side only; the contract's `Mode` is unchanged.
- **README and docs**: the README is now a picture-first front page (banner, badges, a looping demo, download buttons, a 3×2 style grid, the moving-pictures clip, a small "how it's built" diagram). Long material moved out to `docs/DEVELOPMENT.md`, `docs/TROUBLESHOOTING.md` and a Permissions section in `docs/INSTALL.md`. Media is in `docs/media/`, recorded from the real overlay with the mock bridge and original placeholder lines; wallpapers were generated with Higgsfield.
- **Release names** (`.github/workflows/release.yml`): bundles upload as `Undertone_universal.dmg` and `Undertone_x64-setup.exe`, so the README's `releases/latest/download/…` links keep working across versions.
Tests: 1224 vitest in 35 files. New: `holdWeight`, `holdBudget` and held words in `paceWords`; `routes.test.ts` (every route, hops landing on each word's start, copies, seeded); `slot-layouts.test.ts` (Poster's balanced rows and compositions, Spotlight's slide); pictures in their line's layers on their own window, sized to their word; Poster and Spotlight on Lens's engine, Poster's pictures over its block. Coverage is 98.5% of statements. `pnpm build` passes.
Not verified: on a real Mac or PC.
Needs from Codex: nothing.
Contract: unchanged (v6).


## 2026-10-20 · Claude Code · Tighter sync on the Mac, learned sync, and updates that take over (contract v7)
Done: Maxwell: "a lot of the time it still is slightly off … I also don't want to have to tweak it so often", then "the macbook build isn't the updated build".
- **The Mac position, timed right** (`media/applescript.rs`, `media/macos.rs`): the read script asks for the player state and the track's details before its position, near the end of the call, but the reading was stamped with the call's midpoint, so lyrics ran early by about a third of the call, and by more, unevenly, on a busy Mac. Right after each read, on the same main-thread hop, a script that asks for `player position` alone is stamped with the middle of its own call (`SPOTIFY_POSITION`, `MUSIC_POSITION`, `timed_reading`). The read's own position stands in if it fails or takes over 250 ms.
- **A steadier clock** (`core/clock.ts`): while playing, the clock follows the middle of the last five readings' phase (position minus read time) instead of each reading in turn, counts a repeated reading once, follows a real move (a stall) once two readings agree on it, and starts over on a pause, a resume or a seek.
- **Learned sync** (`core/sync.ts`, `settings.rs`; contract v7): a song without its own nudge starts from what the last nudged songs have in common, the middle of their own offsets (from two songs on; of two, the one nearer 0). `Settings.nudgedTracks` keeps the last 9 nudged songs; `trackOffsetsMs` keeps a 0 now (a song's own offset); `set_track_offset` takes `ms: null` to drop a song's own offset (Reset this song, the tray's Reset). Settings shows "· learned" for a song following it. The shortcuts and the tray nudge from the learned value.
- **Updates take over** (`lib.rs`): single-instance hands every second launch to the running Undertone, so opening a newly installed build left the old one running. A second launch now checks whether the executable on disk changed since this instance started and, if so, restarts into it (`replaced_on_disk`, `AppHandle::restart`). The build's commit (`build.rs` and `vite.config.ts`: CI's `GITHUB_SHA`, else git's HEAD) shows on the tray menu's last line, at the bottom of Settings, in the log's start line and in `--diagnose`.
Tests: 1239 vitest in 36 files (new: `sync.test.ts`; the clock's phase window; Settings' learned value; v7 settings in the mock) and 283 Rust tests (position scripts and `timed_reading`, `learned_offset_ms` on the same cases as `sync.test.ts`, `nudged_tracks`, `with_track_offset(None)`, the tray's reset and build line, `replaced_on_disk`). `pnpm coverage` and `pnpm build` pass.
Not verified: on a real Mac or PC, which the timing needs: compare the highlight with a song whose lyrics time every word, before and after.
Needs from Codex: nothing.
Contract: v7 (adds `Settings.nudgedTracks`; `set_track_offset` takes `ms: null`).


## 2026-10-20 · Claude Code · Sung words in a gradient of the cover's colors
Done: Maxwell: "I want the lyrics to be more of a gradient because right now its one color and that one color DOES NOT match the album cover" (a cover of a wooden door in dark green ivy, gold lettering; the highlight was a tan from the door).
- **A second color** (`core/palette.ts`): `Palette.accent`, the cover's other main color: its pixels binned by hue (24 bins), each weighted by its share of the cover and, below 0.12 chroma, by how colorful it is, so a big muted area (dark olive ivy at 0.05) still counts; the heaviest bins at least 40° from the highlight's hue, more distant ones counting more (a sky's violet edge doesn't beat its orange horizon), averaged with their neighbors; at least 12% of the main color's weight, three bins (45°) at a time. From the pixels, not the 16-level buckets: averaging a bucket turns dark olive gray. It is lightened to 0.62–0.74 and kept as muted as the cover has it (saturation from 0.36), so an olive stays an olive. A one-color cover, a gray one and the user's own colors blend into the highlight's neighbor on the color wheel (`accentFor`).
- **The gradient** (`styles/stage.css`, `overlay/motion/bloom.ts`): the lit letters (`.kw-win .kw-in .kl`) are filled top to bottom from `--ut-hl` into `--ut-hl2` with `background-clip: text`. Every letter is filled alike, so a line reads as one gradient in every style, Arc's letters on their curve included. The bloom stays in the highlight.
- **Checked** in Chromium with the mock bridge and a 48×48 sample of the cover from the report (not committed): tan into sage green (`#d29760` → `#9ec17b`); a sunset sea goes blue into coral; every style shows it.
Tests: new palette cases (the muted second color, a main color's fringe, a one-color cover, `accentFor`, the accent's legibility on 300 random covers) and `--ut-hl2` on the rows.
Not verified: on a real Mac or PC.
Needs from Codex: nothing.
Contract: unchanged (v7).


## 2026-10-20 · Claude Code · Nine styles, fifteen faces, words that answer their pictures, Graphics apart (contract v8)
Done: Maxwell: "add some more styles … for different types of songs", "the graphics are still too basic they are just graphics floating around I want it to be more incorporated in the lyrics", "I want the text effects to be its own switch … the graphics and the text effects should be different", "add more font options make sure they match the vibe of the song", and "make the curve … not be so strong".
- **Graphics apart from Text effects** (contract v8): `Settings.graphics` (default true) turns the pictures and the splashes on and off; `effectsMode` is now Text effects, the song's own moves, alone. Two switches in Settings › Look and two items in the tray's **Effects ▸**. `planDecor` takes `DecorParts`. Settings saved before v8 take `graphics` from `effectsMode` (`settings.rs` `migrate`, the mock's `migrateSettings`, `withDefaults`).
- **Three more styles** on Lens's engine (`slot-layouts.ts`): **Wave** (the crest follows the voice, words tilt along its slopes), **Reveal** (words wait as ghosts and come up as they're sung) and **Collage** (cut-out words, each its own size and tilt, in rows). Scored for dance and electronic songs, rap and story songs with word timing, and shouted rock songs; glyphs on the Settings card.
- **Seven more faces** (OFL, `@fontsource`): Anton, Playfair Display, Space Grotesk, Righteous, Pacifico, Rubik, Pirata One, each with its vibe in `fontScore`, vetoes (scripts and blackletter not for fast or long lines), metrics and style harmony. Their notices are in `THIRD_PARTY_NOTICES.txt`.
- **A gentler Arc**: the picked curve is 8 to 32, the house look's 22 (was 12 to 60, and 38).
- **Words answer their pictures** (`routes.ts` `reactions`, played by `KaraokeLine` in its own group): a hop squashes each word it lands on, a bird ducks them, a car dips them, a rocket shakes and kicks its word, a balloon or a heart lifts it, rain hits the words, a burst pops its word and shoves its neighbors, the moon tilts its word, a ball knocks the words, a flame's word sways and shimmers. On the word box's `translate`, `rotate` and `scale`, composing with its pop; at rest at both ends; cancelled, not frozen, as a sung line leaves focus.
- **Checked** in Chromium with the mock bridge (`?power=full`: headless Chromium is the lite tier, which draws no pictures): every new style on three demo songs, the heart lifting "HEARTS", gold shoving "slow" aside.
Tests: 1260 vitest in 36 files (new: Wave, Reveal and Collage layouts; every layout's pose finite; reactions for every picture, at rest at both ends, bounded; Graphics apart from Text effects in `planDecor`, the mock, `withDefaults` and the panel) and the Rust tests (v8 default, `migrate` carrying Effects mode into Graphics, the tray's Graphics item).
Not verified: on a real Mac or PC.
Needs from Codex: nothing.
Contract: v8 (adds `Settings.graphics`).


## 2026-10-20 · Claude Code · Words that become what they say
Done: Maxwell: "instead of there just being an emoji that pops up how about the words like fire … actually catches on fire so for moonlight or sun there is a half cut sun behind it like a horizon … same with a snowflake".
- **Word scenes** (Graphics): `core/wordscenes.ts` lists the words of ten scenes (fire, sun, moon, snow, rain, electric, love, gold, water, stars) and plans one a line, 2.5 s apart, the same one 9 s apart. `planDecor` gives a line's scene word `WordDecor.scene`; a line with a scene shows no picture.
- **Drawn in the word** (`overlay/motion/scenes.ts`, `KaraokeLine.sceneOf`, `stage.css` `.kw-scene` and `.sc-*`): pieces in two layers of the word's own overlay, behind its letters (under the dark legibility copy) and in front, so the scene moves with the word in every style; clipping windows for a horizon and a pool. Fire catches left to right with flame tongues behind the letters and embers; the sun and the moon rise as half discs out of a horizon at the word's baseline (`baselineOf`, from the measured ascent and descent) and set as the line ends; snow falls and drifts; rain streaks and drips; bolts flash; hearts rise as the word beats; sparkles wink; water rises with bubbles; stars twinkle. The word's lit letters and bloom take the scene's colors (`--ut-hl`, `--ut-hl2`, `--ut-bloom`). Some scenes move the word itself (shiver, heartbeat, jolt, bob) on its box's translate, rotate and scale, in the reactions' group. Every piece fades out with its scene; without motion a scene only fades in and out.
- **Checked** in Chromium with the mock bridge (`?power=full`) on the demo songs and a scene test song of placeholder lines, in Lens, Arc, Stack, Drift and Poster: the sun and the moon read as half discs on a horizon behind the word, fire licks up behind the letters, snow drifts at the word's feet; the sun's and the moon's letters were made lighter for contrast over their discs.
Tests: `scenes.test.ts` (the vocabulary, matching, the plan's spacing, every scene's tracks unseen at both ends and seeded, fire catching left to right, the sun rising out of the horizon and setting, the drift, the word's own motion, no motion); a Lens test for the river's water drawn in its word instead of the lantern; picture tests moved to words without a scene.
Not verified: on a real Mac or PC.
Needs from Codex: nothing.
Contract: unchanged (v8).


## 2026-10-28 · Claude Code · Kinetic type: Slant, Pop, Cascade, Tape, twelve more faces, and a Style picker
Done: Maxwell shared a reel of lyrics as kinetic type and asked for "the lyrics to be like this or have a toggle to switch like this like slanted ... be more animated ... add more fonts and styles because now it feels like its recycling the same 5 styles".
- **Four more styles** on Lens's engine (`slot-layouts.ts`), picked per song like the others (`songlook.ts` scores, glyphs on the card): **Slant** (the reel's look: the line built up word by word in a column turned −6°, each word sliding in large on a tag of marker color as it's sung, then shrinking into the stack above as the next lands), **Pop** (one huge word at a time, rising in and flung up out of the way), **Cascade** (the line stepping down the screen like stairs, the view panning with the voice) and **Tape** (Collage's cut-out words, each stuck on a strip of tape as it's sung). Slant and Pop hide the next line.
- **Tags**: a new optional pose channel (`LensPose.tag`, `LensPlan.tagTracks`) planned with the slot tracks and played on the compositor as `scaleX` and opacity on a `.lens-tag` behind each word. `palette.ts` `tagFor` takes the highlight's hue and darkens (or lightens) it until the lyric color reads on it at 3.4:1; a grey highlight gets a red marker. On tagged rows the lit text takes the lyric color.
- **Twelve more faces** (OFL, `@fontsource`): Archivo Black, Bebas Neue, Oswald, DM Serif Display, Abril Fatface, Sedgwick Ave Display, Bungee, Silkscreen, Bodoni Moda, Shrikhand, Chakra Petch, Lilita One, each with its vibe in `fontScore`, vetoes, metrics and style harmony (27 in all). Permanent Marker was left out: it is Apache-2.0, not OFL. Notices regenerated.
- **Style picker** (Settings › Style, under the card): Auto or one style for every song. The pin is kept in the windows' shared web storage (`overlay/pin.ts`, key `undertone.style-pin`), applied through `OverlayController.forceLook` under the QA overrides, and reaches every overlay through the `storage` event. Reset to defaults goes back to Auto. The card's intro says when a style is pinned.
- **Checked** in Chromium with the mock bridge: Slant, Pop, Cascade and Tape on the demo songs over the dusk and light wallpapers; pinning Slant in Settings changes the preview and the card at once. Pop's hand-off was reworked after the first look (the old and new words overlapped in the middle).
Tests: 1272+ vitest in 37 files (new: the four layouts' poses, tags, Pop's hand-off, Cascade's stairs, `tagFor`'s contrast and red marker, the Style group and its pin). The feature grid and the Lens plan continuity test now have 30 s timeouts: both already timed out at 5 s before this change.
Not verified: on a real Mac or PC, in particular that WKWebView and WebView2 deliver the `storage` event across the overlay and Settings windows (same origin, same data store, so they should).
Needs from Codex: a contract field for the pin, so the tray can show it and it survives a cleared web storage: `Settings.style: "auto" | Style` (default "auto"), stored and validated like `graphics`. Until then the pin lives in web storage only.
Contract: unchanged (v8).


## 2026-10-28 · Claude Code · Auto picks livelier: Arc, Drift and Stack retired
Done: Maxwell, after trying the kinetic build: "this is better but I want it to choose better, remove some of the original styles they are just lame and always go for high reactivity". He picked Arc, Drift and Stack to go.
- **Retired** (`songlook.ts` `RETIRED_STYLES`): Arc, Drift and Stack are out of Auto and Settings › Style. `STYLES` is now the ten live styles, most reactive first (Slant, Pop, Cascade, Tape, Spotlight, Wave, Reveal, Collage, Lens, Poster); `ALL_STYLES` keeps all thirteen drawable, so the contract's `Mode`, forced QA looks (`--look`) and plain lyrics still work. Stack stays only as plain lyrics' list. A saved pin of a retired style reads as Auto (`parseStylePin`, now typed `PickStyle`). `DEFAULT_PICK` is Slant at energy 0.62, snap 0.55.
- **Reactivity in the pick**: each live style has a `REACTIVITY` (Pop and Slant 1 … Poster 0.55), added at `REACTIVITY_WEIGHT` 0.5 to its fit score: enough to beat most edges in fit, less than the legibility penalties. The trackKey variety pool is tighter (0.04, was 0.1) and never trades a pick for a style more than 0.2 calmer. Over a 5,760-song synthetic feature grid the kinetic six now take 89% of synced songs, Slant alone 46% (Arc and Stack took ~60% before; Spotlight, Cascade and Tape were never picked).
- **Motion**: synced songs' energy is 0.62–1 (floor 0.55 line-timed, was 0.35–1), about twice BL's amplitude at the least; snap 0.5–1 (was 0.2–1), so words land on the voice instead of floating in. Flair moves lean to bounce, pulse and drop over sway and rise (`MOVE_PUNCH`).
- Demo picks now: Ledger Lines Slant · Bricolage, Strobe Hearts Pop · Unbounded, Glacier Nocturne Spotlight · Instrument Serif, Neon Monsoon Cascade → Slant with its cover, Glass Harbor Spotlight, Script Sampler Slant.
Tests: 1287 vitest in 38 files (new: `pin.test.ts`; the grid asserts every synced song gets a live style at energy ≥ 0.55, that kinetic styles take > 60% and Lens + Poster < 20%, and that a near-tie never swaps a kinetic best for Lens or Poster). Expectations for the old picks updated.
Not verified: on a real Mac, with real songs.
Needs from Codex: nothing new (the `Settings.style` field asked for above should accept only the live styles plus "auto").
Contract: unchanged (v8).


## 2026-10-28 · Claude Code · Reel: one word at a time, with a sign beside it
Done: Maxwell sent an Instagram reel of Verci for Mac ("I want the lyrics to look like this"): one big word in the middle of the screen, the word just sung small above it and the next one small below, each word rolling up with a bounce as it's sung, with small line icons beside the words (a building for "city", an arrow for "left", a play sign for "Started", glasses, a dancer), over a dark cover.
- **Reel**, a tenth style on Lens's engine (`slot-layouts.ts` `REEL_LAYOUT`): the word being sung 2.2 line sizes tall in the middle, the one just sung at line size and half faint above, the next below, nothing else (no next line). Its singing position is its own: `reelAt` steps to each word 80 ms early and the step rolls on a bouncy spring (`REEL_SPRING`), so the word lands in the middle with a little bounce as the voice reaches it; the last word holds the middle to the line's end. `SlotLayout` gained `alone`, `along` and `spring`; `planLens` takes `target` and `spring`. Scored (`songlook.ts`) for mid-tempo R&B, hip-hop and pop with real timing under dark covers, and it is the one one-line style that likes long lines; in the one-line variety window with the rest. Glyph on the Settings card; `?look=reel` and `--look=reel`.
- **Word glyphs** (Graphics, in Reel): `core/wordglyphs.ts` maps about 1,900 words to a hundred signs, `overlay/glyphs.ts` draws them by hand as SVG paths (24 × 24, a round 2 px stroke in the lyric color), and `LensMode` puts a word's glyph in its slot after the word's box, counted in the word's width, so it rolls with the word. A word that becomes a scene carries none. Reel shows no pictures (`DecorParts.pictures: false`, its words aren't in a row); scenes and splashes stay.
- **Dial Tone Avenue** (`?track=10`, `tests/fixtures/demo-dial-tone-avenue.lrc`, original placeholder lyrics): a mid-tempo late-night song full of words that carry a sign, under the cold dark cover, which Undertone draws as Reel in Space Grotesk.
- **Checked** in Chromium with the mock bridge (`?power=full`): Glass Harbor, Paper Lanterns and Dial Tone Avenue in Reel on the dusk and the light wallpapers: the stack reads prev / sung / next, each word rolls in with a bounce, the glyphs sit beside their words ("city" with a building, "Phone" with a phone, "floor" with a dancer, "Started" with a play sign, "driving" with a car) and read on both wallpapers; the line change crossfades the stacks. README gets `docs/media/style-reel.webp`.
Tests: 1282 vitest in 38 files (new: `wordglyphs.test.ts`, the vocabulary once over and matching the reel's lines, the plan, every drawing's path data; Reel's layout, fit, rest, `reelAt` and its planned roll with the spring's overshoot in `slot-layouts.test.ts`; `pictures: false` in `flair.test.ts`; the demo's pick in `demo-looks.test.ts`).
Not verified: on a real Mac or PC.
Needs from Codex: nothing.
Contract: unchanged (v8).


## 2026-10-28 · Claude Code · The Style setting (contract v9)
Done: so the reel's look can be had for every song, not only the ones the picker gives it to: **Style** in Settings › Look, a row of chips (Auto and the ten styles, each with its glyph), saved as `Settings.style` (`"auto"` by default). Any other name draws every song in that style; the font, the curve and the motion stay the song's own.
- `contract.ts` / `contract.rs`: `StyleChoice`, `Settings.style`, v9; settings saved without it read as `"auto"` (serde's default, the mock's `mergeSettings`, the window's `withDefaults`); `merge_patch` validates it like `showWhen`. The tray has no Style menu.
- `overlay/look.ts` `styleChoiceOf` (tolerant: missing, `"auto"` or an unknown name is null) and `withStyleChoice`; the controller puts the chosen style between the song's pick and the QA override, so `?look=` and `--look` still win, reports the look as drawn, and redraws at once when the setting changes. The preview's card says **Your style, the font picked for this song** (`kickerOf`, `CardLook.chosen`).
- Docs: USER_GUIDE (Style), SPEC (v9), ACCEPTANCE §11.6, README.
Tests: 1288 vitest in 38 files (new: the mock's merge and migration of `style`; `styleChoiceOf` and `withStyleChoice`; the panel's chips, their edits, the hint and an older core's missing field; the wiring: the setting draws every song in its style, a forced look outranks it, Auto brings the song's own back at once) and the Rust tests (v9, every name and nothing else, saved before v9 as Auto, 22 keys).
Not verified: on a real Mac or PC.
Needs from Codex: nothing.
Contract: v9 (adds `Settings.style`).


## 2026-10-28 · Claude Code · Undertone 0.4.0: the kinetic styles and Reel together
Done: two lines of work had grown from 0.2.0 in parallel. One (released as 0.3.0) added Slant, Pop, Cascade and Tape, twelve faces, a livelier Auto with Arc, Drift and Stack retired, and a Style picker kept in web storage. The other added Reel with its word signs and the Style setting in the contract (v9). This merges both.
- **Styles**: eleven live ones, most reactive first: Slant, Pop, Reel, Cascade, Tape, Spotlight, Wave, Reveal, Collage, Lens, Poster (`songlook.ts` `STYLES`). `ALL_STYLES` keeps all fourteen drawable for `--look` and the contract's `Mode`. Reel's `REACTIVITY` is 0.85.
- **Reel's score, re-tuned** for the livelier picker, which otherwise gave Reel half of all songs. It now wants real word timing (line timing counts 0.15), hooks that come back, no held notes and a muted cover, and gives way to Pop on shouted chants and to bright acoustic songs. Over the feature grid's 10,800 synced songs Reel takes about a fifth, and every 0.3.0 demo and synthetic pick is unchanged. Dial Tone Avenue is still Reel · Space Grotesk.
- **Style setting**: 0.3.0's tiles (the Style group under the card) now save `Settings.style` instead of web storage. `StyleChoice` names only the styles Settings offers plus `"auto"`, so a stored `"arc"`, `"drift"` or `"stack"` reads as auto in the core (`merge_patch`), the mock and the window (`styleChoiceOf`). 0.4.0's v9 chips in Look are gone. A pin left in web storage by 0.3.0 is moved into the setting once, by the first window to start (`overlay/pin.ts` `migrateStylePin`); an older core that refuses the field just loses it.
- **Signs stay Reel's**: `SlotLayout.alone` is true for Reel only. Slant and Pop hide their next line in `lens.css` as in 0.3.0 and keep their word pictures.
- **Docs**: README grid shows the eleven live styles (new tiles for Slant, Pop, Cascade and Tape; Arc, Drift and Stack removed), USER_GUIDE (eleven styles, Style), SPEC (kinetic type, faces, Auto leaning lively, v9 names), ACCEPTANCE §11, DEVELOPMENT (demo picks, `--look` names). Version 0.4.0.
Tests: 1307 vitest in 39 files (new or changed: the pin migration, Reel among the live styles, only Reel stands alone, `styleChoiceOf` reading retired styles as auto, the Style tiles saving the setting, the bridge and Rust tests taking only the offered names) and 287 Rust tests.
Not verified: on a real Mac or PC.
Needs from Codex: nothing. The `Settings.style` field 0.3.0 asked for is v9.
Contract: v9 (`StyleChoice` lists the offered styles: "auto" | "slant" | "pop" | "reel" | "cascade" | "tape" | "spotlight" | "wave" | "reveal" | "collage" | "lens" | "poster").
