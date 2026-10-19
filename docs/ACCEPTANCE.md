# Native acceptance

The checks that only a real Mac and a real Windows PC can do, beyond the lists in [DESKTOP_LAYER.md](DESKTOP_LAYER.md#required-native-acceptance), [NOW_PLAYING.md](NOW_PLAYING.md#native-acceptance-still-required) and [LYRICS.md](LYRICS.md#native-acceptance). This page covers contract v3 (shortcuts, launch at login, lyrics on and off), contract v4 (Effects, and the look Undertone picks for each song), the Definition of done's CPU budget, ±150 ms sync and 1 s lyrics latency, the checks the 2026-10-15 fixes need, and the v4 motion on WebKit and WebView2. Log what you find in [HANDOFF.md](HANDOFF.md), and tick a Definition of done box in [SPEC.md](../SPEC.md#definition-of-done-v1) only after its check passes on both OSes.

Run on macOS 14 (the minimum) and the current release, and on Windows 10 and 11.

## Before you start

- **Two kinds of build.** The debug flags work only in a dev build: `pnpm tauri dev -- -- --media-test` (the second `--` hands the flag to the app). First launch, launch at login, the log file and the CPU budget need the installed app: a CI test build, as [INSTALL.md](INSTALL.md#download) explains.
- **Where Undertone keeps things.**

  | | macOS | Windows |
  |---|---|---|
  | Settings (`settings.json`) and the lyrics cache (`lyrics/`) | `~/Library/Application Support/com.undertone.desktop` | `%APPDATA%\com.undertone.desktop` |
  | Log (`undertone.log`) | `~/Library/Logs/com.undertone.desktop` | `%LOCALAPPDATA%\com.undertone.desktop\logs` |
  | Login item | `~/Library/LaunchAgents/Undertone.plist` | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `Undertone` |

- **A fresh start.** Quit Undertone from its menu, then move `settings.json` out of the settings folder. Delete the `lyrics` folder next to it to empty the lyrics cache.

## 1. First launch and the settings file

Both OSes, with the installed app:

1. With no `settings.json`, start Undertone (on macOS, after the first-open steps in INSTALL.md). The settings window opens and comes to the front. On macOS there is still no Dock icon.
2. Quit and start it again: no window opens, only the menu bar or tray icon.
3. If you have a `settings.json` from an earlier build (from before 2026-10-15, when tauri-plugin-store wrote it), put it back and start Undertone: every setting is as it was, and the file's modification time doesn't change until you change a setting.
4. Quit, open `settings.json` in a text editor and delete its last `}`. Start Undertone: the file is now `settings.corrupt-<number>.json`, a new `settings.json` holds the defaults, Settings opens, and the log has a line `settings file unusable (…); moved to …`.
5. Windows only: open `settings.json` in an editor that keeps it open, then change a setting in Undertone. The change is saved, or the log says why it couldn't be.

## 2. The log and `--diagnose`

Both OSes, with the installed app:

1. Start Undertone from Finder or the Start menu. The log file exists where the table above says, and its last line reads like `Undertone 0.1.0 started (macos aarch64, release build)`.
2. Turn on **Launch at login**, log out and back in: a second `started` line appears.
3. Play a few songs, including one LRCLIB doesn't have, and search the log for a line of their lyrics: it isn't there.
4. Run `--diagnose` as the README's [Reporting a bug](../README.md#reporting-a-bug) says. The report ends with **Recent log**: the log's path and its last lines.
5. macOS: quit Spotify, start it again and run `--diagnose` right away. Under **Media sources**, Spotify's line says `running; still launching, not read` (or, if Spotify finished starting first, what it plays), never `read failed: did not answer within 2 s`.

## 3. Shortcuts

### macOS

1. On a fresh start, no row under **Settings › Shortcuts** shows a warning, and `--diagnose` lists each binding.
2. Close Settings. Press ⌥⇧⌘L: the lyrics hide. With **Where: All displays** and two displays, they hide on both. Quit and start Undertone: they stay off, and the menu says **Show lyrics**. Press ⌥⇧⌘L again: they come back.
3. Play a song and press ⌥⇧⌘] twice: **This song** in Settings shows +100 ms, and the menu's **Sync ▸ Reset for this song** says "(100 ms earlier)". ⌥⇧⌘[ moves it back.
4. Give ⌥⇧⌘L to another hotkey app (Raycast, Alfred or a Shortcuts keyboard shortcut) and start Undertone. Settings shows no warning, as the user guide says; note which app gets the keys.
5. Click the **Show or hide lyrics** shortcut and press ⌥⇧⌘L: it is recorded, and the lyrics don't hide.
6. Click a shortcut and wait: after 25 s the row stops listening, and ⌥⇧⌘L works again.
7. Click a shortcut, then close Settings; again, minimize it; again, switch to another app. Each time ⌥⇧⌘L works again at once.
8. Rust's own 30 s limit, for a Settings page that stops answering while it listens. Find the PID of Undertone's Web Content process in Activity Monitor and run `sleep 10; kill -STOP <pid>` in Terminal (do this for each one if there are several). Within those 10 s, click a shortcut in Settings, then leave the window alone. Within 30 s ⌥⇧⌘L works again, and the log says `shortcuts: suspended for too long; registering them again`. Resume the process with `kill -CONT <pid>`.
9. Click a shortcut and press ⌘H, then ⌘M: each is turned down with a note ("hides apps", "minimizes windows"). If Settings hides or minimizes instead, the app menu takes those keys first: note it.

### Windows

1. On a fresh start, no row shows a warning, and `--diagnose` lists each binding.
2. As macOS steps 2 and 3, with Ctrl+Alt+Shift+L, Ctrl+Alt+Shift+] and Ctrl+Alt+Shift+[.
3. Start an AutoHotkey script with `^!+l::return`, then start Undertone: the **Show or hide lyrics** row says **Another app is using this combination.** Record another combination: the warning goes.
4. As macOS steps 5 to 8. For step 8, Undertone's page processes are the `msedgewebview2.exe` entries under Undertone in Task Manager; suspend them with `Start-Sleep 10; pssuspend <pid>` (Sysinternals PsSuspend) in PowerShell, and resume them with `pssuspend -r <pid>`.
5. Switch to a German keyboard layout and bring Settings to the front: both nudge rows say **On this keyboard layout, this shortcut may use another key. Record a new one.**, and the toggle row doesn't. Switch back to US English and return to Settings: the warnings go. A Russian layout shows none.
6. In Settings, press F5, Ctrl+R, Ctrl+P and Ctrl+F, and right-click: nothing reloads, prints or opens a find bar, and no browser menu appears.

## 4. Launch at login

### macOS

1. Turn on **Launch at login** in Settings. `~/Library/LaunchAgents/Undertone.plist` exists, and **System Settings › General › Login Items & Extensions** (just **Login Items** on macOS 14) lists Undertone under **Allow in the Background**, switched on. Log out and back in: Undertone starts without a window.
2. Turn Undertone off under **Allow in the Background**. Open Settings, or point at the menu bar icon: the switch and the menu item show off.
3. With it still off there, turn the switch on. It snaps back, the note "Couldn't change Undertone's login item. Try again, or check Login Items in System Settings › General." appears, and System Settings opens at Login Items. Allow Undertone there, then open Settings again: the switch is on.
4. Turn it off, turn it on again, and point at the menu bar icon right away: the switch stays on (a plist macOS hasn't seen yet doesn't count as off).
5. Run `chmod a-w ~/Library/LaunchAgents`, remove the plist first if it's there, and turn the switch on: it snaps back with the note. Undo with `chmod u+w ~/Library/LaunchAgents`.
6. Turn it off from the menu: the plist is gone.
7. Turn it on, quit Undertone, move `Undertone.app` from Applications to another folder (`~/Applications`, say) and open it there. `plutil -p ~/Library/LaunchAgents/Undertone.plist` shows the new path under `ProgramArguments`, the log has a line `launch at login: the login item started …; it now starts …`, and macOS may announce the background item once. Quit and open it again: no new log line, no new notice. Log out and back in: Undertone starts. Move it back to Applications and open it there to undo.
8. With the switch on, quit Undertone, mount the `.dmg` and open Undertone from the disk image. The plist keeps its path, and the log says `… left as is while this one runs from a mounted disk image` (or `an App Translocation path`, where macOS runs a downloaded copy that was never moved). Quit it and eject the disk image.
9. Run `--diagnose`. Under **Settings**, `login item:` names the plist, `starts` its path and `System Settings: Enabled`. After step 2 it says `Requires approval`; after step 6, `none`.

### Windows

1. Turn on **Launch at login** in Settings. The Run key has a value `Undertone` with the path of `undertone.exe`. Sign out and back in: Undertone starts without a window.
2. Turn Undertone off in **Settings › Apps › Startup** (or Task Manager's **Startup apps**). Open Settings, or point at the tray icon: the switch and the menu item show off.
3. Turn it off from the tray menu: the Run value is gone.
4. Turn it on and quit Undertone. Copy `undertone.exe` to another folder and start the copy: the Run value now holds the copy's path, and the log has a line `launch at login: the login item started …; it now starts …`. Start it again: no new line. Quit, then start the installed Undertone: the value points back at it.
5. With the switch on, put `undertone.exe` in a zip, open the zip in Explorer and double-click the exe there, so it runs from the temp folder. The Run value keeps its path, and the log says `… left as is while this one runs from the temp folder`.
6. Run `--diagnose`. Under **Settings**, `login item:` names `HKCU\…\Run › Undertone`, `starts` the path of `undertone.exe` and `Task Manager: enabled`. After step 2 it says `disabled`; after step 3, `none`.

## 5. Lyrics off, and the desktop layer after this session's fixes

[DESKTOP_LAYER.md](DESKTOP_LAYER.md#required-native-acceptance) has the full steps; these are the ones to repeat.

### macOS

1. With **Where: All displays**, switch off **Lyrics on the desktop**: every overlay hides, and the preview says **Off on the desktop**. Restart Undertone: still off.
2. With lyrics showing, press ⌘H in Settings, then ⌥⌘H (**Hide Others**) in Finder. The lyrics stay up both times; Settings hides.
3. The lyrics sit below the menu bar and the notch and clear of the Dock. At **Height** 0% the current line sits a little below the menu bar, never under it; at 100%, a little above a bottom Dock. Move the Dock to the left, resize it, and turn its auto-hide on and off: within about a second the overlay re-frames.
4. **Size** still counts the whole screen: with **Where: All displays**, a line at the same Size takes the same share of the height on the display with the Dock and on one without it.
5. The settings window's green button is disabled, so it can't go full screen.

### Windows

1. As macOS step 1.
2. `pnpm tauri dev -- -- --desktop-layer-test` logs `layered yes` for every overlay, there is no `SetLayeredWindowAttributes` error, and the overlay background is fully transparent. This depends on the Windows 8 to 11 entries in `windows.manifest`.
3. The lyrics stop at the taskbar. Move the taskbar to the top and to a side, make it taller, and turn on auto-hide: within about a second the overlay re-frames.
4. As macOS step 4, with the taskbar.
5. The settings window has no maximize button and stops widening at 560 px. While it's open it has a taskbar button; once closed, it has none.

On both OSes, in a dev build, open the developer tools of the overlay and of Settings (F12 on Windows; Safari's **Develop** menu on a Mac). The consoles show no "not allowed" errors: the pages may only listen to events, and lyrics, playback and settings changes still arrive.

## 6. Now playing, artwork and lyrics after this session's fixes

1. Both OSes, with `--media-test`: a photo cover's `now-playing` line shows `artworkBytes` of roughly 10,000 or less (it was about 200,000). The cover in Settings and the album colors look as before, for Spotify and, on a Mac, Music.
2. Windows: with Spotify playing, play and pause a video in a browser tab. The cover in Settings doesn't blink, and no `now-playing` line shows `"artworkBytes":null` for the Spotify song.
3. macOS: quit Spotify and start it again while `--media-test` runs. No "Spotify did not answer within 2 s" line appears, and the song shows once Spotify has finished launching.
4. Both OSes: play a song that isn't cached, turn the network off, and skip to another uncached song: "Couldn't load lyrics" shows. Turn the network back on within a minute: the lyrics appear by themselves, with no loading dots first. The log has `lyrics lookup failed` lines, and `--media-test` shows `status=Found source=Lrclib` with no `Loading` before it.
5. Both OSes: sleep the computer while an uncached song plays and wake it. If the player resumes before the network is back, the lyrics still appear within about a minute and a half.
6. Both OSes: set a proxy by hand (macOS: **System Settings › Network ›** your network **› Details › Proxies**, Secure web proxy; Windows: **Settings › Network & internet › Proxy › Manual proxy setup**) pointing at a forwarding proxy such as Squid or tinyproxy. Lookups work, and the proxy's log shows `CONNECT lrclib.net:443`. Point it at a port where nothing listens: lookups fail with "Couldn't load lyrics", which shows the proxy is used. On a Mac, Spotify's cover art goes through it too.

## 7. CPU (Definition of done)

The budget is 3% of the whole machine while playing, on a mid-range laptop (for example an M1 MacBook Air, or a four-core Intel Core i5 or Ryzen 5 laptop), with the installed app.

1. Count Undertone and its web content processes together. On macOS, Activity Monitor's **% CPU** is per core, so divide the sum by the number of logical cores (`sysctl -n hw.logicalcpu`); count Undertone's WebKit processes too (Web Content and GPU; Activity Monitor may list them as `Undertone Web Content` or as `com.apple.WebKit.WebContent`). On Windows, Task Manager's **Processes** tab already shows a share of the whole machine; expand Undertone to include its `msedgewebview2.exe` processes.
2. Undertone picks the style for each song, so force each one with `--look` (the README's [Development](../README.md#development) section shows how to start the app with it): quit Undertone, start it with `--look=arc`, play a song with word-timed lyrics (LRCLIB marks them as enhanced; most popular songs have line timing only, which works too) and leave it on for 60 s with Settings closed. Note the average. Do the same with `--look=lens`, `--look=drift` and `--look=stack`, first at **Effects** 50 and then at 100. Every average stays under 3%.
3. Repeat the busiest style from step 2 on a 120 Hz or ProMotion display if you have one. The motion runs on the compositor there, at the display's rate; the total should stay close to the 60 Hz one.
4. Pause the song, switch off **Lyrics on the desktop**, and quit the player: each time the total drops to about 0% within a few seconds.
5. Start Undertone without `--look` and play a few songs: the averages stay under 3% with the looks it picks.

## 8. Sync within ±150 ms (Definition of done)

1. Play a song you know well with **All songs** and **This song** at 0, on wired speakers or headphones (Bluetooth adds its own delay).
2. Film the screen and listen with a phone at 60 fps or more, or make a screen recording with the system sound. For ten lines spread over the song, compare the frame where the line's first word lights with the frame where you hear it. Judge by line starts: inside a line, words are estimated unless the lyrics time every word.
3. Every line is within ±150 ms. Then seek, pause and resume, and check three more lines.
4. Repeat on Spotify on both OSes and on Music on a Mac.

## 9. Lyrics within 1 s of a track change (Definition of done)

1. Empty the lyrics cache (see [Before you start](#before-you-start)) and start Undertone.
2. Record the screen at 60 fps. Skip to a song LRCLIB has: the time from the player showing the new song to the first lyric line on the desktop is under 1 s. The loading dots appear only after 0.6 s, so a fast lookup shows none.
3. Skip back to that song: its lyrics show at once, from the cache.
4. To see where the time goes, add a timestamp to every log line in a dev build: on macOS `pnpm tauri dev -- -- --media-test 2>&1 | ts '%.s'` (`ts` is in moreutils), in PowerShell `pnpm tauri dev -- -- --media-test 2>&1 | ForEach-Object { "$(Get-Date -Format HH:mm:ss.fff) $_" }`. Measure from the `now-playing` line with `"trackChanged":true` to `lyrics: status=Found`.

## 10. Motion on WebKit and WebView2 (v4)

The new motion was checked in Chromium with software compositing only. These need real machines with a GPU, on both OSes, with the installed app:

1. Play a song with word-timed lyrics under each style (`--look=…`, as in section 7). Each word fills with the highlight color from left to right behind a soft edge, rises and swells a little as it's sung, and its letters hop one after another. A word held for about a second or more lights and lifts letter by letter, with its glow building. A glow in the highlight color follows the sung word; at **Glow** 0 it is faint but still there, and at 100 it is strongest.
2. Watch a dozen line changes: the list (Stack, Drift), the next line (Lens) or the curve (Arc) moves just before the line starts, with a soft overshoot. Nothing freezes, stutters or flashes at the change, and the line that leaves fades back to plain text.
3. Find a song with an intro or a break of a few seconds: three dots appear, fill one after another and breathe, then swell and pop just before the next line.
4. Seek back a few seconds within a line, seek a few lines either way, pause and resume: the lit words always match the song, and a paused frame doesn't move.
5. Turn **Effects** to Calm (0) and to Lively (100): at 0 words only light up, with no rising or hopping; at 100 they move about twice as much as at 50. Turn on the system's reduced-motion setting (macOS: **Accessibility › Display › Reduce motion**; Windows: **Accessibility › Visual effects › Animation effects** off): words fade in instead of moving, and line changes crossfade.
6. On a light wallpaper and a dark one, every style stays readable, with no hard-edged dark boxes around words.
7. **The lite tier.** In a dev build, open the overlay's developer tools (section 5) and evaluate `document.documentElement.dataset.power`: it reads `full` on a machine with a working GPU. In a virtual machine or over Remote Desktop it reads `lite`, and words fade in without moving while the line changes still glide.
8. **Letters that draw past their box.** Play an English song with `--look=stack,Caveat`, then with `--look=arc,Caveat` and `--look=lens,Caveat`. While each word lights and after it's lit, every stroke stays whole: the crossbars of t and f, the tops of d and l, and the end of each word's last letter, with no straight cut edge and no white sliver beside a letter. A sung word is lit to the tip of its last letter. Then play a Vietnamese song: its tone marks stay whole in whatever face Undertone picks.

## 11. The look picked for each song (v4)

Both OSes, with the installed app and a few dozen songs of different kinds:

1. Each song gets a style and a font that suit it: dense, fast songs a list (Stack), slow songs with held notes Arc or Drift, short shouted hooks Lens. The **Picked for this song** card in Settings names the same style and font the desktop shows, and its reason reads sensibly.
2. A song never changes style or font while it plays, except once, at a line change or a break, when its cover arrives late or synced lyrics replace plain ones.
3. Plain (unsynced) lyrics always get the calm list. Songs in Vietnamese get a font with Vietnamese letters; Japanese, Chinese and Korean songs use the system's fonts for those characters.
4. Play a song again later in the same session: it looks exactly as before, from its first line.
5. The menu bar / tray menu's **Effects ▸** Calm, Balanced and Lively set the Effects slider in Settings, and its check follows the slider.
