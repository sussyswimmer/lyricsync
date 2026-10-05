#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
mod commands;
pub mod contract;

#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
pub fn run() {
    use tauri::Emitter;
    tauri::Builder::default()
        .manage(commands::AppState::default())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            _app.set_activation_policy(tauri::ActivationPolicy::Accessory);
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
