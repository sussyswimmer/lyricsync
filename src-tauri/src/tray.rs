//! X5 tray / menu bar. What the menu shows (labels, check marks, enabled items, tooltip) is a pure
//! function of settings, now playing and the runtime flags, tested on every OS; `runtime` builds
//! the native menu, keeps it in step with `settings-changed` and `now-playing`, and runs clicks.
use crate::contract::{Mode, NowPlaying, Settings};

/// Tray sync step. Positive offsets show lyrics earlier, as in the settings window.
pub const TRAY_NUDGE_MS: f64 = 100.0;
/// The ±2000 ms bound settings clamp a song's offset to (SPEC).
pub const MAX_OFFSET_MS: f64 = 2000.0;
/// Windows copies tooltips into a 128-unit UTF-16 buffer that must keep its terminating null.
const MAX_TOOLTIP_UTF16: usize = 127;

const LYRICS: &str = "tray.lyrics";
const EARLIER: &str = "tray.sync.earlier";
const LATER: &str = "tray.sync.later";
const RESET: &str = "tray.sync.reset";
const REFETCH: &str = "tray.refetch";
const SETTINGS: &str = "tray.settings";
const LAUNCH_AT_LOGIN: &str = "tray.launch-at-login";
const QUIT: &str = "tray.quit";
/// Style ▸ items, in menu order: mode, menu id, label.
pub const STYLES: [(Mode, &str, &str); 4] = [
    (Mode::Arc, "tray.style.arc", "Arc"),
    (Mode::Lens, "tray.style.lens", "Lens"),
    (Mode::Drift, "tray.style.drift", "Drift"),
    (Mode::Stack, "tray.style.stack", "Stack"),
];

/// What a menu click asks for.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    ToggleLyrics,
    Style(Mode),
    /// Adds this many ms to the current song's offset.
    Nudge(f64),
    ResetOffset,
    Refetch,
    Settings,
    LaunchAtLogin,
    Quit,
}
/// Maps a menu id to its action. Other menus' ids (the app menu on macOS) map to nothing.
pub fn action(id: &str) -> Option<Action> {
    Some(match id {
        LYRICS => Action::ToggleLyrics,
        EARLIER => Action::Nudge(TRAY_NUDGE_MS),
        LATER => Action::Nudge(-TRAY_NUDGE_MS),
        RESET => Action::ResetOffset,
        REFETCH => Action::Refetch,
        SETTINGS => Action::Settings,
        LAUNCH_AT_LOGIN => Action::LaunchAtLogin,
        QUIT => Action::Quit,
        _ => STYLES
            .iter()
            .find(|(_, style, _)| *style == id)
            .map(|(mode, ..)| Action::Style(mode.clone()))?,
    })
}

/// The part of now playing the menu needs; the artwork stays behind.
#[derive(Debug, Clone, PartialEq)]
pub struct Track {
    pub key: String,
    pub title: String,
    pub artist: String,
    pub is_playing: bool,
}
impl From<&NowPlaying> for Track {
    fn from(now: &NowPlaying) -> Self {
        Self {
            key: now.track_key.clone(),
            title: now.title.clone(),
            artist: now.artist.clone(),
            is_playing: now.is_playing,
        }
    }
}

/// Everything the menu depends on. `offset_ms` is the current song's offset (0 without a song).
#[derive(Debug, Clone, PartialEq)]
pub struct Inputs {
    pub mode: Mode,
    pub track: Option<Track>,
    pub offset_ms: f64,
    pub hidden: bool,
    pub autostart: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MenuState {
    pub lyrics_label: &'static str,
    /// The one checked Style ▸ item.
    pub mode: Mode,
    pub earlier_enabled: bool,
    pub later_enabled: bool,
    pub reset_label: String,
    pub reset_enabled: bool,
    pub refetch_enabled: bool,
    pub autostart: bool,
    pub tooltip: String,
}
/// Sync and refetch act on the current song, playing or paused, so they need one. A nudge that
/// can't move past the ±2000 ms bound is disabled, and so is a reset with nothing to reset.
pub fn menu_state(inputs: &Inputs) -> MenuState {
    let offset = inputs.track.as_ref().map(|_| inputs.offset_ms);
    MenuState {
        lyrics_label: if inputs.hidden {
            "Show lyrics"
        } else {
            "Hide lyrics"
        },
        mode: inputs.mode.clone(),
        earlier_enabled: offset.is_some_and(|ms| ms < MAX_OFFSET_MS),
        later_enabled: offset.is_some_and(|ms| ms > -MAX_OFFSET_MS),
        reset_label: reset_label(offset.unwrap_or(0.0)),
        reset_enabled: offset.is_some_and(|ms| ms != 0.0),
        refetch_enabled: inputs.track.is_some(),
        autostart: inputs.autostart,
        tooltip: tooltip(inputs.track.as_ref()),
    }
}

/// "Reset for this song", with the current offset in the same words as the nudge items.
pub fn reset_label(offset_ms: f64) -> String {
    let ms = offset_ms.round() as i64;
    match ms {
        0 => "Reset for this song".into(),
        ms if ms > 0 => format!("Reset for this song ({ms} ms earlier)"),
        ms => format!("Reset for this song ({} ms later)", ms.unsigned_abs()),
    }
}

/// "Undertone", plus the song while one is playing.
pub fn tooltip(track: Option<&Track>) -> String {
    let Some(track) = track.filter(|track| track.is_playing && !track.title.trim().is_empty())
    else {
        return "Undertone".into();
    };
    let text = match track.artist.trim() {
        "" => format!("Undertone · {}", track.title.trim()),
        artist => format!("Undertone · {} — {artist}", track.title.trim()),
    };
    truncate_utf16(&text, MAX_TOOLTIP_UTF16)
}
/// Cuts `text` to at most `max` UTF-16 units, ending in "…" when cut. Never splits a character.
fn truncate_utf16(text: &str, max: usize) -> String {
    if text.encode_utf16().count() <= max {
        return text.into();
    }
    let mut units = 1; // the ellipsis
    let mut out: String = text
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect();
    out.truncate(out.trim_end().len());
    out.push('…');
    out
}

/// A song's offset; missing or unusable values count as 0.
pub fn track_offset(settings: &Settings, key: &str) -> f64 {
    settings
        .track_offsets_ms
        .get(key)
        .copied()
        .filter(|ms| ms.is_finite())
        .unwrap_or(0.0)
}
/// The offset after one nudge, kept within ±2000 ms.
pub fn nudged(current_ms: f64, delta_ms: f64) -> f64 {
    (current_ms + delta_ms).clamp(-MAX_OFFSET_MS, MAX_OFFSET_MS)
}

/// Decodes a bundled PNG into the RGBA pixels the tray takes.
pub fn decode_icon(png: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let image = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?
        .into_rgba8();
    let (width, height) = image.dimensions();
    Ok((image.into_raw(), width, height))
}

#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
mod runtime {
    use super::{Action, Inputs, MenuState, Track};
    use crate::{
        contract::{Mode, NOW_PLAYING_EVENT, SETTINGS_CHANGED_EVENT},
        state::AppState,
    };
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };
    use tauri::{
        image::Image,
        menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
        tray::{TrayIconBuilder, TrayIconEvent},
        AppHandle, Listener, Manager, Wry,
    };
    use tauri_plugin_autostart::AutoLaunchManager;

    const TRAY_ID: &str = "undertone";
    /// macOS: an 18 pt @2x template the menu bar tints for light and dark. Windows has no
    /// tinting, so it gets the glyph on an amber tile that reads on either taskbar.
    #[cfg(target_os = "macos")]
    const ICON: &[u8] = include_bytes!("../icons/tray-template.png");
    #[cfg(not(target_os = "macos"))]
    const ICON: &[u8] = include_bytes!("../icons/tray.png");

    /// The items whose text, marks or enabled state change, plus what was last shown.
    struct Tray {
        lyrics: MenuItem<Wry>,
        styles: Vec<(Mode, CheckMenuItem<Wry>)>,
        earlier: MenuItem<Wry>,
        later: MenuItem<Wry>,
        reset: MenuItem<Wry>,
        refetch: MenuItem<Wry>,
        launch_at_login: CheckMenuItem<Wry>,
        /// The real autostart state, read at start, after a toggle and when the pointer enters
        /// the icon (the user can change it in the OS).
        autostart: AtomicBool,
        shown: Mutex<Option<MenuState>>,
    }

    pub fn install(app: &AppHandle) -> Result<(), String> {
        build(app).map_err(|e| e.to_string())?;
        for event in [SETTINGS_CHANGED_EVENT, NOW_PLAYING_EVENT] {
            let handle = app.clone();
            app.listen_any(event, move |_| refresh(&handle, false));
        }
        // Anything that changed while the menu was being built.
        refresh(app, false);
        Ok(())
    }

    fn build(app: &AppHandle) -> tauri::Result<()> {
        let autostart = autostart_enabled(app).unwrap_or(false);
        let state = super::menu_state(&inputs(app, autostart));
        let lyrics = MenuItem::with_id(app, super::LYRICS, state.lyrics_label, true, None::<&str>)?;
        let styles = super::STYLES
            .iter()
            .map(|(mode, id, label)| {
                CheckMenuItem::with_id(app, *id, *label, true, *mode == state.mode, None::<&str>)
                    .map(|item| (mode.clone(), item))
            })
            .collect::<tauri::Result<Vec<_>>>()?;
        let earlier = MenuItem::with_id(
            app,
            super::EARLIER,
            format!("Earlier {} ms", super::TRAY_NUDGE_MS),
            state.earlier_enabled,
            None::<&str>,
        )?;
        let later = MenuItem::with_id(
            app,
            super::LATER,
            format!("Later {} ms", super::TRAY_NUDGE_MS),
            state.later_enabled,
            None::<&str>,
        )?;
        let reset = MenuItem::with_id(
            app,
            super::RESET,
            &state.reset_label,
            state.reset_enabled,
            None::<&str>,
        )?;
        let refetch = MenuItem::with_id(
            app,
            super::REFETCH,
            "Refetch lyrics",
            state.refetch_enabled,
            None::<&str>,
        )?;
        let settings = MenuItem::with_id(app, super::SETTINGS, "Settings…", true, None::<&str>)?;
        let launch_at_login = CheckMenuItem::with_id(
            app,
            super::LAUNCH_AT_LOGIN,
            "Launch at login",
            true,
            state.autostart,
            None::<&str>,
        )?;
        let quit = MenuItem::with_id(app, super::QUIT, "Quit Undertone", true, None::<&str>)?;

        let style_items: Vec<&dyn IsMenuItem<Wry>> = styles
            .iter()
            .map(|(_, item)| item as &dyn IsMenuItem<Wry>)
            .collect();
        let style = Submenu::with_items(app, "Style", true, &style_items)?;
        let sync = Submenu::with_items(app, "Sync", true, &[&earlier, &later, &reset])?;
        let menu = Menu::with_items(
            app,
            &[
                &lyrics,
                &PredefinedMenuItem::separator(app)?,
                &style,
                &sync,
                &refetch,
                &PredefinedMenuItem::separator(app)?,
                &settings,
                &launch_at_login,
                &PredefinedMenuItem::separator(app)?,
                &quit,
            ],
        )?;

        let (rgba, width, height) = super::decode_icon(ICON).map_err(std::io::Error::other)?;
        TrayIconBuilder::with_id(TRAY_ID)
            .icon(Image::new_owned(rgba, width, height))
            .icon_as_template(cfg!(target_os = "macos"))
            .tooltip(&state.tooltip)
            .menu(&menu)
            // macOS always opens the menu on click; Windows would otherwise want a right click.
            .show_menu_on_left_click(true)
            .on_menu_event(|app, event| handle(app, event.id().as_ref()))
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Enter { .. } = event {
                    read_autostart(tray.app_handle());
                    refresh(tray.app_handle(), false);
                }
            })
            .build(app)?;

        app.manage(Tray {
            lyrics,
            styles,
            earlier,
            later,
            reset,
            refetch,
            launch_at_login,
            autostart: AtomicBool::new(autostart),
            shown: Mutex::new(Some(state)),
        });
        Ok(())
    }

    /// Reads the inputs one lock at a time, never across an emit, so a listener can't deadlock
    /// with the media loop or a settings change.
    fn inputs(app: &AppHandle, autostart: bool) -> Inputs {
        let state = app.state::<AppState>();
        let track = state
            .now_playing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(Track::from);
        let (mode, offset_ms) = {
            let settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
            let offset = track
                .as_ref()
                .map_or(0.0, |track| super::track_offset(&settings, &track.key));
            (settings.mode.clone(), offset)
        };
        Inputs {
            mode,
            track,
            offset_ms,
            hidden: state.lyrics_hidden.load(Ordering::Acquire),
            autostart,
        }
    }

    /// Brings the menu up to date. Cheap when nothing it shows changed (now-playing resyncs every
    /// second). The update itself runs on the main thread, which re-reads the inputs, so the
    /// last update applied always reflects the latest state. `force` re-applies everything:
    /// check items toggle themselves when clicked, even when the click changes nothing.
    fn refresh(app: &AppHandle, force: bool) {
        let Some(tray) = app.try_state::<Tray>() else {
            return;
        };
        if !force {
            let next = super::menu_state(&inputs(app, tray.autostart.load(Ordering::Acquire)));
            if tray
                .shown
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                == Some(&next)
            {
                return;
            }
        }
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            if let Some(tray) = handle.try_state::<Tray>() {
                tray.update(&handle, force);
            }
        }) {
            eprintln!("tray refresh: {error}");
        }
    }

    impl Tray {
        /// Main thread only: menu setters there run inline instead of waiting on the event loop.
        fn update(&self, app: &AppHandle, force: bool) {
            let next = super::menu_state(&inputs(app, self.autostart.load(Ordering::Acquire)));
            let mut shown = self.shown.lock().unwrap_or_else(|e| e.into_inner());
            if !force && shown.as_ref() == Some(&next) {
                return;
            }
            let mut results = vec![
                self.lyrics.set_text(next.lyrics_label),
                self.earlier.set_enabled(next.earlier_enabled),
                self.later.set_enabled(next.later_enabled),
                self.reset.set_text(&next.reset_label),
                self.reset.set_enabled(next.reset_enabled),
                self.refetch.set_enabled(next.refetch_enabled),
                self.launch_at_login.set_checked(next.autostart),
            ];
            for (mode, item) in &self.styles {
                results.push(item.set_checked(*mode == next.mode));
            }
            if let Some(icon) = app.tray_by_id(TRAY_ID) {
                results.push(icon.set_tooltip(Some(&next.tooltip)));
            }
            // A change that failed (Windows: the taskbar isn't up yet, or Explorer is restarting)
            // isn't taken as shown, so the next event applies it again. Logged once per streak.
            let errors: Vec<_> = results.into_iter().filter_map(Result::err).collect();
            if shown.is_some() {
                for error in &errors {
                    eprintln!("tray update: {error}");
                }
            }
            *shown = errors.is_empty().then_some(next);
        }
    }

    fn handle(app: &AppHandle, id: &str) {
        let Some(action) = super::action(id) else {
            return;
        };
        let result = match action {
            Action::ToggleLyrics => {
                toggle_lyrics(app);
                Ok(())
            }
            Action::Style(mode) => {
                crate::settings::runtime::update(app, &serde_json::json!({ "mode": mode }))
                    .map(drop)
            }
            Action::Nudge(delta_ms) => nudge(app, delta_ms),
            Action::ResetOffset => current_key(app).and_then(|key| {
                crate::settings::runtime::set_track_offset(app, &key, 0.0).map(drop)
            }),
            Action::Refetch => refetch(app),
            Action::Settings => crate::commands::show_settings(app),
            Action::LaunchAtLogin => toggle_launch_at_login(app),
            Action::Quit => {
                app.exit(0);
                return;
            }
        };
        if let Err(error) = result {
            eprintln!("tray: {error}");
        }
        refresh(app, true);
    }

    /// Tray "Hide lyrics" / "Show lyrics" and Cmd/Ctrl+Alt+Shift+L.
    pub fn toggle_lyrics(app: &AppHandle) {
        app.state::<AppState>()
            .lyrics_hidden
            .fetch_xor(true, Ordering::AcqRel);
        crate::desktop_layer::refresh_now();
        refresh(app, false);
    }

    /// Moves the current song's lyrics `delta_ms` earlier (negative: later). Tray and shortcuts.
    pub fn nudge(app: &AppHandle, delta_ms: f64) -> Result<(), String> {
        let key = current_key(app)?;
        let current = super::track_offset(&crate::settings::runtime::current(app)?, &key);
        crate::settings::runtime::set_track_offset(app, &key, super::nudged(current, delta_ms))
            .map(drop)
    }

    fn current_key(app: &AppHandle) -> Result<String, String> {
        app.state::<AppState>()
            .now_playing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|track| track.track_key.clone())
            .ok_or_else(|| "nothing is playing".into())
    }

    /// The lookup starts on the async runtime: menu clicks arrive on the main thread, outside it.
    fn refetch(app: &AppHandle) -> Result<(), String> {
        let key = current_key(app)?;
        let service = app
            .try_state::<Arc<crate::lyrics::Service>>()
            .ok_or("lyrics service unavailable")?
            .inner()
            .clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = service.refetch(&key) {
                eprintln!("refetch lyrics: {error}");
            }
        });
        Ok(())
    }

    fn toggle_launch_at_login(app: &AppHandle) -> Result<(), String> {
        let launcher = app
            .try_state::<AutoLaunchManager>()
            .ok_or("autostart unavailable")?;
        let result = match launcher.is_enabled() {
            Ok(true) => launcher.disable(),
            Ok(false) => launcher.enable(),
            Err(error) => Err(error),
        };
        read_autostart(app);
        result.map_err(|e| format!("launch at login: {e}"))
    }

    fn autostart_enabled(app: &AppHandle) -> Option<bool> {
        match app.try_state::<AutoLaunchManager>()?.is_enabled() {
            Ok(enabled) => Some(enabled),
            Err(error) => {
                eprintln!("launch at login: {error}");
                None
            }
        }
    }
    fn read_autostart(app: &AppHandle) {
        if let (Some(tray), Some(enabled)) = (app.try_state::<Tray>(), autostart_enabled(app)) {
            tray.autostart.store(enabled, Ordering::Release);
        }
    }
}
#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
pub use runtime::{install, nudge, toggle_lyrics};

#[cfg(test)]
mod tests {
    use super::*;

    fn track(playing: bool) -> Track {
        Track {
            key: "placeholder artist|paper lanterns|demo|180".into(),
            title: "Paper Lanterns".into(),
            artist: "Placeholder Artist".into(),
            is_playing: playing,
        }
    }
    fn inputs(track: Option<Track>, offset_ms: f64) -> Inputs {
        Inputs {
            mode: Mode::Arc,
            track,
            offset_ms,
            hidden: false,
            autostart: false,
        }
    }

    #[test]
    fn nothing_playing_disables_song_actions() {
        let state = menu_state(&inputs(None, 0.0));
        assert!(!state.earlier_enabled && !state.later_enabled && !state.reset_enabled);
        assert!(!state.refetch_enabled);
        assert_eq!(state.reset_label, "Reset for this song");
        assert_eq!(state.tooltip, "Undertone");
    }
    #[test]
    fn a_song_enables_sync_and_refetch_even_paused() {
        for playing in [true, false] {
            let state = menu_state(&inputs(Some(track(playing)), 0.0));
            assert!(state.earlier_enabled && state.later_enabled && state.refetch_enabled);
            assert!(!state.reset_enabled, "nothing to reset at 0 ms");
        }
        let state = menu_state(&inputs(Some(track(true)), -50.0));
        assert!(state.reset_enabled);
        assert_eq!(state.reset_label, "Reset for this song (50 ms later)");
    }
    #[test]
    fn nudges_stop_at_the_offset_bounds() {
        let top = menu_state(&inputs(Some(track(true)), MAX_OFFSET_MS));
        assert!(!top.earlier_enabled && top.later_enabled);
        let bottom = menu_state(&inputs(Some(track(true)), -MAX_OFFSET_MS));
        assert!(bottom.earlier_enabled && !bottom.later_enabled);
    }
    #[test]
    fn hide_label_mode_and_autostart_follow_inputs() {
        let mut given = inputs(None, 0.0);
        assert_eq!(menu_state(&given).lyrics_label, "Hide lyrics");
        given.hidden = true;
        given.mode = Mode::Drift;
        given.autostart = true;
        let state = menu_state(&given);
        assert_eq!(state.lyrics_label, "Show lyrics");
        assert_eq!(state.mode, Mode::Drift);
        assert!(state.autostart);
    }
    #[test]
    fn reset_label_says_which_way() {
        assert_eq!(reset_label(0.0), "Reset for this song");
        assert_eq!(reset_label(0.4), "Reset for this song");
        assert_eq!(reset_label(150.0), "Reset for this song (150 ms earlier)");
        assert_eq!(reset_label(-2000.0), "Reset for this song (2000 ms later)");
    }
    #[test]
    fn tooltip_names_the_song_only_while_playing() {
        assert_eq!(
            tooltip(Some(&track(true))),
            "Undertone · Paper Lanterns — Placeholder Artist"
        );
        assert_eq!(tooltip(Some(&track(false))), "Undertone");
        let mut untitled = track(true);
        untitled.title = "  ".into();
        assert_eq!(tooltip(Some(&untitled)), "Undertone");
        let mut solo = track(true);
        solo.artist = String::new();
        assert_eq!(tooltip(Some(&solo)), "Undertone · Paper Lanterns");
    }
    #[test]
    fn tooltip_fits_the_windows_buffer() {
        let mut long = track(true);
        long.title = "Lantern ".repeat(30);
        let text = tooltip(Some(&long));
        assert!(text.encode_utf16().count() <= MAX_TOOLTIP_UTF16);
        assert!(text.ends_with('…') && !text.ends_with(" …"));
        // Astral characters are two UTF-16 units and must not be split.
        let wide = truncate_utf16(&"🏮".repeat(80), 9);
        assert_eq!(wide, "🏮🏮🏮🏮…");
        assert_eq!(truncate_utf16("Tiếng Việt 歌词", 127), "Tiếng Việt 歌词");
    }
    #[test]
    fn nudge_arithmetic() {
        assert_eq!(nudged(0.0, TRAY_NUDGE_MS), 100.0);
        assert_eq!(nudged(30.0, -50.0), -20.0);
        assert_eq!(nudged(1950.0, TRAY_NUDGE_MS), MAX_OFFSET_MS);
        assert_eq!(nudged(-1990.0, -50.0), -MAX_OFFSET_MS);
        let mut settings = Settings::default();
        assert_eq!(track_offset(&settings, "a|b|c|1"), 0.0);
        settings.track_offsets_ms.insert("a|b|c|1".into(), -250.0);
        settings.track_offsets_ms.insert("bad".into(), f64::NAN);
        assert_eq!(track_offset(&settings, "a|b|c|1"), -250.0);
        assert_eq!(track_offset(&settings, "bad"), 0.0);
    }
    #[test]
    fn menu_ids_map_to_actions() {
        // Positive is earlier.
        assert_eq!(action(EARLIER), Some(Action::Nudge(100.0)));
        assert_eq!(action(LATER), Some(Action::Nudge(-100.0)));
        assert_eq!(action(RESET), Some(Action::ResetOffset));
        assert_eq!(action("tray.style.lens"), Some(Action::Style(Mode::Lens)));
        assert_eq!(action("quit"), None, "predefined app-menu ids are not ours");
        let mut ids = vec![
            LYRICS,
            EARLIER,
            LATER,
            RESET,
            REFETCH,
            SETTINGS,
            LAUNCH_AT_LOGIN,
            QUIT,
        ];
        ids.extend(STYLES.iter().map(|(_, id, _)| *id));
        assert!(ids.iter().all(|id| action(id).is_some()));
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "menu ids are unique");
    }
    #[test]
    fn track_summary_drops_artwork() {
        let now = NowPlaying {
            source: crate::contract::Source::Spotify,
            track_key: "k".into(),
            title: "T".into(),
            artist: "A".into(),
            album: "Al".into(),
            duration_ms: 1000.0,
            position_ms: 0.0,
            sampled_at: 0.0,
            is_playing: true,
            artwork: Some("data:image/png;base64,AAAA".into()),
        };
        assert_eq!(
            Track::from(&now),
            Track {
                key: "k".into(),
                title: "T".into(),
                artist: "A".into(),
                is_playing: true
            }
        );
    }
    #[test]
    fn bundled_icons_decode() {
        let (rgba, width, height) =
            decode_icon(include_bytes!("../icons/tray-template.png")).expect("macOS template icon");
        assert_eq!((width, height), (36, 36), "18 pt at 2x");
        // A template image is black; only alpha carries the glyph.
        assert!(rgba.chunks(4).all(|px| px[..3] == [0, 0, 0]));
        assert!(rgba.chunks(4).any(|px| px[3] == 255));
        assert!(rgba.chunks(4).any(|px| px[3] == 0));
        let (rgba, width, height) =
            decode_icon(include_bytes!("../icons/tray.png")).expect("Windows icon");
        assert_eq!((width, height), (32, 32));
        assert_eq!(rgba.len(), 32 * 32 * 4);
        assert!(decode_icon(b"not a png").is_err());
    }
}
