# Desktop-layer work (X1)

Windows (Codex) and macOS (Claude Code) are both implemented and share one controller. Neither has passed native acceptance on a real machine yet, so M1 is not complete.

## Windows approach

The Windows adapter implements a shared `DesktopLayer` trait. It discovers classic top-level WorkerW and the raised desktop hierarchy used by Windows 11 24H2. Discovery sends Progman `0x052C` with `0xD, 1` on a blocking worker with a one-second timeout. Native window changes run on Tauri's UI thread. The overlay is layered, click-through, nonactivating, and sized in physical monitor pixels with a PerMonitorV2 manifest.

For the raised desktop, a transparent overlay is parented to Progman **between** the icon DefView and wallpaper WorkerW. Parenting into the wallpaper WorkerW can obscure it. This follows the current hierarchy described in Lively's `SetupDesktopLayer` and `TryAttachToDesktop` ([reference at 25a0a5f](https://github.com/rocksdanister/lively/blob/25a0a5f4ed1988ff42117d3a17feb321062237fe/src/Lively/Lively/Core/WinDesktopCore.cs)). The implementation was written independently; no Lively source is copied.

The persistent hidden settings window receives `TaskbarCreated`, `WM_DISPLAYCHANGE`, `WM_DPICHANGED`, `WM_SETTINGCHANGE` with `SPI_SETWORKAREA`, and wake messages. Its close button hides it; the quit command exits. Overlays parented under Explorer's windows are children and receive none of these broadcasts, so the anchor is what notices a display being added, moved, resized or rescaled: Windows changes every display's work area when its scale changes, which is the signal Chromium uses too. Notifications set a refresh flag; a one-second async loop reconciles display windows, checks parent validity, and retries while Explorer starts. Changes the user is waiting to see (play/pause, `showWhen`/`displays`, Hide lyrics) wake the loop at once. `displays: all` uses `overlay-<n>` labels; primary mode uses `overlay`. Only successfully attached windows can be shown. The media loop calls `desktop_layer::set_playing(bool)` when playback changes; default idle state hides overlays. The tray's Hide lyrics and Cmd/Ctrl+Alt+Shift+L hide every overlay, whatever `showWhen` says.

Each pass reads where every overlay actually hangs (`attachment`: parent, window rect against the monitor in physical pixels, styles, and on the raised desktop the z-order between the icons and the wallpaper) and touches only what is off. An overlay in place is never re-attached, and it is shown or hidden only when its shown state changes. Play/pause reuses the desktop found last time instead of asking Explorer again, so with `showWhen: always` a play/pause does nothing to the overlay at all; before, it hid, re-attached and showed it, which blinked. Only an overlay that needs a new parent (a new window, or Explorer restarted) is hidden while it is reparented; one that only moved or was rescaled is moved in place.

The styles follow X1: `WS_CHILD` (never `WS_POPUP`) and `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE` (never `WS_EX_APPWINDOW`). tao rewrites both style words from its own flags on every show and hide (`apply_diff`), which would drop the child and tool-window styles and add the app-window style. The overlay subclass (reference data 1; the settings anchor has 0) answers `WM_STYLECHANGING` while the overlay's parent is not the desktop window, after tao's procedure has seen it, and puts those bits back. Detaching calls `SetParent(NULL)` first, so the top-level styles it sets afterwards stick. The arithmetic is in `desktop_layer/styles.rs` and is unit-tested on every OS; its constants are checked against windows-sys at compile time. With the debug `--desktop-layer-test` flag, every overlay shown logs its parent and decoded styles.

## macOS approach

The same controller drives `desktop_layer/macos.rs`. Each overlay stays a normal top-level NSWindow, lowered to `CGWindowLevelForKey(kCGDesktopWindowLevelKey)`: above the wallpaper, below the Finder's icons and every app window. It ignores mouse events, has a clear background and no shadow, and joins every Space as stationary and outside the window cycle (`CanJoinAllSpaces | Stationary | IgnoresCycle`). It is never key, so showing it can't take focus from Settings.

Each tauri monitor is matched to an NSScreen in points (tauri reports each display's bounds scaled by its own backing factor; `geometry.rs`), and the overlay is framed to that screen's full frame, menu bar and Dock area included. With `displays: all`, displays that share an origin (a mirror set) get one overlay. An overlay already at the desktop level, click-through and framed to its screen is left alone; any other is restyled in place, shown, so refreshes don't flash. The controller refreshes on `NSApplicationDidChangeScreenParametersNotification`, wake, screens wake and Space changes. If no screen matches yet (the lists disagree mid-reconfiguration), the overlays hide and the next tick retries.

## Visibility and occlusion

The renderer pauses its loop while `document.visibilityState` is "hidden", as well as while paused, with nothing playing, or when `showWhen` hides the lyrics. An overlay under every app window would look hidden to both engines, which would freeze the lyrics whenever a window covers the desktop. So the engines' visibility follows only real show and hide; a covered overlay keeps drawing, within the same CPU budget as an uncovered one.

- **Windows (WebView2).** Chromium's native window occlusion is off (`CalculateNativeWinOcclusion`). WebView2 refuses a second set of browser arguments for the same user-data folder, so every webview passes the same `additionalBrowserArgs`: both windows in `tauri.conf.json` and the `overlay-<n>` windows the controller builds use `desktop_layer::WEBVIEW2_BROWSER_ARGS`, and a unit test checks the config against it. Setting it replaces wry's defaults, so it repeats them: `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion` (wry's autoplay flag is dropped; nothing here plays media). Without occlusion tracking a hidden or minimized window's page stays visible too, so `desktop_layer::set_shown` drives it: `ICoreWebView2Controller::SetIsVisible` with every show and hide of an overlay (gating, Hide lyrics, detaching) and of Settings (close hides it; `show_settings` shows it), page first when showing and window first when hiding. Windows created hidden start with their pages hidden, and Settings' page follows minimize and restore. A Settings window covered by other windows keeps its preview running.
- **macOS (WKWebView).** WebKit hides the page of a window AppKit reports occluded, and a desktop-level window is occluded most of the time. Overlays turn that off with WebKit's `-[WKWebView _setWindowOcclusionDetectionEnabled:NO]`, sent only if the view responds to it (a no-op otherwise). Ordering the window out still hides the page, so show and hide stay the real switches. Overlays also set `backgroundThrottling: "disabled"` (macOS 14+, Undertone's minimum; ignored elsewhere), so WebKit never suspends a hidden overlay's page and it reappears current. Settings keeps WebKit's defaults.

## Required native acceptance

Run on Windows 10/11, including Windows 11 24H2, with the Tauri prerequisites installed:

```
pnpm install --frozen-lockfile
pnpm tauri dev -- -- --desktop-layer-test --desktop-layer-all
```

`tauri dev` passes what follows the first `--` to the runner (cargo) and what follows a second `--` to the app, and pnpm forwards both literally; with a single `--`, cargo would get the flags and refuse them. The debug-only flags show original diagnostic text and select all monitors without modifying frontend files or saved settings. They work on both OSes. The test text's second line counts animation frames and the times the page went hidden: the frame count keeps climbing while the text shows, and covering the desktop with windows must not add to "hidden" (Hide lyrics adds one). Verify on Windows:

- Text is above wallpaper, below desktop icons and every app window; drag folders/windows across it.
- Clicking the text selects the desktop, without stealing focus.
- Restart Explorer via Task Manager and verify recovery.
- Add/remove a display, change primary display and scaling, include a monitor left/above primary, and resume from sleep. Each overlay covers its display exactly within about a second, and after a scale change the lyrics are drawn at the new scale (WebView2 tracks the monitor scale itself).
- The log shows `desktop layer: overlay… shown, parent 0x…, style … (child yes, popup no), ex … (layered yes, transparent yes, tool window yes, no-activate yes, app window no)` after each show, and the overlay has no taskbar button and no Alt+Tab entry.
- With the debug flags removed, idle overlays stay hidden. Play and pause music: with `showWhen: playing` the lyrics appear and disappear; with `showWhen: always` play/pause never makes them blink.
- Maximize a window over the desktop for a few seconds, then minimize it: "hidden" has not changed and the frame count jumped by roughly 60 per second covered. Hide lyrics and show them again: "hidden" went up by one.
- Open/close Settings through the command bridge and verify that closing it preserves the notification anchor. With Settings closed or minimized, its preview stops (Task Manager shows its WebView2 renderer idle); reopened, the preview runs, and an edit made just before closing is saved.

On macOS 14 and 15, with the same command, verify:

- Text is above the wallpaper, below the Finder's desktop icons and every app window; drag files and windows across it. Clicking the text selects and deselects desktop icons. If the wallpaper ever covers the text, raise the level to desktop + 1 in `macos.rs`.
- Change the wallpaper and switch Spaces (also with "Displays have separate Spaces" on), open Mission Control, use Show Desktop and Cmd+`: the text stays put on every Space and never joins the window cycle.
- Sleep and wake the Mac, and let the displays sleep: the text comes back, framed correctly, within about a second.
- A Retina laptop with a 1x external display, an external display above or left of the main one, a scaling change, and plugging and unplugging: each overlay exactly covers its screen. With mirrored displays and `--desktop-layer-all`, there is only one overlay.
- Opening Settings and toggling play/pause never takes focus from Settings or another app, and there is no Dock icon.
- The overlay background is fully clear, and the lyrics keep animating while the desktop is visible and also while app windows cover it: cover the desktop with windows (or a full-screen app) for a few seconds, and "hidden" has not changed. Hide lyrics and show them again: "hidden" went up by one. The log line after each show reports AppKit's occlusion state.

Both adapters build, link and pass their unit tests on GitHub's macOS and Windows runners. Their on-screen behavior still needs the acceptance steps above on a real machine.
