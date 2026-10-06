# Windows now-playing (X2)

`codex/now-playing` builds on `codex/desktop-layer`. It implements the Windows portion of X2. macOS Spotify/Music reading, native SMTC acceptance, and X3 lyrics remain outstanding; M2 is not complete.

## Data flow

The SMTC adapter observes manager session/current-session changes and each session's media, playback and timeline events. All WinRT access runs on Tokio workers, with a one-second polling fallback and bounded metadata/connection waits. Subscriptions are removed when their sessions disappear. Manager failures trigger reconnection; an unavailable or stopped source clears playback to null. Paused tracks retain metadata and set `isPlaying: false`.

Selection prefers playing Spotify, then playing Apple Music, then other playing sessions. When everything is paused, it retains the most recently active session, breaking ties with the current session and then Spotify. This applies the SPEC watcher priority so a paused Spotify session cannot mask another app that is playing. Track keys use the exact lowercase artist/title/album/rounded-duration contract; metadata is not normalized for matching at this stage.

`sampledAt` comes from SMTC `LastUpdatedTime` (100-nanosecond ticks since 1601 converted to Unix milliseconds). Valid coarse timestamps are preserved across polls, so the frontend can extrapolate from the actual observation. Unset timestamps fall back to read time, and future timestamps are bounded by read time. Expected playback is compared at a common sample time to detect seeks greater than one second. Changes emit immediately; unchanged playing tracks resync every second, including while metadata awaits a response. Identical paused/idle state does not produce repeated events.

`get_now_playing` reads the watcher's cached state. Playback transitions drive the X1 overlay visibility hook. The macOS command remains null until its adapter is implemented. Lyrics commands remain explicit error stubs until X3; this branch does not claim to fetch lyrics.

## Artwork

Artwork is read asynchronously from SMTC's thumbnail stream and converted on a blocking worker into a PNG data URL. Stream input is capped at 8 MiB, decode dimensions at 4096 per side, and decoder allocation at 64 MiB. Output is at most 300 pixels per side, preserving aspect ratio without enlarging small images. PNG, JPEG and WebP are supported; invalid artwork leaves the track intact with a null image.

WinRT stream references use `AgileReference` when crossing worker threads. A three-second timeout and ten-second retry delay bound thumbnail failures. Artwork work is cancelled when replaced, and a session/track/invalidation key prevents a late result from overwriting a newer song. No artwork or song data is committed to the repository.

## Native acceptance still required

On Windows with Spotify and the Tauri prerequisites:

```
pnpm install --frozen-lockfile
pnpm tauri dev -- --media-test
```

The debug-only flag prints emitted track keys, positions, sample times, playback state, artwork data-URL byte counts and seek flags. It does not print artwork content or lyrics. In normal mode the overlay hides while idle; use `--desktop-layer-test` only when separately testing the desktop placement, since that flag forces visibility.

Verify:

1. No player open: one null event and hidden overlays. Open Spotify and play: correct metadata, artwork and one-second events.
2. Pause/resume: immediate state changes; no repeating pause events; overlay hides/shows according to settings.
3. Seek forward and back more than one second: immediate seek event and correct timestamp/position pair. Check coarse Spotify timeline updates do not make lyrics jump backward.
4. Switch tracks rapidly: the previous cover never appears on a new track. Missing artwork must not suppress metadata.
5. Play another SMTC app with Spotify paused, then play Spotify too: check selection priority. Close the selected app and check fallback or null.
6. Quit/relaunch Spotify, resume from sleep, and restart Explorer. Check subscription recovery and overlay visibility.

Linux validation covers the portable timing, selection, key and image tests plus Windows cross-target compilation/Clippy. It does not establish native WinRT or desktop behavior. macOS validation requires a Mac and its implementation is pending.
