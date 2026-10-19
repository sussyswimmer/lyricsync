use super::{empty, matching, Failure, Provider, Track};
use crate::contract::{Lyrics, LyricsSource, LyricsStatus};
use async_trait::async_trait;
use reqwest::{Client, StatusCode, Url};
use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use std::time::Duration;

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
/// LRCLIB answers HTTP 400 for a duration under one second.
const MIN_DURATION_MS: f64 = 1000.0;
/// The wait before a retry when the server names none, or there was no connection.
const RETRY_WAIT: Duration = Duration::from_secs(1);
/// A longer `Retry-After` isn't waited out inside a lookup (`super::DEADLINE` in all); the
/// service's quiet retries come back later instead.
const MAX_RETRY_WAIT: Duration = Duration::from_secs(2);
/// How many times a search is asked before its failure is the lookup's. LRCLIB's search answers
/// "busy" (503, `retry-after: 1`) about half the time, and a second later it usually answers.
const SEARCH_ATTEMPTS: u32 = 4;
/// "Not now": LRCLIB answers 503 when it's busy and 429 when it rate-limits, both with
/// `retry-after: 1`; a gateway answers 502 or 504 when it can't reach LRCLIB.
fn busy(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::TOO_MANY_REQUESTS
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
    )
}
/// How long to wait before the retry: `Retry-After` in seconds (a date or anything else counts as
/// absent, so `RETRY_WAIT`), or `None` when that is longer than `MAX_RETRY_WAIT`.
fn retry_wait(retry_after: Option<&str>) -> Option<Duration> {
    let wait = retry_after
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map_or(RETRY_WAIT, Duration::from_secs);
    (wait <= MAX_RETRY_WAIT).then_some(wait)
}
/// Also sent for Spotify artwork. The version is Cargo's, which a test keeps equal to
/// tauri.conf.json's (the installers') and package.json's.
pub const USER_AGENT: &str = concat!(
    "Undertone/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/sussyswimmer/lyricsync)"
);
/// One LRCLIB record. Some records carry `null` where a value belongs (seen for `duration`), so
/// every field but the id tolerates it: a missing or null name is empty, a duration NaN (which
/// `matching` never accepts, and which serializes back to null) and `instrumental` false.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: u64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub track_name: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub artist_name: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub album_name: String,
    #[serde(default = "unknown_duration", deserialize_with = "null_as_nan")]
    pub duration: f64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub instrumental: bool,
    pub plain_lyrics: Option<String>,
    pub synced_lyrics: Option<String>,
}
fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}
fn unknown_duration() -> f64 {
    f64::NAN
}
fn null_as_nan<'de, D: Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(deserializer)?.unwrap_or(f64::NAN))
}
/// A search answer's records, without the ones that don't decode: one malformed record must not
/// throw away the good match next to it.
pub fn records(values: Vec<serde_json::Value>) -> Vec<Record> {
    values
        .into_iter()
        .filter_map(|value| serde_json::from_value(value).ok())
        .collect()
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
    /// Asks up to `attempts` times, after `Retry-After`, while the answer means "not now" (`busy`)
    /// or there is no connection. The service's deadline bounds the whole lookup, waits included.
    async fn json<T: DeserializeOwned>(
        &self,
        endpoint: &str,
        parameters: &[(&str, String)],
        allow_404: bool,
        attempts: u32,
    ) -> Result<Option<T>, Failure> {
        let url = self
            .base
            .join(endpoint)
            .map_err(|e| Failure::permanent(e.to_string()))?;
        let mut asked = 1;
        let mut response = loop {
            let request = self
                .client
                .get(url.clone())
                .header(reqwest::header::ACCEPT, "application/json")
                .query(parameters);
            let wait = match request.send().await {
                Ok(response) if busy(response.status()) => {
                    let header = response.headers().get(reqwest::header::RETRY_AFTER);
                    match retry_wait(header.and_then(|value| value.to_str().ok())) {
                        Some(wait) if asked < attempts => wait,
                        _ => {
                            return Err(Failure::transient(format!(
                                "LRCLIB returned HTTP {}",
                                response.status().as_u16()
                            )))
                        }
                    }
                }
                Ok(response) => break response,
                Err(error) if asked < attempts && (error.is_connect() || error.is_timeout()) => {
                    RETRY_WAIT
                }
                Err(error) => return Err(Failure::transient(error.to_string())),
            };
            asked += 1;
            tokio::time::sleep(wait).await;
        };
        let status = response.status();
        // /api/get answers 404 for no match, and 400 for metadata it won't match (a duration it
        // rejects): either way there is no exact record, and search still gets its turn.
        if allow_404 && matches!(status, StatusCode::NOT_FOUND | StatusCode::BAD_REQUEST) {
            return Ok(None);
        }
        if !status.is_success() {
            let message = format!("LRCLIB returned HTTP {}", status.as_u16());
            // A 4xx is about the request itself, and asking again gets the same answer.
            return Err(if status.is_client_error() {
                Failure::permanent(message)
            } else {
                Failure::transient(message)
            });
        }
        let too_large = || Failure::permanent("LRCLIB response exceeds size limit");
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(too_large());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| Failure::transient(e.to_string()))?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(too_large());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| Failure::transient(format!("invalid LRCLIB JSON: {e}")))
    }
    /// A body that isn't a JSON array is still an error.
    async fn search(&self, track: &Track, title: &str) -> Result<Vec<Record>, Failure> {
        self.json(
            "search",
            &[
                ("track_name", title.into()),
                ("artist_name", track.artist.clone()),
            ],
            false,
            SEARCH_ATTEMPTS,
        )
        .await
        .map(|values| records(values.unwrap_or_default()))
    }
    /// The record LRCLIB has for this title, artist and length (and, with `album`, album), when it
    /// is one `matching` accepts. Anything else is a miss, a failed request included: LRCLIB
    /// answers "busy" (503) to metadata it can't match exactly, such as an album or a length it has
    /// differently, so the search still gets its turn, and the search's failures are the ones
    /// reported. A busy answer isn't asked again, since it is how a miss looks.
    async fn exact(&self, track: &Track, album: bool) -> Option<Record> {
        let mut parameters = vec![
            ("track_name", track.title.clone()),
            ("artist_name", track.artist.clone()),
        ];
        if album {
            parameters.push(("album_name", track.album.clone()));
        }
        parameters.push(("duration", (track.duration_ms / 1000.0).to_string()));
        let value = self
            .json::<serde_json::Value>("get", &parameters, true, 1)
            .await
            .ok()??;
        let record: Record = serde_json::from_value(value).ok()?;
        let usable = matching::best(track, std::slice::from_ref(&record)).is_some();
        usable.then_some(record)
    }
}
#[async_trait]
impl Provider for LrcLib {
    async fn lookup(&self, track: &Track) -> Result<Lyrics, Failure> {
        if !track.duration_ms.is_finite() || track.duration_ms < 0.0 {
            return Err(Failure::permanent("track metadata is incomplete"));
        }
        // A stream, an ad or a podcast often has no length, title or artist. LRCLIB can't match it
        // (and rejects a duration under a second), so it has no lyrics rather than an error chip.
        if track.duration_ms < MIN_DURATION_MS
            || track.title.trim().is_empty()
            || track.artist.trim().is_empty()
        {
            return Ok(empty(&track.key, LyricsStatus::NotFound));
        }
        // The exact match, then the same without the album (a player's album name often differs
        // from LRCLIB's: an edition, a remaster), then a search.
        if let Some(record) = self.exact(track, true).await {
            return Ok(record.into_lyrics(&track.key));
        }
        if !track.album.trim().is_empty() {
            if let Some(record) = self.exact(track, false).await {
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
