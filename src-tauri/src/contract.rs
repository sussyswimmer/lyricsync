use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const CONTRACT_VERSION: u8 = 1;
pub static DEFAULT_SETTINGS: std::sync::LazyLock<Settings> =
    std::sync::LazyLock::new(Settings::default);
pub const NOW_PLAYING_EVENT: &str = "now-playing";
pub const LYRICS_EVENT: &str = "lyrics";
pub const SETTINGS_CHANGED_EVENT: &str = "settings-changed";

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
            version: CONTRACT_VERSION,
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
    use serde_json::json;
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
}
