# Changelog

All notable changes to Undertone are listed here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-20

Karaoke mode, Effects mode off until you turn it on, and the repository's license and documentation.

### Added

- **Karaoke mode.** A dot in the highlight color bounces along the line, landing on each word right as it's sung, in every style. Turn it on in **Settings › Look**; it's off by default. Under reduced motion it moves from word to word without bouncing.

- **The MIT license.** ([#3](https://github.com/sussyswimmer/lyricsync/pull/3))
- **A README laid out like a product page:** download buttons, features, the six styles, the settings window, install, how it works, privacy, an FAQ and a roadmap. ([#3](https://github.com/sussyswimmer/lyricsync/pull/3))
- **For contributors:** a contributing guide, a security policy, a code of conduct, issue forms (bug report, feature request, private contact) and a pull request template. ([#3](https://github.com/sussyswimmer/lyricsync/pull/3))
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) links its bug-report steps to the bug report form.

### Changed

- **Effects mode is off by default.** Each song's own motion, its splashes and the word pictures wait until you turn Effects mode on. Settings from 0.1.0, when it was on by default, start with it off once; turn it back on and it stays on.

## [0.1.0] - 2026-10-20

The first release. The builds aren't code-signed yet; [docs/INSTALL.md](docs/INSTALL.md) shows how to open them.

### Added

- **Synced lyrics on the desktop.** Undertone shows the lyrics of the song you're playing between the wallpaper and your icons. Windows sit on top, clicks go straight through, and it lives in the menu bar on macOS and the system tray on Windows, with no Dock icon.
- **Players.** Spotify on macOS 14+ and Windows 10/11, and the Music app (Apple Music) on macOS. On Windows, other players that show up in the media controls work too. Undertone only reads what's playing; it never controls the player.
- **Lyrics from LRCLIB.** Looked up by title, artist, album and length, with a search as a fallback, cached on your computer, and retried by themselves when a lookup fails. No account and no API key.
- **Word by word.** Each word fills with the highlight syllable by syllable as it's sung, in a gradient of the cover's own colors. Lyrics timed by line are timed word by word at the song's own pace, and a held note keeps its word lit, letter by letter.
- **A look for every song.** Six styles (Arc, Lens, Drift, Stack, Poster and Spotlight) and eight fonts, picked from how the song is sung, and colors from its cover. The same song always gets the same look.
- **Word pictures.** 140 pictures join the song as their words are sung, and each song gets its own motion and splashes at its big moments. **Effects mode** turns them off.
- **Sync controls.** An offset for all songs and a remembered nudge for each song, from Settings, the menu or a global shortcut. A song you haven't nudged starts from what your last nudged songs have in common.
- **Settings window** with a live preview of the current song and a card naming the look picked for it, light and dark modes, launch at login and recordable shortcuts.
- **Installers.** An unsigned universal `Undertone_universal.dmg` for macOS and an NSIS `Undertone_x64-setup.exe` for Windows. Opening a newly installed version while an old one runs restarts Undertone into the new one.
- **`--diagnose`,** a report of what Undertone sees (players, the current song, the lyrics match, settings and displays, never lyric text) to attach to bug reports.

[Unreleased]: https://github.com/sussyswimmer/lyricsync/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/sussyswimmer/lyricsync/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sussyswimmer/lyricsync/releases/tag/v0.1.0
