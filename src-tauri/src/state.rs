//! State shared by commands, the tray, shortcuts and the native services.
use crate::contract::{MediaStatus, NowPlaying, Settings};
use std::sync::{atomic::AtomicBool, Mutex};

#[derive(Default)]
pub struct AppState {
    pub settings: Mutex<Settings>,
    pub now_playing: Mutex<Option<NowPlaying>>,
    /// The last `media-status`: no source and no problem until the now-playing loop says otherwise.
    pub media_status: Mutex<MediaStatus>,
    /// Tray "Hide lyrics" and Cmd/Ctrl+Alt+Shift+L: hides every overlay until shown again. Not persisted.
    pub lyrics_hidden: AtomicBool,
}
