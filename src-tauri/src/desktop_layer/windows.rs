//! Explorer's desktop hierarchy is undocumented. See docs/DESKTOP_LAYER.md.
use super::{geometry::Bounds, request_refresh, styles, Attachment, DesktopLayer};
use std::{
    ptr::null_mut,
    sync::atomic::{AtomicU32, Ordering},
};
use tauri::{AppHandle, Manager, Monitor, WebviewWindow};
use windows_sys::{
    core::w,
    Win32::{
        Foundation::{GetLastError, SetLastError, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::Gdi::MapWindowPoints,
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::*,
        },
    },
};

static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
const SUBCLASS_ID: usize = 0x554e544f;
/// The subclass's reference data: what the window is to us.
const ANCHOR: usize = 0;
const OVERLAY: usize = 1;

// styles.rs keeps its own copies so it tests on every OS; they must be the real values.
const _: () = assert!(
    styles::WS_CHILD == WS_CHILD
        && styles::WS_POPUP == WS_POPUP
        && styles::WS_EX_TRANSPARENT == WS_EX_TRANSPARENT
        && styles::WS_EX_TOOLWINDOW == WS_EX_TOOLWINDOW
        && styles::WS_EX_APPWINDOW == WS_EX_APPWINDOW
        && styles::WS_EX_LAYERED == WS_EX_LAYERED
        && styles::WS_EX_NOACTIVATE == WS_EX_NOACTIVATE
);

pub struct WindowsDesktop;
#[derive(Clone, Copy)]
pub struct Target {
    parent: usize,
    below: usize,
    wallpaper: usize,
}
impl Target {
    pub fn is_valid(self) -> bool {
        // SAFETY: IsWindow accepts potentially stale handles and never dereferences them in Rust.
        unsafe { IsWindow(self.parent as HWND) != 0 && IsWindow(self.wallpaper as HWND) != 0 }
    }
}

unsafe extern "system" fn find_legacy(top: HWND, parameter: LPARAM) -> i32 {
    // SAFETY: EnumWindows synchronously invokes this callback with a live pointer to our local target.
    unsafe {
        let icons = FindWindowExW(top, null_mut(), w!("SHELLDLL_DefView"), std::ptr::null());
        if !icons.is_null() {
            let worker = FindWindowExW(null_mut(), top, w!("WorkerW"), std::ptr::null());
            if !worker.is_null() {
                *(parameter as *mut HWND) = worker;
                return 0;
            }
        }
    }
    1
}

impl DesktopLayer for WindowsDesktop {
    type Target = Target;
    const HIDE_WHILE_ATTACHING: bool = true;
    fn install_notifications(app: &AppHandle) -> Result<(), String> {
        let anchor = app
            .get_webview_window("settings")
            .ok_or("settings notification window missing")?;
        // Keep this hidden top-level window alive (lib.rs hides it on close instead of destroying it):
        // child overlays receive none of the broadcasts below (TaskbarCreated, display, DPI, work
        // area, power).
        subclass(&anchor, ANCHOR)
    }
    fn is_valid(target: Target) -> bool {
        target.is_valid()
    }
    fn area(monitor: &Monitor) -> Bounds {
        let (position, size) = (monitor.position(), monitor.size());
        (position.x, position.y, size.width, size.height)
    }
    fn discover() -> Result<Target, String> {
        // SAFETY: All class strings are static UTF-16; no borrowed pointers escape these Win32 calls.
        unsafe {
            let progman = FindWindowW(w!("Progman"), std::ptr::null());
            if progman.is_null() {
                return Err("Explorer Progman is unavailable".into());
            }
            let mut result = 0;
            if SendMessageTimeoutW(progman, 0x052c, 0xd, 1, SMTO_ABORTIFHUNG, 1000, &mut result)
                == 0
            {
                return Err("Explorer did not respond to desktop-layer creation".into());
            }
            let icons = FindWindowExW(
                progman,
                null_mut(),
                w!("SHELLDLL_DefView"),
                std::ptr::null(),
            );
            let child_worker = FindWindowExW(progman, null_mut(), w!("WorkerW"), std::ptr::null());
            // Raised desktop (24H2): a transparent layered sibling belongs between DefView and wallpaper.
            // Parenting *inside* the wallpaper WorkerW can place the overlay behind its opaque content.
            if !icons.is_null() && !child_worker.is_null() {
                return Ok(Target {
                    parent: progman as usize,
                    below: icons as usize,
                    wallpaper: child_worker as usize,
                });
            }
            let mut worker: HWND = null_mut();
            EnumWindows(Some(find_legacy), &mut worker as *mut HWND as LPARAM);
            if worker.is_null() {
                return Err("No WorkerW behind the desktop icons; overlay stays hidden".into());
            }
            Ok(Target {
                parent: worker as usize,
                below: 0,
                wallpaper: worker as usize,
            })
        }
    }

    fn attach(window: &WebviewWindow, monitor: &Monitor, target: Target) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as HWND;
        if !target.is_valid() {
            return Err("Desktop parent disappeared before attachment".into());
        }
        // Before restyling, so WM_STYLECHANGING keeps these styles through tao's later rewrites.
        subclass(window, OVERLAY)?;
        window
            .set_ignore_cursor_events(true)
            .map_err(|e| e.to_string())?;
        // SAFETY: Called on the event-loop thread for a live Tauri window. Target was rediscovered above.
        unsafe {
            // Already under this parent (a display moved or rescaled): move and restack in place.
            // Otherwise the controller has hidden it, and SetParent's documentation asks for
            // WS_CHILD instead of WS_POPUP first.
            let reparent = parent(hwnd) != target.parent as HWND;
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
            let restyle = !styles::is_attached(style, ex);
            if restyle {
                set_style(hwnd, GWL_EXSTYLE, styles::attached_ex(ex) as isize)?;
                set_style(hwnd, GWL_STYLE, styles::attached(style) as isize)?;
            }
            if reparent {
                SetLastError(0);
                let old_parent = SetParent(hwnd, target.parent as HWND);
                if old_parent.is_null() && GetLastError() != 0 {
                    return Err(last_error("SetParent"));
                }
            }
            if SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA) == 0 {
                return Err(last_error("SetLayeredWindowAttributes"));
            }
            let position = monitor.position();
            let mut origin = POINT {
                x: position.x,
                y: position.y,
            };
            // Monitor positions are physical desktop coordinates; children use their parent's client origin.
            SetLastError(0);
            if MapWindowPoints(null_mut(), target.parent as HWND, &mut origin, 1) == 0
                && GetLastError() != 0
            {
                return Err(last_error("MapWindowPoints"));
            }
            if target.below != 0
                && SetWindowPos(
                    target.wallpaper as HWND,
                    HWND_BOTTOM,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                ) == 0
            {
                return Err(last_error("wallpaper z-order"));
            }
            let size = monitor.size();
            // New styles or a new parent take effect only with SWP_FRAMECHANGED; a window moved in
            // place keeps both (WM_STYLECHANGING) and needs no frame recalculation.
            let frame = if restyle || reparent {
                SWP_FRAMECHANGED
            } else {
                0
            };
            if SetWindowPos(
                hwnd,
                target.below as HWND,
                origin.x,
                origin.y,
                size.width as i32,
                size.height as i32,
                SWP_NOACTIVATE | frame,
            ) == 0
            {
                return Err(last_error("SetWindowPos"));
            }
        }
        Ok(())
    }

    fn attachment(window: &WebviewWindow, monitor: &Monitor, target: Target) -> Attachment {
        let Ok(hwnd) = window.hwnd().map(|hwnd| hwnd.0 as HWND) else {
            return Attachment::Detached;
        };
        // SAFETY: Read-only queries on the event-loop thread; stale handles only fail the comparisons.
        unsafe {
            if !target.is_valid() || parent(hwnd) != target.parent as HWND {
                return Attachment::Detached;
            }
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            // Screen coordinates in physical pixels (PerMonitorV2), like the monitor's area.
            let framed = GetWindowRect(hwnd, &mut rect) != 0
                && (rect.left, rect.top) == (monitor.position().x, monitor.position().y)
                && (rect.right - rect.left, rect.bottom - rect.top)
                    == (monitor.size().width as i32, monitor.size().height as i32);
            if styles::is_attached(style, ex) && framed && stacked(hwnd, target) {
                Attachment::Placed
            } else {
                Attachment::Misplaced
            }
        }
    }

    fn detach(window: &WebviewWindow) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as HWND;
        // SAFETY: Called on the owning event-loop thread; the hidden window is immediately destroyed by the caller.
        unsafe {
            // Top-level first: WM_STYLECHANGING stops enforcing the child styles once the parent is
            // the desktop, so the popup style below sticks.
            SetLastError(0);
            if SetParent(hwnd, null_mut()).is_null() && GetLastError() != 0 {
                return Err(last_error("detach SetParent"));
            }
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
            set_style(hwnd, GWL_STYLE, styles::detached(style) as isize)?;
        }
        Ok(())
    }

    fn set_page_visible(window: &WebviewWindow, visible: bool) -> Result<(), String> {
        // Synchronous on the event-loop thread; queued in order behind show/hide from elsewhere.
        window
            .with_webview(move |webview| {
                // SAFETY: tauri hands out the live controller on the thread that owns it.
                if let Err(error) = unsafe { webview.controller().SetIsVisible(visible) } {
                    eprintln!("desktop layer: page visibility: {error}");
                }
            })
            .map_err(|e| e.to_string())
    }

    fn report(window: &WebviewWindow) -> String {
        let Ok(hwnd) = window.hwnd().map(|hwnd| hwnd.0 as HWND) else {
            return "no window handle".into();
        };
        // SAFETY: Read-only queries on the event-loop thread for a live window.
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            format!(
                "parent {:#x}, {}",
                parent(hwnd) as usize,
                styles::describe(style, ex)
            )
        }
    }

    fn describe(target: Target) -> String {
        let layout = if target.below != 0 {
            "raised desktop (24H2): under Progman, between icons and wallpaper"
        } else {
            "classic: inside the WorkerW behind the icons"
        };
        format!(
            "{layout}; parent {:#x}, below {:#x}, wallpaper {:#x}",
            target.parent, target.below, target.wallpaper
        )
    }
}

/// The real parent: GetParent would return an owner for a top-level window.
unsafe fn parent(hwnd: HWND) -> HWND {
    // SAFETY: GetAncestor accepts any handle and returns null for a stale one.
    unsafe { GetAncestor(hwnd, GA_PARENT) }
}

/// Raised desktop: between the icons above and the wallpaper below, among its parent's children.
/// The classic WorkerW holds nothing else that could cover the overlay.
unsafe fn stacked(hwnd: HWND, target: Target) -> bool {
    if target.below == 0 {
        return true;
    }
    // SAFETY: GetWindow walks the sibling list of live windows on their owning thread; a stale
    // handle ends the walk with null. Progman has a handful of children; the bound is a backstop.
    unsafe {
        let finds = |direction: GET_WINDOW_CMD, wanted: usize| {
            let mut sibling = GetWindow(hwnd, direction);
            for _ in 0..256 {
                if sibling.is_null() {
                    return false;
                }
                if sibling as usize == wanted {
                    return true;
                }
                sibling = GetWindow(sibling, direction);
            }
            false
        };
        finds(GW_HWNDPREV, target.below) && finds(GW_HWNDNEXT, target.wallpaper)
    }
}

unsafe fn set_style(hwnd: HWND, index: i32, value: isize) -> Result<(), String> {
    // SAFETY: Caller holds a live HWND on its owning thread; zero is a valid previous style value.
    unsafe {
        SetLastError(0);
        if SetWindowLongPtrW(hwnd, index, value) == 0 && GetLastError() != 0 {
            return Err(last_error("SetWindowLongPtrW"));
        }
    }
    Ok(())
}
fn last_error(operation: &str) -> String {
    format!("{operation}: {}", std::io::Error::last_os_error())
}

/// The settings anchor (`ANCHOR`) requests a refresh on Explorer restarts, display, DPI, work-area
/// and power changes, which only top-level windows receive. Overlays (`OVERLAY`) keep their
/// attached styles. Installing again on the same window only updates `kind`.
fn subclass(window: &WebviewWindow, kind: usize) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as HWND;
    // SAFETY: Subclass is installed on the owning thread; callback owns no heap state and removes itself on destruction.
    unsafe {
        let message = RegisterWindowMessageW(w!("TaskbarCreated"));
        if message == 0 {
            return Err(last_error("RegisterWindowMessageW"));
        }
        TASKBAR_CREATED.store(message, Ordering::Release);
        if SetWindowSubclass(hwnd, Some(on_message), SUBCLASS_ID, kind) == 0 {
            return Err(last_error("SetWindowSubclass"));
        }
    }
    Ok(())
}
unsafe extern "system" fn on_message(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _: usize,
    kind: usize,
) -> LRESULT {
    // A display's resolution or arrangement (WM_DISPLAYCHANGE), the anchor's own display scale
    // (WM_DPICHANGED), and any display's scale or the taskbar (the work area: what Chromium
    // watches for scale changes, since children never get WM_DPICHANGED).
    if message == TASKBAR_CREATED.load(Ordering::Acquire)
        || matches!(
            message,
            WM_DISPLAYCHANGE | WM_DPICHANGED | WM_POWERBROADCAST
        )
        || (message == WM_SETTINGCHANGE && wparam == SPI_SETWORKAREA as WPARAM)
    {
        request_refresh();
    }
    // SAFETY: The callback has the same lifetime as the native window; forward every message to Tauri's original procedure.
    unsafe {
        if message == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, Some(on_message), SUBCLASS_ID);
            request_refresh();
        }
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        // tao rewrites both style words from its own flags on every show and hide. While the
        // overlay hangs under Explorer's window (its parent is not the desktop), the proposed
        // styles are amended last, after tao's own procedure has seen the message.
        if message == WM_STYLECHANGING && kind == OVERLAY && parent(hwnd) != GetDesktopWindow() {
            if let Some(change) = (lparam as *mut STYLESTRUCT).as_mut() {
                match wparam as i32 {
                    GWL_STYLE => change.styleNew = styles::attached(change.styleNew),
                    GWL_EXSTYLE => change.styleNew = styles::attached_ex(change.styleNew),
                    _ => {}
                }
            }
        }
        result
    }
}
