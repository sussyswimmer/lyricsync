//! One controller for both OSes: a one-second async loop reconciles overlay windows with the
//! displays and settings, and the native adapter (`Native`) does the OS-specific work. Changes the
//! user makes (play/pause, "hide lyrics", showWhen/displays) wake it at once.
use super::{geometry::Bounds, is_overlay, plan, shown, DesktopLayer};
use crate::{
    contract::{Displays, Settings, ShowWhen},
    state::AppState,
};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::Notify;

#[cfg(target_os = "macos")]
type Native = super::macos::MacDesktop;
#[cfg(target_os = "windows")]
type Native = super::windows::WindowsDesktop;
type Target = <Native as DesktopLayer>::Target;

static DIRTY: AtomicBool = AtomicBool::new(true);
static PLAYING: AtomicBool = AtomicBool::new(false);
static WAKE: Notify = Notify::const_new();

/// Re-applies the desktop layer on the next tick (at most a second away), so a burst of OS
/// notifications (display, DPI, wake, Explorer restarts, Spaces) settles into one pass. Safe from
/// any thread; the native hooks call it.
pub fn request_refresh() {
    DIRTY.store(true, Ordering::Release);
}
/// Re-applies the desktop layer now, for a change the user is waiting to see: settings
/// (showWhen, displays) and the tray's "hide lyrics" toggle. Safe from any thread.
pub fn refresh_now() {
    request_refresh();
    WAKE.notify_one();
}
fn take_refresh() -> bool {
    DIRTY.swap(false, Ordering::AcqRel)
}
/// The media loop calls this on every update; a change of playback state refreshes at once.
pub fn set_playing(playing: bool) {
    if PLAYING.swap(playing, Ordering::AcqRel) != playing {
        refresh_now();
    }
}

/// For `undertone --diagnose`: what the adapter finds right now. Needs no running app, but on
/// Windows it asks Explorer for the WorkerW (up to a second).
pub fn describe() -> Result<String, String> {
    Native::discover().map(Native::describe)
}

pub fn start(app: &AppHandle) -> Result<(), String> {
    Native::install_notifications(app)?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut target: Option<Target> = None;
        let mut previous_error = None;
        loop {
            tokio::select! {
                _ = interval.tick() => {}
                _ = WAKE.notified() => {}
            }
            if !take_refresh() && target.is_some_and(Native::is_valid) {
                continue;
            }
            let found = tauri::async_runtime::spawn_blocking(Native::discover).await;
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
                    target = None; // Retry on the next tick; Explorer or a display may still be starting.
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

/// Runs only on Tauri's event-loop thread. Hidden overlays are shown only after successful attachment.
fn reattach_all(app: &AppHandle, target: Target) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut settings: Settings = state.settings.lock().map_err(|e| e.to_string())?.clone();
    let lyrics_hidden = state.lyrics_hidden.load(Ordering::Acquire);
    let test_page =
        cfg!(debug_assertions) && std::env::args().any(|arg| arg == "--desktop-layer-test");
    if test_page {
        settings.show_when = ShowWhen::Always;
    }
    if cfg!(debug_assertions) && std::env::args().any(|arg| arg == "--desktop-layer-all") {
        settings.displays = Displays::All;
    }
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let all: Vec<Bounds> = monitors.iter().map(Native::area).collect();
    let primary = app.primary_monitor().map_err(|e| e.to_string())?;
    let primary_index = primary
        .as_ref()
        .and_then(|p| all.iter().position(|m| *m == Native::area(p)));
    let planned = plan(&settings.displays, &all, primary_index);
    for (label, window) in app.webview_windows() {
        if is_overlay(&label) && !planned.iter().any(|(_, kept)| *kept == label) {
            Native::detach(&window)?;
            window.destroy().map_err(|e| e.to_string())?;
        }
    }
    let show = shown(
        &settings.show_when,
        PLAYING.load(Ordering::Acquire),
        lyrics_hidden,
    );
    for (index, label) in planned {
        let window = match app.get_webview_window(&label) {
            Some(window) => window,
            None => WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
                .title("Undertone")
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .skip_taskbar(true)
                .focused(false)
                // Never focusable, like the `overlay` window in tauri.conf.json. macOS: never key,
                // so showing an overlay can't take focus from Settings (set at creation because
                // tao's set_focusable leaks a retain). Windows: tao rebuilds the extended style
                // from its own flags on every show and hide, and keeps WS_EX_NOACTIVATE only for
                // a window it knows is not focusable.
                .focusable(false)
                .resizable(false)
                .visible(false)
                .build()
                .map_err(|e| e.to_string())?,
        };
        if Native::HIDE_WHILE_ATTACHING {
            window.hide().map_err(|e| e.to_string())?;
        }
        Native::attach(&window, &monitors[index], target)?;
        if show {
            window.show().map_err(|e| e.to_string())?;
        } else if !Native::HIDE_WHILE_ATTACHING {
            window.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
