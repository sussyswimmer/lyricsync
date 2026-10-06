//! One now-playing loop for every OS. A `Backend` connects, takes snapshots and wakes the loop on
//! OS notifications; the loop owns the 1 s resync, the Watcher and publishing, `media-status`
//! included.
use super::{media_status, MediaSource, Presence, Watcher};
use crate::{
    contract::{MEDIA_STATUS_EVENT, NOW_PLAYING_EVENT},
    desktop_layer,
    state::AppState,
};
use async_trait::async_trait;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

#[cfg(target_os = "macos")]
type Native = super::macos::MacSource;
#[cfg(target_os = "windows")]
type Native = super::windows::WindowsSource;

/// One OS's now-playing adapter.
#[async_trait]
pub(super) trait Backend: MediaSource + Sized + 'static {
    /// Names the adapter in logs.
    const NAME: &'static str;
    /// A snapshot that takes longer drops the connection; the next loop reconnects.
    const SNAPSHOT_TIMEOUT: Duration;
    /// While nothing plays, snapshot on every Nth 1 s tick and rely on wake notifications.
    const IDLE_TICKS: u32;
    /// Connects and registers the OS notifications that call `wake.notify_one()`.
    async fn connect(app: &AppHandle, wake: Arc<Notify>) -> Result<Self, String>;
    /// True once the OS connection is gone and `connect` must run again.
    fn is_disconnected(&self) -> bool;
}

pub fn start(app: &AppHandle) {
    run::<Native>(app.clone());
}
fn run<S: Backend>(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let wake = Arc::new(Notify::new());
        let mut watcher = Watcher::default();
        let mut source: Option<S> = None;
        let started = Instant::now();
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut connection_error = None;
        let mut idle_ticks = 0;
        loop {
            let woken = tokio::select! {
                _ = interval.tick() => {
                    if let Some(update) = watcher.resync(started.elapsed().as_millis() as u64) {
                        emit(&app, update);
                    }
                    false
                },
                _ = wake.notified() => true,
            };
            let playing = watcher
                .current()
                .as_ref()
                .is_some_and(|track| track.is_playing);
            if !woken && !playing && source.is_some() {
                idle_ticks += 1;
                if idle_ticks < S::IDLE_TICKS {
                    continue;
                }
            }
            idle_ticks = 0;
            if source.is_none() {
                match tokio::time::timeout(Duration::from_secs(3), S::connect(&app, wake.clone()))
                    .await
                {
                    Ok(Ok(connected)) => {
                        source = Some(connected);
                        connection_error = None;
                    }
                    result => {
                        let message = match result {
                            Ok(Err(error)) => error,
                            _ => format!("{} connection timed out", S::NAME),
                        };
                        if connection_error.as_ref() != Some(&message) {
                            eprintln!("{} connection unavailable: {message}", S::NAME);
                        }
                        connection_error = Some(message);
                        publish(
                            &app,
                            &mut watcher,
                            None,
                            &Presence::NoPlayer,
                            started.elapsed().as_millis() as u64,
                        );
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        continue;
                    }
                }
            }
            let Some(connected) = source.as_ref() else {
                continue;
            };
            let snapshot = {
                let pending = tokio::time::timeout(S::SNAPSHOT_TIMEOUT, connected.snapshot());
                tokio::pin!(pending);
                loop {
                    tokio::select! {
                        result = &mut pending => break result,
                        _ = interval.tick() => {
                            if let Some(update) = watcher.resync(started.elapsed().as_millis() as u64) {
                                emit(&app, update);
                            }
                        }
                    }
                }
            };
            let reconnect = connected.is_disconnected() || snapshot.is_err();
            publish(
                &app,
                &mut watcher,
                snapshot.unwrap_or(None),
                &connected.presence(),
                started.elapsed().as_millis() as u64,
            );
            if reconnect {
                source = None;
            }
        }
    });
}
/// `now-playing` first, then `media-status` when it changed, so a status never names a track
/// the webviews haven't heard about yet.
fn publish(
    app: &AppHandle,
    watcher: &mut Watcher,
    raw: Option<super::RawTrack>,
    presence: &Presence,
    elapsed_ms: u64,
) {
    let update = watcher.update(raw, elapsed_ms);
    let state = app.state::<AppState>();
    *state.now_playing.lock().unwrap_or_else(|e| e.into_inner()) = watcher.current().clone();
    if let Some(update) = update {
        emit(app, update);
    }
    let status = media_status(watcher.current().as_ref(), presence);
    let previous = std::mem::replace(
        &mut *state.media_status.lock().unwrap_or_else(|e| e.into_inner()),
        status.clone(),
    );
    if previous == status {
        return;
    }
    if cfg!(debug_assertions) && std::env::args().any(|arg| arg == "--media-test") {
        eprintln!(
            "media-status: {}",
            serde_json::to_string(&status).unwrap_or_default()
        );
    }
    if let Err(error) = app.emit(MEDIA_STATUS_EVENT, &status) {
        eprintln!("media-status event: {error}");
    }
}
fn emit(app: &AppHandle, update: super::Update) {
    if cfg!(debug_assertions) && std::env::args().any(|arg| arg == "--media-test") {
        let diagnostic = update.now_playing.as_ref().map(|track| {
            serde_json::json!({
                "source": track.source, "trackKey": track.track_key,
                "positionMs": track.position_ms, "sampledAt": track.sampled_at,
                "durationMs": track.duration_ms, "isPlaying": track.is_playing,
                "artworkBytes": track.artwork.as_ref().map(String::len),
                "trackChanged": update.track_changed, "seek": update.seek,
            })
        });
        eprintln!(
            "now-playing: {}",
            serde_json::to_string(&diagnostic).unwrap_or_default()
        );
    }
    desktop_layer::set_playing(
        update
            .now_playing
            .as_ref()
            .is_some_and(|track| track.is_playing),
    );
    if update.track_changed {
        if let Some(track) = update.now_playing.as_ref() {
            crate::lyrics::runtime::track_changed(app, track);
        }
    }
    if let Err(error) = app.emit(NOW_PLAYING_EVENT, &update.now_playing) {
        eprintln!("now-playing event: {error}");
    }
}
