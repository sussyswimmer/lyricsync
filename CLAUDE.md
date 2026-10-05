# CLAUDE.md — Claude Code's half of Undertone

Read `SPEC.md` first. It holds the architecture, the contract and the ownership map. This file is your work order.

## Your role

You own **everything the user sees and everything about time and color**: the lyric renderer, the settings window, LRC parsing, word timing, the playback clock, and palette extraction. Codex owns the Rust core and the OS-level work in parallel.

You got this half because it rewards visual judgment, motion design, typography, and careful TypeScript logic. Treat the overlay as a product people stare at all day, not a debug view.

**Your paths:** `index.html`, `settings.html`, `src/**`, `tests/**`, `vite.config.ts`, `package.json` (after Codex's M0 scaffold), `README.md`, `docs/USER_GUIDE.md`.
**Never edit:** `src-tauri/**`, `.github/**`. Request changes in `docs/HANDOFF.md`.

## Ground rules

- Strict TypeScript, no `any`. Import contract types from `contract/contract.ts`; never redeclare them.
- No UI framework. Overlay code is a per-frame renderer.
- Bundle fonts locally (`@fontsource/*`, OFL-licensed only). The app must work offline, so no Google Fonts at runtime.
- **Never commit real lyrics.** Fixtures use original placeholder text (see SPEC).
- Everything must run in a plain browser with the mock bridge (`pnpm dev`). That way you never wait on Codex.
- Commit small, on branches named `claude/<task>`. Log each milestone in `docs/HANDOFF.md`.

## Target structure

```
src/
  bridge/
    index.ts        picks tauri or mock (mock when !window.__TAURI_INTERNALS__ or ?mock)
    tauri.ts        @tauri-apps/api invoke + listen, typed by the contract
    mock.ts         fake NowPlaying stream + fixture LRC, supports pause/seek/track change
  core/
    lrc.ts          LRC → Line[]
    timing.ts       word timing fallback + plain-lyric pacing
    clock.ts        interpolated, offset-corrected playback position
    palette.ts      artwork → { lyric, highlight, dim }
  overlay/
    main.ts         subscribes to bridge, owns the rAF loop
    modes/arc.ts · lens.ts · drift.ts   (stack = drift with depth 0)
    states.ts       loading / not-found / instrumental / plain-only presentations
  settings/
    main.ts         settings window
    preview.ts      mini stage reusing the overlay modes
  styles/
tests/
  fixtures/         original placeholder LRC only
  lrc.test.ts · timing.test.ts · clock.test.ts · palette.test.ts
```

## Tasks

Do C1–C3 first. They need no scaffold, so start while Codex is on M0.

### C1 · LRC parser (`core/lrc.ts`)
```ts
export interface Word { text: string; start: number; end: number }   // ms
export interface Line { start: number; end: number; words: Word[]; text: string }
export function parseLrc(raw: string, durationMs: number): Line[];
```
- Handle multiple timestamps on one line (`[00:12.00][01:40.00]chorus`), `[offset:+/-ms]`, metadata tags (`[ar:]`, `[ti:]`…), `[mm:ss]`, `[mm:ss.x]`, `[mm:ss.xx]` and `[mm:ss.xxx]`.
- Enhanced LRC: `<mm:ss.xx>` word tags give real per-word timing. Use them when present.
- An empty timed line is an instrumental gap. It ends the previous line and produces no words.
- A line's `end` is the next line's start minus a 350 ms gap, never past `durationMs`.
- Sort the output; tolerate junk lines and CRLF.

### C2 · Word timing (`core/timing.ts`)
- The fallback when there are no word tags is the prototype's length-weighted split. Improve it:
  - Weight by vowel groups (rough syllables) plus a floor.
  - Give the last word of a line a hold of up to 600 ms.
  - Cap any single word at 1.6 s, so a long instrumental tail doesn't freeze one word.
- Plain lyrics only (`status: "plain-only"`): pace lines evenly across the duration, and flag `unsynced` so the renderer shows a calmer style without word highlight.

### C3 · Playback clock (`core/clock.ts`)
- `position(now) = positionMs + (isPlaying ? now - sampledAt : 0) + globalOffsetMs + trackOffsetsMs[trackKey]`.
- Each new sample is compared to the predicted position:
  - Off by more than 400 ms: snap (seek).
  - Off by less: slew over about 300 ms so the highlight never jitters.
- Freeze on pause. Reset on `trackKey` change.
- Unit test seek, pause/resume, slew, and offset.

### C4 · Palette (`core/palette.ts`)
- Port `extract()` from the prototype: 48×48 sample, 4-bit buckets, dominant color for tint, vivid color for highlight.
- Guarantee legibility on unknown wallpapers:
  - Lyric lightness ≥ 0.85.
  - Highlight lightness 0.6–0.75 with saturation ≥ 0.55.
  - The renderer always adds a soft dark text shadow (scaled by `glow` = 0 → subtle).
- Near-grayscale covers: fall back to a neutral warm white plus the most saturated pixel, or the default highlight.
- Cache results per `trackKey`. Run off the main animation path (once per track).

### C5 · Bridge (`src/bridge/`)
- `tauri.ts`: typed `invoke`/`listen` wrappers for every command and event in the contract.
- `mock.ts`: two fixture tracks with original lyrics.
  - One with enhanced word tags, one line-only.
  - Also simulates a not-found track and an instrumental track.
  - Keyboard shortcuts in mock mode: Space play/pause, ←/→ seek ±5 s, N next track.
- `index.ts` picks the right bridge automatically.

### C6 · Overlay renderer (`src/overlay/`)
- Port the four styles from the prototype: Arc (SVG `textPath`, curve from settings), Lens (fisheye scale around the active word), Drift (3D stack), Stack (Drift with no depth).
- Word states: sung → highlight, active → highlight + glow, upcoming → lyric color, other lines → dim.
- Transparent background (`html, body { background: transparent }`). No pointer handling; the window is click-through.
- Track change: fade the old line out over 250 ms, then fade the new song in.
- States from `states.ts`:
  - `loading`: nothing for 600 ms, then a faint pulse.
  - `not-found`: a small "No lyrics for this song" chip that fades out after 4 s.
  - `instrumental`: a slow breathing ♪.
  - `plain-only`: unsynced style.
- **Performance budget:**
  - Run the rAF loop only while playing and visible. Stop it on pause, `showWhen` gating, or a `null` track.
  - Build DOM per line, then mutate only styles per frame.
  - No layout thrash; use transforms where possible.
- Scale `size` by the window's devicePixelRatio and display height, so it looks the same on a 13" laptop and a 27" monitor.
- `prefers-reduced-motion`: no drift or lens animation; crossfade only.

### C7 · Settings window (`settings.html`, `src/settings/`)
- Base the design on the prototype's panel. Make it a polished native-feeling window (about 380×640, light and dark aware).
- **Live preview** at the top: a mini stage running the real overlay modes on the current track, or the mock track if nothing is playing.
- Controls: all `Settings` fields.
  - Font picker shows each font in its own face.
  - "Match album colors" toggle; editing any color turns it off.
  - Show-when, displays, global offset slider (±2000 ms).
  - Per-track sync nudge: −100 / −50 / +50 / +100 ms with the current value, plus "Reset this song".
- Every change calls `update_settings` (debounced 120 ms) and re-renders from the `settings-changed` echo, so the overlay and tray stay in sync.
- "Reset to defaults" with an in-window confirm step.

### C8 · Tests, polish, docs
- vitest coverage on `core/`. Target ≥ 90% on `lrc.ts`, `timing.ts` and `clock.ts`.
- Visual QA with the mock bridge:
  - All 4 styles × 3 covers × light and dark wallpapers.
  - Long lines, single-word lines, CJK and Vietnamese diacritics.
- `README.md`: what it is, install, permissions (macOS Automation prompt), troubleshooting.
- `docs/USER_GUIDE.md`: every setting explained in plain words.

## Handoffs you depend on (from Codex)

| Need | Until it lands |
|---|---|
| M0 scaffold | work in `src/core/` + `tests/` only |
| Real events/commands | mock bridge |
| Overlay pinned to desktop | test in a normal window or the browser |

## Start here

1. Open `prototype/undertone.html` in a browser and play with every control.
2. Build C1–C3 with tests. Log progress in `docs/HANDOFF.md`.
3. When Codex logs **M0 done**, pull and continue with C4–C7.
