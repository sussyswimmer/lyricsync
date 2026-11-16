# Security policy

Thanks for helping keep Undertone and the people who run it safe.

## Supported versions

Security fixes go into the next release, and only the latest release is supported. Undertone doesn't update itself, so install the new version over the old one when a fix is out ([docs/INSTALL.md](docs/INSTALL.md#updating) shows how; your settings are kept).

| Version | Supported |
|---|---|
| Latest release | Yes |
| Older releases | No. Please update to the latest release first. |
| Builds from `main` and CI test builds | Best effort. Reports are welcome. |

## Reporting a vulnerability

**Please don't report security problems in a public issue, discussion or pull request.** Report them privately through GitHub instead:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**, or go straight to the [private report form](https://github.com/sussyswimmer/lyricsync/security/advisories/new).
3. Describe the problem: the Undertone version (the first line of a `--diagnose` report, or the version in the file you downloaded), your OS and its version, the steps or a proof of concept, and what an attacker could do with it.

Only you and the maintainers can see the report. If you don't see the **Report a vulnerability** button, or the form doesn't open, [ask for a private contact](https://github.com/sussyswimmer/lyricsync/issues/new?template=private_contact.yml) instead. That issue is public, so leave out every detail, and the maintainer will set up a private channel with you.

What happens next:

- The maintainer confirms the report and works with you on the details in the private report.
- Once a fix is ready, it ships in a new release, and a GitHub security advisory is published alongside it. You're credited in the advisory unless you'd rather not be.
- Please keep the details private until that release is out.

Undertone has a single maintainer, so a reply can take a few days.

## Scope

Undertone is a menu bar and tray app that shows the lyrics of the song you're playing on your desktop. By design:

- It only reads what's playing: from Spotify and Music through Apple Events on macOS, and from the system media session on Windows. It never plays, pauses or skips anything, and never launches a player.
- Its only network requests are the lyrics lookup on `lrclib.net` (title, artist, album and length) and, for Spotify on macOS, the cover art from Spotify's image server. There's no telemetry or analytics, and no update check.
- Lyrics are cached on your computer. The log and `--diagnose` reports never contain lyric text.
- The lyrics window ignores the mouse: clicks go through to the desktop.

**In scope:**

- Anything that breaks one of the promises above, for example Undertone sending data anywhere else, sending more than the song's details, or controlling a player.
- Code execution or privilege escalation through Undertone or its installers (the `.dmg` and the `-setup.exe`).
- Crafted lyrics from LRCLIB, or crafted track info or cover art (any app can publish these to the Windows media controls), that make Undertone run code, read or write files it shouldn't, or crash in a way that looks exploitable.
- A crafted `settings.json` or lyrics cache entry that does the same.
- Another user account on the same computer controlling your copy of Undertone, for example through its single-instance channel.
- The build and release pipeline in this repository: GitHub Actions workflows and scripts, for example a pull request that can read secrets or change a published release.

**Out of scope:**

- Bugs in macOS, Windows, WebView2, WebKit, Tauri or the libraries Undertone uses. Please report those to their maintainers. If Undertone ships a version with a known vulnerability, that *is* in scope.
- Attacks that need administrator rights, or that already control your user account (for example, replacing Undertone's files or editing its settings as you).
- The warnings macOS and Windows show when you first open Undertone. Its builds aren't code-signed yet; [docs/INSTALL.md](docs/INSTALL.md) shows how to open them.
- Wrong or offensive lyrics. They come from LRCLIB's community database, and [lrclib.net](https://lrclib.net) explains how to correct them.
- Crashes, visual glitches and high CPU use with no security impact. Those are regular bugs: please use the [bug report form](https://github.com/sussyswimmer/lyricsync/issues/new?template=bug_report.yml).
