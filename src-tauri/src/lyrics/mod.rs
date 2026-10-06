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
#[async_trait]
pub trait Provider: Send + Sync {
    async fn lookup(&self, track: &Track) -> Result<Lyrics, String>;
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
        let _ = self.events.send(empty(&track.key, LyricsStatus::Loading));
        drop(state);
        let service = self.clone();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
        tokio::spawn(async move {
            loop {
                let outcome =
                    tokio::time::timeout_at(deadline, service.resolve(&track, &force)).await;
                let (result, from_cache, saved_at) = match outcome {
                    Ok(Ok(result)) => result,
                    Ok(Err(error)) => {
                        eprintln!("lyrics lookup failed: {error}");
                        (empty(&track.key, LyricsStatus::Error), false, now_seconds())
                    }
                    Err(_) => {
                        eprintln!("lyrics lookup timed out after six seconds");
                        (empty(&track.key, LyricsStatus::Error), false, now_seconds())
                    }
                };
                let mut state = service.state.lock().unwrap_or_else(|e| e.into_inner());
                // A refetch can promote a lookup while disk/memory cache is being read. Do not return that cached result.
                if from_cache && force.load(Ordering::Acquire) {
                    drop(state);
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
                // Broadcast enqueue is nonblocking and cannot re-enter the service. Keep result ordering under the state lock.
                let _ = service.events.send(result.clone());
                sender.send_replace(Some(result));
                break;
            }
        });
        receiver
    }
    async fn resolve(
        &self,
        track: &Track,
        force: &AtomicBool,
    ) -> Result<(Lyrics, bool, u64), String> {
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
                Err(error) => eprintln!("lyrics cache read failed; using network: {error}"),
            }
        }
        let _slot = self.slots.acquire().await.map_err(|e| e.to_string())?;
        let result = self.provider.lookup(track).await?;
        if result.track_key != track.key || !cache::cacheable(&result) {
            return Err("provider returned an invalid terminal lyrics result".into());
        }
        let saved_at = now_seconds();
        if let Err(error) = self.cache.put(&result, saved_at).await {
            eprintln!("lyrics cache write failed: {error}");
        }
        Ok((result, false, saved_at))
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
