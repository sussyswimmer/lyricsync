use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const CONTRACT_VERSION: u8 = 2;
/// `Settings.version`. The settings schema is still v1: contract v2 only added `media-status`.
pub const SETTINGS_VERSION: u8 = 1;
pub static DEFAULT_SETTINGS: std::sync::LazyLock<Settings> =
    std::sync::LazyLock::new(Settings::default);
pub const NOW_PLAYING_EVENT: &str = "now-playing";
pub const LYRICS_EVENT: &str = "lyrics";
pub const SETTINGS_CHANGED_EVENT: &str = "settings-changed";
pub const MEDIA_STATUS_EVENT: &str = "media-status";

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
    pub mode: Mode,
    pub auto_color: bool,
    pub colors: Colors,
    pub font: Font,
    pub size: f64,
    pub curve: f64,
    pub y_pos: f64,
    pub glow: f64,
    pub opacity: f64,
    pub show_when: ShowWhen,
    pub displays: Displays,
    pub global_offset_ms: f64,
    pub track_offsets_ms: BTreeMap<String, f64>,
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
        ] {
            assert_eq!(json_keys(&value), ts_fields(name), "{name}");
        }
        let settings = serde_json::to_value(&*DEFAULT_SETTINGS).unwrap();
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
                "showWhen": "playing", "displays": "primary", "globalOffsetMs": 0.0, "trackOffsetsMs": {}
            })
        );
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
    fn contract_v2_keeps_the_v1_settings_schema() {
        assert_eq!(CONTRACT_VERSION, 2);
        assert_eq!(SETTINGS_VERSION, 1);
        assert_eq!(DEFAULT_SETTINGS.version, 1);
    }
}
