# Now playing (X2)

Codex built the Windows adapter (SMTC); Claude Code built the macOS one (Spotify and Music over AppleScript). Both run in one now-playing loop (`media/runtime.rs`) that owns the 1 s resync, the watcher and publishing. Neither has passed native acceptance on a real machine yet, so M2 is not complete.

## Data flow

The SMTC adapter observes manager session/current-session changes and each session's media, playback and timeline events. All WinRT access runs on Tokio workers, with a one-second polling fallback and bounded metadata/connection waits. Subscriptions are removed when their sessions disappear. Manager failures trigger reconnection; an unavailable or stopped source clears playback to null. Paused tracks retain metadata and set `isPlaying: false`.

Selection prefers playing Spotify, then playing Apple Music, then other playing sessions. When everything is paused, it retains the most recently active session, breaking ties with the current session and then Spotify. This applies the SPEC watcher priority so a paused Spotify session cannot mask another app that is playing. Track keys use the exact lowercase artist/title/album/rounded-duration contract; metadata is not normalized for matching at this stage.

`sampledAt` comes from SMTC `LastUpdatedTime` (100-nanosecond ticks since 1601 converted to Unix milliseconds). Valid coarse timestamps are preserved across polls, so the frontend can extrapolate from the actual observation. Unset timestamps fall back to read time, and future timestamps are bounded by read time. Expected playback is compared at a common sample time to detect seeks greater than one second. Changes emit immediately; unchanged playing tracks resync every second, including while metadata awaits a response. Identical paused/idle state does not produce repeated events.

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

Artwork is read asynchronously from SMTC's thumbnail stream and converted on a blocking worker into a PNG data URL. Stream input is capped at 8 MiB, decode dimensions at 4096 per side, and decoder allocation at 64 MiB. Output is at most 300 pixels per side, preserving aspect ratio without enlarging small images. PNG, JPEG and WebP are supported; invalid artwork leaves the track intact with a null image.

WinRT stream references use `AgileReference` when crossing worker threads. A three-second timeout and ten-second retry delay bound thumbnail failures. Artwork work is cancelled when replaced, and a session/track/invalidation key prevents a late result from overwriting a newer song. No artwork or song data is committed to the repository.

## Native acceptance still required

On Windows with Spotify and the Tauri prerequisites:

```
pnpm install --frozen-lockfile
pnpm tauri dev -- --media-test
```

The debug-only flag prints emitted track keys, positions, sample times, playback state, artwork data-URL byte counts and seek flags, and each `media-status` change. It does not print artwork content or lyrics. In normal mode the overlay hides while idle; use `--desktop-layer-test` only when separately testing the desktop placement, since that flag forces visibility.

Verify:

1. No player open: one null event, `media-status` `no-player` (Settings → This song says "No music app open") and hidden overlays. Open Spotify and play: correct metadata, artwork and one-second events, and `media-status` `{ "source": "spotify", "problem": null }`.
2. Pause/resume: immediate state changes; no repeating pause events; overlay hides/shows according to settings.
3. Seek forward and back more than one second: immediate seek event and correct timestamp/position pair. Check coarse Spotify timeline updates do not make lyrics jump backward.
4. Switch tracks rapidly: the previous cover never appears on a new track. Missing artwork must not suppress metadata.
5. Play another SMTC app with Spotify paused, then play Spotify too: check selection priority. Close the selected app and check fallback or null.
6. Quit/relaunch Spotify, resume from sleep, and restart Explorer. Check subscription recovery and overlay visibility.

Linux validation covers the portable timing, selection, key and image tests plus Windows cross-target compilation/Clippy. It does not establish native WinRT or desktop behavior.

## macOS: Spotify and Music

`media/macos.rs` reads both players with in-process NSAppleScript, never `osascript`. Before each poll it lists the running apps through NSWorkspace, so a closed player is never sent an Apple event (that would launch it). Each script also checks `application id "…" is running` before its `tell`, and bounds its Apple events to 2 s. The script sources and their parsing live in `media/applescript.rs` and are unit-tested on every OS.

- **Main thread:** NSAppleScript is main-thread only, so each read is one short hop there, and only one can be queued at a time. A player that times out gets no scripts for 4 s, and a script that fails to compile is not retried for 60 s.
- **Automation consent:** asked with `AEDeterminePermissionToAutomateTarget` on a blocking thread before any script runs, so the macOS prompt never freezes the app. While the prompt is open the player is skipped. Denial publishes `null` with `media-status` `automation-denied` for that player, and logs one hint naming System Settings → Privacy & Security → Automation; a denied player is checked again every 5 s, so turning it back on needs no restart. `Info.plist` carries `NSAppleEventsUsageDescription`.
- **Selection:** a playing Spotify beats a playing Music, which beats whichever played last. With Spotify playing, Music isn't asked at all.
- **Hiccups:** one slow or failed read keeps the player's last reading for up to 5 s, so it doesn't publish `null` and reload the lyrics mid-song. A denial, a quit or a player with no track drops it at once.
- **Artwork:** Spotify's artwork URL is fetched over HTTPS only (5 s timeout, 8 MiB cap); Music's comes from `data of artwork 1 of current track`. Both become PNG data URLs of at most 300 px, cached per track. An image the decoder refuses means no artwork and isn't retried.
- **Polling:** every second while playing, every 3 s while paused or idle. `com.spotify.client.PlaybackStateChanged` and `com.apple.Music.playerInfo` wake the loop at once.

## macOS acceptance still required

On macOS 14 or 15:

```
pnpm install --frozen-lockfile
pnpm tauri dev -- --media-test
```

Verify:

1. Paste `SPOTIFY_READ`, `MUSIC_READ` and `MUSIC_ARTWORK` from `media/applescript.rs` into Script Editor and run each with the player playing, paused and closed. A closed player must not launch.
2. First run: macOS asks whether Undertone may control Spotify. The tray menu and Settings keep working while the prompt is open, and `media-status` stays `{ null, null }`. Deny it: `now-playing` goes `null`, the Automation hint is logged once, `media-status` reports `automation-denied` for `spotify`, and Settings shows "Undertone can't see what Spotify is playing." Turn it back on in System Settings: lyrics come back and the notice goes away within about 5 s, without a restart. Repeat with Music. Quit both players: `media-status` reports `no-player`.
3. Play, pause and skip in Spotify and in Music with Undertone in the background: `now-playing` follows within a fraction of a second, not after the 3 s idle poll.
4. With both players open: a playing Spotify beats a playing Music; pause Spotify while Music plays and Music is picked; with both paused, the one that played last stays selected.
5. Artwork shows for both players. If Music's never does, `data of artwork 1` may be returning TIFF or PICT: switch the script to `raw data`, or enable the `image` crate's `tiff` feature.
6. Set a decimal-comma region (for example German) and check `positionMs` and `durationMs`.
7. Quit Spotify while it plays and watch that it doesn't relaunch. Check that the highlight stays within ±150 ms of the vocals in both players.
