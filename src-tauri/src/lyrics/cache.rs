use crate::contract::{Lyrics, LyricsSource, LyricsStatus};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const NEGATIVE_TTL_SECS: u64 = 7 * 24 * 60 * 60;
/// The entry format. Version 2 entries were looked up asking for a synced version when the match had
/// plain text only; a version 1 plain-only entry wasn't, so it is due for that at its next play.
const ENTRY_VERSION: u8 = 2;
/// LRCLIB's synced coverage grows, so a plain-only result this old is asked about again.
pub const PLAIN_RECHECK_SECS: u64 = 30 * 24 * 60 * 60;
const MAX_ENTRY_BYTES: u64 = 2 * 1024 * 1024;
#[derive(Clone)]
pub struct Cache {
    directory: PathBuf,
}
pub struct Cached {
    pub lyrics: Lyrics,
    pub saved_at: u64,
}
#[derive(Serialize, Deserialize)]
struct Entry {
    version: u8,
    saved_at: u64,
    lyrics: Lyrics,
}
pub fn cacheable(lyrics: &Lyrics) -> bool {
    match lyrics.status {
        LyricsStatus::Found => lyrics.synced.as_ref().is_some_and(|s| !s.trim().is_empty()),
        LyricsStatus::PlainOnly => lyrics.plain.as_ref().is_some_and(|s| !s.trim().is_empty()),
        LyricsStatus::Instrumental | LyricsStatus::NotFound => {
            lyrics.synced.is_none() && lyrics.plain.is_none()
        }
        _ => false,
    }
}
pub fn fresh(lyrics: &Lyrics, saved_at: u64, now: u64) -> bool {
    cacheable(lyrics)
        && (lyrics.status != LyricsStatus::NotFound
            || now
                .checked_sub(saved_at)
                .is_some_and(|age| age < NEGATIVE_TTL_SECS))
}
/// A plain-only result that is still served, but due for a quiet check for synced lyrics: older
/// than `PLAIN_RECHECK_SECS`, or saved by a clock that was ahead.
pub fn stale(lyrics: &Lyrics, saved_at: u64, now: u64) -> bool {
    lyrics.status == LyricsStatus::PlainOnly
        && now
            .checked_sub(saved_at)
            .is_none_or(|age| age >= PLAIN_RECHECK_SECS)
}
impl Cache {
    pub fn new(app_data_dir: impl AsRef<Path>) -> Self {
        Self {
            directory: app_data_dir.as_ref().join("lyrics"),
        }
    }
    pub fn path(&self, key: &str) -> PathBuf {
        self.directory
            .join(format!("{:x}.json", Sha1::digest(key.as_bytes())))
    }
    pub async fn get(&self, key: &str, now: u64) -> std::io::Result<Option<Lyrics>> {
        Ok(self.read(key, now).await?.map(|entry| entry.lyrics))
    }
    pub async fn read(&self, key: &str, now: u64) -> std::io::Result<Option<Cached>> {
        let path = self.path(key);
        let key = key.to_owned();
        tokio::task::spawn_blocking(move || {
            let file = match std::fs::File::open(path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error),
            };
            let mut bytes = Vec::new();
            file.take(MAX_ENTRY_BYTES + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > MAX_ENTRY_BYTES {
                return Ok(None);
            }
            let Ok(mut entry) = serde_json::from_slice::<Entry>(&bytes) else {
                return Ok(None);
            };
            if !(1..=ENTRY_VERSION).contains(&entry.version)
                || entry.lyrics.track_key != key
                || !fresh(&entry.lyrics, entry.saved_at, now)
            {
                return Ok(None);
            }
            entry.lyrics.source = LyricsSource::Cache;
            // A plain-only entry from before synced versions were looked for counts as saved long
            // ago: still served, and due for a recheck (`stale`).
            let saved_at = if entry.version < 2 && entry.lyrics.status == LyricsStatus::PlainOnly {
                0
            } else {
                entry.saved_at
            };
            Ok(Some(Cached {
                lyrics: entry.lyrics,
                saved_at,
            }))
        })
        .await
        .map_err(std::io::Error::other)?
    }
    pub async fn put(&self, lyrics: &Lyrics, saved_at: u64) -> std::io::Result<()> {
        if !cacheable(lyrics) {
            return Ok(());
        }
        let path = self.path(&lyrics.track_key);
        let directory = self.directory.clone();
        let entry = Entry {
            version: ENTRY_VERSION,
            saved_at,
            lyrics: lyrics.clone(),
        };
        tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(&directory)?;
            let bytes = serde_json::to_vec(&entry)?;
            if bytes.len() as u64 > MAX_ENTRY_BYTES {
                return Err(std::io::Error::other(
                    "lyrics cache entry exceeds size limit",
                ));
            }
            let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
            temporary.write_all(&bytes)?;
            temporary.flush()?;
            temporary.persist(path).map_err(|error| error.error)?;
            Ok(())
        })
        .await
        .map_err(std::io::Error::other)?
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::lyrics::{
        empty,
        tests::{record, track},
    };
    #[tokio::test]
    async fn positive_persists_and_negative_expires_at_seven_days() {
        let directory = tempfile::tempdir().unwrap();
        let cache = Cache::new(directory.path());
        let positive = record().into_lyrics(&track().key);
        cache.put(&positive, 100).await.unwrap();
        assert_eq!(
            cache
                .get(&positive.track_key, u64::MAX)
                .await
                .unwrap()
                .unwrap()
                .source,
            LyricsSource::Cache
        );
        let negative = empty(&positive.track_key, LyricsStatus::NotFound);
        cache.put(&negative, 100).await.unwrap();
        assert!(cache
            .get(&negative.track_key, 100 + NEGATIVE_TTL_SECS - 1)
            .await
            .unwrap()
            .is_some());
        assert!(cache
            .get(&negative.track_key, 100 + NEGATIVE_TTL_SECS)
            .await
            .unwrap()
            .is_none());
        assert!(cache.get(&negative.track_key, 99).await.unwrap().is_none());
    }
    #[test]
    fn plain_only_results_are_rechecked_after_thirty_days_and_still_served() {
        let mut unsynced = record();
        unsynced.synced_lyrics = None;
        let plain = unsynced.into_lyrics("key");
        for (now, due) in [
            (100, false),
            (100 + PLAIN_RECHECK_SECS - 1, false),
            (100 + PLAIN_RECHECK_SECS, true),
            (99, true),
        ] {
            assert_eq!(stale(&plain, 100, now), due, "{now}");
            assert!(fresh(&plain, 100, now));
        }
        // Synced lyrics and instrumentals are never rechecked; not-found simply expires.
        let found = record().into_lyrics("key");
        assert!(!stale(&found, 0, u64::MAX));
        for status in [LyricsStatus::Instrumental, LyricsStatus::NotFound] {
            assert!(!stale(&empty("key", status), 0, u64::MAX));
        }
    }
    #[tokio::test]
    async fn plain_only_entries_from_before_synced_versions_were_looked_for_are_due_now() {
        let directory = tempfile::tempdir().unwrap();
        let cache = Cache::new(directory.path());
        let mut unsynced = record();
        unsynced.synced_lyrics = None;
        let plain = unsynced.into_lyrics("key");
        // a realistic clock: "long ago" is measured against now
        const NOW: u64 = 1_800_000_000;
        let write = |version: u8, lyrics: &Lyrics| {
            let entry = Entry {
                version,
                saved_at: NOW - 1000,
                lyrics: lyrics.clone(),
            };
            std::fs::create_dir_all(&cache.directory).unwrap();
            std::fs::write(
                cache.path(&lyrics.track_key),
                serde_json::to_vec(&entry).unwrap(),
            )
            .unwrap();
        };
        // version 1 plain text: still served, and due at once
        write(1, &plain);
        let old = cache.read("key", NOW).await.unwrap().unwrap();
        assert_eq!(old.lyrics.status, LyricsStatus::PlainOnly);
        assert!(stale(&old.lyrics, old.saved_at, NOW));
        // version 1 synced lyrics, and version 2 plain text, keep their age
        let found = record().into_lyrics("key");
        write(1, &found);
        assert_eq!(
            cache.read("key", NOW).await.unwrap().unwrap().saved_at,
            NOW - 1000
        );
        write(2, &plain);
        let new = cache.read("key", NOW).await.unwrap().unwrap();
        assert_eq!(new.saved_at, NOW - 1000);
        assert!(!stale(&new.lyrics, new.saved_at, NOW));
        // an unknown, newer format is no hit; what is written now is version 2
        write(3, &plain);
        assert!(cache.read("key", NOW).await.unwrap().is_none());
        cache.put(&plain, NOW).await.unwrap();
        let bytes = std::fs::read(cache.path("key")).unwrap();
        let entry: Entry = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(entry.version, ENTRY_VERSION);
        assert_eq!(ENTRY_VERSION, 2);
    }
    #[tokio::test]
    async fn corrupt_wrong_key_and_transient_results_are_not_hits() {
        let directory = tempfile::tempdir().unwrap();
        let cache = Cache::new(directory.path());
        for status in [LyricsStatus::Error, LyricsStatus::Loading] {
            cache.put(&empty("key", status), 100).await.unwrap();
        }
        assert!(!cache.path("key").exists());
        std::fs::create_dir_all(&cache.directory).unwrap();
        std::fs::write(cache.path("key"), b"{").unwrap();
        assert!(cache.get("key", 100).await.unwrap().is_none());
        let good = record().into_lyrics("different key");
        cache.put(&good, 100).await.unwrap();
        std::fs::copy(cache.path("different key"), cache.path("key")).unwrap();
        assert!(cache.get("key", 100).await.unwrap().is_none());
        assert_eq!(
            cache.path("../../outside").parent(),
            Some(cache.directory.as_path())
        );
        assert_eq!(
            cache.path("abc").file_name().unwrap(),
            "a9993e364706816aba3e25717850c26c9cd0d89d.json"
        );
    }
}
