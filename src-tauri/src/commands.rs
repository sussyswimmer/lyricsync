//! Settings remain an in-memory stub; media and lyrics are supplied by their services.
use crate::contract::*;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
#[derive(Default)]
pub struct AppState {
    pub settings: Mutex<Settings>,
    pub now_playing: Mutex<Option<NowPlaying>>,
}
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings.lock().map_err(|e| e.to_string())?.clone())
}
#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: serde_json::Value,
) -> Result<Settings, String> {
    let result = {
        let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
        let mut value = serde_json::to_value(&*settings).map_err(|e| e.to_string())?;
        let patch = patch.as_object().ok_or("patch must be an object")?;
        value
            .as_object_mut()
            .ok_or("invalid settings")?
            .extend(patch.clone());
        let next: Settings = serde_json::from_value(value).map_err(|e| e.to_string())?;
        if next.version != CONTRACT_VERSION {
            return Err("unsupported settings version".into());
        }
        if *settings == next {
            return Ok(next);
        }
        *settings = next;
        settings.clone()
    };
    #[cfg(target_os = "windows")]
    crate::desktop_layer::request_refresh();
    app.emit(SETTINGS_CHANGED_EVENT, &result)
        .map_err(|e| e.to_string())?;
    Ok(result)
}
#[tauri::command]
pub fn get_now_playing(state: State<'_, AppState>) -> Result<Option<NowPlaying>, String> {
    Ok(state.now_playing.lock().map_err(|e| e.to_string())?.clone())
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
pub fn set_track_offset(
    app: AppHandle,
    state: State<'_, AppState>,
    track_key: String,
    ms: f64,
) -> Result<Settings, String> {
    if !ms.is_finite() {
        return Err("offset must be finite".into());
    }
    let result = {
        let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings
            .track_offsets_ms
            .insert(track_key, ms.clamp(-2000.0, 2000.0));
        settings.clone()
    };
    #[cfg(target_os = "windows")]
    crate::desktop_layer::request_refresh();
    app.emit(SETTINGS_CHANGED_EVENT, &result)
        .map_err(|e| e.to_string())?;
    Ok(result)
}
#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("settings")
        .ok_or("settings window unavailable")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}
