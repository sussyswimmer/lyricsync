# Troubleshooting

Find what you're seeing below. If it isn't here, or the fix doesn't help, [report a bug](#reporting-a-bug) with the diagnostics it describes.

- [No lyrics, or the wrong song](#no-lyrics-or-the-wrong-song)
- [Lyrics are early or late](#lyrics-are-early-or-late)
- [Nothing shows up](#nothing-shows-up)
- [Lyrics on the wrong monitor](#lyrics-on-the-wrong-monitor)
- [After an Explorer restart, sleep or a display change](#after-an-explorer-restart-sleep-or-a-display-change)
- [Settings went back to the defaults](#settings-went-back-to-the-defaults)
- [Network and proxies](#network-and-proxies)
- [Reporting a bug](#reporting-a-bug)

## No lyrics, or the wrong song

- **"No lyrics for this song"** means LRCLIB has nothing that matches. Undertone looks the song up by title, artist, album and length, then falls back to a search by title and artist. Songs by several artists match however the credits are written ("A & B", "A, B", "A feat. B", "A x B"). It rejects any result whose length differs from your track by more than 8 seconds, so live versions, remasters and regional releases sometimes miss. Undertone remembers a miss for 7 days so it doesn't keep asking. **Refetch lyrics** asks again right away.
- **"Couldn't load lyrics"** means the lookup failed: no connection, or LRCLIB didn't answer within 6 seconds. Undertone tries again by itself after 5, 20 and 60 seconds, and the lyrics appear as soon as one try works. If they don't, check your connection (and your proxy, see [Network and proxies](#network-and-proxies)), then use **Refetch lyrics**.
- **Wrong lyrics:** **Refetch lyrics** skips the cache, which fixes lyrics that were corrected on LRCLIB since Undertone saved them. If LRCLIB's best match is itself wrong, refetching returns the same thing. Lyrics on LRCLIB are submitted by the community; [lrclib.net](https://lrclib.net) explains how to add or correct them.
- **Lyrics but no word highlight:** LRCLIB only has unsynced text for this song. Undertone paces the lines evenly across the song instead (see "Plain (unsynced) lyrics" in the [user guide](USER_GUIDE.md#loading-missing-and-unsynced-lyrics)). When you play the song more than 30 days after Undertone saved them, it checks LRCLIB for synced lyrics again; **Refetch lyrics** checks right away. Synced lyrics whose timestamps would keep one line up for most of the song are paced the same way.

## Lyrics are early or late

Positive offsets make lyrics appear **earlier**; negative offsets make them appear **later**.

- **Every song is off by about the same amount** (for example, Bluetooth headphones that delay the sound): move the **All songs** slider in Settings → Sync, the global offset. If lyrics run ahead of the singer, move it toward Later (below 0).
- **One song is off:** nudge just that song with **Sync ▸ Earlier/Later 100 ms** in the menu, ⌥⇧⌘[ / ⌥⇧⌘] (Ctrl+Alt+Shift+[ / ] on Windows, unless you've changed them) for 50 ms steps, or the −100 / −50 / +50 / +100 buttons under **This song** in Settings → Sync. Undertone remembers the nudge for that song. **Reset for this song** in the menu, or **Reset this song** in Settings, clears it.

The song's nudge is added on top of the All songs offset. When a song's lyrics are timed by line only, Undertone estimates where each word falls, so judge the sync by when each line starts.

## Nothing shows up

1. **Is a song playing?** With **When: While playing** (the default, in Settings › Behavior), lyrics hide when you pause and when nothing is playing. Choose **Always** to keep them up while paused.
2. **Are the lyrics turned off?** Then the preview in Settings says **Off on the desktop**. Switch on **Lyrics on the desktop** in Settings › General, choose **Show lyrics** in the menu, or press ⌥⇧⌘L / Ctrl+Alt+Shift+L (the default shortcut).
3. **Is a window covering them?** The lyrics sit under every window, so a maximized or full-screen window hides them. Move windows aside or show the desktop.
4. **Is the player supported?** On macOS, Undertone reads the Spotify app and the Music app only (not players in a web browser). On Windows, the player must show up in the Windows media controls. When Undertone finds no such player open, **This song** in Settings → Sync says **No music app open**.
5. **On macOS, was Automation denied?** Then the settings window shows a notice at the top, such as "Undertone can't see what Spotify is playing.", with the switch to turn on. See [macOS: Automation](../README.md#macos-automation) in the README.
6. **Are they faint?** Check **Opacity** and your colors in Settings, or turn on **Match album colors**.

## Lyrics on the wrong monitor

**Where: Primary display** (the default, in Settings › Behavior) shows lyrics only on your main display: on macOS, the one with the menu bar (set it in System Settings → Displays); on Windows, the one marked "Make this my main display" in Settings → System → Display. Choose **All displays** to show them on every monitor. Each screen scales the lyrics to its own height.

## After an Explorer restart, sleep or a display change

Undertone reattaches the lyrics to the desktop by itself when Windows Explorer restarts, when your computer wakes from sleep, and when displays are connected, removed or rearranged. It also picks up again when Spotify quits and relaunches. If the lyrics don't come back, quit Undertone from the menu and open it again, then report the problem with the diagnostics below.

## Settings went back to the defaults

Undertone keeps your settings, including each song's sync nudge, in `settings.json` in its data folder: `~/Library/Application Support/com.undertone.desktop` on macOS, `%APPDATA%\com.undertone.desktop` on Windows. It saves the file in one step, so a crash can't leave half a file. If the file still can't be read, Undertone renames it to `settings.corrupt-<number>.json` in the same folder, starts from the defaults and opens the settings window. Cached lyrics are kept.

## Network and proxies

Undertone sends the title, artist, album and length of the current song to `lrclib.net` to look up lyrics. For Spotify on macOS, it also downloads the cover art from Spotify's image server. Lyrics are cached on your computer so the same song loads instantly next time.

If you set a proxy by hand in your system's network settings, Undertone uses it. A proxy set up automatically (a PAC script or WPAD) isn't supported.

## Reporting a bug

Run Undertone with `--diagnose`. It reports what Undertone sees right now: the media sources it found and which one it picked, the current track, the LRCLIB match with its length difference, your settings with the login item as your system keeps it, the lyrics cache, your displays and the desktop-layer window handles. It never includes lyric text, and it works while Undertone is running. The report is also saved to your temp folder as `undertone-diagnose-<date>-<time>.txt`, with the path on its last line. Attach that file to your [bug report](https://github.com/sussyswimmer/lyricsync/issues/new?template=bug_report.yml).

- **macOS** (Terminal): `open -n -a Undertone --args --diagnose`. The report opens in TextEdit. Running `/Applications/Undertone.app/Contents/MacOS/undertone --diagnose` prints it in Terminal instead, but then macOS checks Terminal's Automation permission rather than Undertone's, so the Automation lines may not match what the app sees.
- **Windows** (PowerShell): find the folder with `undertone.exe` (right-click Undertone in the Start menu and choose **Open file location**; if that opens a folder of shortcuts, do it again on the Undertone shortcut), open PowerShell there and run `.\undertone.exe --diagnose | Out-Host`, so PowerShell waits for the report. In Command Prompt, use `undertone.exe --diagnose | more`. Started from a shortcut, the report opens in your default text editor.

Undertone also keeps a log of what went wrong while it ran, such as a lyrics lookup that failed or a shortcut it couldn't register. It may name songs, but never holds lyric text. `--diagnose` ends with its last 60 lines under **Recent log**; if you can, attach the whole file too:

- **macOS:** `~/Library/Logs/com.undertone.desktop/undertone.log`
- **Windows:** `%LOCALAPPDATA%\com.undertone.desktop\logs\undertone.log`

When the log reaches 512 KB it moves to `undertone.1.log` next to it, replacing the one before.
