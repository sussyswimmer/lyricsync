//! Platform-independent playback policy; platform adapters supply timestamped snapshots.
pub mod applescript;
pub mod artwork;
#[cfg(all(feature = "desktop", target_os = "macos"))]
mod macos;
#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
mod runtime;
#[cfg(all(feature = "desktop", target_os = "windows"))]
mod windows;
#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
pub use runtime::start;

use crate::contract::{MediaProblem, MediaStatus, NowPlaying, Source};
use async_trait::async_trait;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
    /// What the last snapshot saw of the players, for `media-status`. A backend that can't tell
    /// keeps the default.
    fn presence(&self) -> Presence {
        Presence::Unknown
    }
}

/// The players as a backend last saw them, beyond the track it picked.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum Presence {
    #[default]
    Unknown,
    /// No supported player runs (macOS), no media session exists (Windows), or the OS connection failed.
    NoPlayer,
    /// A supported player runs and may be read; it may simply have nothing loaded.
    Running,
    /// A running player macOS denies Automation for; Spotify when both are.
    Denied(Source),
}

/// `media-status`: the reported track's player, else why nothing is reported. A consent prompt
/// still open, or a player with nothing loaded, is no problem.
pub fn media_status(track: Option<&NowPlaying>, presence: &Presence) -> MediaStatus {
    let (source, problem) = match (track, presence) {
        (Some(track), _) => (Some(track.source.clone()), None),
        (None, Presence::Denied(source)) => {
            (Some(source.clone()), Some(MediaProblem::AutomationDenied))
        }
        (None, Presence::NoPlayer) => (None, Some(MediaProblem::NoPlayer)),
        (None, Presence::Running | Presence::Unknown) => (None, None),
    };
    MediaStatus { source, problem }
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

/// Wall-clock read time for `sampledAt`, in epoch milliseconds.
pub fn epoch_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
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

/// A read's trackKey in the two halves an SMTC player publishes separately: the metadata
/// (artist, title, album) and the timeline's duration, in whole seconds as the key rounds it.
#[derive(Debug, Clone, PartialEq)]
pub struct KeyHalves {
    /// The player the read came from (its app id); reads of different players are not compared.
    pub player: String,
    pub metadata: String,
    pub seconds: f64,
}
impl KeyHalves {
    pub fn new(player: &str, artist: &str, title: &str, album: &str, duration_ms: f64) -> Self {
        Self {
            player: player.to_owned(),
            metadata: track_key(artist, title, album, 0.0),
            seconds: (duration_ms / 1000.0).round(),
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq)]
enum Half {
    Metadata,
    Duration,
}
enum Change {
    Same,
    One(Half),
    /// Both halves, or another player.
    New,
}

/// How many metadata and timeline changes the players have announced so far (SMTC's
/// MediaPropertiesChanged and TimelinePropertiesChanged, from any session).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Announced {
    pub metadata: u64,
    pub timeline: u64,
}
impl Announced {
    fn of(&self, half: Half) -> u64 {
        match half {
            Half::Metadata => self.metadata,
            Half::Duration => self.timeline,
        }
    }
}

/// Holds back a read that may pair two tracks' halves. An SMTC player sets a new track's
/// metadata and its timeline in separate calls, and the media loop wakes on the first: a read
/// in between pairs the new title with the previous track's duration (or the old title with the
/// new one), so its trackKey names no real song and starts a spurious LRCLIB lookup. A read where
/// only one half changed since the last one published waits up to `WAIT` for the other. One
/// half really changing alone (a duration that arrives late, two songs of the same length, a
/// player that reports no timeline) is published when the wait runs out. If the player hasn't
/// announced the missing half since the previous trackKey was published, it may still be on its
/// way and is published at once if it arrives within `LATE`. If it has (two songs of the same
/// length), the half that kept its value is the new track's, so its next change belongs to the
/// next track and waits like any other. Reads that keep the trackKey (play, pause, seek,
/// artwork) never wait.
#[derive(Debug, Default)]
pub struct Settle {
    last: Option<KeyHalves>,
    /// What had been announced before the read that published `last`'s trackKey.
    announced: Announced,
    /// The half a read published by `give_up` still lacked, and until when it may arrive.
    awaiting: Option<(Half, Instant)>,
}
impl Settle {
    pub const WAIT: Duration = Duration::from_millis(300);
    const LATE: Duration = Duration::from_secs(3);

    fn change(&self, next: &KeyHalves) -> Change {
        let Some(last) = self.last.as_ref().filter(|last| last.player == next.player) else {
            return Change::New;
        };
        match (last.metadata != next.metadata, last.seconds != next.seconds) {
            (false, false) => Change::Same,
            (true, false) => Change::One(Half::Metadata),
            (false, true) => Change::One(Half::Duration),
            (true, true) => Change::New,
        }
    }

    /// Whether `next` may be published now; it then becomes the read later ones are compared
    /// with. If not, read again when the player publishes more, and call `give_up` once `WAIT`
    /// is over. `announced` is counted before the read.
    pub fn admit(&mut self, next: &KeyHalves, announced: Announced, now: Instant) -> bool {
        match self.change(next) {
            Change::Same => {
                self.last = Some(next.clone());
                return true;
            }
            Change::New => self.awaiting = None,
            Change::One(half) => {
                let completes = self
                    .awaiting
                    .is_some_and(|(awaited, until)| awaited == half && now <= until);
                if !completes {
                    return false;
                }
                self.awaiting = None;
            }
        }
        self.announced = announced;
        self.last = Some(next.clone());
        true
    }

    /// The other half did not come within `WAIT`: `next` is published as it is. `announced` is
    /// counted after the read, so an announcement during it counts as the half having come.
    pub fn give_up(&mut self, next: KeyHalves, announced: Announced, now: Instant) {
        let missing = match self.change(&next) {
            Change::One(Half::Metadata) => Some(Half::Duration),
            Change::One(Half::Duration) => Some(Half::Metadata),
            Change::Same | Change::New => None,
        };
        let before = self.announced;
        self.awaiting = missing
            .filter(|half| announced.of(*half) == before.of(*half))
            .map(|half| (half, now + Self::LATE));
        self.announced = announced;
        self.last = Some(next);
    }
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
    fn media_status_reports_the_track_first_then_the_problem() {
        let track = raw().into_now_playing().unwrap();
        // A reported track wins over anything the backend saw, playing or paused.
        for presence in [
            Presence::Unknown,
            Presence::NoPlayer,
            Presence::Running,
            Presence::Denied(Source::AppleMusic),
        ] {
            assert_eq!(
                media_status(Some(&track), &presence),
                MediaStatus {
                    source: Some(Source::Spotify),
                    problem: None,
                },
                "{presence:?}"
            );
        }
        let mut paused = raw();
        paused.is_playing = false;
        paused.source = Source::AppleMusic;
        let paused = paused.into_now_playing().unwrap();
        assert_eq!(
            media_status(Some(&paused), &Presence::NoPlayer).source,
            Some(Source::AppleMusic)
        );
        for source in [Source::Spotify, Source::AppleMusic] {
            assert_eq!(
                media_status(None, &Presence::Denied(source.clone())),
                MediaStatus {
                    source: Some(source),
                    problem: Some(MediaProblem::AutomationDenied),
                }
            );
        }
        assert_eq!(
            media_status(None, &Presence::NoPlayer),
            MediaStatus {
                source: None,
                problem: Some(MediaProblem::NoPlayer),
            }
        );
        // A player with nothing loaded, a consent prompt still open, or a backend that can't tell.
        for presence in [Presence::Running, Presence::Unknown] {
            assert_eq!(
                media_status(None, &presence),
                MediaStatus::default(),
                "{presence:?}"
            );
        }
    }
    #[test]
    fn a_backend_that_cannot_tell_reports_unknown() {
        struct Silent;
        #[async_trait]
        impl MediaSource for Silent {
            async fn snapshot(&self) -> Option<RawTrack> {
                None
            }
        }
        assert_eq!(Silent.presence(), Presence::Unknown);
        assert_eq!(Presence::default(), Presence::Unknown);
    }
    fn halves(title: &str, duration_ms: f64) -> KeyHalves {
        KeyHalves::new(
            "spotify.exe",
            "Demo Artist",
            title,
            "Demo Album",
            duration_ms,
        )
    }
    /// Nothing announced: tests where only the reads matter.
    const QUIET: Announced = Announced {
        metadata: 0,
        timeline: 0,
    };
    #[test]
    fn a_track_change_read_between_its_two_halves_waits_for_the_other() {
        let t0 = Instant::now();
        let mut settle = Settle::default();
        // The first read of a player has nothing to be compared with.
        assert!(settle.admit(&halves("Paper Lantern", 180_000.0), QUIET, t0));
        // The new title next to the previous track's duration, then the timeline catches up.
        assert!(!settle.admit(&halves("Glass Harbor", 180_000.0), QUIET, t0));
        assert!(settle.admit(&halves("Glass Harbor", 214_000.0), QUIET, t0));
        // The other order: the new duration next to the previous title, then the metadata.
        assert!(!settle.admit(&halves("Glass Harbor", 95_000.0), QUIET, t0));
        assert!(settle.admit(&halves("Quiet Engine", 95_000.0), QUIET, t0));
        // Both halves at once is a new track, at once.
        assert!(settle.admit(&halves("Paper Lantern", 180_000.0), QUIET, t0));
    }
    #[test]
    fn reads_that_keep_the_track_key_never_wait() {
        let t0 = Instant::now();
        let mut settle = Settle::default();
        assert!(settle.admit(&halves("Paper Lantern", 180_000.0), QUIET, t0));
        // Play, pause, seek and artwork are not part of the halves; sub-second jitter and a
        // case change don't change the key.
        assert!(settle.admit(&halves("Paper Lantern", 180_000.0), QUIET, t0));
        assert!(settle.admit(&halves("Paper Lantern", 180_400.0), QUIET, t0));
        assert!(settle.admit(&halves("PAPER LANTERN", 180_000.0), QUIET, t0));
        // Another player is not a half-updated track of this one.
        let other = KeyHalves::new("msedge", "Demo Artist", "Glass Harbor", "", 180_000.0);
        assert!(settle.admit(&other, QUIET, t0));
        assert!(settle.admit(&halves("Glass Harbor", 180_000.0), QUIET, t0));
    }
    #[test]
    fn a_half_that_really_changed_alone_is_published_when_the_wait_runs_out() {
        let t0 = Instant::now();
        let mut settle = Settle::default();
        let mut seen = QUIET;
        assert!(settle.admit(&halves("Paper Lantern", 0.0), seen, t0));
        // A player without a timeline: every track change is metadata alone.
        seen.metadata += 1;
        let next = halves("Glass Harbor", 0.0);
        assert!(!settle.admit(&next, seen, t0));
        settle.give_up(next.clone(), seen, t0 + Settle::WAIT);
        // Published once, it is the reference: the next reads of it don't wait again.
        assert!(settle.admit(&next, seen, t0 + Duration::from_secs(1)));
        assert!(settle.admit(&next, seen, t0 + Duration::from_secs(2)));
        // The next track change waits again; metadata is not the half that was missing.
        seen.metadata += 1;
        let at = t0 + Duration::from_secs(2);
        assert!(!settle.admit(&halves("Quiet Engine", 0.0), seen, at));
    }
    #[test]
    fn a_late_half_completes_the_change_it_belongs_to_at_once() {
        let t0 = Instant::now();
        let mut settle = Settle::default();
        let mut seen = QUIET;
        assert!(settle.admit(&halves("Paper Lantern", 180_000.0), seen, t0));
        seen.metadata += 1;
        let half = halves("Glass Harbor", 180_000.0);
        assert!(!settle.admit(&half, seen, t0));
        settle.give_up(half, seen, t0 + Settle::WAIT);
        // The timeline arrives after the wait: no second wait for the half already published.
        seen.timeline += 1;
        assert!(settle.admit(
            &halves("Glass Harbor", 214_000.0),
            seen,
            t0 + Duration::from_millis(900)
        ));
        // A duration that arrives late on its own (a browser learning the length).
        let mut settle = Settle::default();
        let mut seen = QUIET;
        assert!(settle.admit(&halves("Paper Lantern", 0.0), seen, t0));
        seen.timeline += 1;
        let corrected = halves("Paper Lantern", 180_000.0);
        assert!(!settle.admit(&corrected, seen, t0));
        settle.give_up(corrected, seen, t0 + Settle::WAIT);
        // Long after, a new title next to that duration is a half-updated change again.
        seen.metadata += 1;
        let at = t0 + Duration::from_secs(60);
        assert!(!settle.admit(&halves("Glass Harbor", 180_000.0), seen, at));
        assert!(settle.admit(&halves("Glass Harbor", 214_000.0), seen, at));
    }
    #[test]
    fn a_half_the_player_already_announced_is_not_awaited_after_the_wait() {
        // Two songs of the same length: the player announced the new timeline (before or after
        // the metadata), so the duration that kept its value is the new song's. A quick skip whose
        // timeline comes first pairs that title with the next song's length, and must wait.
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        for timeline_first in [true, false] {
            let mut settle = Settle::default();
            let mut seen = QUIET;
            let before = halves("Paper Lantern", 180_000.0);
            assert!(settle.admit(&before, seen, t0));
            if timeline_first {
                seen.timeline += 1;
                assert!(settle.admit(&before, seen, t0));
            }
            seen.metadata += 1;
            let same_length = halves("Glass Harbor", 180_400.0);
            assert!(!settle.admit(&same_length, seen, t0));
            if !timeline_first {
                seen.timeline += 1;
                assert!(!settle.admit(&same_length, seen, t0 + ms(50)));
            }
            settle.give_up(same_length, seen, t0 + Settle::WAIT);

            seen.timeline += 1;
            let mixed = halves("Glass Harbor", 200_000.0);
            assert!(
                !settle.admit(&mixed, seen, t0 + ms(1000)),
                "{timeline_first}"
            );
            seen.metadata += 1;
            let skipped_to = halves("Quiet Engine", 200_000.0);
            assert!(
                settle.admit(&skipped_to, seen, t0 + ms(1050)),
                "{timeline_first}"
            );
        }
        // Announced during the read that gave up: it counts, though the read missed it.
        let mut settle = Settle::default();
        let mut seen = QUIET;
        assert!(settle.admit(&halves("Paper Lantern", 180_000.0), seen, t0));
        seen.metadata += 1;
        let same_length = halves("Glass Harbor", 180_000.0);
        assert!(!settle.admit(&same_length, seen, t0));
        let during = Announced {
            timeline: seen.timeline + 1,
            ..seen
        };
        settle.give_up(same_length, during, t0 + Settle::WAIT);
        assert!(!settle.admit(&halves("Glass Harbor", 200_000.0), during, t0 + ms(1000)));
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
