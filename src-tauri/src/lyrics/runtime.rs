use super::{cache::Cache, lrclib::LrcLib, Service, Track};
use crate::contract::{NowPlaying, LYRICS_EVENT};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

pub fn install(app: &AppHandle) -> Result<(), String> {
    let cache = Cache::new(app.path().app_data_dir().map_err(|e| e.to_string())?);
    let service = Service::new(Arc::new(LrcLib::new()?), cache);
    let mut events = service.subscribe();
    app.manage(service);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(lyrics) => {
                    if cfg!(debug_assertions) && std::env::args().any(|arg| arg == "--media-test") {
                        eprintln!(
                            "lyrics: status={:?} source={:?}",
                            lyrics.status, lyrics.source
                        );
                    }
                    if let Err(error) = app.emit(LYRICS_EVENT, &lyrics) {
                        eprintln!("lyrics event failed: {error}");
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => eprintln!(
                    "lyrics event consumer lagged by {count}; clients can query get_lyrics"
                ),
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    Ok(())
}
pub fn track_changed(app: &AppHandle, track: &NowPlaying) {
    app.state::<Arc<Service>>()
        .inner()
        .start(Track::from(track), false);
}
