use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const CONTRACT_VERSION: u8 = 8;
/// `Settings.version`. The settings schema is still v1: contract v2 only added `media-status`,
/// contracts v3, v4 and v5 only added fields, which stored settings without them get as defaults, and
/// v6 only stopped reading `yPos`.
pub const SETTINGS_VERSION: u8 = 1;
pub static DEFAULT_SETTINGS: std::sync::LazyLock<Settings> =
    std::sync::LazyLock::new(Settings::default);
pub const NOW_PLAYING_EVENT: &str = "now-playing";
pub const LYRICS_EVENT: &str = "lyrics";
pub const SETTINGS_CHANGED_EVENT: &str = "settings-changed";
pub const MEDIA_STATUS_EVENT: &str = "media-status";
pub const SHORTCUTS_STATUS_EVENT: &str = "shortcuts-status";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    Spotify,
    AppleMusic,
    System,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub source: Source,
    pub track_key: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: f64,
    pub position_ms: f64,
    pub sampled_at: f64,
    pub is_playing: bool,
    pub artwork: Option<String>,
}
/// Why nothing is reported: macOS Automation is off for a running player, or no supported player runs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum MediaProblem {
    AutomationDenied,
    NoPlayer,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatus {
    /// The player being reported, or the player with the problem; null when none.
    pub source: Option<Source>,
    pub problem: Option<MediaProblem>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum LyricsStatus {
    Loading,
    Found,
    PlainOnly,
    Instrumental,
    NotFound,
    Error,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LyricsSource {
    Lrclib,
    Cache,
    User,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    pub track_key: String,
    pub status: LyricsStatus,
    pub synced: Option<String>,
    pub plain: Option<String>,
    pub source: LyricsSource,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Arc,
    Lens,
    Drift,
    Stack,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ShowWhen {
    Playing,
    Always,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Displays {
    Primary,
    All,
}
/// A global shortcut's action. Added in contract v3.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ShortcutAction {
    ToggleLyrics,
    NudgeEarlier,
    NudgeLater,
}
/// Global keyboard shortcuts: accelerators such as "CmdOrCtrl+Alt+Shift+L"; "" leaves that action
/// without one. Added in contract v3.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Shortcuts {
    /// false turns every global shortcut off.
    pub enabled: bool,
    pub toggle_lyrics: String,
    /// +50 ms for the current song (lyrics earlier).
    pub nudge_earlier: String,
    /// −50 ms for the current song (lyrics later).
    pub nudge_later: String,
}
/// Whether a shortcut is working. Added in contract v3.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ShortcutState {
    /// Registered with the OS.
    Ok,
    /// Shortcuts are off, or the action has none.
    #[default]
    Off,
    /// Another app or the OS holds that key combination.
    Unavailable,
    /// Not a usable key combination.
    Invalid,
}
/// `Record<ShortcutAction, ShortcutState>`: one key per action. Added in contract v3.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutsStatus {
    pub toggle_lyrics: ShortcutState,
    pub nudge_earlier: ShortcutState,
    pub nudge_later: ShortcutState,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Colors {
    pub lyric: String,
    pub highlight: String,
    pub dim: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Font {
    pub family: String,
    pub weight: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub version: u8,
    /// Not read since v4: Undertone picks the style per song. Still validated and stored.
    pub mode: Mode,
    pub auto_color: bool,
    pub colors: Colors,
    /// Not read since v4: the face is picked per song. Still validated and stored.
    pub font: Font,
    pub size: f64,
    /// Not read since v4: Arc's curve is picked per song. Still validated and stored.
    pub curve: f64,
    /// Not read since v6: the lyrics always sit in the middle of the display's work area (without
    /// menu bar, Dock or taskbar). Still validated and stored, 0..100.
    pub y_pos: f64,
    /// 0..100. Scales the bloom the song's look asks for (0 subtle, 40 as picked, 100 strongest)
    /// and softens the dark shadow.
    pub glow: f64,
    pub opacity: f64,
    pub show_when: ShowWhen,
    pub displays: Displays,
    pub global_offset_ms: f64,
    /// Each nudged song's own offset on top of `global_offset_ms`, keyed by track key. Since v7, 0
    /// is an offset of its own; a song without an entry follows the learned offset
    /// (`settings::learned_offset_ms`).
    pub track_offsets_ms: BTreeMap<String, f64>,
    /// The songs whose sync was set most recently, oldest first, at most
    /// `settings::NUDGED_TRACKS_MAX`. Added in contract v7: settings saved without it read as none.
    #[serde(default)]
    pub nudged_tracks: Vec<String>,
    /// false hides the lyrics on every display (Settings, the tray and the toggle shortcut).
    /// Added in contract v3.
    pub enabled: bool,
    /// The OS login item follows it; at startup it adopts the login item's real state. Added in
    /// contract v3.
    pub launch_at_login: bool,
    /// Added in contract v3.
    pub shortcuts: Shortcuts,
    /// How much lyrics move as they're sung, 0..100; 50 is as picked for the song. Added in
    /// contract v4: settings saved without it read as 50.
    #[serde(default = "default_effects")]
    pub effects: f64,
    /// Text effects (called Effects mode before contract v8): each song's words move their own way;
    /// false keeps every song's words rising alike. Added in contract v5: settings saved without it
    /// read as true. Until contract v8 it also turned the pictures and splashes on and off.
    #[serde(default = "default_effects_mode")]
    pub effects_mode: bool,
    /// Graphics: words that name something take part in the line as a picture, and big moments
    /// splash. Added in contract v8: settings saved without it read as true (`settings::migrate`
    /// carries over an Effects mode that was off).
    #[serde(default = "default_graphics")]
    pub graphics: bool,
}
/// `Settings.effects` when it is missing (settings saved before contract v4).
fn default_effects() -> f64 {
    50.0
}
/// `Settings.effectsMode` when it is missing (settings saved before contract v5).
fn default_effects_mode() -> bool {
    true
}
/// `Settings.graphics` when it is missing (settings saved before contract v8).
fn default_graphics() -> bool {
    true
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            mode: Mode::Arc,
            auto_color: true,
            colors: Colors {
                lyric: "#f1ece3".into(),
                highlight: "#f2a65a".into(),
                dim: "#8d93a0".into(),
            },
            font: Font {
                family: "Fraunces".into(),
                weight: 700.0,
            },
            size: 58.0,
            curve: 38.0,
            y_pos: 46.0,
            glow: 40.0,
            opacity: 100.0,
            show_when: ShowWhen::Playing,
            displays: Displays::Primary,
            global_offset_ms: 0.0,
            track_offsets_ms: BTreeMap::new(),
            nudged_tracks: Vec::new(),
            enabled: true,
            launch_at_login: false,
            // Why every default includes Shift: `crate::shortcuts`.
            shortcuts: Shortcuts {
                enabled: true,
                toggle_lyrics: "CmdOrCtrl+Alt+Shift+L".into(),
                nudge_earlier: "CmdOrCtrl+Alt+Shift+]".into(),
                nudge_later: "CmdOrCtrl+Alt+Shift+[".into(),
            },
            effects: default_effects(),
            effects_mode: default_effects_mode(),
            graphics: default_graphics(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::{json, Value};
    use std::fmt::Debug;

    /// The TypeScript side of the contract, read at compile time so the two can't drift apart.
    const CONTRACT_TS: &str = include_str!("../../contract/contract.ts");

    /// The type declarations of contract.ts, without the `DEFAULT_SETTINGS` value below them.
    fn ts_types() -> &'static str {
        CONTRACT_TS
            .split("export const DEFAULT_SETTINGS")
            .next()
            .unwrap()
    }

    /// The quoted strings of the union that follows `anchors` (each found after the previous one),
    /// up to its `;`, sorted.
    fn ts_union(anchors: &[&str]) -> Vec<String> {
        let mut rest = ts_types();
        for anchor in anchors {
            let at = rest
                .find(anchor)
                .unwrap_or_else(|| panic!("{anchor:?} not in contract.ts"));
            rest = &rest[at + anchor.len()..];
        }
        let union = &rest[..rest.find(';').unwrap()];
        let mut values: Vec<String> = union
            .split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_owned)
            .collect();
        values.sort();
        values
    }

    /// The field names of `export interface <name>`, sorted. Nested objects (`colors`, `font`)
    /// are written on one line, so only their own key is a field here.
    fn ts_fields(name: &str) -> Vec<String> {
        let start = format!("export interface {name} {{");
        let body = &ts_types()[ts_types().find(&start).unwrap() + start.len()..];
        let body = &body[..body.find("\n}").unwrap()];
        let field = regex::Regex::new(r"(?m)^\s*(\w+):").unwrap();
        let mut fields: Vec<String> = field.captures_iter(body).map(|c| c[1].to_owned()).collect();
        fields.sort();
        fields
    }

    fn json_keys(value: &Value) -> Vec<String> {
        let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    }

    /// Every variant serializes to its wire string and reads back from it, and the wire strings
    /// are exactly the union contract.ts declares (none missing on either side).
    fn assert_wire<T>(variants: &[T], wire: fn(&T) -> &'static str, ts: &[&str])
    where
        T: Serialize + DeserializeOwned + PartialEq + Debug,
    {
        for variant in variants {
            let text = wire(variant);
            assert_eq!(serde_json::to_value(variant).unwrap(), json!(text));
            assert_eq!(
                &serde_json::from_value::<T>(json!(text)).unwrap(),
                variant,
                "{text}"
            );
        }
        let mut ours: Vec<String> = variants.iter().map(|v| wire(v).to_owned()).collect();
        ours.sort();
        assert_eq!(ours, ts_union(ts), "{ts:?}");
    }

    // The `wire` matches have no wildcard: a new variant doesn't compile until it is listed.
    #[test]
    fn every_enum_variant_has_the_wire_string_contract_ts_declares() {
        assert_wire(
            &[Source::Spotify, Source::AppleMusic, Source::System],
            |v| match v {
                Source::Spotify => "spotify",
                Source::AppleMusic => "apple-music",
                Source::System => "system",
            },
            &["export type Source ="],
        );
        assert_wire(
            &[MediaProblem::AutomationDenied, MediaProblem::NoPlayer],
            |v| match v {
                MediaProblem::AutomationDenied => "automation-denied",
                MediaProblem::NoPlayer => "no-player",
            },
            &["export type MediaProblem ="],
        );
        assert_wire(
            &[
                LyricsStatus::Loading,
                LyricsStatus::Found,
                LyricsStatus::PlainOnly,
                LyricsStatus::Instrumental,
                LyricsStatus::NotFound,
                LyricsStatus::Error,
            ],
            |v| match v {
                LyricsStatus::Loading => "loading",
                LyricsStatus::Found => "found",
                LyricsStatus::PlainOnly => "plain-only",
                LyricsStatus::Instrumental => "instrumental",
                LyricsStatus::NotFound => "not-found",
                LyricsStatus::Error => "error",
            },
            &["export type LyricsStatus ="],
        );
        assert_wire(
            &[
                LyricsSource::Lrclib,
                LyricsSource::Cache,
                LyricsSource::User,
            ],
            |v| match v {
                LyricsSource::Lrclib => "lrclib",
                LyricsSource::Cache => "cache",
                LyricsSource::User => "user",
            },
            &["export interface Lyrics {", "source:"],
        );
        assert_wire(
            &[Mode::Arc, Mode::Lens, Mode::Drift, Mode::Stack],
            |v| match v {
                Mode::Arc => "arc",
                Mode::Lens => "lens",
                Mode::Drift => "drift",
                Mode::Stack => "stack",
            },
            &["export type Mode ="],
        );
        assert_wire(
            &[ShowWhen::Playing, ShowWhen::Always],
            |v| match v {
                ShowWhen::Playing => "playing",
                ShowWhen::Always => "always",
            },
            &["export interface Settings {", "showWhen:"],
        );
        assert_wire(
            &[Displays::Primary, Displays::All],
            |v| match v {
                Displays::Primary => "primary",
                Displays::All => "all",
            },
            &["export interface Settings {", "displays:"],
        );
        assert_wire(
            &[
                ShortcutAction::ToggleLyrics,
                ShortcutAction::NudgeEarlier,
                ShortcutAction::NudgeLater,
            ],
            |v| match v {
                ShortcutAction::ToggleLyrics => "toggleLyrics",
                ShortcutAction::NudgeEarlier => "nudgeEarlier",
                ShortcutAction::NudgeLater => "nudgeLater",
            },
            &["export type ShortcutAction ="],
        );
        assert_wire(
            &[
                ShortcutState::Ok,
                ShortcutState::Off,
                ShortcutState::Unavailable,
                ShortcutState::Invalid,
            ],
            |v| match v {
                ShortcutState::Ok => "ok",
                ShortcutState::Off => "off",
                ShortcutState::Unavailable => "unavailable",
                ShortcutState::Invalid => "invalid",
            },
            &["export type ShortcutState ="],
        );
        // Wire strings are exact: no Rust variant names, no other case.
        assert!(serde_json::from_value::<Source>(json!("AppleMusic")).is_err());
        assert!(serde_json::from_value::<LyricsStatus>(json!("Plain-Only")).is_err());
    }

    #[test]
    fn now_playing_json_shape_matches_with_and_without_artwork() {
        let mut track = NowPlaying {
            source: Source::Spotify,
            track_key: "demo artist|paper lantern|demo album|180".into(),
            title: "Paper Lantern".into(),
            artist: "Demo Artist".into(),
            album: "Demo Album".into(),
            duration_ms: 180_000.0,
            position_ms: 12_345.5,
            sampled_at: 1_700_000_000_000.0,
            is_playing: true,
            artwork: None,
        };
        let without = json!({
            "source": "spotify", "trackKey": "demo artist|paper lantern|demo album|180",
            "title": "Paper Lantern", "artist": "Demo Artist", "album": "Demo Album",
            "durationMs": 180_000.0, "positionMs": 12_345.5, "sampledAt": 1_700_000_000_000.0,
            "isPlaying": true, "artwork": null
        });
        assert_eq!(serde_json::to_value(&track).unwrap(), without);
        assert_eq!(
            serde_json::from_value::<NowPlaying>(without.clone()).unwrap(),
            track
        );
        assert_eq!(json_keys(&without), ts_fields("NowPlaying"));

        track.source = Source::AppleMusic;
        track.is_playing = false;
        track.artwork = Some("data:image/png;base64,iVBORw0KGgo=".into());
        let with = json!({
            "source": "apple-music", "trackKey": "demo artist|paper lantern|demo album|180",
            "title": "Paper Lantern", "artist": "Demo Artist", "album": "Demo Album",
            "durationMs": 180_000.0, "positionMs": 12_345.5, "sampledAt": 1_700_000_000_000.0,
            "isPlaying": false, "artwork": "data:image/png;base64,iVBORw0KGgo="
        });
        assert_eq!(serde_json::to_value(&track).unwrap(), with);
        assert_eq!(serde_json::from_value::<NowPlaying>(with).unwrap(), track);
        // `get_now_playing` and the `now-playing` event send null when nothing plays.
        assert_eq!(
            serde_json::to_value(None::<NowPlaying>).unwrap(),
            Value::Null
        );
    }

    #[test]
    fn every_payload_has_exactly_the_fields_contract_ts_declares() {
        let lyrics = Lyrics {
            track_key: "k".into(),
            status: LyricsStatus::Found,
            synced: Some("[00:01.00]placeholder".into()),
            plain: None,
            source: LyricsSource::Cache,
        };
        for (name, value) in [
            ("Lyrics", serde_json::to_value(lyrics).unwrap()),
            (
                "MediaStatus",
                serde_json::to_value(MediaStatus::default()).unwrap(),
            ),
            (
                "Settings",
                serde_json::to_value(&*DEFAULT_SETTINGS).unwrap(),
            ),
            (
                "Shortcuts",
                serde_json::to_value(&DEFAULT_SETTINGS.shortcuts).unwrap(),
            ),
        ] {
            assert_eq!(json_keys(&value), ts_fields(name), "{name}");
        }
        // `Record<ShortcutAction, ShortcutState>`: exactly one key per action.
        assert_eq!(
            json_keys(&serde_json::to_value(ShortcutsStatus::default()).unwrap()),
            ts_union(&["export type ShortcutAction ="])
        );
        let settings = serde_json::to_value(&*DEFAULT_SETTINGS).unwrap();
        // The default bindings are the ones contract.ts's DEFAULT_SETTINGS spells out.
        for action in ["toggleLyrics", "nudgeEarlier", "nudgeLater"] {
            let binding = settings["shortcuts"][action].as_str().unwrap();
            assert!(
                CONTRACT_TS.contains(&format!("{action}: \"{binding}\"")),
                "{action}: {binding}"
            );
        }
        assert_eq!(
            json_keys(&settings["colors"]),
            ["dim", "highlight", "lyric"]
        );
        assert_eq!(json_keys(&settings["font"]), ["family", "weight"]);
    }

    #[test]
    fn default_settings_json_keys_and_values_match_contract() {
        assert_eq!(
            serde_json::to_value(&*DEFAULT_SETTINGS).unwrap(),
            json!({
                "version": 1, "mode": "arc", "autoColor": true,
                "colors": { "lyric": "#f1ece3", "highlight": "#f2a65a", "dim": "#8d93a0" },
                "font": { "family": "Fraunces", "weight": 700.0 },
                "size": 58.0, "curve": 38.0, "yPos": 46.0, "glow": 40.0, "opacity": 100.0,
                "showWhen": "playing", "displays": "primary", "globalOffsetMs": 0.0, "trackOffsetsMs": {},
                "nudgedTracks": [],
                "enabled": true, "launchAtLogin": false,
                "shortcuts": {
                    "enabled": true,
                    "toggleLyrics": "CmdOrCtrl+Alt+Shift+L",
                    "nudgeEarlier": "CmdOrCtrl+Alt+Shift+]",
                    "nudgeLater": "CmdOrCtrl+Alt+Shift+["
                },
                "effects": 50.0,
                "effectsMode": true,
                "graphics": true
            })
        );
        // contract.ts's DEFAULT_SETTINGS spells out the same Effects level, Text effects and Graphics.
        assert!(CONTRACT_TS.contains(&format!("effects: {},", DEFAULT_SETTINGS.effects)));
        assert!(CONTRACT_TS.contains(&format!("effectsMode: {},", DEFAULT_SETTINGS.effects_mode)));
        assert!(CONTRACT_TS.contains(&format!("graphics: {},", DEFAULT_SETTINGS.graphics)));
    }
    #[test]
    fn settings_saved_before_contract_v8_read_as_graphics_on() {
        let mut saved = serde_json::to_value(&*DEFAULT_SETTINGS).unwrap();
        saved["graphics"] = json!(false);
        assert!(
            !serde_json::from_value::<Settings>(saved.clone())
                .unwrap()
                .graphics
        );
        saved.as_object_mut().unwrap().remove("graphics");
        let v7: Settings = serde_json::from_value(saved).unwrap();
        assert_eq!(v7, *DEFAULT_SETTINGS);
        assert!(v7.graphics);
    }
    #[test]
    fn settings_saved_before_contract_v7_have_no_nudged_tracks() {
        let mut saved = serde_json::to_value(&*DEFAULT_SETTINGS).unwrap();
        saved.as_object_mut().unwrap().remove("nudgedTracks");
        saved["trackOffsetsMs"] = json!({ "a|b|c|1": 100.0 });
        let read = serde_json::from_value::<Settings>(saved).unwrap();
        assert!(read.nudged_tracks.is_empty());
        assert_eq!(read.track_offsets_ms["a|b|c|1"], 100.0);
        assert!(CONTRACT_TS.contains("nudgedTracks: [],"));
    }
    #[test]
    fn settings_saved_before_contract_v5_read_as_effects_mode_on() {
        let mut saved = serde_json::to_value(&*DEFAULT_SETTINGS).unwrap();
        saved["effectsMode"] = json!(false);
        assert!(
            !serde_json::from_value::<Settings>(saved.clone())
                .unwrap()
                .effects_mode
        );
        saved.as_object_mut().unwrap().remove("effectsMode");
        let v4: Settings = serde_json::from_value(saved).unwrap();
        assert_eq!(v4, *DEFAULT_SETTINGS);
        assert!(v4.effects_mode);
    }
    #[test]
    fn settings_saved_before_contract_v4_read_as_effects_50() {
        let mut saved = serde_json::to_value(&*DEFAULT_SETTINGS).unwrap();
        saved["effects"] = json!(80.0);
        assert_eq!(
            serde_json::from_value::<Settings>(saved.clone())
                .unwrap()
                .effects,
            80.0
        );
        saved.as_object_mut().unwrap().remove("effects");
        let v3: Settings = serde_json::from_value(saved).unwrap();
        assert_eq!(v3, *DEFAULT_SETTINGS);
        assert_eq!(v3.effects, 50.0);
    }
    #[test]
    fn event_wire_names_and_nullable_fields_match() {
        let lyrics = Lyrics {
            track_key: "demo".into(),
            status: LyricsStatus::PlainOnly,
            synced: None,
            plain: None,
            source: LyricsSource::Lrclib,
        };
        assert_eq!(
            serde_json::to_value(lyrics).unwrap(),
            json!({
                "trackKey": "demo", "status": "plain-only", "synced": null,
                "plain": null, "source": "lrclib"
            })
        );
        assert_eq!(
            serde_json::to_value(Source::AppleMusic).unwrap(),
            "apple-music"
        );
    }
    #[test]
    fn media_status_json_shape_matches() {
        assert_eq!(MEDIA_STATUS_EVENT, "media-status");
        assert_eq!(
            serde_json::to_value(MediaStatus::default()).unwrap(),
            json!({ "source": null, "problem": null })
        );
        let denied = MediaStatus {
            source: Some(Source::AppleMusic),
            problem: Some(MediaProblem::AutomationDenied),
        };
        assert_eq!(
            serde_json::to_value(&denied).unwrap(),
            json!({ "source": "apple-music", "problem": "automation-denied" })
        );
        let none = MediaStatus {
            source: None,
            problem: Some(MediaProblem::NoPlayer),
        };
        assert_eq!(
            serde_json::to_value(&none).unwrap(),
            json!({ "source": null, "problem": "no-player" })
        );
        let parsed: MediaStatus =
            serde_json::from_value(json!({ "source": "spotify", "problem": null })).unwrap();
        assert_eq!(
            parsed,
            MediaStatus {
                source: Some(Source::Spotify),
                problem: None,
            }
        );
    }
    #[test]
    fn shortcuts_status_json_shape_matches() {
        assert_eq!(SHORTCUTS_STATUS_EVENT, "shortcuts-status");
        // Nothing registered yet: every action off.
        assert_eq!(
            serde_json::to_value(ShortcutsStatus::default()).unwrap(),
            json!({ "toggleLyrics": "off", "nudgeEarlier": "off", "nudgeLater": "off" })
        );
        let mixed = ShortcutsStatus {
            toggle_lyrics: ShortcutState::Ok,
            nudge_earlier: ShortcutState::Unavailable,
            nudge_later: ShortcutState::Invalid,
        };
        let wire = json!({
            "toggleLyrics": "ok", "nudgeEarlier": "unavailable", "nudgeLater": "invalid"
        });
        assert_eq!(serde_json::to_value(&mixed).unwrap(), wire);
        assert_eq!(
            serde_json::from_value::<ShortcutsStatus>(wire).unwrap(),
            mixed
        );
    }
    #[test]
    fn contract_v4_keeps_the_v1_settings_schema() {
        assert_eq!(CONTRACT_VERSION, 8);
        assert!(
            CONTRACT_TS.contains(&format!(
                "export const CONTRACT_VERSION = {CONTRACT_VERSION};"
            )),
            "contract.ts declares another version"
        );
        assert_eq!(SETTINGS_VERSION, 1);
        assert_eq!(DEFAULT_SETTINGS.version, 1);
    }

    /// The frontend's command and event map, read at compile time like contract.ts. A renamed
    /// command, argument or event still compiles on both sides; it fails only at runtime, as a
    /// rejected call or an event nobody hears.
    const BRIDGE_TS: &str = include_str!("../../src/bridge/types.ts");

    /// The body of `export interface <name>` in types.ts, one member per line.
    fn bridge_interface(name: &str) -> &'static str {
        let start = format!("export interface {name} {{");
        let body = &BRIDGE_TS[BRIDGE_TS.find(&start).unwrap() + start.len()..];
        &body[..body.find("\n}").unwrap()]
    }

    /// The members of a types.ts interface, so a pattern that misses one can't pass unnoticed.
    fn member_count(body: &str) -> usize {
        let member = regex::Regex::new(r#"(?m)^\s*"?[\w-]+"?:"#).unwrap();
        member.find_iter(body).count()
    }

    /// `trackKey` from `track_key`: Tauri's default for command arguments on the wire.
    fn camel(snake: &str) -> String {
        let mut parts = snake.split('_');
        let first = parts.next().unwrap_or_default().to_owned();
        parts.fold(first, |mut out, part| {
            let mut chars = part.chars();
            if let Some(c) = chars.next() {
                out.extend(c.to_uppercase());
                out.push_str(chars.as_str());
            }
            out
        })
    }

    /// Splits a parameter list on the commas outside `<…>` (`State<'_, AppState>` has one).
    fn parameters(list: &str) -> Vec<&str> {
        let (mut depth, mut start, mut out) = (0, 0, Vec::new());
        for (i, c) in list.char_indices() {
            match c {
                '<' => depth += 1,
                '>' => depth -= 1,
                ',' if depth == 0 => {
                    out.push(list[start..i].trim());
                    start = i + 1;
                }
                _ => {}
            }
        }
        out.push(list[start..].trim());
        out.retain(|p| !p.is_empty());
        out
    }

    #[test]
    fn every_command_and_argument_name_matches_the_frontend() {
        // TypeScript: `name: { args: NoArgs | { a: A; b: B }; result: … }`.
        let body = bridge_interface("Commands");
        let entry =
            regex::Regex::new(r"(?m)^\s*(\w+): \{ args: (?:NoArgs|\{([^}]*)\}); result:").unwrap();
        let mut ts = BTreeMap::new();
        for c in entry.captures_iter(body) {
            let args = c.get(2).map_or("", |m| m.as_str());
            let mut keys: Vec<String> = args
                .split(';')
                .filter_map(|arg| arg.split_once(':'))
                .map(|(key, _)| key.trim().to_owned())
                .collect();
            keys.sort();
            ts.insert(c[1].to_owned(), keys);
        }
        assert_eq!(
            ts.len(),
            member_count(body),
            "a command types.ts writes another way"
        );

        // Rust: every `#[tauri::command]` in commands.rs and the arguments the page passes,
        // without the ones Tauri fills in itself (the app, managed state, the calling webview).
        let commands = include_str!("commands.rs");
        let command = regex::Regex::new(
            r"(?ms)^#\[tauri::command(\([^)]*\))?\]\s*pub (?:async )?fn (\w+)\((.*?)\)\s*(?:->|\{)",
        )
        .unwrap();
        let attribute = regex::Regex::new(r"(?m)^#\[tauri::command").unwrap();
        let injected = regex::Regex::new(r"^(tauri::)?(AppHandle|State<|Webview|Window)").unwrap();
        let mut rust = BTreeMap::new();
        for c in command.captures_iter(commands) {
            // Arguments are camelCase only while no command renames them.
            assert!(!c.get(1).is_some_and(|m| m.as_str().contains("rename_all")));
            let mut keys: Vec<String> = parameters(&c[3])
                .into_iter()
                .filter_map(|p| p.split_once(':'))
                .filter(|(_, ty)| !injected.is_match(ty.trim()))
                .map(|(name, _)| camel(name.trim()))
                .collect();
            keys.sort();
            rust.insert(c[2].to_owned(), keys);
        }
        assert_eq!(
            attribute.find_iter(commands).count(),
            rust.len(),
            "a command commands.rs writes another way"
        );

        // Registered with Tauri: the list in lib.rs.
        let lib = include_str!("lib.rs");
        let start = lib.find("generate_handler![").unwrap();
        let list = &lib[start..start + lib[start..].find(']').unwrap()];
        let mut registered: Vec<String> = regex::Regex::new(r"commands::(\w+)")
            .unwrap()
            .captures_iter(list)
            .map(|c| c[1].to_owned())
            .collect();
        registered.sort();
        let defined: Vec<String> = rust.keys().cloned().collect();
        assert_eq!(
            registered, defined,
            "commands.rs and generate_handler! disagree"
        );

        // `debug_probe` is debug-only: lib.rs's `--overlay-probe` script calls it, not the bridge.
        assert_eq!(rust.remove("debug_probe"), Some(vec!["message".to_owned()]));
        assert!(lib.contains("invoke('debug_probe',{message:"));
        assert_eq!(rust, ts);
    }

    #[test]
    fn every_event_name_matches_the_frontend() {
        use std::collections::BTreeSet;
        let body = bridge_interface("Events");
        let key = regex::Regex::new(r#"(?m)^\s*"?([\w-]+)"?:"#).unwrap();
        let ts: BTreeSet<String> = key.captures_iter(body).map(|c| c[1].to_owned()).collect();
        // Every `*_EVENT` constant at the top of this file.
        let constant = regex::Regex::new(r#"pub const \w+_EVENT: &str = "([^"]+)";"#).unwrap();
        let rust: BTreeSet<String> = constant
            .captures_iter(include_str!("contract.rs"))
            .map(|c| c[1].to_owned())
            .collect();
        assert_eq!(rust, ts);
    }
}
