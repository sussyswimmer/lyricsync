#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
mod commands;
pub mod contract;
pub mod desktop_layer;
pub mod media;

#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
pub fn run() {
    #[cfg(target_os = "macos")]
    use tauri::Emitter;
    tauri::Builder::default()
        .manage(commands::AppState::default())
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
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            _app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            #[cfg(target_os = "windows")]
            desktop_layer::start(_app.handle()).map_err(std::io::Error::other)?;
            #[cfg(target_os = "windows")]
            media::start(_app.handle());
            #[cfg(target_os = "macos")]
            _app.emit(
                contract::NOW_PLAYING_EVENT,
                Option::<contract::NowPlaying>::None,
            )?;
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
