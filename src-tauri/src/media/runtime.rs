use super::{windows::WindowsSource, MediaSource, Watcher};
use crate::{commands::AppState, contract::NOW_PLAYING_EVENT, desktop_layer};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let wake = Arc::new(Notify::new());
        let mut watcher = Watcher::default();
        let mut source: Option<WindowsSource> = None;
        let started = Instant::now();
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut connection_error = None;
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if let Some(update) = watcher.resync(started.elapsed().as_millis() as u64) {
                        emit(&app, update);
                    }
                },
                _ = wake.notified() => {}
            }
            if source.is_none() {
                match tokio::time::timeout(
                    Duration::from_secs(3),
                    WindowsSource::connect(wake.clone()),
                )
                .await
                {
                    Ok(Ok(connected)) => {
                        source = Some(connected);
                        connection_error = None;
                    }
                    result => {
                        let message = match result {
                            Ok(Err(error)) => error.to_string(),
                            _ => "SMTC connection timed out".into(),
                        };
                        if connection_error.as_ref() != Some(&message) {
                            eprintln!("SMTC connection unavailable: {message}");
                        }
                        connection_error = Some(message);
                        publish(
                            &app,
                            &mut watcher,
                            None,
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
                let pending = tokio::time::timeout(Duration::from_secs(2), connected.snapshot());
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
                started.elapsed().as_millis() as u64,
            );
            if reconnect {
                source = None;
            }
        }
    });
}
fn publish(app: &AppHandle, watcher: &mut Watcher, raw: Option<super::RawTrack>, elapsed_ms: u64) {
    let update = watcher.update(raw, elapsed_ms);
    let state = app.state::<AppState>();
    *state.now_playing.lock().unwrap_or_else(|e| e.into_inner()) = watcher.current().clone();
    if let Some(update) = update {
        emit(app, update);
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
    if let Err(error) = app.emit(NOW_PLAYING_EVENT, &update.now_playing) {
        eprintln!("now-playing event: {error}");
    }
    // X3 will consume update.track_changed to begin lyrics lookup; lyrics remain an explicit stub.
}
