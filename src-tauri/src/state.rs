//! State shared by commands, the tray, shortcuts and the native services.
use crate::contract::{MediaStatus, NowPlaying, Settings, ShortcutsStatus};
use std::sync::Mutex;

#[derive(Default)]
pub struct AppState {
    /// Everything the user chose, `enabled` (lyrics on or off) included: `settings::runtime` is
    /// the only writer.
    pub settings: Mutex<Settings>,
    pub now_playing: Mutex<Option<NowPlaying>>,
    /// The last `media-status`: no source and no problem until the now-playing loop says otherwise.
    pub media_status: Mutex<MediaStatus>,
    /// The last `shortcuts-status`: every action off until the first registration pass.
    pub shortcuts_status: Mutex<ShortcutsStatus>,
}
