//! Portable policy plus one controller that drives the native adapters (Windows, macOS) through
//! the `DesktopLayer` trait. See docs/DESKTOP_LAYER.md.
use crate::contract::{Displays, ShowWhen};

pub mod geometry;
use geometry::Bounds;

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

#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
mod controller;
#[cfg(all(feature = "desktop", target_os = "macos"))]
mod macos;
#[cfg(all(feature = "desktop", target_os = "windows"))]
mod windows;
#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
pub use controller::{describe, refresh_now, request_refresh, set_playing, start};

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
    fn detach(window: &tauri::WebviewWindow) -> Result<(), String>;
    /// One line for `undertone --diagnose`.
    fn describe(target: Self::Target) -> String;
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
}
