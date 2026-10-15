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
/// Another song, for tests where the user moves on.
fn other() -> Track {
    Track {
        key: "demo artist|glass river|demo album|200".into(),
        title: "Glass River".into(),
        duration_ms: 200_000.0,
        ..track()
    }
}
struct Fake {
    calls: AtomicUsize,
    gate: Option<Arc<Notify>>,
    /// The first this-many calls fail with `failure`; the others answer `answer`.
    failures: usize,
    failure: Failure,
    answer: lrclib::Record,
}
#[async_trait]
impl Provider for Fake {
    async fn lookup(&self, track: &Track) -> Result<Lyrics, Failure> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.gate {
            gate.notified().await;
        }
        if call < self.failures {
            Err(self.failure.clone())
        } else {
            Ok(self.answer.into_lyrics(&track.key))
        }
    }
}
fn fake(gate: Option<Arc<Notify>>, fail: bool) -> Arc<Fake> {
    let failures = if fail { usize::MAX } else { 0 };
    flaky(failures, Failure::transient("simulated outage"), gate)
}
fn flaky(failures: usize, failure: Failure, gate: Option<Arc<Notify>>) -> Arc<Fake> {
    Arc::new(Fake {
        calls: AtomicUsize::new(0),
        gate,
        failures,
        failure,
        answer: record(),
    })
}
/// The events sent so far, as (status, source).
fn sent(events: &mut broadcast::Receiver<Lyrics>) -> Vec<(LyricsStatus, LyricsSource)> {
    std::iter::from_fn(|| events.try_recv().ok())
        .map(|lyrics| (lyrics.status, lyrics.source))
        .collect()
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
    let service = Service::new(provider.clone(), cache.clone());
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
    // The deadline is transient: three quiet tries, each with its own deadline, and no event.
    tokio::time::sleep(Duration::from_secs(300)).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 4);
    assert!(sent(&mut events).is_empty());
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
#[tokio::test(start_paused = true)]
async fn a_transient_failure_is_retried_quietly_until_lyrics_arrive() {
    let directory = tempfile::tempdir().unwrap();
    let cache = cache::Cache::new(directory.path());
    let provider = flaky(2, Failure::transient("no network yet"), None);
    let service = Service::new(provider.clone(), cache.clone());
    let mut events = service.subscribe();
    let started = tokio::time::Instant::now();
    let key = track().key;
    assert_eq!(
        wait(service.start(track(), false), &key).await.status,
        LyricsStatus::Error
    );
    assert_eq!(events.recv().await.unwrap().status, LyricsStatus::Loading);
    assert_eq!(events.recv().await.unwrap().status, LyricsStatus::Error);
    // No second loading: the next event is the answer, after the first two waits.
    let found = events.recv().await.unwrap();
    assert_eq!(
        (found.status.clone(), found.source.clone()),
        (LyricsStatus::Found, LyricsSource::Lrclib)
    );
    assert!(started.elapsed() >= RETRY_BACKOFF[0] + RETRY_BACKOFF[1]);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
    assert_eq!(service.get(&key).await, found);
    assert!(cache.get(&key, now_seconds()).await.unwrap().is_some());
    tokio::time::sleep(Duration::from_secs(300)).await;
    assert!(sent(&mut events).is_empty());
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
}
#[tokio::test(start_paused = true)]
async fn retries_stop_after_three_tries_or_a_permanent_failure() {
    for (failure, calls) in [
        (Failure::transient("LRCLIB returned HTTP 503"), 4),
        (Failure::permanent("LRCLIB returned HTTP 403"), 1),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let provider = flaky(usize::MAX, failure, None);
        let service = Service::new(provider.clone(), cache::Cache::new(directory.path()));
        let mut events = service.subscribe();
        service.start(track(), false);
        tokio::time::sleep(Duration::from_secs(300)).await;
        assert_eq!(provider.calls.load(Ordering::SeqCst), calls);
        assert_eq!(
            sent(&mut events),
            [
                (LyricsStatus::Loading, LyricsSource::Lrclib),
                (LyricsStatus::Error, LyricsSource::Lrclib)
            ]
        );
        assert_eq!(service.get(&track().key).await.status, LyricsStatus::Error);
    }
}
#[tokio::test(start_paused = true)]
async fn a_newer_track_or_a_refetch_ends_the_retries() {
    // The user moves on to another song while the first one waits for its retry.
    let directory = tempfile::tempdir().unwrap();
    let provider = flaky(1, Failure::transient("no network yet"), None);
    let service = Service::new(provider.clone(), cache::Cache::new(directory.path()));
    let mut events = service.subscribe();
    wait(service.start(track(), false), &track().key).await;
    let next = wait(service.start(other(), false), &other().key).await;
    assert_eq!(next.status, LyricsStatus::Found);
    tokio::time::sleep(Duration::from_secs(300)).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    let first: Vec<_> = std::iter::from_fn(|| events.try_recv().ok())
        .filter(|lyrics| lyrics.track_key == track().key)
        .map(|lyrics| lyrics.status)
        .collect();
    assert_eq!(first, [LyricsStatus::Loading, LyricsStatus::Error]);
    // Refetch during the wait: one lookup of its own, with its loading, and no retry after it.
    let directory = tempfile::tempdir().unwrap();
    let provider = flaky(1, Failure::transient("no network yet"), None);
    let service = Service::new(provider.clone(), cache::Cache::new(directory.path()));
    let mut events = service.subscribe();
    wait(service.start(track(), false), &track().key).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    service.refetch(&track().key).unwrap();
    assert_eq!(service.get(&track().key).await.status, LyricsStatus::Found);
    tokio::time::sleep(Duration::from_secs(300)).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    let statuses: Vec<_> = sent(&mut events)
        .into_iter()
        .map(|(status, _)| status)
        .collect();
    assert_eq!(
        statuses,
        [
            LyricsStatus::Loading,
            LyricsStatus::Error,
            LyricsStatus::Loading,
            LyricsStatus::Found
        ]
    );
}
#[tokio::test]
async fn a_track_the_user_skipped_past_never_reaches_the_network() {
    let directory = tempfile::tempdir().unwrap();
    let provider = fake(None, false);
    let service = Service::new(provider.clone(), cache::Cache::new(directory.path()));
    let third = Track {
        key: "demo artist|still water|demo album|190".into(),
        title: "Still Water".into(),
        ..track()
    };
    // Every slot is busy. The first song's lookup (a refetch: straight to the network) queues for
    // one while that song still plays...
    let busy = service.slots.acquire_many(4).await.unwrap();
    let queued = service.start(track(), true);
    tokio::task::yield_now().await;
    // ...then the user skips twice, the second time before the next song's lookup even starts.
    let passed = service.start(other(), false);
    let playing = service.start(third.clone(), false);
    // The song passed over doesn't even wait for a slot (well within its six seconds)...
    let passed = tokio::time::timeout(Duration::from_secs(5), wait(passed, &other().key)).await;
    assert_eq!(passed.unwrap().status, LyricsStatus::Error);
    // ...and the queued one gives its slot up without a request.
    drop(busy);
    assert_eq!(wait(queued, &track().key).await.status, LyricsStatus::Error);
    assert_eq!(wait(playing, &third.key).await.status, LyricsStatus::Found);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    // Nothing was cached for it: playing it again looks it up.
    assert_eq!(
        wait(service.start(track(), false), &track().key)
            .await
            .status,
        LyricsStatus::Found
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
}
