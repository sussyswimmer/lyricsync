# LRCLIB lyrics service (X3)

The lyrics service (Codex, `codex/lyrics`, now merged) answers the lyrics commands and starts a lookup on every track change from either OS's now-playing adapter. The shared contract remains v1. Native end-to-end acceptance is still pending; M2 is not complete.

## Lookup and matching

The Rust client calls `https://lrclib.net/api/get` with the original track title, artist, album and duration in seconds. A missing or unsuitable exact match falls back to `/api/search`. Search first uses the original title, then retries without recognized remaster/live/radio-edit/featured-artist decorations if necessary. Case, quote and diacritic normalization is used only for comparisons; it does not rewrite queries or returned lyrics.

Candidates must match normalized title and artist. Ranking uses duration difference bands (≤2 s, ≤5 s, ≤8 s), then non-empty synced lyrics, then album match; duration difference and record ID break remaining ties. Differences over 8 s and invalid durations are rejected. Instrumental results take precedence, then synced text, plain text, or not-found. Valid empty searches produce not-found; HTTP failures, rate limits, malformed/oversized responses and timeouts produce error.

Requests include `Undertone/0.1 (+https://github.com/sussyswimmer/lyricsync)` as User-Agent. TLS verification and native trust roots remain enabled. Responses are limited to 2 MiB, redirects are rejected, and the shared lookup deadline is six seconds across cache, queueing, exact lookup and search. At most four provider lookups run concurrently.

## Service, commands and events

A track change starts one shared job per track key and immediately queues `lyrics` with `status: loading`, followed by its terminal result. Calls for the same key share that job. A forced refetch bypasses both memory and disk cache; if a regular lookup is already running, it is promoted so a cached result cannot satisfy the refetch. Cancellation of an individual waiter does not cancel shared work.

`get_lyrics(trackKey)` returns an active job's result, the latest known result, or a valid disk entry. `refetch_lyrics(trackKey)` returns after starting/promoting work; the result arrives on the `lyrics` event. Refetch requires metadata for one of the most recent 64 observed tracks. Unknown, uncached keys return error; the implementation does not try to reconstruct metadata by splitting track keys.

Every event carries its track key. Results for different tracks can finish out of order, so the frontend must match events to the active track. Initial state remains available through commands after subscribing. When playback becomes null the frontend should clear its display; the Lyrics contract does not define a null payload.

## Persistence

Files live under `appDataDir/lyrics/<sha1(trackKey)>.json` and include a schema version, original save timestamp and result. Writes use a temporary file in the same directory and atomic replacement. Reads verify schema, track identity, size and result shape. Invalid/corrupt entries are treated as misses. Cache failures log diagnostics without deliberately discarding a valid provider result.

Found, plain-only and instrumental results do not expire. Not-found expires exactly seven days after the original save time; repeated disk/memory reads do not renew that timestamp. Loading/error results are never intentionally persisted. Cache hits report `source: cache`. Cached song data stays in the user's app-data directory and is not tracked in Git. Test text is original placeholder material.

## Validation and live checks

The normal Rust suite uses a local HTTP fixture server and temporary directories. It verifies query encoding/User-Agent, exact and search responses, title retries, status mapping, ranking, cache persistence/expiry/corruption, concurrent callers, forced refetch, cancelled waiters, six-second timeout and HTTP/JSON failure behavior. An integrated test shuts its HTTP server down and starts a new service to prove the disk cache works offline.

The optional live probe uses deliberately nonexistent original metadata, without fetching or printing real lyrics:

```
cargo test --manifest-path src-tauri/Cargo.toml --locked live_lrclib_not_found_probe -- --ignored
```

The cloud proxy currently rejects the connection to `lrclib.net` with CONNECT 403. The domain has been added to the saved environment draft, preserving package-manager presets. Review/save the change in environment settings and publish the environment, then rerun the live probe. No LRCLIB key is required. Saving the draft does not itself change runtime egress.

For Windows acceptance after allowing LRCLIB access, run `pnpm tauri dev -- --media-test`, play Spotify, and check loading/terminal lyrics events alongside now-playing. The debug log prints only lyrics status/source, not text. Test cached replay offline, explicit refetch, a missing/instrumental/plain-only result, and rapid track switches. Actual lyrics display still depends on the frontend work. macOS's future media adapter must call the same `lyrics::runtime::track_changed` hook.
