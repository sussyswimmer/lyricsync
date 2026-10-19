# LRCLIB lyrics service (X3)

The lyrics service (Codex, `codex/lyrics`, now merged) answers the lyrics commands and starts a lookup on every track change from either OS's now-playing adapter. The shared contract is v5. v2 added `media-status` ([NOW_PLAYING.md](NOW_PLAYING.md#media-status-contract-v2)), v3 added the on/off, launch-at-login and shortcut settings, v4 the Effects setting and v5 Effects mode, so the lyrics commands and events are unchanged from v1. Native end-to-end acceptance is still pending; M2 is not complete.

## Lookup and matching

The Rust client calls `https://lrclib.net/api/get` with the original track title, artist, album and duration in seconds. A missing or unsuitable exact match asks `/api/get` again without the album (a player's album name often differs from LRCLIB's: an edition, a remaster), then falls back to `/api/search`. Search first uses the original title, then retries without recognized remaster/live/radio-edit/featured-artist decorations if necessary. Case, quote and diacritic normalization is used only for comparisons; it does not rewrite queries or returned lyrics.

The title must match exactly or once decorations such as remaster, live, radio edit, feat. and "(with X)" are stripped. Artist credits are compared as sets: each side is split on `,` `;` `&` `/` `+` `×` `、` and on the words x, and, with, vs, feat., ft. and featuring. A candidate matches when the strings are equal or one side's primary (first) artist is credited on the other side; sharing only a featured artist is not enough. Ranking uses duration difference bands (≤2 s, ≤5 s, ≤8 s), then non-empty synced lyrics, an exact title, an exact artist credit and the album; duration difference and record ID break remaining ties. Differences over 8 s and invalid durations are rejected. Instrumental results take precedence, then synced text, plain text, or not-found. Valid empty searches produce not-found.

Plain text only comes paced by guesswork, which drifts from the singer, so a plain-only answer is not the end of it. It is sent at once, and then, for the current track, a quiet follow-up asks for a synced version (`Provider::synced`). The follow-up tries the exact record (it may have gained timing), the exact lookup without the album, and then every record a search finds under the title and under its plain form. The first record with synced lyrics that matching accepts wins (`matching::best_synced`), even a duration band further off than the plain match. It replaces the plain text live, with no `loading` before it, and is cached. With no synced version the plain text stays.

An exact lookup that fails in any way counts as a miss, so search still runs: LRCLIB answers 503 to metadata it can't match exactly (an album or a length it has differently), and an exact answer that isn't a usable record is a miss too. A search answered 429, 502, 503 or 504, or a connection or timeout error, is asked again after `Retry-After` (1 s when it's absent), up to four times in all (LRCLIB's search answers 503 with `retry-after: 1` about half the time); there's no further try when the server asks for more than 2 s. Search records that don't decode, such as one with `"duration": null`, are skipped. A search that still fails produces error. Transient failures (network, timeout, 5xx, 429, a malformed answer, the deadline) are retried later on the current track (below); permanent ones (any other 4xx, an oversized answer, unusable metadata) are not.

Requests include `Undertone/<version> (+https://github.com/sussyswimmer/lyricsync)` as User-Agent, with the version from `Cargo.toml` (0.1.0 today); a cargo test fails when `tauri.conf.json`'s or `package.json`'s version differs from it. TLS verification and native trust roots remain enabled. Responses are limited to 2 MiB, redirects are rejected, and the shared lookup deadline is 15 seconds across cache, queueing, the exact lookups and the searches with their retries (each quiet retry or recheck below gets its own 15 seconds). At most four provider lookups run concurrently. A lookup whose track is no longer the current one when it would take a slot, or once it has one, is skipped without a request: it produces an uncached error, and the song is looked up again when it plays again.

## Service, commands and events

A track change starts one shared job per track key and immediately queues `lyrics` with `status: loading`, followed by its terminal result. For the current track, a quiet follow-up can send one more `lyrics` event later, with no `loading` before it, and only when it brings an answer: after a transient error the job tries again after 5 s, 20 s and 60 s, and a plain-only answer, just looked up or a stale cached one, is followed by a search for a synced version (see above and Persistence). The retries stop on a track change, a refetch, an answer, a permanent failure or after the third try. Meanwhile `get_lyrics` answers the error at once. Calls for the same key share that job. A forced refetch bypasses both memory and disk cache; if a regular lookup is already running, it is promoted so a cached result cannot satisfy the refetch. Cancellation of an individual waiter does not cancel shared work.

`get_lyrics(trackKey)` returns an active job's result, the latest known result, or a valid disk entry. `refetch_lyrics(trackKey)` returns after starting/promoting work; the result arrives on the `lyrics` event. Refetch requires metadata for one of the most recent 64 observed tracks. Unknown, uncached keys return error; the implementation does not try to reconstruct metadata by splitting track keys.

Every event carries its track key. Results for different tracks can finish out of order, so the frontend must match events to the active track. Initial state remains available through commands after subscribing. When playback becomes null the frontend should clear its display; the Lyrics contract does not define a null payload.

## Persistence

Files live under `appDataDir/lyrics/<sha1(trackKey)>.json` and include a schema version, original save timestamp and result. Writes use a temporary file in the same directory and atomic replacement. Reads verify schema, track identity, size and result shape. Invalid/corrupt entries are treated as misses. Cache failures log diagnostics without deliberately discarding a valid provider result.

Found and instrumental results do not expire. A plain-only result is served too, but once it is older than 30 days it is rechecked quietly when the song plays (the same synced search as above): synced lyrics replace it live, any other answer keeps it and renews its timestamp, and a failure leaves it due for the next play. Entries are format version 2. A version 1 plain-only entry, saved before plain-only answers were followed up, counts as due at its next play. Not-found expires exactly seven days after the original save time; repeated disk/memory reads do not renew that timestamp. Loading/error results are never intentionally persisted. Cache hits report `source: cache`. Cached song data stays in the user's app-data directory and is not tracked in Git. Test text is original placeholder material.

## Validation and live checks

The normal Rust suite uses a local HTTP fixture server and temporary directories. It verifies query encoding/User-Agent, exact and search responses, title retries, status mapping, ranking, cache persistence/expiry/corruption, concurrent callers, forced refetch, cancelled waiters, six-second timeout and HTTP/JSON failure behavior. It also covers null or malformed records, the `Retry-After` retry, the busy and timeout classification, the quiet retries and their cancellation (on Tokio's paused clock), skipped lookups, the plain-only recheck, the search for a synced version of a plain-only song (and the cache format that makes old plain-only entries due), artist credit sets, and the test that keeps the three manifests on one version. An integrated test shuts its HTTP server down and starts a new service to prove the disk cache works offline.

The optional live probe uses deliberately nonexistent original metadata, without fetching or printing real lyrics:

```
cargo test --manifest-path src-tauri/Cargo.toml --locked live_lrclib_not_found_probe -- --ignored
```

From the cloud environment the probe now reaches `lrclib.net`, which answers not-found, as it should for metadata that doesn't exist. No LRCLIB key is required.

## Native acceptance

Both OSes reach the service the same way: the now-playing loop in `media/runtime.rs` calls `lyrics::runtime::track_changed` on every track change, before it emits `now-playing`, whether the track came from the Windows media session or from Spotify or Music on macOS. So the steps are the same on Windows 10/11 (Spotify) and macOS 14+ (Spotify, then Music):

```
pnpm install --frozen-lockfile
pnpm tauri dev -- -- --media-test
```

The first `--` ends the Tauri CLI's options and the second ends cargo's, so `--media-test` reaches the app. Its log prints each lyrics event's status and source (for example `lyrics: status=Found source=Lrclib`), never the text. Verify:

1. Play a song LRCLIB has synced lyrics for: after the `now-playing` line with `"trackChanged":true` come `status=Loading` and then `status=Found source=Lrclib`. The overlay shows the lyrics, and words light up as they're sung.
2. Quit Undertone, turn the network off, start it again and play the same song: `status=Found source=Cache`, and the same lyrics on the overlay.
3. **Refetch lyrics** in the tray or menu bar: a new `Loading` and a result from `Lrclib`, never `Cache`.
4. A song LRCLIB doesn't have shows the "No lyrics for this song" chip, which fades after a few seconds; an instrumental shows a slow breathing ♪; a song with only plain lyrics shows them line by line without word highlight.
5. With the network off, an uncached song shows "Couldn't load lyrics" within about 15 seconds. Turn the network back on within a minute: the lyrics appear by themselves, logged as `status=Found source=Lrclib` with no `Loading` before it.
6. Skip through several tracks quickly: each new track logs its own `Loading`, and the overlay ends on the current song's lyrics, never an earlier song's. Songs skipped before their lookup reached LRCLIB log `lyrics lookup failed: skipped: …` and send no request.

[ACCEPTANCE.md](ACCEPTANCE.md) adds the Definition of done's latency check (lyrics within 1 s of a track change) and the proxy check.
