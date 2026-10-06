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
pub fn run() {
    tauri::Builder::default()
        // First, so a second launch hands over before anything else starts: it opens Settings.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Err(error) = commands::show_settings(app) {
                eprintln!("second launch: {error}");
            }
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(state::AppState::default())
        .on_page_load(|webview, payload| {
            // Debug `--desktop-layer-test`: a fixed line on every overlay, to check the layer by hand.
            if cfg!(debug_assertions)
                && std::env::args().any(|arg| arg == "--desktop-layer-test")
                && desktop_layer::is_overlay(webview.label())
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                if let Err(error) = webview.eval("document.body.style.cssText='margin:0;background:transparent;color:#f2a65a;font:48px sans-serif;display:grid;place-items:center;height:100vh';document.getElementById('app').textContent='Undertone desktop layer — drag a folder over this text';") {
                    eprintln!("desktop test page: {error}");
                }
            }
        })
        .on_window_event(|window, event| {
            // Closing Settings hides it, so the tray and a second launch can show it again.
            if window.label() == "settings" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        eprintln!("settings hide: {error}");
                    }
                }
            }
        })
        .setup(|app| {
            // Menu bar only: no Dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = app.handle();
            // Settings first: every service and window below reads them.
            settings::runtime::install(handle).map_err(std::io::Error::other)?;
            lyrics::runtime::install(handle).map_err(std::io::Error::other)?;
            desktop_layer::start(handle).map_err(std::io::Error::other)?;
            media::start(handle);
            tray::install(handle).map_err(std::io::Error::other)?;
            shortcuts::install(handle).map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::update_settings,
            commands::get_now_playing,
            commands::get_lyrics,
            commands::refetch_lyrics,
            commands::set_track_offset,
            commands::open_settings,
            commands::quit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Undertone")
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
                    eprintln!("reopen: {error}");
                }
            }
            _ => {}
        });
}
