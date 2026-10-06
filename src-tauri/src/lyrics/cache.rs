use crate::contract::{Lyrics, LyricsSource, LyricsStatus};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const NEGATIVE_TTL_SECS: u64 = 7 * 24 * 60 * 60;
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
            if entry.version != 1
                || entry.lyrics.track_key != key
                || !fresh(&entry.lyrics, entry.saved_at, now)
            {
                return Ok(None);
            }
            entry.lyrics.source = LyricsSource::Cache;
            Ok(Some(Cached {
                lyrics: entry.lyrics,
                saved_at: entry.saved_at,
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
            version: 1,
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
