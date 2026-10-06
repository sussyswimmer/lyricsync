//! Portable policy plus one controller that drives the native adapters (Windows, macOS) through
//! the `DesktopLayer` trait. See docs/DESKTOP_LAYER.md.
use crate::contract::{Displays, ShowWhen};

pub mod geometry;
pub mod styles;
use geometry::Bounds;

/// WebView2 browser arguments for every webview in the app: the `overlay` and `settings` windows
/// in tauri.conf.json (a test checks they match) and the `overlay-<n>` windows the controller
/// builds. WebView2 refuses a second set of arguments for the same user-data folder, and setting
/// them replaces wry's defaults, so the first three features repeat those.
///
/// `CalculateNativeWinOcclusion` is off because an overlay sits under every app window: Chromium
/// would report it occluded and the renderer would stop drawing (it pauses while
/// `document.visibilityState` is "hidden"). Without it a hidden window's page stays visible too,
/// so `set_shown` hides the page itself (ICoreWebView2Controller::SetIsVisible). wry's default
/// autoplay flag is not kept: nothing in Undertone plays media.
pub const WEBVIEW2_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion";

pub fn visible(show_when: &ShowWhen, is_playing: bool) -> bool {
    *show_when == ShowWhen::Always || is_playing
}

/// Whether attached overlays are shown: the `showWhen` rule, unless the tray or the
/// Cmd/Ctrl+Alt+Shift+L shortcut has hidden the lyrics.
pub fn shown(show_when: &ShowWhen, is_playing: bool, lyrics_hidden: bool) -> bool {
    visible(show_when, is_playing) && !lyrics_hidden
}

pub fn monitor_indices(displays: &Displays, count: usize, primary: Option<usize>) -> Vec<usize> {
    match displays {
        Displays::All => (0..count).collect(),
        Displays::Primary => primary
            .filter(|i| *i < count)
            .or((count > 0).then_some(0))
            .into_iter()
            .collect(),
    }
}

pub fn is_overlay(label: &str) -> bool {
    label == "overlay" || label.starts_with("overlay-")
}

/// The overlays to keep: (index into `monitors`, window label). `primary` uses the `overlay`
/// window; `all` uses `overlay-<n>`, one per distinct monitor origin. Displays only share an
/// origin when they mirror each other (macOS lists every display of a software mirror set, and
/// the members' sizes can differ), and one overlay there is enough.
pub fn plan(
    displays: &Displays,
    monitors: &[Bounds],
    primary: Option<usize>,
) -> Vec<(usize, String)> {
    let origin = |(x, y, _, _): &Bounds| (*x, *y);
    let indices = monitor_indices(displays, monitors.len(), primary).into_iter();
    match displays {
        Displays::Primary => indices.map(|i| (i, "overlay".to_owned())).collect(),
        Displays::All => indices
            .filter(|&i| {
                monitors
                    .iter()
                    .position(|m| origin(m) == origin(&monitors[i]))
                    == Some(i)
            })
            .map(|i| (i, format!("overlay-{i}")))
            .collect(),
    }
}

/// What starts a reconcile pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pass {
    /// Find the desktop again, then reconcile: settings, Hide lyrics, OS notifications, startup,
    /// or a desktop that disappeared.
    Full,
    /// Reconcile against the desktop found last time: play/pause, which mustn't wait on Explorer.
    Reuse,
}

/// `refresh`: a full refresh was requested. `playback`: play/pause changed. `target_valid`: the
/// last desktop found is still there.
pub fn pass(refresh: bool, playback: bool, target_valid: bool) -> Option<Pass> {
    if refresh || !target_valid {
        Some(Pass::Full)
    } else if playback {
        Some(Pass::Reuse)
    } else {
        None
    }
}

/// How an existing overlay hangs on the desktop layer, as the native adapter finds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attachment {
    /// Where `attach` put it: right parent or level, frame and z-order. Left alone.
    Placed,
    /// On this desktop layer, but its frame, z-order or styles are off: re-attached in place.
    Misplaced,
    /// Not on this desktop layer (new, or Explorer restarted): attached from scratch.
    Detached,
}

/// What one pass does to one overlay, in this order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Steps {
    pub hide_first: bool,
    pub attach: bool,
    pub show_after: bool,
}

/// A placed overlay is never re-attached, and a window is shown or hidden only when that changes,
/// so play/pause with `showWhen: always` leaves the overlay alone instead of blinking it.
/// `hide_while_attaching`: Windows reparents hidden windows only; moving a child within its
/// parent, or restyling on macOS, happens in place.
pub fn steps(
    attachment: Attachment,
    visible: bool,
    show: bool,
    hide_while_attaching: bool,
) -> Steps {
    let reparent = attachment == Attachment::Detached && hide_while_attaching;
    let hide_first = visible && (!show || reparent);
    Steps {
        hide_first,
        attach: attachment != Attachment::Placed,
        show_after: show && (!visible || hide_first),
    }
}

#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
mod controller;
#[cfg(all(feature = "desktop", target_os = "macos"))]
mod macos;
#[cfg(all(feature = "desktop", target_os = "windows"))]
mod windows;
#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
pub use controller::{
    describe, refresh_now, request_refresh, set_playing, set_shown, start, sync_page_visibility,
};

#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
pub trait DesktopLayer {
    type Target: Send + Copy + 'static;
    /// Windows reparents hidden windows; macOS restyles a shown overlay in place, without a flash.
    const HIDE_WHILE_ATTACHING: bool;
    /// Registers the OS hooks (display, wake, Explorer restarts…) that call `request_refresh`.
    /// Runs once from `start`, on the UI thread.
    fn install_notifications(app: &tauri::AppHandle) -> Result<(), String>;
    /// May wait for Explorer; run off the UI thread.
    fn discover() -> Result<Self::Target, String>;
    /// False once the desktop the overlays hang from is gone (Explorer restarted).
    fn is_valid(target: Self::Target) -> bool;
    /// Where `monitor` sits, in units all displays share, for `plan`: physical pixels on Windows,
    /// points on macOS (tao scales each display by its own backing factor).
    fn area(monitor: &tauri::Monitor) -> Bounds;
    /// Native window operations run on the UI thread.
    fn attach(
        window: &tauri::WebviewWindow,
        monitor: &tauri::Monitor,
        target: Self::Target,
    ) -> Result<(), String>;
    /// Where `window` hangs now compared with where `attach` would put it, read from the OS.
    fn attachment(
        window: &tauri::WebviewWindow,
        monitor: &tauri::Monitor,
        target: Self::Target,
    ) -> Attachment;
    /// Back to a plain top-level window. The controller hides it first and destroys it after.
    fn detach(window: &tauri::WebviewWindow) -> Result<(), String>;
    /// Whether the page counts as visible to the renderer. Windows: WebView2 no longer follows its
    /// window (occlusion is off, see `WEBVIEW2_BROWSER_ARGS`). macOS: WebKit already does.
    fn set_page_visible(window: &tauri::WebviewWindow, visible: bool) -> Result<(), String>;
    /// One line on a shown overlay's native state, for the debug `--desktop-layer-test` log.
    fn report(window: &tauri::WebviewWindow) -> String;
    /// One line for `undertone --diagnose`.
    fn describe(target: Self::Target) -> String;
    /// Debug `--overlay-probe`: the native window state after an attach.
    fn debug_state(_window: &tauri::WebviewWindow) -> String {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn playback_visibility() {
        assert!(!visible(&ShowWhen::Playing, false));
        assert!(visible(&ShowWhen::Playing, true));
        assert!(visible(&ShowWhen::Always, false));
    }
    #[test]
    fn hidden_lyrics_win_over_every_show_when() {
        assert!(shown(&ShowWhen::Playing, true, false));
        assert!(shown(&ShowWhen::Always, false, false));
        assert!(!shown(&ShowWhen::Playing, false, false));
        assert!(!shown(&ShowWhen::Playing, true, true));
        assert!(!shown(&ShowWhen::Always, false, true));
        assert!(!shown(&ShowWhen::Always, true, true));
    }
    #[test]
    fn primary_is_not_assumed_to_be_first() {
        assert_eq!(monitor_indices(&Displays::Primary, 3, Some(2)), vec![2]);
        assert_eq!(monitor_indices(&Displays::All, 3, Some(2)), vec![0, 1, 2]);
    }
    #[test]
    fn missing_or_disconnected_primary() {
        assert!(monitor_indices(&Displays::Primary, 0, None).is_empty());
        assert_eq!(monitor_indices(&Displays::Primary, 2, None), vec![0]);
        assert_eq!(monitor_indices(&Displays::Primary, 2, Some(4)), vec![0]);
    }
    #[test]
    fn overlay_labels() {
        assert!(is_overlay("overlay"));
        assert!(is_overlay("overlay-0"));
        assert!(is_overlay("overlay-12"));
        assert!(!is_overlay("settings"));
        assert!(!is_overlay("overlays"));
    }
    const LAPTOP: Bounds = (0, 0, 3024, 1964);
    const RIGHT: Bounds = (3024, 0, 2560, 1440);
    const LEFT: Bounds = (-1920, 200, 1920, 1080);
    #[test]
    fn plan_primary_uses_the_single_overlay_window() {
        assert_eq!(
            plan(&Displays::Primary, &[RIGHT, LAPTOP], Some(1)),
            vec![(1, "overlay".to_owned())]
        );
        assert_eq!(
            plan(&Displays::Primary, &[RIGHT, LAPTOP], None),
            vec![(0, "overlay".to_owned())]
        );
        assert!(plan(&Displays::Primary, &[], None).is_empty());
    }
    #[test]
    fn plan_all_labels_each_monitor_by_index() {
        assert_eq!(
            plan(&Displays::All, &[LAPTOP, RIGHT, LEFT], Some(0)),
            vec![
                (0, "overlay-0".to_owned()),
                (1, "overlay-1".to_owned()),
                (2, "overlay-2".to_owned()),
            ]
        );
        assert!(plan(&Displays::All, &[], None).is_empty());
    }
    #[test]
    fn plan_all_covers_a_mirror_set_once() {
        assert_eq!(
            plan(&Displays::All, &[LAPTOP, RIGHT, LAPTOP], Some(0)),
            vec![(0, "overlay-0".to_owned()), (1, "overlay-1".to_owned())]
        );
        // Mirror members can run different modes: the shared origin is what counts.
        let projector: Bounds = (0, 0, 1280, 800);
        assert_eq!(
            plan(&Displays::All, &[LAPTOP, projector, RIGHT], Some(0)),
            vec![(0, "overlay-0".to_owned()), (2, "overlay-2".to_owned())]
        );
        // The primary stays the primary even when it mirrors another display.
        assert_eq!(
            plan(&Displays::Primary, &[LAPTOP, RIGHT, LAPTOP], Some(2)),
            vec![(2, "overlay".to_owned())]
        );
    }

    #[test]
    fn play_pause_reuses_the_desktop_and_settings_find_it_again() {
        assert_eq!(pass(false, false, true), None);
        assert_eq!(pass(false, true, true), Some(Pass::Reuse));
        assert_eq!(pass(true, false, true), Some(Pass::Full));
        assert_eq!(pass(true, true, true), Some(Pass::Full));
        // No desktop yet, or Explorer restarted: every pass looks for it, play/pause included.
        assert_eq!(pass(false, false, false), Some(Pass::Full));
        assert_eq!(pass(false, true, false), Some(Pass::Full));
    }

    const NOTHING: Steps = Steps {
        hide_first: false,
        attach: false,
        show_after: false,
    };
    const HIDE: Steps = Steps {
        hide_first: true,
        ..NOTHING
    };
    const SHOW: Steps = Steps {
        show_after: true,
        ..NOTHING
    };
    const ATTACH: Steps = Steps {
        attach: true,
        ..NOTHING
    };
    const ATTACH_SHOW: Steps = Steps {
        attach: true,
        show_after: true,
        ..NOTHING
    };
    const HIDE_ATTACH: Steps = Steps {
        hide_first: true,
        attach: true,
        ..NOTHING
    };
    const REPARENT: Steps = Steps {
        hide_first: true,
        attach: true,
        show_after: true,
    };

    #[test]
    fn a_placed_overlay_only_changes_when_its_shown_state_does() {
        for windows in [true, false] {
            // showWhen: always, play ↔ pause: nothing at all, so nothing blinks.
            assert_eq!(steps(Attachment::Placed, true, true, windows), NOTHING);
            assert_eq!(steps(Attachment::Placed, false, false, windows), NOTHING);
            // showWhen: playing, or Hide lyrics.
            assert_eq!(steps(Attachment::Placed, true, false, windows), HIDE);
            assert_eq!(steps(Attachment::Placed, false, true, windows), SHOW);
        }
    }

    #[test]
    fn windows_reparents_only_hidden_overlays() {
        assert_eq!(steps(Attachment::Detached, true, true, true), REPARENT);
        assert_eq!(steps(Attachment::Detached, true, false, true), HIDE_ATTACH);
        assert_eq!(steps(Attachment::Detached, false, true, true), ATTACH_SHOW);
        assert_eq!(steps(Attachment::Detached, false, false, true), ATTACH);
        // Already under the right parent: moved and restacked in place, without a blink.
        assert_eq!(steps(Attachment::Misplaced, true, true, true), ATTACH);
        assert_eq!(steps(Attachment::Misplaced, true, false, true), HIDE_ATTACH);
        assert_eq!(steps(Attachment::Misplaced, false, true, true), ATTACH_SHOW);
    }

    #[test]
    fn macos_restyles_in_place() {
        for attachment in [Attachment::Detached, Attachment::Misplaced] {
            assert_eq!(steps(attachment, true, true, false), ATTACH);
            assert_eq!(steps(attachment, true, false, false), HIDE_ATTACH);
            assert_eq!(steps(attachment, false, true, false), ATTACH_SHOW);
            assert_eq!(steps(attachment, false, false, false), ATTACH);
        }
    }

    fn configured_windows() -> Vec<serde_json::Value> {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        config["app"]["windows"].as_array().unwrap().clone()
    }

    #[test]
    fn every_configured_webview_uses_the_shared_webview2_args() {
        let windows = configured_windows();
        assert!(windows.iter().any(|w| w["label"] == "overlay"));
        assert!(windows.iter().any(|w| w["label"] == "settings"));
        for window in &windows {
            assert_eq!(
                window["additionalBrowserArgs"].as_str(),
                Some(WEBVIEW2_BROWSER_ARGS),
                "window {}",
                window["label"]
            );
        }
    }

    #[test]
    fn every_runtime_webview_uses_the_shared_webview2_args() {
        // The controller only compiles for Windows and macOS, so its builders are checked as
        // source. Needles are joined here so this test's own text never matches.
        fn sources(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    sources(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let text = std::fs::read_to_string(&path).unwrap();
                    out.push((path.display().to_string(), text));
                }
            }
        }
        let mut files = Vec::new();
        sources(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut files,
        );
        let builders = [
            ["WebviewWindowBuilder", "::new("].concat(),
            ["WebviewBuilder", "::new("].concat(),
        ];
        let mut built = 0;
        for (path, text) in &files {
            for builder in &builders {
                for (start, _) in text.match_indices(builder.as_str()) {
                    let chain = &text[start..];
                    let chain = &chain[..chain.find(".build()").expect(path)];
                    assert!(
                        chain.contains(".additional_browser_args(WEBVIEW2_BROWSER_ARGS)"),
                        "{path}: {builder} without the shared WebView2 arguments"
                    );
                    built += 1;
                }
            }
        }
        // The `overlay-<n>` windows of `displays: all` (desktop_layer/controller.rs).
        assert!(built >= 1);
    }

    #[test]
    fn webview2_args_keep_wrys_defaults_in_one_flag() {
        // Chromium reads only the last --disable-features, so every feature shares one flag.
        assert_eq!(WEBVIEW2_BROWSER_ARGS.matches("--").count(), 1);
        let features = WEBVIEW2_BROWSER_ARGS
            .strip_prefix("--disable-features=")
            .unwrap();
        assert_eq!(
            features.split(',').collect::<Vec<_>>(),
            [
                "msWebOOUI",
                "msPdfOOUI",
                "msSmartScreenProtection",
                "CalculateNativeWinOcclusion"
            ]
        );
    }

    #[test]
    fn configured_overlays_are_never_throttled() {
        let windows = configured_windows();
        let overlays: Vec<_> = windows
            .iter()
            .filter(|w| w["label"].as_str().is_some_and(is_overlay))
            .collect();
        assert!(!overlays.is_empty());
        for overlay in overlays {
            assert_eq!(overlay["backgroundThrottling"], "disabled");
        }
    }
}
