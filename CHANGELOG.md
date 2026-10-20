# Changelog

All notable changes to Undertone are listed here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-20

The first release. The builds aren't code-signed yet; [docs/INSTALL.md](docs/INSTALL.md) shows how to open them.

### Added

- **Synced lyrics on the desktop.** Undertone shows the lyrics of the song you're playing between the wallpaper and your icons. Windows sit on top, clicks go straight through, and it lives in the menu bar on macOS and the system tray on Windows, with no Dock icon. ([#1](https://github.com/sussyswimmer/lyricsync/pull/1))
- **Players.** Spotify on macOS 14+ and Windows 10/11, and the Music app (Apple Music) on macOS. On Windows, other players that show up in the media controls work too. Undertone only reads what's playing; it never controls the player. ([#1](https://github.com/sussyswimmer/lyricsync/pull/1))
- **Lyrics from LRCLIB.** Looked up by title, artist, album and length, with a search as a fallback, cached on your computer, and retried by themselves when a lookup fails. No account and no API key. ([#1](https://github.com/sussyswimmer/lyricsync/pull/1))
- **Word-by-word highlight.** Lyrics timed word by word are followed exactly; for line-timed lyrics, each word is estimated from its syllables. Unsynced lyrics are paced evenly in a calmer style. ([#1](https://github.com/sussyswimmer/lyricsync/pull/1))
- **Four styles and album colors.** Arc, Lens, Drift and Stack, seven bundled fonts, and colors picked from the album art and tuned to stay readable on any wallpaper, or your own. ([#1](https://github.com/sussyswimmer/lyricsync/pull/1))
- **Sync controls.** An offset for all songs and a remembered nudge for each song, from Settings, the menu or a global shortcut. ([#1](https://github.com/sussyswimmer/lyricsync/pull/1))
- **Settings window** with a live preview of the current song, light and dark modes, launch at login and recordable shortcuts. ([#1](https://github.com/sussyswimmer/lyricsync/pull/1))
- **Installers.** An unsigned universal `.dmg` for macOS and an NSIS `-setup.exe` for Windows, built by CI on every push and attached to a draft release for every `v*` tag. ([#1](https://github.com/sussyswimmer/lyricsync/pull/1))
- **`--diagnose`,** a report of what Undertone sees (players, the current song, the lyrics match, settings and displays, never lyric text) to attach to bug reports. ([#1](https://github.com/sussyswimmer/lyricsync/pull/1))
- **For contributors:**
  - A README with a banner, screenshots and a demo of the real renderer, plus [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).
  - A contributing guide, security policy, code of conduct, issue forms and a pull request template.
  - The MIT license.

[Unreleased]: https://github.com/sussyswimmer/lyricsync/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sussyswimmer/lyricsync/releases/tag/v0.1.0
