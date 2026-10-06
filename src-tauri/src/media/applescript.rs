//! Portable half of the macOS adapter: the AppleScript sources, the parser for their one-line
//! answers, error classification and source selection. `macos.rs` only runs them.
use super::{select_candidate, track_key, Candidate, Presence, RawTrack};
use crate::contract::Source;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

/// ASCII unit separator (`character id 31`): joins the fields of one answer. No title has one.
pub const FIELD_SEPARATOR: char = '\u{1f}';

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Player {
    Spotify,
    Music,
}
impl Player {
    /// Read order: a playing Spotify wins outright, so Music is only asked when it is not.
    pub const ALL: [Player; 2] = [Player::Spotify, Player::Music];
    pub fn name(self) -> &'static str {
        match self {
            Player::Spotify => "Spotify",
            Player::Music => "Music",
        }
    }
    pub fn bundle_id(self) -> &'static str {
        match self {
            Player::Spotify => "com.spotify.client",
            Player::Music => "com.apple.Music",
        }
    }
    /// Distributed notification the player posts on play, pause and track changes.
    pub fn notification(self) -> &'static str {
        match self {
            Player::Spotify => "com.spotify.client.PlaybackStateChanged",
            Player::Music => "com.apple.Music.playerInfo",
        }
    }
    pub fn source(self) -> Source {
        match self {
            Player::Spotify => Source::Spotify,
            Player::Music => Source::AppleMusic,
        }
    }
    pub fn read_script(self) -> Script {
        match self {
            Player::Spotify => Script::SpotifyRead,
            Player::Music => Script::MusicRead,
        }
    }
    /// state, title, artist, album, duration, position, then Spotify's artwork URL.
    fn fields(self) -> usize {
        match self {
            Player::Spotify => 7,
            Player::Music => 6,
        }
    }
    /// Spotify reports durations in milliseconds, Music in seconds.
    fn duration_unit_ms(self) -> f64 {
        match self {
            Player::Spotify => 1.0,
            Player::Music => 1000.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Script {
    SpotifyRead,
    MusicRead,
    MusicArtwork,
}
impl Script {
    pub fn source(self) -> &'static str {
        match self {
            Script::SpotifyRead => SPOTIFY_READ,
            Script::MusicRead => MUSIC_READ,
            Script::MusicArtwork => MUSIC_ARTWORK,
        }
    }
}

// Every script checks `is running` itself (no Apple event, so it never launches the player)
// before its `tell`, closing the gap after the NSWorkspace check. `with timeout` bounds each
// Apple event, so a hung player blocks the main thread for at most 2 s. `txt` turns `missing
// value` (local files, ads, streams) into an empty field instead of breaking the line. The
// separator is built outside the `tell`: inside it, `character id 31` is an object specifier
// aimed at the player, which answers -1728 (read as "no track", so silently nothing).
const SPOTIFY_READ: &str = r#"on txt(v)
	try
		if v is missing value then return ""
		return v as text
	on error
		return ""
	end try
end txt
if application id "com.spotify.client" is not running then return "not-running"
set d to character id 31
with timeout of 2 seconds
	tell application id "com.spotify.client"
		set s to player state
		if s is stopped then return "stopped"
		if s is playing then
			set stateText to "playing"
		else
			set stateText to "paused"
		end if
		set t to current track
		return stateText & d & my txt(name of t) & d & my txt(artist of t) & d & my txt(album of t) & d & my txt(duration of t) & d & my txt(player position) & d & my txt(artwork url of t)
	end tell
end timeout
"#;

const MUSIC_READ: &str = r#"on txt(v)
	try
		if v is missing value then return ""
		return v as text
	on error
		return ""
	end try
end txt
if application id "com.apple.Music" is not running then return "not-running"
set d to character id 31
with timeout of 2 seconds
	tell application id "com.apple.Music"
		set s to player state
		if s is stopped then return "stopped"
		if s is playing then
			set stateText to "playing"
		else if s is paused then
			set stateText to "paused"
		else
			set stateText to "other"
		end if
		set t to current track
		return stateText & d & my txt(name of t) & d & my txt(artist of t) & d & my txt(album of t) & d & my txt(duration of t) & d & my txt(player position)
	end tell
end timeout
"#;

/// Raw image bytes, or `missing value` when the track has no artwork. Run once per track.
const MUSIC_ARTWORK: &str = r#"if application id "com.apple.Music" is not running then return missing value
with timeout of 2 seconds
	tell application id "com.apple.Music"
		try
			return data of artwork 1 of current track
		on error m number n
			if n is -1728 or n is -1719 then return missing value
			error m number n
		end try
	end tell
end timeout
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerState {
    Playing,
    Paused,
}

/// One player's answer, units already converted to milliseconds.
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    pub state: PlayerState,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: f64,
    pub position_ms: f64,
    /// Spotify only; Music artwork is read as data by a separate script.
    pub artwork_url: Option<String>,
}
impl Reading {
    pub fn is_playing(&self) -> bool {
        self.state == PlayerState::Playing
    }
    pub fn track_key(&self) -> String {
        track_key(&self.artist, &self.title, &self.album, self.duration_ms)
    }
    pub fn into_raw(self, player: Player, sampled_at: f64, artwork: Option<String>) -> RawTrack {
        RawTrack {
            source: player.source(),
            is_playing: self.is_playing(),
            title: self.title,
            artist: self.artist,
            album: self.album,
            duration_ms: self.duration_ms,
            position_ms: self.position_ms,
            sampled_at,
            artwork,
        }
    }
}

/// Parses a read script's answer. `Ok(None)` is a stopped or closed player; `Err` is an answer
/// this version does not understand.
pub fn parse_reading(player: Player, output: &str) -> Result<Option<Reading>, String> {
    if matches!(output.trim(), "" | "stopped" | "not-running") {
        return Ok(None);
    }
    let fields: Vec<&str> = output.split(FIELD_SEPARATOR).collect();
    if fields.len() != player.fields() {
        return Err(format!(
            "{} answered with {} fields instead of {}",
            player.name(),
            fields.len(),
            player.fields()
        ));
    }
    let state = match fields[0].trim() {
        "playing" => PlayerState::Playing,
        // Music's fast forwarding and rewinding: the position is not advancing at play speed.
        "paused" | "other" => PlayerState::Paused,
        "stopped" => return Ok(None),
        other => return Err(format!("{} reported player state {other:?}", player.name())),
    };
    let duration_ms =
        parse_number(fields[4]).map_or(0.0, |value| value.max(0.0)) * player.duration_unit_ms();
    let position_ms = parse_number(fields[5]).map_or(0.0, |value| value.max(0.0)) * 1000.0;
    Ok(Some(Reading {
        state,
        title: fields[1].to_owned(),
        artist: fields[2].to_owned(),
        album: fields[3].to_owned(),
        duration_ms,
        position_ms,
        artwork_url: fields
            .get(6)
            .map(|url| url.trim())
            .filter(|url| !url.is_empty())
            .map(str::to_owned),
    }))
}

/// AppleScript turns reals into text with the user's decimal separator ("12,5" in much of
/// Europe) and switches to exponent form from 10 000 up ("2,6E+4"). It never groups digits.
pub fn parse_number(text: &str) -> Option<f64> {
    let text = text.trim();
    if text.is_empty() || text == "missing value" {
        return None;
    }
    let normalized: String = text
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| if c == ',' { '.' } else { c })
        .collect();
    normalized
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

/// Spotify's cover URL, fetched over HTTPS only. Some builds still hand out `http://` links to
/// the same CDN; anything that is not a web URL means no artwork.
pub fn https_artwork_url(raw: &str) -> Option<reqwest::Url> {
    let mut url = reqwest::Url::parse(raw.trim()).ok()?;
    match url.scheme() {
        "https" => {}
        "http" => url.set_scheme("https").ok()?,
        _ => return None,
    }
    url.host_str().is_some().then_some(url)
}

/// Read time for a whole script call: halfway through it, since the position is read mid-call.
pub fn midpoint(before_ms: f64, after_ms: f64) -> f64 {
    if after_ms >= before_ms {
        before_ms + (after_ms - before_ms) / 2.0
    } else {
        after_ms
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// errAEEventNotPermitted (-1743) or consent required (-1744): Automation is off for this player.
    NotPermitted,
    /// procNotFound (-600) or connectionInvalid (-609): the player quit between check and read.
    NotRunning,
    /// errAETimeout (-1712): the player did not answer within the script's 2 s.
    Timeout,
    /// errAENoSuchObject (-1728) or errAEIllegalIndex (-1719): no current track.
    NoTrack,
    /// macOS is still showing (or about to show) the Automation prompt; no script ran.
    AwaitingConsent,
    Other,
}
impl FailureKind {
    /// A hiccup (a slow player, a busy main thread) rather than a state of the player. The
    /// player's last reading stands in for up to `HOLD`, so the lyrics don't blink off and reload.
    pub fn is_transient(self) -> bool {
        matches!(self, FailureKind::Timeout | FailureKind::Other)
    }
}
/// How long a reading may stand in for a player that failed transiently.
pub const HOLD: Duration = Duration::from_secs(5);
/// A player that timed out is left alone this long: every script it stalls blocks the main
/// thread for its 2 s timeout.
pub const TIMEOUT_COOLDOWN: Duration = Duration::from_secs(4);
pub fn classify(number: Option<i64>) -> FailureKind {
    match number {
        Some(-1743 | -1744) => FailureKind::NotPermitted,
        Some(-600 | -609) => FailureKind::NotRunning,
        Some(-1712) => FailureKind::Timeout,
        Some(-1728 | -1719) => FailureKind::NoTrack,
        _ => FailureKind::Other,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub kind: FailureKind,
    pub number: Option<i64>,
    pub message: String,
}
impl Failure {
    pub fn new(number: Option<i64>, message: impl Into<String>) -> Self {
        Self {
            kind: classify(number),
            number,
            message: message.into(),
        }
    }
    pub fn other(message: impl Into<String>) -> Self {
        Self::new(None, message)
    }
    fn awaiting_consent() -> Self {
        Self {
            kind: FailureKind::AwaitingConsent,
            number: None,
            message: "waiting for the Automation prompt to be answered".into(),
        }
    }
    /// The line to log for this failure, or `None` when it is part of normal use (a player
    /// quitting, nothing queued, the Automation prompt still open). Callers log each distinct
    /// line once.
    pub fn log_line(&self, player: Player) -> Option<String> {
        let name = player.name();
        match self.kind {
            FailureKind::NotPermitted => Some(format!(
                "{name}: macOS denied Undertone access (Automation, error {}). Lyrics for {name} \
                 stay hidden until you turn on Undertone → {name} in System Settings → Privacy & \
                 Security → Automation.",
                self.number.unwrap_or(-1743)
            )),
            FailureKind::NotRunning | FailureKind::NoTrack | FailureKind::AwaitingConsent => None,
            FailureKind::Timeout => Some(format!("{name} did not answer within 2 s; still trying")),
            FailureKind::Other => Some(match self.number {
                Some(number) => format!("{name} AppleScript failed ({number}): {}", self.message),
                None => format!("{name} AppleScript failed: {}", self.message),
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Verdict {
    #[default]
    Unknown,
    Granted,
    Denied,
}
/// macOS's Automation answer for one player. It is asked off the main thread before any script
/// runs: a script that triggers the prompt itself blocks the main thread (tray, settings,
/// overlays) until the user answers it.
#[derive(Debug, Default)]
pub struct Consent {
    verdict: Verdict,
    checked_at: Option<Instant>,
    asking: bool,
}
impl Consent {
    /// How often a denied player is asked again. Once the user has decided the answer is
    /// instant and shows no prompt; turning Automation on in System Settings then works at once.
    pub const RECHECK: Duration = Duration::from_secs(5);
    pub fn verdict(&self) -> Verdict {
        self.verdict
    }
    /// `Ok` when scripts may run, otherwise the failure to report. The flag asks the caller to
    /// start a check now (off the main thread) and hand its status to `answered`.
    pub fn gate(&mut self, now: Instant) -> (Result<(), Failure>, bool) {
        if self.verdict == Verdict::Granted {
            return (Ok(()), false);
        }
        let due = self.verdict == Verdict::Unknown
            || self
                .checked_at
                .is_none_or(|at| now.saturating_duration_since(at) >= Self::RECHECK);
        let ask = due && !self.asking;
        self.asking |= ask;
        let failure = match self.verdict {
            Verdict::Denied => Failure::new(Some(-1743), "Automation is off for this player"),
            _ => Failure::awaiting_consent(),
        };
        (Err(failure), ask)
    }
    /// `status` is AEDeterminePermissionToAutomateTarget's answer.
    pub fn answered(&mut self, status: i32, now: Instant) {
        self.asking = false;
        self.checked_at = Some(now);
        self.verdict = match (status, classify(Some(status.into()))) {
            (0, _) => Verdict::Granted,
            (_, FailureKind::NotPermitted) => Verdict::Denied,
            // The player quit before answering: ask again when it runs.
            (_, FailureKind::NotRunning) => Verdict::Unknown,
            // Anything unexpected: let the script run and report the real error.
            _ => Verdict::Granted,
        };
    }
    /// A script was refused after consent: Automation was turned off in System Settings.
    pub fn revoked(&mut self, now: Instant) {
        self.verdict = Verdict::Denied;
        self.checked_at = Some(now);
    }
}

/// What `media-status` hears from macOS: the first running player (Spotify, then Music) that
/// Automation is denied for, otherwise whether either player runs at all.
pub fn presence(running: &[Player], denied: impl Fn(Player) -> bool) -> Presence {
    if running.is_empty() {
        return Presence::NoPlayer;
    }
    Player::ALL
        .into_iter()
        .filter(|player| running.contains(player))
        .find(|player| denied(*player))
        .map_or(Presence::Running, |player| {
            Presence::Denied(player.source())
        })
}

/// Picks the reading to publish with `select_candidate`: a playing Spotify, then a playing
/// Music, then whichever was seen playing most recently. `activity` keeps those times.
pub fn choose(
    readings: &[(Player, PlayerState)],
    activity: &mut HashMap<Player, f64>,
    now_ms: f64,
) -> Option<usize> {
    let candidates: Vec<Candidate> = readings
        .iter()
        .map(|&(player, state)| {
            let playing = state == PlayerState::Playing;
            let last_active = activity.entry(player).or_insert(0.0);
            if playing {
                *last_active = now_ms;
            }
            Candidate {
                source: player.source(),
                is_playing: playing,
                last_active_ms: *last_active,
                is_current: false,
            }
        })
        .collect();
    select_candidate(&candidates)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn line(fields: &[&str]) -> String {
        fields.join("\u{1f}")
    }
    fn spotify(fields: &[&str]) -> Result<Option<Reading>, String> {
        parse_reading(Player::Spotify, &line(fields))
    }
    fn music(fields: &[&str]) -> Result<Option<Reading>, String> {
        parse_reading(Player::Music, &line(fields))
    }
    #[test]
    fn spotify_playing_converts_units_and_keeps_the_artwork_url() {
        let reading = spotify(&[
            "playing",
            "Paper Lantern",
            "Demo Artist",
            "Demo Album",
            "245000",
            "12.5",
            "https://i.scdn.co/image/demo",
        ])
        .unwrap()
        .unwrap();
        assert_eq!(
            reading,
            Reading {
                state: PlayerState::Playing,
                title: "Paper Lantern".into(),
                artist: "Demo Artist".into(),
                album: "Demo Album".into(),
                duration_ms: 245_000.0,
                position_ms: 12_500.0,
                artwork_url: Some("https://i.scdn.co/image/demo".into()),
            }
        );
        assert_eq!(
            reading.track_key(),
            "demo artist|paper lantern|demo album|245"
        );
        let raw = reading.into_raw(Player::Spotify, 1_700_000_000_000.0, None);
        assert_eq!(raw.source, Source::Spotify);
        assert!(raw.is_playing);
        assert_eq!(raw.sampled_at, 1_700_000_000_000.0);
    }
    #[test]
    fn music_durations_are_seconds_and_states_map_to_paused() {
        let reading = music(&["paused", "Tide", "Demo", "Album", "245.123", "3"])
            .unwrap()
            .unwrap();
        assert_eq!(reading.state, PlayerState::Paused);
        assert_eq!(reading.duration_ms, 245_123.0);
        assert_eq!(reading.position_ms, 3000.0);
        assert_eq!(reading.artwork_url, None);
        assert_eq!(
            reading.into_raw(Player::Music, 1.0, None).source,
            Source::AppleMusic
        );
        // Fast forwarding / rewinding.
        let scrubbing = music(&["other", "Tide", "Demo", "Album", "245", "3"])
            .unwrap()
            .unwrap();
        assert!(!scrubbing.is_playing());
    }
    #[test]
    fn stopped_closed_and_empty_players_are_not_tracks() {
        for output in ["stopped", "not-running", "", "  \n"] {
            assert_eq!(parse_reading(Player::Spotify, output), Ok(None));
            assert_eq!(parse_reading(Player::Music, output), Ok(None));
        }
        assert_eq!(music(&["stopped", "", "", "", "", ""]), Ok(None));
    }
    #[test]
    fn locale_decimal_commas_and_exponents() {
        let reading = music(&["playing", "Tide", "Demo", "Album", "245,5", "12,25"])
            .unwrap()
            .unwrap();
        assert_eq!(reading.duration_ms, 245_500.0);
        assert_eq!(reading.position_ms, 12_250.0);
        assert_eq!(parse_number("1,2345E+4"), Some(12_345.0));
        assert_eq!(parse_number("1.2345E+4"), Some(12_345.0));
        assert_eq!(parse_number(" 7 "), Some(7.0));
        assert_eq!(parse_number("0"), Some(0.0));
        assert_eq!(parse_number(""), None);
        assert_eq!(parse_number("missing value"), None);
        assert_eq!(parse_number("NaN"), None);
        assert_eq!(parse_number("inf"), None);
        assert_eq!(parse_number("abc"), None);
    }
    #[test]
    fn missing_fields_become_empty_or_zero() {
        // A local file in Spotify: no album, no artwork, no duration yet.
        let reading = spotify(&["paused", "Voice Memo", "", "", "", "missing value", ""])
            .unwrap()
            .unwrap();
        assert_eq!(reading.artist, "");
        assert_eq!(reading.album, "");
        assert_eq!(reading.duration_ms, 0.0);
        assert_eq!(reading.position_ms, 0.0);
        assert_eq!(reading.artwork_url, None);
        assert_eq!(reading.track_key(), "|voice memo||0");
        // An empty album keeps its place in the track key.
        let single = music(&["playing", "Tide", "Demo", "", "200", "1"])
            .unwrap()
            .unwrap();
        assert_eq!(single.track_key(), "demo|tide||200");
        // An empty title is still parsed; RawTrack::into_now_playing drops it later.
        assert_eq!(
            spotify(&["playing", "", "", "", "1000", "0", ""])
                .unwrap()
                .unwrap()
                .title,
            ""
        );
    }
    #[test]
    fn negative_values_are_clamped_and_text_is_kept_verbatim() {
        let reading = spotify(&[
            "playing",
            " Spaced Title ",
            "Ána, Bé & Cœ",
            "Album; \"Quoted\"",
            "-5",
            "-0,5",
            "  ",
        ])
        .unwrap()
        .unwrap();
        assert_eq!(reading.title, " Spaced Title ");
        assert_eq!(reading.artist, "Ána, Bé & Cœ");
        assert_eq!(reading.album, "Album; \"Quoted\"");
        assert_eq!(reading.duration_ms, 0.0);
        assert_eq!(reading.position_ms, 0.0);
        assert_eq!(reading.artwork_url, None);
    }
    #[test]
    fn malformed_answers_are_errors() {
        assert!(spotify(&["playing", "Only", "Three"]).is_err());
        // Music has no artwork URL field.
        assert!(music(&["playing", "a", "b", "c", "1", "2", "https://x"]).is_err());
        assert!(spotify(&["buffering", "a", "b", "c", "1", "2", ""]).is_err());
        assert!(parse_reading(Player::Spotify, "playing").is_err());
    }
    #[test]
    fn artwork_urls_are_upgraded_to_https_or_dropped() {
        assert_eq!(
            https_artwork_url("https://i.scdn.co/image/ab67")
                .unwrap()
                .as_str(),
            "https://i.scdn.co/image/ab67"
        );
        assert_eq!(
            https_artwork_url(" http://i.scdn.co/image/ab67 ")
                .unwrap()
                .as_str(),
            "https://i.scdn.co/image/ab67"
        );
        for raw in [
            "",
            "missing value",
            "file:///Users/demo/cover.jpg",
            "spotify:image:ab67",
            "https://",
        ] {
            assert_eq!(https_artwork_url(raw), None, "{raw}");
        }
    }
    #[test]
    fn midpoint_of_the_script_call() {
        assert_eq!(midpoint(1000.0, 1010.0), 1005.0);
        assert_eq!(midpoint(1000.0, 1000.0), 1000.0);
        // The wall clock stepped back during the call.
        assert_eq!(midpoint(1000.0, 900.0), 900.0);
    }
    /// AppleScript reserves its ordinal suffixes (`1st`, `2nd`, `3rd`, `4th`) along with its
    /// keywords. One as a variable name is a syntax error (-2741) that no Rust check sees.
    #[test]
    fn scripts_use_no_reserved_word_as_a_variable() {
        const RESERVED: [&str; 40] = [
            "st", "nd", "rd", "th", "it", "me", "my", "its", "the", "to", "of", "in", "on", "at",
            "by", "as", "is", "if", "or", "and", "not", "end", "get", "set", "ref", "mod", "div",
            "for", "from", "into", "with", "tell", "then", "else", "some", "every", "first",
            "last", "front", "back",
        ];
        for script in [SPOTIFY_READ, MUSIC_READ, MUSIC_ARTWORK] {
            for line in script.lines() {
                let mut words = line.split_whitespace();
                if words.next() == Some("set") {
                    let name = words.next().unwrap_or_default();
                    assert!(!RESERVED.contains(&name), "reserved word in: {line}");
                }
            }
        }
    }
    /// The real compiler, on a Mac. Music ships with macOS; Spotify's script needs Spotify's own
    /// dictionary, so it is checked only where Spotify is installed.
    #[cfg(target_os = "macos")]
    #[test]
    fn scripts_compile_with_osacompile() {
        let directory = tempfile::tempdir().unwrap();
        let mut scripts = vec![("music-read", MUSIC_READ), ("music-artwork", MUSIC_ARTWORK)];
        if std::path::Path::new("/Applications/Spotify.app").exists() {
            scripts.push(("spotify-read", SPOTIFY_READ));
        }
        for (name, source) in scripts {
            let input = directory.path().join(format!("{name}.applescript"));
            std::fs::write(&input, source).unwrap();
            let output = std::process::Command::new("/usr/bin/osacompile")
                .arg("-o")
                .arg(directory.path().join(format!("{name}.scpt")))
                .arg(&input)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{name}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
    #[test]
    fn apple_event_errors_are_classified() {
        assert_eq!(classify(Some(-1743)), FailureKind::NotPermitted);
        assert_eq!(classify(Some(-1744)), FailureKind::NotPermitted);
        assert_eq!(classify(Some(-600)), FailureKind::NotRunning);
        assert_eq!(classify(Some(-609)), FailureKind::NotRunning);
        assert_eq!(classify(Some(-1712)), FailureKind::Timeout);
        assert_eq!(classify(Some(-1728)), FailureKind::NoTrack);
        assert_eq!(classify(Some(-1719)), FailureKind::NoTrack);
        assert_eq!(classify(Some(-2741)), FailureKind::Other);
        assert_eq!(classify(None), FailureKind::Other);
    }
    #[test]
    fn denial_logs_one_actionable_hint_and_normal_cases_stay_quiet() {
        let hint = Failure::new(
            Some(-1743),
            "Not authorized to send Apple events to Spotify.",
        )
        .log_line(Player::Spotify)
        .unwrap();
        assert!(hint.contains("System Settings → Privacy & Security → Automation"));
        assert!(hint.contains("Undertone → Spotify"));
        assert!(hint.contains("-1743"));
        assert_eq!(Failure::new(Some(-600), "").log_line(Player::Music), None);
        assert_eq!(Failure::new(Some(-1728), "").log_line(Player::Music), None);
        assert!(Failure::new(Some(-1712), "")
            .log_line(Player::Music)
            .unwrap()
            .contains("2 s"));
        assert_eq!(
            Failure::new(Some(-2741), "Expected end of line")
                .log_line(Player::Spotify)
                .unwrap(),
            "Spotify AppleScript failed (-2741): Expected end of line"
        );
        assert_eq!(
            Failure::other("main thread busy")
                .log_line(Player::Music)
                .unwrap(),
            "Music AppleScript failed: main thread busy"
        );
    }
    #[test]
    fn only_hiccups_let_the_last_reading_stand_in() {
        assert!(classify(Some(-1712)).is_transient());
        assert!(Failure::other("the main thread did not answer within 3 s")
            .kind
            .is_transient());
        for number in [-1743, -600, -1728] {
            assert!(!classify(Some(number)).is_transient(), "{number}");
        }
        assert!(!FailureKind::AwaitingConsent.is_transient());
        assert!(TIMEOUT_COOLDOWN < HOLD);
    }
    #[test]
    fn consent_is_asked_once_and_scripts_wait_quietly_for_the_answer() {
        let start = Instant::now();
        let mut consent = Consent::default();
        let (gate, ask) = consent.gate(start);
        assert!(ask);
        let failure = gate.unwrap_err();
        assert_eq!(failure.kind, FailureKind::AwaitingConsent);
        assert_eq!(failure.log_line(Player::Spotify), None);
        // The prompt is still open: no second check, still waiting.
        let (gate, ask) = consent.gate(start + Duration::from_secs(30));
        assert!(!ask);
        assert_eq!(gate.unwrap_err().kind, FailureKind::AwaitingConsent);
        consent.answered(0, start + Duration::from_secs(31));
        assert_eq!(consent.verdict(), Verdict::Granted);
        assert_eq!(
            consent.gate(start + Duration::from_secs(32)),
            (Ok(()), false)
        );
    }
    #[test]
    fn denied_consent_reports_the_hint_and_is_rechecked_without_a_restart() {
        let start = Instant::now();
        let mut consent = Consent::default();
        assert!(consent.gate(start).1);
        consent.answered(-1743, start);
        assert_eq!(consent.verdict(), Verdict::Denied);
        let (gate, ask) = consent.gate(start + Duration::from_secs(1));
        assert!(!ask);
        let hint = gate.unwrap_err().log_line(Player::Music).unwrap();
        assert!(hint.contains("Privacy & Security → Automation"));
        // Due again: one check, and the hint (not "waiting") while it runs.
        let later = start + Consent::RECHECK;
        let (gate, ask) = consent.gate(later);
        assert!(ask);
        assert_eq!(gate.unwrap_err().kind, FailureKind::NotPermitted);
        assert!(!consent.gate(later).1);
        consent.answered(0, later);
        assert_eq!(consent.gate(later).0, Ok(()));
    }
    #[test]
    fn consent_follows_quits_revocations_and_unexpected_answers() {
        let now = Instant::now();
        let mut consent = Consent::default();
        assert!(consent.gate(now).1);
        // The player quit before answering: ask again on the next read.
        consent.answered(-600, now);
        assert_eq!(consent.verdict(), Verdict::Unknown);
        assert!(consent.gate(now).1);
        // Unexpected status (e.g. paramErr): let the script run and report what is wrong.
        consent.answered(-50, now);
        assert_eq!(consent.verdict(), Verdict::Granted);
        // A script refused after consent: Automation was switched off in System Settings.
        consent.revoked(now);
        let (gate, ask) = consent.gate(now);
        assert!(!ask);
        assert_eq!(gate.unwrap_err().kind, FailureKind::NotPermitted);
        assert!(consent.gate(now + Consent::RECHECK).1);
    }
    #[test]
    fn presence_names_a_denied_running_player_spotify_first() {
        let denied_both = |_: Player| true;
        let denied_none = |_: Player| false;
        let only_music = |player: Player| player == Player::Music;
        assert_eq!(presence(&[], denied_both), Presence::NoPlayer);
        assert_eq!(
            presence(&[Player::Music, Player::Spotify], denied_both),
            Presence::Denied(Source::Spotify)
        );
        assert_eq!(
            presence(&[Player::Spotify, Player::Music], only_music),
            Presence::Denied(Source::AppleMusic)
        );
        // A denied player that isn't running is no problem: it has nothing to show.
        assert_eq!(presence(&[Player::Spotify], only_music), Presence::Running);
        assert_eq!(
            presence(&[Player::Spotify, Player::Music], denied_none),
            Presence::Running
        );
        // As macOS reads it: no problem while the prompt is open, a denial once it is answered.
        let now = Instant::now();
        let mut verdicts = HashMap::from([(Player::Spotify, Consent::default())]);
        let read = |verdicts: &HashMap<Player, Consent>| {
            presence(&[Player::Spotify], |player| {
                verdicts
                    .get(&player)
                    .is_some_and(|consent| consent.verdict() == Verdict::Denied)
            })
        };
        let consent = verdicts.get_mut(&Player::Spotify).unwrap();
        assert!(consent.gate(now).1);
        assert_eq!(read(&verdicts), Presence::Running);
        verdicts
            .get_mut(&Player::Spotify)
            .unwrap()
            .answered(-1743, now);
        assert_eq!(read(&verdicts), Presence::Denied(Source::Spotify));
    }
    #[test]
    fn playing_spotify_then_playing_music_then_most_recent() {
        use PlayerState::*;
        let mut activity = HashMap::new();
        let both_playing = [(Player::Spotify, Playing), (Player::Music, Playing)];
        assert_eq!(choose(&both_playing, &mut activity, 10.0), Some(0));
        let music_playing = [(Player::Spotify, Paused), (Player::Music, Playing)];
        assert_eq!(choose(&music_playing, &mut activity, 20.0), Some(1));
        // Both paused: Music played last.
        let both_paused = [(Player::Spotify, Paused), (Player::Music, Paused)];
        assert_eq!(choose(&both_paused, &mut activity, 30.0), Some(1));
        assert_eq!(activity[&Player::Music], 20.0);
        assert_eq!(activity[&Player::Spotify], 10.0);
        // Never seen playing: Spotify breaks the tie.
        assert_eq!(choose(&both_paused, &mut HashMap::new(), 30.0), Some(0));
        assert_eq!(
            choose(&[(Player::Music, Paused)], &mut HashMap::new(), 1.0),
            Some(0)
        );
        assert_eq!(choose(&[], &mut activity, 40.0), None);
    }
    #[test]
    fn scripts_guard_launches_bound_events_and_match_the_parser() {
        for player in Player::ALL {
            let source = player.read_script().source();
            let guard = source
                .find(&format!(
                    "application id \"{}\" is not running",
                    player.bundle_id()
                ))
                .unwrap();
            let tell = source
                .find(&format!("tell application id \"{}\"", player.bundle_id()))
                .unwrap();
            assert!(guard < tell, "{player:?} must check before it tells");
            assert!(source.contains("with timeout of 2 seconds"));
            // Inside the `tell` it would be asked of the player instead.
            let separator = source.find("set d to character id 31").unwrap();
            assert!(separator < tell, "{player:?} builds the separator locally");
            assert_eq!(
                source.matches("& d &").count() + 1,
                player.fields(),
                "{player:?} field count"
            );
        }
        let artwork = Script::MusicArtwork.source();
        assert!(artwork.contains("with timeout of 2 seconds"));
        assert!(
            artwork.find("is not running").unwrap() < artwork.find("tell application").unwrap()
        );
        assert!(Player::ALL
            .iter()
            .all(|player| player.notification().starts_with(player.bundle_id())));
    }
}
