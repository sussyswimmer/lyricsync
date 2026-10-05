# Desktop-layer work (X1)

Windows implementation is on `codex/desktop-layer`; M1 is not complete. macOS native attachment and native runtime acceptance remain outstanding. `main` contains the M0 scaffold handoff.

## Windows approach

The Windows adapter implements a shared `DesktopLayer` trait. It discovers classic top-level WorkerW and the raised desktop hierarchy used by Windows 11 24H2. Discovery sends Progman `0x052C` with `0xD, 1` on a blocking worker with a one-second timeout. Native window changes run on Tauri's UI thread. The overlay is layered, click-through, nonactivating, and sized in physical monitor pixels with a PerMonitorV2 manifest.

For the raised desktop, a transparent overlay is parented to Progman **between** the icon DefView and wallpaper WorkerW. Parenting into the wallpaper WorkerW can obscure it. This follows the current hierarchy described in Lively's `SetupDesktopLayer` and `TryAttachToDesktop` ([reference at 25a0a5f](https://github.com/rocksdanister/lively/blob/25a0a5f4ed1988ff42117d3a17feb321062237fe/src/Lively/Lively/Core/WinDesktopCore.cs)). The implementation was written independently; no Lively source is copied.

The persistent hidden settings window receives `TaskbarCreated`, `WM_DISPLAYCHANGE`, DPI and wake messages. Its close button hides it; the quit command exits. Overlays also receive DPI notifications. Notifications set a refresh flag; a one-second async loop reconciles display windows, checks parent validity, and retries while Explorer starts. `displays: all` uses `overlay-<n>` labels; primary mode uses `overlay`. Only successfully attached windows can be shown. X2 must call `desktop_layer::set_playing(bool)` when playback changes; default idle state hides overlays.

## Required native acceptance

Run on Windows 10/11, including Windows 11 24H2, with the Tauri prerequisites installed:

```
pnpm install --frozen-lockfile
pnpm tauri dev -- --desktop-layer-test --desktop-layer-all
```

The debug-only flags show original diagnostic text and select all monitors without modifying frontend files or saved settings. Verify:

- Text is above wallpaper, below desktop icons and every app window; drag folders/windows across it.
- Clicking the text selects the desktop, without stealing focus.
- Restart Explorer via Task Manager and verify recovery.
- Add/remove a display, change primary display and scaling, include a monitor left/above primary, and resume from sleep.
- With the debug flags removed, idle overlays stay hidden. A future media watcher can call `set_playing` to test playback visibility.
- Open/close Settings through the command bridge and verify that closing it preserves the notification anchor.

No native runtime behavior has been claimed from Linux cross-compilation. macOS desktop level, Spaces/wake notifications, and monitor mapping must be implemented and tested on a macOS host before M1.
