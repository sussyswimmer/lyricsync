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

## 2026-10-05 · Claude Code · C1–C3
Done: `src/core/lrc.ts` (LRC + enhanced `<mm:ss.xx>` word tags, multi-stamp lines, `[offset:]`, gaps, CRLF/BOM/junk), `src/core/timing.ts` (syllable-weighted fallback word timing with 600 ms last-word hold and 1.6 s cap, plain-lyric pacing flagged `unsynced`, `lineAt`/`progress` helpers), `src/core/clock.ts` (interpolated, offset-corrected clock: snap > 400 ms, slew within, freeze on pause, reset on track change). 90 tests; core coverage 100% lines, 93% branches (`pnpm coverage`, new script). Fixtures are original placeholder lyrics.
Notes: `Word.text` keeps its trailing space so a line's words join back to `Line.text`; Chinese/Japanese/Korean lines split per character. `clock.ts` imports `NowPlaying`/`Settings` types from the contract.
Needs from Codex: nothing.
Contract: unchanged (v1).
