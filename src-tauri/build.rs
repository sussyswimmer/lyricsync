fn main() {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some()
        && matches!(os.as_str(), "windows" | "macos")
    {
        println!("cargo:rerun-if-changed=windows.manifest");
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows.manifest")),
        ))
        .expect("Tauri build configuration failed");
    }
}
