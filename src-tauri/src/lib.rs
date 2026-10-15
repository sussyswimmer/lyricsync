// First: `applog!` is in scope in every module declared after it.
#[macro_use]
pub mod applog;

#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
mod commands;
pub mod contract;
pub mod desktop_layer;
pub mod diagnose;
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
    applog!(
        "Undertone {} started ({} {}, {} build)",
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
    tauri::Builder::default()
        // First, so a second launch hands over before anything else starts: it opens Settings.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
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
        .on_page_load(|webview, payload| {
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
        })
        .run(|_app, event| match event {
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
