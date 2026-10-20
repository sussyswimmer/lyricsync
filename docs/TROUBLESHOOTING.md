# Troubleshooting

## No lyrics, or the wrong song

- **"No lyrics for this song"** means LRCLIB has nothing that matches. Undertone looks the song up by title, artist, album and length, then the same without the album (a player's album name often differs from LRCLIB's), then searches by title and artist. Songs by several artists match however the credits are written ("A & B", "A, B", "A feat. B", "A x B"). It rejects any result whose length differs from your track by more than 8 seconds, so live versions, remasters and regional releases sometimes miss. Undertone remembers a miss for 7 days so it doesn't keep asking. **Refetch lyrics** asks again right away.
- **"Couldn't load lyrics"** means the lookup failed: no connection, or no answer from LRCLIB within 15 seconds. LRCLIB's search often answers "busy, try again in a second", so Undertone asks it up to four times before giving up. It then tries again by itself after 5, 20 and 60 seconds, and the lyrics appear as soon as one try works. If they don't, check your connection (and your proxy, see [Network](INSTALL.md#network)), then use **Refetch lyrics**.
- **Wrong lyrics:** **Refetch lyrics** skips the cache, which fixes lyrics that were corrected on LRCLIB since Undertone saved them. If LRCLIB's best match is itself wrong, refetching returns the same thing. Lyrics on LRCLIB are submitted by the community; [lrclib.net](https://lrclib.net) explains how to add or correct them.
- **Lyrics but no word highlight, drifting from the singer:** LRCLIB only has unsynced text for this song. Undertone looks for a synced version of the same song (another album or edition) right away and switches to it if it finds one. Without one, it can only guess the pace, by the length of each line and the gaps between verses, so it drifts when the singer speeds up or slows down. The lines around the current one stay easy to read meanwhile (see "Plain (unsynced) lyrics" in the [user guide](USER_GUIDE.md#loading-missing-and-unsynced-lyrics)). When you play the song more than 30 days later, Undertone looks for synced lyrics again; **Refetch lyrics** looks right away. Synced lyrics whose timestamps would keep one line up for most of the song are shown the same way.

## Lyrics are early or late

Positive offsets make lyrics appear **earlier**; negative offsets make them appear **later**.

- **Every song is off by about the same amount** (for example, Bluetooth headphones that delay the sound): move the **All songs** slider in Settings → Sync, the global offset. If lyrics run ahead of the singer, move it toward Later (below 0).
- **One song is off:** nudge just that song with **Sync ▸ Earlier/Later 100 ms** in the menu, ⌥⇧⌘[ / ⌥⇧⌘] (Ctrl+Alt+Shift+[ / ] on Windows, unless you've changed them) for 50 ms steps, or the −100 / −50 / +50 / +100 buttons under **This song** in Settings → Sync. Undertone remembers the nudge for that song. **Reset for this song** in the menu, or **Reset this song** in Settings, clears it.

The song's nudge is added on top of the All songs offset. A song you haven't nudged starts from what your last few nudged songs have in common, so after two or three nudges the same way, new songs start in time on their own. Most songs' lyrics are timed by line only: Undertone then works out when each word is sung, at the pace the song is being sung, so judge the sync by when each line starts. Lyrics timed word by word follow every word exactly.

## Nothing shows up

1. **Is a song playing?** With **When: While playing** (the default, in Settings › Behavior), lyrics hide when you pause and when nothing is playing. Choose **Always** to keep them up while paused.
2. **Are the lyrics turned off?** Then the preview in Settings says **Off on the desktop**. Switch on **Lyrics on the desktop** in Settings › General, choose **Show lyrics** in the menu, or press ⌥⇧⌘L / Ctrl+Alt+Shift+L (the default shortcut).
3. **Is a window covering them?** The lyrics sit under every window, so a maximized or full-screen window hides them. Move windows aside or show the desktop.
4. **Is the player supported?** On macOS, Undertone reads the Spotify app and the Music app only (not players in a web browser). On Windows, the player must show up in the Windows media controls. When Undertone finds no such player open, **This song** in Settings → Sync says **No music app open**.
5. **On macOS, was Automation denied?** Then the settings window shows a notice at the top, such as "Undertone can't see what Spotify is playing.", with the switch to turn on. See [Permissions](INSTALL.md#macos-automation).
6. **On macOS, does Settings play the demo song while Spotify or Music plays, with no notice at the top?** Then macOS hasn't given Undertone an answer yet. It should ask whether Undertone may control the player a few seconds after you open Undertone; click **OK**. If no prompt appears and Undertone isn't listed under System Settings → Privacy & Security → Automation, quit Undertone from the menu, run `tccutil reset AppleEvents com.undertone.desktop` in Terminal, open Undertone again and play a song.
7. **Are they faint?** Check **Opacity** and your colors in Settings, or turn on **Match album colors**.

## Lyrics on the wrong monitor

**Where: Primary display** (the default, in Settings › Behavior) shows lyrics only on your main display: on macOS, the one with the menu bar (set it in System Settings → Displays); on Windows, the one marked "Make this my main display" in Settings → System → Display. Choose **All displays** to show them on every monitor. Each screen scales the lyrics to its own height.

## After an Explorer restart, sleep or a display change

Undertone reattaches the lyrics to the desktop by itself when Windows Explorer restarts, when your computer wakes from sleep, and when displays are connected, removed or rearranged. It also picks up again when Spotify quits and relaunches. If the lyrics don't come back, quit Undertone from the menu and open it again, then report the problem with the diagnostics below.

## A feature is missing after an update

You may still be running the old build. The last line of the menu bar or tray menu, and the bottom of Settings, say which build is running: **Undertone 0.1.0 (build …)**. If it isn't the one you downloaded, quit Undertone from the menu and open it again from Applications (or the Start menu). Opening the new app while an old one runs restarts Undertone into the new one.

## Settings went back to the defaults

Undertone keeps your settings, including each song's sync nudge, in `settings.json` in its data folder: `~/Library/Application Support/com.undertone.desktop` on macOS, `%APPDATA%\com.undertone.desktop` on Windows. It saves the file in one step, so a crash can't leave half a file. If the file still can't be read, Undertone renames it to `settings.corrupt-<number>.json` in the same folder, starts from the defaults and opens the settings window. Cached lyrics are kept.

## Reporting a bug

Run Undertone with `--diagnose`. It reports what Undertone sees right now: the media sources it found and which one it picked, the current track, the LRCLIB match with its length difference, your settings with the login item as your system keeps it, the lyrics cache, your displays and the desktop-layer window handles. It never includes lyric text, and it works while Undertone is running. The report is also saved to your temp folder as `undertone-diagnose-<date>-<time>.txt`, with the path on its last line. Attach that file to your bug report.

- **macOS** (Terminal): `open -n -a Undertone --args --diagnose`. The report opens in TextEdit. Running `/Applications/Undertone.app/Contents/MacOS/undertone --diagnose` prints it in Terminal instead, but then macOS checks Terminal's Automation permission rather than Undertone's, so the Automation lines may not match what the app sees.
- **Windows** (PowerShell): find the folder with `undertone.exe` (right-click Undertone in the Start menu and choose **Open file location**; if that opens a folder of shortcuts, do it again on the Undertone shortcut), open PowerShell there and run `.\undertone.exe --diagnose | Out-Host`, so PowerShell waits for the report. In Command Prompt, use `undertone.exe --diagnose | more`. Started from a shortcut, the report opens in your default text editor.

Undertone also keeps a log of what went wrong while it ran, such as a lyrics lookup that failed or a shortcut it couldn't register. It may name songs, but never holds lyric text. `--diagnose` ends with its last 60 lines under **Recent log**; if you can, attach the whole file too:

- **macOS:** `~/Library/Logs/com.undertone.desktop/undertone.log`
- **Windows:** `%LOCALAPPDATA%\com.undertone.desktop\logs\undertone.log`

When the log reaches 512 KB it moves to `undertone.1.log` next to it, replacing the one before.
