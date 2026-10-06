# Desktop-layer work (X1)

Windows (Codex) and macOS (Claude Code) are both implemented and share one controller. Neither has passed native acceptance on a real machine yet, so M1 is not complete.

## Windows approach

The Windows adapter implements a shared `DesktopLayer` trait. It discovers classic top-level WorkerW and the raised desktop hierarchy used by Windows 11 24H2. Discovery sends Progman `0x052C` with `0xD, 1` on a blocking worker with a one-second timeout. Native window changes run on Tauri's UI thread. The overlay is layered, click-through, nonactivating, and sized in physical monitor pixels with a PerMonitorV2 manifest.

For the raised desktop, a transparent overlay is parented to Progman **between** the icon DefView and wallpaper WorkerW. Parenting into the wallpaper WorkerW can obscure it. This follows the current hierarchy described in Lively's `SetupDesktopLayer` and `TryAttachToDesktop` ([reference at 25a0a5f](https://github.com/rocksdanister/lively/blob/25a0a5f4ed1988ff42117d3a17feb321062237fe/src/Lively/Lively/Core/WinDesktopCore.cs)). The implementation was written independently; no Lively source is copied.

The persistent hidden settings window receives `TaskbarCreated`, `WM_DISPLAYCHANGE`, DPI and wake messages. Its close button hides it; the quit command exits. Overlays also receive DPI notifications. Notifications set a refresh flag; a one-second async loop reconciles display windows, checks parent validity, and retries while Explorer starts. Changes the user is waiting to see (play/pause, `showWhen`/`displays`, Hide lyrics) wake the loop at once. `displays: all` uses `overlay-<n>` labels; primary mode uses `overlay`. Only successfully attached windows can be shown. The media loop calls `desktop_layer::set_playing(bool)` when playback changes; default idle state hides overlays. The tray's Hide lyrics and Cmd/Ctrl+Alt+L hide every overlay, whatever `showWhen` says. Overlays are created non-focusable on both OSes; on Windows that also keeps `WS_EX_NOACTIVATE`, because tao rebuilds the extended style from its own flags on every show and hide.

## macOS approach

The same controller drives `desktop_layer/macos.rs`. Each overlay stays a normal top-level NSWindow, lowered to `CGWindowLevelForKey(kCGDesktopWindowLevelKey)`: above the wallpaper, below the Finder's icons and every app window. It ignores mouse events, has a clear background and no shadow, and joins every Space as stationary and outside the window cycle (`CanJoinAllSpaces | Stationary | IgnoresCycle`). It is never key, so showing it can't take focus from Settings.

Each tauri monitor is matched to an NSScreen in points (tauri reports each display's bounds scaled by its own backing factor; `geometry.rs`), and the overlay is framed to that screen's full frame, menu bar and Dock area included. With `displays: all`, displays that share an origin (a mirror set) get one overlay. macOS restyles a shown overlay in place, so refreshes don't flash. The controller refreshes on `NSApplicationDidChangeScreenParametersNotification`, wake, screens wake and Space changes. If no screen matches yet (the lists disagree mid-reconfiguration), the overlays hide and the next tick retries.

## Required native acceptance

Run on Windows 10/11, including Windows 11 24H2, with the Tauri prerequisites installed:

```
pnpm install --frozen-lockfile
pnpm tauri dev -- --desktop-layer-test --desktop-layer-all
```

The debug-only flags show original diagnostic text and select all monitors without modifying frontend files or saved settings. They work on both OSes. Verify on Windows:

- Text is above wallpaper, below desktop icons and every app window; drag folders/windows across it.
- Clicking the text selects the desktop, without stealing focus.
- Restart Explorer via Task Manager and verify recovery.
- Add/remove a display, change primary display and scaling, include a monitor left/above primary, and resume from sleep.
- With the debug flags removed, idle overlays stay hidden. A future media watcher can call `set_playing` to test playback visibility.
- Open/close Settings through the command bridge and verify that closing it preserves the notification anchor.

On macOS 14 and 15, with the same command, verify:

- Text is above the wallpaper, below the Finder's desktop icons and every app window; drag files and windows across it. Clicking the text selects and deselects desktop icons. If the wallpaper ever covers the text, raise the level to desktop + 1 in `macos.rs`.
- Change the wallpaper and switch Spaces (also with "Displays have separate Spaces" on), open Mission Control, use Show Desktop and Cmd+`: the text stays put on every Space and never joins the window cycle.
- Sleep and wake the Mac, and let the displays sleep: the text comes back, framed correctly, within about a second.
- A Retina laptop with a 1x external display, an external display above or left of the main one, a scaling change, and plugging and unplugging: each overlay exactly covers its screen. With mirrored displays and `--desktop-layer-all`, there is only one overlay.
- Opening Settings and toggling play/pause never takes focus from Settings or another app, and there is no Dock icon.
- The overlay background is fully clear, and the lyrics keep animating while the desktop is visible.

Both adapters build, link and pass their unit tests on GitHub's macOS and Windows runners. Their on-screen behavior still needs the acceptance steps above on a real machine.
