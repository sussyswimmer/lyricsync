//! The runtime log. A release build has no stderr anyone can read (Windows release builds have no
//! console, and macOS drops the stderr of an app started from Finder or at login), so everything
//! the running app reports also goes to `undertone.log` in the app log dir, where `--diagnose`
//! shows its last lines and a bug report can attach it:
//! - macOS: `~/Library/Logs/com.undertone.desktop`
//! - Windows: `%LOCALAPPDATA%\com.undertone.desktop\logs`
//!
//! `applog!` takes `format!` arguments and works from any thread, before `init` too (stderr only
//! then). **Never log lyric text**: the file is meant to be shared. A track's title is fine; the
//! diagnose report prints it anyway.
//!
//! Each message is one line, stamped in UTC. The file moves to `undertone.1.log` (replacing the
//! one before) when it would pass 512 KiB, and a message that repeats within a minute is written
//! once and then counted, so a failure that recurs every second can't fill the disk.
use std::{
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, Once, TryLockError},
    time::{SystemTime, UNIX_EPOCH},
};

/// Logs one message to stderr and, once `init` has run, to the log file. In scope in every module
/// declared after `applog` in lib.rs; `crate::applog!` works anywhere.
///
/// ```ignore
/// applog!("settings save failed: {error}");
/// ```
#[macro_export]
macro_rules! applog {
    ($($arg:tt)*) => {
        $crate::applog::write(format_args!($($arg)*))
    };
}

pub const FILE: &str = "undertone.log";
pub const ROTATED: &str = "undertone.1.log";
pub const MAX_BYTES: u64 = 512 * 1024;
/// A longer message (an error that quotes a whole response) is cut here.
const MAX_MESSAGE_CHARS: usize = 2000;
/// The same message again within this long is counted instead of written.
const REPEAT_WINDOW_MS: u64 = 60_000;

static LOG: Mutex<Option<Log>> = Mutex::new(None);
static PANIC_HOOK: Once = Once::new();

struct Log {
    dir: PathBuf,
    repeats: Repeats,
    /// The last append failed: said once on stderr, not again until one works.
    failing: bool,
}
impl Log {
    fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            repeats: Repeats::default(),
            failing: false,
        }
    }
    /// Writes one line, stamped with `now_ms`, unless it repeats the last one.
    fn add(&mut self, line: &str, now_ms: u64) {
        let text: String = self
            .repeats
            .admit(line, now_ms)
            .iter()
            .map(|line| format!("{} {line}\n", stamp(now_ms)))
            .collect();
        if text.is_empty() {
            return;
        }
        match append(&self.dir, &text) {
            Ok(()) => self.failing = false,
            Err(error) => {
                if !self.failing {
                    eprintln!("log file {}: {error}", self.dir.join(FILE).display());
                }
                self.failing = true;
            }
        }
    }
}

/// Starts writing to `dir/undertone.log`, and logs a panic before the process ends: release
/// builds abort on panic, which would otherwise leave nothing behind.
pub fn init(dir: PathBuf) {
    *lock() = Some(Log::new(dir));
    PANIC_HOOK.call_once(|| {
        let report = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            record(&format!("panic: {info}"), true);
            report(info);
        }));
    });
}

/// `applog!`'s body.
pub fn write(message: fmt::Arguments<'_>) {
    record(&message.to_string(), false);
}

/// A panic while logging left nothing half-done that matters, so a poisoned lock is used as is.
fn lock() -> MutexGuard<'static, Option<Log>> {
    LOG.lock().unwrap_or_else(|e| e.into_inner())
}
fn try_lock() -> Option<MutexGuard<'static, Option<Log>>> {
    match LOG.try_lock() {
        Ok(log) => Some(log),
        Err(TryLockError::Poisoned(log)) => Some(log.into_inner()),
        Err(TryLockError::WouldBlock) => None,
    }
}

/// A panic's message is already on stderr (the default hook prints it), and its record never
/// waits: the panic may have happened while this thread held the log.
fn record(message: &str, panic: bool) {
    let message = one_line(message);
    if !panic {
        eprintln!("{message}");
    }
    let Some(mut log) = (if panic { try_lock() } else { Some(lock()) }) else {
        return;
    };
    if let Some(log) = log.as_mut() {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |now| now.as_millis() as u64);
        log.add(&message, now_ms);
    }
}

/// One line however the message was written: control characters (a newline in an OS error)
/// become spaces, and a very long message is cut.
pub fn one_line(message: &str) -> String {
    let mut line: String = message
        .chars()
        .take(MAX_MESSAGE_CHARS + 1)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    if line.chars().count() > MAX_MESSAGE_CHARS {
        line = line.chars().take(MAX_MESSAGE_CHARS).collect();
        line.push('…');
    }
    line.trim_end().to_owned()
}

/// `2026-10-06T09:05:00.123Z`.
pub fn stamp(unix_ms: u64) -> String {
    let (year, month, day, hour, minute, second) = utc_parts(unix_ms / 1000);
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        unix_ms % 1000
    )
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
pub(crate) fn utc_parts(secs: u64) -> (i64, u32, u32, u64, u64, u64) {
    let (year, month, day) = civil((secs / 86_400) as i64);
    let rest = secs % 86_400;
    (year, month, day, rest / 3600, rest / 60 % 60, rest % 60)
}

/// Collapses a message that keeps coming back.
#[derive(Debug, Default)]
pub struct Repeats {
    /// The last message written, and when.
    last: Option<(String, u64)>,
    /// How often it came back since, unwritten.
    dropped: u32,
}
impl Repeats {
    /// The lines to write for `message` at `now_ms`: none when it repeats the last one written
    /// less than a minute ago; otherwise how often the last one was dropped (if it was), then
    /// `message`. A message that keeps repeating is thus written about once a minute.
    pub fn admit(&mut self, message: &str, now_ms: u64) -> Vec<String> {
        if let Some((last, written_at)) = &self.last {
            if last == message && now_ms.saturating_sub(*written_at) < REPEAT_WINDOW_MS {
                self.dropped += 1;
                return Vec::new();
            }
        }
        let mut lines = Vec::new();
        if self.dropped > 0 {
            lines.push(format!(
                "(the message before repeated {} more {})",
                self.dropped,
                if self.dropped == 1 { "time" } else { "times" }
            ));
        }
        lines.push(message.to_owned());
        self.last = Some((message.to_owned(), now_ms));
        self.dropped = 0;
        lines
    }
}

/// Whether a log of `len` bytes moves aside before `adding` more: when it would pass
/// `MAX_BYTES`. An empty log never does, so one huge write can't loop.
pub fn needs_rotation(len: u64, adding: usize) -> bool {
    len > 0 && len.saturating_add(adding as u64) > MAX_BYTES
}

/// Appends `text` to `dir/undertone.log`, creating the dir, after moving a log that would grow
/// past `MAX_BYTES` to `undertone.1.log`.
pub fn append(dir: &Path, text: &str) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let path = dir.join(FILE);
    let len = fs::metadata(&path).map_or(0, |metadata| metadata.len());
    if needs_rotation(len, text.len()) {
        fs::rename(&path, dir.join(ROTATED))?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?
        .write_all(text.as_bytes())
}

/// The last `count` lines of `dir/undertone.log`, from at most its last 64 KiB; `None` when there
/// is no log yet.
pub fn tail(dir: &Path, count: usize) -> io::Result<Option<Vec<String>>> {
    const WINDOW: u64 = 64 * 1024;
    let mut file = match File::open(dir.join(FILE)) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let start = file.metadata()?.len().saturating_sub(WINDOW);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(WINDOW).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        // Read from the middle of a line.
        lines.remove(0);
    }
    let skip = lines.len().saturating_sub(count);
    Ok(Some(
        lines[skip..]
            .iter()
            .map(|line| (*line).to_owned())
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_is_one_stamped_line() {
        assert_eq!(stamp(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(stamp(1_791_277_500_042), "2026-10-06T09:05:00.042Z");
        assert_eq!(
            one_line("desktop layer:\r\nattach failed\t(5)\n"),
            "desktop layer:  attach failed (5)"
        );
        let long = one_line(&"x".repeat(MAX_MESSAGE_CHARS + 50));
        assert_eq!(long.chars().count(), MAX_MESSAGE_CHARS + 1);
        assert!(long.ends_with("x…"));
        assert_eq!(
            one_line(&"é".repeat(MAX_MESSAGE_CHARS)).chars().count(),
            MAX_MESSAGE_CHARS
        );
    }

    #[test]
    fn a_repeated_message_is_written_once_a_minute_with_a_count() {
        let mut repeats = Repeats::default();
        assert_eq!(repeats.admit("tray update: busy", 0), ["tray update: busy"]);
        assert!(repeats.admit("tray update: busy", 1_000).is_empty());
        assert!(repeats.admit("tray update: busy", 59_999).is_empty());
        // Another message says how often the last one was dropped.
        assert_eq!(
            repeats.admit("shortcut: nothing is playing", 60_500),
            [
                "(the message before repeated 2 more times)",
                "shortcut: nothing is playing"
            ]
        );
        // The same message after a minute is written again.
        assert!(repeats
            .admit("shortcut: nothing is playing", 70_000)
            .is_empty());
        assert_eq!(
            repeats.admit("shortcut: nothing is playing", 120_500),
            [
                "(the message before repeated 1 more time)",
                "shortcut: nothing is playing"
            ]
        );
        // A different message in between ends the streak.
        assert_eq!(repeats.admit("a", 121_000), ["a"]);
        assert_eq!(repeats.admit("b", 121_001), ["b"]);
        assert_eq!(repeats.admit("a", 121_002), ["a"]);
    }

    #[test]
    fn each_message_is_appended_stamped_and_a_repeat_only_counted() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = Log::new(dir.path().join("logs"));
        let at = 1_791_277_500_000;
        log.add("Undertone 0.1.0 started", at);
        log.add("tray update: busy", at + 1);
        log.add("tray update: busy", at + 2);
        log.add("tray update: busy", at + 3);
        log.add("settings save failed: disk full", at + 1_004);
        assert_eq!(
            fs::read_to_string(dir.path().join("logs").join(FILE)).unwrap(),
            "2026-10-06T09:05:00.000Z Undertone 0.1.0 started\n\
             2026-10-06T09:05:00.001Z tray update: busy\n\
             2026-10-06T09:05:01.004Z (the message before repeated 2 more times)\n\
             2026-10-06T09:05:01.004Z settings save failed: disk full\n"
        );
        assert!(!log.failing);
        // An unwritable dir (here, a file in its place) is noted, and the next success clears it.
        let blocked = dir.path().join("blocked");
        fs::write(&blocked, "").unwrap();
        let mut log = Log::new(blocked.clone());
        log.add("lost", at);
        assert!(log.failing);
        fs::remove_file(&blocked).unwrap();
        log.add("kept", at + 1);
        assert!(!log.failing);
        assert_eq!(tail(&blocked, 5).unwrap().unwrap().len(), 1);
    }

    #[test]
    fn the_log_moves_aside_before_it_passes_512_kib() {
        assert!(!needs_rotation(0, 10));
        assert!(
            !needs_rotation(0, 10 * MAX_BYTES as usize),
            "an empty log takes anything"
        );
        assert!(!needs_rotation(MAX_BYTES - 10, 10));
        assert!(needs_rotation(MAX_BYTES - 10, 11));
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        append(&logs, "first\n").unwrap();
        append(&logs, "second\n").unwrap();
        assert_eq!(
            fs::read_to_string(logs.join(FILE)).unwrap(),
            "first\nsecond\n"
        );
        // Grown to exactly the limit: the next line starts a new file, and the old one replaces
        // the previous rotation.
        fs::write(logs.join(ROTATED), "older\n").unwrap();
        let full = "x".repeat(MAX_BYTES as usize - 14) + "\n";
        append(&logs, &full).unwrap();
        assert_eq!(fs::metadata(logs.join(FILE)).unwrap().len(), MAX_BYTES);
        append(&logs, "after\n").unwrap();
        assert_eq!(fs::read_to_string(logs.join(FILE)).unwrap(), "after\n");
        let rotated = fs::read_to_string(logs.join(ROTATED)).unwrap();
        assert!(rotated.starts_with("first\nsecond\nxxx") && rotated.len() as u64 == MAX_BYTES);
    }

    #[test]
    fn tail_reads_the_last_lines_or_says_there_is_no_log() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(tail(dir.path(), 3).unwrap(), None);
        append(dir.path(), "one\ntwo\nthree\nfour\n").unwrap();
        assert_eq!(
            tail(dir.path(), 3).unwrap(),
            Some(vec!["two".into(), "three".into(), "four".into()])
        );
        assert_eq!(tail(dir.path(), 10).unwrap().unwrap().len(), 4);
        // A long log: only its end is read, and never half a line.
        let long: String = (0..20_000).map(|n| format!("line {n}\n")).collect();
        fs::write(dir.path().join(FILE), long).unwrap();
        let lines = tail(dir.path(), 60).unwrap().unwrap();
        assert_eq!(lines.len(), 60);
        assert_eq!(lines.first().unwrap(), "line 19940");
        assert_eq!(lines.last().unwrap(), "line 19999");
        let all = tail(dir.path(), usize::MAX).unwrap().unwrap();
        assert!(
            all.iter().all(|line| line.starts_with("line ")),
            "{:?}",
            all[0]
        );
    }

    #[test]
    fn a_second_launch_logs_no_start() {
        // A second launch (how Windows reopens Settings) opens the log too, then single-instance
        // hands it over and exits inside `build`. Logged before that, its "started" line would
        // read in `--diagnose` like a restart with no exit before it.
        let lib = include_str!("lib.rs").replace("\r\n", "\n"); // a Windows checkout has CRLF
        let body = |signature: &str| {
            let start = lib.find(&format!("\n{signature} {{\n")).expect(signature);
            &lib[start..start + lib[start..].find("\n}\n").unwrap()]
        };
        assert!(!body("fn start_log()").contains("started"));
        assert!(body("fn log_started()").contains("\"Undertone {} started ("));
        let run = body("pub fn run()");
        let order = [
            "start_log();",
            "tauri_plugin_single_instance::init(",
            ".build(tauri::generate_context!())",
            "log_started();",
            "app.run(",
        ]
        .map(|step| run.find(step).expect(step));
        assert!(order.windows(2).all(|pair| pair[0] < pair[1]), "{order:?}");
        assert_eq!(lib.matches("log_started();").count(), 1);
    }
}
