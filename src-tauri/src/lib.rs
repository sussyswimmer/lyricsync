// First: `applog!` is in scope in every module declared after it.
#[macro_use]
pub mod applog;

#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
mod commands;
pub mod contract;
pub mod desktop_layer;
pub mod diagnose;
pub mod login_item;
pub mod lyrics;
pub mod media;
pub mod settings;
pub mod shortcuts;
pub mod state;
pub mod tray;

#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
const DESKTOP_TEST_PAGE: &str = "(()=>{document.body.style.cssText='margin:0;background:transparent;\
color:#f2a65a;font:48px sans-serif;display:grid;place-items:center;height:100vh;text-align:center';\
const app=document.getElementById('app');app.style.whiteSpace='pre-line';let frames=0,hidden=0;\
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')hidden++;});\
const draw=()=>{frames++;app.textContent='Undertone desktop layer — drag a folder over this text\\n'\
+'frame '+frames+' · hidden '+hidden+' times';requestAnimationFrame(draw);};requestAnimationFrame(draw);})();";

/// The commit this build is from (`build.rs`): CI's, git's, or "dev".
pub const BUILD: &str = env!("UNDERTONE_BUILD");

/// The executable on disk as it was when it was read: its size and when it was written. A new
/// Undertone installed over a running one changes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExeStamp {
    len: u64,
    modified: std::time::SystemTime,
}

pub fn exe_stamp(path: &std::path::Path) -> Option<ExeStamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some(ExeStamp {
        len: meta.len(),
        modified: meta.modified().ok()?,
    })
}

/// Whether the app on disk is no longer the one running: an update was installed over it. A
/// second launch then restarts this instance into the new build, instead of only showing Settings
/// (single-instance hands every second launch to the running one, so opening the new app would
/// otherwise keep the old one running).
pub fn replaced_on_disk(started: Option<ExeStamp>, now: Option<ExeStamp>) -> bool {
    matches!((started, now), (Some(started), Some(now)) if started != now)
}

/// `--look=<style>[,<family>[,<curve>]]`, in debug and release builds: every overlay page draws with
/// that style, and optionally that face and Arc's curve, instead of the look Undertone picks per
/// song, as `?look=` does on the overlay page in a browser. For checking one style on purpose
/// (docs/ACCEPTANCE.md's CPU checks) and for support; never stored.
pub const LOOK_FLAG: &str = "--look";
/// A forced look is at most three short parts; anything longer isn't one.
const LOOK_MAX_CHARS: usize = 120;

/// The last `--look=<value>` among the app's arguments: `None` without one, `Some(Err)` with why a
/// value is malformed (empty, not UTF-8, too long, control characters, more than three parts), which
/// Undertone then ignores. Rust only checks the shape: the overlay validates the style, face and
/// curve, as it does `?look=`, and keeps the pick for any part it can't use.
pub fn look_arg(
    args: impl IntoIterator<Item = std::ffi::OsString>,
) -> Option<Result<String, String>> {
    let mut found = None;
    for arg in args {
        let Some(text) = arg.to_str() else {
            let lossy = arg.to_string_lossy();
            if lossy.starts_with(LOOK_FLAG) {
                found = Some(Err(format!("{LOOK_FLAG}: not UTF-8: {lossy}")));
            }
            continue;
        };
        let Some(rest) = text.strip_prefix(LOOK_FLAG) else {
            continue;
        };
        found = match rest.strip_prefix('=') {
            Some(value) => Some(look_value(value)),
            None if rest.is_empty() => Some(Err(format!(
                "{LOOK_FLAG} needs a value: {LOOK_FLAG}=<style>[,<family>[,<curve>]]"
            ))),
            // Another flag (`--looks`, `--lookup`).
            None => continue,
        };
    }
    found
}

fn look_value(value: &str) -> Result<String, String> {
    let malformed = |why: &str| Err(format!("{LOOK_FLAG}={value:?} ignored: {why}"));
    if value.trim().is_empty() {
        return malformed("empty");
    }
    if value.chars().count() > LOOK_MAX_CHARS {
        return malformed("too long");
    }
    if value.chars().any(char::is_control) {
        return malformed("control characters");
    }
    if value.split(',').count() > 3 {
        return malformed("more than <style>,<family>,<curve>");
    }
    Ok(value.to_owned())
}

/// The script an overlay page runs as it finishes loading: the forced look as a JSON string, which
/// nothing in it can end early, and the event the overlay listens for (it also reads the global at
/// startup, so the order the two happen in doesn't matter).
pub fn look_script(look: &str) -> String {
    // JSON escapes quotes, backslashes and control characters; U+2028 and U+2029 are line ends in
    // older JavaScript engines, so they are escaped too.
    let literal = serde_json::Value::from(look)
        .to_string()
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!("window.__UNDERTONE_LOOK__={literal};dispatchEvent(new Event(\"undertone-look\"))")
}

/// Starts the runtime log (`applog`) in the dir `--diagnose` reads, before anything can fail.
#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
fn start_log() {
    let var = |name: &str| std::env::var_os(name);
    match diagnose::identifier()
        .and_then(|id| diagnose::app_log_dir(std::env::consts::OS, &id, &var))
    {
        Ok(dir) => applog::init(dir),
        Err(error) => applog!("log file unavailable: {error}"),
    }
}

/// Logs the start once `build` has returned. A second launch never gets that far: single-instance
/// hands it to the running instance and exits inside `build`, so it adds no start of its own.
#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
fn log_started() {
    applog!(
        "Undertone {} ({BUILD}) started ({} {}, {} build)",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );
}

#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
pub fn run() {
    start_log();
    // `--look`: read once; a malformed value is logged and ignored.
    let forced_look = match look_arg(std::env::args_os()) {
        Some(Ok(look)) => {
            applog!("{LOOK_FLAG}: every overlay draws with {look:?} instead of the picked look");
            Some(look_script(&look))
        }
        Some(Err(why)) => {
            applog!("{why}");
            None
        }
        None => None,
    };
    let started_exe = std::env::current_exe()
        .ok()
        .and_then(|path| exe_stamp(&path));
    let app = tauri::Builder::default()
        // First, so a second launch hands over before anything else starts: it opens Settings, or,
        // when a new Undertone was installed over this one, restarts into it.
        .plugin(tauri_plugin_single_instance::init(move |app, _args, _cwd| {
            let now = std::env::current_exe()
                .ok()
                .and_then(|path| exe_stamp(&path));
            if replaced_on_disk(started_exe, now) {
                applog!("second launch: a new build was installed; restarting into it");
                app.restart();
            }
            if let Err(error) = commands::show_settings(app) {
                applog!("second launch: {error}");
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(state::AppState::default())
        .on_page_load(move |webview, payload| {
            // `--look`, in every build: each overlay page, and each reload of one, gets the forced
            // look once its page has loaded. Settings' preview keeps the picked look.
            if let Some(script) = forced_look.as_deref() {
                if desktop_layer::is_overlay(webview.label())
                    && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                {
                    if let Err(error) = webview.eval(script) {
                        applog!("{LOOK_FLAG}: {error}");
                    }
                }
            }
            // Debug `--overlay-probe`: every 2 s each webview prints whether the engine calls it
            // visible and how many frames it was given, whatever the renderer's own loop does.
            // It answers on a real machine whether a covered desktop-layer overlay keeps animating.
            if cfg!(debug_assertions)
                && std::env::args().any(|arg| arg == "--overlay-probe")
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                if let Err(error) = webview.eval("(()=>{let f=0;const t=()=>{f++;requestAnimationFrame(t)};requestAnimationFrame(t);setInterval(()=>{window.__TAURI_INTERNALS__.invoke('debug_probe',{message:`visibility=${document.visibilityState} frames/2s=${f} nodes=${document.querySelectorAll('#app *').length} text=${(document.getElementById('app')?.textContent||'').trim().slice(0,60)}`});f=0},2000)})();") {
                    applog!("overlay probe: {error}");
                }
            }
            // Debug `--desktop-layer-test`: a fixed line on every overlay, to check the layer by hand.
            // The second line counts animation frames and the times the page went hidden: covering
            // the desktop with windows must not add to "hidden" (docs/DESKTOP_LAYER.md).
            if cfg!(debug_assertions)
                && std::env::args().any(|arg| arg == "--desktop-layer-test")
                && desktop_layer::is_overlay(webview.label())
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                if let Err(error) = webview.eval(DESKTOP_TEST_PAGE) {
                    applog!("desktop test page: {error}");
                }
            }
        })
        .on_window_event(|window, event| {
            use tauri::Manager;
            if window.label() != "settings" {
                return;
            }
            // Its page hides and shows with it (desktop_layer::set_shown), so the preview stops
            // drawing and the settings page saves a pending edit as it goes. Hidden, minimized or
            // in the background, it can't be recording a shortcut: any suspension it left ends.
            let result = match event {
                // Closing Settings hides it, so the tray and a second launch can show it again.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    shortcuts::resume(window.app_handle());
                    window
                        .get_webview_window("settings")
                        .map(|settings| desktop_layer::set_shown(&settings, false))
                }
                // Minimized or restored.
                tauri::WindowEvent::Resized(_) => {
                    if window.is_minimized().unwrap_or(false) {
                        shortcuts::resume(window.app_handle());
                    }
                    window
                        .get_webview_window("settings")
                        .map(|settings| desktop_layer::sync_page_visibility(&settings))
                }
                tauri::WindowEvent::Focused(false) => {
                    shortcuts::resume(window.app_handle());
                    None
                }
                _ => None,
            };
            if let Some(Err(error)) = result {
                applog!("settings window: {error}");
            }
        })
        .setup(|app| {
            use tauri::Manager;
            // Menu bar only: no Dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = app.handle();
            // Settings starts hidden, but a WebView2 page starts visible (occlusion tracking is off,
            // see desktop_layer::WEBVIEW2_BROWSER_ARGS): hide its page until it is shown.
            if let Some(settings) = app.get_webview_window("settings") {
                if let Err(error) = desktop_layer::set_shown(&settings, false) {
                    applog!("settings page: {error}");
                }
            }
            // A step that fails ends the app (tauri panics with the error): log which one and why.
            let failed = |step: &'static str| {
                move |error: String| {
                    applog!("Undertone couldn't start: {step}: {error}");
                    std::io::Error::other(format!("{step}: {error}"))
                }
            };
            // Settings first: every service and window below reads them (and the shortcuts).
            let first_launch = settings::runtime::install(handle).map_err(failed("settings"))?;
            lyrics::runtime::install(handle).map_err(failed("lyrics"))?;
            desktop_layer::start(handle).map_err(failed("desktop layer"))?;
            media::start(handle);
            tray::install(handle).map_err(failed("tray"))?;
            shortcuts::install(handle).map_err(failed("shortcuts"))?;
            // With nothing playing, a first launch would show nothing but a tray icon that is
            // often out of sight. Settings says what Undertone needs and has the demo preview.
            // (Also when the stored settings were lost: the user should see that they were.)
            if first_launch {
                if let Err(error) = commands::show_settings(handle) {
                    applog!("first launch: {error}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::update_settings,
            commands::get_now_playing,
            commands::get_media_status,
            commands::get_shortcuts_status,
            commands::suspend_shortcuts,
            commands::get_lyrics,
            commands::refetch_lyrics,
            commands::set_track_offset,
            commands::open_settings,
            commands::quit,
            commands::debug_probe,
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| {
            // Release builds abort here with no window and no console: the log keeps the reason.
            // (The setup above runs later, inside `run`.)
            applog!("Undertone couldn't start: {error}");
            panic!("error while building Undertone");
        });
    log_started();
    app.run(|_app, event| match event {
        // A tray app keeps running with no window open; only Quit (an explicit exit code) ends it.
        tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        // macOS: opening Undertone again while it runs reaches this instance as a reopen, not a
        // second launch, so single-instance never sees it. Same answer: show Settings.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Err(error) = commands::show_settings(_app) {
                applog!("reopen: {error}");
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn a_build_installed_over_the_running_one_is_seen_on_the_next_launch() {
        let dir = std::env::temp_dir().join(format!("undertone-exe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("undertone");
        std::fs::write(&exe, b"old build").unwrap();
        let started = exe_stamp(&exe);
        assert!(started.is_some());
        assert!(!replaced_on_disk(started, exe_stamp(&exe)));
        // the installer writes a new file in its place
        std::fs::write(&exe, b"the new, longer build").unwrap();
        assert!(replaced_on_disk(started, exe_stamp(&exe)));
        // unknown either side: no restart, Settings as before
        assert!(!replaced_on_disk(None, exe_stamp(&exe)));
        assert!(!replaced_on_disk(started, exe_stamp(&dir.join("gone"))));
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!BUILD.is_empty());
    }

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn look_takes_the_last_value_and_leaves_other_flags_alone() {
        assert_eq!(look_arg(args(&["undertone"])), None);
        assert_eq!(
            look_arg(args(&["undertone", "--look=lens"])),
            Some(Ok("lens".into()))
        );
        // A face with a space, Arc's curve with the face kept, and the last one given wins.
        assert_eq!(
            look_arg(args(&["undertone", "--look=drift,Instrument Serif"])),
            Some(Ok("drift,Instrument Serif".into()))
        );
        assert_eq!(
            look_arg(args(&[
                "undertone",
                "--look=stack",
                "--diagnose",
                "--look=arc,,-50"
            ])),
            Some(Ok("arc,,-50".into()))
        );
        // Not this flag. (Built, not spelled out: regress-docs takes every quoted double-dash word
        // in the Rust sources for a flag the app has, and wants it documented.)
        let (looks, lookup) = (format!("{LOOK_FLAG}s=lens"), format!("{LOOK_FLAG}up"));
        assert_eq!(
            look_arg(args(&["undertone", &looks, &lookup, "look=arc"])),
            None
        );
        // The overlay validates the parts: an unknown style still goes through, and is ignored there.
        assert_eq!(
            look_arg(args(&["undertone", "--look=spiral"])),
            Some(Ok("spiral".into()))
        );
    }

    #[test]
    fn a_malformed_look_is_ignored_with_a_reason() {
        for (arg, why) in [
            ("--look", "needs a value"),
            ("--look=", "empty"),
            ("--look=  ", "empty"),
            ("--look=arc,Fraunces,40,extra", "more than"),
            ("--look=arc\u{7}", "control characters"),
            ("--look=lens\nalert(1)", "control characters"),
        ] {
            let Some(Err(error)) = look_arg(args(&["undertone", arg])) else {
                panic!("{arg:?} should be malformed");
            };
            assert!(error.contains(why), "{arg:?}: {error}");
        }
        let long = format!("--look=arc,{}", "x".repeat(LOOK_MAX_CHARS));
        assert!(
            matches!(look_arg(args(&["undertone", &long])), Some(Err(e)) if e.contains("too long"))
        );
        // A malformed last value isn't replaced by an earlier one: the user's last word stands.
        assert!(matches!(
            look_arg(args(&["undertone", "--look=lens", "--look="])),
            Some(Err(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_look_that_is_not_utf8_is_ignored() {
        use std::os::unix::ffi::OsStringExt;
        let raw = OsString::from_vec(b"--look=l\xffns".to_vec());
        assert!(
            matches!(look_arg([OsString::from("undertone"), raw]), Some(Err(e)) if e.contains("not UTF-8"))
        );
        // Another flag that isn't UTF-8 is none of its business.
        let other = OsString::from_vec(b"--media-\xff".to_vec());
        assert_eq!(look_arg([OsString::from("undertone"), other]), None);
    }

    #[test]
    fn the_look_reaches_the_page_as_a_string_it_cannot_break_out_of() {
        for look in [
            "lens",
            "arc,,-50",
            "drift,Instrument Serif",
            "lens\";alert(1);\"",
            "a\\b",
            "x\u{2028}y\u{2029}",
            "</script>",
        ] {
            let script = look_script(look);
            let rest = script
                .strip_prefix("window.__UNDERTONE_LOOK__=")
                .expect("sets the global first");
            // The event has no `;`, and the string literal must parse back whole.
            let (literal, event) = rest.rsplit_once(';').expect("then the event");
            assert_eq!(event, "dispatchEvent(new Event(\"undertone-look\"))");
            assert_eq!(
                serde_json::from_str::<String>(literal).unwrap(),
                look,
                "{script}"
            );
            assert!(!literal.contains('\u{2028}') && !literal.contains('\u{2029}'));
        }
    }

    #[test]
    fn every_overlay_page_gets_the_look_as_it_loads_in_every_build() {
        // The native half can't run here, so the source says it: the look is handed over before
        // (and outside) the debug-only probes, to overlay webviews only, once their page finished.
        let source = include_str!("lib.rs").replace("\r\n", "\n");
        let run = &source[source.find("pub fn run() {").expect("run")..];
        let read = run
            .find("let forced_look = match look_arg(std::env::args_os())")
            .expect("--look is read once at startup");
        let load = run
            .find(".on_page_load(move |webview, payload| {")
            .expect("on_page_load");
        let debug = load
            + run[load..]
                .find("cfg!(debug_assertions)")
                .expect("the debug probes");
        let handed = &run[load..debug];
        for step in [
            "forced_look.as_deref()",
            "desktop_layer::is_overlay(webview.label())",
            "PageLoadEvent::Finished",
            "webview.eval(script)",
        ] {
            assert!(handed.contains(step), "{step}");
        }
        assert!(read < load);
        assert!(!run[read..load].contains("debug_assertions"));
    }
}
