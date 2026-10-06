//! X4 settings: validation, migration and persistence. The pure functions are portable and tested on
//! every OS; `runtime` stores settings with tauri-plugin-store and broadcasts `settings-changed`.
//!
//! Every field is validated on its own: unknown keys are dropped, numbers are clamped to the SPEC
//! ranges, and a value of the wrong type or outside an enum keeps the current one. The mock bridge
//! (`src/bridge/mock.ts`) implements the same rules for `pnpm dev`.
use crate::contract::{Colors, Font, Settings, CONTRACT_VERSION};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{collections::BTreeMap, ops::RangeInclusive};

pub const SIZE: RangeInclusive<f64> = 22.0..=140.0;
pub const CURVE: RangeInclusive<f64> = -100.0..=100.0;
pub const Y_POS: RangeInclusive<f64> = 0.0..=100.0;
pub const GLOW: RangeInclusive<f64> = 0.0..=100.0;
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

/// Per-song offsets: each entry clamped to ±2000 ms; zero, non-numeric and non-finite ones dropped.
pub fn track_offsets(value: &Value) -> Option<BTreeMap<String, f64>> {
    let entries = value.as_object()?;
    Some(
        entries
            .iter()
            .filter_map(|(key, ms)| Some((key.clone(), clamp_number(ms, &OFFSET_MS)?)))
            .filter(|(_, ms)| *ms != 0.0)
            .collect(),
    )
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

/// `update_settings`: a shallow top-level merge, validated field by field. Anything that isn't an
/// object changes nothing. `trackOffsetsMs` replaces the whole map (the settings window never
/// sends it; per-song changes go through `with_track_offset`).
pub fn merge_patch(current: &Settings, patch: &Value) -> Settings {
    let mut next = current.clone();
    next.version = CONTRACT_VERSION;
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
            // `version` is always CONTRACT_VERSION; anything else is unknown and dropped.
            _ => {}
        }
    }
    next
}

/// Turns stored settings of any shape (an older, newer or missing `version`, missing or invalid
/// fields, not even an object) into valid ones by the update rules, starting from the defaults.
/// Contract v1 has no renamed fields to carry over; a future version adds its steps here.
pub fn migrate(stored: &Value) -> Settings {
    merge_patch(&Settings::default(), stored)
}

/// What `runtime::install` does with the store's value: the settings to use, and whether the
/// file must be rewritten because migrating changed them (or there was nothing stored yet).
pub fn load(stored: Option<&Value>) -> (Settings, bool) {
    let settings = migrate(stored.unwrap_or(&Value::Null));
    let unchanged = stored.is_some_and(|stored| {
        serde_json::to_value(&settings).is_ok_and(|migrated| migrated == *stored)
    });
    (settings, !unchanged)
}

/// Whether a change concerns the desktop layer: how many overlays there are and when they show.
/// Everything else is drawn by the overlay webviews from `settings-changed`, and a layer refresh
/// re-attaches (hides and shows) every overlay, so a slider drag must not trigger one.
pub fn affects_layer(before: &Settings, after: &Settings) -> bool {
    before.show_when != after.show_when || before.displays != after.displays
}

/// Sets one song's sync offset, clamped to ±2000 ms. Zero removes the song from the map.
pub fn with_track_offset(current: &Settings, track_key: &str, ms: f64) -> Result<Settings, String> {
    if !ms.is_finite() {
        return Err("offset must be finite".into());
    }
    let mut next = current.clone();
    let ms = ms.clamp(*OFFSET_MS.start(), *OFFSET_MS.end());
    if ms == 0.0 {
        next.track_offsets_ms.remove(track_key);
    } else {
        next.track_offsets_ms.insert(track_key.to_owned(), ms);
    }
    Ok(next)
}

#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
pub mod runtime {
    use crate::{contract::Settings, contract::SETTINGS_CHANGED_EVENT, state::AppState};
    use std::sync::Arc;
    use tauri::{AppHandle, Emitter, Manager, Wry};
    use tauri_plugin_store::{Store, StoreExt};

    /// In the app data dir. Settings live under one key, so the file stays one readable object.
    const STORE_FILE: &str = "settings.json";
    const STORE_KEY: &str = "settings";

    /// The store, opened (and read from disk) on first use. Every change is saved right away, so
    /// there is no debounced auto-save task.
    fn store(app: &AppHandle) -> Result<Arc<Store<Wry>>, String> {
        app.store_builder(STORE_FILE)
            .disable_auto_save()
            .build()
            .map_err(|e| e.to_string())
    }

    /// Writes `settings` to disk. A failure is logged, not returned: the change still applies for
    /// this session, and the next successful save catches the file up.
    fn persist(app: &AppHandle, settings: &Settings) {
        let saved = store(app).and_then(|store| {
            store.set(
                STORE_KEY,
                serde_json::to_value(settings).map_err(|e| e.to_string())?,
            );
            store.save().map_err(|e| e.to_string())
        });
        if let Err(error) = saved {
            eprintln!("settings save failed: {error}");
        }
    }

    /// Loads stored settings into AppState before any window or service reads them, migrated to
    /// the current shape (and written back when that changed them). A missing or corrupt file
    /// starts from the defaults; an unusable store is logged and doesn't stop the app.
    pub fn install(app: &AppHandle) -> Result<(), String> {
        let stored = match store(app) {
            Ok(store) => {
                let stored = store.get(STORE_KEY);
                // The store ignores a file it can't read or parse; say so before it is overwritten.
                if stored.is_none()
                    && tauri_plugin_store::resolve_store_path(app, STORE_FILE)
                        .is_ok_and(|path| path.exists())
                {
                    eprintln!("settings file unreadable or without settings; using defaults");
                }
                stored
            }
            Err(error) => {
                eprintln!("settings store unavailable; using defaults: {error}");
                None
            }
        };
        let (settings, rewrite) = super::load(stored.as_ref());
        if rewrite {
            persist(app, &settings);
        }
        *app.state::<AppState>()
            .settings
            .lock()
            .map_err(|e| e.to_string())? = settings;
        Ok(())
    }

    /// Changes the settings under their lock, so a command and a tray click in quick succession
    /// can't lose each other's change or reach the disk out of order. Real changes are saved,
    /// broadcast to every webview and applied (overlay count, visibility); no-op when unchanged.
    /// The event goes out after the lock is released, so Rust listeners may call `current`.
    fn modify(
        app: &AppHandle,
        change: impl FnOnce(&Settings) -> Result<Settings, String>,
    ) -> Result<Settings, String> {
        let (next, refresh) = {
            let state = app.state::<AppState>();
            let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
            let next = change(&settings)?;
            if *settings == next {
                return Ok(next);
            }
            let refresh = super::affects_layer(&settings, &next);
            *settings = next.clone();
            persist(app, &next);
            (next, refresh)
        };
        if refresh {
            crate::desktop_layer::refresh_now();
        }
        // The change is stored and saved, so a failed broadcast is logged rather than reported as a
        // failed save; the windows catch up on the next change.
        if let Err(error) = app.emit(SETTINGS_CHANGED_EVENT, &next) {
            eprintln!("settings-changed broadcast failed: {error}");
        }
        Ok(next)
    }

    /// Stores whole settings built in Rust. They go through the same field rules as a patch, so an
    /// out-of-range or invalid value keeps the current one.
    pub fn apply(app: &AppHandle, next: Settings) -> Result<Settings, String> {
        let patch = serde_json::to_value(next).map_err(|e| e.to_string())?;
        modify(app, |current| Ok(super::merge_patch(current, &patch)))
    }

    pub fn current(app: &AppHandle) -> Result<Settings, String> {
        Ok(app
            .state::<AppState>()
            .settings
            .lock()
            .map_err(|e| e.to_string())?
            .clone())
    }

    pub fn update(app: &AppHandle, patch: &serde_json::Value) -> Result<Settings, String> {
        modify(app, |current| Ok(super::merge_patch(current, patch)))
    }

    pub fn set_track_offset(app: &AppHandle, track_key: &str, ms: f64) -> Result<Settings, String> {
        modify(app, |current| {
            super::with_track_offset(current, track_key, ms)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{Displays, Mode, ShowWhen};
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
            "trackOffsetsMs": { "a|b|c|1": -150 }
        }))
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
        assert_eq!(s.version, CONTRACT_VERSION);
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
            "globalOffsetMs": 9999, "font": { "weight": 1000 }
        }));
        assert_eq!(
            (high.size, high.curve, high.y_pos, high.glow, high.opacity),
            (140.0, 100.0, 100.0, 100.0, 100.0)
        );
        assert_eq!((high.global_offset_ms, high.font.weight), (2000.0, 900.0));
        let low = patched(json!({
            "size": 10, "curve": -300, "yPos": -1, "glow": -5, "opacity": 5,
            "globalOffsetMs": -9999, "font": { "weight": 50 }
        }));
        assert_eq!(
            (low.size, low.curve, low.y_pos, low.glow, low.opacity),
            (22.0, -100.0, 0.0, 0.0, 20.0)
        );
        assert_eq!((low.global_offset_ms, low.font.weight), (-2000.0, 100.0));
        // The ends themselves are valid.
        let edges = patched(json!({ "size": 22, "opacity": 100, "curve": -100 }));
        assert_eq!(
            (edges.size, edges.opacity, edges.curve),
            (22.0, 100.0, -100.0)
        );
    }

    #[test]
    fn a_wrong_type_keeps_the_current_value_of_every_field() {
        let current = custom();
        for junk in [json!("50"), json!(null), json!([1]), json!({ "v": "x" })] {
            let patch = json!({
                "mode": junk, "autoColor": junk, "colors": junk, "font": junk, "size": junk,
                "curve": junk, "yPos": junk, "glow": junk, "opacity": junk, "showWhen": junk,
                "displays": junk, "globalOffsetMs": junk, "trackOffsetsMs": junk
            });
            let next = merge_patch(&current, &patch);
            if junk.is_object() {
                // An object is the right type for the maps: colors and font change nothing, and
                // the offsets map is replaced by one whose only entry is dropped.
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
            &json!({ "autoColor": 1, "mode": 2, "font": { "family": 3, "weight": "700" } }),
        );
        assert_eq!(next, current);
        let next = merge_patch(
            &current,
            &json!({ "size": true, "glow": false, "displays": true, "colors": { "dim": true } }),
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
        assert_eq!(keys.len(), 14);
        assert!(!keys.iter().any(|k| k == "theme"));
    }

    #[test]
    fn version_in_a_patch_is_ignored() {
        for version in [json!(7), json!(0), json!("1"), json!(null)] {
            let next = patched(json!({ "version": version, "size": 60 }));
            assert_eq!(next.version, CONTRACT_VERSION);
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
        assert_eq!(
            next.track_offsets_ms,
            BTreeMap::from([("b".to_owned(), 50.0), ("d".to_owned(), 2000.0)])
        );
        assert_eq!(next.colors, current.colors);
        assert_eq!(
            merge_patch(&current, &json!({ "trackOffsetsMs": {} })).track_offsets_ms,
            BTreeMap::new()
        );
    }

    #[test]
    fn the_whole_settings_object_is_a_valid_patch() {
        // The settings window's "Reset to defaults" sends everything but version and offsets.
        let mut reset = serde_json::to_value(defaults()).unwrap();
        let reset_fields = reset.as_object_mut().unwrap();
        reset_fields.remove("version");
        reset_fields.remove("trackOffsetsMs");
        assert_eq!(
            merge_patch(&custom(), &reset),
            Settings {
                track_offsets_ms: custom().track_offsets_ms,
                ..defaults()
            }
        );
        let whole = serde_json::to_value(custom()).unwrap();
        assert_eq!(merge_patch(&defaults(), &whole), custom());
        assert_eq!(merge_patch(&custom(), &whole), custom());
    }

    #[test]
    fn track_offset_is_clamped_and_zero_removes_it() {
        let current = custom();
        let next = with_track_offset(&current, "k", 50.0).unwrap();
        assert_eq!(next.track_offsets_ms.get("k"), Some(&50.0));
        assert_eq!(next.track_offsets_ms.get("a|b|c|1"), Some(&-150.0));
        let next = with_track_offset(&next, "k", 5000.0).unwrap();
        assert_eq!(next.track_offsets_ms.get("k"), Some(&2000.0));
        let next = with_track_offset(&next, "k", -9000.0).unwrap();
        assert_eq!(next.track_offsets_ms.get("k"), Some(&-2000.0));
        let next = with_track_offset(&next, "k", 0.0).unwrap();
        assert_eq!(next.track_offsets_ms.get("k"), None);
        let next = with_track_offset(&next, "a|b|c|1", -0.0).unwrap();
        assert!(next.track_offsets_ms.is_empty());
        // Zero for a song without an offset is no change at all.
        assert_eq!(with_track_offset(&next, "new", 0.0).unwrap(), next);
        for ms in [f64::NAN, f64::INFINITY] {
            assert!(with_track_offset(&current, "k", ms).is_err());
        }
    }

    #[test]
    fn only_show_when_and_displays_refresh_the_desktop_layer() {
        let current = custom();
        let drag = merge_patch(
            &current,
            &json!({ "size": 30, "yPos": 10, "colors": { "dim": "#000000" }, "mode": "arc" }),
        );
        assert!(!affects_layer(&current, &drag));
        assert!(!affects_layer(
            &current,
            &with_track_offset(&current, "k", 50.0).unwrap()
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
            track_offsets_ms: BTreeMap::from([
                ("far".to_owned(), -2000.0),
                ("x|y|z|200".to_owned(), 90.0),
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
            (Mode::Drift, 40.0, CONTRACT_VERSION)
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
}
