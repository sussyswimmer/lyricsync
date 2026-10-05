//! Portable policy plus the native Windows adapter. macOS attachment is still pending.
use crate::contract::{Displays, ShowWhen};

pub fn visible(show_when: &ShowWhen, is_playing: bool) -> bool {
    *show_when == ShowWhen::Always || is_playing
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

#[cfg(all(feature = "desktop", target_os = "windows"))]
mod controller;
#[cfg(all(feature = "desktop", target_os = "windows"))]
mod windows;
#[cfg(all(feature = "desktop", target_os = "windows"))]
pub use controller::{request_refresh, set_playing, start};

#[cfg(all(feature = "desktop", target_os = "windows"))]
pub trait DesktopLayer {
    type Target: Send + Copy;
    /// May wait for Explorer; run off the UI thread.
    fn discover() -> Result<Self::Target, String>;
    /// Native window operations run on the UI thread.
    fn attach(
        window: &tauri::WebviewWindow,
        monitor: &tauri::Monitor,
        target: Self::Target,
    ) -> Result<(), String>;
    fn detach(window: &tauri::WebviewWindow) -> Result<(), String>;
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
}
