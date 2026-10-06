//! SMTC reads and subscriptions run on Tauri's Tokio runtime, never on the window thread.
use super::{
    artwork, epoch_ms, runtime::Backend, select_candidate, track_key, windows_sample_time,
    Candidate, MediaSource, RawTrack,
};
use crate::contract::Source;
use async_trait::async_trait;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::AppHandle;
use tokio::sync::Notify;
use windows::{
    core::{AgileReference, Interface},
    Foundation::TypedEventHandler,
    Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as SessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    },
    Storage::Streams::{DataReader, IRandomAccessStreamReference},
};

pub struct WindowsSource {
    manager: SessionManager,
    manager_current_token: Option<i64>,
    manager_sessions_token: Option<i64>,
    sessions: Mutex<Vec<Subscription>>,
    activity: Mutex<HashMap<usize, f64>>,
    notify: Arc<Notify>,
    art_generation: Arc<AtomicU64>,
    art: Arc<Mutex<ArtCache>>,
    art_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    disconnected: AtomicBool,
    last_error: Mutex<Option<String>>,
}
#[derive(Default)]
struct ArtCache {
    key: Option<(usize, String, u64)>,
    value: Option<String>,
    retry_after: Option<Instant>,
}
struct Subscription {
    session: Session,
    media: Option<i64>,
    playback: Option<i64>,
    timeline: Option<i64>,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(token) = self.media {
            let _ = self.session.RemoveMediaPropertiesChanged(token);
        }
        if let Some(token) = self.playback {
            let _ = self.session.RemovePlaybackInfoChanged(token);
        }
        if let Some(token) = self.timeline {
            let _ = self.session.RemoveTimelinePropertiesChanged(token);
        }
    }
}
impl Drop for WindowsSource {
    fn drop(&mut self) {
        if let Some(token) = self.manager_current_token {
            let _ = self.manager.RemoveCurrentSessionChanged(token);
        }
        if let Some(token) = self.manager_sessions_token {
            let _ = self.manager.RemoveSessionsChanged(token);
        }
        if let Ok(mut task) = self.art_task.lock() {
            if let Some(task) = task.take() {
                task.abort();
            }
        }
    }
}
#[async_trait]
impl Backend for WindowsSource {
    const NAME: &'static str = "SMTC";
    const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(2);
    // SMTC reads are local and cheap, so every tick snapshots, playing or not.
    const IDLE_TICKS: u32 = 1;
    async fn connect(_app: &AppHandle, wake: Arc<Notify>) -> Result<Self, String> {
        Self::open(wake).await.map_err(|error| error.to_string())
    }
    fn is_disconnected(&self) -> bool {
        self.disconnected.load(Ordering::Acquire)
    }
}
impl WindowsSource {
    async fn open(notify: Arc<Notify>) -> windows::core::Result<Self> {
        // windows-rs initializes its WinRT factory in the MTA when called from a Tokio worker.
        let manager = SessionManager::RequestAsync()?.await?;
        let mut source = Self {
            manager,
            manager_current_token: None,
            manager_sessions_token: None,
            sessions: Mutex::new(Vec::new()),
            activity: Mutex::new(HashMap::new()),
            notify,
            art_generation: Arc::new(AtomicU64::new(0)),
            art: Arc::new(Mutex::new(ArtCache::default())),
            art_task: Mutex::new(None),
            disconnected: AtomicBool::new(false),
            last_error: Mutex::new(None),
        };
        let wake = source.notify.clone();
        source.manager_current_token = Some(source.manager.CurrentSessionChanged(
            &TypedEventHandler::new(move |_, _| {
                wake.notify_one();
                Ok(())
            }),
        )?);
        let wake = source.notify.clone();
        source.manager_sessions_token = Some(source.manager.SessionsChanged(
            &TypedEventHandler::new(move |_, _| {
                wake.notify_one();
                Ok(())
            }),
        )?);
        Ok(source)
    }
    fn subscribe(&self, sessions: &[Session]) -> windows::core::Result<()> {
        let mut subscriptions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        subscriptions.retain(|old| sessions.contains(&old.session));
        for session in sessions {
            if subscriptions.iter().any(|old| old.session == *session) {
                continue;
            }
            let mut sub = Subscription {
                session: session.clone(),
                media: None,
                playback: None,
                timeline: None,
            };
            let wake = self.notify.clone();
            let generation = self.art_generation.clone();
            sub.media = Some(session.MediaPropertiesChanged(&TypedEventHandler::new(
                move |_, _| {
                    generation.fetch_add(1, Ordering::AcqRel);
                    wake.notify_one();
                    Ok(())
                },
            ))?);
            let wake = self.notify.clone();
            sub.playback = Some(session.PlaybackInfoChanged(&TypedEventHandler::new(
                move |_, _| {
                    wake.notify_one();
                    Ok(())
                },
            ))?);
            let wake = self.notify.clone();
            sub.timeline = Some(session.TimelinePropertiesChanged(&TypedEventHandler::new(
                move |_, _| {
                    wake.notify_one();
                    Ok(())
                },
            ))?);
            subscriptions.push(sub);
        }
        Ok(())
    }
    fn report_error(&self, error: &windows::core::Error) {
        let message = error.to_string();
        let mut previous = self.last_error.lock().unwrap_or_else(|e| e.into_inner());
        if previous.as_ref() != Some(&message) {
            eprintln!("SMTC snapshot unavailable: {message}");
        }
        *previous = Some(message);
    }
    async fn read_snapshot(&self) -> windows::core::Result<Option<RawTrack>> {
        let sessions: Vec<Session> = match self.manager.GetSessions() {
            Ok(sessions) => sessions.into_iter().collect(),
            Err(error) => {
                self.disconnected.store(true, Ordering::Release);
                return Err(error);
            }
        };
        self.subscribe(&sessions)?;
        let current = self.manager.GetCurrentSession().ok();
        let now = epoch_ms();
        let mut candidates = Vec::new();
        let mut active_sessions = Vec::new();
        {
            let mut activity = self.activity.lock().unwrap_or_else(|e| e.into_inner());
            activity.retain(|id, _| sessions.iter().any(|s| s.as_raw() as usize == *id));
            for session in &sessions {
                let Ok(status) = session
                    .GetPlaybackInfo()
                    .and_then(|info| info.PlaybackStatus())
                else {
                    continue;
                };
                if !matches!(status, Status::Playing | Status::Paused) {
                    continue;
                }
                let Ok(app_id) = session.SourceAppUserModelId() else {
                    continue;
                };
                let app_id = app_id.to_string().to_lowercase();
                let source = if app_id.contains("spotify") {
                    Source::Spotify
                } else if app_id.contains("applemusic") || app_id.contains("apple-music") {
                    Source::AppleMusic
                } else {
                    Source::System
                };
                let sample_time = session
                    .GetTimelineProperties()
                    .and_then(|p| p.LastUpdatedTime())
                    .ok()
                    .filter(|time| time.UniversalTime > 116_444_736_000_000_000)
                    .map(|time| windows_sample_time(time.UniversalTime, now))
                    .unwrap_or(0.0);
                let last_active = activity
                    .entry(session.as_raw() as usize)
                    .or_insert(sample_time);
                if status == Status::Playing {
                    *last_active = now;
                }
                candidates.push(Candidate {
                    source,
                    is_playing: status == Status::Playing,
                    last_active_ms: *last_active,
                    is_current: current.as_ref() == Some(session),
                });
                active_sessions.push(session);
            }
        }
        let Some(selected) = select_candidate(&candidates) else {
            return Ok(None);
        };
        let session = active_sessions[selected];
        // Capture invalidation generation before the async metadata read, so changes during it are retried next time.
        let generation = self.art_generation.load(Ordering::Acquire);
        let properties = session.TryGetMediaPropertiesAsync()?.await?;
        let timeline = session.GetTimelineProperties()?;
        let status = session.GetPlaybackInfo()?.PlaybackStatus()?;
        if !matches!(status, Status::Playing | Status::Paused) {
            return Ok(None);
        }
        let start = timeline.StartTime()?.Duration;
        let duration_ms =
            timeline.EndTime()?.Duration.saturating_sub(start).max(0) as f64 / 10_000.0;
        let title = properties.Title()?.to_string();
        let artist = properties.Artist()?.to_string();
        let album = properties.AlbumTitle()?.to_string();
        let key = (
            session.as_raw() as usize,
            track_key(&artist, &title, &album, duration_ms),
            generation,
        );
        let thumbnail = properties.Thumbnail().ok();
        let artwork = self.artwork(key, thumbnail);
        Ok(Some(RawTrack {
            source: candidates[selected].source.clone(),
            title,
            artist,
            album,
            duration_ms,
            position_ms: timeline.Position()?.Duration.saturating_sub(start).max(0) as f64
                / 10_000.0,
            sampled_at: windows_sample_time(timeline.LastUpdatedTime()?.UniversalTime, epoch_ms()),
            is_playing: status == Status::Playing,
            artwork,
        }))
    }
    fn artwork(
        &self,
        key: (usize, String, u64),
        thumbnail: Option<IRandomAccessStreamReference>,
    ) -> Option<String> {
        {
            let mut cache = self.art.lock().unwrap_or_else(|e| e.into_inner());
            if cache.key.as_ref() == Some(&key)
                && !cache.retry_after.is_some_and(|time| Instant::now() >= time)
            {
                return cache.value.clone();
            }
            *cache = ArtCache {
                key: Some(key.clone()),
                value: None,
                retry_after: None,
            };
        }
        let thumbnail = thumbnail
            .as_ref()
            .and_then(|reference| AgileReference::new(reference).ok());
        let cache = self.art.clone();
        let wake = self.notify.clone();
        let mut worker = self.art_task.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = worker.take() {
            old.abort();
        }
        *worker = Some(tauri::async_runtime::spawn(async move {
            let result = tokio::time::timeout(Duration::from_secs(3), async {
                let reference = thumbnail.ok_or_else(|| "no artwork available".to_string())?;
                let bytes = read_thumbnail(reference).await.map_err(|e| e.to_string())?;
                tauri::async_runtime::spawn_blocking(move || artwork::to_data_url(&bytes))
                    .await
                    .map_err(|e| e.to_string())?
            })
            .await;
            let mut cache = cache.lock().unwrap_or_else(|e| e.into_inner());
            // A late decode may complete after a track switch; never attach it to the new song.
            if cache.key.as_ref() != Some(&key) {
                return;
            }
            match result {
                Ok(Ok(value)) => {
                    cache.value = Some(value);
                    wake.notify_one();
                }
                _ => cache.retry_after = Some(Instant::now() + Duration::from_secs(10)),
            }
        }));
        None
    }
}
#[async_trait]
impl MediaSource for WindowsSource {
    async fn snapshot(&self) -> Option<RawTrack> {
        match self.read_snapshot().await {
            Ok(value) => {
                *self.last_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
                value
            }
            Err(error) => {
                self.report_error(&error);
                None
            }
        }
    }
}
async fn read_thumbnail(
    reference: AgileReference<IRandomAccessStreamReference>,
) -> windows::core::Result<Vec<u8>> {
    // Resolve apartment-bound interfaces only in the thread where they are used; never assert Send manually.
    let open = reference.resolve()?.OpenReadAsync()?;
    let (reader, size) = {
        let stream = open.await?;
        let size = stream.Size()?;
        if size == 0 || size > artwork::MAX_ARTWORK_BYTES as u64 {
            return Err(windows::core::Error::new(
                windows::core::HRESULT(0x80070057u32 as i32),
                "artwork exceeds size limit or is empty",
            ));
        }
        (
            DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?,
            size,
        )
    };
    let count = reader.LoadAsync(size as u32)?.await?;
    if count != size as u32 {
        return Err(windows::core::Error::new(
            windows::core::HRESULT(0x80004005u32 as i32),
            "incomplete artwork stream",
        ));
    }
    let mut bytes = vec![0; count as usize];
    reader.ReadBytes(&mut bytes)?;
    Ok(bytes)
}
