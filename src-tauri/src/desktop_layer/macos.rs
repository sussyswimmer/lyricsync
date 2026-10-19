//! macOS: the overlay stays a normal top-level NSWindow, lowered to the desktop window level
//! (above the wallpaper, below the Finder's icons and every app window). Nothing to discover.
use super::{
    geometry::{self, Bounds, Rect, Screen},
    request_refresh, Attachment, DesktopLayer,
};
use block2::RcBlock;
use objc2::{msg_send, runtime::AnyObject, sel, MainThreadMarker};
use objc2_app_kit::{
    NSApplicationDidChangeScreenParametersNotification, NSApplicationDidHideNotification,
    NSApplicationDidUnhideNotification, NSColor, NSNormalWindowLevel, NSScreen, NSWindow,
    NSWindowCollectionBehavior, NSWindowLevel, NSWindowOcclusionState, NSWorkspace,
    NSWorkspaceActiveSpaceDidChangeNotification, NSWorkspaceDidWakeNotification,
    NSWorkspaceScreensDidWakeNotification,
};
use objc2_core_graphics::{CGWindowLevelForKey, CGWindowLevelKey};
use objc2_foundation::{
    NSNotification, NSNotificationCenter, NSNotificationName, NSPoint, NSRect, NSSize,
};
use std::{ptr::NonNull, sync::Once};
use tauri::{AppHandle, Monitor, WebviewWindow};

pub struct MacDesktop;

/// Above the wallpaper, below the Finder's desktop icons (kCGDesktopIconWindowLevel).
fn desktop_level() -> NSWindowLevel {
    CGWindowLevelForKey(CGWindowLevelKey::DesktopWindowLevelKey) as NSWindowLevel
}

/// tauri's physical bounds for `monitor`; `geometry::monitor_points` turns them into points.
fn physical(monitor: &Monitor) -> Bounds {
    let (position, size) = (monitor.position(), monitor.size());
    (position.x, position.y, size.width, size.height)
}

fn rect(frame: NSRect) -> Rect {
    Rect {
        x: frame.origin.x,
        y: frame.origin.y,
        width: frame.size.width,
        height: frame.size.height,
    }
}

/// The live NSWindow behind a tauri window. AppKit is main-thread only, so this refuses elsewhere.
fn ns_window(window: &WebviewWindow) -> Result<(MainThreadMarker, &NSWindow), String> {
    let mtm = MainThreadMarker::new().ok_or("desktop layer: AppKit used off the main thread")?;
    let pointer = window.ns_window().map_err(|e| e.to_string())?;
    let pointer = NonNull::new(pointer.cast::<NSWindow>()).ok_or("window has no NSWindow")?;
    // SAFETY: tauri hands out the NSWindow its tao window owns; it outlives this borrow of
    // `window`, and the marker above proves we are on the main thread AppKit requires.
    Ok((mtm, unsafe { pointer.as_ref() }))
}

/// The overlay's frame, in Cocoa points, on the screen that shows `monitor`: that screen's visible
/// frame (`geometry::overlay_frame`). `attach` sets it and `attachment` compares against it.
fn overlay_frame(mtm: MainThreadMarker, monitor: &Monitor) -> Result<NSRect, String> {
    let screens: Vec<Screen> = NSScreen::screens(mtm)
        .iter()
        .map(|screen| Screen {
            frame: rect(screen.frame()),
            visible: rect(screen.visibleFrame()),
        })
        .collect();
    let wanted = geometry::monitor_points(physical(monitor), monitor.scale_factor());
    let frame = geometry::overlay_frame(wanted, &screens)
        .ok_or_else(|| format!("no screen matches display {wanted:?} yet"))?;
    Ok(NSRect::new(
        NSPoint::new(frame.x, frame.y),
        NSSize::new(frame.width, frame.height),
    ))
}

/// Keeps the overlay's page visible while app windows cover it. WebKit hides the page of a window
/// AppKit reports occluded, and a desktop-level window under other windows is occluded most of the
/// time: the renderer would stop drawing (it pauses while `document.visibilityState` is "hidden").
/// Ordering the window out still hides the page, so the lyrics stop exactly when the controller
/// hides them. `_setWindowOcclusionDetectionEnabled:` is WebKit SPI; where it is missing this
/// does nothing.
fn keep_page_visible(window: &WebviewWindow) -> Result<(), String> {
    window
        .with_webview(|webview| {
            let view = webview.inner().cast::<AnyObject>();
            // SAFETY: on the main thread, tauri hands out its live WKWebView for the duration of
            // this call. The setter is only sent where the view answers to it, and takes a BOOL.
            unsafe {
                let Some(view) = view.as_ref() else {
                    return;
                };
                let setter = sel!(_setWindowOcclusionDetectionEnabled:);
                let supported: bool = msg_send![view, respondsToSelector: setter];
                if supported {
                    let _: () = msg_send![view, _setWindowOcclusionDetectionEnabled: false];
                }
            }
        })
        .map_err(|e| e.to_string())
}

/// Calls `request_refresh` whenever `center` posts `name`. The block captures nothing and the
/// center copies it; the observer token is leaked on purpose so it lives as long as the app.
fn observe(center: &NSNotificationCenter, name: &NSNotificationName) {
    let block = RcBlock::new(|_: NonNull<NSNotification>| request_refresh());
    // SAFETY: no object filter and no queue (the block runs on the posting thread); the block only
    // stores an atomic flag, so it is sendable.
    let token = unsafe {
        center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
    };
    std::mem::forget(token);
}

impl DesktopLayer for MacDesktop {
    type Target = ();
    const HIDE_WHILE_ATTACHING: bool = false;

    fn install_notifications(_app: &AppHandle) -> Result<(), String> {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            // SAFETY: AppKit's notification names are immutable NSString constants.
            let (screens, hide, unhide, wake, screens_wake, space) = unsafe {
                (
                    NSApplicationDidChangeScreenParametersNotification,
                    NSApplicationDidHideNotification,
                    NSApplicationDidUnhideNotification,
                    NSWorkspaceDidWakeNotification,
                    NSWorkspaceScreensDidWakeNotification,
                    NSWorkspaceActiveSpaceDidChangeNotification,
                )
            };
            let center = NSNotificationCenter::defaultCenter();
            // Displays added, removed, rearranged or rescaled.
            observe(&center, screens);
            // Undertone hidden (⌘H in Settings, Hide Others in another app) or shown again. The
            // overlays opt out of hiding (`attach`), so neither should touch them; a pass checks
            // that each one still does and is still shown.
            observe(&center, hide);
            observe(&center, unhide);
            // Workspace notifications only arrive on NSWorkspace's own center. Re-applying after
            // sleep and on a Space switch is cheap insurance against a dropped desktop-level window.
            let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
            observe(&workspace, wake);
            observe(&workspace, screens_wake);
            observe(&workspace, space);
        });
        Ok(())
    }

    fn discover() -> Result<(), String> {
        Ok(())
    }

    fn is_valid(_: ()) -> bool {
        true
    }

    fn area(monitor: &Monitor) -> Bounds {
        geometry::rounded(geometry::monitor_points(
            physical(monitor),
            monitor.scale_factor(),
        ))
    }

    fn attach(window: &WebviewWindow, monitor: &Monitor, _: ()) -> Result<(), String> {
        let (mtm, ns_window) = ns_window(window)?;
        let frame = overlay_frame(mtm, monitor)?;
        keep_page_visible(window)?;
        // Never key: showing the overlay must not take focus from Settings or another app. The
        // controller and tauri.conf.json create overlays non-focusable; this is a safety net that
        // runs at most once per window, because tao's set_focusable leaks a retain on every call.
        if ns_window.canBecomeKeyWindow() {
            window.set_focusable(false).map_err(|e| e.to_string())?;
        }
        ns_window.setLevel(desktop_level());
        // Hiding Undertone (⌘H in Settings, which tauri's default menu binds, or Hide Others in
        // any app) hides Settings only. The lyrics stay, like the Finder's desktop.
        ns_window.setCanHide(false);
        ns_window.setIgnoresMouseEvents(true);
        ns_window.setOpaque(false);
        ns_window.setBackgroundColor(Some(&NSColor::clearColor()));
        ns_window.setHasShadow(false);
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        // Below the menu bar and clear of the Dock, so the lyrics center in the space apps use; the
        // page keeps Size relative to the whole screen.
        ns_window.setFrame_display(frame, true);
        Ok(())
    }

    fn attachment(window: &WebviewWindow, monitor: &Monitor, _: ()) -> Attachment {
        let Ok((mtm, ns_window)) = ns_window(window) else {
            return Attachment::Detached;
        };
        if ns_window.level() != desktop_level() {
            return Attachment::Detached;
        }
        // No matching screen yet: attach runs and reports it, and the controller retries.
        match overlay_frame(mtm, monitor) {
            Ok(frame)
                if ns_window.ignoresMouseEvents()
                    && !ns_window.canHide()
                    && geometry::same_rect(rect(ns_window.frame()), rect(frame)) =>
            {
                Attachment::Placed
            }
            _ => Attachment::Misplaced,
        }
    }

    fn detach(window: &WebviewWindow) -> Result<(), String> {
        let (_, ns_window) = ns_window(window)?;
        ns_window.setLevel(NSNormalWindowLevel);
        ns_window.setCanHide(true);
        ns_window.setIgnoresMouseEvents(false);
        ns_window.setCollectionBehavior(NSWindowCollectionBehavior::Default);
        Ok(())
    }

    /// WebKit hides the page whenever the window is ordered out (and, for Settings, covered or
    /// minimized); overlays only skip the occlusion part (`keep_page_visible`).
    fn set_page_visible(_: &WebviewWindow, _: bool) -> Result<(), String> {
        Ok(())
    }

    fn report(window: &WebviewWindow) -> String {
        match ns_window(window) {
            Ok((_, ns_window)) => format!(
                "level {}, frame {:?}, AppKit occlusion: {}",
                ns_window.level(),
                rect(ns_window.frame()),
                if ns_window
                    .occlusionState()
                    .contains(NSWindowOcclusionState::Visible)
                {
                    "visible"
                } else {
                    "occluded (the page stays visible)"
                }
            ),
            Err(error) => error,
        }
    }

    fn debug_state(window: &WebviewWindow) -> String {
        match ns_window(window) {
            Ok((_, ns_window)) => format!(
                "level={} nsVisible={} occlusion={:#x} alpha={} frame={:?}",
                ns_window.level(),
                ns_window.isVisible(),
                ns_window.occlusionState().0,
                ns_window.alphaValue(),
                rect(ns_window.frame()),
            ),
            Err(error) => error,
        }
    }

    fn describe(_: ()) -> String {
        format!(
            "desktop window level {} on every Space; no handles to find",
            desktop_level()
        )
    }
}
