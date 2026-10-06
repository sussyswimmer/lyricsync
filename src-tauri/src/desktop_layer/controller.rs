//! One controller for both OSes: a one-second async loop reconciles overlay windows with the
//! displays and settings, and the native adapter (`Native`) does the OS-specific work. Changes the
//! user makes (play/pause, "hide lyrics", showWhen/displays) wake it at once.
use super::{
    geometry::Bounds, is_overlay, pass, plan, shown, steps, DesktopLayer, Pass,
    WEBVIEW2_BROWSER_ARGS,
};
use crate::{
    contract::{Displays, Settings, ShowWhen},
    state::AppState,
};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{
    utils::config::BackgroundThrottlingPolicy, AppHandle, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tokio::sync::Notify;

#[cfg(target_os = "macos")]
type Native = super::macos::MacDesktop;
#[cfg(target_os = "windows")]
type Native = super::windows::WindowsDesktop;
type Target = <Native as DesktopLayer>::Target;

static DIRTY: AtomicBool = AtomicBool::new(true);
static PLAYBACK_CHANGED: AtomicBool = AtomicBool::new(false);
static PLAYING: AtomicBool = AtomicBool::new(false);
static WAKE: Notify = Notify::const_new();

/// Re-applies the desktop layer on the next tick (at most a second away), so a burst of OS
/// notifications (display, DPI, work area, wake, Explorer restarts, Spaces) settles into one pass.
/// Safe from any thread; the native hooks call it.
pub fn request_refresh() {
    DIRTY.store(true, Ordering::Release);
}
/// Re-applies the desktop layer now, for a change the user is waiting to see: settings
/// (showWhen, displays) and the tray's "hide lyrics" toggle. Safe from any thread.
pub fn refresh_now() {
    request_refresh();
    WAKE.notify_one();
}
/// The media loop calls this on every update. A change of playback state reconciles at once
/// against the desktop already found: overlays whose shown state changes are shown or hidden,
/// and nothing else is touched.
pub fn set_playing(playing: bool) {
    if PLAYING.swap(playing, Ordering::AcqRel) != playing {
        PLAYBACK_CHANGED.store(true, Ordering::Release);
        WAKE.notify_one();
    }
}

/// Shows or hides a window together with its page, so the renderer's loop (which pauses while
/// `document.visibilityState` is "hidden") runs exactly while the window is shown. Every overlay
/// and the Settings window go through here. Page first when showing, so the first frame on screen
/// is a fresh one; window first when hiding.
pub fn set_shown(window: &WebviewWindow, shown: bool) -> Result<(), String> {
    if shown {
        Native::set_page_visible(window, true)?;
        window.show().map_err(|e| e.to_string())
    } else {
        window.hide().map_err(|e| e.to_string())?;
        Native::set_page_visible(window, false)
    }
}

/// Follows a window being minimized or restored (Settings): a minimized window's page is hidden,
/// a shown one's visible. A hidden window is left alone, because `set_shown` owns that state and
/// this may run between its two halves.
pub fn sync_page_visibility(window: &WebviewWindow) -> Result<(), String> {
    if window.is_minimized().map_err(|e| e.to_string())? {
        Native::set_page_visible(window, false)
    } else if window.is_visible().map_err(|e| e.to_string())? {
        Native::set_page_visible(window, true)
    } else {
        Ok(())
    }
}

/// For `undertone --diagnose`: what the adapter finds right now. Needs no running app, but on
/// Windows it asks Explorer for the WorkerW (up to a second).
pub fn describe() -> Result<String, String> {
    Native::discover().map(Native::describe)
}

pub fn start(app: &AppHandle) -> Result<(), String> {
    Native::install_notifications(app)?;
    // The overlay windows from tauri.conf.json exist already: hidden, but a WebView2 page starts
    // out visible.
    for (label, window) in app.webview_windows() {
        if is_overlay(&label) {
            if let Err(error) = set_shown(&window, false) {
                eprintln!("desktop layer: {label} page: {error}");
            }
        }
    }
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
            let refresh = DIRTY.swap(false, Ordering::AcqRel);
            let playback = PLAYBACK_CHANGED.swap(false, Ordering::AcqRel);
            let found = match (
                pass(refresh, playback, target.is_some_and(Native::is_valid)),
                target,
            ) {
                (None, _) => continue,
                (Some(Pass::Reuse), Some(known)) => Ok(known),
                (Some(_), _) => {
                    match tauri::async_runtime::spawn_blocking(Native::discover).await {
                        Ok(found) => found,
                        Err(error) => Err(error.to_string()),
                    }
                }
            };
            let result = match found {
                Ok(found) => {
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    let handle = app.clone();
                    if app
                        .run_on_main_thread(move || {
                            let _ = tx.send(reconcile(&handle, found));
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
                Err(error) => Err(error),
            };
            match result {
                Ok(()) => previous_error = None,
                Err(error) => {
                    target = None; // Retry on the next tick; Explorer or a display may still be starting.
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        for (label, window) in handle.webview_windows() {
                            if is_overlay(&label) {
                                let _ = set_shown(&window, false);
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

/// A runtime overlay for `displays: all`, configured like the `overlay` window in tauri.conf.json.
fn build_overlay(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Undertone")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .skip_taskbar(true)
        .focused(false)
        // Never focusable, like the `overlay` window in tauri.conf.json. macOS: never key, so
        // showing an overlay can't take focus from Settings (set at creation because tao's
        // set_focusable leaks a retain). Windows: tao rebuilds the extended style from its own
        // flags on every show and hide, and keeps WS_EX_NOACTIVATE only for a window it knows is
        // not focusable.
        .focusable(false)
        .resizable(false)
        .visible(false)
        // Windows: the same arguments as every other webview, or WebView2 refuses to create it.
        .additional_browser_args(WEBVIEW2_BROWSER_ARGS)
        // macOS 14+: WebKit never suspends a hidden overlay's page, so it keeps up with events and
        // reappears current. Other OSes ignore it.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .build()
        .map_err(|e| e.to_string())?;
    // Hidden, but a WebView2 page starts out visible.
    set_shown(&window, false)?;
    Ok(window)
}

/// Runs only on Tauri's event-loop thread. Hidden overlays are shown only after successful
/// attachment, and an overlay that is already where it belongs is not touched beyond its shown
/// state (see `steps`).
fn reconcile(app: &AppHandle, target: Target) -> Result<(), String> {
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
            set_shown(&window, false)?;
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
        let monitor = &monitors[index];
        let window = match app.get_webview_window(&label) {
            Some(window) => window,
            None => build_overlay(app, &label)?,
        };
        let visible = window.is_visible().map_err(|e| e.to_string())?;
        let attachment = Native::attachment(&window, monitor, target);
        let todo = steps(attachment, visible, show, Native::HIDE_WHILE_ATTACHING);
        if todo.hide_first {
            set_shown(&window, false)?;
        }
        if todo.attach {
            Native::attach(&window, monitor, target)?;
        }
        if todo.show_after {
            set_shown(&window, true)?;
            if test_page {
                eprintln!("desktop layer: {label} shown, {}", Native::report(&window));
            }
        }
        if todo.attach
            && cfg!(debug_assertions)
            && std::env::args().any(|arg| arg == "--overlay-probe")
        {
            eprintln!(
                "probe[{label}]: attached show={show} visible={:?} {}",
                window.is_visible(),
                Native::debug_state(&window)
            );
        }
    }
    Ok(())
}
