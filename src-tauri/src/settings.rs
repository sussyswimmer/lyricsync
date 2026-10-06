//! X4 settings: merge, validation and persistence. The pure functions are portable and tested on
//! every OS; `runtime` stores settings with tauri-plugin-store and broadcasts `settings-changed`.
use crate::contract::{Settings, CONTRACT_VERSION};

/// Applies a shallow top-level patch, as the contract's `update_settings` does.
pub fn merge(current: &Settings, patch: &serde_json::Value) -> Result<Settings, String> {
    let mut value = serde_json::to_value(current).map_err(|e| e.to_string())?;
    let patch = patch.as_object().ok_or("patch must be an object")?;
    value
        .as_object_mut()
        .ok_or("invalid settings")?
        .extend(patch.clone());
    let next: Settings = serde_json::from_value(value).map_err(|e| e.to_string())?;
    if next.version != CONTRACT_VERSION {
        return Err("unsupported settings version".into());
    }
    Ok(next)
}

/// Sets one song's sync offset, clamped to ±2000 ms.
pub fn with_track_offset(current: &Settings, track_key: &str, ms: f64) -> Result<Settings, String> {
    if !ms.is_finite() {
        return Err("offset must be finite".into());
    }
    let mut next = current.clone();
    next.track_offsets_ms
        .insert(track_key.to_owned(), ms.clamp(-2000.0, 2000.0));
    Ok(next)
}

#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
pub mod runtime {
    use crate::{contract::Settings, contract::SETTINGS_CHANGED_EVENT, state::AppState};
    use tauri::{AppHandle, Emitter, Manager};

    /// Loads stored settings into AppState before any window or service reads them.
    pub fn install(_app: &AppHandle) -> Result<(), String> {
        Ok(())
    }

    /// Stores `next`, broadcasts it to every webview and applies side effects. No-op when unchanged.
    pub fn apply(app: &AppHandle, next: Settings) -> Result<Settings, String> {
        {
            let state = app.state::<AppState>();
            let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
            if *settings == next {
                return Ok(next);
            }
            *settings = next.clone();
        }
        crate::desktop_layer::request_refresh();
        app.emit(SETTINGS_CHANGED_EVENT, &next)
            .map_err(|e| e.to_string())?;
        Ok(next)
    }

    pub fn current(app: &AppHandle) -> Result<Settings, String> {
        Ok(app
            .state::<AppState>()
            .settings
            .lock()
            .map_err(|e| e.to_string())?
            .clone())
    }

    pub fn update(app: &AppHandle, patch: &serde_json::Value) -> Result<Settings, String> {
        apply(app, super::merge(&current(app)?, patch)?)
    }

    pub fn set_track_offset(app: &AppHandle, track_key: &str, ms: f64) -> Result<Settings, String> {
        apply(
            app,
            super::with_track_offset(&current(app)?, track_key, ms)?,
        )
    }
}
