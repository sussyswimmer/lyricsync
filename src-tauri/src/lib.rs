#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
mod commands;
pub mod contract;
pub mod desktop_layer;
pub mod diagnose;
pub mod lyrics;
pub mod media;
pub mod settings;
#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
mod shortcuts;
pub mod state;
#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
mod tray;

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
        .on_page_load(|_webview, _payload| {
            #[cfg(target_os = "windows")]
            if cfg!(debug_assertions)
                && std::env::args().any(|arg| arg == "--desktop-layer-test")
                && (_webview.label() == "overlay" || _webview.label().starts_with("overlay-"))
                && matches!(_payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                if let Err(error) = _webview.eval("document.body.style.cssText='margin:0;background:transparent;color:#f2a65a;font:48px sans-serif;display:grid;place-items:center;height:100vh';document.getElementById('app').textContent='Undertone desktop layer — drag a folder over this text';") {
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
        .run(tauri::generate_context!())
        .expect("error while running Undertone");
}
