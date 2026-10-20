<!--
Title: the area it touches, then what changed in plain words, for example
`Overlay: keep the active word lit across a seek` or `Lyrics: retry after a timeout`.
-->

## What and why

<!-- What does this change, and why? Link the issue it fixes ("Fixes #123"). -->

## How it was tested

<!-- Commands you ran and their results. For the frontend, say what you checked with the mock bridge (`pnpm dev`). -->

## Screenshots

<!--
Needed when something visible changes: the lyrics, the settings window, the tray menu or the installers.
Before and after, or a short recording. Use the demo songs: never real lyrics.
Delete this section if nothing visible changed.
-->

## Checklist

- [ ] `pnpm test`, `pnpm coverage` and `pnpm build` pass.
- [ ] Rust changes: `cargo fmt --check`, `cargo clippy --features desktop -- -D warnings` and `cargo test` pass (from `src-tauri`).
- [ ] Dependencies changed: `node scripts/notices.mjs` regenerated `THIRD_PARTY_NOTICES.txt`.
- [ ] The contract is unchanged, or `contract.ts` and `contract.rs` change together, `CONTRACT_VERSION` is bumped and `docs/HANDOFF.md` says why.
- [ ] The README, `docs/USER_GUIDE.md` and `docs/TROUBLESHOOTING.md` still match what the app does.
- [ ] `CHANGELOG.md` has a line under `[Unreleased]`, if users will notice the change.
- [ ] No real song lyrics anywhere: fixtures, tests, screenshots and this description use original placeholder text.
- [ ] Still no network requests other than the LRCLIB lookup and Spotify's cover art, and still read-only toward the player.
