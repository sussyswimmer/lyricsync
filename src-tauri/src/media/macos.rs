//! macOS: Spotify and Music over AppleScript, run in-process by NSAppleScript (never `osascript`).
//! NSAppleScript is main-thread only, so each read is one short hop there: a script compiled
//! once, a handful of Apple events. Finding the running players, asking for Automation consent,
//! parsing, picking the source and artwork all stay off the main thread.
use super::{
    applescript::{
        self, Consent, Failure, FailureKind, Player, Reading, Script, Verdict, HOLD,
        TIMEOUT_COOLDOWN,
    },
    artwork, epoch_ms,
    runtime::Backend,
    MediaSource, Presence, RawTrack,
};
use crate::lyrics::lrclib::USER_AGENT;
use async_trait::async_trait;
use objc2::{
    define_class, msg_send,
    rc::{autoreleasepool, Retained},
    runtime::{AnyObject, NSObject},
    sel, AnyThread, DefinedClass, MainThreadMarker,
};
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{
    NSAppleEventDescriptor, NSAppleScript, NSAppleScriptErrorMessage, NSAppleScriptErrorNumber,
    NSDictionary, NSDistributedNotificationCenter, NSNotification,
    NSNotificationSuspensionBehavior, NSNumber, NSObjectProtocol, NSString,
};
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Once, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::AppHandle;
use tokio::sync::{oneshot, Notify};

/// Each script bounds its Apple events to 2 s; this adds room for a busy main thread.
const MAIN_THREAD_WAIT: Duration = Duration::from_secs(3);

/// macOS's Automation answers belong to the process, not to one connection.
fn shared_consent() -> Arc<Mutex<HashMap<Player, Consent>>> {
    static CONSENT: OnceLock<Arc<Mutex<HashMap<Player, Consent>>>> = OnceLock::new();
    CONSENT.get_or_init(Default::default).clone()
}

pub struct MacSource {
    app: AppHandle,
    notify: Arc<Notify>,
    http: reqwest::Client,
    /// When each player was last seen playing, for "most recently active".
    activity: Mutex<HashMap<Player, f64>>,
    /// The last line logged per player, so a lasting problem (Automation off) is logged once.
    reported: Mutex<HashMap<Player, String>>,
    /// Automation consent per player, asked on a blocking thread before any script runs. Shared
    /// by every connection, so a reconnect neither asks again nor clears a denial for a moment.
    consent: Arc<Mutex<HashMap<Player, Consent>>>,
    /// Which players ran in the last snapshot, and whether Automation is denied for one.
    presence: Mutex<Presence>,
    /// Each player's last good reading, standing in for it across a transient failure.
    last: Mutex<HashMap<Player, Held>>,
    /// A player that timed out is not sent another script before this time.
    cooldown: Mutex<HashMap<Player, Instant>>,
    /// Set while a read script is queued or running on the main thread. Something blocking it
    /// (a hung player, a long main-thread task) must not pile one script up per poll behind it.
    reading: Arc<AtomicBool>,
    art: Arc<Mutex<ArtCache>>,
    art_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}
struct Held {
    reading: Reading,
    sampled_at: f64,
    at: Instant,
}
/// Clears `MacSource::reading` when the main-thread work ends, or is dropped without running.
struct InFlight(Arc<AtomicBool>);
impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
#[derive(Default)]
struct ArtCache {
    /// Player, track key and Spotify's artwork URL, which can arrive after the track does.
    key: Option<(Player, String, Option<String>)>,
    value: Option<String>,
    retry_after: Option<Instant>,
}
impl Drop for MacSource {
    fn drop(&mut self) {
        if let Ok(mut task) = self.art_task.lock() {
            if let Some(task) = task.take() {
                task.abort();
            }
        }
    }
}

#[async_trait]
impl Backend for MacSource {
    const NAME: &'static str = "AppleScript";
    // Two players, each at most one main-thread hop.
    const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(7);
    // Paused or idle: every 3 s. Play, pause and track changes wake the loop at once.
    const IDLE_TICKS: u32 = 3;
    async fn connect(app: &AppHandle, wake: Arc<Notify>) -> Result<Self, String> {
        let observer_wake = wake.clone();
        on_main(app, move || observe_players(observer_wake)).await?;
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .https_only(true)
            .timeout(Duration::from_secs(5))
            .connect_timeout(Duration::from_secs(3))
            .redirect(reqwest::redirect::Policy::limited(3))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            app: app.clone(),
            notify: wake,
            http,
            activity: Mutex::new(HashMap::new()),
            reported: Mutex::new(HashMap::new()),
            consent: shared_consent(),
            presence: Mutex::new(Presence::Unknown),
            last: Mutex::new(HashMap::new()),
            cooldown: Mutex::new(HashMap::new()),
            reading: Arc::new(AtomicBool::new(false)),
            art: Arc::new(Mutex::new(ArtCache::default())),
            art_task: Mutex::new(None),
        })
    }
    /// Every snapshot looks the players up afresh; there is no session to lose.
    fn is_disconnected(&self) -> bool {
        false
    }
}

#[async_trait]
impl MediaSource for MacSource {
    async fn snapshot(&self) -> Option<RawTrack> {
        let running = running_players();
        let mut readings: Vec<(Player, Reading, f64)> = Vec::new();
        for player in Player::ALL {
            if !running.contains(&player) {
                lock(&self.last).remove(&player);
                continue;
            }
            let Some((reading, sampled_at)) = self.current(player).await else {
                continue;
            };
            let outranks_all = player == Player::Spotify && reading.is_playing();
            readings.push((player, reading, sampled_at));
            // Nothing beats a playing Spotify; skip Music's round trip.
            if outranks_all {
                break;
            }
        }
        let presence = {
            let consent = lock(&self.consent);
            applescript::presence(&running, |player| {
                consent
                    .get(&player)
                    .is_some_and(|consent| consent.verdict() == Verdict::Denied)
            })
        };
        *lock(&self.presence) = presence;
        let states: Vec<_> = readings
            .iter()
            .map(|(player, reading, _)| (*player, reading.state))
            .collect();
        let selected = {
            let mut activity = lock(&self.activity);
            applescript::choose(&states, &mut activity, epoch_ms())
        }?;
        let (player, reading, sampled_at) = readings.swap_remove(selected);
        let artwork = self.artwork(player, &reading);
        Some(reading.into_raw(player, sampled_at, artwork))
    }
    fn presence(&self) -> Presence {
        lock(&self.presence).clone()
    }
}

impl MacSource {
    /// This snapshot's reading for a running player: a fresh one, or its last one across a
    /// hiccup, so one slow answer does not publish null (and reload the lyrics) mid-song.
    async fn current(&self, player: Player) -> Option<(Reading, f64)> {
        let failure = match self.read(player).await {
            Ok(reading) => {
                lock(&self.reported).remove(&player);
                let mut last = lock(&self.last);
                match &reading {
                    Some((reading, sampled_at)) => {
                        let held = Held {
                            reading: reading.clone(),
                            sampled_at: *sampled_at,
                            at: Instant::now(),
                        };
                        last.insert(player, held);
                    }
                    None => {
                        last.remove(&player);
                    }
                }
                return reading;
            }
            Err(failure) => failure,
        };
        self.report(player, &failure);
        let mut last = lock(&self.last);
        if failure.kind.is_transient() {
            if let Some(held) = last.get(&player).filter(|held| held.at.elapsed() <= HOLD) {
                return Some((held.reading.clone(), held.sampled_at));
            }
        }
        last.remove(&player);
        None
    }
    async fn read(&self, player: Player) -> Result<Option<(Reading, f64)>, Failure> {
        self.consent(player)?;
        if lock(&self.cooldown)
            .get(&player)
            .is_some_and(|until| Instant::now() < *until)
        {
            // The same failure as the timeout that started it, so it is not logged again.
            return Err(Failure::new(Some(-1712), "cooling down after a timeout"));
        }
        if self.reading.swap(true, Ordering::AcqRel) {
            return Err(Failure::other(
                "the previous script has not finished on the main thread",
            ));
        }
        let in_flight = InFlight(self.reading.clone());
        let script = player.read_script();
        let answer = on_main(&self.app, move || {
            let _in_flight = in_flight;
            read_on_main(script)
        })
        .await
        .map_err(Failure::other)
        .and_then(|answer| answer);
        let (text, sampled_at) = answer.inspect_err(|failure| match failure.kind {
            FailureKind::NotPermitted => {
                lock(&self.consent)
                    .entry(player)
                    .or_default()
                    .revoked(Instant::now());
            }
            FailureKind::Timeout => {
                lock(&self.cooldown).insert(player, Instant::now() + TIMEOUT_COOLDOWN);
            }
            _ => {}
        })?;
        let reading = applescript::parse_reading(player, &text).map_err(Failure::other)?;
        Ok(reading.map(|reading| (reading, sampled_at)))
    }
    /// Scripts run only once macOS has answered the Automation question for this player. The
    /// question is asked on a blocking thread, where its prompt may wait for the user as long
    /// as it likes; meanwhile the player is simply not read.
    fn consent(&self, player: Player) -> Result<(), Failure> {
        let (gate, ask) = lock(&self.consent)
            .entry(player)
            .or_default()
            .gate(Instant::now());
        if ask {
            let (consent, wake) = (self.consent.clone(), self.notify.clone());
            drop(tauri::async_runtime::spawn_blocking(move || {
                let status = automation_permission(player.bundle_id());
                lock(&consent)
                    .entry(player)
                    .or_default()
                    .answered(status, Instant::now());
                wake.notify_one();
            }));
        }
        gate
    }
    fn report(&self, player: Player, failure: &Failure) {
        let Some(line) = failure.log_line(player) else {
            return;
        };
        let mut reported = lock(&self.reported);
        if reported.get(&player) != Some(&line) {
            eprintln!("{line}");
            reported.insert(player, line);
        }
    }
    /// Cached per track: fetched once when the track changes, then retried only after a failure.
    fn artwork(&self, player: Player, reading: &Reading) -> Option<String> {
        let key = (player, reading.track_key(), reading.artwork_url.clone());
        {
            let mut cache = lock(&self.art);
            if cache.key.as_ref() == Some(&key)
                && cache.retry_after.is_none_or(|time| Instant::now() < time)
            {
                return cache.value.clone();
            }
            *cache = ArtCache {
                key: Some(key.clone()),
                value: None,
                retry_after: None,
            };
        }
        let url = reading.artwork_url.clone();
        let (app, http) = (self.app.clone(), self.http.clone());
        let cache = self.art.clone();
        let wake = self.notify.clone();
        let mut worker = lock(&self.art_task);
        if let Some(old) = worker.take() {
            old.abort();
        }
        *worker = Some(tauri::async_runtime::spawn(async move {
            let result = tokio::time::timeout(
                Duration::from_secs(8),
                fetch_artwork(&app, &http, player, url.as_deref()),
            )
            .await;
            let mut cache = lock(&cache);
            // A late answer may arrive after a track switch; never attach it to the new song.
            if cache.key.as_ref() != Some(&key) {
                return;
            }
            match result {
                Ok(Ok(Some(value))) => {
                    cache.value = Some(value);
                    wake.notify_one();
                }
                // The track has no artwork: ask again only for the next one.
                Ok(Ok(None)) => {}
                _ => cache.retry_after = Some(Instant::now() + Duration::from_secs(10)),
            }
        }));
        None
    }
}

async fn fetch_artwork(
    app: &AppHandle,
    http: &reqwest::Client,
    player: Player,
    url: Option<&str>,
) -> Result<Option<String>, String> {
    let bytes = match player {
        Player::Spotify => match url.and_then(applescript::https_artwork_url) {
            Some(url) => Some(download(http, url).await?),
            None => None,
        },
        Player::Music => on_main(app, music_artwork_on_main)
            .await?
            .map_err(|failure| failure.message)?,
    };
    let Some(bytes) = bytes else {
        return Ok(None);
    };
    match tauri::async_runtime::spawn_blocking(move || artwork::to_data_url(&bytes))
        .await
        .map_err(|error| error.to_string())?
    {
        Ok(url) => Ok(Some(url)),
        // A format or size the decoder refuses comes back the same on every retry.
        Err(error) => {
            unusable_artwork(player, &error);
            Ok(None)
        }
    }
}

/// Logs the first cover that cannot be used; tracks like it then simply show none.
fn unusable_artwork(player: Player, error: &str) {
    static LOGGED: AtomicBool = AtomicBool::new(false);
    if !LOGGED.swap(true, Ordering::Relaxed) {
        eprintln!(
            "{} artwork unusable, shown without a cover: {error}",
            player.name()
        );
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// Spotify's cover from its CDN, bounded like every artwork source.
async fn download(http: &reqwest::Client, url: reqwest::Url) -> Result<Vec<u8>, String> {
    let mut response = http
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "artwork returned HTTP {}",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > artwork::MAX_ARTWORK_BYTES as u64)
    {
        return Err("artwork exceeds size limit".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if bytes.len() + chunk.len() > artwork::MAX_ARTWORK_BYTES {
            return Err("artwork exceeds size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Runs `work` on the main thread, where AppKit and NSAppleScript live, and waits for it.
async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(work());
    })
    .map_err(|error| error.to_string())?;
    match tokio::time::timeout(MAIN_THREAD_WAIT, receiver).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err("the main thread dropped the request".into()),
        Err(_) => Err("the main thread did not answer within 3 s".into()),
    }
}

/// Which players run. NSWorkspace's list is thread-safe, and checking it first means a closed
/// player is never sent an Apple event: `tell application` would launch it.
fn running_players() -> Vec<Player> {
    autoreleasepool(|_| {
        let apps = NSWorkspace::sharedWorkspace().runningApplications();
        Player::ALL
            .into_iter()
            .filter(|player| {
                let bundle_id = NSString::from_str(player.bundle_id());
                apps.iter().any(|app| {
                    !app.isTerminated()
                        && app
                            .bundleIdentifier()
                            .is_some_and(|id| id.isEqualToString(&bundle_id))
                })
            })
            .collect()
    })
}

thread_local! {
    /// Main thread only. Compiling loads the player's scripting dictionary, so it happens once,
    /// on first use, when the player is known to run (and so to be installed).
    static COMPILED: RefCell<HashMap<Script, Retained<NSAppleScript>>> =
        RefCell::new(HashMap::new());
    /// Main thread only: scripts this player version rejected, and when. They are compiled again
    /// after `RECOMPILE_AFTER`, not on every poll.
    static REJECTED: RefCell<HashMap<Script, (Instant, Failure)>> = RefCell::new(HashMap::new());
}
const RECOMPILE_AFTER: Duration = Duration::from_secs(60);

fn compiled(script: Script) -> Result<Retained<NSAppleScript>, Failure> {
    MainThreadMarker::new()
        .ok_or_else(|| Failure::other("AppleScript used off the main thread"))?;
    if let Some(found) = COMPILED.with(|cache| cache.borrow().get(&script).cloned()) {
        return Ok(found);
    }
    let rejected = REJECTED.with(|rejected| {
        rejected
            .borrow()
            .get(&script)
            .filter(|(at, _)| at.elapsed() < RECOMPILE_AFTER)
            .map(|(_, failure)| failure.clone())
    });
    if let Some(failure) = rejected {
        return Err(failure);
    }
    let source = NSString::from_str(script.source());
    let compiled = NSAppleScript::initWithSource(NSAppleScript::alloc(), &source)
        .ok_or_else(|| Failure::other("NSAppleScript rejected the script source"))?;
    let mut info = None;
    // SAFETY: the out-parameter is the NSDictionary<NSString, id> the method documents.
    if !unsafe { compiled.compileAndReturnError(Some(&mut info)) } {
        let failure = failure(info.as_deref());
        REJECTED.with(|rejected| {
            rejected
                .borrow_mut()
                .insert(script, (Instant::now(), failure.clone()))
        });
        return Err(failure);
    }
    COMPILED.with(|cache| cache.borrow_mut().insert(script, compiled.clone()));
    Ok(compiled)
}

fn execute(script: &NSAppleScript) -> Result<Retained<NSAppleEventDescriptor>, Failure> {
    let mut info: Option<Retained<NSDictionary<NSString, AnyObject>>> = None;
    // SAFETY: `executeAndReturnError:` takes that same out-parameter. It returns nil on failure,
    // which the generated binding (a non-optional descriptor) would turn into a panic, so the
    // result is read as an Option.
    let result: Option<Retained<NSAppleEventDescriptor>> =
        unsafe { msg_send![script, executeAndReturnError: &mut info] };
    result.ok_or_else(|| failure(info.as_deref()))
}

fn failure(info: Option<&NSDictionary<NSString, AnyObject>>) -> Failure {
    let Some(info) = info else {
        return Failure::other("AppleScript failed without details");
    };
    // SAFETY: Foundation's immutable NSString key constants.
    let (number_key, message_key) =
        unsafe { (NSAppleScriptErrorNumber, NSAppleScriptErrorMessage) };
    let number = info
        .objectForKey(number_key)
        .and_then(|value| value.downcast::<NSNumber>().ok())
        .map(|number| number.as_i64());
    let message = info
        .objectForKey(message_key)
        .and_then(|value| value.downcast::<NSString>().ok())
        .map(|message| message.to_string())
        .unwrap_or_default();
    Failure::new(number, message)
}

/// Main thread: one player's answer, stamped halfway through the call that produced it.
fn read_on_main(script: Script) -> Result<(String, f64), Failure> {
    autoreleasepool(|_| {
        let compiled = compiled(script)?;
        let before = epoch_ms();
        let result = execute(&compiled);
        let after = epoch_ms();
        let text = result?
            .stringValue()
            .map(|text| text.to_string())
            .unwrap_or_default();
        Ok((text, applescript::midpoint(before, after)))
    })
}

/// Main thread: the current Music track's artwork bytes, or `None` when it has none.
fn music_artwork_on_main() -> Result<Option<Vec<u8>>, Failure> {
    const MISSING_VALUE: u32 = u32::from_be_bytes(*b"msng");
    autoreleasepool(|_| {
        let compiled = compiled(Script::MusicArtwork)?;
        let descriptor = execute(&compiled)?;
        if descriptor.typeCodeValue() == MISSING_VALUE {
            return Ok(None);
        }
        let data = descriptor.data();
        if data.len() > artwork::MAX_ARTWORK_BYTES {
            // As final as a format the decoder refuses: no retry.
            unusable_artwork(Player::Music, "artwork exceeds 8 MiB");
            return Ok(None);
        }
        Ok((!data.is_empty()).then(|| data.to_vec()))
    })
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and WakeObserver does not implement Drop.
    #[unsafe(super(NSObject))]
    #[name = "UndertoneMediaWakeObserver"]
    #[ivars = Arc<Notify>]
    struct WakeObserver;

    impl WakeObserver {
        #[unsafe(method(playerChanged:))]
        fn player_changed(&self, _notification: &NSNotification) {
            self.ivars().notify_one();
        }
    }

    unsafe impl NSObjectProtocol for WakeObserver {}
);
impl WakeObserver {
    fn new(wake: Arc<Notify>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(wake);
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

/// Main thread, once: wake the loop on the players' distributed notifications. AppKit suspends
/// distributed delivery while the app is inactive (always, for a menu bar app), so these ask for
/// immediate delivery, which only the selector-based API offers.
fn observe_players(wake: Arc<Notify>) {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let observer = WakeObserver::new(wake);
        let center = NSDistributedNotificationCenter::defaultCenter();
        for player in Player::ALL {
            let name = NSString::from_str(player.notification());
            // SAFETY: `playerChanged:` is defined above and takes the posted NSNotification.
            unsafe {
                center.addObserver_selector_name_object_suspensionBehavior(
                    &observer,
                    sel!(playerChanged:),
                    Some(&name),
                    None,
                    NSNotificationSuspensionBehavior::DeliverImmediately,
                );
            }
        }
        // The center does not retain its observers; this one lives as long as the app.
        std::mem::forget(observer);
    });
}

/// Asks macOS whether Undertone may send Apple events to `bundle_id`, showing the Automation
/// prompt if the user has not decided yet. It blocks until they answer, so it runs on a blocking
/// thread, never the main one. A player that is not running answers procNotFound (-600) and is
/// never launched.
fn automation_permission(bundle_id: &str) -> i32 {
    const TYPE_APPLICATION_BUNDLE_ID: u32 = u32::from_be_bytes(*b"bund");
    const TYPE_WILD_CARD: u32 = u32::from_be_bytes(*b"****");
    /// Room for an AEDesc (a type code and a handle: 12 or 16 bytes depending on packing).
    /// Only CoreServices reads or writes it, so its exact layout never matters here.
    #[repr(C, align(8))]
    struct AEDesc([u8; 16]);
    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn AECreateDesc(
            type_code: u32,
            data: *const std::ffi::c_void,
            size: isize,
            result: *mut AEDesc,
        ) -> i16;
        fn AEDisposeDesc(desc: *mut AEDesc) -> i16;
        fn AEDeterminePermissionToAutomateTarget(
            target: *const AEDesc,
            event_class: u32,
            event_id: u32,
            ask_user_if_needed: u8,
        ) -> i32;
    }
    let mut target = AEDesc([0; 16]);
    // SAFETY: AECreateDesc copies `bundle_id`'s bytes into `target`, which is then only passed
    // back to CoreServices and disposed of exactly once, and only after it was created.
    unsafe {
        let created = AECreateDesc(
            TYPE_APPLICATION_BUNDLE_ID,
            bundle_id.as_ptr().cast(),
            bundle_id.len() as isize,
            &mut target,
        );
        if created != 0 {
            return created.into();
        }
        let status =
            AEDeterminePermissionToAutomateTarget(&target, TYPE_WILD_CARD, TYPE_WILD_CARD, 1);
        AEDisposeDesc(&mut target);
        status
    }
}
