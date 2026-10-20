pub mod cache;
pub mod lrclib;
pub mod matching;
#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
pub mod runtime;

use crate::contract::{Lyrics, LyricsSource, LyricsStatus, NowPlaying};
use async_trait::async_trait;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{broadcast, watch, Semaphore};

#[derive(Debug, Clone)]
pub struct Track {
    pub key: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: f64,
}
impl From<&NowPlaying> for Track {
    fn from(track: &NowPlaying) -> Self {
        Self {
            key: track.track_key.clone(),
            title: track.title.clone(),
            artist: track.artist.clone(),
            album: track.album.clone(),
            duration_ms: track.duration_ms,
        }
    }
}
/// Why a lookup has no answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub message: String,
    /// No network yet, a timeout, or a busy or rate-limited LRCLIB: another try a little later may
    /// work. Otherwise (a 4xx answer, unusable metadata) it would get the same answer.
    pub transient: bool,
}
impl Failure {
    pub fn transient(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            transient: true,
        }
    }
    pub fn permanent(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            transient: false,
        }
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
#[async_trait]
pub trait Provider: Send + Sync {
    async fn lookup(&self, track: &Track) -> Result<Lyrics, Failure>;
    /// A synced version of a song `lookup` found only plain text for, from a broader search; None
    /// when there is none. Plain text can only be paced by guesswork, which drifts from the singer,
    /// so the service asks this quietly right after a plain-only answer, while the plain text shows.
    async fn synced(&self, _track: &Track) -> Result<Option<Lyrics>, Failure> {
        Ok(None)
    }
}
pub fn empty(key: &str, status: LyricsStatus) -> Lyrics {
    Lyrics {
        track_key: key.into(),
        status,
        synced: None,
        plain: None,
        source: LyricsSource::Lrclib,
    }
}
fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
struct Flight {
    receiver: watch::Receiver<Option<Lyrics>>,
    force: Arc<AtomicBool>,
}
struct Completed {
    lyrics: Lyrics,
    saved_at: u64,
}
#[derive(Default)]
struct State {
    flights: HashMap<String, Flight>,
    tracks: VecDeque<Track>,
    completed: HashMap<String, Completed>,
    /// Bumped by every new job and every quiet follow-up. A follow-up holding an older value was
    /// overtaken (another track, a refetch) and stops.
    quiet: u64,
}
impl State {
    /// The track started last: the one playing, as far as the service knows.
    fn current(&self, key: &str) -> bool {
        self.tracks.back().is_some_and(|track| track.key == key)
    }
}
/// One lookup's budget, from the track change through the cache, waiting for a free slot, the
/// exact matches and the searches, with their retries while LRCLIB answers "busy". The overlay
/// shows the lyrics loading meanwhile.
const DEADLINE: Duration = Duration::from_secs(15);
/// After a transient failure on the current track (no network yet after wake, a busy or
/// rate-limiting LRCLIB, the deadline), the lookup is tried again after each of these waits: about
/// a minute and a half in all.
const RETRY_BACKOFF: [Duration; 3] = [
    Duration::from_secs(5),
    Duration::from_secs(20),
    Duration::from_secs(60),
];
/// Quiet work for the current track after its job answered: no `loading` event, and nothing is
/// broadcast unless a better answer arrives, so the overlay never fades back to its loading view.
enum FollowUp {
    /// The lookup failed on something transient.
    Retry,
    /// The answer is plain text only, showing meanwhile: just looked up, or a cached answer due for
    /// a recheck (`cache::stale`). A synced version replaces it live.
    Recheck(Lyrics),
}
pub struct Service {
    provider: Arc<dyn Provider>,
    cache: cache::Cache,
    state: Mutex<State>,
    events: broadcast::Sender<Lyrics>,
    slots: Semaphore,
}
impl Service {
    pub fn new(provider: Arc<dyn Provider>, cache: cache::Cache) -> Arc<Self> {
        let (events, _) = broadcast::channel(128);
        Arc::new(Self {
            provider,
            cache,
            state: Mutex::new(State::default()),
            events,
            slots: Semaphore::new(4),
        })
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Lyrics> {
        self.events.subscribe()
    }
    /// Synchronous initiation queues loading before returning; the shared background job owns its lifetime.
    pub fn start(self: &Arc<Self>, track: Track, force: bool) -> watch::Receiver<Option<Lyrics>> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.tracks.retain(|known| known.key != track.key);
        state.tracks.push_back(track.clone());
        // Bound the metadata/result history. In-flight jobs retain their own metadata independently.
        while state.tracks.len() > 64 {
            if let Some(old) = state.tracks.pop_front() {
                state.completed.remove(&old.key);
            }
        }
        if let Some(flight) = state.flights.get(&track.key) {
            if force {
                flight.force.store(true, Ordering::Release);
            }
            return flight.receiver.clone();
        }
        let force = Arc::new(AtomicBool::new(force));
        let (sender, receiver) = watch::channel(None);
        state.flights.insert(
            track.key.clone(),
            Flight {
                receiver: receiver.clone(),
                force: force.clone(),
            },
        );
        state.quiet += 1;
        let _ = self.events.send(empty(&track.key, LyricsStatus::Loading));
        drop(state);
        let service = self.clone();
        let deadline = tokio::time::Instant::now() + DEADLINE;
        tokio::spawn(async move {
            loop {
                let outcome =
                    tokio::time::timeout_at(deadline, service.resolve(&track, &force)).await;
                let (result, from_cache, saved_at, transient) = match outcome {
                    Ok(Ok((result, from_cache, saved_at))) => (result, from_cache, saved_at, false),
                    Ok(Err(error)) => {
                        applog!("lyrics lookup failed: {error}");
                        let error_result = empty(&track.key, LyricsStatus::Error);
                        (error_result, false, now_seconds(), error.transient)
                    }
                    Err(_) => {
                        applog!("lyrics lookup timed out after {} s", DEADLINE.as_secs());
                        let error_result = empty(&track.key, LyricsStatus::Error);
                        (error_result, false, now_seconds(), true)
                    }
                };
                let follow_up = {
                    let mut state = service.state.lock().unwrap_or_else(|e| e.into_inner());
                    // A refetch can promote a lookup while disk/memory cache is being read. Do not return that cached result.
                    if from_cache && force.load(Ordering::Acquire) {
                        continue;
                    }
                    if state.tracks.iter().any(|known| known.key == track.key) {
                        state.completed.insert(
                            track.key.clone(),
                            Completed {
                                lyrics: result.clone(),
                                saved_at,
                            },
                        );
                    }
                    state.flights.remove(&track.key);
                    // Only the playing track is worth more work; any other is looked up again
                    // when it plays again.
                    let follow_up = if !state.current(&track.key) {
                        None
                    } else if transient {
                        Some(FollowUp::Retry)
                    } else if result.status == LyricsStatus::PlainOnly
                        && (!from_cache || cache::stale(&result, saved_at, now_seconds()))
                    {
                        Some(FollowUp::Recheck(result.clone()))
                    } else {
                        None
                    };
                    let follow_up = follow_up.map(|work| {
                        state.quiet += 1;
                        (work, state.quiet)
                    });
                    // Broadcast enqueue is nonblocking and cannot re-enter the service. Keep result ordering under the state lock.
                    let _ = service.events.send(result.clone());
                    sender.send_replace(Some(result));
                    follow_up
                };
                match follow_up {
                    Some((FollowUp::Retry, token)) => service.retry(&track, token).await,
                    Some((FollowUp::Recheck(plain), token)) => {
                        service.recheck(&track, token, plain).await
                    }
                    None => {}
                }
                break;
            }
        });
        receiver
    }
    /// Tries again after a transient failure, waiting `RETRY_BACKOFF` before each try, so the
    /// overlay goes from its "Couldn't load lyrics" note straight to the lyrics. Each try first
    /// checks that nothing overtook this one (another track, a refetch); a permanent failure ends
    /// them.
    async fn retry(&self, track: &Track, token: u64) {
        for wait in RETRY_BACKOFF {
            tokio::time::sleep(wait).await;
            if !self.unchanged(&track.key, token) {
                return;
            }
            let failure = match tokio::time::timeout(DEADLINE, self.fetch(track)).await {
                Ok(Ok(result)) => {
                    let plain = (result.status == LyricsStatus::PlainOnly).then(|| result.clone());
                    self.settle(track, token, result).await;
                    // plain text only: a synced version is worth one more ask
                    if let Some(plain) = plain {
                        self.recheck(track, token, plain).await;
                    }
                    return;
                }
                Ok(Err(failure)) => failure,
                Err(_) => Failure::transient(format!("timed out after {} s", DEADLINE.as_secs())),
            };
            applog!("lyrics retry failed: {failure}");
            if !failure.transient {
                return;
            }
        }
    }
    /// Asks LRCLIB once for a synced version of a plain-only song (`Provider::synced`), while the
    /// plain text shows. Synced lyrics replace it live (from unsynced to word highlight); none keeps
    /// the plain text and starts its 30 days again; a failure leaves it due, for the next play.
    async fn recheck(&self, track: &Track, token: u64, plain: Lyrics) {
        let result = match tokio::time::timeout(DEADLINE, self.fetch_synced(track)).await {
            Ok(Ok(Some(result))) => result,
            Ok(Ok(None)) => plain.clone(),
            Ok(Err(failure)) => {
                applog!("lyrics recheck failed: {failure}");
                return;
            }
            Err(_) => {
                applog!("lyrics recheck timed out after {} s", DEADLINE.as_secs());
                return;
            }
        };
        if result.status == LyricsStatus::Found {
            self.settle(track, token, result).await;
            return;
        }
        // A newer job (a refetch) may have saved its own answer meanwhile: don't write over it.
        if self.state.lock().unwrap_or_else(|e| e.into_inner()).quiet != token {
            return;
        }
        let saved_at = now_seconds();
        let plain = Lyrics {
            source: LyricsSource::Lrclib,
            ..plain
        };
        if let Err(error) = self.cache.put(&plain, saved_at).await {
            applog!("lyrics cache write failed: {error}");
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.quiet == token {
            if let Some(completed) = state.completed.get_mut(&track.key) {
                completed.saved_at = saved_at;
            }
        }
    }
    /// Nothing overtook the quiet follow-up holding `token`, and its track still plays.
    fn unchanged(&self, key: &str, token: u64) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.quiet == token && state.current(key)
    }
    /// Saves a quiet follow-up's answer, and makes it the track's result and broadcasts it unless
    /// a newer job took over meanwhile (that job sends its own).
    async fn settle(&self, track: &Track, token: u64, result: Lyrics) {
        let saved_at = now_seconds();
        if let Err(error) = self.cache.put(&result, saved_at).await {
            applog!("lyrics cache write failed: {error}");
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.quiet != token {
            return;
        }
        if state.tracks.iter().any(|known| known.key == track.key) {
            state.completed.insert(
                track.key.clone(),
                Completed {
                    lyrics: result.clone(),
                    saved_at,
                },
            );
        }
        let _ = self.events.send(result);
    }
    async fn resolve(
        &self,
        track: &Track,
        force: &AtomicBool,
    ) -> Result<(Lyrics, bool, u64), Failure> {
        if !force.load(Ordering::Acquire) {
            {
                let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(completed) = state.completed.get(&track.key) {
                    if cache::fresh(&completed.lyrics, completed.saved_at, now_seconds()) {
                        let mut result = completed.lyrics.clone();
                        result.source = LyricsSource::Cache;
                        return Ok((result, true, completed.saved_at));
                    }
                }
            }
            match self.cache.read(&track.key, now_seconds()).await {
                Ok(Some(entry)) => return Ok((entry.lyrics, true, entry.saved_at)),
                Ok(None) => {}
                Err(error) => applog!("lyrics cache read failed; using network: {error}"),
            }
        }
        let result = self.fetch(track).await?;
        let saved_at = now_seconds();
        if let Err(error) = self.cache.put(&result, saved_at).await {
            applog!("lyrics cache write failed: {error}");
        }
        Ok((result, false, saved_at))
    }
    /// The network half of a lookup, in one of the shared slots. A track that stopped being the
    /// current one before its lookup reached the network (the user skipped on) doesn't take a slot
    /// or a request, which keeps a burst of skips from tripping LRCLIB's rate limit: it is looked
    /// up again when it plays again.
    async fn fetch(&self, track: &Track) -> Result<Lyrics, Failure> {
        let skipped =
            || Failure::permanent("skipped: another track started before it reached LRCLIB");
        if !self.current(&track.key) {
            return Err(skipped());
        }
        let _slot = self
            .slots
            .acquire()
            .await
            .map_err(|e| Failure::permanent(e.to_string()))?;
        if !self.current(&track.key) {
            return Err(skipped());
        }
        let result = self.provider.lookup(track).await?;
        if result.track_key != track.key || !cache::cacheable(&result) {
            return Err(Failure::permanent(
                "provider returned an invalid terminal lyrics result",
            ));
        }
        Ok(result)
    }
    /// `fetch` for `Provider::synced`: in a slot, for the current track only, a synced answer or none.
    async fn fetch_synced(&self, track: &Track) -> Result<Option<Lyrics>, Failure> {
        let skipped = || Failure::permanent("skipped: another track started");
        if !self.current(&track.key) {
            return Err(skipped());
        }
        let _slot = self
            .slots
            .acquire()
            .await
            .map_err(|e| Failure::permanent(e.to_string()))?;
        if !self.current(&track.key) {
            return Err(skipped());
        }
        let found = self.provider.synced(track).await?;
        Ok(found.filter(|lyrics| {
            lyrics.track_key == track.key
                && lyrics.status == LyricsStatus::Found
                && cache::cacheable(lyrics)
        }))
    }
    fn current(&self, key: &str) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .current(key)
    }
    pub async fn get(self: &Arc<Self>, key: &str) -> Lyrics {
        let (flight, track) = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let flight = state.flights.get(key).map(|flight| flight.receiver.clone());
            if flight.is_none() {
                if let Some(completed) = state.completed.get(key) {
                    if completed.lyrics.status == LyricsStatus::Error
                        || cache::fresh(&completed.lyrics, completed.saved_at, now_seconds())
                    {
                        return completed.lyrics.clone();
                    }
                }
            }
            (
                flight,
                state.tracks.iter().find(|track| track.key == key).cloned(),
            )
        };
        if let Some(receiver) = flight {
            return wait(receiver, key).await;
        }
        if let Some(track) = track {
            return wait(self.start(track, false), key).await;
        }
        self.cache
            .get(key, now_seconds())
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| empty(key, LyricsStatus::Error))
    }
    pub fn refetch(self: &Arc<Self>, key: &str) -> Result<(), String> {
        let track = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .tracks
            .iter()
            .find(|track| track.key == key)
            .cloned()
            .ok_or("track metadata is unavailable; play this track before refetching")?;
        self.start(track, true);
        Ok(())
    }
}
pub async fn wait(mut receiver: watch::Receiver<Option<Lyrics>>, key: &str) -> Lyrics {
    loop {
        if let Some(result) = receiver.borrow().clone() {
            return result;
        }
        if receiver.changed().await.is_err() {
            return empty(key, LyricsStatus::Error);
        }
    }
}
#[cfg(test)]
mod tests;
