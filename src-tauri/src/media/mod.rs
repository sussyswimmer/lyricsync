//! Platform-independent playback policy; platform adapters supply timestamped snapshots.
pub mod artwork;
#[cfg(all(feature = "desktop", target_os = "windows"))]
mod runtime;
#[cfg(all(feature = "desktop", target_os = "windows"))]
mod windows;
#[cfg(all(feature = "desktop", target_os = "windows"))]
pub use runtime::start;

/// macOS now playing (X2, second OS). Until it lands nothing is playing.
#[cfg(all(feature = "desktop", target_os = "macos"))]
pub fn start(app: &tauri::AppHandle) {
    use tauri::Emitter;
    if let Err(error) = app.emit(
        crate::contract::NOW_PLAYING_EVENT,
        Option::<crate::contract::NowPlaying>::None,
    ) {
        eprintln!("now-playing event: {error}");
    }
}

use crate::contract::{NowPlaying, Source};
use async_trait::async_trait;

#[derive(Debug, Clone)]
pub struct RawTrack {
    pub source: Source,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: f64,
    pub position_ms: f64,
    pub sampled_at: f64,
    pub is_playing: bool,
    pub artwork: Option<String>,
}
#[async_trait]
pub trait MediaSource: Send + Sync {
    async fn snapshot(&self) -> Option<RawTrack>;
}

pub fn track_key(artist: &str, title: &str, album: &str, duration_ms: f64) -> String {
    format!(
        "{artist}|{title}|{album}|{:.0}",
        (duration_ms / 1000.0).round()
    )
    .to_lowercase()
}
impl RawTrack {
    fn into_now_playing(self) -> Option<NowPlaying> {
        if self.title.trim().is_empty()
            || !self.duration_ms.is_finite()
            || self.duration_ms < 0.0
            || !self.position_ms.is_finite()
            || !self.sampled_at.is_finite()
            || self.sampled_at < 0.0
        {
            return None;
        }
        let position_ms = if self.duration_ms > 0.0 {
            self.position_ms.clamp(0.0, self.duration_ms)
        } else {
            self.position_ms.max(0.0)
        };
        Some(NowPlaying {
            track_key: track_key(&self.artist, &self.title, &self.album, self.duration_ms),
            source: self.source,
            title: self.title,
            artist: self.artist,
            album: self.album,
            duration_ms: self.duration_ms,
            position_ms,
            sampled_at: self.sampled_at,
            is_playing: self.is_playing,
            artwork: self.artwork,
        })
    }
}

/// WinRT DateTime uses 100 ns ticks since 1601, not Unix time. Zero/unset timestamps use read time.
pub fn windows_sample_time(ticks: i64, read_at_ms: f64) -> f64 {
    const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;
    match ticks.checked_sub(UNIX_EPOCH_TICKS) {
        Some(unix) if unix > 0 => (unix as f64 / 10_000.0).min(read_at_ms),
        _ => read_at_ms,
    }
}

#[derive(Debug, Clone)]
pub struct Candidate {
    pub source: Source,
    pub is_playing: bool,
    pub last_active_ms: f64,
    pub is_current: bool,
}
/// Playing Spotify, then playing Music, then other playing sessions; otherwise most recently active.
pub fn select_candidate(candidates: &[Candidate]) -> Option<usize> {
    fn priority(candidate: &Candidate) -> u8 {
        match (&candidate.source, candidate.is_playing) {
            (Source::Spotify, true) => 3,
            (Source::AppleMusic, true) => 2,
            (_, true) => 1,
            _ => 0,
        }
    }
    candidates
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| {
            priority(a)
                .cmp(&priority(b))
                .then_with(|| a.last_active_ms.total_cmp(&b.last_active_ms))
                .then_with(|| a.is_current.cmp(&b.is_current))
                .then_with(|| (a.source == Source::Spotify).cmp(&(b.source == Source::Spotify)))
        })
        .map(|(index, _)| index)
}

#[derive(Debug)]
pub struct Update {
    pub now_playing: Option<NowPlaying>,
    pub track_changed: bool,
    pub seek: bool,
}
#[derive(Default)]
pub struct Watcher {
    current: Option<NowPlaying>,
    initialized: bool,
    last_emit_ms: u64,
}
impl Watcher {
    pub fn current(&self) -> &Option<NowPlaying> {
        &self.current
    }
    /// Called once per timer tick, including while metadata is pending. A real-change event must not postpone this resync.
    pub fn resync(&mut self, elapsed_ms: u64) -> Option<Update> {
        if self.current.as_ref().is_some_and(|track| track.is_playing) {
            self.last_emit_ms = elapsed_ms;
            Some(Update {
                now_playing: self.current.clone(),
                track_changed: false,
                seek: false,
            })
        } else {
            None
        }
    }
    /// elapsed_ms is monotonic time since the watcher started; OS timestamps remain untouched.
    pub fn update(&mut self, raw: Option<RawTrack>, elapsed_ms: u64) -> Option<Update> {
        let next = raw.and_then(RawTrack::into_now_playing);
        let track_changed =
            self.current.as_ref().map(|n| &n.track_key) != next.as_ref().map(|n| &n.track_key);
        let (changed, seek) = match (&self.current, &next) {
            (Some(old), Some(new)) => {
                let sample = old.sampled_at.max(new.sampled_at);
                let seek = !track_changed
                    && (projected(old, sample) - projected(new, sample)).abs() > 1000.0;
                (
                    track_changed
                        || old.source != new.source
                        || old.title != new.title
                        || old.artist != new.artist
                        || old.album != new.album
                        || old.duration_ms != new.duration_ms
                        || old.is_playing != new.is_playing
                        || old.artwork != new.artwork
                        || seek,
                    seek,
                )
            }
            (None, None) => (false, false),
            _ => (true, false),
        };
        let resync = next.as_ref().is_some_and(|n| n.is_playing)
            && elapsed_ms.saturating_sub(self.last_emit_ms) >= 1000;
        self.current = next;
        if !self.initialized || changed || resync {
            self.initialized = true;
            self.last_emit_ms = elapsed_ms;
            Some(Update {
                now_playing: self.current.clone(),
                track_changed,
                seek,
            })
        } else {
            None
        }
    }
}
fn projected(track: &NowPlaying, at_ms: f64) -> f64 {
    let position = track.position_ms
        + if track.is_playing {
            (at_ms - track.sampled_at).max(0.0)
        } else {
            0.0
        };
    if track.duration_ms > 0.0 {
        position.min(track.duration_ms)
    } else {
        position
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn raw() -> RawTrack {
        RawTrack {
            source: Source::Spotify,
            title: "Paper Lantern".into(),
            artist: "Demo Artist".into(),
            album: "Demo Album".into(),
            duration_ms: 180_000.0,
            position_ms: 10_000.0,
            sampled_at: 1_700_000_000_000.0,
            is_playing: true,
            artwork: None,
        }
    }
    #[test]
    fn key_matches_contract_rounding_case_and_delimiters() {
        assert_eq!(
            track_key("Demo ARTIST", "Paper Lantern", "Demo Album", 1500.0),
            "demo artist|paper lantern|demo album|2"
        );
        assert_eq!(track_key("A", "B", "", 1499.0), "a|b||1");
        assert_eq!(track_key(" Å ", "B", "", 0.0), " å |b||0");
    }
    #[test]
    fn winrt_epoch_preserves_coarse_sample_time() {
        let ticks = 116_444_736_000_000_000 + 1_700_000_000_000i64 * 10_000;
        assert_eq!(
            windows_sample_time(ticks, 1_700_000_005_000.0),
            1_700_000_000_000.0
        );
        assert_eq!(windows_sample_time(0, 5000.0), 5000.0);
        assert_eq!(windows_sample_time(i64::MIN, 5000.0), 5000.0);
        assert_eq!(windows_sample_time(ticks, 100.0), 100.0);
    }
    #[test]
    fn playback_priority_and_recent_paused_fallback() {
        let mut candidates = vec![
            Candidate {
                source: Source::Spotify,
                is_playing: false,
                last_active_ms: 1.0,
                is_current: false,
            },
            Candidate {
                source: Source::AppleMusic,
                is_playing: true,
                last_active_ms: 2.0,
                is_current: false,
            },
            Candidate {
                source: Source::System,
                is_playing: true,
                last_active_ms: 3.0,
                is_current: true,
            },
        ];
        assert_eq!(select_candidate(&candidates), Some(1));
        candidates[0].is_playing = true;
        assert_eq!(select_candidate(&candidates), Some(0));
        for candidate in &mut candidates {
            candidate.is_playing = false;
        }
        assert_eq!(select_candidate(&candidates), Some(2));
        assert_eq!(select_candidate(&[]), None);
    }
    #[test]
    fn null_is_emitted_once_and_on_session_loss() {
        let mut watcher = Watcher::default();
        assert!(watcher.update(None, 0).unwrap().now_playing.is_none());
        assert!(watcher.update(None, 1000).is_none());
        assert!(watcher.update(Some(raw()), 1001).unwrap().track_changed);
        assert!(watcher.update(None, 1002).unwrap().track_changed);
        assert!(watcher.update(None, 2002).is_none());
    }
    #[test]
    fn coarse_timeline_is_not_restamped_or_misidentified_as_a_seek() {
        let mut watcher = Watcher::default();
        watcher.update(Some(raw()), 0);
        assert!(watcher.update(Some(raw()), 999).is_none());
        let event = watcher.update(Some(raw()), 1000).unwrap();
        assert!(!event.seek);
        assert_eq!(event.now_playing.unwrap().sampled_at, raw().sampled_at);
        let mut advancing = raw();
        advancing.sampled_at += 1500.0;
        advancing.position_ms += 1500.0;
        assert!(watcher.update(Some(advancing), 1500).is_none());
    }
    #[test]
    fn pending_metadata_keeps_resyncing_without_fabricating_sample_times() {
        let mut watcher = Watcher::default();
        watcher.update(Some(raw()), 0);
        let update = watcher.resync(1000).unwrap();
        assert_eq!(update.now_playing.unwrap().sampled_at, raw().sampled_at);
        assert!(!update.seek);
        assert!(watcher.resync(2000).is_some());
        watcher.update(None, 2001);
        assert!(watcher.resync(3001).is_none());
    }
    #[test]
    fn real_change_does_not_postpone_the_next_periodic_resync() {
        let mut watcher = Watcher::default();
        watcher.update(Some(raw()), 0);
        let mut sought = raw();
        sought.position_ms += 3000.0;
        assert!(watcher.update(Some(sought), 500).unwrap().seek);
        assert!(watcher.resync(1000).is_some());
    }
    #[test]
    fn forward_and_backward_seek_emit_immediately() {
        for delta in [-1500.0, 1500.0] {
            let mut watcher = Watcher::default();
            watcher.update(Some(raw()), 0);
            let mut next = raw();
            next.position_ms += delta;
            assert!(watcher.update(Some(next), 10).unwrap().seek);
        }
        let mut watcher = Watcher::default();
        watcher.update(Some(raw()), 0);
        let mut next = raw();
        next.position_ms += 1000.0;
        assert!(watcher.update(Some(next), 10).is_none());
    }
    #[test]
    fn pause_and_artwork_change_emit_without_idle_resync() {
        let mut watcher = Watcher::default();
        watcher.update(Some(raw()), 0);
        let mut paused = raw();
        paused.is_playing = false;
        assert!(
            !watcher
                .update(Some(paused.clone()), 10)
                .unwrap()
                .now_playing
                .unwrap()
                .is_playing
        );
        assert!(watcher.update(Some(paused.clone()), 5000).is_none());
        paused.artwork = Some("data:image/png;base64,demo".into());
        assert!(watcher.update(Some(paused), 5001).is_some());
    }
    #[test]
    fn malformed_snapshots_are_rejected_and_position_is_bounded() {
        let mut bad = raw();
        bad.duration_ms = f64::NAN;
        assert!(bad.into_now_playing().is_none());
        let mut bad = raw();
        bad.title = "  ".into();
        assert!(bad.into_now_playing().is_none());
        let mut bad = raw();
        bad.position_ms = f64::INFINITY;
        assert!(bad.into_now_playing().is_none());
        let mut bounded = raw();
        bounded.position_ms = 999_999.0;
        assert_eq!(bounded.into_now_playing().unwrap().position_ms, 180_000.0);
    }
}
