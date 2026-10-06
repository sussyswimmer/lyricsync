//! macOS: the overlay stays a normal top-level NSWindow, lowered to the desktop window level
//! (above the wallpaper, below the Finder's icons and every app window). Nothing to discover.
use super::{
    geometry::{self, Bounds, Rect},
    request_refresh, DesktopLayer,
};
use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSApplicationDidChangeScreenParametersNotification, NSColor, NSNormalWindowLevel, NSScreen,
    NSWindow, NSWindowCollectionBehavior, NSWindowLevel, NSWorkspace,
    NSWorkspaceActiveSpaceDidChangeNotification, NSWorkspaceDidWakeNotification,
    NSWorkspaceScreensDidWakeNotification,
};
use objc2_core_graphics::{CGWindowLevelForKey, CGWindowLevelKey};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSNotificationName, NSRect};
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
            let (screens, wake, screens_wake, space) = unsafe {
                (
                    NSApplicationDidChangeScreenParametersNotification,
                    NSWorkspaceDidWakeNotification,
                    NSWorkspaceScreensDidWakeNotification,
                    NSWorkspaceActiveSpaceDidChangeNotification,
                )
            };
            // Displays added, removed, rearranged or rescaled.
            observe(&NSNotificationCenter::defaultCenter(), screens);
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
        let screens = NSScreen::screens(mtm).to_vec();
        let frames: Vec<Rect> = screens.iter().map(|screen| rect(screen.frame())).collect();
        let primary = *frames.first().ok_or("no screens attached")?;
        let quartz: Vec<Rect> = frames
            .iter()
            .map(|frame| geometry::flip_y(*frame, primary))
            .collect();
        let wanted = geometry::monitor_points(physical(monitor), monitor.scale_factor());
        let index = geometry::match_screen(wanted, &quartz)
            .ok_or_else(|| format!("no screen matches display {wanted:?} yet"))?;
        // Never key: showing the overlay must not take focus from Settings or another app. The
        // controller and tauri.conf.json create overlays non-focusable; this is a safety net that
        // runs at most once per window, because tao's set_focusable leaks a retain on every call.
        if ns_window.canBecomeKeyWindow() {
            window.set_focusable(false).map_err(|e| e.to_string())?;
        }
        ns_window.setLevel(desktop_level());
        ns_window.setIgnoresMouseEvents(true);
        ns_window.setOpaque(false);
        ns_window.setBackgroundColor(Some(&NSColor::clearColor()));
        ns_window.setHasShadow(false);
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        // The full frame in Cocoa coordinates, menu bar and Dock included, like the wallpaper.
        ns_window.setFrame_display(screens[index].frame(), true);
        Ok(())
    }

    fn detach(window: &WebviewWindow) -> Result<(), String> {
        window.hide().map_err(|e| e.to_string())?;
        let (_, ns_window) = ns_window(window)?;
        ns_window.setLevel(NSNormalWindowLevel);
        ns_window.setIgnoresMouseEvents(false);
        ns_window.setCollectionBehavior(NSWindowCollectionBehavior::Default);
        Ok(())
    }

    fn describe(_: ()) -> String {
        format!(
            "desktop window level {} on every Space; no handles to find",
            desktop_level()
        )
    }
}
