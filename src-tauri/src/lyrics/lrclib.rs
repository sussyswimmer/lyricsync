use super::{empty, matching, Provider, Track};
use crate::contract::{Lyrics, LyricsSource, LyricsStatus};
use async_trait::async_trait;
use reqwest::{Client, StatusCode, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::time::Duration;

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
/// LRCLIB answers HTTP 400 for a duration under one second.
const MIN_DURATION_MS: f64 = 1000.0;
pub const USER_AGENT: &str = "Undertone/0.1 (+https://github.com/sussyswimmer/lyricsync)";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: u64,
    pub track_name: String,
    pub artist_name: String,
    pub album_name: String,
    pub duration: f64,
    pub instrumental: bool,
    pub plain_lyrics: Option<String>,
    pub synced_lyrics: Option<String>,
}
impl Record {
    pub fn into_lyrics(&self, key: &str) -> Lyrics {
        if self.instrumental {
            return empty(key, LyricsStatus::Instrumental);
        }
        let synced = self.synced_lyrics.clone().filter(|s| !s.trim().is_empty());
        let plain = self.plain_lyrics.clone().filter(|s| !s.trim().is_empty());
        let status = if synced.is_some() {
            LyricsStatus::Found
        } else if plain.is_some() {
            LyricsStatus::PlainOnly
        } else {
            LyricsStatus::NotFound
        };
        Lyrics {
            track_key: key.into(),
            status,
            synced,
            plain,
            source: LyricsSource::Lrclib,
        }
    }
}
pub struct LrcLib {
    client: Client,
    base: Url,
}
impl LrcLib {
    pub fn new() -> Result<Self, String> {
        Self::build(
            Url::parse("https://lrclib.net/api/").map_err(|e| e.to_string())?,
            false,
        )
    }
    fn build(base: Url, local_test: bool) -> Result<Self, String> {
        let mut builder = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(6))
            .connect_timeout(Duration::from_secs(3))
            .redirect(reqwest::redirect::Policy::none());
        if local_test {
            builder = builder.no_proxy();
        }
        Ok(Self {
            client: builder.build().map_err(|e| e.to_string())?,
            base,
        })
    }
    async fn json<T: DeserializeOwned>(
        &self,
        endpoint: &str,
        parameters: &[(&str, String)],
        allow_404: bool,
    ) -> Result<Option<T>, String> {
        let url = self.base.join(endpoint).map_err(|e| e.to_string())?;
        let mut response = self
            .client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .query(parameters)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        // /api/get answers 404 for no match, and 400 for metadata it won't match (a duration it
        // rejects): either way there is no exact record, and search still gets its turn.
        if allow_404
            && matches!(
                response.status(),
                StatusCode::NOT_FOUND | StatusCode::BAD_REQUEST
            )
        {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!(
                "LRCLIB returned HTTP {}",
                response.status().as_u16()
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err("LRCLIB response exceeds size limit".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err("LRCLIB response exceeds size limit".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("invalid LRCLIB JSON: {e}"))
    }
    async fn search(&self, track: &Track, title: &str) -> Result<Vec<Record>, String> {
        self.json(
            "search",
            &[
                ("track_name", title.into()),
                ("artist_name", track.artist.clone()),
            ],
            false,
        )
        .await
        .map(|value| value.unwrap_or_default())
    }
}
#[async_trait]
impl Provider for LrcLib {
    async fn lookup(&self, track: &Track) -> Result<Lyrics, String> {
        if !track.duration_ms.is_finite() || track.duration_ms < 0.0 {
            return Err("track metadata is incomplete".into());
        }
        // A stream, an ad or a podcast often has no length, title or artist. LRCLIB can't match it
        // (and rejects a duration under a second), so it has no lyrics rather than an error chip.
        if track.duration_ms < MIN_DURATION_MS
            || track.title.trim().is_empty()
            || track.artist.trim().is_empty()
        {
            return Ok(empty(&track.key, LyricsStatus::NotFound));
        }
        let exact: Option<Record> = self
            .json(
                "get",
                &[
                    ("track_name", track.title.clone()),
                    ("artist_name", track.artist.clone()),
                    ("album_name", track.album.clone()),
                    ("duration", (track.duration_ms / 1000.0).to_string()),
                ],
                true,
            )
            .await?;
        if let Some(record) = exact {
            if matching::best(track, std::slice::from_ref(&record)).is_some() {
                return Ok(record.into_lyrics(&track.key));
            }
        }
        let records = self.search(track, &track.title).await?;
        if let Some(record) = matching::best(track, &records) {
            return Ok(record.into_lyrics(&track.key));
        }
        let retry = matching::retry_title(&track.title);
        if !retry.is_empty() && retry != track.title {
            let records = self.search(track, &retry).await?;
            if let Some(record) = matching::best(track, &records) {
                return Ok(record.into_lyrics(&track.key));
            }
        }
        Ok(empty(&track.key, LyricsStatus::NotFound))
    }
}
#[cfg(test)]
mod tests;
