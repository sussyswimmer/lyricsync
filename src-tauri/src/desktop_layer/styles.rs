//! The Win32 styles of an overlay attached under Explorer's desktop windows, as plain arithmetic so
//! it is unit-tested on every OS. windows.rs checks these values against windows-sys when it builds.
//!
//! tao rewrites both style words from its own flags on every show and hide (`apply_diff`), which
//! would drop WS_CHILD and WS_EX_TOOLWINDOW and add WS_EX_APPWINDOW. While an overlay is attached,
//! windows.rs answers WM_STYLECHANGING with `attached` and `attached_ex`, so the rewrite keeps them.

pub const WS_CHILD: u32 = 0x4000_0000;
pub const WS_POPUP: u32 = 0x8000_0000;
pub const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
pub const WS_EX_APPWINDOW: u32 = 0x0004_0000;
pub const WS_EX_LAYERED: u32 = 0x0008_0000;
pub const WS_EX_NOACTIVATE: u32 = 0x0800_0000;

/// Layered and transparent: clicks fall through to the desktop. Tool window: no taskbar button and
/// no Alt+Tab entry. No-activate: never takes focus.
const ATTACHED_EX: u32 = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;

/// An attached overlay is a child of Explorer's window, never a popup.
pub const fn attached(style: u32) -> u32 {
    (style | WS_CHILD) & !WS_POPUP
}

pub const fn attached_ex(ex: u32) -> u32 {
    (ex | ATTACHED_EX) & !WS_EX_APPWINDOW
}

/// A top-level window again, set after `SetParent(hwnd, NULL)` as its documentation asks.
pub const fn detached(style: u32) -> u32 {
    (style & !WS_CHILD) | WS_POPUP
}

/// Whether both style words already are what an attached overlay keeps.
pub const fn is_attached(style: u32, ex: u32) -> bool {
    attached(style) == style && attached_ex(ex) == ex
}

/// For the debug `--desktop-layer-test` log.
pub fn describe(style: u32, ex: u32) -> String {
    let yes = |word: u32, flag: u32| if word & flag != 0 { "yes" } else { "no" };
    format!(
        "style {style:#010x} (child {}, popup {}), ex {ex:#010x} (layered {}, transparent {}, \
         tool window {}, no-activate {}, app window {})",
        yes(style, WS_CHILD),
        yes(style, WS_POPUP),
        yes(ex, WS_EX_LAYERED),
        yes(ex, WS_EX_TRANSPARENT),
        yes(ex, WS_EX_TOOLWINDOW),
        yes(ex, WS_EX_NOACTIVATE),
        yes(ex, WS_EX_APPWINDOW),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // What tao 0.37 asks for on show() for an overlay: undecorated, not resizable, minimizable and
    // maximizable, visible, on the taskbar, click-through, not focusable.
    const WS_CAPTION: u32 = 0x00c0_0000;
    const WS_CLIPSIBLINGS: u32 = 0x0400_0000;
    const WS_SYSMENU: u32 = 0x0008_0000;
    const WS_VISIBLE: u32 = 0x1000_0000;
    const WS_MINMAXBOXES: u32 = 0x0003_0000;
    const WS_EX_WINDOWEDGE: u32 = 0x0000_0100;
    const WS_EX_ACCEPTFILES: u32 = 0x0000_0010;
    const TAO_STYLE: u32 = WS_CAPTION | WS_CLIPSIBLINGS | WS_SYSMENU | WS_VISIBLE | WS_MINMAXBOXES;
    const TAO_EX: u32 = WS_EX_WINDOWEDGE
        | WS_EX_ACCEPTFILES
        | WS_EX_APPWINDOW
        | WS_EX_TRANSPARENT
        | WS_EX_LAYERED
        | WS_EX_NOACTIVATE;

    #[test]
    fn taos_rewrite_keeps_an_attached_overlay_a_child() {
        let style = attached(TAO_STYLE);
        assert_eq!(style, TAO_STYLE | WS_CHILD);
        assert_eq!(attached(TAO_STYLE | WS_POPUP), style);
    }

    #[test]
    fn taos_rewrite_keeps_an_attached_overlay_off_the_taskbar() {
        let ex = attached_ex(TAO_EX);
        assert_eq!(ex & WS_EX_APPWINDOW, 0);
        assert_eq!(ex & ATTACHED_EX, ATTACHED_EX);
        // Everything else tao asked for stays.
        assert_eq!(
            ex & (WS_EX_WINDOWEDGE | WS_EX_ACCEPTFILES),
            WS_EX_WINDOWEDGE | WS_EX_ACCEPTFILES
        );
        // Even a rewrite that lost click-through and no-activate gets them back.
        assert_eq!(attached_ex(WS_EX_APPWINDOW), ATTACHED_EX);
    }

    #[test]
    fn enforcing_twice_changes_nothing() {
        let (style, ex) = (attached(TAO_STYLE), attached_ex(TAO_EX));
        assert_eq!(attached(style), style);
        assert_eq!(attached_ex(ex), ex);
        assert!(is_attached(style, ex));
        assert!(!is_attached(TAO_STYLE, ex));
        assert!(!is_attached(style, TAO_EX));
    }

    #[test]
    fn detaching_undoes_the_child_style() {
        let style = detached(attached(TAO_STYLE));
        assert_eq!(style & WS_CHILD, 0);
        assert_ne!(style & WS_POPUP, 0);
        assert_eq!(style & !WS_POPUP, TAO_STYLE);
    }

    #[test]
    fn describes_each_flag() {
        let line = describe(attached(TAO_STYLE), attached_ex(TAO_EX));
        assert!(line.contains("child yes, popup no"), "{line}");
        assert!(line.contains("tool window yes"), "{line}");
        assert!(line.contains("app window no"), "{line}");
        assert!(describe(TAO_STYLE, TAO_EX).contains("app window yes"));
    }
}
