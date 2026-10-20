//! X4 settings: validation, migration and persistence. The pure functions, settings.json's reading
//! and writing included, are portable and tested on every OS; `runtime` keeps the settings in
//! AppState, saves every change and broadcasts `settings-changed`.
//!
//! Every field is validated on its own: unknown keys are dropped, numbers are clamped to the SPEC
//! ranges, and a value of the wrong type or outside an enum keeps the current one. The mock bridge
//! (`src/bridge/mock.ts`) implements the same rules for `pnpm dev`.
//!
//! Contract v3 added `enabled`, `launchAtLogin` and `shortcuts`, contract v4 `effects`, contract
//! v5 `effectsMode`, contract v7 `nudgedTracks` and contract v8 `karaokeMode`, without a new settings
//! version: a stored file without them loads with their defaults and is rewritten once with them
//! (`load`). Contract v8 also turned Effects mode off by default; `migrate` turns it off once in a
//! file saved before v8.
use crate::contract::{Colors, Font, Settings, Shortcuts, SETTINGS_VERSION};
use crate::shortcuts::{field as shortcut_field, normalize as accelerator, ACTIONS};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{self, Read, Write},
    ops::RangeInclusive,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const SIZE: RangeInclusive<f64> = 22.0..=140.0;
pub const CURVE: RangeInclusive<f64> = -100.0..=100.0;
pub const Y_POS: RangeInclusive<f64> = 0.0..=100.0;
pub const GLOW: RangeInclusive<f64> = 0.0..=100.0;
/// How much lyrics move as they're sung (contract v4); 50 is the look as picked.
pub const EFFECTS: RangeInclusive<f64> = 0.0..=100.0;
pub const OPACITY: RangeInclusive<f64> = 20.0..=100.0;
pub const FONT_WEIGHT: RangeInclusive<f64> = 100.0..=900.0;
/// Both the global offset and every per-song offset.
pub const OFFSET_MS: RangeInclusive<f64> = -2000.0..=2000.0;
pub const FONT_FAMILY_MAX_CHARS: usize = 64;

/// A finite number clamped to `range`; `None` for anything else.
pub fn clamp_number(value: &Value, range: &RangeInclusive<f64>) -> Option<f64> {
    value
        .as_f64()
        .filter(|n| n.is_finite())
        .map(|n| n.clamp(*range.start(), *range.end()))
}

/// `#rrggbb`, lowercased; `None` for anything else.
pub fn hex_color(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    let digits = text.strip_prefix('#')?;
    (digits.len() == 6 && digits.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| text.to_ascii_lowercase())
}

/// A font family that isn't blank and has at most 64 characters.
pub fn font_family(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    (!text.trim().is_empty() && text.chars().count() <= FONT_FAMILY_MAX_CHARS)
        .then(|| text.to_owned())
}

/// Per-song offsets: each entry clamped to ±2000 ms; non-numeric and non-finite ones dropped. Since
/// contract v7 a 0 is a song's own offset and is kept (-0 reads as 0).
pub fn track_offsets(value: &Value) -> Option<BTreeMap<String, f64>> {
    let entries = value.as_object()?;
    Some(
        entries
            .iter()
            .filter_map(|(key, ms)| Some((key.clone(), clamp_number(ms, &OFFSET_MS)? + 0.0)))
            .collect(),
    )
}

/// How many of the most recently nudged songs the learned offset looks at.
pub const NUDGED_TRACKS_MAX: usize = 9;

/// `nudgedTracks`: strings only, each once (at its last place), the newest `NUDGED_TRACKS_MAX`.
pub fn nudged_tracks(value: &Value) -> Option<Vec<String>> {
    Some(
        value
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .fold(Vec::new(), |list, key| nudged_after(&list, key)),
    )
}

/// The recently nudged songs once `track_key` is nudged: it moves to the end, the oldest past the
/// limit drop off.
pub fn nudged_after(nudged: &[String], track_key: &str) -> Vec<String> {
    let mut next: Vec<String> = nudged
        .iter()
        .filter(|key| *key != track_key)
        .cloned()
        .collect();
    next.push(track_key.to_owned());
    let excess = next.len().saturating_sub(NUDGED_TRACKS_MAX);
    next.split_off(excess)
}

/// The offset a song without its own starts from: the middle of the recently nudged songs' own
/// offsets, from two songs on. With an even number, the middle value nearer 0 (0 when the two are
/// equally near). The same rule as `src/core/sync.ts` `learnedOffsetMs`: keep the two in step.
pub fn learned_offset_ms(settings: &Settings) -> f64 {
    let mut values: Vec<f64> = settings
        .nudged_tracks
        .iter()
        .filter_map(|key| settings.track_offsets_ms.get(key).copied())
        .filter(|ms| ms.is_finite())
        .collect();
    values.sort_by(f64::total_cmp);
    let n = values.len();
    if n < 2 {
        return 0.0;
    }
    let hi = values[n / 2];
    if n % 2 == 1 {
        return hi;
    }
    let lo = values[n / 2 - 1];
    if lo.abs() < hi.abs() {
        lo
    } else if hi.abs() < lo.abs() {
        hi
    } else if lo == hi {
        lo
    } else {
        0.0
    }
}

/// The song's own offset, if it has one (0 included).
pub fn own_offset_ms(settings: &Settings, track_key: &str) -> Option<f64> {
    settings
        .track_offsets_ms
        .get(track_key)
        .copied()
        .filter(|ms| ms.is_finite())
}

/// The song's sync on top of All songs: its own offset, or the learned one.
pub fn song_offset_ms(settings: &Settings, track_key: &str) -> f64 {
    own_offset_ms(settings, track_key).unwrap_or_else(|| learned_offset_ms(settings))
}

/// One of a contract enum's wire values (`mode`, `showWhen`, `displays`). Strings only: serde
/// would also read `{"arc": null}` as a unit variant.
fn variant<T: DeserializeOwned>(value: &Value) -> Option<T> {
    value.as_str()?;
    T::deserialize(value).ok()
}

fn keep_or_set<T>(field: &mut T, value: Option<T>) {
    if let Some(value) = value {
        *field = value;
    }
}

/// A partial `colors` object changes only the keys it has.
fn merge_colors(colors: &mut Colors, patch: &Value) {
    let Some(patch) = patch.as_object() else {
        return;
    };
    for (key, field) in [
        ("lyric", &mut colors.lyric),
        ("highlight", &mut colors.highlight),
        ("dim", &mut colors.dim),
    ] {
        keep_or_set(field, patch.get(key).and_then(hex_color));
    }
}

/// A partial `font` object changes only the keys it has.
fn merge_font(font: &mut Font, patch: &Value) {
    let Some(patch) = patch.as_object() else {
        return;
    };
    keep_or_set(&mut font.family, patch.get("family").and_then(font_family));
    keep_or_set(
        &mut font.weight,
        patch
            .get("weight")
            .and_then(|w| clamp_number(w, &FONT_WEIGHT)),
    );
}

/// A partial `shortcuts` object changes only the keys it has. A binding must be an accelerator
/// (`crate::shortcuts::normalize`, stored in its one spelling) or "" for none. A binding that would
/// press the same keys as another action's, once the patch is applied, keeps its current value; so
/// does the other action's if the patch changes it too. That rule is checked again after each
/// revert, so the result never has two actions on one accelerator, and a complete set of distinct
/// bindings (Reset shortcuts, a swap) always applies whatever the current ones are.
pub fn merge_shortcuts(current: &Shortcuts, patch: &Value) -> Shortcuts {
    let Some(patch) = patch.as_object() else {
        return current.clone();
    };
    let mut next = current.clone();
    keep_or_set(
        &mut next.enabled,
        patch.get("enabled").and_then(Value::as_bool),
    );
    let mut changed = Vec::new();
    for action in ACTIONS {
        let binding = patch
            .get(shortcut_field(action))
            .and_then(Value::as_str)
            .and_then(accelerator);
        if let Some(binding) = binding.filter(|binding| binding != current.binding(action)) {
            *next.binding_mut(action) = binding;
            changed.push(action);
        }
    }
    loop {
        let clashing: Vec<_> = changed
            .iter()
            .copied()
            .filter(|action| {
                let binding = next.binding(*action);
                !binding.is_empty()
                    && ACTIONS
                        .iter()
                        .any(|other| other != action && next.binding(*other) == binding)
            })
            .collect();
        if clashing.is_empty() {
            return next;
        }
        for action in clashing {
            *next.binding_mut(action) = current.binding(action).to_owned();
            changed.retain(|other| *other != action);
        }
    }
}

/// `update_settings`: a shallow top-level merge, validated field by field. Anything that isn't an
/// object changes nothing. `trackOffsetsMs` and `nudgedTracks` replace the whole map and list (the
/// settings window sends them only as `{}` and `[]`, to clear every song on Reset; per-song changes
/// go through `with_track_offset`).
pub fn merge_patch(current: &Settings, patch: &Value) -> Settings {
    let mut next = current.clone();
    next.version = SETTINGS_VERSION;
    let Some(patch) = patch.as_object() else {
        return next;
    };
    for (key, value) in patch {
        match key.as_str() {
            "mode" => keep_or_set(&mut next.mode, variant(value)),
            "autoColor" => keep_or_set(&mut next.auto_color, value.as_bool()),
            "colors" => merge_colors(&mut next.colors, value),
            "font" => merge_font(&mut next.font, value),
            "size" => keep_or_set(&mut next.size, clamp_number(value, &SIZE)),
            "curve" => keep_or_set(&mut next.curve, clamp_number(value, &CURVE)),
            "yPos" => keep_or_set(&mut next.y_pos, clamp_number(value, &Y_POS)),
            "glow" => keep_or_set(&mut next.glow, clamp_number(value, &GLOW)),
            "opacity" => keep_or_set(&mut next.opacity, clamp_number(value, &OPACITY)),
            "showWhen" => keep_or_set(&mut next.show_when, variant(value)),
            "displays" => keep_or_set(&mut next.displays, variant(value)),
            "globalOffsetMs" => {
                keep_or_set(&mut next.global_offset_ms, clamp_number(value, &OFFSET_MS))
            }
            "trackOffsetsMs" => keep_or_set(&mut next.track_offsets_ms, track_offsets(value)),
            "nudgedTracks" => keep_or_set(&mut next.nudged_tracks, nudged_tracks(value)),
            "enabled" => keep_or_set(&mut next.enabled, value.as_bool()),
            "launchAtLogin" => keep_or_set(&mut next.launch_at_login, value.as_bool()),
            "shortcuts" => next.shortcuts = merge_shortcuts(&next.shortcuts, value),
            "effects" => keep_or_set(&mut next.effects, clamp_number(value, &EFFECTS)),
            "effectsMode" => keep_or_set(&mut next.effects_mode, value.as_bool()),
            "karaokeMode" => keep_or_set(&mut next.karaoke_mode, value.as_bool()),
            // `version` is always SETTINGS_VERSION; anything else is unknown and dropped.
            _ => {}
        }
    }
    next
}

/// Turns stored settings of any shape (an older, newer or missing `version`, missing or invalid
/// fields, not even an object) into valid ones by the update rules, starting from the defaults.
/// Settings v1 has no renamed fields to carry over; a future version adds its steps here.
pub fn migrate(stored: &Value) -> Settings {
    let mut settings = merge_patch(&Settings::default(), stored);
    // Effects mode was on by default until contract v8, so a file saved before it (no `karaokeMode`)
    // says `effectsMode: true` whether or not anyone chose it: it starts off, as on a new install.
    // `load` then rewrites the file with `karaokeMode`, so a choice made after that sticks.
    if stored.is_object() && stored.get("karaokeMode").is_none() {
        settings.effects_mode = Settings::default().effects_mode;
    }
    settings
}

/// What startup (`open`) does with the stored value: the settings to use, and whether the file
/// must be rewritten because migrating changed them (or there was nothing stored yet).
pub fn load(stored: Option<&Value>) -> (Settings, bool) {
    let settings = migrate(stored.unwrap_or(&Value::Null));
    let unchanged = stored.is_some_and(|stored| {
        serde_json::to_value(&settings).is_ok_and(|migrated| migrated == *stored)
    });
    (settings, !unchanged)
}

/// Takes the OS login item's real state (`None`: it couldn't be read) into `settings`: the user
/// may have added or removed it in the OS. True when that changed them.
pub fn adopt_login_item(settings: &mut Settings, login_item: Option<bool>) -> bool {
    match login_item {
        Some(real) if real != settings.launch_at_login => {
            settings.launch_at_login = real;
            true
        }
        _ => false,
    }
}

/// A change that may turn launch at login on or off: when `next` changes `launchAtLogin`, `set`
/// changes the OS login item to match. If that fails, `launchAtLogin` keeps its current value, the
/// rest of `next` still applies, and the error comes back with the settings.
pub fn with_login_item(
    current: &Settings,
    mut next: Settings,
    set: impl FnOnce(bool) -> Result<(), String>,
) -> (Settings, Option<String>) {
    if next.launch_at_login == current.launch_at_login {
        return (next, None);
    }
    match set(next.launch_at_login) {
        Ok(()) => (next, None),
        Err(error) => {
            next.launch_at_login = current.launch_at_login;
            (next, Some(error))
        }
    }
}

/// Whether a change concerns the desktop layer: how many overlays there are and when they show.
/// Everything else is drawn by the overlay webviews from `settings-changed`, and a layer refresh
/// re-attaches (hides and shows) every overlay, so a slider drag must not trigger one.
pub fn affects_layer(before: &Settings, after: &Settings) -> bool {
    before.show_when != after.show_when
        || before.displays != after.displays
        || before.enabled != after.enabled
}

/// Sets one song's own sync offset, clamped to ±2000 ms (0 included), and makes it the most
/// recently nudged song. `None` drops its own offset and its place among them: it follows the
/// learned offset again.
pub fn with_track_offset(
    current: &Settings,
    track_key: &str,
    ms: Option<f64>,
) -> Result<Settings, String> {
    let mut next = current.clone();
    let Some(ms) = ms else {
        next.track_offsets_ms.remove(track_key);
        next.nudged_tracks.retain(|key| key != track_key);
        return Ok(next);
    };
    if !ms.is_finite() {
        return Err("offset must be finite".into());
    }
    let ms = ms.clamp(*OFFSET_MS.start(), *OFFSET_MS.end()) + 0.0;
    next.track_offsets_ms.insert(track_key.to_owned(), ms);
    next.nudged_tracks = nudged_after(&next.nudged_tracks, track_key);
    Ok(next)
}

/// What one settings change did.
#[derive(Debug, PartialEq)]
pub enum Committed {
    /// The change left the settings as they were: nothing was saved.
    Unchanged(Settings),
    /// The new settings, saved; `refresh` when they concern the desktop layer (`affects_layer`),
    /// `reregister` when the shortcuts changed.
    Changed {
        settings: Settings,
        refresh: bool,
        reregister: bool,
    },
}

/// One settings change, safe from any thread at once: commands run on the async runtime, the tray
/// and shortcuts on the main thread. `writer` is held from reading the current settings to saving
/// the new ones, so concurrent changes can't lose each other or reach the disk out of order.
/// `settings` is held only to copy them and to replace them in memory, so readers (the desktop
/// layer and the tray on the main thread, `get_settings`) never wait for the disk, nor for
/// `change`, which may turn the OS login item on or off. Only writers replace the settings and
/// they all hold `writer`, so the copy stays current until replaced. Always `writer` first.
pub fn commit(
    writer: &Mutex<()>,
    settings: &Mutex<Settings>,
    change: impl FnOnce(&Settings) -> Result<Settings, String>,
    save: impl FnOnce(&Settings),
) -> Result<Committed, String> {
    // Guards no data: a writer that panicked left nothing half-done to protect.
    let _writer = writer.lock().unwrap_or_else(|e| e.into_inner());
    let current = settings.lock().map_err(|e| e.to_string())?.clone();
    let next = change(&current)?;
    if current == next {
        return Ok(Committed::Unchanged(next));
    }
    *settings.lock().map_err(|e| e.to_string())? = next.clone();
    save(&next);
    Ok(Committed::Changed {
        refresh: affects_layer(&current, &next),
        reregister: current.shortcuts != next.shortcuts,
        settings: next,
    })
}

/// settings.json, in the app data dir. Its shape, `{"settings": {...}}` in pretty JSON, is what
/// tauri-plugin-store wrote before Undertone wrote the file itself, so either one loads unchanged.
pub const FILE: &str = "settings.json";
const KEY: &str = "settings";
/// Settings take a few KiB; a larger file isn't one.
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// What settings.json holds.
#[derive(Debug, Clone, PartialEq)]
pub enum Stored {
    /// No file yet: the first launch.
    Missing,
    /// A file without usable settings: unreadable, too large, not JSON, or no `settings` entry.
    Unusable(String),
    /// The `settings` entry, as stored (`load` makes it valid).
    Found(Value),
}

/// Reads settings.json, up to `MAX_FILE_BYTES`; `--diagnose` reads it the same way.
pub fn read_file(path: &Path) -> Stored {
    let mut bytes = Vec::new();
    let read =
        File::open(path).and_then(|file| file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes));
    match read {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Stored::Missing,
        Err(error) => return Stored::Unusable(error.to_string()),
        Ok(_) if bytes.len() as u64 > MAX_FILE_BYTES => {
            return Stored::Unusable(format!("larger than {} KiB", MAX_FILE_BYTES / 1024))
        }
        Ok(_) => {}
    }
    match serde_json::from_slice::<Value>(&bytes) {
        Err(error) => Stored::Unusable(format!("not JSON: {error}")),
        Ok(mut value) => match value.get_mut(KEY) {
            Some(stored) => Stored::Found(stored.take()),
            None => Stored::Unusable(format!("no {KEY:?} entry")),
        },
    }
}

/// The file's bytes for `settings`.
pub fn encode(settings: &Settings) -> serde_json::Result<Vec<u8>> {
    let entry = serde_json::Map::from_iter([(KEY.to_owned(), serde_json::to_value(settings)?)]);
    serde_json::to_vec_pretty(&Value::Object(entry))
}

/// Saves `settings` to `path` in one step: a temporary file next to it, flushed to the disk, then
/// renamed over the old one. A crash, logout or power loss mid-save leaves the old file or the new
/// one, never part of one.
pub fn write_file(path: &Path, settings: &Settings) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other("the settings file has no folder"))?;
    fs::create_dir_all(dir)?;
    let mut temporary = tempfile::NamedTempFile::new_in(dir)?;
    temporary.write_all(&encode(settings)?)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

/// Where an unusable settings file goes before the defaults replace it:
/// `settings.corrupt-<unix-secs>.json` next to it.
pub fn backup_path(path: &Path, now_secs: u64) -> PathBuf {
    let stem = path
        .file_stem()
        .map_or("settings".into(), |stem| stem.to_string_lossy());
    path.with_file_name(format!("{stem}.corrupt-{now_secs}.json"))
}

/// What Undertone starts with (`runtime::install`).
#[derive(Debug, PartialEq)]
pub struct Opened {
    pub settings: Settings,
    /// The file must be written: there was none, it was unusable, or `load` changed it.
    pub rewrite: bool,
    /// Open Settings on this launch: there was no file (the first launch; a login-item start never
    /// is one, as the item can only be turned on after a launch) or its settings were lost.
    pub show_settings: bool,
}

/// Reads the settings at `path` for startup. An unusable file is moved aside to
/// `settings.corrupt-<unix-secs>.json` first, so writing the defaults can't destroy what it held.
pub fn open(path: &Path, now_secs: u64) -> Opened {
    let stored = match read_file(path) {
        Stored::Found(stored) => Some(stored),
        Stored::Missing => None,
        Stored::Unusable(error) => {
            let backup = backup_path(path, now_secs);
            match fs::rename(path, &backup) {
                Ok(()) => applog!(
                    "settings file unusable ({error}); moved to {} and using the defaults",
                    backup.display()
                ),
                Err(move_error) => applog!(
                    "settings file unusable ({error}) and not moved aside ({move_error}); using \
                     the defaults"
                ),
            }
            return Opened {
                settings: Settings::default(),
                rewrite: true,
                show_settings: true,
            };
        }
    };
    let (settings, rewrite) = load(stored.as_ref());
    Opened {
        show_settings: stored.is_none(),
        settings,
        rewrite,
    }
}

#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
pub mod runtime {
    use super::Committed;
    use crate::{contract::Settings, contract::SETTINGS_CHANGED_EVENT, state::AppState};
    use std::{
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex,
        },
        time::{SystemTime, UNIX_EPOCH},
    };
    use tauri::{AppHandle, Emitter, Manager};
    use tauri_plugin_autostart::AutoLaunchManager;

    /// Held by every change from reading the settings to saving them (`super::commit`).
    static WRITER: Mutex<()> = Mutex::new(());
    /// Set by `install`, with `WRITER` held, once the stored settings are in AppState. Before that a
    /// change would start from the defaults and its save would overwrite the stored file, so
    /// `modify` refuses it: on macOS a second launch reaches `show_settings` (and its login-item
    /// sync) from a tokio task that can run before the app's setup has called `install`.
    static INSTALLED: AtomicBool = AtomicBool::new(false);

    /// settings.json in the app data dir, where tauri-plugin-store kept it.
    fn file(app: &AppHandle) -> Result<PathBuf, String> {
        app.path()
            .app_data_dir()
            .map(|dir| dir.join(super::FILE))
            .map_err(|e| e.to_string())
    }

    /// Writes `settings` to disk (`super::write_file`), right away: there is no debounced
    /// auto-save. A failure is logged, not returned: the change still applies for this session,
    /// and the next successful save catches the file up.
    fn persist(app: &AppHandle, settings: &Settings) {
        let saved = file(app)
            .and_then(|path| super::write_file(&path, settings).map_err(|e| e.to_string()));
        if let Err(error) = saved {
            applog!("settings save failed: {error}");
        }
    }

    /// The OS login item's real state; `None` (logged) when it can't be read. On macOS the plugin
    /// only says whether its plist exists; System Settings may have turned it off since.
    fn login_item(app: &AppHandle) -> Option<bool> {
        match app.try_state::<AutoLaunchManager>()?.is_enabled() {
            #[cfg(target_os = "macos")]
            Ok(exists) => Some(crate::login_item::is_on(exists, login_item_status(app))),
            #[cfg(not(target_os = "macos"))]
            Ok(enabled) => Some(enabled),
            Err(error) => {
                applog!("launch at login: {error}");
                None
            }
        }
    }
    /// The plugin's LaunchAgent plist (`crate::login_item`).
    #[cfg(target_os = "macos")]
    fn plist(app: &AppHandle) -> Result<PathBuf, String> {
        app.path()
            .home_dir()
            .map(|home| crate::login_item::legacy_plist(&home, &app.package_info().name))
            .map_err(|e| e.to_string())
    }
    /// What macOS does with the plugin's LaunchAgent plist (`crate::login_item`).
    #[cfg(target_os = "macos")]
    fn login_item_status(app: &AppHandle) -> isize {
        match plist(app) {
            Ok(plist) => crate::login_item::native::status(&plist),
            Err(error) => {
                applog!("launch at login: {error}");
                crate::login_item::NOT_FOUND
            }
        }
    }
    /// The program the OS login item starts: the plist's on macOS, the Run value's on Windows,
    /// where one in either hive that starts `here` wins (`crate::login_item::stored_program`).
    /// `None` when there is no item, or (logged) when it can't be read.
    fn login_item_program(app: &AppHandle, here: &crate::login_item::Here) -> Option<String> {
        #[cfg(target_os = "macos")]
        let programs = plist(app)
            .and_then(|plist| crate::login_item::read_plist_program(&plist))
            .map(|program| program.into_iter().collect::<Vec<_>>());
        #[cfg(target_os = "windows")]
        let programs =
            crate::login_item::native::run_values(&app.package_info().name).map(|values| {
                values
                    .iter()
                    .filter_map(|(_, command)| crate::login_item::run_program(command))
                    .collect::<Vec<_>>()
            });
        match programs {
            Ok(programs) => {
                crate::login_item::stored_program(std::env::consts::OS, &programs, here)
                    .map(str::to_owned)
            }
            Err(error) => {
                applog!("launch at login: the login item's program: {error}");
                None
            }
        }
    }
    /// A login item turned on before Undertone was moved still starts the old path: nothing, at
    /// login, while it reads as on. Turning it on again makes the plugin write this copy's path
    /// (`crate::login_item::refresh`), never while this copy runs from a temporary place.
    fn refresh_login_item(app: &AppHandle, launch_at_login: bool) {
        // Off: no item to point anywhere, so nothing to read.
        if !launch_at_login {
            return;
        }
        let here = match crate::login_item::Here::current() {
            Ok(here) => here.for_build(cfg!(debug_assertions)),
            Err(error) => {
                applog!("launch at login: {error}");
                return;
            }
        };
        let stored = login_item_program(app, &here);
        let os = std::env::consts::OS;
        match crate::login_item::refresh(os, launch_at_login, stored.as_deref(), &here) {
            crate::login_item::Refresh::Keep => {}
            crate::login_item::Refresh::Temporary(place) => applog!(
                "launch at login: the login item starts another copy of Undertone; left as is \
                 while this one runs from {place}"
            ),
            crate::login_item::Refresh::Rewrite => {
                let enabled = app
                    .try_state::<AutoLaunchManager>()
                    .ok_or_else(|| "unavailable".to_owned())
                    .and_then(|launcher| launcher.enable().map_err(|e| e.to_string()));
                match enabled {
                    Ok(()) => applog!(
                        "launch at login: the login item started {}; it now starts {}",
                        stored.unwrap_or_default(),
                        here.program
                    ),
                    Err(error) => applog!("launch at login: not pointed at this copy: {error}"),
                }
            }
        }
    }
    fn set_login_item(app: &AppHandle, enabled: bool) -> Result<(), String> {
        let launcher = app
            .try_state::<AutoLaunchManager>()
            .ok_or("launch at login: unavailable")?;
        let result = if enabled {
            launcher.enable()
        } else {
            launcher.disable()
        };
        result.map_err(|e| format!("launch at login: {e}"))?;
        // A plist System Settings keeps turned off won't start Undertone: refuse, so the switch
        // stays off, and show the user where to allow it. The plist stays, so allowing it there
        // is picked up on the next tray hover or Settings show.
        #[cfg(target_os = "macos")]
        if enabled {
            if let Err(error) = crate::login_item::check_enabled(login_item_status(app)) {
                let opened = app.run_on_main_thread(crate::login_item::native::open_login_items);
                if let Err(open_error) = opened {
                    applog!("launch at login: System Settings not opened: {open_error}");
                }
                return Err(error);
            }
        }
        Ok(())
    }

    /// Loads stored settings into AppState before any window or service reads them, migrated to
    /// the current shape, with `launchAtLogin` taken from the OS login item (the user may have
    /// removed it while Undertone wasn't running), and written back when either changed them. A
    /// login item that's on is pointed at this copy if Undertone was moved (`refresh_login_item`).
    /// A missing file starts from the defaults; an unusable one is moved aside first
    /// (`super::open`). An unknown data dir is logged and doesn't stop the app. The autostart
    /// plugin is set up before the app's setup, so it can be read here. True when Settings should
    /// open on this launch (`Opened::show_settings`): the first one, or the settings were lost.
    pub fn install(app: &AppHandle) -> Result<bool, String> {
        // A change that arrives meanwhile applies on top of the stored settings, not the defaults.
        let _writer = WRITER.lock().unwrap_or_else(|e| e.into_inner());
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |now| now.as_secs());
        let opened = match file(app) {
            Ok(path) => super::open(&path, now_secs),
            Err(error) => {
                applog!("settings file unavailable; using the defaults: {error}");
                super::Opened {
                    settings: Settings::default(),
                    rewrite: false,
                    show_settings: false,
                }
            }
        };
        let mut settings = opened.settings;
        let adopted = super::adopt_login_item(&mut settings, login_item(app));
        refresh_login_item(app, settings.launch_at_login);
        if opened.rewrite || adopted {
            persist(app, &settings);
        }
        *app.state::<AppState>()
            .settings
            .lock()
            .map_err(|e| e.to_string())? = settings;
        INSTALLED.store(true, Ordering::Release);
        Ok(opened.show_settings)
    }

    /// Changes the settings through `super::commit`, so a command (async runtime) and a tray click
    /// (main thread) at once can't lose each other's change or reach the disk out of order. Real
    /// changes are saved, applied (overlay count and visibility, shortcut registration) and
    /// broadcast to every webview; no-op when unchanged. No lock is held while broadcasting, so
    /// Rust listeners may call `current`, and nothing here waits for the main thread, which may
    /// itself be waiting here: shortcuts register on the blocking pool. Returns the settings and
    /// whether they changed. Refused until `install` has loaded the stored settings.
    fn modify(
        app: &AppHandle,
        change: impl FnOnce(&Settings) -> Result<Settings, String>,
    ) -> Result<(Settings, bool), String> {
        let state = app.state::<AppState>();
        // Checked with `WRITER` held: `install` has either finished or not started.
        let loaded = |current: &Settings| {
            if !INSTALLED.load(Ordering::Acquire) {
                return Err("settings aren't loaded yet".to_owned());
            }
            change(current)
        };
        match super::commit(&WRITER, &state.settings, loaded, |next| persist(app, next))? {
            Committed::Unchanged(settings) => Ok((settings, false)),
            Committed::Changed {
                settings,
                refresh,
                reregister,
            } => {
                if refresh {
                    crate::desktop_layer::refresh_now();
                }
                if reregister {
                    crate::shortcuts::refresh(app);
                }
                broadcast(app);
                Ok((settings, true))
            }
        }
    }

    /// A change that may turn launch at login on or off. The OS login item changes inside the
    /// change (`super::with_login_item`), before the settings are stored, so the two can't
    /// disagree. If the OS refuses,
    /// `launchAtLogin` keeps its value, the rest of the change still applies, and the error is
    /// returned; every window hears `settings-changed` even when nothing else changed, so a
    /// switch that moved goes back.
    fn modify_with_login_item(
        app: &AppHandle,
        change: impl FnOnce(&Settings) -> Settings,
    ) -> Result<Settings, String> {
        let mut refused = None;
        let (settings, changed) = modify(app, |current| {
            let (next, error) =
                super::with_login_item(current, change(current), |on| set_login_item(app, on));
            refused = error;
            Ok(next)
        })?;
        match refused {
            None => Ok(settings),
            Some(error) => {
                if !changed {
                    broadcast(app);
                }
                Err(error)
            }
        }
    }

    /// `settings-changed`, emitted on the main thread with the settings as they are when it gets
    /// there. An emit on the main thread reaches the webviews at once, but one from another
    /// thread is queued behind the main thread's work, so a command's change and a tray click
    /// emitted where they happen could arrive in the wrong order and leave every window showing
    /// the older settings. Read on delivery, the last event always carries the latest settings
    /// (a window may get the same settings twice). Inline when already on the main thread.
    fn broadcast(app: &AppHandle) {
        let handle = app.clone();
        let queued = app.run_on_main_thread(move || {
            // The change is stored and saved, so a failed broadcast is logged rather than reported
            // as a failed save; the windows catch up on the next change.
            let sent = current(&handle).and_then(|settings| {
                handle
                    .emit(SETTINGS_CHANGED_EVENT, &settings)
                    .map_err(|e| e.to_string())
            });
            if let Err(error) = sent {
                applog!("settings-changed broadcast failed: {error}");
            }
        });
        if let Err(error) = queued {
            applog!("settings-changed broadcast failed: {error}");
        }
    }

    /// Stores whole settings built in Rust. They go through the same field rules as a patch, so an
    /// out-of-range or invalid value keeps the current one.
    pub fn apply(app: &AppHandle, next: Settings) -> Result<Settings, String> {
        let patch = serde_json::to_value(next).map_err(|e| e.to_string())?;
        update(app, &patch)
    }

    pub fn current(app: &AppHandle) -> Result<Settings, String> {
        Ok(app
            .state::<AppState>()
            .settings
            .lock()
            .map_err(|e| e.to_string())?
            .clone())
    }

    /// `update_settings`, and every tray item that sets one field.
    pub fn update(app: &AppHandle, patch: &serde_json::Value) -> Result<Settings, String> {
        modify_with_login_item(app, |current| super::merge_patch(current, patch))
    }

    /// Tray "Hide lyrics" / "Show lyrics" and the toggle shortcut. Read inside the change, so a
    /// Settings switch at the same moment can't be lost.
    pub fn toggle_enabled(app: &AppHandle) -> Result<Settings, String> {
        modify(app, |current| {
            Ok(Settings {
                enabled: !current.enabled,
                ..current.clone()
            })
        })
        .map(|(settings, _)| settings)
    }

    /// Tray "Launch at login".
    pub fn toggle_launch_at_login(app: &AppHandle) -> Result<Settings, String> {
        modify_with_login_item(app, |current| Settings {
            launch_at_login: !current.launch_at_login,
            ..current.clone()
        })
    }

    /// Takes the OS login item's real state into the settings while Undertone runs (tray hover,
    /// Settings shown): the user may have removed it in the OS. Read inside the change, which
    /// every login-item change also runs in, so a toggle at the same moment can't be undone.
    pub fn sync_login_item(app: &AppHandle) {
        let adopted = modify(app, |current| {
            let mut next = current.clone();
            super::adopt_login_item(&mut next, login_item(app));
            Ok(next)
        });
        if let Err(error) = adopted {
            applog!("launch at login: {error}");
        }
    }

    pub fn set_track_offset(
        app: &AppHandle,
        track_key: &str,
        ms: Option<f64>,
    ) -> Result<Settings, String> {
        modify(app, |current| {
            super::with_track_offset(current, track_key, ms)
        })
        .map(|(settings, _)| settings)
    }

    /// Moves one song's offset by `delta_ms` from where it is (its own, or the learned one), kept
    /// within ±2000 ms. The offset is read inside the change, so a nudge from the settings window
    /// at the same moment can't be lost.
    pub fn nudge_track_offset(
        app: &AppHandle,
        track_key: &str,
        delta_ms: f64,
    ) -> Result<Settings, String> {
        modify(app, |current| {
            let current_ms = super::song_offset_ms(current, track_key);
            super::with_track_offset(
                current,
                track_key,
                Some(crate::tray::nudged(current_ms, delta_ms)),
            )
        })
        .map(|(settings, _)| settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{Displays, Mode, ShowWhen};
    use crate::shortcuts::ACTIONS;
    use serde_json::json;

    fn defaults() -> Settings {
        Settings::default()
    }
    fn patched(patch: Value) -> Settings {
        merge_patch(&defaults(), &patch)
    }
    /// Non-default values everywhere, so "keeps the current value" can't be confused with "resets".
    fn custom() -> Settings {
        migrate(&json!({
            "mode": "lens", "autoColor": false,
            "colors": { "lyric": "#ffffff", "highlight": "#00ff88", "dim": "#202020" },
            "font": { "family": "Syne", "weight": 500 },
            "size": 80, "curve": -20, "yPos": 70, "glow": 10, "opacity": 60,
            "showWhen": "always", "displays": "all", "globalOffsetMs": 250,
            "trackOffsetsMs": { "a|b|c|1": -150 },
            "enabled": false, "launchAtLogin": true,
            "shortcuts": {
                "enabled": false, "toggleLyrics": "Alt+F1", "nudgeEarlier": "",
                "nudgeLater": "Control+Shift+K"
            },
            "effects": 80,
            "effectsMode": true,
            "karaokeMode": true
        }))
    }
    fn shortcuts(toggle: &str, earlier: &str, later: &str) -> Shortcuts {
        Shortcuts {
            enabled: true,
            toggle_lyrics: toggle.into(),
            nudge_earlier: earlier.into(),
            nudge_later: later.into(),
        }
    }

    #[test]
    fn accepts_a_valid_value_for_every_field() {
        let s = custom();
        assert_eq!(s.mode, Mode::Lens);
        assert!(!s.auto_color);
        assert_eq!(
            s.colors,
            Colors {
                lyric: "#ffffff".into(),
                highlight: "#00ff88".into(),
                dim: "#202020".into()
            }
        );
        assert_eq!(
            s.font,
            Font {
                family: "Syne".into(),
                weight: 500.0
            }
        );
        assert_eq!(
            (s.size, s.curve, s.y_pos, s.glow, s.opacity),
            (80.0, -20.0, 70.0, 10.0, 60.0)
        );
        assert_eq!(s.show_when, ShowWhen::Always);
        assert_eq!(s.displays, Displays::All);
        assert_eq!(s.global_offset_ms, 250.0);
        assert_eq!(
            s.track_offsets_ms,
            BTreeMap::from([("a|b|c|1".to_owned(), -150.0)])
        );
        assert!(!s.enabled && s.launch_at_login);
        assert_eq!(
            s.shortcuts,
            Shortcuts {
                enabled: false,
                ..shortcuts("Alt+F1", "", "Control+Shift+K")
            }
        );
        assert_eq!(s.effects, 80.0);
        assert!(s.effects_mode && s.karaoke_mode);
        assert_eq!(s.version, SETTINGS_VERSION);
    }

    #[test]
    fn accepts_every_enum_value_and_fractional_numbers() {
        for mode in ["arc", "lens", "drift", "stack"] {
            assert_eq!(
                serde_json::to_value(patched(json!({ "mode": mode })).mode).unwrap(),
                mode
            );
        }
        assert_eq!(
            patched(json!({ "showWhen": "always" })).show_when,
            ShowWhen::Always
        );
        assert_eq!(
            merge_patch(
                &custom(),
                &json!({ "showWhen": "playing", "displays": "primary" })
            ),
            Settings {
                show_when: ShowWhen::Playing,
                displays: Displays::Primary,
                ..custom()
            }
        );
        assert_eq!(patched(json!({ "glow": 12.5 })).glow, 12.5);
    }

    #[test]
    fn clamps_every_number_to_the_spec_range() {
        let high = patched(json!({
            "size": 500, "curve": 300, "yPos": 150, "glow": 101, "opacity": 120,
            "globalOffsetMs": 9999, "font": { "weight": 1000 }, "effects": 150
        }));
        assert_eq!(
            (high.size, high.curve, high.y_pos, high.glow, high.opacity),
            (140.0, 100.0, 100.0, 100.0, 100.0)
        );
        assert_eq!(
            (high.global_offset_ms, high.font.weight, high.effects),
            (2000.0, 900.0, 100.0)
        );
        let low = patched(json!({
            "size": 10, "curve": -300, "yPos": -1, "glow": -5, "opacity": 5,
            "globalOffsetMs": -9999, "font": { "weight": 50 }, "effects": -0.5
        }));
        assert_eq!(
            (low.size, low.curve, low.y_pos, low.glow, low.opacity),
            (22.0, -100.0, 0.0, 0.0, 20.0)
        );
        assert_eq!(
            (low.global_offset_ms, low.font.weight, low.effects),
            (-2000.0, 100.0, 0.0)
        );
        // The ends themselves are valid, and so is a fraction.
        let edges = patched(json!({ "size": 22, "opacity": 100, "curve": -100, "effects": 0 }));
        assert_eq!(
            (edges.size, edges.opacity, edges.curve, edges.effects),
            (22.0, 100.0, -100.0, 0.0)
        );
        assert_eq!(patched(json!({ "effects": 100 })).effects, 100.0);
        assert_eq!(patched(json!({ "effects": 62.5 })).effects, 62.5);
    }

    #[test]
    fn a_wrong_type_keeps_the_current_value_of_every_field() {
        let current = custom();
        for junk in [json!("50"), json!(null), json!([1]), json!({ "v": "x" })] {
            let patch = json!({
                "mode": junk, "autoColor": junk, "colors": junk, "font": junk, "size": junk,
                "curve": junk, "yPos": junk, "glow": junk, "opacity": junk, "showWhen": junk,
                "displays": junk, "globalOffsetMs": junk, "trackOffsetsMs": junk,
                "enabled": junk, "launchAtLogin": junk, "shortcuts": junk, "effects": junk,
                "effectsMode": junk
            });
            let next = merge_patch(&current, &patch);
            if junk.is_object() {
                // An object is the right type for the maps: colors, font and shortcuts change
                // nothing, and the offsets map is replaced by one whose only entry is dropped.
                assert_eq!(next.track_offsets_ms, BTreeMap::new());
                assert_eq!(
                    Settings {
                        track_offsets_ms: current.track_offsets_ms.clone(),
                        ..next
                    },
                    current
                );
            } else {
                assert_eq!(next, current, "patch with {junk}");
            }
        }
        // Numbers where a boolean or a string belongs, booleans where a number or a string does.
        let next = merge_patch(
            &current,
            &json!({ "autoColor": 1, "mode": 2, "font": { "family": 3, "weight": "700" }, "effectsMode": 0 }),
        );
        assert_eq!(next, current);
        let next = merge_patch(
            &current,
            &json!({ "size": true, "glow": false, "displays": true, "colors": { "dim": true } }),
        );
        assert_eq!(next, current);
        // Effects is a number: a string, a boolean or a level's name keeps the current value.
        for junk in [
            json!("50"),
            json!(true),
            json!("lively"),
            json!({ "level": 50 }),
        ] {
            assert_eq!(
                merge_patch(&current, &json!({ "effects": junk })).effects,
                80.0
            );
        }
        let next = merge_patch(
            &current,
            &json!({
                "enabled": 1, "launchAtLogin": "true",
                "shortcuts": {
                    "enabled": "yes", "toggleLyrics": 76, "nudgeEarlier": null,
                    "nudgeLater": ["Alt+L"]
                }
            }),
        );
        assert_eq!(next, current);
    }

    #[test]
    fn non_finite_numbers_are_invalid() {
        // serde_json can't hold NaN or infinity: they become null, which keeps the current value.
        for n in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(clamp_number(&Value::from(n), &SIZE), None);
            assert_eq!(
                merge_patch(
                    &custom(),
                    &json!({ "size": n, "trackOffsetsMs": { "x": n } })
                )
                .size,
                80.0
            );
            assert_eq!(
                merge_patch(&custom(), &json!({ "effects": n })).effects,
                80.0
            );
            assert_eq!(
                merge_patch(&custom(), &json!({ "trackOffsetsMs": { "x": n, "y": 5 } }))
                    .track_offsets_ms,
                BTreeMap::from([("y".to_owned(), 5.0)])
            );
        }
    }

    #[test]
    fn an_invalid_enum_value_keeps_the_current_one() {
        let current = custom();
        let next = merge_patch(
            &current,
            &json!({ "mode": "spiral", "showWhen": "sometimes", "displays": "left" }),
        );
        assert_eq!(next, current);
        // Wire values are exact: no other case, no Rust variant names.
        let next = merge_patch(&current, &json!({ "mode": "Arc", "displays": "All" }));
        assert_eq!(next, current);
    }

    #[test]
    fn colors_are_lowercased_and_an_invalid_one_keeps_the_current_one() {
        let current = custom();
        let next = merge_patch(
            &current,
            &json!({ "colors": { "lyric": "red", "highlight": "#ABCDEF", "dim": "#12345" } }),
        );
        assert_eq!(
            next.colors,
            Colors {
                highlight: "#abcdef".into(),
                ..current.colors.clone()
            }
        );
        for bad in [
            "#1234567",
            "123456",
            "#12345g",
            "#fff",
            " #123456",
            "#12345\u{e9}",
        ] {
            assert_eq!(hex_color(&json!(bad)), None, "{bad}");
        }
        assert_eq!(hex_color(&json!("#A0b1C2")).as_deref(), Some("#a0b1c2"));
    }

    #[test]
    fn a_partial_colors_object_changes_only_its_keys() {
        let current = custom();
        let next = merge_patch(
            &current,
            &json!({ "colors": { "dim": "#010203", "accent": "#ffffff" } }),
        );
        assert_eq!(
            next.colors,
            Colors {
                dim: "#010203".into(),
                ..current.colors.clone()
            }
        );
        assert_eq!(merge_patch(&current, &json!({ "colors": {} })), current);
    }

    #[test]
    fn font_family_must_be_a_non_blank_string_of_at_most_64_characters() {
        let current = custom();
        // Blank is Unicode White_Space (as `str::trim` and the mock's `\p{White_Space}` read it).
        for bad in [
            json!(""),
            json!("   "),
            json!("\u{85}\u{a0}\u{3000}\t"),
            json!("x".repeat(65)),
            json!(["Syne"]),
        ] {
            let next = merge_patch(&current, &json!({ "font": { "family": bad } }));
            assert_eq!(next.font, current.font, "{bad}");
        }
        assert_eq!(font_family(&json!("\u{feff}")).as_deref(), Some("\u{feff}"));
        // Characters, not bytes: 64 accented letters are 128 bytes.
        let long = "\u{e9}".repeat(64);
        assert_eq!(
            merge_patch(&current, &json!({ "font": { "family": long } })).font,
            Font {
                family: long.clone(),
                weight: 500.0
            }
        );
        // A partial font object changes only its keys.
        assert_eq!(
            merge_patch(&current, &json!({ "font": { "weight": 300 } })).font,
            Font {
                family: "Syne".into(),
                weight: 300.0
            }
        );
        assert_eq!(
            merge_patch(
                &current,
                &json!({ "font": { "family": "Fraunces", "style": "x" } })
            )
            .font,
            Font {
                family: "Fraunces".into(),
                weight: 500.0
            }
        );
    }

    #[test]
    fn unknown_keys_are_dropped() {
        let next = patched(json!({ "theme": "dark", "Size": 99, "lyricsHidden": true }));
        assert_eq!(next, defaults());
        let keys: Vec<String> = serde_json::to_value(next)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys.len(), 21);
        assert!(!keys.iter().any(|k| k == "theme"));
    }

    #[test]
    fn version_in_a_patch_is_ignored() {
        for version in [json!(7), json!(0), json!("1"), json!(null)] {
            let next = patched(json!({ "version": version, "size": 60 }));
            assert_eq!(next.version, SETTINGS_VERSION);
            assert_eq!(next.size, 60.0);
        }
    }

    #[test]
    fn a_patch_that_is_not_an_object_changes_nothing() {
        let current = custom();
        for patch in [
            json!(null),
            json!([{ "size": 30 }]),
            json!("size"),
            json!(30),
            json!(true),
        ] {
            assert_eq!(merge_patch(&current, &patch), current, "{patch}");
        }
        assert_eq!(merge_patch(&current, &json!({})), current);
    }

    #[test]
    fn the_merge_is_shallow_and_track_offsets_are_replaced_whole() {
        let current = custom();
        let next = merge_patch(
            &current,
            &json!({ "mode": "drift", "trackOffsetsMs": { "b": 50, "c": 0, "d": 5000, "e": "x", "f": -0.0 } }),
        );
        assert_eq!(next.mode, Mode::Drift);
        // Since contract v7 a 0 (or -0) is a song's own offset and stays.
        assert_eq!(
            next.track_offsets_ms,
            BTreeMap::from([
                ("b".to_owned(), 50.0),
                ("c".to_owned(), 0.0),
                ("d".to_owned(), 2000.0),
                ("f".to_owned(), 0.0)
            ])
        );
        assert!(next.track_offsets_ms["f"].is_sign_positive());
        assert_eq!(next.colors, current.colors);
        assert_eq!(
            merge_patch(&current, &json!({ "trackOffsetsMs": {} })).track_offsets_ms,
            BTreeMap::new()
        );
        // nudgedTracks: strings only, each once at its last place, the newest nine.
        let keys: Vec<String> = (0..12).map(|i| format!("k{i}")).collect();
        let mut sent = json!(keys);
        sent.as_array_mut()
            .unwrap()
            .extend([json!(5), json!("k10"), json!(null)]);
        let next = merge_patch(&current, &json!({ "nudgedTracks": sent }));
        assert_eq!(
            next.nudged_tracks,
            ["k3", "k4", "k5", "k6", "k7", "k8", "k9", "k11", "k10"]
        );
        assert_eq!(
            merge_patch(&next, &json!({ "nudgedTracks": "k1" })).nudged_tracks,
            next.nudged_tracks
        );
        assert!(merge_patch(&next, &json!({ "nudgedTracks": [] }))
            .nudged_tracks
            .is_empty());
    }

    #[test]
    fn the_whole_settings_object_is_a_valid_patch() {
        // The settings window's "Reset to defaults" sends everything but version, offsets, and
        // whether the lyrics are on and Undertone launches at login. Shortcuts are reset too.
        let mut reset = serde_json::to_value(defaults()).unwrap();
        let reset_fields = reset.as_object_mut().unwrap();
        for kept in [
            "version",
            "trackOffsetsMs",
            "nudgedTracks",
            "enabled",
            "launchAtLogin",
        ] {
            reset_fields.remove(kept);
        }
        assert_eq!(
            merge_patch(&custom(), &reset),
            Settings {
                track_offsets_ms: custom().track_offsets_ms,
                enabled: false,
                launch_at_login: true,
                ..defaults()
            }
        );
        let whole = serde_json::to_value(custom()).unwrap();
        assert_eq!(merge_patch(&defaults(), &whole), custom());
        assert_eq!(merge_patch(&custom(), &whole), custom());
    }

    #[test]
    fn track_offset_is_clamped_kept_at_zero_and_none_removes_it() {
        let current = custom();
        let next = with_track_offset(&current, "k", Some(50.0)).unwrap();
        assert_eq!(next.track_offsets_ms.get("k"), Some(&50.0));
        assert_eq!(next.track_offsets_ms.get("a|b|c|1"), Some(&-150.0));
        assert_eq!(next.nudged_tracks, ["k"]);
        let next = with_track_offset(&next, "k", Some(5000.0)).unwrap();
        assert_eq!(next.track_offsets_ms.get("k"), Some(&2000.0));
        let next = with_track_offset(&next, "k", Some(-9000.0)).unwrap();
        assert_eq!(next.track_offsets_ms.get("k"), Some(&-2000.0));
        // 0 is an offset of its own (the learned one may not be 0)
        let next = with_track_offset(&next, "k", Some(-0.0)).unwrap();
        assert_eq!(next.track_offsets_ms.get("k"), Some(&0.0));
        assert!(next.track_offsets_ms["k"].is_sign_positive());
        let next = with_track_offset(&next, "a|b|c|1", Some(10.0)).unwrap();
        assert_eq!(next.nudged_tracks, ["k", "a|b|c|1"]);
        // None: back to the learned offset, and out of the songs it is learned from
        let next = with_track_offset(&next, "k", None).unwrap();
        assert_eq!(next.track_offsets_ms.get("k"), None);
        assert_eq!(next.nudged_tracks, ["a|b|c|1"]);
        assert_eq!(with_track_offset(&next, "new", None).unwrap(), next);
        for ms in [f64::NAN, f64::INFINITY] {
            assert!(with_track_offset(&current, "k", Some(ms)).is_err());
        }
    }

    fn nudged(offsets: &[(&str, f64)]) -> Settings {
        let mut settings = defaults();
        for (key, ms) in offsets {
            settings = with_track_offset(&settings, key, Some(*ms)).unwrap();
        }
        settings
    }

    #[test]
    fn songs_without_their_own_offset_learn_it_from_the_last_nudged() {
        // One song is not enough: its lyrics may just be timed badly.
        assert_eq!(learned_offset_ms(&nudged(&[("a", 300.0)])), 0.0);
        // The middle of three; of two, the one nearer 0, or 0 when they are equally near.
        assert_eq!(
            learned_offset_ms(&nudged(&[("a", 100.0), ("b", 400.0), ("c", 150.0)])),
            150.0
        );
        assert_eq!(
            learned_offset_ms(&nudged(&[("a", 100.0), ("b", 400.0)])),
            100.0
        );
        assert_eq!(
            learned_offset_ms(&nudged(&[("a", -250.0), ("b", -100.0)])),
            -100.0
        );
        assert_eq!(
            learned_offset_ms(&nudged(&[("a", -100.0), ("b", 100.0)])),
            0.0
        );
        assert_eq!(
            learned_offset_ms(&nudged(&[("a", 50.0), ("b", 50.0)])),
            50.0
        );
        // Only the newest nine count, each once.
        let mut many: Vec<(String, f64)> = (0..9).map(|i| (format!("old{i}"), -500.0)).collect();
        many.extend((0..9).map(|i| (format!("new{i}"), 100.0)));
        let many: Vec<(&str, f64)> = many.iter().map(|(k, ms)| (k.as_str(), *ms)).collect();
        assert_eq!(learned_offset_ms(&nudged(&many)), 100.0);
        // A song with its own offset keeps it; the others start from the learned one.
        let settings = nudged(&[("a", 100.0), ("b", 200.0), ("c", 150.0)]);
        assert_eq!(song_offset_ms(&settings, "b"), 200.0);
        assert_eq!(song_offset_ms(&settings, "fresh"), 150.0);
        assert_eq!(own_offset_ms(&settings, "fresh"), None);
        // A song dropped from the nudged list (an offset set by a whole-map patch) still keeps its own.
        let mut patched = settings.clone();
        patched.nudged_tracks.clear();
        assert_eq!(song_offset_ms(&patched, "b"), 200.0);
        assert_eq!(song_offset_ms(&patched, "fresh"), 0.0);
    }

    #[test]
    fn only_show_when_displays_and_enabled_refresh_the_desktop_layer() {
        let current = custom();
        let drag = merge_patch(
            &current,
            &json!({
                "size": 30, "yPos": 10, "colors": { "dim": "#000000" }, "mode": "arc",
                "launchAtLogin": false, "shortcuts": { "enabled": true }
            }),
        );
        assert!(!affects_layer(&current, &drag));
        assert!(affects_layer(
            &current,
            &merge_patch(&current, &json!({ "enabled": true }))
        ));
        assert!(!affects_layer(
            &current,
            &with_track_offset(&current, "k", Some(50.0)).unwrap()
        ));
        assert!(affects_layer(
            &current,
            &merge_patch(&current, &json!({ "showWhen": "playing" }))
        ));
        assert!(affects_layer(
            &current,
            &merge_patch(&current, &json!({ "displays": "primary" }))
        ));
    }

    /// One song's offset plus one, as a tray nudge and a settings-window nudge both compute it.
    fn bump(current: &Settings) -> Result<Settings, String> {
        with_track_offset(current, "k", Some(song_offset_ms(current, "k") + 1.0))
    }

    #[test]
    fn concurrent_commits_lose_nothing_and_save_in_change_order() {
        let writer = Mutex::new(());
        let settings = Mutex::new(defaults());
        let saved = Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    for _ in 0..50 {
                        let committed = commit(&writer, &settings, bump, |next| {
                            saved.lock().unwrap().push(next.track_offsets_ms["k"]);
                        })
                        .unwrap();
                        assert!(matches!(
                            committed,
                            Committed::Changed { refresh: false, .. }
                        ));
                    }
                });
            }
        });
        assert_eq!(settings.lock().unwrap().track_offsets_ms["k"], 400.0);
        // Every change saved exactly once, each after the one it was made on top of.
        let expected: Vec<f64> = (1..=400).map(f64::from).collect();
        assert_eq!(*saved.lock().unwrap(), expected);
    }

    #[test]
    fn readers_do_not_wait_for_a_save_but_the_next_change_does() {
        let writer = Mutex::new(());
        let settings = Mutex::new(defaults());
        let (saving_tx, saving) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel::<()>();
        let (writer_ref, settings_ref) = (&writer, &settings);
        std::thread::scope(|scope| {
            scope.spawn(move || {
                let patch = json!({ "showWhen": "always" });
                let committed = commit(
                    writer_ref,
                    settings_ref,
                    |current| Ok(merge_patch(current, &patch)),
                    |_| {
                        saving_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                    },
                );
                assert!(matches!(
                    committed,
                    Ok(Committed::Changed { refresh: true, .. })
                ));
            });
            saving.recv().unwrap();
            // Mid-save: the new settings are readable, and another change has to wait its turn.
            assert_eq!(settings.try_lock().unwrap().show_when, ShowWhen::Always);
            assert!(writer.try_lock().is_err());
            release.send(()).unwrap();
        });
        assert!(writer.try_lock().is_ok());
    }

    #[test]
    fn a_commit_that_changes_nothing_or_fails_saves_nothing() {
        let writer = Mutex::new(());
        let settings = Mutex::new(custom());
        let unsaved = |_: &Settings| panic!("nothing to save");
        assert_eq!(
            commit(&writer, &settings, |s| Ok(s.clone()), unsaved),
            Ok(Committed::Unchanged(custom()))
        );
        assert_eq!(
            commit(
                &writer,
                &settings,
                |s| with_track_offset(s, "k", Some(f64::NAN)),
                unsaved
            ),
            Err("offset must be finite".into())
        );
        assert_eq!(*settings.lock().unwrap(), custom());
        // Neither left a lock held.
        assert!(writer.try_lock().is_ok());
    }

    #[test]
    fn migrate_turns_nothing_or_an_empty_object_into_the_defaults() {
        for stored in [json!({}), json!(null), json!("settings"), json!([1, 2])] {
            assert_eq!(migrate(&stored), defaults(), "{stored}");
        }
    }

    #[test]
    fn migrate_repairs_a_v1_blob_field_by_field() {
        let stored = json!({
            "version": 1, "mode": "stack", "autoColor": "yes",
            "colors": { "lyric": "#FFEEDD", "highlight": "orange" },
            "font": { "family": "", "weight": 950 },
            "size": "big", "curve": -500, "glow": null, "opacity": 55,
            "showWhen": "never", "displays": "all",
            "globalOffsetMs": 120.5,
            "trackOffsetsMs": { "x|y|z|200": 90, "zero": 0, "junk": "x", "far": -7000 },
            "legacyTheme": "night"
        });
        let expected = Settings {
            mode: Mode::Stack,
            colors: Colors {
                lyric: "#ffeedd".into(),
                ..defaults().colors
            },
            font: Font {
                weight: 900.0,
                ..defaults().font
            },
            curve: -100.0,
            opacity: 55.0,
            displays: Displays::All,
            global_offset_ms: 120.5,
            // A 0 is a song's own offset since contract v7.
            track_offsets_ms: BTreeMap::from([
                ("far".to_owned(), -2000.0),
                ("x|y|z|200".to_owned(), 90.0),
                ("zero".to_owned(), 0.0),
            ]),
            ..defaults()
        };
        assert_eq!(migrate(&stored), expected);
    }

    #[test]
    fn migrate_keeps_what_it_knows_from_an_older_or_newer_version() {
        // Written before `version` existed.
        let old = migrate(&json!({ "mode": "drift", "size": 40 }));
        assert_eq!(
            (old.mode, old.size, old.version),
            (Mode::Drift, 40.0, SETTINGS_VERSION)
        );
        // Written by a newer Undertone: new fields and values are dropped, the rest is kept.
        let future = migrate(&json!({
            "version": 3, "mode": "helix", "size": 70, "glow": 20,
            "colors": { "lyric": "#000000", "shadow": "#111111" },
            "showWhen": "always", "lockScreen": true
        }));
        assert_eq!(
            future,
            Settings {
                size: 70.0,
                glow: 20.0,
                colors: Colors {
                    lyric: "#000000".into(),
                    ..defaults().colors
                },
                show_when: ShowWhen::Always,
                ..defaults()
            }
        );
    }

    #[test]
    fn lyrics_on_and_launch_at_login_are_booleans() {
        let next = patched(json!({ "enabled": false, "launchAtLogin": true }));
        assert!(!next.enabled && next.launch_at_login);
        let back = merge_patch(&next, &json!({ "enabled": true, "launchAtLogin": false }));
        assert_eq!(back, defaults());
    }

    #[test]
    fn shortcut_bindings_are_stored_in_one_spelling() {
        let next = patched(json!({ "shortcuts": { "toggleLyrics": "shift+option+cmd+k" } }));
        assert_eq!(
            next.shortcuts,
            Shortcuts {
                toggle_lyrics: "Super+Alt+Shift+K".into(),
                ..defaults().shortcuts
            }
        );
        // "" is no shortcut.
        let next = patched(json!({ "shortcuts": { "nudgeEarlier": "" } }));
        assert_eq!(next.shortcuts.nudge_earlier, "");
        let next = patched(json!({ "shortcuts": { "enabled": false } }));
        assert_eq!(
            next.shortcuts,
            Shortcuts {
                enabled: false,
                ..defaults().shortcuts
            }
        );
        // A partial object changes only its keys; unknown keys are dropped.
        let next = merge_patch(
            &custom(),
            &json!({ "shortcuts": { "nudgeEarlier": "Alt+2", "openSettings": "Alt+S" } }),
        );
        assert_eq!(
            next.shortcuts,
            Shortcuts {
                nudge_earlier: "Alt+2".into(),
                ..custom().shortcuts
            }
        );
        assert_eq!(
            merge_patch(&custom(), &json!({ "shortcuts": {} })),
            custom()
        );
    }

    #[test]
    fn an_unusable_binding_keeps_the_current_one() {
        let current = custom();
        for bad in [
            "Shift+K",
            "K",
            "Alt+",
            "Alt+Escape",
            " ",
            "Ctrl+Control+K",
            "Alt + K",
        ] {
            let patch = json!({ "shortcuts": { "toggleLyrics": bad, "nudgeEarlier": bad } });
            assert_eq!(merge_patch(&current, &patch), current, "{bad:?}");
        }
    }

    #[test]
    fn a_binding_another_action_has_keeps_the_current_one() {
        let current = defaults();
        // The toggle's keys for a nudge, spelled another way.
        let patch = json!({ "shortcuts": { "nudgeLater": "alt+shift+cmdorctrl+l" } });
        assert_eq!(merge_patch(&current, &patch), current);
        // Two new bindings on the same keys: both keep their current ones.
        let patch = json!({ "shortcuts": { "toggleLyrics": "Alt+K", "nudgeEarlier": "Alt+K" } });
        assert_eq!(merge_patch(&current, &patch), current);
        // Any number of actions may have none.
        let patch =
            json!({ "shortcuts": { "toggleLyrics": "", "nudgeEarlier": "", "nudgeLater": "" } });
        assert_eq!(
            merge_patch(&current, &patch).shortcuts,
            shortcuts("", "", "")
        );
        // A binding freed by the same patch can be taken: a swap.
        let patch = json!({ "shortcuts": {
            "toggleLyrics": "CmdOrCtrl+Alt+Shift+]", "nudgeEarlier": "CmdOrCtrl+Alt+Shift+L"
        } });
        let swapped = merge_patch(&current, &patch);
        assert_eq!(
            swapped.shortcuts,
            shortcuts(
                "CmdOrCtrl+Alt+Shift+]",
                "CmdOrCtrl+Alt+Shift+L",
                "CmdOrCtrl+Alt+Shift+["
            )
        );
        // And back: Reset shortcuts sends the three defaults, whatever the current ones are.
        let reset = json!({ "shortcuts": serde_json::to_value(defaults().shortcuts).unwrap() });
        assert_eq!(merge_patch(&swapped, &reset), defaults());
    }

    #[test]
    fn rejecting_a_binding_also_rejects_a_new_one_that_now_clashes_with_it() {
        let current = defaults();
        // The toggle can't have the later nudge's [ and keeps its L, so the earlier nudge can't
        // have L either.
        let patch = json!({ "shortcuts": {
            "toggleLyrics": "CmdOrCtrl+Alt+Shift+[", "nudgeEarlier": "CmdOrCtrl+Alt+Shift+L"
        } });
        assert_eq!(merge_patch(&current, &patch), current);
    }

    #[test]
    fn no_patch_leaves_two_actions_on_one_accelerator_and_distinct_sets_always_apply() {
        let candidates = [
            "",
            "Alt+A",
            "alt+b",
            "CmdOrCtrl+Alt+Shift+L",
            "CmdOrCtrl+Alt+Shift+[",
        ];
        for current in [
            defaults(),
            custom(),
            patched(json!({ "shortcuts": {
            "toggleLyrics": "Alt+A", "nudgeEarlier": "Alt+B", "nudgeLater": ""
        } })),
        ] {
            for toggle in candidates {
                for earlier in candidates {
                    for later in candidates {
                        let patch = json!({ "shortcuts": {
                            "toggleLyrics": toggle, "nudgeEarlier": earlier, "nudgeLater": later
                        } });
                        let next = merge_patch(&current, &patch).shortcuts;
                        let bindings = ACTIONS.map(|action| next.binding(action).to_owned());
                        let bound: Vec<_> = bindings.iter().filter(|b| !b.is_empty()).collect();
                        let mut distinct = bound.clone();
                        distinct.sort();
                        distinct.dedup();
                        assert_eq!(distinct.len(), bound.len(), "{patch}: {next:?}");
                        let wanted = [toggle, earlier, later].map(|b| accelerator(b).unwrap());
                        let wanted_bound: Vec<_> =
                            wanted.iter().filter(|b| !b.is_empty()).collect();
                        let mut wanted_distinct = wanted_bound.clone();
                        wanted_distinct.sort();
                        wanted_distinct.dedup();
                        if wanted_distinct.len() == wanted_bound.len() {
                            assert_eq!(bindings, wanted, "{patch}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn stored_shortcuts_are_repaired_like_a_patch() {
        // The toggle would take the default earlier nudge's keys; Shift+X isn't usable.
        let stored = json!({ "shortcuts": {
            "enabled": "no", "toggleLyrics": "CmdOrCtrl+Alt+Shift+]", "nudgeLater": "Shift+X"
        } });
        assert_eq!(migrate(&stored).shortcuts, defaults().shortcuts);
        // A complete set of distinct bindings loads as saved.
        let stored = json!({ "shortcuts": {
            "enabled": true, "toggleLyrics": "CmdOrCtrl+Alt+Shift+]",
            "nudgeEarlier": "CmdOrCtrl+Alt+Shift+L", "nudgeLater": ""
        } });
        assert_eq!(
            migrate(&stored).shortcuts,
            shortcuts("CmdOrCtrl+Alt+Shift+]", "CmdOrCtrl+Alt+Shift+L", "")
        );
    }

    #[test]
    fn settings_saved_before_contract_v3_get_the_new_defaults_and_are_rewritten_once() {
        let mut saved = serde_json::to_value(custom()).unwrap();
        for added in ["enabled", "launchAtLogin", "shortcuts"] {
            saved.as_object_mut().unwrap().remove(added);
        }
        let (settings, rewrite) = load(Some(&saved));
        assert_eq!(
            settings,
            Settings {
                enabled: true,
                launch_at_login: false,
                shortcuts: defaults().shortcuts,
                ..custom()
            }
        );
        assert!(rewrite);
        let rewritten = serde_json::to_value(&settings).unwrap();
        assert_eq!(load(Some(&rewritten)), (settings, false));
    }

    #[test]
    fn settings_saved_before_contract_v4_get_effects_50_and_are_rewritten_once() {
        let mut saved = serde_json::to_value(custom()).unwrap();
        saved.as_object_mut().unwrap().remove("effects");
        let (settings, rewrite) = load(Some(&saved));
        assert_eq!(
            settings,
            Settings {
                effects: 50.0,
                ..custom()
            }
        );
        assert!(rewrite);
        let rewritten = serde_json::to_value(&settings).unwrap();
        assert_eq!(rewritten["effects"], json!(50.0));
        assert_eq!(load(Some(&rewritten)), (settings, false));
        // And Effects alone, from nothing: the default.
        assert_eq!(migrate(&json!({ "version": 1 })).effects, 50.0);
        assert_eq!(migrate(&json!({ "effects": 20 })).effects, 20.0);
    }

    #[test]
    fn settings_saved_before_contract_v8_start_with_effects_mode_off_and_are_rewritten_once() {
        // a file from 0.1.0 (contract v7): Effects mode on, its default then, and no karaokeMode
        let mut saved = serde_json::to_value(custom()).unwrap();
        saved.as_object_mut().unwrap().remove("karaokeMode");
        assert_eq!(saved["effectsMode"], json!(true));
        let (settings, rewrite) = load(Some(&saved));
        assert_eq!(
            settings,
            Settings {
                effects_mode: false,
                karaoke_mode: false,
                ..custom()
            }
        );
        assert!(rewrite);
        let rewritten = serde_json::to_value(&settings).unwrap();
        assert_eq!(rewritten["karaokeMode"], json!(false));
        assert_eq!(load(Some(&rewritten)), (settings.clone(), false));
        // once rewritten, turning Effects mode back on sticks
        let chosen = merge_patch(&settings, &json!({ "effectsMode": true }));
        let stored = serde_json::to_value(&chosen).unwrap();
        assert_eq!(load(Some(&stored)), (chosen, false));
        // a file from before contract v5 has no effectsMode at all: off too
        saved.as_object_mut().unwrap().remove("effectsMode");
        assert!(!load(Some(&saved)).0.effects_mode);
        assert!(!migrate(&json!({ "version": 1 })).effects_mode);
        assert!(migrate(&json!({ "effectsMode": true, "karaokeMode": false })).effects_mode);
    }

    #[test]
    fn the_login_item_is_adopted_only_when_known_and_different() {
        let mut settings = defaults();
        assert!(!adopt_login_item(&mut settings, None));
        assert!(!adopt_login_item(&mut settings, Some(false)));
        assert!(adopt_login_item(&mut settings, Some(true)));
        assert!(settings.launch_at_login);
        assert!(!adopt_login_item(&mut settings, None), "unknown keeps it");
        assert!(adopt_login_item(&mut settings, Some(false)));
        assert_eq!(settings, defaults());
    }

    #[test]
    fn startup_points_a_login_item_that_is_on_at_this_copy() {
        // A login item turned on before Undertone was moved starts nothing at login. `install`
        // adopts the item's state first, so only an item that is on is pointed here, and turns it
        // on again through the plugin only when `login_item::refresh` finds another copy.
        let source = include_str!("settings.rs").replace("\r\n", "\n"); // a Windows checkout has CRLF
        let body = |signature: &str| {
            let start = source
                .find(&format!("\n{signature} {{\n"))
                .expect(signature);
            &source[start..start + source[start..].find("\n    }\n").unwrap()]
        };
        let install = body("    pub fn install(app: &AppHandle) -> Result<bool, String>");
        let order = [
            "super::adopt_login_item(&mut settings, login_item(app));",
            "refresh_login_item(app, settings.launch_at_login);",
            "INSTALLED.store(true, Ordering::Release);",
        ]
        .map(|step| install.find(step).expect(step));
        assert!(order.windows(2).all(|pair| pair[0] < pair[1]), "{order:?}");
        let refresh = body("    fn refresh_login_item(app: &AppHandle, launch_at_login: bool)");
        let decided = refresh
            .find("crate::login_item::refresh(os, launch_at_login, stored.as_deref(), &here)")
            .expect("decided by login_item::refresh");
        let rewrite = refresh
            .find("crate::login_item::Refresh::Rewrite => {")
            .expect("a rewrite arm");
        let enable = refresh.find("launcher.enable()").expect("enabled again");
        assert!(decided < rewrite && rewrite < enable);
        assert_eq!(refresh.matches(".enable()").count(), 1);
    }

    /// The mock bridge's `mergeSettings` runs the same cases (`tests/accelerator.test.ts`).
    #[test]
    fn both_halves_merge_the_shared_shortcut_cases_alike() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/accelerators.json")).unwrap();
        let cases = fixture["merge"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let why = case["why"].as_str().unwrap();
            let current = Settings {
                shortcuts: serde_json::from_value(case["current"].clone()).unwrap(),
                ..defaults()
            };
            let expected: Shortcuts = serde_json::from_value(case["expected"].clone()).unwrap();
            let next = merge_patch(&current, &json!({ "shortcuts": case["patch"] }));
            assert_eq!(next.shortcuts, expected, "{why}");
        }
    }

    #[test]
    fn the_login_item_follows_a_change_or_keeps_its_value_when_the_os_refuses() {
        let current = defaults();
        let on = merge_patch(&current, &json!({ "launchAtLogin": true, "size": 80 }));
        // Turned on: the OS is asked once, for the new value.
        let mut asked = Vec::new();
        let (next, error) = with_login_item(&current, on.clone(), |enabled| {
            asked.push(enabled);
            Ok(())
        });
        assert_eq!((next, error, asked), (on.clone(), None, vec![true]));
        // Refused: launchAtLogin keeps its value, the rest of the change applies, the error returns.
        let (next, error) = with_login_item(&current, on, |_| Err("denied".into()));
        assert_eq!(
            next,
            Settings {
                size: 80.0,
                ..defaults()
            }
        );
        assert_eq!(error.as_deref(), Some("denied"));
        // Not part of the change: the OS isn't asked.
        let sized = merge_patch(&current, &json!({ "size": 80 }));
        let (next, error) = with_login_item(&current, sized.clone(), |_| {
            panic!("the login item didn't change")
        });
        assert_eq!((next, error), (sized, None));
    }

    #[test]
    fn a_refused_login_item_alone_changes_nothing_to_save() {
        // So the runtime broadcasts the settings itself, and a switch that moved goes back.
        let writer = Mutex::new(());
        let settings = Mutex::new(defaults());
        let mut refused = None;
        let committed = commit(
            &writer,
            &settings,
            |current| {
                let next = merge_patch(current, &json!({ "launchAtLogin": true }));
                let (next, error) = with_login_item(current, next, |_| Err("denied".into()));
                refused = error;
                Ok(next)
            },
            |_| panic!("nothing to save"),
        )
        .unwrap();
        assert_eq!(committed, Committed::Unchanged(defaults()));
        assert_eq!(refused.as_deref(), Some("denied"));
    }

    #[test]
    fn a_change_runs_without_the_settings_lock_and_says_what_to_redo() {
        let writer = Mutex::new(());
        let settings = Mutex::new(defaults());
        let committed = commit(
            &writer,
            &settings,
            |current| {
                // Readers aren't kept waiting while a change turns the login item on or off;
                // other changes are.
                assert!(settings.try_lock().is_ok());
                assert!(writer.try_lock().is_err());
                Ok(merge_patch(
                    current,
                    &json!({ "shortcuts": { "toggleLyrics": "Alt+K" } }),
                ))
            },
            |_| {},
        )
        .unwrap();
        assert!(matches!(
            committed,
            Committed::Changed {
                refresh: false,
                reregister: true,
                ..
            }
        ));
        let committed = commit(
            &writer,
            &settings,
            |current| {
                Ok(merge_patch(
                    current,
                    &json!({ "enabled": false, "launchAtLogin": true }),
                ))
            },
            |_| {},
        )
        .unwrap();
        assert!(matches!(
            committed,
            Committed::Changed {
                refresh: true,
                reregister: false,
                ..
            }
        ));
        assert_eq!(settings.lock().unwrap().shortcuts.toggle_lyrics, "Alt+K");
    }

    #[test]
    fn load_rewrites_the_file_only_when_migrating_changed_it() {
        assert_eq!(load(None), (defaults(), true));
        let saved = serde_json::to_value(custom()).unwrap();
        assert_eq!(load(Some(&saved)), (custom(), false));
        // The saved file survives a text round trip unchanged, so startup doesn't rewrite it.
        let reread: Value = serde_json::from_str(&saved.to_string()).unwrap();
        assert_eq!(load(Some(&reread)), (custom(), false));
        assert!(load(Some(&json!({ "size": 999 }))).1);
        let mut future = saved.clone();
        future["version"] = json!(2);
        assert_eq!(load(Some(&future)), (custom(), true));
        assert_eq!(load(Some(&json!("corrupt"))), (defaults(), true));
    }

    /// The bytes tauri-plugin-store's `save` wrote: its default serializer, `to_vec_pretty`, over
    /// its key map.
    fn store_bytes(settings: &Settings) -> Vec<u8> {
        let map = std::collections::HashMap::from([(
            "settings".to_owned(),
            serde_json::to_value(settings).unwrap(),
        )]);
        serde_json::to_vec_pretty(&map).unwrap()
    }
    /// Every file in `dir`, by name.
    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_file_the_store_wrote_loads_unchanged_and_is_written_back_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        fs::write(&path, store_bytes(&custom())).unwrap();
        assert_eq!(
            open(&path, 1),
            Opened {
                settings: custom(),
                rewrite: false,
                show_settings: false,
            }
        );
        assert_eq!(encode(&custom()).unwrap(), store_bytes(&custom()));
        write_file(&path, &custom()).unwrap();
        assert_eq!(fs::read(&path).unwrap(), store_bytes(&custom()));
    }

    #[test]
    fn the_first_launch_has_no_file_and_opens_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("com.undertone.desktop").join(FILE);
        assert_eq!(read_file(&path), Stored::Missing);
        assert_eq!(
            open(&path, 1),
            Opened {
                settings: defaults(),
                rewrite: true,
                show_settings: true,
            }
        );
        // The data dir doesn't exist yet either: saving creates it.
        write_file(&path, &defaults()).unwrap();
        assert_eq!(
            open(&path, 2),
            Opened {
                settings: defaults(),
                rewrite: false,
                show_settings: false,
            }
        );
    }

    #[test]
    fn a_save_replaces_the_whole_file_and_leaves_nothing_else_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        fs::write(&path, vec![b' '; 50_000]).unwrap();
        write_file(&path, &custom()).unwrap();
        assert_eq!(
            read_file(&path),
            Stored::Found(serde_json::to_value(custom()).unwrap())
        );
        write_file(&path, &defaults()).unwrap();
        assert_eq!(open(&path, 1).settings, defaults());
        assert_eq!(names(dir.path()), [FILE]);
        // A path that can't be a file fails without touching anything.
        assert!(write_file(dir.path(), &defaults()).is_err());
        assert_eq!(names(dir.path()), [FILE]);
    }

    #[test]
    fn an_unusable_file_is_moved_aside_before_the_defaults_replace_it() {
        assert_eq!(
            backup_path(Path::new("data").join(FILE).as_path(), 1_791_277_500),
            Path::new("data").join("settings.corrupt-1791277500.json")
        );
        let truncated = &store_bytes(&custom())[..120];
        for (bytes, why) in [
            (truncated.to_vec(), "not JSON: "),
            (Vec::new(), "not JSON: "),
            (br#"{"other": 1}"#.to_vec(), "no \"settings\" entry"),
            (
                vec![b' '; MAX_FILE_BYTES as usize + 1],
                "larger than 1024 KiB",
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(FILE);
            fs::write(&path, &bytes).unwrap();
            assert!(
                matches!(read_file(&path), Stored::Unusable(error) if error.starts_with(why)),
                "{why}"
            );
            // Settings opens, since the user's settings are gone, and the defaults are saved.
            assert_eq!(
                open(&path, 1_791_277_500),
                Opened {
                    settings: defaults(),
                    rewrite: true,
                    show_settings: true,
                },
                "{why}"
            );
            let backup = dir.path().join("settings.corrupt-1791277500.json");
            assert_eq!(fs::read(&backup).unwrap(), bytes, "{why}");
            assert!(!path.exists(), "{why}");
        }
    }
}
