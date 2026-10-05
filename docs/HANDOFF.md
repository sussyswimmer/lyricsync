# Handoff log

Shared between Claude Code and Codex. Append new entries at the bottom; never edit the other agent's entries. Format is in `SPEC.md`.

## 2026-10-05 · Maxwell · Kickoff
Repo created with SPEC.md, CLAUDE.md, AGENTS.md and the prototype.
Codex starts with X0 (scaffold). Claude Code starts with C1–C3 (core logic, no scaffold needed).
Contract: v1.

## 2026-10-05 · Codex · M0
M0 done.
Done: X0 scaffold committed on `codex/scaffold` (`b69ebc2`), pushed, and merged into `main`. Tauri v2 + vanilla TypeScript; Vite overlay/settings entry points; transparent, hidden overlay and hidden 380×640 settings window; macOS private API and Accessory activation policy; matching contract v1 shapes/defaults; all eight command names registered and all three event payloads stubbed.
Validation: `pnpm test` (1 passed), `pnpm build`, `cargo test --locked` (2 passed), `cargo fmt --check`, portable Clippy and Windows desktop cross-target Clippy with `-D warnings` passed. Chromium opened the reference prototype and both scaffold pages without page errors. Windows cross-check used `x86_64-pc-windows-gnu`; it is not a native GUI/runtime test. macOS cross-check is blocked by the Linux host's missing Apple SDK/Objective-C toolchain. Native Windows/macOS window startup remains unverified.
Needs from Claude: frontend work can proceed in the owned paths. Both pages are deliberately empty shells. Subscribe to events, then query initial state with commands. Settings are in-memory stubs (full clamping/persistence is X4), playback returns null (X2), lyrics return `error` until X3; refetch emits `loading` then `error`. Desktop Cargo checks need `--features desktop`; Tauri CLI enables it automatically. Linux runs only frontend and portable Rust checks; it is not a product target.
Contract: unchanged (v1), initialized in TypeScript and Rust. No real lyrics added.

## 2026-10-05 · Codex · X1 in progress
Done: first Windows desktop-layer implementation on `codex/desktop-layer`, separate from the M0 scaffold on `main`. Classic WorkerW and Windows 11 24H2 raised-desktop discovery; layered/click-through/nonactivating styles; PerMonitorV2 manifest and physical monitor coordinates; primary/all display reconciliation; TaskbarCreated/display/DPI/wake hooks; async retry and idle visibility policy. Reviewed current Lively desktop hierarchy behavior and documented the source reference. Debug-only native diagnostic page avoids changes to frontend-owned files.
Validation: 5 portable Rust tests passed; rustfmt, portable Clippy and Windows desktop cross-target Clippy (`x86_64-pc-windows-gnu`, `-D warnings`) passed. No frontend or shared contract changes after M0. Native Explorer restart, click-through, mixed-DPI/multi-monitor acceptance and macOS implementation remain pending; M1 is NOT done. Follow `docs/DESKTOP_LAYER.md` on Windows before moving to the second OS, as AGENTS.md requests. Linux cannot perform this native acceptance.
Needs from Claude: nothing for X1; continue against the M0 contract. X2's watcher will need to call `desktop_layer::set_playing(bool)` on playback changes. Full settings persistence and media integration remain later milestones.
Contract: unchanged (v1).
