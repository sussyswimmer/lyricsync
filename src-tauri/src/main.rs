// Release builds open no console window on Windows; `--diagnose` attaches to its terminal's own.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    // Before the app (and its single-instance handoff) starts, so it works while Undertone is open.
    if undertone_lib::diagnose::requested() {
        std::process::exit(undertone_lib::diagnose::run());
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    undertone_lib::run();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        eprintln!("Undertone desktop supports Windows and macOS only.");
        std::process::exit(1);
    }
}
