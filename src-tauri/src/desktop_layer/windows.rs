//! Explorer's desktop hierarchy is undocumented. See docs/DESKTOP_LAYER.md.
use super::DesktopLayer;
use std::{
    ptr::null_mut,
    sync::atomic::{AtomicBool, AtomicU32, Ordering},
};
use tauri::{Monitor, WebviewWindow};
use windows_sys::{
    core::w,
    Win32::{
        Foundation::{GetLastError, SetLastError, HWND, LPARAM, LRESULT, POINT, WPARAM},
        Graphics::Gdi::MapWindowPoints,
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::*,
        },
    },
};

static DIRTY: AtomicBool = AtomicBool::new(true);
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
const SUBCLASS_ID: usize = 0x554e544f;

pub fn request_refresh() {
    DIRTY.store(true, Ordering::Release);
}
pub fn take_refresh() -> bool {
    DIRTY.swap(false, Ordering::AcqRel)
}

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
        install_notifications(window)?;
        window
            .set_ignore_cursor_events(true)
            .map_err(|e| e.to_string())?;
        // SAFETY: Called on the event-loop thread for a live Tauri window. Target was rediscovered above.
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            set_style(
                hwnd,
                GWL_EXSTYLE,
                (ex | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)
                    as isize,
            )?;
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
            set_style(hwnd, GWL_STYLE, ((style | WS_CHILD) & !WS_POPUP) as isize)?;
            SetLastError(0);
            let old_parent = SetParent(hwnd, target.parent as HWND);
            if old_parent.is_null() && GetLastError() != 0 {
                return Err(last_error("SetParent"));
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
            if SetWindowPos(
                hwnd,
                target.below as HWND,
                origin.x,
                origin.y,
                size.width as i32,
                size.height as i32,
                SWP_NOACTIVATE | SWP_FRAMECHANGED,
            ) == 0
            {
                return Err(last_error("SetWindowPos"));
            }
        }
        Ok(())
    }

    fn detach(window: &WebviewWindow) -> Result<(), String> {
        window.hide().map_err(|e| e.to_string())?;
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as HWND;
        // SAFETY: Called on the owning event-loop thread; the hidden window is immediately destroyed by the caller.
        unsafe {
            SetLastError(0);
            if SetParent(hwnd, null_mut()).is_null() && GetLastError() != 0 {
                return Err(last_error("detach SetParent"));
            }
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
            set_style(hwnd, GWL_STYLE, ((style & !WS_CHILD) | WS_POPUP) as isize)?;
        }
        Ok(())
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

pub fn install_notifications(window: &WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as HWND;
    // SAFETY: Subclass is installed on the owning thread; callback owns no heap state and removes itself on destruction.
    unsafe {
        let message = RegisterWindowMessageW(w!("TaskbarCreated"));
        if message == 0 {
            return Err(last_error("RegisterWindowMessageW"));
        }
        TASKBAR_CREATED.store(message, Ordering::Release);
        if SetWindowSubclass(hwnd, Some(on_message), SUBCLASS_ID, 0) == 0 {
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
    _: usize,
) -> LRESULT {
    if message == TASKBAR_CREATED.load(Ordering::Acquire)
        || matches!(
            message,
            WM_DISPLAYCHANGE | WM_DPICHANGED | WM_POWERBROADCAST
        )
    {
        request_refresh();
    }
    // SAFETY: The callback has the same lifetime as the native window; forward every message to Tauri's original procedure.
    unsafe {
        if message == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, Some(on_message), SUBCLASS_ID);
            request_refresh();
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }
}
