use super::{
    monitor_indices, visible,
    windows::{self, Target, WindowsDesktop},
    DesktopLayer,
};
use crate::{
    commands::AppState,
    contract::{Displays, Settings, ShowWhen},
};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

static PLAYING: AtomicBool = AtomicBool::new(false);
pub fn request_refresh() {
    windows::request_refresh();
}
/// X2's media watcher should call this whenever playback state changes.
pub fn set_playing(playing: bool) {
    if PLAYING.swap(playing, Ordering::AcqRel) != playing {
        request_refresh();
    }
}

pub fn start(app: &AppHandle) -> Result<(), String> {
    let anchor = app
        .get_webview_window("settings")
        .ok_or("settings notification window missing")?;
    // Keep this hidden top-level window alive: child overlays do not receive TaskbarCreated broadcasts.
    windows::install_notifications(&anchor)?;
    let hidden = anchor.clone();
    anchor.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Err(error) = hidden.hide() {
                eprintln!("settings hide: {error}");
            }
        }
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut target: Option<Target> = None;
        let mut previous_error = None;
        loop {
            interval.tick().await;
            if !windows::take_refresh() && target.is_some_and(Target::is_valid) {
                continue;
            }
            let found = tauri::async_runtime::spawn_blocking(WindowsDesktop::discover).await;
            let result = match found {
                Ok(Ok(found)) => {
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    let handle = app.clone();
                    if app
                        .run_on_main_thread(move || {
                            let _ = tx.send(reattach_all(&handle, found));
                        })
                        .is_err()
                    {
                        break;
                    }
                    match rx.await {
                        Ok(Ok(())) => {
                            target = Some(found);
                            Ok(())
                        }
                        Ok(Err(error)) => Err(error),
                        Err(_) => break,
                    }
                }
                Ok(Err(error)) => Err(error),
                Err(error) => Err(error.to_string()),
            };
            match result {
                Ok(()) => previous_error = None,
                Err(error) => {
                    target = None; // Retry on the next tick; Explorer may still be starting.
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        for (label, window) in handle.webview_windows() {
                            if is_overlay(&label) {
                                let _ = window.hide();
                            }
                        }
                    });
                    if previous_error.as_ref() != Some(&error) {
                        eprintln!("desktop layer: {error}");
                    }
                    previous_error = Some(error);
                }
            }
        }
    });
    Ok(())
}
fn is_overlay(label: &str) -> bool {
    label == "overlay" || label.starts_with("overlay-")
}

/// Runs only on Tauri's event-loop thread. Hidden overlays are shown only after successful attachment.
fn reattach_all(app: &AppHandle, target: Target) -> Result<(), String> {
    let mut settings: Settings = app
        .state::<AppState>()
        .settings
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let test_page =
        cfg!(debug_assertions) && std::env::args().any(|arg| arg == "--desktop-layer-test");
    if test_page {
        settings.show_when = ShowWhen::Always;
    }
    if cfg!(debug_assertions) && std::env::args().any(|arg| arg == "--desktop-layer-all") {
        settings.displays = Displays::All;
    }
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let primary = app.primary_monitor().map_err(|e| e.to_string())?;
    let primary_index = primary.as_ref().and_then(|p| {
        monitors
            .iter()
            .position(|m| m.position() == p.position() && m.size() == p.size())
    });
    let indices = monitor_indices(&settings.displays, monitors.len(), primary_index);
    let labels: Vec<_> = indices
        .iter()
        .map(|i| {
            if settings.displays == Displays::Primary {
                "overlay".into()
            } else {
                format!("overlay-{i}")
            }
        })
        .collect();
    for (label, window) in app.webview_windows() {
        if is_overlay(&label) && !labels.contains(&label) {
            WindowsDesktop::detach(&window)?;
            window.destroy().map_err(|e| e.to_string())?;
        }
    }
    for (index, label) in indices.into_iter().zip(labels) {
        let window = match app.get_webview_window(&label) {
            Some(window) => window,
            None => WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
                .title("Undertone")
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .skip_taskbar(true)
                .focused(false)
                .resizable(false)
                .visible(false)
                .build()
                .map_err(|e| e.to_string())?,
        };
        window.hide().map_err(|e| e.to_string())?;
        WindowsDesktop::attach(&window, &monitors[index], target)?;
        if visible(&settings.show_when, PLAYING.load(Ordering::Acquire)) {
            window.show().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
