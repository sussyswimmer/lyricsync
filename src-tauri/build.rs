fn main() {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some()
        && matches!(os.as_str(), "windows" | "macos")
    {
        tauri_build::build();
    }
}
