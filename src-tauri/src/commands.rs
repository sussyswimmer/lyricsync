//! Every command in contract v3. Settings go through `settings::runtime`; media and lyrics come
//! from their services, shortcut registration from `shortcuts`.
//!
//! A plain `#[tauri::command] fn` runs on the main thread, behind every window operation (and on
//! macOS behind the player scripts, up to 2 s each). Only the commands that work windows stay
//! there; reads answer from the async runtime, and changes that write settings.json run on the
//! blocking pool, so a slow disk never stalls the windows.
use crate::contract::*;
pub use crate::state::AppState;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

/// Runs `work`, which writes to disk, on the blocking pool and waits for it.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
pub fn get_settings(app: AppHandle) -> Result<Settings, String> {
    crate::settings::runtime::current(&app)
}
#[tauri::command]
pub async fn update_settings(app: AppHandle, patch: serde_json::Value) -> Result<Settings, String> {
    blocking(move || crate::settings::runtime::update(&app, &patch)).await
}
#[tauri::command(async)]
pub fn get_now_playing(state: State<'_, AppState>) -> Result<Option<NowPlaying>, String> {
    Ok(state.now_playing.lock().map_err(|e| e.to_string())?.clone())
}
#[tauri::command(async)]
pub fn get_media_status(state: State<'_, AppState>) -> Result<MediaStatus, String> {
    Ok(state
        .media_status
        .lock()
        .map_err(|e| e.to_string())?
        .clone())
}
#[tauri::command(async)]
pub fn get_shortcuts_status(state: State<'_, AppState>) -> Result<ShortcutsStatus, String> {
    Ok(state
        .shortcuts_status
        .lock()
        .map_err(|e| e.to_string())?
        .clone())
}
/// Settings suspends the global shortcuts while its key recorder listens. Returns once they are
/// unregistered (or registered again), which waits for the main thread, so never on it.
#[tauri::command]
pub async fn suspend_shortcuts(app: AppHandle, suspended: bool) -> Result<(), String> {
    crate::shortcuts::suspend(&app, suspended).await
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
pub async fn set_track_offset(
    app: AppHandle,
    track_key: String,
    ms: f64,
) -> Result<Settings, String> {
    blocking(move || crate::settings::runtime::set_track_offset(&app, &track_key, ms)).await
}
#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<(), String> {
    show_settings(&app)
}
#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}

/// Shows and focuses the settings window (command, tray, second launch). Its page becomes visible
/// with it: on Windows WebView2 no longer tracks that itself (see `desktop_layer::set_shown`).
/// Launch at login first takes the OS login item's state, which the user may have changed there.
pub fn show_settings(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("settings")
        .ok_or("settings window unavailable")?;
    crate::settings::runtime::sync_login_item(app);
    window.unminimize().map_err(|e| e.to_string())?;
    crate::desktop_layer::set_shown(&window, true)?;
    window.set_focus().map_err(|e| e.to_string())
}
/// Debug `--overlay-probe`: each webview reports its visibility and frame rate (see `lib.rs`).
#[tauri::command]
pub fn debug_probe(webview: tauri::Webview, message: String) {
    if cfg!(debug_assertions) {
        eprintln!("probe[{}]: {message}", webview.label());
    }
}
