#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    undertone_lib::run();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        eprintln!("Undertone desktop supports Windows and macOS only.");
        std::process::exit(1);
    }
}
