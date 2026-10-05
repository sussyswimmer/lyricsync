use super::{lrclib::Record, Track};
use regex::Regex;
use std::sync::LazyLock;
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

pub fn retry_title(title: &str) -> String {
    static BRACKETS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\s*[\(\[]\s*(?:(?:feat\.?|ft\.?|featuring)\s|(?:\d{4}\s+)?remaster(?:ed)?\b|live\b|radio\s+edit\b|(?:album|single)\s+version\b|(?:original|extended)\s+mix\b|mono\b|stereo\b)[^\)\]]*[\)\]]").unwrap()
    });
    static SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\s+[-–—]\s*(?:(?:\d{4}\s+)?remaster(?:ed)?\b|live\b|radio\s+edit\b|(?:album|single)\s+version\b|(?:original|extended)\s+mix\b|mono\b|stereo\b).*$").unwrap()
    });
    static FEATURE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)\s+(?:feat\.?|ft\.?|featuring)\s+.+$").unwrap());
    let stripped = BRACKETS.replace_all(title, "");
    let stripped = SUFFIX.replace(&stripped, "");
    FEATURE.replace(&stripped, "").trim().to_owned()
}
/// Comparison only: preserve accents and quotes in outbound query strings and returned lyrics.
pub fn comparison(text: &str) -> String {
    text.nfkd()
        .filter(|c| !is_combining_mark(*c))
        .map(|c| match c {
            '‘' | '’' | 'ʼ' => '\'',
            '“' | '”' => '"',
            _ => c,
        })
        .collect::<String>()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn score(track: &Track, candidate: &Record) -> Option<(u8, bool, bool)> {
    if !candidate.duration.is_finite()
        || candidate.duration < 0.0
        || !track.duration_ms.is_finite()
        || track.duration_ms < 0.0
    {
        return None;
    }
    if comparison(&retry_title(&candidate.track_name)) != comparison(&retry_title(&track.title))
        || comparison(&retry_title(&candidate.artist_name))
            != comparison(&retry_title(&track.artist))
    {
        return None;
    }
    let delta = (candidate.duration - track.duration_ms / 1000.0).abs();
    let tier = if delta <= 2.0 {
        0
    } else if delta <= 5.0 {
        1
    } else if delta <= 8.0 {
        2
    } else {
        return None;
    };
    Some((
        tier,
        candidate
            .synced_lyrics
            .as_ref()
            .is_none_or(|s| s.trim().is_empty()),
        comparison(&candidate.album_name) != comparison(&track.album),
    ))
}
pub fn best<'a>(track: &Track, candidates: &'a [Record]) -> Option<&'a Record> {
    candidates
        .iter()
        .filter_map(|record| score(track, record).map(|score| (record, score)))
        .min_by(|(a, sa), (b, sb)| {
            sa.cmp(sb)
                .then_with(|| {
                    (a.duration - track.duration_ms / 1000.0)
                        .abs()
                        .total_cmp(&(b.duration - track.duration_ms / 1000.0).abs())
                })
                .then_with(|| a.id.cmp(&b.id))
        })
        .map(|(record, _)| record)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::lyrics::tests::{record, track};
    #[test]
    fn normalization_strips_only_recognized_decorations() {
        for name in [
            "Paper Sun - Remastered 2011",
            "Paper Sun (feat. Guest)",
            "Paper Sun - Live",
            "Paper Sun (Radio Edit)",
            "Paper Sun - 2011 Remaster",
            "Paper Sun [Stereo]",
        ] {
            assert_eq!(retry_title(name), "Paper Sun", "{name}");
        }
        assert_eq!(retry_title("Paper Sun (Part II)"), "Paper Sun (Part II)");
        assert_eq!(retry_title("L'été - Live"), "L'été");
        assert_eq!(comparison("  L’ÉTÉ  “Blue” "), "l'ete \"blue\"");
    }
    #[test]
    fn ranking_respects_duration_tier_then_sync_then_album() {
        let track = track();
        let mut near = record();
        near.duration += 1.9;
        near.synced_lyrics = None;
        let mut farther = record();
        farther.id = 2;
        farther.duration += 2.1;
        assert_eq!(best(&track, &[near.clone(), farther]).unwrap().id, 1);
        let mut synced = near.clone();
        synced.id = 3;
        synced.album_name = "Other Album".into();
        synced.synced_lyrics = Some("[00:00.00] We draw a paper sun".into());
        assert_eq!(best(&track, &[near, synced.clone()]).unwrap().id, 3);
        let mut album = synced.clone();
        album.id = 4;
        album.album_name = track.album.clone();
        assert_eq!(best(&track, &[synced, album]).unwrap().id, 4);
    }
    #[test]
    fn duration_boundaries_and_metadata_rejection() {
        for (delta, accepted) in [
            (2.0, true),
            (5.0, true),
            (8.0, true),
            (8.01, false),
            (-8.01, false),
        ] {
            let mut candidate = record();
            candidate.duration += delta;
            assert_eq!(best(&track(), &[candidate]).is_some(), accepted);
        }
        for field in ["artist", "title", "nan"] {
            let mut candidate = record();
            match field {
                "artist" => candidate.artist_name = "Someone Else".into(),
                "title" => candidate.track_name = "Another Song".into(),
                _ => candidate.duration = f64::NAN,
            }
            assert!(best(&track(), &[candidate]).is_none());
        }
    }
}
