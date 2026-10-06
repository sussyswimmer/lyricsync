//! X7 `undertone --diagnose`: the first thing to run when something breaks. It prints what
//! Undertone sees right now (version and OS, media sources, the current track and its LRCLIB
//! match, settings, the lyrics cache, displays and the desktop layer) without starting the app,
//! and saves the same text to `undertone-diagnose-<timestamp>.txt` in the temp dir.
//!
//! Each section is gathered on its own and degrades to "unavailable: <reason>". Nothing here may
//! panic: release builds abort on panic, so the file is written section by section as a backstop.
//! The report holds no lyrics (line counts only), no artwork and no secrets. The formatting takes
//! plain data and is tested on every OS; `native` gathers that data on Windows and macOS.
use crate::{
    contract::{
        Lyrics, LyricsStatus, NowPlaying, Settings, ShortcutAction, Shortcuts, Source,
        CONTRACT_VERSION,
    },
    desktop_layer::geometry::Rect,
    lyrics::{
        cache::Cache,
        empty,
        lrclib::{Record, USER_AGENT},
        matching, Track,
    },
    media::{
        applescript::{classify, Failure, FailureKind, Player, PlayerState, Reading},
        RawTrack, Watcher,
    },
    settings,
    shortcuts::{plan, Plan},
};
use reqwest::{Client, StatusCode, Url};
use serde::de::DeserializeOwned;
use std::{
    ffi::OsString,
    fs::{File, OpenOptions},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// True when the process was started with `--diagnose`.
pub fn requested() -> bool {
    std::env::args().skip(1).any(|arg| arg == "--diagnose")
}

/// Prints the report, saves it to a file and returns the process exit code: 0 once the file is
/// saved, 1 when it could not be (the printed copy is then the only one).
pub fn run() -> i32 {
    let visible = native::prepare_output();
    let env = |name: &str| std::env::var_os(name);
    let mut print = |text: &str| {
        let mut stdout = std::io::stdout().lock();
        // A closed pipe or a missing console must not stop the report file.
        let _ = stdout
            .write_all(text.as_bytes())
            .and_then(|()| stdout.flush());
    };
    let (code, saved) = write_report(&std::env::temp_dir(), &env, &mut print);
    // Started without a terminal (a shortcut, Finder, `open`): show the file instead.
    if !visible {
        if let Some(path) = saved {
            native::reveal(&path);
        }
    }
    code
}

/// Reads an environment variable; injected so tests never see the real home or data dirs.
pub type Env<'a> = &'a dyn Fn(&str) -> Option<OsString>;
pub type RuntimeResult = Result<tokio::runtime::Runtime, String>;

/// The LRCLIB lookup gives up after this long, as the lyrics service does.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(6);
/// Windows' media controls answer in well under this; a hung session must not hang the report.
#[cfg(all(feature = "desktop", target_os = "windows"))]
const MEDIA_TIMEOUT: Duration = Duration::from_secs(10);
const LRCLIB_API: &str = "https://lrclib.net/api/";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
/// Where `settings::runtime` keeps the settings: one key in the store's file in the app data dir.
const SETTINGS_FILE: &str = "settings.json";
const SETTINGS_KEY: &str = "settings";
const MAX_SETTINGS_BYTES: u64 = 1024 * 1024;

/// Gathers every section into `dir`'s report file and `echo`, in order, and returns the exit code
/// with the saved file's path.
fn write_report(dir: &Path, env: Env<'_>, echo: &mut dyn FnMut(&str)) -> (i32, Option<PathBuf>) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let (now_secs, now_ms) = (now.as_secs(), now.as_secs_f64() * 1000.0);
    let mut out = Output {
        echo,
        file: create_report_file(dir, &file_stamp(now_secs)),
        failed: None,
    };
    let report = out.path();
    out.emit(&header_section(&Header {
        version: env!("CARGO_PKG_VERSION"),
        generated_at: now_secs,
        os: native::os_version(),
        arch: std::env::consts::ARCH,
        release: !cfg!(debug_assertions),
        executable: std::env::current_exe().map_err(|error| error.to_string()),
        report,
    }));
    let runtime: RuntimeResult = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|error| format!("async runtime: {error}"));
    let data_dir = identifier().and_then(|id| app_data_dir(std::env::consts::OS, &id, env));
    let settings_path = data_dir.clone().map(|dir| dir.join(SETTINGS_FILE));
    let stored = settings_path
        .as_ref()
        .map(|path| read_settings(path))
        .map_err(Clone::clone);

    let media = native::media(&runtime);
    out.emit(&sources_section(&media.sources));
    let effective = stored.as_ref().ok().map(StoredSettings::effective);
    out.emit(&track_section(&media.track, effective.as_ref(), now_ms));
    let lyrics = match (&media.track, &runtime) {
        (Ok(Some(track)), Ok(runtime)) => Ok(runtime.block_on(probe_lyrics(
            data_dir.as_ref().ok().cloned(),
            Track::from(track),
            now_secs,
        ))),
        (Ok(Some(_)), Err(error)) => Err(error.clone()),
        (Ok(None), _) => Err("nothing is playing, so there is nothing to look up".into()),
        (Err(error), _) => Err(format!("no current track ({error})")),
    };
    out.emit(&lyrics_section(&lyrics, now_secs));
    out.emit(&settings_section(&settings_path, &stored));
    out.emit(&cache_section(&data_dir.map(|dir| {
        let path = dir.join("lyrics");
        let contents = scan_cache(&path);
        CacheDir { path, contents }
    })));
    out.emit(&displays_section(&native::displays()));
    out.emit(&desktop_section(&native::desktop_layer()));
    if let Ok(runtime) = runtime {
        // A request still running on a worker must not hold the process open.
        runtime.shutdown_timeout(Duration::from_secs(1));
    }
    out.finish()
}

/// Echoes every section and appends it to the report file as soon as it is ready.
struct Output<'a> {
    echo: &'a mut dyn FnMut(&str),
    file: Result<(PathBuf, File), String>,
    /// The first failed write: the file is then incomplete.
    failed: Option<String>,
}
impl Output<'_> {
    fn path(&self) -> Result<PathBuf, String> {
        self.file
            .as_ref()
            .map(|(path, _)| path.clone())
            .map_err(Clone::clone)
    }
    fn emit(&mut self, section: &Section) {
        self.text(&section.render());
    }
    fn text(&mut self, text: &str) {
        (self.echo)(text);
        if let Ok((_, file)) = &mut self.file {
            if let Err(error) = file.write_all(text.as_bytes()) {
                self.failed.get_or_insert_with(|| error.to_string());
            }
        }
    }
    fn finish(mut self) -> (i32, Option<PathBuf>) {
        let (line, code, path) = match (self.path(), &self.failed) {
            (Ok(path), None) => (
                format!("\nReport saved to {}\n", path.display()),
                0,
                Some(path),
            ),
            (Ok(path), Some(error)) => (
                format!(
                    "\nReport only partly saved to {}: {error}\n",
                    path.display()
                ),
                1,
                Some(path),
            ),
            (Err(error), _) => (format!("\nReport not saved: {error}\n"), 1, None),
        };
        self.text(&line);
        (code, path)
    }
}

/// `undertone-diagnose-<stamp>.txt` in `dir`, never overwriting a file that is already there
/// (another run in the same second, or something planted in a shared temp dir).
pub fn create_report_file(dir: &Path, stamp: &str) -> Result<(PathBuf, File), String> {
    for attempt in 1..=20 {
        let name = if attempt == 1 {
            format!("undertone-diagnose-{stamp}.txt")
        } else {
            format!("undertone-diagnose-{stamp}-{attempt}.txt")
        };
        let path = dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("{}: {error}", path.display())),
        }
    }
    Err(format!(
        "{}: too many reports in the same second",
        dir.display()
    ))
}

// ---------------------------------------------------------------------------------------------
// Report data and formatting (portable).

/// One block of the report: its lines, or why they could not be gathered.
#[derive(Debug, Clone, PartialEq)]
pub struct Section {
    pub title: String,
    pub body: Result<Vec<String>, String>,
}
impl Section {
    pub fn new(title: impl Into<String>, body: Result<Vec<String>, String>) -> Self {
        Self {
            title: title.into(),
            body,
        }
    }
    pub fn render(&self) -> String {
        let mut text = format!("\n== {} ==\n", one_line(&self.title));
        match &self.body {
            Ok(lines) if lines.is_empty() => text.push_str("  (nothing to report)\n"),
            Ok(lines) => {
                for line in lines {
                    text.push_str("  ");
                    text.push_str(one_line(line).trim_end());
                    text.push('\n');
                }
            }
            Err(reason) => {
                text.push_str("  unavailable: ");
                text.push_str(&one_line(reason));
                text.push('\n');
            }
        }
        text
    }
}

/// Control characters (a newline in a title or an OS error) would break the report's layout.
fn one_line(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// `name: value`, with the values of one section lined up. An empty name continues the line above.
pub fn field(name: &str, value: impl std::fmt::Display) -> String {
    let name = if name.is_empty() {
        String::new()
    } else {
        format!("{name}:")
    };
    format!("{name:<13}{value}")
}

pub struct Header {
    pub version: &'static str,
    pub generated_at: u64,
    pub os: String,
    pub arch: &'static str,
    pub release: bool,
    pub executable: Result<PathBuf, String>,
    pub report: Result<PathBuf, String>,
}
pub fn header_section(header: &Header) -> Section {
    let path = |path: &Result<PathBuf, String>| match path {
        Ok(path) => path.display().to_string(),
        Err(error) => format!("unknown: {error}"),
    };
    Section::new(
        format!("Undertone {} diagnostics", header.version),
        Ok(vec![
            field("generated", utc(header.generated_at)),
            field("os", format!("{}, {}", header.os, header.arch)),
            field(
                "build",
                format!(
                    "{}, contract v{CONTRACT_VERSION}",
                    if header.release { "release" } else { "debug" }
                ),
            ),
            field("executable", path(&header.executable)),
            field(
                "report file",
                match &header.report {
                    Ok(report) => report.display().to_string(),
                    Err(error) => format!("not saved: {error}"),
                },
            ),
        ]),
    )
}

/// What the platform reports about now playing: one line per media source, and the track
/// Undertone would show.
pub struct Media {
    pub sources: Result<Vec<String>, String>,
    pub track: Result<Option<NowPlaying>, String>,
}
pub fn sources_section(sources: &Result<Vec<String>, String>) -> Section {
    Section::new("Media sources", sources.clone())
}

/// Windows: one SMTC session as Undertone sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct SmtcSession {
    pub app_id: String,
    pub status: String,
    /// Windows' own "current session".
    pub current: bool,
    /// How Undertone reads it; `None` when it is ignored (only playing or paused sessions count).
    pub source: Option<Source>,
    /// Title and artist, or why they could not be read.
    pub track: Result<(String, String), String>,
    pub thumbnail: bool,
    /// The session Undertone shows.
    pub selected: bool,
}
pub fn session_line(index: usize, session: &SmtcSession) -> String {
    let mut line = format!(
        "#{} {}: {}",
        index + 1,
        or_text(&session.app_id, "(no app id)"),
        session.status
    );
    if session.current {
        line.push_str(", Windows' current session");
    }
    match &session.source {
        Some(source) => line.push_str(&format!("; read as {}", source_name(source))),
        None => line.push_str("; ignored (not playing or paused)"),
    }
    match &session.track {
        Ok((title, artist)) => line.push_str(&format!("; {}", title_by(title, artist))),
        Err(error) => line.push_str(&format!("; metadata unavailable: {error}")),
    }
    if session.thumbnail {
        line.push_str(", has artwork");
    }
    if session.selected {
        line.push_str("  <- selected");
    }
    line
}

/// macOS: one player as Undertone sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct PlayerInfo {
    pub player: Player,
    pub running: bool,
    /// AEDeterminePermissionToAutomateTarget's answer, without prompting; `None` when not asked.
    pub automation: Option<i32>,
    /// The read script's answer (`Ok(None)`: stopped); `None` when no script ran.
    pub reading: Option<Result<Option<Reading>, Failure>>,
    pub selected: bool,
}
/// Whether Undertone runs its read script for an Automation answer: only a refusal (or a player
/// that quit) stops it. Mirrors `applescript::Consent::answered`.
pub fn automation_allows(status: i32) -> bool {
    !matches!(
        classify(Some(status.into())),
        FailureKind::NotPermitted | FailureKind::NotRunning
    )
}
pub fn automation_text(player: Player, status: i32) -> String {
    match status {
        0 => "Automation granted".into(),
        -1743 => format!(
            "Automation denied: turn it on in System Settings > Privacy & Security > Automation > \
             Undertone > {}",
            player.name()
        ),
        -1744 => format!(
            "Automation not decided yet: Undertone asks the first time it reads {}",
            player.name()
        ),
        -600 | -609 => "quit before Automation could be checked".into(),
        other => format!("Automation answered {other}; Undertone reads it anyway"),
    }
}
pub fn failure_text(failure: &Failure) -> String {
    let number = failure
        .number
        .map(|number| format!(" ({number})"))
        .unwrap_or_default();
    match failure.kind {
        FailureKind::NotPermitted => format!("Automation refused the script{number}"),
        FailureKind::NotRunning => "quit while being read".into(),
        FailureKind::Timeout => "did not answer within 2 s".into(),
        FailureKind::NoTrack => "no current track".into(),
        FailureKind::AwaitingConsent => "waiting for the Automation prompt".into(),
        FailureKind::Other => format!("script failed{number}: {}", failure.message),
    }
}
pub fn player_line(info: &PlayerInfo) -> String {
    let mut line = format!("{} ({}): ", info.player.name(), info.player.bundle_id());
    if !info.running {
        line.push_str("not running");
        return line;
    }
    line.push_str("running");
    if let Some(status) = info.automation {
        line.push_str("; ");
        line.push_str(&automation_text(info.player, status));
    }
    match &info.reading {
        None => {}
        Some(Ok(None)) => line.push_str("; stopped, no track"),
        Some(Ok(Some(reading))) => {
            let state = match reading.state {
                PlayerState::Playing => "playing",
                PlayerState::Paused => "paused",
            };
            line.push_str(&format!(
                "; {state} {}",
                title_by(&reading.title, &reading.artist)
            ));
            if reading.artwork_url.is_some() {
                line.push_str(", has an artwork URL");
            }
        }
        Some(Err(failure)) => line.push_str(&format!("; read failed: {}", failure_text(failure))),
    }
    if info.selected {
        line.push_str("  <- selected");
    }
    line
}

/// The track Undertone would publish for the selected source's `raw` reading, with the media
/// watcher's own checks, or why it publishes none (an empty title or a broken timeline): the
/// overlay then shows nothing although a source is playing, which is what this report is for.
pub fn now_playing(raw: RawTrack) -> Result<NowPlaying, String> {
    let untitled = raw.title.trim().is_empty();
    Watcher::default()
        .update(Some(raw), 0)
        .and_then(|update| update.now_playing)
        .ok_or_else(|| {
            if untitled {
                "the selected source's track has no title, so Undertone shows nothing".into()
            } else {
                "the selected source's timeline is broken (duration, position or sample time), \
                 so Undertone shows nothing"
                    .into()
            }
        })
}

/// How `media/windows.rs` classifies a session's app id.
pub fn smtc_source(app_id: &str) -> Source {
    let app_id = app_id.to_lowercase();
    if app_id.contains("spotify") {
        Source::Spotify
    } else if app_id.contains("applemusic") || app_id.contains("apple-music") {
        Source::AppleMusic
    } else {
        Source::System
    }
}

pub fn track_section(
    track: &Result<Option<NowPlaying>, String>,
    settings: Option<&Settings>,
    now_ms: f64,
) -> Section {
    let body = match track {
        Err(error) => Err(error.clone()),
        Ok(None) => Ok(vec![
            "nothing is playing: no media source has a playing or paused track".into(),
        ]),
        Ok(Some(track)) => Ok(track_lines(track, settings, now_ms)),
    };
    Section::new("Current track", body)
}
fn track_lines(track: &NowPlaying, settings: Option<&Settings>, now_ms: f64) -> Vec<String> {
    let age = now_ms - track.sampled_at;
    let sampled = if age >= 0.0 {
        format!("sampled {} ms before this report", age.round())
    } else {
        format!("stamped {} ms ahead of the clock", (-age).round())
    };
    let position = if track.is_playing {
        let mut now = track.position_ms + age.max(0.0);
        if track.duration_ms > 0.0 {
            now = now.min(track.duration_ms);
        }
        format!(
            "{} ({sampled}), so about {} now",
            clock(track.position_ms),
            clock(now)
        )
    } else {
        format!("{} ({sampled}), paused", clock(track.position_ms))
    };
    let duration = if track.duration_ms > 0.0 {
        format!(
            "{} ({} ms)",
            clock(track.duration_ms),
            track.duration_ms.round()
        )
    } else {
        "unknown (0 ms): LRCLIB matches by duration".into()
    };
    let mut lines = vec![
        field("source", source_name(&track.source)),
        field("title", &track.title),
        field("artist", or_text(&track.artist, "(none)")),
        field("album", or_text(&track.album, "(none)")),
        field("duration", duration),
        field("playing", if track.is_playing { "yes" } else { "no" }),
        field("position", position),
        field("track key", &track.track_key),
    ];
    if let Some(settings) = settings {
        let song = settings
            .track_offsets_ms
            .get(&track.track_key)
            .copied()
            .unwrap_or(0.0);
        lines.push(field(
            "sync offset",
            format!(
                "{} ms global, {} ms for this song",
                signed(settings.global_offset_ms, 0),
                signed(song, 0)
            ),
        ));
    }
    lines
}

/// What the lyrics cache holds for the current track.
#[derive(Debug, Clone, PartialEq)]
pub enum CacheProbe {
    Hit {
        lyrics: Lyrics,
        saved_at: u64,
    },
    /// No entry for this track.
    Miss,
    /// An entry Undertone does not use: an expired not-found, unreadable, or another track's.
    Ignored,
    Failed(String),
}
/// One LRCLIB lookup, request by request.
#[derive(Debug, Clone)]
pub struct Lookup {
    /// One line per request, in order.
    pub requests: Vec<String>,
    /// The accepted record (`None`: not found) and the lyrics Undertone makes of it.
    pub result: Result<(Option<Record>, Lyrics), String>,
}
#[derive(Debug, Clone)]
pub struct LyricsProbe {
    pub track_ms: f64,
    pub cache_file: Option<PathBuf>,
    pub cache: CacheProbe,
    pub lookup: Lookup,
}
pub fn lyrics_section(probe: &Result<LyricsProbe, String>, now_secs: u64) -> Section {
    Section::new(
        "Lyrics (LRCLIB)",
        probe
            .as_ref()
            .map(|probe| lyrics_lines(probe, now_secs))
            .map_err(Clone::clone),
    )
}
fn lyrics_lines(probe: &LyricsProbe, now_secs: u64) -> Vec<String> {
    // The service reads its cache first and asks LRCLIB only without a usable entry.
    let shown = match (&probe.cache, &probe.lookup.result) {
        (CacheProbe::Hit { lyrics, .. }, _) => format!("{}, from the cache", describe(lyrics)),
        (_, Ok((_, lyrics))) => format!("{}, from LRCLIB", describe(lyrics)),
        (_, Err(_)) => "error: the lookup failed (below); Undertone retries on Refetch".into(),
    };
    let mut lines = vec![field("shows", shown)];
    lines.push(field(
        "cache",
        match &probe.cache {
            CacheProbe::Hit { lyrics, saved_at } => {
                format!("{}, saved {}", describe(lyrics), age(now_secs, *saved_at))
            }
            CacheProbe::Miss => "no entry: Undertone asks LRCLIB".into(),
            CacheProbe::Ignored => "an entry Undertone ignores (an expired not-found, unreadable, \
                 or another track's): it asks LRCLIB"
                .into(),
            CacheProbe::Failed(error) => format!("unavailable: {error}"),
        },
    ));
    if let Some(path) = &probe.cache_file {
        lines.push(field("cache file", path.display()));
    }
    for (index, request) in probe.lookup.requests.iter().enumerate() {
        lines.push(field(if index == 0 { "requests" } else { "" }, request));
    }
    match &probe.lookup.result {
        Ok((Some(record), lyrics)) => {
            let delta = record.duration - probe.track_ms / 1000.0;
            lines.push(field("match", record_name(record)));
            lines.push(field(
                "duration",
                format!(
                    "{} s on LRCLIB, {} s playing: delta {} s, {}",
                    round1(record.duration),
                    round1(probe.track_ms / 1000.0),
                    signed(delta, 1),
                    tier(delta)
                ),
            ));
            lines.push(field("lrclib", describe(lyrics)));
        }
        Ok((None, _)) => lines.push(field("match", "none: not-found")),
        Err(error) => lines.push(field("lookup", format!("unavailable: {error}"))),
    }
    lines
}

/// Status and line counts, never the text.
pub fn describe(lyrics: &Lyrics) -> String {
    let status = status_name(&lyrics.status);
    let mut parts = Vec::new();
    if let Some(synced) = &lyrics.synced {
        parts.push(format!("synced {} lines", line_count(synced)));
    }
    if let Some(plain) = &lyrics.plain {
        parts.push(format!("plain {} lines", line_count(plain)));
    }
    if parts.is_empty() {
        status.into()
    } else {
        format!("{status}: {}", parts.join(", "))
    }
}
fn line_count(text: &str) -> usize {
    text.lines().filter(|line| !line.trim().is_empty()).count()
}
fn status_name(status: &LyricsStatus) -> &'static str {
    match status {
        LyricsStatus::Loading => "loading",
        LyricsStatus::Found => "found",
        LyricsStatus::PlainOnly => "plain-only",
        LyricsStatus::Instrumental => "instrumental",
        LyricsStatus::NotFound => "not-found",
        LyricsStatus::Error => "error",
    }
}
fn record_name(record: &Record) -> String {
    let mut name = format!(
        "#{} {}",
        record.id,
        title_by(&record.track_name, &record.artist_name)
    );
    if !record.album_name.is_empty() {
        name.push_str(&format!(" on {:?}", record.album_name));
    }
    if record.instrumental {
        name.push_str(", instrumental");
    }
    name
}
/// LRCLIB's duration tiers (`matching::best`).
fn tier(delta: f64) -> &'static str {
    match delta.abs() {
        d if d <= 2.0 => "within 2 s (best tier)",
        d if d <= 5.0 => "within 5 s",
        d if d <= 8.0 => "within 8 s (last accepted tier)",
        _ => "over 8 s (rejected)",
    }
}

/// The settings file as Undertone loads it on start.
#[derive(Debug, Clone, PartialEq)]
pub enum StoredSettings {
    /// No file yet: Undertone starts from the defaults and writes them.
    Missing,
    /// A file Undertone cannot use: it starts from the defaults and overwrites it.
    Unreadable(String),
    /// `current` is false when Undertone repairs or migrates (rewrites) `stored` on start.
    Loaded {
        settings: Box<Settings>,
        current: bool,
        stored: serde_json::Value,
    },
}
impl StoredSettings {
    /// The settings Undertone runs with.
    pub fn effective(&self) -> Settings {
        match self {
            StoredSettings::Loaded { settings, .. } => Settings::clone(settings),
            _ => Settings::default(),
        }
    }
}
pub fn read_settings(path: &Path) -> StoredSettings {
    let bytes = match read_limited(path, MAX_SETTINGS_BYTES) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return StoredSettings::Missing,
        Err(error) => return StoredSettings::Unreadable(error.to_string()),
    };
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) => return StoredSettings::Unreadable(format!("not JSON: {error}")),
    };
    let Some(stored) = value.get(SETTINGS_KEY) else {
        return StoredSettings::Unreadable(format!("no {SETTINGS_KEY:?} entry"));
    };
    let (settings, rewrite) = settings::load(Some(stored));
    StoredSettings::Loaded {
        settings: Box::new(settings),
        current: !rewrite,
        stored: stored.clone(),
    }
}
fn read_limited(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(std::io::Error::other(format!(
            "larger than {} KiB",
            limit / 1024
        )));
    }
    Ok(bytes)
}
pub fn settings_section(
    path: &Result<PathBuf, String>,
    stored: &Result<StoredSettings, String>,
) -> Section {
    let body = path.as_ref().map_err(Clone::clone).and_then(|path| {
        let stored = stored.as_ref().map_err(Clone::clone)?;
        let state = match stored {
            StoredSettings::Missing => "no file yet: Undertone uses the defaults".into(),
            StoredSettings::Unreadable(error) => {
                format!("unusable ({error}): Undertone uses the defaults and overwrites it")
            }
            StoredSettings::Loaded { current: true, .. } => "saved, current".into(),
            StoredSettings::Loaded { current: false, .. } => {
                "saved; Undertone repairs or migrates it on start".into()
            }
        };
        let json = |value: &serde_json::Value| {
            serde_json::to_string_pretty(value).map_err(|error| format!("settings: {error}"))
        };
        let effective = serde_json::to_value(stored.effective())
            .map_err(|error| format!("settings: {error}"))?;
        let mut lines = vec![field("file", path.display()), field("state", state)];
        lines.extend(switch_lines(&stored.effective(), cfg!(target_os = "macos")));
        // What is on disk, when it differs from what Undertone runs with.
        if let StoredSettings::Loaded {
            current: false,
            stored,
            ..
        } = stored
        {
            lines.push("stored:".into());
            lines.extend(json(stored)?.lines().map(|line| format!("  {line}")));
        }
        lines.push("effective:".into());
        lines.extend(json(&effective)?.lines().map(|line| format!("  {line}")));
        Ok(lines)
    });
    Section::new("Settings", body)
}

/// Lyrics on or off, launch at login, and the shortcuts, ahead of the full settings. Whether
/// another app holds a key combination only the running app can tell (Settings › Shortcuts).
pub fn switch_lines(settings: &Settings, macos: bool) -> Vec<String> {
    let lyrics = if settings.enabled {
        "on"
    } else {
        "off: hidden on every display until turned on in Settings, the menu or the shortcut"
    };
    let shortcuts = &settings.shortcuts;
    let mut lines = vec![
        field("lyrics", lyrics),
        field(
            "at login",
            if settings.launch_at_login {
                "launch Undertone"
            } else {
                "off"
            },
        ),
        field(
            "shortcuts",
            if shortcuts.enabled {
                "on"
            } else {
                "off (the bindings below are kept)"
            },
        ),
    ];
    // Planned as if on, so a binding this OS can't use shows even while shortcuts are off.
    let planned = plan(
        &Shortcuts {
            enabled: true,
            ..shortcuts.clone()
        },
        macos,
    );
    for (action, plan) in planned {
        let binding = shortcuts.binding(action);
        let text = match plan {
            Plan::Off => "none".to_owned(),
            Plan::Invalid => format!("{binding} (not usable on this OS)"),
            Plan::Register(accelerator) => accelerator,
        };
        let name = match action {
            ShortcutAction::ToggleLyrics => "  toggle",
            ShortcutAction::NudgeEarlier => "  earlier",
            ShortcutAction::NudgeLater => "  later",
        };
        lines.push(field(name, text));
    }
    lines
}

pub struct CacheDir {
    pub path: PathBuf,
    /// Entry count and total size; `None` while the directory does not exist.
    pub contents: Result<Option<(usize, u64)>, String>,
}
pub fn scan_cache(path: &Path) -> Result<Option<(usize, u64)>, String> {
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let (mut count, mut bytes) = (0, 0);
    for entry in entries.flatten() {
        if entry.path().extension().is_some_and(|ext| ext == "json") {
            count += 1;
            bytes += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        }
    }
    Ok(Some((count, bytes)))
}
pub fn cache_section(cache: &Result<CacheDir, String>) -> Section {
    Section::new(
        "Lyrics cache",
        cache.as_ref().map_err(Clone::clone).map(|cache| {
            vec![
                field("dir", cache.path.display()),
                field(
                    "entries",
                    match &cache.contents {
                        Ok(Some((songs, bytes))) => {
                            format!("{}, {}", count(*songs, "song"), size(*bytes))
                        }
                        Ok(None) => "none yet (the folder is created on the first lookup)".into(),
                        Err(error) => format!("unavailable: {error}"),
                    },
                ),
            ]
        }),
    )
}

/// One display as the OS reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct Display {
    pub name: String,
    /// Windows: physical pixels on the virtual desktop. macOS: points from the primary screen's
    /// top-left corner, y down (Quartz), the space tauri's monitors use.
    pub frame: Rect,
    /// Without the taskbar, menu bar or Dock.
    pub work_area: Option<Rect>,
    pub unit: &'static str,
    pub scale: Option<f64>,
    pub primary: bool,
}
pub fn display_line(index: usize, display: &Display) -> String {
    let mut line = format!(
        "#{index} {}{}: {} at ({}, {})",
        or_text(&display.name, "(unnamed)"),
        if display.primary { " (primary)" } else { "" },
        extent(&display.frame, display.unit),
        number(display.frame.x),
        number(display.frame.y)
    );
    if let Some(scale) = display.scale {
        line.push_str(&format!(", scale {}%", (scale * 100.0).round()));
        if display.unit == "pt" {
            line.push_str(&format!(
                " = {}x{} px",
                number(display.frame.width * scale),
                number(display.frame.height * scale)
            ));
        }
    }
    if let Some(work) = &display.work_area {
        line.push_str(&format!(
            "; usable {} at ({}, {})",
            extent(work, display.unit),
            number(work.x),
            number(work.y)
        ));
    }
    line
}
pub fn displays_section(displays: &Result<Vec<Display>, String>) -> Section {
    Section::new(
        "Displays",
        displays.as_ref().map_err(Clone::clone).map(|displays| {
            displays
                .iter()
                .enumerate()
                .map(|(index, display)| display_line(index, display))
                .collect()
        }),
    )
}
pub fn desktop_section(lines: &Result<Vec<String>, String>) -> Section {
    Section::new("Desktop layer", lines.clone())
}

/// Windows' marketing name for a build: the desktop layer changed shape in 24H2.
pub fn windows_version(major: u32, minor: u32, build: u32) -> String {
    let release = match build {
        19041 => Some("2004"),
        19042 => Some("20H2"),
        19043 => Some("21H1"),
        19044 => Some("21H2"),
        19045 => Some("22H2"),
        22000 => Some("21H2"),
        22621 => Some("22H2"),
        22631 => Some("23H2"),
        26100 => Some("24H2"),
        26200 => Some("25H2"),
        _ => None,
    };
    let name = match (major, build) {
        (10, 22000..) => "Windows 11".to_owned(),
        (10, _) => "Windows 10".to_owned(),
        _ => format!("Windows {major}.{minor}"),
    };
    match release {
        Some(release) => format!("{name} {release} ({major}.{minor}.{build})"),
        None => format!("{name} ({major}.{minor}.{build})"),
    }
}

fn source_name(source: &Source) -> &'static str {
    match source {
        Source::Spotify => "spotify",
        Source::AppleMusic => "apple-music",
        Source::System => "system",
    }
}
fn or_text<'a>(text: &'a str, fallback: &'a str) -> &'a str {
    if text.trim().is_empty() {
        fallback
    } else {
        text
    }
}
fn title_by(title: &str, artist: &str) -> String {
    format!("{title:?} by {}", or_text(artist, "(no artist)"))
}
/// `m:ss.mmm`.
fn clock(ms: f64) -> String {
    let total = ms.max(0.0).round() as u64;
    format!(
        "{}:{:02}.{:03}",
        total / 60_000,
        total / 1000 % 60,
        total % 1000
    )
}
fn count(n: usize, noun: &str) -> String {
    if n == 1 {
        format!("1 {noun}")
    } else {
        format!("{n} {noun}s")
    }
}
fn round1(value: f64) -> String {
    format!("{value:.1}")
}
/// Signed unless it rounds to zero. ASCII only, like every label here: a report piped through
/// `more` or PowerShell on Windows is decoded with the console's OEM code page.
fn signed(value: f64, decimals: usize) -> String {
    let text = format!("{:.*}", decimals, value.abs());
    if text.chars().all(|c| c == '0' || c == '.') {
        text
    } else if value < 0.0 {
        format!("-{text}")
    } else {
        format!("+{text}")
    }
}
/// Whole numbers without decimals, others with one.
fn number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        format!("{value:.1}")
    }
}
fn extent(rect: &Rect, unit: &str) -> String {
    format!("{}x{} {unit}", number(rect.width), number(rect.height))
}
fn size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}
fn age(now_secs: u64, then_secs: u64) -> String {
    let when = utc(then_secs);
    match now_secs.checked_sub(then_secs) {
        Some(secs) if secs < 120 => format!("{when} (just now)"),
        Some(secs) if secs < 2 * 3600 => format!("{when} ({} minutes ago)", secs / 60),
        Some(secs) if secs < 2 * 86_400 => format!("{when} ({} hours ago)", secs / 3600),
        Some(secs) => format!("{when} ({} days ago)", secs / 86_400),
        None => format!("{when} (in the future)"),
    }
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian (Howard Hinnant's algorithm).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month as u32, day as u32)
}
fn utc_parts(secs: u64) -> (i64, u32, u32, u64, u64, u64) {
    let (year, month, day) = civil((secs / 86_400) as i64);
    let rest = secs % 86_400;
    (year, month, day, rest / 3600, rest / 60 % 60, rest % 60)
}
/// `2026-10-06 09:05:00 UTC`.
pub fn utc(secs: u64) -> String {
    let (year, month, day, hour, minute, second) = utc_parts(secs);
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02} UTC")
}
/// `20261006-090500`, for the report's file name.
pub fn file_stamp(secs: u64) -> String {
    let (year, month, day, hour, minute, second) = utc_parts(secs);
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
}

/// The bundle identifier from tauri.conf.json, which names the app data dir.
pub fn identifier() -> Result<String, String> {
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .map_err(|error| format!("tauri.conf.json: {error}"))?;
    config
        .get("identifier")
        .and_then(|id| id.as_str())
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "tauri.conf.json has no identifier".into())
}
/// Tauri's `app_data_dir` without an app: the OS data dir (`dirs::data_dir`) joined with the
/// bundle identifier. Windows: the roaming AppData; macOS: `~/Library/Application Support`.
pub fn app_data_dir(os: &str, identifier: &str, env: Env<'_>) -> Result<PathBuf, String> {
    let var = |name: &str| {
        env(name)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };
    let base = match os {
        "windows" => var("APPDATA").ok_or("APPDATA is not set")?,
        "macos" => var("HOME")
            .ok_or("HOME is not set")?
            .join("Library")
            .join("Application Support"),
        _ => var("XDG_DATA_HOME")
            .or_else(|| var("HOME").map(|home| home.join(".local").join("share")))
            .ok_or("neither XDG_DATA_HOME nor HOME is set")?,
    };
    Ok(base.join(identifier))
}

// ---------------------------------------------------------------------------------------------
// Lyrics: the cache as the service reads it, and LRCLIB as the provider asks it.

async fn probe_lyrics(data_dir: Option<PathBuf>, track: Track, now_secs: u64) -> LyricsProbe {
    let (cache_file, cache) = match data_dir {
        None => (
            None,
            CacheProbe::Failed("the app data dir is unknown".into()),
        ),
        Some(dir) => {
            let cache = Cache::new(dir);
            let path = cache.path(&track.key);
            let probe = match cache.read(&track.key, now_secs).await {
                Ok(Some(entry)) => CacheProbe::Hit {
                    lyrics: entry.lyrics,
                    saved_at: entry.saved_at,
                },
                Ok(None) if path.exists() => CacheProbe::Ignored,
                Ok(None) => CacheProbe::Miss,
                Err(error) => CacheProbe::Failed(error.to_string()),
            };
            (Some(path), probe)
        }
    };
    let lookup = match (lrclib_client(false), Url::parse(LRCLIB_API)) {
        (Ok(client), Ok(base)) => lookup(&client, &base, &track).await,
        (Err(error), _) => Lookup {
            requests: Vec::new(),
            result: Err(error),
        },
        (_, Err(error)) => Lookup {
            requests: Vec::new(),
            result: Err(error.to_string()),
        },
    };
    LyricsProbe {
        track_ms: track.duration_ms,
        cache_file,
        cache,
        lookup,
    }
}

/// Configured like `LrcLib`'s client. `local_test` skips proxies for a server on 127.0.0.1.
pub fn lrclib_client(local_test: bool) -> Result<Client, String> {
    let mut builder = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(LOOKUP_TIMEOUT)
        .connect_timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none());
    if local_test {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|error| error.to_string())
}

/// The provider's lookup (`LrcLib::lookup`: the exact get, a search, then a search with the
/// cleaned-up title, each answer ranked by `matching::best`), keeping the record it accepts so the
/// report can show its duration. Read-only: nothing is cached. Gives up after six seconds overall.
pub async fn lookup(client: &Client, base: &Url, track: &Track) -> Lookup {
    let deadline = tokio::time::Instant::now() + LOOKUP_TIMEOUT;
    let mut requests = Vec::new();
    let result = lookup_steps(client, base, track, deadline, &mut requests).await;
    Lookup { requests, result }
}
async fn lookup_steps(
    client: &Client,
    base: &Url,
    track: &Track,
    deadline: tokio::time::Instant,
    log: &mut Vec<String>,
) -> Result<(Option<Record>, Lyrics), String> {
    if !track.duration_ms.is_finite()
        || track.duration_ms < 0.0
        || track.title.trim().is_empty()
        || track.artist.trim().is_empty()
    {
        return Err("track metadata is incomplete: LRCLIB needs a title and an artist".into());
    }
    let seconds = track.duration_ms / 1000.0;
    let label = format!(
        "get {} on {:?}, {} s",
        title_by(&track.title, &track.artist),
        track.album,
        round1(seconds)
    );
    let exact: Option<Record> = fetch(
        client,
        base,
        "get",
        &[
            ("track_name", track.title.clone()),
            ("artist_name", track.artist.clone()),
            ("album_name", track.album.clone()),
            ("duration", seconds.to_string()),
        ],
        true,
        deadline,
    )
    .await
    .inspect_err(|error| log.push(format!("{label} -> {error}")))?;
    match exact {
        None => log.push(format!("{label} -> not found (404)")),
        Some(record) => {
            if matching::best(track, std::slice::from_ref(&record)).is_some() {
                log.push(format!("{label} -> {}, accepted", record_name(&record)));
                let lyrics = record.into_lyrics(&track.key);
                return Ok((Some(record), lyrics));
            }
            log.push(format!(
                "{label} -> {}, rejected (delta {} s, or another title or artist)",
                record_name(&record),
                signed(record.duration - seconds, 1)
            ));
        }
    }
    if let Some(record) = search(client, base, track, &track.title, deadline, log).await? {
        let lyrics = record.into_lyrics(&track.key);
        return Ok((Some(record), lyrics));
    }
    let retry = matching::retry_title(&track.title);
    if !retry.is_empty() && retry != track.title {
        if let Some(record) = search(client, base, track, &retry, deadline, log).await? {
            let lyrics = record.into_lyrics(&track.key);
            return Ok((Some(record), lyrics));
        }
    }
    Ok((None, empty(&track.key, LyricsStatus::NotFound)))
}
async fn search(
    client: &Client,
    base: &Url,
    track: &Track,
    title: &str,
    deadline: tokio::time::Instant,
    log: &mut Vec<String>,
) -> Result<Option<Record>, String> {
    let label = format!("search {}", title_by(title, &track.artist));
    let records: Vec<Record> = fetch(
        client,
        base,
        "search",
        &[
            ("track_name", title.to_owned()),
            ("artist_name", track.artist.clone()),
        ],
        false,
        deadline,
    )
    .await
    .inspect_err(|error| log.push(format!("{label} -> {error}")))?
    .unwrap_or_default();
    let seconds = track.duration_ms / 1000.0;
    if let Some(record) = matching::best(track, &records) {
        log.push(format!(
            "{label} -> {}, picked {}",
            count(records.len(), "result"),
            record_name(record)
        ));
        return Ok(Some(record.clone()));
    }
    if records.is_empty() {
        log.push(format!("{label} -> no results"));
        return Ok(None);
    }
    let closest = records
        .iter()
        .map(|record| record.duration - seconds)
        .filter(|delta| delta.is_finite())
        .min_by(|a, b| a.abs().total_cmp(&b.abs()));
    log.push(format!(
        "{label} -> {}, none accepted{}",
        count(records.len(), "result"),
        closest
            .map(|delta| format!(" (closest duration delta {} s)", signed(delta, 1)))
            .unwrap_or_default()
    ));
    Ok(None)
}
async fn fetch<T: DeserializeOwned>(
    client: &Client,
    base: &Url,
    endpoint: &str,
    query: &[(&str, String)],
    allow_404: bool,
    deadline: tokio::time::Instant,
) -> Result<Option<T>, String> {
    let url = base.join(endpoint).map_err(|error| error.to_string())?;
    let request = async {
        let mut response = client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .query(query)
            .send()
            .await
            .map_err(|error| error_chain(&error))?;
        let status = response.status();
        if allow_404 && status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(format!("HTTP {}", status.as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err("response exceeds 2 MiB".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| error_chain(&error))?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err("response exceeds 2 MiB".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("invalid JSON: {error}"))
    };
    tokio::time::timeout_at(deadline, request)
        .await
        .map_err(|_| {
            format!(
                "timed out (Undertone gives up after {} s)",
                LOOKUP_TIMEOUT.as_secs()
            )
        })?
}
/// An error with its causes, which name the real problem (DNS, TLS, proxy).
fn error_chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        if !text.contains(&cause_text) {
            text.push_str(": ");
            text.push_str(&cause_text);
        }
        source = cause.source();
    }
    text
}

// ---------------------------------------------------------------------------------------------
// Platform probes. Each one degrades to an error string; none starts the Tauri event loop.

/// Windows: SMTC sessions, monitors and Explorer's desktop windows, read directly.
#[cfg(all(feature = "desktop", target_os = "windows"))]
mod native {
    use super::{
        field, now_playing, session_line, smtc_source, windows_version, Display, Media,
        RuntimeResult, SmtcSession, MEDIA_TIMEOUT,
    };
    use crate::{
        contract::NowPlaying,
        desktop_layer::{self, geometry::Rect},
        media::{epoch_ms, select_candidate, windows_sample_time, Candidate, RawTrack},
    };
    use std::{
        ffi::c_void,
        os::windows::ffi::OsStrExt,
        path::Path,
        ptr::{null, null_mut},
        time::Duration,
    };
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as SessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows_sys::{
        core::w,
        Win32::{
            Foundation::{HWND, LPARAM, RECT},
            Graphics::Gdi::{
                EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
            },
            UI::{
                Shell::SEE_MASK_NOASYNC,
                WindowsAndMessaging::{
                    EnumWindows, FindWindowExW, FindWindowW, GetClassNameW, IsWindowVisible,
                    MONITORINFOF_PRIMARY, SW_SHOWNORMAL,
                },
            },
        },
    };

    /// OSVERSIONINFOW.
    #[repr(C)]
    struct OsVersionInfo {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }
    /// SHELLEXECUTEINFOW (windows-sys declares it only with its Registry feature, for one HKEY).
    #[repr(C)]
    struct ShellExecuteInfo {
        size: u32,
        mask: u32,
        window: HWND,
        verb: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
        instance: *mut c_void,
        id_list: *mut c_void,
        class: *const u16,
        class_key: *mut c_void,
        hot_key: u32,
        icon_or_monitor: *mut c_void,
        process: *mut c_void,
    }
    const _: () = assert!(
        std::mem::size_of::<ShellExecuteInfo>()
            == if cfg!(target_pointer_width = "64") {
                112
            } else {
                60
            }
    );
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(id: u32) -> *mut c_void;
        fn SetStdHandle(id: u32, handle: *mut c_void) -> i32;
        fn GetFileType(handle: *mut c_void) -> u32;
        fn AttachConsole(process: u32) -> i32;
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *const c_void,
            disposition: u32,
            flags: u32,
            template: *mut c_void,
        ) -> *mut c_void;
    }
    #[link(name = "ntdll")]
    extern "system" {
        /// Unlike GetVersionExW, never capped by the manifest's supportedOS list.
        fn RtlGetVersion(info: *mut OsVersionInfo) -> i32;
    }
    #[link(name = "shcore")]
    extern "system" {
        fn GetDpiForMonitor(monitor: HMONITOR, kind: i32, x: *mut u32, y: *mut u32) -> i32;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteExW(info: *mut ShellExecuteInfo) -> i32;
    }
    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(reserved: *const c_void, flags: u32) -> i32;
    }

    /// Release builds are GUI programs without a console. Output already redirected (a pipe, a
    /// file) or a console of its own (debug builds) is used as is; otherwise the report goes to
    /// the console of the terminal that started it. False when there is neither.
    pub fn prepare_output() -> bool {
        const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
        const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
        // Both rights: std detects a console with GetConsoleMode, which needs GENERIC_READ, and
        // writes UTF-16 to it; without it the UTF-8 bytes land in the console's code page.
        const GENERIC_READ: u32 = 0x8000_0000;
        const GENERIC_WRITE: u32 = 0x4000_0000;
        const FILE_SHARE_READ: u32 = 1;
        const FILE_SHARE_WRITE: u32 = 2;
        const OPEN_EXISTING: u32 = 3;
        const FILE_TYPE_UNKNOWN: u32 = 0;
        /// A handle std can write to: set, and a console, pipe or file. A stale value inherited
        /// from the parent (GetFileType cannot tell what it is) writes nowhere.
        unsafe fn usable(handle: *mut c_void) -> bool {
            // SAFETY: GetFileType accepts any handle value and fails on a stale one.
            !handle.is_null()
                && handle as isize != -1
                && unsafe { GetFileType(handle) } != FILE_TYPE_UNKNOWN
        }
        // SAFETY: plain kernel32 calls; the only pointer passed is a static NUL-terminated name.
        // std looks the standard handle up on every write, so a handle set here is used.
        unsafe {
            if usable(GetStdHandle(STD_OUTPUT_HANDLE)) {
                return true;
            }
            if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
                return false;
            }
            if usable(GetStdHandle(STD_OUTPUT_HANDLE)) {
                return true;
            }
            // Attached, but the standard handle was not filled in: open the console directly.
            let console = CreateFileW(
                w!("CONOUT$"),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                0,
                null_mut(),
            );
            usable(console) && SetStdHandle(STD_OUTPUT_HANDLE, console) != 0
        }
    }

    /// Opens the report in the default text editor. The process exits right after, so the
    /// shell must finish launching first (SEE_MASK_NOASYNC, which Microsoft asks of callers that
    /// exit soon), on the single-threaded apartment its file handlers expect: from a COM-less
    /// thread it would hand the launch to a background thread that dies with the process.
    pub fn reveal(path: &Path) {
        const COINIT_APARTMENTTHREADED: u32 = 0x2;
        const COINIT_DISABLE_OLE1DDE: u32 = 0x4;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        let mut info = ShellExecuteInfo {
            size: std::mem::size_of::<ShellExecuteInfo>() as u32,
            mask: SEE_MASK_NOASYNC,
            window: null_mut(),
            verb: w!("open"),
            file: wide.as_ptr(),
            parameters: null(),
            directory: null(),
            show: SW_SHOWNORMAL,
            instance: null_mut(),
            id_list: null_mut(),
            class: null(),
            class_key: null_mut(),
            hot_key: 0,
            icon_or_monitor: null_mut(),
            process: null_mut(),
        };
        // SAFETY: COM is initialized once for this thread, which exits with the process; any
        // answer (already initialized, another apartment) still lets the shell run. Both strings
        // are NUL-terminated UTF-16 that outlive the call, and `info` is sized for ShellExecuteExW.
        unsafe {
            CoInitializeEx(null(), COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
            ShellExecuteExW(&mut info);
        }
    }

    pub fn os_version() -> String {
        let mut info = OsVersionInfo {
            size: std::mem::size_of::<OsVersionInfo>() as u32,
            major: 0,
            minor: 0,
            build: 0,
            platform: 0,
            service_pack: [0; 128],
        };
        // SAFETY: RtlGetVersion fills the OSVERSIONINFOW whose size it is given.
        if unsafe { RtlGetVersion(&mut info) } != 0 {
            return "Windows (version unknown)".into();
        }
        windows_version(info.major, info.minor, info.build)
    }

    pub fn media(runtime: &RuntimeResult) -> Media {
        let result = match runtime {
            Ok(runtime) => runtime.block_on(async {
                tokio::time::timeout(MEDIA_TIMEOUT, sessions())
                    .await
                    .unwrap_or_else(|_| {
                        Err("Windows' media controls did not answer within 10 s".into())
                    })
            }),
            Err(error) => Err(error.clone()),
        };
        match result {
            Ok((sessions, track)) => {
                let lines = if sessions.is_empty() {
                    vec![
                        "no media sessions: no app has registered with Windows' media controls"
                            .into(),
                    ]
                } else {
                    sessions
                        .iter()
                        .enumerate()
                        .map(|(index, session)| session_line(index, session))
                        .collect()
                };
                Media {
                    sources: Ok(lines),
                    track,
                }
            }
            Err(error) => Media {
                track: Err(format!("no media source ({error})")),
                sources: Err(error),
            },
        }
    }

    /// One session's answers, read once.
    struct Read {
        app_id: Option<String>,
        status: Option<Status>,
        metadata: Result<(String, String, String, bool), String>,
        /// Duration and position in ms.
        timeline: Option<(f64, f64)>,
        /// LastUpdatedTime in WinRT ticks, read on its own like the app's "last active" time.
        updated: Option<i64>,
    }

    /// Every session, and the track Undertone would pick from them (or why it shows none):
    /// `media/windows.rs`'s `read_snapshot`, read once, with the same filtering and
    /// `select_candidate`.
    async fn sessions() -> Result<(Vec<SmtcSession>, Result<Option<NowPlaying>, String>), String> {
        let manager = SessionManager::RequestAsync()
            .map_err(|error| error.message())?
            .await
            .map_err(|error| error.message())?;
        let sessions: Vec<_> = manager
            .GetSessions()
            .map_err(|error| error.message())?
            .into_iter()
            .collect();
        let current = manager.GetCurrentSession().ok();
        let now = epoch_ms();
        let mut reads = Vec::new();
        for session in &sessions {
            let metadata = match session.TryGetMediaPropertiesAsync() {
                Ok(pending) => match tokio::time::timeout(Duration::from_secs(2), pending).await {
                    Ok(Ok(properties)) => Ok((
                        properties
                            .Title()
                            .map(|t| t.to_string())
                            .unwrap_or_default(),
                        properties
                            .Artist()
                            .map(|a| a.to_string())
                            .unwrap_or_default(),
                        properties
                            .AlbumTitle()
                            .map(|a| a.to_string())
                            .unwrap_or_default(),
                        properties.Thumbnail().is_ok(),
                    )),
                    Ok(Err(error)) => Err(error.message()),
                    Err(_) => Err("no answer within 2 s".into()),
                },
                Err(error) => Err(error.message()),
            };
            let properties = session.GetTimelineProperties().ok();
            let timeline = properties.as_ref().and_then(|timeline| {
                let start = timeline.StartTime().ok()?.Duration;
                let end = timeline.EndTime().ok()?.Duration;
                let position = timeline.Position().ok()?.Duration;
                Some((
                    end.saturating_sub(start).max(0) as f64 / 10_000.0,
                    position.saturating_sub(start).max(0) as f64 / 10_000.0,
                ))
            });
            reads.push(Read {
                app_id: session.SourceAppUserModelId().ok().map(|id| id.to_string()),
                status: session
                    .GetPlaybackInfo()
                    .and_then(|info| info.PlaybackStatus())
                    .ok(),
                metadata,
                timeline,
                updated: properties
                    .and_then(|timeline| timeline.LastUpdatedTime().ok())
                    .map(|time| time.UniversalTime),
            });
        }
        // Only playing or paused sessions with an app id are candidates, as in the app.
        let mut candidates = Vec::new();
        let mut indices = Vec::new();
        let mut listed: Vec<SmtcSession> = Vec::new();
        for (index, (session, read)) in sessions.iter().zip(&reads).enumerate() {
            let candidate = matches!(read.status, Some(Status::Playing | Status::Paused))
                && read.app_id.is_some();
            let source = read
                .app_id
                .as_deref()
                .filter(|_| candidate)
                .map(smtc_source);
            if let Some(source) = &source {
                let playing = read.status == Some(Status::Playing);
                let last_active = if playing {
                    now
                } else {
                    read.updated
                        .filter(|ticks| *ticks > 116_444_736_000_000_000)
                        .map_or(0.0, |ticks| windows_sample_time(ticks, now))
                };
                candidates.push(Candidate {
                    source: source.clone(),
                    is_playing: playing,
                    last_active_ms: last_active,
                    is_current: current.as_ref() == Some(session),
                });
                indices.push(index);
            }
            listed.push(SmtcSession {
                app_id: read.app_id.clone().unwrap_or_default(),
                status: status_name(read.status).into(),
                current: current.as_ref() == Some(session),
                source,
                track: read
                    .metadata
                    .as_ref()
                    .map(|(title, artist, _, _)| (title.clone(), artist.clone()))
                    .map_err(Clone::clone),
                thumbnail: read.metadata.as_ref().is_ok_and(|metadata| metadata.3),
                selected: false,
            });
        }
        let Some(chosen) = select_candidate(&candidates) else {
            return Ok((listed, Ok(None)));
        };
        let index = indices[chosen];
        listed[index].selected = true;
        let read = &reads[index];
        // The app publishes nothing when it cannot read the selected session: say why.
        let track = match (&read.metadata, read.timeline.zip(read.updated)) {
            (Ok((title, artist, album, _)), Some(((duration_ms, position_ms), ticks))) => {
                now_playing(RawTrack {
                    source: candidates[chosen].source.clone(),
                    title: title.clone(),
                    artist: artist.clone(),
                    album: album.clone(),
                    duration_ms,
                    position_ms,
                    sampled_at: windows_sample_time(ticks, epoch_ms()),
                    is_playing: read.status == Some(Status::Playing),
                    artwork: None,
                })
                .map(Some)
            }
            (Err(error), _) => Err(format!(
                "the selected session's metadata is unavailable ({error}), so Undertone shows \
                 nothing"
            )),
            (Ok(_), None) => Err(
                "the selected session has no readable timeline, so Undertone shows nothing".into(),
            ),
        };
        Ok((listed, track))
    }

    fn status_name(status: Option<Status>) -> &'static str {
        match status {
            Some(Status::Playing) => "playing",
            Some(Status::Paused) => "paused",
            Some(Status::Stopped) => "stopped",
            Some(Status::Changing) => "changing",
            Some(Status::Opened) => "opened",
            Some(Status::Closed) => "closed",
            _ => "unknown status",
        }
    }

    pub fn displays() -> Result<Vec<Display>, String> {
        unsafe extern "system" fn collect(
            monitor: HMONITOR,
            _: HDC,
            _: *mut RECT,
            list: LPARAM,
        ) -> i32 {
            // SAFETY: EnumDisplayMonitors calls back synchronously with our Vec's address.
            unsafe { (*(list as *mut Vec<usize>)).push(monitor as usize) };
            1
        }
        let mut monitors: Vec<usize> = Vec::new();
        // SAFETY: no DC and no clip rectangle: every monitor of the virtual desktop.
        let enumerated = unsafe {
            EnumDisplayMonitors(
                null_mut(),
                null(),
                Some(collect),
                &mut monitors as *mut Vec<usize> as LPARAM,
            )
        };
        if enumerated == 0 {
            return Err(format!(
                "EnumDisplayMonitors: {}",
                std::io::Error::last_os_error()
            ));
        }
        monitors
            .into_iter()
            .map(|monitor| describe_monitor(monitor as HMONITOR))
            .collect()
    }
    fn describe_monitor(monitor: HMONITOR) -> Result<Display, String> {
        let rect = |r: RECT| Rect {
            x: f64::from(r.left),
            y: f64::from(r.top),
            width: f64::from(r.right - r.left),
            height: f64::from(r.bottom - r.top),
        };
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        // SAFETY: cbSize tells GetMonitorInfoW it may fill the whole MONITORINFOEXW.
        if unsafe {
            GetMonitorInfoW(
                monitor,
                &mut info as *mut MONITORINFOEXW as *mut MONITORINFO,
            )
        } == 0
        {
            return Err(format!(
                "GetMonitorInfoW: {}",
                std::io::Error::last_os_error()
            ));
        }
        let (mut dpi_x, mut dpi_y) = (0, 0);
        // SAFETY: MDT_EFFECTIVE_DPI (0) into two u32s we own.
        let scale = (unsafe { GetDpiForMonitor(monitor, 0, &mut dpi_x, &mut dpi_y) } == 0)
            .then(|| f64::from(dpi_x) / 96.0);
        let device = &info.szDevice;
        let length = device.iter().position(|c| *c == 0).unwrap_or(device.len());
        Ok(Display {
            name: String::from_utf16_lossy(&device[..length]),
            frame: rect(info.monitorInfo.rcMonitor),
            work_area: Some(rect(info.monitorInfo.rcWork)),
            unit: "px",
            scale,
            primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
        })
    }

    /// The adapter's own discovery (which also asks Explorer for its WorkerW, as the app does),
    /// then every window it could have picked from.
    pub fn desktop_layer() -> Result<Vec<String>, String> {
        let mut lines = vec![field(
            "found",
            desktop_layer::describe().unwrap_or_else(|error| format!("nothing: {error}")),
        )];
        lines.extend(handles());
        Ok(lines)
    }
    fn hwnd(window: HWND) -> String {
        // SAFETY: IsWindowVisible accepts any handle, stale or not.
        let visible = unsafe { IsWindowVisible(window) } != 0;
        format!(
            "{:#x} ({})",
            window as usize,
            if visible { "visible" } else { "hidden" }
        )
    }
    fn class_name(window: HWND) -> String {
        let mut buffer = [0u16; 64];
        // SAFETY: the buffer and its length are ours.
        let length = unsafe { GetClassNameW(window, buffer.as_mut_ptr(), buffer.len() as i32) };
        String::from_utf16_lossy(&buffer[..length.max(0) as usize])
    }
    fn handles() -> Vec<String> {
        unsafe extern "system" fn collect(window: HWND, list: LPARAM) -> i32 {
            // SAFETY: EnumWindows calls back synchronously with our Vec's address.
            unsafe { (*(list as *mut Vec<usize>)).push(window as usize) };
            1
        }
        let mut lines = Vec::new();
        // SAFETY: class names are static UTF-16; handles are only passed back to user32, which
        // accepts stale ones.
        unsafe {
            let progman = FindWindowW(w!("Progman"), null());
            if progman.is_null() {
                lines.push(field("Progman", "not found (Explorer is not running?)"));
            } else {
                lines.push(field("Progman", hwnd(progman)));
                let icons = FindWindowExW(progman, null_mut(), w!("SHELLDLL_DefView"), null());
                if !icons.is_null() {
                    lines.push(field(
                        "icons",
                        format!("SHELLDLL_DefView {} in Progman", hwnd(icons)),
                    ));
                }
                let mut after: HWND = null_mut();
                loop {
                    after = FindWindowExW(progman, after, w!("WorkerW"), null());
                    if after.is_null() {
                        break;
                    }
                    lines.push(field("WorkerW", format!("{} in Progman", hwnd(after))));
                }
            }
            let mut tops: Vec<usize> = Vec::new();
            EnumWindows(Some(collect), &mut tops as *mut Vec<usize> as LPARAM);
            for top in tops {
                let top = top as HWND;
                if class_name(top) != "WorkerW" {
                    continue;
                }
                lines.push(field("WorkerW", format!("{} top-level", hwnd(top))));
                let icons = FindWindowExW(top, null_mut(), w!("SHELLDLL_DefView"), null());
                if !icons.is_null() {
                    lines.push(field(
                        "icons",
                        format!("SHELLDLL_DefView {} in that WorkerW", hwnd(icons)),
                    ));
                }
            }
        }
        lines
    }
}

/// macOS: runs on the process's main thread (main() calls `run` first), so AppKit and
/// NSAppleScript are used directly, without the app's main-thread hop.
#[cfg(all(feature = "desktop", target_os = "macos"))]
mod native {
    use super::{field, now_playing, player_line, Display, Media, PlayerInfo, RuntimeResult};
    use crate::{
        desktop_layer::{
            self,
            geometry::{self, Rect},
        },
        media::{
            applescript::{self, Failure, Player, Reading},
            epoch_ms,
        },
    };
    use objc2::{
        class, msg_send,
        rc::{autoreleasepool, Retained},
        runtime::{AnyObject, NSObjectProtocol},
        sel, AnyThread, MainThreadMarker,
    };
    use objc2_app_kit::{NSScreen, NSWorkspace};
    use objc2_core_graphics::{CGWindowLevelForKey, CGWindowLevelKey};
    use objc2_foundation::{
        NSAppleEventDescriptor, NSAppleScript, NSAppleScriptErrorMessage, NSAppleScriptErrorNumber,
        NSDictionary, NSNumber, NSRect, NSString,
    };
    use std::{collections::HashMap, path::Path};

    const MAIN_THREAD: &str = "AppKit and AppleScript need the main thread";

    /// Opened from Finder or `open`, the parent is launchd and nobody sees stdout.
    fn from_terminal() -> bool {
        std::os::unix::process::parent_id() != 1
    }
    pub fn prepare_output() -> bool {
        from_terminal()
    }
    /// Opens the report in TextEdit (the default for .txt).
    pub fn reveal(path: &Path) {
        let _ = std::process::Command::new("/usr/bin/open")
            .arg(path)
            .status();
    }

    pub fn os_version() -> String {
        autoreleasepool(|_| {
            // SAFETY: +[NSProcessInfo processInfo] and -operatingSystemVersionString take no
            // arguments and return objects ("Version 15.1 (Build 24B83)").
            let text: Option<Retained<NSString>> = unsafe {
                let info: Option<Retained<AnyObject>> =
                    msg_send![class!(NSProcessInfo), processInfo];
                match info {
                    Some(info) => msg_send![&*info, operatingSystemVersionString],
                    None => None,
                }
            };
            text.map_or_else(
                || "macOS (version unknown)".into(),
                |text| format!("macOS {text}"),
            )
        })
    }

    /// Spotify and Music as `media/macos.rs` reads them: only running players are scripted (a
    /// `tell` would launch a closed one), Automation is checked without prompting, and the same
    /// scripts, parser and `choose` pick the track.
    pub fn media(_: &RuntimeResult) -> Media {
        if MainThreadMarker::new().is_none() {
            return Media {
                sources: Err(MAIN_THREAD.into()),
                track: Err(MAIN_THREAD.into()),
            };
        }
        let running = running_players();
        let mut players = Vec::new();
        let mut readings: Vec<(usize, Player, Reading, f64)> = Vec::new();
        for player in Player::ALL {
            let mut info = PlayerInfo {
                player,
                running: running.contains(&player),
                automation: None,
                reading: None,
                selected: false,
            };
            if info.running {
                let status = automation_status(player.bundle_id());
                info.automation = Some(status);
                if super::automation_allows(status) {
                    let result = read(player);
                    if let Ok(Some((reading, sampled_at))) = &result {
                        readings.push((players.len(), player, reading.clone(), *sampled_at));
                    }
                    info.reading = Some(result.map(|found| found.map(|(reading, _)| reading)));
                }
            }
            players.push(info);
        }
        let states: Vec<_> = readings
            .iter()
            .map(|(_, player, reading, _)| (*player, reading.state))
            .collect();
        let track = match applescript::choose(&states, &mut HashMap::new(), epoch_ms()) {
            Some(chosen) => {
                let (index, player, reading, sampled_at) = readings.swap_remove(chosen);
                players[index].selected = true;
                now_playing(reading.into_raw(player, sampled_at, None)).map(Some)
            }
            None => Ok(None),
        };
        let mut lines: Vec<String> = players.iter().map(player_line).collect();
        if from_terminal() {
            lines.push(
                "note: started from a terminal, so macOS may answer for the terminal's \
                 Automation access rather than Undertone's. To check Undertone's own, run \
                 `open -n -a Undertone --args --diagnose`; the report then opens in TextEdit."
                    .into(),
            );
        }
        Media {
            sources: Ok(lines),
            track,
        }
    }

    /// Like `media/macos.rs`: a closed player is never sent an Apple event.
    fn running_players() -> Vec<Player> {
        autoreleasepool(|_| {
            let apps = NSWorkspace::sharedWorkspace().runningApplications();
            Player::ALL
                .into_iter()
                .filter(|player| {
                    let bundle_id = NSString::from_str(player.bundle_id());
                    apps.iter().any(|app| {
                        !app.isTerminated()
                            && app
                                .bundleIdentifier()
                                .is_some_and(|id| id.isEqualToString(&bundle_id))
                    })
                })
                .collect()
        })
    }

    /// One read script, stamped halfway through the call like the app's.
    fn read(player: Player) -> Result<Option<(Reading, f64)>, Failure> {
        let before = epoch_ms();
        let text = run_script(player.read_script().source())?;
        let sampled_at = applescript::midpoint(before, epoch_ms());
        let reading = applescript::parse_reading(player, &text).map_err(Failure::other)?;
        Ok(reading.map(|reading| (reading, sampled_at)))
    }

    /// Compiles and runs `source`; each script bounds its Apple events to 2 s.
    fn run_script(source: &str) -> Result<String, Failure> {
        autoreleasepool(|_| {
            let script =
                NSAppleScript::initWithSource(NSAppleScript::alloc(), &NSString::from_str(source))
                    .ok_or_else(|| Failure::other("NSAppleScript rejected the script source"))?;
            let mut info: Option<Retained<NSDictionary<NSString, AnyObject>>> = None;
            // SAFETY: `executeAndReturnError:` takes that out-parameter and compiles the script
            // first. It returns nil on failure, so the result is read as an Option.
            let result: Option<Retained<NSAppleEventDescriptor>> =
                unsafe { msg_send![&*script, executeAndReturnError: &mut info] };
            let result = result.ok_or_else(|| failure(info.as_deref()))?;
            Ok(result
                .stringValue()
                .map(|text| text.to_string())
                .unwrap_or_default())
        })
    }
    fn failure(info: Option<&NSDictionary<NSString, AnyObject>>) -> Failure {
        let Some(info) = info else {
            return Failure::other("AppleScript failed without details");
        };
        // SAFETY: Foundation's immutable NSString key constants.
        let (number_key, message_key) =
            unsafe { (NSAppleScriptErrorNumber, NSAppleScriptErrorMessage) };
        let number = info
            .objectForKey(number_key)
            .and_then(|value| value.downcast::<NSNumber>().ok())
            .map(|number| number.as_i64());
        let message = info
            .objectForKey(message_key)
            .and_then(|value| value.downcast::<NSString>().ok())
            .map(|message| message.to_string())
            .unwrap_or_default();
        Failure::new(number, message)
    }

    /// AEDeterminePermissionToAutomateTarget without asking: 0 granted, -1743 denied, -1744 not
    /// decided yet, -600 not running. A diagnostic never shows the Automation prompt.
    fn automation_status(bundle_id: &str) -> i32 {
        const TYPE_APPLICATION_BUNDLE_ID: u32 = u32::from_be_bytes(*b"bund");
        const TYPE_WILD_CARD: u32 = u32::from_be_bytes(*b"****");
        /// Room for an AEDesc; only CoreServices reads or writes it (see `media/macos.rs`).
        #[repr(C, align(8))]
        struct AEDesc([u8; 16]);
        #[link(name = "CoreServices", kind = "framework")]
        extern "C" {
            fn AECreateDesc(
                type_code: u32,
                data: *const std::ffi::c_void,
                size: isize,
                result: *mut AEDesc,
            ) -> i16;
            fn AEDisposeDesc(desc: *mut AEDesc) -> i16;
            fn AEDeterminePermissionToAutomateTarget(
                target: *const AEDesc,
                event_class: u32,
                event_id: u32,
                ask_user_if_needed: u8,
            ) -> i32;
        }
        let mut target = AEDesc([0; 16]);
        // SAFETY: AECreateDesc copies `bundle_id`'s bytes into `target`, which is then only
        // passed back to CoreServices and disposed of exactly once, after it was created.
        unsafe {
            let created = AECreateDesc(
                TYPE_APPLICATION_BUNDLE_ID,
                bundle_id.as_ptr().cast(),
                bundle_id.len() as isize,
                &mut target,
            );
            if created != 0 {
                return created.into();
            }
            let status =
                AEDeterminePermissionToAutomateTarget(&target, TYPE_WILD_CARD, TYPE_WILD_CARD, 0);
            AEDisposeDesc(&mut target);
            status
        }
    }

    fn rect(frame: NSRect) -> Rect {
        Rect {
            x: frame.origin.x,
            y: frame.origin.y,
            width: frame.size.width,
            height: frame.size.height,
        }
    }
    /// NSScreen's frames, flipped to Quartz points like the desktop layer compares them.
    pub fn displays() -> Result<Vec<Display>, String> {
        let mtm = MainThreadMarker::new().ok_or(MAIN_THREAD)?;
        autoreleasepool(|_| {
            let screens = NSScreen::screens(mtm).to_vec();
            let Some(primary) = screens.first().map(|screen| rect(screen.frame())) else {
                return Ok(Vec::new());
            };
            Ok(screens
                .iter()
                .enumerate()
                .map(|(index, screen)| Display {
                    // macOS 10.15+; Undertone may run on 10.13, where it would throw.
                    name: if screen.respondsToSelector(sel!(localizedName)) {
                        screen.localizedName().to_string()
                    } else {
                        String::new()
                    },
                    frame: geometry::flip_y(rect(screen.frame()), primary),
                    work_area: Some(geometry::flip_y(rect(screen.visibleFrame()), primary)),
                    unit: "pt",
                    scale: Some(screen.backingScaleFactor()),
                    // NSScreen.screens[0] holds the menu bar: the primary display.
                    primary: index == 0,
                })
                .collect())
        })
    }

    pub fn desktop_layer() -> Result<Vec<String>, String> {
        let mut lines = vec![field(
            "found",
            desktop_layer::describe().unwrap_or_else(|error| format!("nothing: {error}")),
        )];
        lines.push(field(
            "icon level",
            format!(
                "{} (the Finder's icons, just above the overlays)",
                CGWindowLevelForKey(CGWindowLevelKey::DesktopIconWindowLevelKey)
            ),
        ));
        if let Some(mtm) = MainThreadMarker::new() {
            lines.push(field(
                "spaces",
                if NSScreen::screensHaveSeparateSpaces(mtm) {
                    "each display has its own Spaces"
                } else {
                    "one set of Spaces across all displays"
                },
            ));
        }
        Ok(lines)
    }
}

/// Anything else: the report still covers settings and the lyrics cache.
#[cfg(not(all(feature = "desktop", any(target_os = "windows", target_os = "macos"))))]
mod native {
    use super::{Display, Media, RuntimeResult};
    use std::path::Path;

    const UNSUPPORTED: &str = if cfg!(any(target_os = "windows", target_os = "macos")) {
        "this build has no desktop support (built without the `desktop` feature)"
    } else {
        "Undertone's desktop app runs on Windows and macOS only"
    };
    pub fn prepare_output() -> bool {
        true
    }
    pub fn reveal(_: &Path) {}
    pub fn os_version() -> String {
        std::env::consts::OS.into()
    }
    pub fn media(_: &RuntimeResult) -> Media {
        Media {
            sources: Err(UNSUPPORTED.into()),
            track: Err(UNSUPPORTED.into()),
        }
    }
    pub fn displays() -> Result<Vec<Display>, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn desktop_layer() -> Result<Vec<String>, String> {
        Err(UNSUPPORTED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        contract::{LyricsSource, Mode},
        media::applescript::parse_reading,
    };
    use std::sync::{Arc, Mutex};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    /// Original placeholder lyrics: the report must never contain them.
    const SYNCED: &str =
        "[00:01.00] Chalk birds over the quiet harbor\n[00:04.50] \n[00:06.00] Lanterns hum in the rain\n";
    const PLAIN: &str = "Chalk birds over the quiet harbor\n\nLanterns hum in the rain\n";

    fn playing() -> NowPlaying {
        NowPlaying {
            source: Source::Spotify,
            track_key: "demo artist|paper lantern|demo album|180".into(),
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
    fn track() -> Track {
        Track::from(&playing())
    }
    fn record() -> Record {
        Record {
            id: 7,
            track_name: "Paper Lantern".into(),
            artist_name: "Demo Artist".into(),
            album_name: "Demo Album".into(),
            duration: 181.2,
            instrumental: false,
            plain_lyrics: Some(PLAIN.into()),
            synced_lyrics: Some(SYNCED.into()),
        }
    }

    #[test]
    fn a_section_prints_its_lines_or_why_it_is_unavailable() {
        let lines = Section::new("Displays", Ok(vec!["#0 one".into(), "#1 two".into()]));
        assert_eq!(lines.render(), "\n== Displays ==\n  #0 one\n  #1 two\n");
        let failed = Section::new("Displays", Err("EnumDisplayMonitors: denied".into()));
        assert_eq!(
            failed.render(),
            "\n== Displays ==\n  unavailable: EnumDisplayMonitors: denied\n"
        );
        assert_eq!(
            Section::new("Empty", Ok(Vec::new())).render(),
            "\n== Empty ==\n  (nothing to report)\n"
        );
        assert_eq!(field("title", "x"), "title:       x");
        assert_eq!(field("", "x"), format!("{}x", " ".repeat(13)));
    }

    #[test]
    fn control_characters_never_break_the_layout() {
        let section = Section::new("Title\n", Err("line one\r\nline two".into()));
        assert_eq!(
            section.render(),
            "\n== Title  ==\n  unavailable: line one  line two\n"
        );
        let odd = NowPlaying {
            title: "Two\nLines\t".into(),
            ..playing()
        };
        let text = track_section(&Ok(Some(odd)), None, 0.0).render();
        assert!(text.contains("title:       Two Lines\n"), "{text}");
    }

    #[test]
    fn header_names_the_version_os_build_and_both_paths() {
        let text = header_section(&Header {
            version: "0.1.0",
            generated_at: 1_700_000_000,
            os: "Windows 11 24H2 (10.0.26100)".into(),
            arch: "x86_64",
            release: true,
            executable: Ok(PathBuf::from("/Apps/undertone")),
            report: Err("read-only temp dir".into()),
        })
        .render();
        assert!(text.starts_with("\n== Undertone 0.1.0 diagnostics ==\n"));
        for expected in [
            "generated:   2023-11-14 22:13:20 UTC",
            "os:          Windows 11 24H2 (10.0.26100), x86_64",
            "build:       release, contract v3",
            "executable:  /Apps/undertone",
            "report file: not saved: read-only temp dir",
        ] {
            assert!(text.contains(expected), "{expected}\n{text}");
        }
    }

    #[test]
    fn the_track_shows_metadata_live_position_and_sync_offsets() {
        let settings = Settings {
            global_offset_ms: -150.0,
            track_offsets_ms: [(playing().track_key, 100.0)].into(),
            ..Settings::default()
        };
        let text =
            track_section(&Ok(Some(playing())), Some(&settings), 1_700_000_000_250.0).render();
        for expected in [
            "source:      spotify",
            "title:       Paper Lantern",
            "duration:    3:00.000 (180000 ms)",
            "playing:     yes",
            "position:    0:10.000 (sampled 250 ms before this report), so about 0:10.250 now",
            "track key:   demo artist|paper lantern|demo album|180",
            "sync offset: -150 ms global, +100 ms for this song",
        ] {
            assert!(text.contains(expected), "{expected}\n{text}");
        }
    }

    #[test]
    fn paused_tracks_unknown_lengths_and_blank_fields_are_spelled_out() {
        let paused = NowPlaying {
            is_playing: false,
            duration_ms: 0.0,
            album: String::new(),
            ..playing()
        };
        let text = track_section(
            &Ok(Some(paused)),
            Some(&Settings::default()),
            1_700_000_005_000.0,
        )
        .render();
        for expected in [
            "position:    0:10.000 (sampled 5000 ms before this report), paused",
            "duration:    unknown (0 ms)",
            "album:       (none)",
            "sync offset: 0 ms global, 0 ms for this song",
        ] {
            assert!(text.contains(expected), "{expected}\n{text}");
        }
        assert!(track_section(&Ok(None), None, 0.0)
            .render()
            .contains("nothing is playing"));
        assert_eq!(
            track_section(&Err("SMTC unavailable".into()), None, 0.0).body,
            Err("SMTC unavailable".into())
        );
    }

    fn probe(cache: CacheProbe, result: Result<(Option<Record>, Lyrics), String>) -> LyricsProbe {
        LyricsProbe {
            track_ms: 180_000.0,
            cache_file: Some(PathBuf::from("/data/lyrics/abc.json")),
            cache,
            lookup: Lookup {
                requests: vec!["get \"Paper Lantern\" by Demo Artist -> #7, accepted".into()],
                result,
            },
        }
    }

    #[test]
    fn lyrics_show_line_counts_and_the_duration_delta_but_never_the_lyrics() {
        let found = record().into_lyrics(&track().key);
        let cached = Lyrics {
            source: LyricsSource::Cache,
            ..found.clone()
        };
        let now = 1_700_000_000;
        let text = lyrics_section(
            &Ok(probe(
                CacheProbe::Hit {
                    lyrics: cached,
                    saved_at: now - 3 * 86_400,
                },
                Ok((Some(record()), found)),
            )),
            now,
        )
        .render();
        assert!(
            !text.contains("Chalk") && !text.contains("Lanterns"),
            "{text}"
        );
        for expected in [
            "shows:       found: synced 3 lines, plain 2 lines, from the cache",
            "(3 days ago)",
            "cache file:  /data/lyrics/abc.json",
            "requests:    get \"Paper Lantern\" by Demo Artist -> #7, accepted",
            "match:       #7 \"Paper Lantern\" by Demo Artist on \"Demo Album\"",
            "duration:    181.2 s on LRCLIB, 180.0 s playing: delta +1.2 s, within 2 s (best tier)",
            "lrclib:      found: synced 3 lines, plain 2 lines",
        ] {
            assert!(text.contains(expected), "{expected}\n{text}");
        }
    }

    #[test]
    fn a_cache_miss_shows_what_lrclib_answered_and_a_failure_keeps_its_requests() {
        let missing = empty(&track().key, LyricsStatus::NotFound);
        let text = lyrics_section(&Ok(probe(CacheProbe::Miss, Ok((None, missing)))), 0).render();
        for expected in [
            "shows:       not-found, from LRCLIB",
            "cache:       no entry: Undertone asks LRCLIB",
            "match:       none: not-found",
        ] {
            assert!(text.contains(expected), "{expected}\n{text}");
        }
        let mut failed = probe(CacheProbe::Ignored, Err("timed out".into()));
        failed.lookup.requests = vec![
            "get A -> not found (404)".into(),
            "search A -> timed out".into(),
        ];
        let text = lyrics_section(&Ok(failed), 0).render();
        for expected in [
            "shows:       error: the lookup failed",
            "cache:       an entry Undertone ignores",
            "requests:    get A -> not found (404)\n",
            &format!("\n  {}search A -> timed out\n", " ".repeat(13)),
            "lookup:      unavailable: timed out",
        ] {
            assert!(text.contains(expected), "{expected}\n{text}");
        }
        let broken = probe(
            CacheProbe::Failed("permission denied".into()),
            Err("x".into()),
        );
        assert!(lyrics_section(&Ok(broken), 0)
            .render()
            .contains("cache:       unavailable: permission denied"));
        assert_eq!(
            lyrics_section(&Err("nothing is playing".into()), 0).render(),
            "\n== Lyrics (LRCLIB) ==\n  unavailable: nothing is playing\n"
        );
    }

    #[test]
    fn statuses_and_duration_tiers_are_named() {
        assert_eq!(
            describe(&empty("k", LyricsStatus::Instrumental)),
            "instrumental"
        );
        let plain = Lyrics {
            plain: Some(PLAIN.into()),
            ..empty("k", LyricsStatus::PlainOnly)
        };
        assert_eq!(describe(&plain), "plain-only: plain 2 lines");
        assert_eq!(tier(-2.0), "within 2 s (best tier)");
        assert_eq!(tier(4.9), "within 5 s");
        assert_eq!(tier(-8.0), "within 8 s (last accepted tier)");
        assert_eq!(tier(8.5), "over 8 s (rejected)");
    }

    /// A fake LRCLIB that answers each connection with the next response, then stops listening.
    async fn serve(
        responses: Vec<(u16, String)>,
    ) -> (Url, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/api/", listener.local_addr().unwrap())).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let capture = requests.clone();
        let task = tokio::spawn(async move {
            for (status, body) in responses {
                let (mut stream, _) =
                    tokio::time::timeout(Duration::from_secs(3), listener.accept())
                        .await
                        .unwrap()
                        .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 1024];
                while !request.windows(4).any(|chunk| chunk == b"\r\n\r\n") {
                    let count = stream.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                capture
                    .lock()
                    .unwrap()
                    .push(String::from_utf8(request).unwrap());
                let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (url, requests, task)
    }
    fn json<T: serde::Serialize>(value: &T) -> String {
        serde_json::to_string(value).unwrap()
    }

    #[tokio::test]
    async fn the_exact_match_is_accepted_and_its_record_kept() {
        let (base, requests, server) = serve(vec![(200, json(&record()))]).await;
        let lookup = lookup(&lrclib_client(true).unwrap(), &base, &track()).await;
        server.await.unwrap();
        let (matched, lyrics) = lookup.result.unwrap();
        assert_eq!(matched.unwrap().id, 7);
        assert_eq!(lyrics.status, LyricsStatus::Found);
        assert_eq!(
            lookup.requests,
            vec![
                "get \"Paper Lantern\" by Demo Artist on \"Demo Album\", 180.0 s -> #7 \
                 \"Paper Lantern\" by Demo Artist on \"Demo Album\", accepted"
            ]
        );
        let requests = requests.lock().unwrap();
        assert!(requests[0].starts_with("GET /api/get?"));
        assert!(requests[0].contains("duration=180"));
        assert!(requests[0]
            .to_lowercase()
            .contains(&format!("user-agent: {}", USER_AGENT.to_lowercase())));
    }

    #[tokio::test]
    async fn like_the_provider_it_searches_then_retries_the_clean_title() {
        let decorated = Track {
            title: "Paper Lantern - Remastered 2011".into(),
            ..track()
        };
        let mut far = record();
        far.id = 8;
        far.duration = 200.0;
        let (base, requests, server) = serve(vec![
            (404, "{}".into()),
            (200, json(&vec![far])),
            (200, json(&vec![record()])),
        ])
        .await;
        let lookup = lookup(&lrclib_client(true).unwrap(), &base, &decorated).await;
        server.await.unwrap();
        assert_eq!(lookup.result.unwrap().0.unwrap().id, 7);
        assert!(lookup.requests[0].ends_with("-> not found (404)"));
        assert!(
            lookup.requests[1]
                .ends_with("-> 1 result, none accepted (closest duration delta +20.0 s)"),
            "{:?}",
            lookup.requests
        );
        assert!(lookup.requests[2]
            .starts_with("search \"Paper Lantern\" by Demo Artist -> 1 result, picked #7"));
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[2].starts_with("GET /api/search?track_name=Paper+Lantern&"));
    }

    #[tokio::test]
    async fn a_rejected_exact_match_and_an_empty_search_are_not_found() {
        let mut far = record();
        far.duration = 190.0;
        let (base, _, server) = serve(vec![(200, json(&far)), (200, "[]".into())]).await;
        let lookup = lookup(&lrclib_client(true).unwrap(), &base, &track()).await;
        server.await.unwrap();
        let (matched, lyrics) = lookup.result.unwrap();
        assert!(matched.is_none());
        assert_eq!(lyrics.status, LyricsStatus::NotFound);
        assert!(lookup.requests[0]
            .ends_with("#7 \"Paper Lantern\" by Demo Artist on \"Demo Album\", rejected (delta +10.0 s, or another title or artist)"));
        assert!(lookup.requests[1].ends_with("-> no results"));
        assert_eq!(lookup.requests.len(), 2);
    }

    #[tokio::test]
    async fn errors_keep_the_requests_made_so_far() {
        let (base, _, server) = serve(vec![(404, "{}".into()), (503, "{}".into())]).await;
        let failed = lookup(&lrclib_client(true).unwrap(), &base, &track()).await;
        server.await.unwrap();
        assert_eq!(failed.result.unwrap_err(), "HTTP 503");
        assert_eq!(failed.requests.len(), 2);
        assert!(failed.requests[1].ends_with("-> HTTP 503"));

        let incomplete = Track {
            artist: " ".into(),
            ..track()
        };
        let base = Url::parse("http://127.0.0.1:9/api/").unwrap();
        let skipped = lookup(&lrclib_client(true).unwrap(), &base, &incomplete).await;
        assert!(skipped.requests.is_empty());
        assert!(skipped.result.unwrap_err().contains("incomplete"));
    }

    #[tokio::test]
    async fn a_silent_server_times_out_with_a_clear_reason() {
        // Accepts connections (the OS backlog does) but never answers.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}/api/", listener.local_addr().unwrap())).unwrap();
        let mut log = Vec::new();
        let result = lookup_steps(
            &lrclib_client(true).unwrap(),
            &base,
            &track(),
            tokio::time::Instant::now(),
            &mut log,
        )
        .await;
        assert!(result.unwrap_err().starts_with("timed out"));
        assert!(log[0].ends_with("-> timed out (Undertone gives up after 6 s)"));
        drop(listener);
    }

    #[test]
    fn the_settings_file_is_read_as_undertone_loads_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert_eq!(read_settings(&path), StoredSettings::Missing);
        std::fs::write(&path, b"{").unwrap();
        assert!(
            matches!(read_settings(&path), StoredSettings::Unreadable(e) if e.starts_with("not JSON"))
        );
        std::fs::write(&path, br#"{"other": 1}"#).unwrap();
        assert_eq!(
            read_settings(&path),
            StoredSettings::Unreadable("no \"settings\" entry".into())
        );
        let defaults = serde_json::to_value(Settings::default()).unwrap();
        std::fs::write(&path, json(&serde_json::json!({ "settings": defaults }))).unwrap();
        assert_eq!(
            read_settings(&path),
            StoredSettings::Loaded {
                settings: Box::default(),
                current: true,
                stored: defaults,
            }
        );
        std::fs::write(&path, br#"{"settings": {"mode": "lens", "size": 999}}"#).unwrap();
        let StoredSettings::Loaded {
            settings,
            current,
            stored,
        } = read_settings(&path)
        else {
            panic!("a partial blob still loads");
        };
        assert!(!current);
        assert_eq!(settings.mode, Mode::Lens);
        assert_eq!(settings.size, 140.0);
        assert_eq!(stored, serde_json::json!({"mode": "lens", "size": 999}));
        std::fs::write(&path, vec![b' '; 1024 * 1024 + 1]).unwrap();
        assert!(
            matches!(read_settings(&path), StoredSettings::Unreadable(e) if e.contains("larger than"))
        );
    }

    #[test]
    fn the_settings_section_shows_the_path_state_and_effective_values() {
        let path = Ok(PathBuf::from("/data/settings.json"));
        let text = settings_section(&path, &Ok(StoredSettings::Missing)).render();
        for expected in [
            "file:        /data/settings.json",
            "state:       no file yet: Undertone uses the defaults",
            "lyrics:      on\n",
            "at login:    off\n",
            "shortcuts:   on\n",
            "  toggle:    CmdOrCtrl+Alt+Shift+L\n",
            "effective:\n    {\n",
            "\"mode\": \"arc\"",
        ] {
            assert!(text.contains(expected), "{expected}\n{text}");
        }
        assert!(!text.contains("stored:"));
        // A value Undertone repairs on start: both what is on disk and what it runs with.
        let repaired = StoredSettings::Loaded {
            settings: Box::new(Settings {
                size: 140.0,
                ..Settings::default()
            }),
            current: false,
            stored: serde_json::json!({"size": 999}),
        };
        let text = settings_section(&path, &Ok(repaired)).render();
        let stored = text
            .find("  stored:\n    {\n      \"size\": 999\n    }\n")
            .unwrap();
        let effective = text.find("  effective:\n").unwrap();
        assert!(stored < effective, "{text}");
        assert!(text.contains("\"size\": 140.0"));
        let text =
            settings_section(&path, &Ok(StoredSettings::Unreadable("not JSON".into()))).render();
        assert!(text.contains("unusable (not JSON): Undertone uses the defaults"));
        let unknown: Result<PathBuf, String> = Err("HOME is not set".into());
        assert_eq!(
            settings_section(&unknown, &Err("HOME is not set".into())).render(),
            "\n== Settings ==\n  unavailable: HOME is not set\n"
        );
    }

    #[test]
    fn the_switches_show_lyrics_login_and_each_binding() {
        let defaults = switch_lines(&Settings::default(), false).join("\n");
        assert_eq!(
            defaults,
            [
                "lyrics:      on",
                "at login:    off",
                "shortcuts:   on",
                "  toggle:    CmdOrCtrl+Alt+Shift+L",
                "  earlier:   CmdOrCtrl+Alt+Shift+]",
                "  later:     CmdOrCtrl+Alt+Shift+[",
            ]
            .join("\n")
        );
        let settings = Settings {
            enabled: false,
            launch_at_login: true,
            shortcuts: Shortcuts {
                enabled: false,
                toggle_lyrics: "Alt+F22".into(),
                nudge_earlier: String::new(),
                nudge_later: "Control+K".into(),
            },
            ..Settings::default()
        };
        let mac = switch_lines(&settings, true).join("\n");
        for expected in [
            "lyrics:      off: hidden on every display",
            "at login:    launch Undertone",
            "shortcuts:   off (the bindings below are kept)",
            "  toggle:    Alt+F22 (not usable on this OS)",
            "  earlier:   none",
            "  later:     Control+K",
        ] {
            assert!(mac.contains(expected), "{expected}\n{mac}");
        }
        assert!(switch_lines(&settings, false)
            .join("\n")
            .contains("  toggle:    Alt+F22\n"));
    }

    #[test]
    fn the_cache_dir_counts_entries_or_says_it_is_not_there_yet() {
        let dir = tempfile::tempdir().unwrap();
        let lyrics = dir.path().join("lyrics");
        assert_eq!(scan_cache(&lyrics), Ok(None));
        std::fs::create_dir(&lyrics).unwrap();
        std::fs::write(lyrics.join("a.json"), [0u8; 1500]).unwrap();
        std::fs::write(lyrics.join("b.json"), [0u8; 100]).unwrap();
        std::fs::write(lyrics.join(".tmpXYZ"), [0u8; 100]).unwrap();
        assert_eq!(scan_cache(&lyrics), Ok(Some((2, 1600))));
        let text = cache_section(&Ok(CacheDir {
            path: lyrics.clone(),
            contents: scan_cache(&lyrics),
        }))
        .render();
        assert!(text.contains("entries:     2 songs, 1.6 KB"), "{text}");
        let text = cache_section(&Ok(CacheDir {
            path: lyrics,
            contents: Ok(None),
        }))
        .render();
        assert!(text.contains("none yet"));
    }

    #[test]
    fn the_app_data_dir_matches_tauris_on_each_os() {
        let id = identifier().unwrap();
        assert!(id.contains('.'), "{id}");
        let env = |name: &str| match name {
            "APPDATA" => Some(OsString::from(r"C:\Users\Demo\AppData\Roaming")),
            "HOME" => Some(OsString::from("/Users/demo")),
            _ => None,
        };
        assert_eq!(
            app_data_dir("windows", &id, &env),
            Ok(PathBuf::from(r"C:\Users\Demo\AppData\Roaming").join(&id))
        );
        assert_eq!(
            app_data_dir("macos", &id, &env),
            Ok(PathBuf::from("/Users/demo/Library/Application Support").join(&id))
        );
        assert_eq!(
            app_data_dir("linux", &id, &env),
            Ok(PathBuf::from("/Users/demo/.local/share").join(&id))
        );
        assert!(app_data_dir("windows", &id, &|_: &str| None).is_err());
        assert!(app_data_dir("macos", &id, &|_: &str| Some(OsString::new())).is_err());
    }

    #[test]
    fn utc_dates_and_file_stamps() {
        assert_eq!(utc(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(utc(1_700_000_000), "2023-11-14 22:13:20 UTC");
        assert_eq!(utc(1_709_164_800), "2024-02-29 00:00:00 UTC");
        assert_eq!(utc(951_782_400), "2000-02-29 00:00:00 UTC");
        assert_eq!(utc(4_102_444_799), "2099-12-31 23:59:59 UTC");
        assert_eq!(file_stamp(1_791_277_500), "20261006-090500");
        assert!(age(1_791_277_500, 1_791_277_500 - 30).ends_with("(just now)"));
        assert!(age(1_791_277_500, 1_791_277_500 - 600).ends_with("(10 minutes ago)"));
        assert!(age(1_791_277_500, 1_791_277_500 + 5).ends_with("(in the future)"));
    }

    #[test]
    fn report_files_are_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let (first, _) = create_report_file(dir.path(), "20261006-090500").unwrap();
        let (second, _) = create_report_file(dir.path(), "20261006-090500").unwrap();
        assert_eq!(
            first.file_name().unwrap(),
            "undertone-diagnose-20261006-090500.txt"
        );
        assert_eq!(
            second.file_name().unwrap(),
            "undertone-diagnose-20261006-090500-2.txt"
        );
        assert!(create_report_file(&dir.path().join("missing"), "x").is_err());
    }

    #[test]
    fn smtc_sessions_show_status_classification_and_the_pick() {
        let spotify = SmtcSession {
            app_id: "Spotify.exe".into(),
            status: "playing".into(),
            current: true,
            source: Some(Source::Spotify),
            track: Ok(("Paper Lantern".into(), "Demo Artist".into())),
            thumbnail: true,
            selected: true,
        };
        assert_eq!(
            session_line(0, &spotify),
            "#1 Spotify.exe: playing, Windows' current session; read as spotify; \
             \"Paper Lantern\" by Demo Artist, has artwork  <- selected"
        );
        let ignored = SmtcSession {
            app_id: String::new(),
            status: "stopped".into(),
            current: false,
            source: None,
            track: Err("no answer within 2 s".into()),
            thumbnail: false,
            selected: false,
        };
        assert_eq!(
            session_line(1, &ignored),
            "#2 (no app id): stopped; ignored (not playing or paused); metadata unavailable: \
             no answer within 2 s"
        );
    }

    #[test]
    fn players_show_automation_and_what_they_play() {
        let closed = PlayerInfo {
            player: Player::Music,
            running: false,
            automation: None,
            reading: None,
            selected: false,
        };
        assert_eq!(player_line(&closed), "Music (com.apple.Music): not running");
        let denied = PlayerInfo {
            player: Player::Spotify,
            running: true,
            automation: Some(-1743),
            ..closed
        };
        assert!(player_line(&denied).ends_with(
            "running; Automation denied: turn it on in System Settings > Privacy & Security > \
             Automation > Undertone > Spotify"
        ));
        let answer = [
            "playing",
            "Paper Lantern",
            "Demo Artist",
            "Demo Album",
            "180000",
            "10",
            "https://i.scdn.co/image/demo",
        ]
        .join("\u{1f}");
        let playing = PlayerInfo {
            automation: Some(0),
            reading: Some(Ok(parse_reading(Player::Spotify, &answer).unwrap())),
            selected: true,
            ..denied.clone()
        };
        assert_eq!(
            player_line(&playing),
            "Spotify (com.spotify.client): running; Automation granted; playing \"Paper Lantern\" \
             by Demo Artist, has an artwork URL  <- selected"
        );
        let slow = PlayerInfo {
            automation: Some(0),
            reading: Some(Err(Failure::new(Some(-1712), "timed out"))),
            ..denied.clone()
        };
        assert!(player_line(&slow).ends_with("read failed: did not answer within 2 s"));
        let stopped = PlayerInfo {
            automation: Some(0),
            reading: Some(Ok(None)),
            ..denied
        };
        assert!(player_line(&stopped).ends_with("Automation granted; stopped, no track"));
    }

    #[test]
    fn automation_answers_gate_the_read_like_the_app() {
        assert!(automation_allows(0));
        assert!(!automation_allows(-1743));
        assert!(!automation_allows(-1744));
        assert!(!automation_allows(-600));
        // Anything unexpected: the script runs and reports the real error.
        assert!(automation_allows(-50));
        assert!(automation_text(Player::Music, -1744).contains("not decided yet"));
        assert!(automation_text(Player::Music, -50).contains("reads it anyway"));
        assert_eq!(
            failure_text(&Failure::new(Some(-2741), "Expected end of line")),
            "script failed (-2741): Expected end of line"
        );
    }

    #[test]
    fn displays_show_size_origin_scale_and_usable_area() {
        let monitor = Display {
            name: r"\\.\DISPLAY1".into(),
            frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 2560.0,
                height: 1440.0,
            },
            work_area: Some(Rect {
                x: 0.0,
                y: 0.0,
                width: 2560.0,
                height: 1392.0,
            }),
            unit: "px",
            scale: Some(1.5),
            primary: true,
        };
        assert_eq!(
            display_line(0, &monitor),
            r"#0 \\.\DISPLAY1 (primary): 2560x1440 px at (0, 0), scale 150%; usable 2560x1392 px at (0, 0)"
        );
        let screen = Display {
            name: "Built-in Retina Display".into(),
            frame: Rect {
                x: -1512.0,
                y: 120.5,
                width: 1512.0,
                height: 982.0,
            },
            work_area: None,
            unit: "pt",
            scale: Some(2.0),
            primary: false,
        };
        assert_eq!(
            display_line(1, &screen),
            "#1 Built-in Retina Display: 1512x982 pt at (-1512, 120.5), scale 200% = 3024x1964 px"
        );
        assert!(displays_section(&Ok(vec![monitor, screen]))
            .render()
            .contains("\n  #1 Built-in"));
        assert!(displays_section(&Err("no main thread".into()))
            .render()
            .contains("unavailable: no main thread"));
    }

    #[test]
    fn windows_builds_get_their_release_names() {
        assert_eq!(
            windows_version(10, 0, 26100),
            "Windows 11 24H2 (10.0.26100)"
        );
        assert_eq!(
            windows_version(10, 0, 22631),
            "Windows 11 23H2 (10.0.22631)"
        );
        assert_eq!(
            windows_version(10, 0, 19045),
            "Windows 10 22H2 (10.0.19045)"
        );
        assert_eq!(windows_version(10, 0, 27000), "Windows 11 (10.0.27000)");
        assert_eq!(windows_version(6, 3, 9600), "Windows 6.3 (6.3.9600)");
    }

    #[test]
    fn numbers_read_naturally() {
        assert_eq!(clock(185_250.4), "3:05.250");
        assert_eq!(clock(-5.0), "0:00.000");
        assert_eq!(signed(-0.04, 1), "0.0");
        assert_eq!(signed(2.26, 1), "+2.3");
        assert_eq!(signed(-20.0, 0), "-20");
        assert_eq!(size(512), "512 B");
        assert_eq!(size(1_572_864), "1.5 MB");
        assert_eq!(count(1, "result"), "1 result");
        assert_eq!(count(0, "result"), "0 results");
    }

    #[test]
    fn a_track_needs_a_title_to_be_published() {
        let raw = RawTrack {
            source: Source::System,
            title: "Paper Lantern".into(),
            artist: String::new(),
            album: String::new(),
            duration_ms: 1000.0,
            position_ms: 5000.0,
            sampled_at: 1.0,
            is_playing: false,
            artwork: None,
        };
        let published = now_playing(raw.clone()).unwrap();
        assert_eq!(published.track_key, "|paper lantern||1");
        assert_eq!(published.position_ms, 1000.0);
        // A selected source the app drops: the report says why the overlay stays empty.
        let untitled = now_playing(RawTrack {
            title: " ".into(),
            ..raw.clone()
        })
        .unwrap_err();
        assert!(untitled.contains("no title"), "{untitled}");
        let broken = now_playing(RawTrack {
            duration_ms: f64::NAN,
            ..raw
        })
        .unwrap_err();
        assert!(broken.contains("timeline is broken"), "{broken}");
        let section = track_section(&Err(untitled), None, 0.0).render();
        assert!(section.contains("unavailable: the selected source's track has no title"));
        assert!(lyrics_section(&Err("no current track".into()), 0)
            .render()
            .contains("unavailable: no current track"));
    }

    #[test]
    fn smtc_app_ids_map_to_sources_like_the_app() {
        assert_eq!(smtc_source("Spotify.exe"), Source::Spotify);
        assert_eq!(
            smtc_source("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"),
            Source::Spotify
        );
        assert_eq!(
            smtc_source("AppleInc.AppleMusicWin_nzyj5cx40ttqa!App"),
            Source::AppleMusic
        );
        assert_eq!(smtc_source("apple-music.exe"), Source::AppleMusic);
        assert_eq!(
            smtc_source("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"),
            Source::System
        );
        assert_eq!(smtc_source("chrome"), Source::System);
    }

    /// The whole run, as on a machine where the native sections fail: every section is still
    /// printed and saved, and the settings and cache sections are filled from the data dir.
    #[test]
    fn the_whole_report_is_printed_saved_and_degrades_section_by_section() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let env =
            |name: &str| matches!(name, "HOME" | "APPDATA").then(|| home.clone().into_os_string());
        let data = app_data_dir(std::env::consts::OS, &identifier().unwrap(), &env).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(
            data.join("settings.json"),
            r#"{"settings": {"mode": "drift", "globalOffsetMs": 120}}"#,
        )
        .unwrap();
        let reports = temp.path().join("reports");
        std::fs::create_dir(&reports).unwrap();
        let mut printed = String::new();
        let (code, saved) = write_report(&reports, &env, &mut |text| printed.push_str(text));
        assert_eq!(code, 0);
        let saved = saved.unwrap();
        assert_eq!(std::fs::read_to_string(&saved).unwrap(), printed);
        for expected in [
            "== Undertone ",
            "== Media sources ==",
            "== Current track ==",
            "== Lyrics (LRCLIB) ==",
            "== Settings ==",
            "== Lyrics cache ==",
            "== Displays ==",
            "== Desktop layer ==",
            "state:       saved; Undertone repairs or migrates it on start",
            "\"mode\": \"drift\"",
            "\"globalOffsetMs\": 120.0",
            &format!("report file: {}", saved.display()),
            &format!("file:        {}", data.join("settings.json").display()),
            &format!("dir:         {}", data.join("lyrics").display()),
            "entries:     none yet",
        ] {
            assert!(printed.contains(expected), "{expected}\n{printed}");
        }
        assert!(printed.ends_with(&format!("\nReport saved to {}\n", saved.display())));
        #[cfg(not(all(feature = "desktop", any(target_os = "windows", target_os = "macos"))))]
        for expected in [
            "== Media sources ==\n  unavailable: ",
            "== Current track ==\n  unavailable: ",
            "== Lyrics (LRCLIB) ==\n  unavailable: no current track",
            "== Displays ==\n  unavailable: ",
            "== Desktop layer ==\n  unavailable: ",
        ] {
            assert!(printed.contains(expected), "{expected}\n{printed}");
        }
    }

    #[test]
    fn an_unwritable_report_dir_still_prints_everything_and_fails() {
        let temp = tempfile::tempdir().unwrap();
        let mut printed = String::new();
        let (code, saved) =
            write_report(&temp.path().join("missing"), &|_: &str| None, &mut |text| {
                printed.push_str(text)
            });
        assert_eq!(code, 1);
        assert!(saved.is_none());
        assert!(printed.contains("report file: not saved: "));
        assert!(printed.contains("== Settings ==\n  unavailable: "));
        assert!(printed.contains("== Desktop layer =="));
        assert!(printed.contains("\nReport not saved: "));
    }
}
