use super::*;
use crate::lyrics::tests::{record, track};
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

type Fixture = (LrcLib, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>);
async fn server(responses: Vec<(u16, String)>) -> Fixture {
    server_with_headers(
        responses
            .into_iter()
            .map(|(status, body)| (status, "", body))
            .collect(),
    )
    .await
}
/// Each response's extra header lines end in "\r\n".
async fn server_with_headers(responses: Vec<(u16, &'static str, String)>) -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}/api/", listener.local_addr().unwrap())).unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let capture = requests.clone();
    let task = tokio::spawn(async move {
        for (status, headers, body) in responses {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 1024];
            while !request.windows(4).any(|chunk| chunk == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
                assert!(request.len() < 16384);
            }
            capture
                .lock()
                .unwrap()
                .push(String::from_utf8(request).unwrap());
            let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n{body}", body.len());
            if let Err(error) = stream.write_all(response.as_bytes()).await {
                assert!(matches!(
                    error.kind(),
                    std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                ));
            }
        }
    });
    (LrcLib::build(url, true).unwrap(), requests, task)
}
#[tokio::test]
async fn exact_get_encodes_metadata_duration_and_user_agent() {
    let (client, requests, server) =
        server(vec![(200, serde_json::to_string(&record()).unwrap())]).await;
    assert_eq!(
        client.lookup(&track()).await.unwrap().status,
        LyricsStatus::Found
    );
    server.await.unwrap();
    let requests = requests.lock().unwrap();
    let request = &requests[0];
    assert!(request.starts_with("GET /api/get?"));
    assert!(request.contains("duration=180"));
    assert!(request.contains("album_name=Demo+Album"));
    assert!(request
        .to_lowercase()
        .contains(&format!("user-agent: {}", USER_AGENT.to_lowercase())));
}
#[tokio::test]
async fn missing_exact_match_asks_without_the_album_then_searches_then_retries_clean_title() {
    let mut decorated = track();
    decorated.title = "Paper Sun - Remastered 2011".into();
    let (client, requests, server) = server(vec![
        (404, "{}".into()),
        (404, "{}".into()),
        (200, "[]".into()),
        (200, serde_json::to_string(&vec![record()]).unwrap()),
    ])
    .await;
    assert_eq!(
        client.lookup(&decorated).await.unwrap().status,
        LyricsStatus::Found
    );
    server.await.unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(requests[0].starts_with("GET /api/get?") && requests[0].contains("album_name="));
    assert!(requests[1].starts_with("GET /api/get?") && !requests[1].contains("album_name="));
    assert!(requests[1].contains("duration=180"));
    assert!(requests[2].starts_with("GET /api/search?"));
    assert!(requests[2].contains("Remastered"));
    assert!(requests[3].contains("track_name=Paper+Sun&"));
    assert!(!requests[3].contains("Remastered"));
}
#[tokio::test]
async fn the_record_found_without_the_album_is_the_answer() {
    let (client, requests, server) = server(vec![
        (404, "{}".into()),
        (200, serde_json::to_string(&record()).unwrap()),
    ])
    .await;
    assert_eq!(
        client.lookup(&track()).await.unwrap().status,
        LyricsStatus::Found
    );
    server.await.unwrap();
    assert_eq!(requests.lock().unwrap().len(), 2);
    // No album to leave out: one exact lookup, then the search.
    let mut no_album = track();
    no_album.album = String::new();
    let (client, requests, server) = self::server(vec![
        (404, "{}".into()),
        (200, serde_json::to_string(&vec![record()]).unwrap()),
    ])
    .await;
    assert_eq!(
        client.lookup(&no_album).await.unwrap().status,
        LyricsStatus::Found
    );
    server.await.unwrap();
    assert!(requests.lock().unwrap()[1].starts_with("GET /api/search?"));
}
#[tokio::test]
async fn valid_empty_search_is_not_found_but_http_and_json_errors_are_errors() {
    let (client, _, server) = server(vec![
        (404, "{}".into()),
        (404, "{}".into()),
        (200, "[]".into()),
    ])
    .await;
    assert_eq!(
        client.lookup(&track()).await.unwrap().status,
        LyricsStatus::NotFound
    );
    server.await.unwrap();
    // A failed exact lookup is a miss; the search's failure is the lookup's. A server error or a
    // garbled answer may be gone a little later; a 4xx or an oversized answer would come back the
    // same. None of them is asked again within the lookup.
    for (response, transient) in [
        ((500, String::from("{}")), true),
        ((200, "{".into()), true),
        ((403, "{}".into()), false),
        ((200, "x".repeat(MAX_RESPONSE_BYTES + 1)), false),
    ] {
        let (client, requests, server) =
            self::server(vec![response.clone(), response.clone(), response]).await;
        assert_eq!(
            client.lookup(&track()).await.unwrap_err().transient,
            transient
        );
        // The size guard can close the socket without consuming the oversized response.
        server.await.unwrap();
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[2].starts_with("GET /api/search?"));
    }
}
#[tokio::test]
async fn a_busy_exact_lookup_is_a_miss_and_the_search_still_finds_it() {
    // LRCLIB answers "busy" to an album or a length it has differently: never the lookup's end.
    for status in [429, 503, 502, 504] {
        let (client, requests, server) = server_with_headers(vec![
            (status, "Retry-After: 0\r\n", "{}".into()),
            (status, "Retry-After: 0\r\n", "{}".into()),
            (200, "", serde_json::to_string(&vec![record()]).unwrap()),
        ])
        .await;
        assert_eq!(
            client.lookup(&track()).await.unwrap().status,
            LyricsStatus::Found,
            "{status}"
        );
        server.await.unwrap();
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[..2].iter().all(|r| r.starts_with("GET /api/get?")));
        assert!(requests[2].starts_with("GET /api/search?"));
    }
}
#[tokio::test]
async fn a_busy_search_is_asked_again_up_to_its_attempts_after_retry_after() {
    let busy = || (503, "Retry-After: 0\r\n", String::from("{}"));
    let found = (200, "", serde_json::to_string(&vec![record()]).unwrap());
    let misses = || [(404, "", String::from("{}")), (404, "", String::from("{}"))];
    let mut responses = misses().to_vec();
    responses.extend([busy(), busy(), busy(), found]);
    let (client, requests, server) = server_with_headers(responses).await;
    assert_eq!(
        client.lookup(&track()).await.unwrap().status,
        LyricsStatus::Found
    );
    server.await.unwrap();
    assert_eq!(requests.lock().unwrap().len(), 2 + SEARCH_ATTEMPTS as usize);
    // Busy every time: the search's last answer ends the lookup, as transient.
    let mut responses = misses().to_vec();
    responses.extend((0..SEARCH_ATTEMPTS).map(|_| busy()));
    let (client, requests, server) = server_with_headers(responses).await;
    let failure = client.lookup(&track()).await.unwrap_err();
    assert!(failure.transient);
    assert_eq!(failure.message, "LRCLIB returned HTTP 503");
    server.await.unwrap();
    assert_eq!(requests.lock().unwrap().len(), 2 + SEARCH_ATTEMPTS as usize);
    // Longer than the lookup can wait: no second search, the quiet retries come back later.
    let mut responses = misses().to_vec();
    responses.push((429, "Retry-After: 60\r\n", "{}".into()));
    let (client, requests, server) = server_with_headers(responses).await;
    assert!(client.lookup(&track()).await.unwrap_err().transient);
    server.await.unwrap();
    assert_eq!(requests.lock().unwrap().len(), 3);
}
#[test]
fn retry_after_is_read_in_seconds_and_capped() {
    for (header, wait) in [
        (None, Some(RETRY_WAIT)),
        (Some("0"), Some(Duration::ZERO)),
        (Some(" 2 "), Some(Duration::from_secs(2))),
        (Some("3"), None),
        (Some("Wed, 21 Oct 2026 07:28:00 GMT"), Some(RETRY_WAIT)),
        (Some("-1"), Some(RETRY_WAIT)),
    ] {
        assert_eq!(retry_wait(header), wait, "{header:?}");
    }
    assert!(RETRY_WAIT <= MAX_RETRY_WAIT);
}
#[tokio::test(start_paused = true)]
async fn no_connection_is_asked_again_then_transient() {
    // A port nothing listens on: the connection is refused (or, with the paused clock, times
    // out), both times.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}/api/", listener.local_addr().unwrap())).unwrap();
    drop(listener);
    let started = tokio::time::Instant::now();
    let failure = LrcLib::build(url, true)
        .unwrap()
        .lookup(&track())
        .await
        .unwrap_err();
    assert!(failure.transient, "{failure}");
    assert!(started.elapsed() >= RETRY_WAIT);
}
#[tokio::test]
#[ignore = "requires live access to lrclib.net; queries an original nonexistent test title"]
async fn live_lrclib_not_found_probe() {
    let probe = Track {
        key: "undertone-live-probe".into(),
        title: "Undertone Onboarding Placeholder 7c92f6".into(),
        artist: "Undertone Test Fixture".into(),
        album: "Original Test Metadata".into(),
        duration_ms: 123_000.0,
    };
    let result = LrcLib::new().unwrap().lookup(&probe).await.unwrap();
    assert_eq!(result.status, LyricsStatus::NotFound);
    assert!(result.synced.is_none() && result.plain.is_none());
}

#[tokio::test]
async fn http_service_emits_results_and_restarts_offline_from_disk() {
    use crate::lyrics::{cache::Cache, wait, Service};
    let directory = tempfile::tempdir().unwrap();
    let (client, requests, server) =
        server(vec![(200, serde_json::to_string(&record()).unwrap())]).await;
    let provider = Arc::new(client);
    let service = Service::new(provider.clone(), Cache::new(directory.path()));
    let mut events = service.subscribe();
    let receiver = service.start(track(), false);
    assert_eq!(events.recv().await.unwrap().status, LyricsStatus::Loading);
    let ready = wait(receiver, &track().key).await;
    assert_eq!(ready.status, LyricsStatus::Found);
    assert_eq!(events.recv().await.unwrap(), ready);
    server.await.unwrap();
    assert_eq!(requests.lock().unwrap().len(), 1);
    drop(service);
    // The fixture server is now shut down: this request can succeed only from persisted cache.
    let restarted = Service::new(provider, Cache::new(directory.path()));
    let cached = wait(restarted.start(track(), false), &track().key).await;
    assert_eq!(cached.status, LyricsStatus::Found);
    assert_eq!(cached.source, LyricsSource::Cache);
    assert_eq!(cached.synced, ready.synced);
}
#[tokio::test]
async fn untimed_or_unnamed_tracks_are_not_found_without_a_request() {
    let (client, requests, server) = server(Vec::new()).await;
    let mut cases = Vec::new();
    for change in [
        |t: &mut Track| t.duration_ms = 0.0,
        |t: &mut Track| t.duration_ms = 999.0,
        |t: &mut Track| t.artist = "  ".into(),
        |t: &mut Track| t.title = String::new(),
    ] {
        let mut case = track();
        change(&mut case);
        cases.push(case);
    }
    for case in &cases {
        assert_eq!(
            client.lookup(case).await.unwrap().status,
            LyricsStatus::NotFound
        );
    }
    let mut broken = track();
    broken.duration_ms = f64::NAN;
    assert!(client.lookup(&broken).await.is_err());
    server.await.unwrap();
    assert!(requests.lock().unwrap().is_empty());
}
#[tokio::test]
async fn a_rejected_exact_lookup_still_searches() {
    let (client, requests, server) = server(vec![
        (400, "{}".into()),
        (400, "{}".into()),
        (200, serde_json::to_string(&vec![record()]).unwrap()),
    ])
    .await;
    assert_eq!(
        client.lookup(&track()).await.unwrap().status,
        LyricsStatus::Found
    );
    server.await.unwrap();
    assert!(requests.lock().unwrap()[2].starts_with("GET /api/search?"));
}
#[test]
fn the_user_agent_and_every_manifest_carry_one_version() {
    let version = env!("CARGO_PKG_VERSION");
    assert!(USER_AGENT.starts_with(&format!("Undertone/{version} (+https://")));
    // A release bumps all three: tauri.conf.json names the installers, package.json the frontend,
    // and Cargo.toml the user agent and the --diagnose header.
    for (file, text) in [
        ("tauri.conf.json", include_str!("../../../tauri.conf.json")),
        ("package.json", include_str!("../../../../package.json")),
    ] {
        let manifest: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(manifest["version"], version, "{file}");
    }
}
#[test]
fn null_fields_decode_to_values_matching_rejects() {
    let record: Record = serde_json::from_value(serde_json::json!({
        "id": 7,
        "trackName": null,
        "artistName": null,
        "albumName": null,
        "duration": null,
        "instrumental": null,
        "plainLyrics": null,
        "syncedLyrics": null,
    }))
    .unwrap();
    assert_eq!(
        (record.track_name.as_str(), record.artist_name.as_str()),
        ("", "")
    );
    assert!(record.duration.is_nan() && !record.instrumental);
    assert!(matching::best(&track(), std::slice::from_ref(&record)).is_none());
    let missing: Record = serde_json::from_value(serde_json::json!({ "id": 8 })).unwrap();
    assert!(missing.duration.is_nan() && missing.album_name.is_empty());
    // NaN goes back out as null, so a record survives a round trip.
    let text = serde_json::to_string(&record).unwrap();
    assert!(text.contains("\"duration\":null"));
    assert!(serde_json::from_str::<Record>(&text)
        .unwrap()
        .duration
        .is_nan());
}
#[tokio::test]
async fn a_null_or_malformed_search_record_does_not_hide_the_match() {
    let mut no_length = serde_json::to_value(record()).unwrap();
    no_length["id"] = 2.into();
    no_length["duration"] = serde_json::Value::Null;
    let body = serde_json::json!([no_length, { "id": "not a number" }, record()]);
    let (client, requests, server) = server(vec![
        (404, "{}".into()),
        (404, "{}".into()),
        (200, body.to_string()),
    ])
    .await;
    let found = client.lookup(&track()).await.unwrap();
    assert_eq!(found.status, LyricsStatus::Found);
    assert_eq!(found.synced, record().synced_lyrics);
    server.await.unwrap();
    assert_eq!(requests.lock().unwrap().len(), 3);
    // Only a body that isn't a list at all is an error.
    let (client, _, server) = self::server(vec![
        (404, "{}".into()),
        (404, "{}".into()),
        (200, "{}".into()),
    ])
    .await;
    assert!(client.lookup(&track()).await.is_err());
    server.await.unwrap();
}
#[tokio::test]
async fn an_unusable_exact_answer_falls_through_to_search() {
    let mut no_length = serde_json::to_value(record()).unwrap();
    no_length["duration"] = serde_json::Value::Null;
    for exact in [no_length.to_string(), r#"{"id":"not a number"}"#.into()] {
        let (client, requests, server) = server(vec![
            (200, exact.clone()),
            (200, exact),
            (200, serde_json::to_string(&vec![record()]).unwrap()),
        ])
        .await;
        assert_eq!(
            client.lookup(&track()).await.unwrap().status,
            LyricsStatus::Found
        );
        server.await.unwrap();
        assert!(requests.lock().unwrap()[2].starts_with("GET /api/search?"));
    }
}
