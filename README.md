# Undertone

Tauri v2 desktop lyrics app for Windows and macOS. See SPEC.md for the shared contract and AGENTS.md for backend ownership.

## Development

Use Node 24+, pnpm 11 and Rust stable. Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your native OS (WebView2 and MSVC on Windows; Xcode command line tools on macOS).

```
pnpm install --frozen-lockfile
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
pnpm tauri dev
```

`pnpm dev` serves both empty frontend entry points. `pnpm tauri dev` enables the `desktop` Cargo feature. Native checks must also use `cargo check --features desktop` and `cargo clippy --features desktop -- -D warnings` from `src-tauri`. Linux can run frontend and portable Rust tests; it is not a supported desktop target. Reuse the existing checkout in cloud tasks; do not create a worktree unless requested.

M0 commands are deliberately stubs: settings are in memory (full clamping/persistence is X4), now-playing is null, and lyrics lookup reports error until X2/X3. Listen to events before invoking commands; fetch initial settings and playback via commands. The reference prototype lives in `prototype/undertone.html`.
