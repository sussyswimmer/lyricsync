use super::*;
use crate::lyrics::tests::{record, track};
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

async fn server(
    responses: Vec<(u16, String)>,
) -> (LrcLib, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}/api/", listener.local_addr().unwrap())).unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let capture = requests.clone();
    let task = tokio::spawn(async move {
        for (status, body) in responses {
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
            let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
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
async fn missing_exact_match_searches_then_retries_clean_title() {
    let mut decorated = track();
    decorated.title = "Paper Sun - Remastered 2011".into();
    let (client, requests, server) = server(vec![
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
    assert_eq!(requests.len(), 3);
    assert!(requests[1].starts_with("GET /api/search?"));
    assert!(requests[1].contains("Remastered"));
    assert!(requests[2].contains("track_name=Paper+Sun&"));
    assert!(!requests[2].contains("Remastered"));
}
#[tokio::test]
async fn valid_empty_search_is_not_found_but_http_and_json_errors_are_errors() {
    let (client, _, server) = server(vec![(404, "{}".into()), (200, "[]".into())]).await;
    assert_eq!(
        client.lookup(&track()).await.unwrap().status,
        LyricsStatus::NotFound
    );
    server.await.unwrap();
    for response in [
        (429, "{}".into()),
        (500, "{}".into()),
        (200, "{".into()),
        (200, "x".repeat(MAX_RESPONSE_BYTES + 1)),
    ] {
        let (client, _, server) = self::server(vec![response]).await;
        assert!(client.lookup(&track()).await.is_err());
        // The size guard can close the socket without consuming the oversized response.
        server.await.unwrap();
    }
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
        (200, serde_json::to_string(&vec![record()]).unwrap()),
    ])
    .await;
    assert_eq!(
        client.lookup(&track()).await.unwrap().status,
        LyricsStatus::Found
    );
    server.await.unwrap();
    assert!(requests.lock().unwrap()[1].starts_with("GET /api/search?"));
}
