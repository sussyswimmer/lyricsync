use super::*;
use std::sync::atomic::AtomicUsize;
use tokio::sync::Notify;

pub fn track() -> Track {
    Track {
        key: "demo artist|paper sun|demo album|180".into(),
        title: "Paper Sun".into(),
        artist: "Demo Artist".into(),
        album: "Demo Album".into(),
        duration_ms: 180_000.0,
    }
}
pub fn record() -> lrclib::Record {
    lrclib::Record {
        id: 1,
        track_name: "Paper Sun".into(),
        artist_name: "Demo Artist".into(),
        album_name: "Demo Album".into(),
        duration: 180.0,
        instrumental: false,
        plain_lyrics: Some("We draw a paper sun".into()),
        synced_lyrics: Some("[00:00.00] We draw a paper sun".into()),
    }
}
struct Fake {
    calls: AtomicUsize,
    gate: Option<Arc<Notify>>,
    fail: bool,
}
#[async_trait]
impl Provider for Fake {
    async fn lookup(&self, track: &Track) -> Result<Lyrics, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.gate {
            gate.notified().await;
        }
        if self.fail {
            Err("simulated outage".into())
        } else {
            Ok(record().into_lyrics(&track.key))
        }
    }
}
fn fake(gate: Option<Arc<Notify>>, fail: bool) -> Arc<Fake> {
    Arc::new(Fake {
        calls: AtomicUsize::new(0),
        gate,
        fail,
    })
}
#[tokio::test]
async fn concurrent_gets_share_one_job_and_one_event_pair() {
    let directory = tempfile::tempdir().unwrap();
    let gate = Arc::new(Notify::new());
    let provider = fake(Some(gate.clone()), false);
    let service = Service::new(provider.clone(), cache::Cache::new(directory.path()));
    let mut events = service.subscribe();
    let first = service.start(track(), false);
    let second = service.start(track(), false);
    assert_eq!(events.recv().await.unwrap().status, LyricsStatus::Loading);
    assert!(events.try_recv().is_err());
    gate.notify_one();
    let key = track().key;
    let (a, b) = tokio::join!(wait(first, &key), wait(second, &key));
    assert_eq!(a, b);
    assert_eq!(a.status, LyricsStatus::Found);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(events.recv().await.unwrap(), a);
    assert!(events.try_recv().is_err());
    assert_eq!(service.get(&track().key).await, a);
}
#[tokio::test]
async fn force_promotes_pending_cache_hit_and_bypasses_completed_cache() {
    let directory = tempfile::tempdir().unwrap();
    let cache = cache::Cache::new(directory.path());
    let mut old = record();
    old.synced_lyrics = Some("[00:00.00] Our lantern rests".into());
    cache
        .put(&old.into_lyrics(&track().key), now_seconds())
        .await
        .unwrap();
    let provider = fake(None, false);
    let service = Service::new(provider.clone(), cache);
    let ordinary = service.start(track(), false);
    let forced = service.start(track(), true);
    let key = track().key;
    let (a, b) = tokio::join!(wait(ordinary, &key), wait(forced, &key));
    assert_eq!(a, b);
    assert_eq!(a.source, LyricsSource::Lrclib);
    assert_eq!(a.synced, record().synced_lyrics);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        wait(service.start(track(), false), &track().key)
            .await
            .source,
        LyricsSource::Cache
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    service.refetch(&track().key).unwrap();
    assert_eq!(service.get(&track().key).await.source, LyricsSource::Lrclib);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn restarted_service_reads_disk_without_network() {
    let directory = tempfile::tempdir().unwrap();
    let cache = cache::Cache::new(directory.path());
    let provider = fake(None, false);
    let first = Service::new(provider.clone(), cache.clone());
    assert_eq!(
        wait(first.start(track(), false), &track().key).await.status,
        LyricsStatus::Found
    );
    drop(first);
    let second = Service::new(provider.clone(), cache);
    assert_eq!(
        wait(second.start(track(), false), &track().key)
            .await
            .source,
        LyricsSource::Cache
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}
#[tokio::test(start_paused = true)]
async fn timeout_emits_error_releases_flight_and_does_not_cache_failure() {
    let directory = tempfile::tempdir().unwrap();
    let cache = cache::Cache::new(directory.path());
    let provider = fake(Some(Arc::new(Notify::new())), false);
    let service = Service::new(provider, cache.clone());
    let mut events = service.subscribe();
    let receiver = service.start(track(), true);
    assert_eq!(events.recv().await.unwrap().status, LyricsStatus::Loading);
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(6)).await;
    assert_eq!(
        wait(receiver, &track().key).await.status,
        LyricsStatus::Error
    );
    assert_eq!(events.recv().await.unwrap().status, LyricsStatus::Error);
    assert!(!cache.path(&track().key).exists());
    assert!(service.state.lock().unwrap().flights.is_empty());
}
#[tokio::test]
async fn errors_are_not_negative_cached_and_cancelled_waiters_do_not_cancel_work() {
    let directory = tempfile::tempdir().unwrap();
    let cache = cache::Cache::new(directory.path());
    let failing = Service::new(fake(None, true), cache.clone());
    assert_eq!(
        wait(failing.start(track(), true), &track().key)
            .await
            .status,
        LyricsStatus::Error
    );
    assert!(!cache.path(&track().key).exists());
    let gate = Arc::new(Notify::new());
    let provider = fake(Some(gate.clone()), false);
    let service = Service::new(provider.clone(), cache);
    drop(service.start(track(), false));
    gate.notify_one();
    assert_eq!(service.get(&track().key).await.status, LyricsStatus::Found);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert!(service.refetch("unknown key").is_err());
}
#[test]
fn response_status_mapping() {
    let mut candidate = record();
    assert_eq!(candidate.into_lyrics("key").status, LyricsStatus::Found);
    candidate.synced_lyrics = Some("  ".into());
    assert_eq!(candidate.into_lyrics("key").status, LyricsStatus::PlainOnly);
    candidate.plain_lyrics = None;
    assert_eq!(candidate.into_lyrics("key").status, LyricsStatus::NotFound);
    candidate.instrumental = true;
    assert_eq!(
        candidate.into_lyrics("key").status,
        LyricsStatus::Instrumental
    );
    assert!(candidate.into_lyrics("key").synced.is_none());
}

#[tokio::test]
async fn repeated_negative_hits_preserve_the_original_expiry() {
    let directory = tempfile::tempdir().unwrap();
    let cache = cache::Cache::new(directory.path());
    let original_time = now_seconds() - cache::NEGATIVE_TTL_SECS + 60;
    cache
        .put(&empty(&track().key, LyricsStatus::NotFound), original_time)
        .await
        .unwrap();
    let provider = fake(None, false);
    let service = Service::new(provider.clone(), cache.clone());
    for _ in 0..2 {
        assert_eq!(
            wait(service.start(track(), false), &track().key)
                .await
                .status,
            LyricsStatus::NotFound
        );
        assert_eq!(
            service.state.lock().unwrap().completed[&track().key].saved_at,
            original_time
        );
    }
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    assert!(cache
        .get(&track().key, original_time + cache::NEGATIVE_TTL_SECS)
        .await
        .unwrap()
        .is_none());
}
