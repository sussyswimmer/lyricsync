# Now playing (X2)

Codex built the Windows adapter (SMTC); Claude Code built the macOS one (Spotify and Music over AppleScript). Both run in one now-playing loop (`media/runtime.rs`) that owns the 1 s resync, the watcher and publishing. Neither has passed native acceptance on a real machine yet, so M2 is not complete. Results so far (macOS 26.5 with Spotify, logged in `HANDOFF.md`): the track, artwork and LRCLIB lyrics arrive.

## Data flow

The SMTC adapter observes manager session/current-session changes and each session's media, playback and timeline events. All WinRT access runs on Tokio workers, with a one-second polling fallback and bounded metadata/connection waits. Subscriptions are removed when their sessions disappear. Manager failures trigger reconnection; an unavailable or stopped source clears playback to null. Paused tracks retain metadata and set `isPlaying: false`.

Selection prefers playing Spotify, then playing Apple Music, then other playing sessions. When everything is paused, it retains the most recently active session, breaking ties with the current session and then Spotify. This applies the SPEC watcher priority so a paused Spotify session cannot mask another app that is playing. Track keys use the exact lowercase artist/title/album/rounded-duration contract; metadata is not normalized for matching at this stage.

`sampledAt` comes from SMTC `LastUpdatedTime` (100-nanosecond ticks since 1601 converted to Unix milliseconds). Valid coarse timestamps are preserved across polls, so the frontend can extrapolate from the actual observation. Unset timestamps fall back to read time, and future timestamps are bounded by read time. Expected playback is compared at a common sample time to detect seeks greater than one second. Changes emit immediately, with one exception: a player publishes a new track's metadata and timeline separately, so a read where only the metadata or only the duration changed waits up to 300 ms for the other half (`Settle` in `media/mod.rs`). That keeps a trackKey from pairing two songs. Unchanged playing tracks resync every second, including while metadata awaits a response. Identical paused/idle state does not produce repeated events.

`get_now_playing` reads the watcher's cached state. Playback transitions drive the X1 overlay visibility hook, and a track change starts the lyrics lookup before `now-playing` is emitted.

## Media status (contract v2)

`now-playing` is `null` both when nothing plays and when Undertone can't see the player, so contract v2 adds `media-status` (`{ source, problem }`) to tell them apart. `media::media_status` decides it from the published track and what the backend saw of the players in the same snapshot (`MediaSource::presence`, a `Presence`):

| Situation | `source` | `problem` |
|---|---|---|
| A track is reported, playing or paused | the track's source | `null` |
| No track, and a running player has Automation denied (macOS; Spotify when both do) | `"spotify"` or `"apple-music"` | `"automation-denied"` |
| No track, and no supported player runs: macOS finds neither Spotify nor Music running, Windows has no media session, or the backend can't connect | `null` | `"no-player"` |
| No track otherwise: a player open with nothing loaded, the Automation prompt still open, or a backend that can't tell | `null` | `null` |

The loop recomputes it after every publish and after a failed connection, keeps it in `AppState` for `get_media_status` (`{ null, null }` until the first snapshot), and emits `media-status` only when it changed, always after the `now-playing` it goes with. On macOS the presence comes from the running set and the Automation consent map; a denied player that isn't running is no problem. On Windows any media session, current or not, counts as a player. Settings uses it to show the Automation notice and "No music app open"; the overlay ignores it. A core older than v2 rejects `get_media_status`, and Settings then behaves as it did before.

## Artwork

Artwork is read asynchronously from SMTC's thumbnail stream and converted on a blocking worker into a JPEG data URL (quality 85), or a PNG when the cover has real transparency (the palette skips see-through pixels, so flattening them would change its colors). Stream input is capped at 8 MiB, decode dimensions at 4096 per side, and decoder allocation at 64 MiB. Output is at most 160 pixels per side, preserving aspect ratio without enlarging small images; a photo-like cover is about 8 KB of base64, which matters because every `now-playing` event carries it. PNG, JPEG and WebP are supported; invalid artwork leaves the track intact with a null image.

WinRT stream references use `AgileReference` when crossing worker threads. A three-second timeout and ten-second retry delay bound thumbnail failures. Artwork work is cancelled when replaced. The cache key (`ArtCache` in `media/mod.rs`) is the session, the trackKey and that session's own count of metadata changes, so another app changing its metadata never refetches this song's art. When the same song announces new metadata, or a failed fetch is retried after 10 s, the current picture stays published until a fetch brings a different one, so the cover never blinks to null. A fetch that finds the song has no thumbnail at all (a local file, a podcast without art) clears the picture and publishes null, with no retry; a thumbnail the player publishes later is announced and fetched then. Only a failed fetch (timeout, read or decode error) keeps the cover and is retried. A late result for an older key is dropped. No artwork or song data is committed to the repository.

## Native acceptance still required

On Windows with Spotify and the Tauri prerequisites:

```
pnpm install --frozen-lockfile
pnpm tauri dev -- -- --media-test
```

The first `--` ends the Tauri CLI's options and the second ends cargo's, so the flag reaches the app. This debug-only flag prints emitted track keys, positions, sample times, playback state, artwork data-URL byte counts and seek flags, and each `media-status` change. It does not print artwork content or lyrics. In normal mode the overlay hides while idle; use `--desktop-layer-test` only when separately testing the desktop placement, since that flag forces visibility.

Verify:

1. No player open: one null event, `media-status` `no-player` (Settings → This song says "No music app open") and hidden overlays. Open Spotify and play: correct metadata, artwork and one-second events, and `media-status` `{ "source": "spotify", "problem": null }`.
2. Pause/resume: immediate state changes; no repeating pause events; overlay hides/shows according to settings.
3. Seek forward and back more than one second: immediate seek event and correct timestamp/position pair. Check coarse Spotify timeline updates do not make lyrics jump backward.
4. Switch tracks rapidly: the previous cover never appears on a new track. Missing artwork must not suppress metadata.
5. With Spotify playing, play and pause a video in a browser tab (another media session). The cover in Settings doesn't blink, and no `now-playing` line shows `"artworkBytes":null` for the Spotify song.
6. Play another SMTC app with Spotify paused, then play Spotify too: check selection priority. Close the selected app and check fallback or null.
7. Quit/relaunch Spotify, resume from sleep, and restart Explorer. Check subscription recovery and overlay visibility.

Linux validation covers the portable timing, selection, key and image tests plus Windows cross-target compilation/Clippy. It does not establish native WinRT or desktop behavior.

## macOS: Spotify and Music

`media/macos.rs` reads both players with in-process NSAppleScript; `osascript` only asks the Automation question (below). Before each poll it lists the running apps through NSWorkspace, so a closed player is never sent an Apple event (that would launch it). A player that is running but hasn't finished launching counts as running for `media-status`, but isn't read until it reports that it has finished (`isFinishedLaunching`), or after 10 s for an app that never reports it: until then AppKit holds its Apple events, and a script would block the main thread for its full 2 s. The gate is per process: each player is judged by its newest instance, and a relaunch (a new process) waits again even if no poll saw the player closed, as when Spotify restarts to update. Each script also checks `application id "…" is running` before its `tell`, and bounds its Apple events to 2 s. The script sources and their parsing live in `media/applescript.rs` and are unit-tested on every OS.

- **Main thread:** NSAppleScript is main-thread only, so each read is one short hop there, and only one can be queued at a time. A player that times out gets no scripts for 4 s, and a script that fails to compile is not retried for 60 s.
- **Automation consent:** settled on a blocking thread before any script runs, so the macOS prompt never freezes the app. While the question is open the player is skipped.
  - First `AEDeterminePermissionToAutomateTarget` is asked without prompting, on its own thread with a 2 s limit. On macOS 26 it can block forever without showing anything; after one such hang Undertone stops calling it for the rest of the run, and logs it once.
  - When the user hasn't decided yet, or that check didn't answer, `/usr/bin/osascript` sends the player one Apple event (`consent_probe`: `get player state`, only if the player is running). macOS attributes the event to Undertone, the process that started `osascript`, so the prompt names Undertone and the answer is kept for Undertone. The probe waits up to 120 s for the user, then gives up and the next poll asks again.
  - A denial publishes `null` with `media-status` `automation-denied` for that player, and logs one hint naming System Settings → Privacy & Security → Automation; a denied player is checked again every 10 s, so turning it back on needs no restart. `Info.plist` carries `NSAppleEventsUsageDescription`.
- **Selection:** a playing Spotify beats a playing Music, which beats whichever played last. With Spotify playing, Music isn't asked at all.
- **Hiccups:** one slow or failed read keeps the player's last reading for up to 5 s, so it doesn't publish `null` and reload the lyrics mid-song. A denial, a quit or a player with no track drops it at once.
- **Artwork:** Spotify's artwork URL is fetched over HTTPS only (5 s timeout, 8 MiB cap); Music's comes from `raw data of artwork 1 of current track` (the image as stored, normally JPEG or PNG). Only if that returns nothing or fails with an error other than a timeout does it fall back to `data`, a picture Music may hand over as TIFF or PICT. Both become JPEG data URLs of at most 160 px (PNG when the cover is see-through), cached per track. An image the decoder refuses means no artwork and isn't retried.
- **Position timing:** the read script asks for the player state and the track's details first and its position near the end, so the call's midpoint was earlier than the moment the position was read, putting lyrics early by about a third of the call, and more on a busy Mac. Right after each read, on the same main-thread hop, a second script asks for `player position` alone (one Apple event, 1 s timeout) and is stamped with the middle of its own call. The read's position stands in when that fails or takes longer than 250 ms (`applescript::timed_reading`). The overlay's clock then follows the middle of the last five readings' phase (`src/core/clock.ts`), so a reading that is a little early or late doesn't speed the words up or slow them down.
- **Polling:** every second while playing, every 3 s while paused or idle. `com.spotify.client.PlaybackStateChanged` and `com.apple.Music.playerInfo` wake the loop at once.

## macOS acceptance still required

On macOS 14 (the minimum) and the current release:

```
pnpm install --frozen-lockfile
pnpm tauri dev -- -- --media-test
```

Verify:

1. Paste `SPOTIFY_READ`, `MUSIC_READ` and `MUSIC_ARTWORK` from `media/applescript.rs` into Script Editor and run each with the player playing, paused and closed. A closed player must not launch.
2. First run: macOS asks whether Undertone may control Spotify. The tray menu and Settings keep working while the prompt is open, and `media-status` stays `{ null, null }`. Deny it: `now-playing` goes `null`, the Automation hint is logged once, `media-status` reports `automation-denied` for `spotify`, and Settings shows "Undertone can't see what Spotify is playing." Turn it back on in System Settings: lyrics come back and the notice goes away within about 10 s, without a restart. Repeat with Music. Quit both players: `media-status` reports `no-player`.
3. Play, pause and skip in Spotify and in Music with Undertone in the background: `now-playing` follows within a fraction of a second, not after the 3 s idle poll.
4. With both players open: a playing Spotify beats a playing Music; pause Spotify while Music plays and Music is picked; with both paused, the one that played last stays selected.
5. Artwork shows for both players. Music's `raw data` is normally JPEG or PNG; the `data` fallback can be TIFF, which decodes too (the `image` crate is built with png, jpeg, webp, bmp, gif and tiff). Only PICT can't be decoded: if Music's art never shows, the terminal shows one "Music artwork unusable" line saying why.
6. Set a decimal-comma region (for example German) and check `positionMs` and `durationMs`. Then set an Arabic or Persian region (decimal separator ٫, and Arabic-Indic digits if offered): `positionMs` advances and `durationMs` isn't 0.
7. Quit Spotify while it plays and watch that it doesn't relaunch. Start it again while `--media-test` runs: no "Spotify did not answer within 2 s" line appears, and the track shows once Spotify has finished launching. Check that the highlight stays within ±150 ms of the vocals in both players.
8. On macOS 26, after `tccutil reset AppleEvents com.undertone.desktop`: open Undertone with Spotify playing. The prompt appears within about 3 s and names Undertone, not osascript; after **OK**, lyrics show. If the first check hung, `undertone.log` has one "macOS did not answer Undertone's Automation check" line. `--diagnose` finishes, and reports "did not answer the Automation check" instead of hanging.

[ACCEPTANCE.md](ACCEPTANCE.md) has the remaining real-machine checks, including the ±150 ms sync and the 1 s lyrics latency in the Definition of done.
