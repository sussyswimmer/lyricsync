//! Every command in contract v2. Settings go through `settings::runtime`; media and lyrics come
//! from their services.
use crate::contract::*;
pub use crate::state::AppState;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<Settings, String> {
    crate::settings::runtime::current(&app)
}
#[tauri::command]
pub fn update_settings(app: AppHandle, patch: serde_json::Value) -> Result<Settings, String> {
    crate::settings::runtime::update(&app, &patch)
}
#[tauri::command]
pub fn get_now_playing(state: State<'_, AppState>) -> Result<Option<NowPlaying>, String> {
    Ok(state.now_playing.lock().map_err(|e| e.to_string())?.clone())
}
#[tauri::command]
pub fn get_media_status(state: State<'_, AppState>) -> Result<MediaStatus, String> {
    Ok(state
        .media_status
        .lock()
        .map_err(|e| e.to_string())?
        .clone())
}
#[tauri::command]
pub async fn get_lyrics(
    service: State<'_, Arc<crate::lyrics::Service>>,
    track_key: String,
) -> Result<Lyrics, String> {
    Ok(service.inner().get(&track_key).await)
}
#[tauri::command]
pub async fn refetch_lyrics(
    service: State<'_, Arc<crate::lyrics::Service>>,
    track_key: String,
) -> Result<(), String> {
    service.inner().refetch(&track_key)
}
#[tauri::command]
pub fn set_track_offset(app: AppHandle, track_key: String, ms: f64) -> Result<Settings, String> {
    crate::settings::runtime::set_track_offset(&app, &track_key, ms)
}
#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<(), String> {
    show_settings(&app)
}
#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}

/// Shows and focuses the settings window (command, tray, second launch).
pub fn show_settings(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("settings")
        .ok_or("settings window unavailable")?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
