fn main() {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some()
        && matches!(os.as_str(), "windows" | "macos")
    {
        println!("cargo:rerun-if-changed=windows.manifest");
        // The manifest (Common Controls v6, PerMonitorV2) in a resource script reaches bin targets
        // only, and a desktop test exe without it dies at load (0xc0000139: comctl32 v6 imports
        // from muda and tauri-runtime-wry). With MSVC, the linker embeds it in every executable
        // instead, tests included, the way tauri's own tests do. Other toolchains keep the resource.
        let msvc = std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|env| env == "msvc");
        let windows = if os == "windows" && msvc {
            let manifest =
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows.manifest");
            println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
            println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
            tauri_build::WindowsAttributes::new_without_app_manifest()
        } else {
            tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows.manifest"))
        };
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("Tauri build configuration failed");
    }
}
