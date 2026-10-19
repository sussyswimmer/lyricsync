use super::{lrclib::Record, Track};
use regex::Regex;
use std::sync::LazyLock;
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

pub fn retry_title(title: &str) -> String {
    static BRACKETS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\s*[\(\[]\s*(?:(?:feat\.?|ft\.?|featuring|with)\s|(?:\d{4}\s+)?remaster(?:ed)?\b|live\b|radio\s+edit\b|(?:album|single)\s+version\b|(?:original|extended)\s+mix\b|mono\b|stereo\b)[^\)\]]*[\)\]]").unwrap()
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
/// The names in an artist credit, normalized for comparison. Players and LRCLIB records each join
/// collaborators their own way: "A & B", "A, B", "A; B", "A / B", "A x B", "A and B", "A with B" and
/// "A (feat. B)" all give ["a", "b"].
fn credits(artist: &str) -> Vec<String> {
    static JOINERS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\s*[,;&/+×、]\s*|\s(?:x|and|with|vs\.?|feat\.?|ft\.?|featuring)\s").unwrap()
    });
    let names = comparison(&artist.replace(['(', ')', '[', ']'], " "));
    JOINERS
        .split(&names)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect()
}
/// One side's primary (first) artist is credited on the other side, so a player that reports only
/// the primary artist still finds a fully credited record. Sharing only a featured artist is not
/// enough.
fn same_artist(a: &str, b: &str) -> bool {
    let (a, b) = (credits(a), credits(b));
    a.first().is_some_and(|primary| b.contains(primary))
        || b.first().is_some_and(|primary| a.contains(primary))
}
/// Lower is better: the duration band, then missing synced lyrics, a title or an artist credit that
/// only matches once normalized, and another album.
fn score(track: &Track, candidate: &Record) -> Option<(u8, bool, bool, bool, bool)> {
    if !candidate.duration.is_finite()
        || candidate.duration < 0.0
        || !track.duration_ms.is_finite()
        || track.duration_ms < 0.0
    {
        return None;
    }
    let title_exact = comparison(&candidate.track_name) == comparison(&track.title);
    let artist_exact = comparison(&candidate.artist_name) == comparison(&track.artist);
    if !(title_exact
        || comparison(&retry_title(&candidate.track_name))
            == comparison(&retry_title(&track.title)))
        || !(artist_exact || same_artist(&candidate.artist_name, &track.artist))
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
        !title_exact,
        !artist_exact,
        comparison(&candidate.album_name) != comparison(&track.album),
    ))
}
pub fn best<'a>(track: &Track, candidates: &'a [Record]) -> Option<&'a Record> {
    best_of(track, candidates.iter())
}
/// The best candidate that has synced lyrics, by `best`'s ranking among those alone: a synced
/// version beats plain text even a duration tier further off, since plain text can only be paced
/// by guesswork.
pub fn best_synced<'a>(track: &Track, candidates: &'a [Record]) -> Option<&'a Record> {
    best_of(
        track,
        candidates
            .iter()
            .filter(|record| record.has_synced() && !record.instrumental),
    )
}
fn best_of<'a>(track: &Track, candidates: impl Iterator<Item = &'a Record>) -> Option<&'a Record> {
    candidates
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
    fn best_synced_takes_timing_over_a_closer_plain_record() {
        let track = track();
        let mut plain = record();
        plain.synced_lyrics = None;
        let mut farther = record();
        farther.id = 2;
        farther.duration += 4.0;
        let mut instrumental = record();
        instrumental.id = 3;
        instrumental.instrumental = true;
        let candidates = [plain.clone(), farther.clone()];
        assert_eq!(best(&track, &candidates).unwrap().id, 1);
        assert_eq!(best_synced(&track, &candidates).unwrap().id, 2);
        // an instrumental record's text doesn't count as timing
        assert_eq!(
            best_synced(&track, &[instrumental.clone(), farther])
                .unwrap()
                .id,
            2
        );
        assert!(best_synced(&track, &[plain, instrumental]).is_none());
        // still within what `best` accepts: 8 s off at most
        let mut far = record();
        far.duration += 9.0;
        assert!(best_synced(&track, &[far]).is_none());
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
    #[test]
    fn collaborations_match_whichever_way_each_side_joins_the_credits() {
        for credit in [
            "Demo Artist & Guest Singer",
            "Demo Artist, Guest Singer",
            "Demo Artist,Guest Singer",
            "Demo Artist; Guest Singer",
            "Demo Artist / Guest Singer",
            "Demo Artist x Guest Singer",
            "Demo Artist × Guest Singer",
            "Demo Artist and Guest Singer",
            "Demo Artist with Guest Singer",
            "Demo Artist feat. Guest Singer",
            "Demo Artist ft Guest Singer",
            "Demo Artist (featuring Guest Singer)",
            "Guest Singer & Demo Artist",
        ] {
            // The player reports only the primary artist, and LRCLIB has the full credit...
            let mut candidate = record();
            candidate.artist_name = credit.into();
            assert!(best(&track(), &[candidate]).is_some(), "record {credit}");
            // ...or the other way round, or both credit everyone, each in their own way.
            let mut credited = track();
            credited.artist = credit.into();
            assert!(best(&credited, &[record()]).is_some(), "track {credit}");
            let mut candidate = record();
            candidate.artist_name = "Demo Artist; Guest Singer".into();
            assert!(best(&credited, &[candidate]).is_some(), "both {credit}");
        }
        let mut duo = track();
        duo.artist = "Paper & Wire".into();
        for name in ["Paper & Wire", "Paper and Wire", "PAPER & WIRE"] {
            let mut candidate = record();
            candidate.artist_name = name.into();
            assert!(best(&duo, &[candidate]).is_some(), "{name}");
        }
    }
    #[test]
    fn other_acts_are_still_rejected() {
        let mut credited = track();
        credited.artist = "Demo Artist & Guest Singer".into();
        for (track, artist) in [
            (track(), "Someone Else & Another Act"),
            (track(), "Demo Artistx Guest Singer"),
            (track(), "Demo Artists"),
            // Only a featured artist in common.
            (credited.clone(), "Third Voice, Guest Singer"),
            (credited, "Someone Else"),
        ] {
            let mut candidate = record();
            candidate.artist_name = artist.into();
            assert!(best(&track, &[candidate]).is_none(), "{artist}");
        }
    }
    #[test]
    fn with_credits_in_a_title_are_stripped_like_features() {
        assert_eq!(retry_title("Paper Sun (with Guest Singer)"), "Paper Sun");
        assert_eq!(retry_title("Paper Sun [With Guest Singer]"), "Paper Sun");
        assert_eq!(
            retry_title("Paper Sun With Guest Singer"),
            "Paper Sun With Guest Singer"
        );
        let mut credited = track();
        credited.title = "Paper Sun (with Guest Singer)".into();
        assert!(best(&credited, &[record()]).is_some());
    }
    #[test]
    fn an_exact_credit_or_title_outranks_one_that_matches_only_normalized() {
        let mut shared = record();
        shared.artist_name = "Demo Artist & Guest Singer".into();
        let mut exact = record();
        exact.id = 2;
        assert_eq!(
            best(&track(), &[shared.clone(), exact.clone()]).unwrap().id,
            2
        );
        // Synced lyrics still come first.
        exact.synced_lyrics = None;
        assert_eq!(best(&track(), &[shared, exact]).unwrap().id, 1);
        let mut live = track();
        live.title = "Paper Sun - Live".into();
        let mut live_record = record();
        live_record.id = 2;
        live_record.track_name = "Paper Sun - Live".into();
        assert_eq!(best(&live, &[record(), live_record]).unwrap().id, 2);
    }
}
