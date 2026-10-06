//! Display geometry for the macOS adapter, kept portable so it is unit-tested on every OS.
//!
//! Three coordinate spaces meet here:
//! - tauri `Monitor`: physical pixels. On macOS tao reports a display's Quartz bounds (points,
//!   origin at the primary display's top-left, y down) multiplied by *that display's* backing
//!   scale factor, so neighbors with different scales don't share one pixel grid.
//! - Quartz: points, top-left origin, y down. Comparable across displays.
//! - Cocoa (`NSScreen.frame`, `NSWindow.setFrame`): points, origin at the primary screen's
//!   bottom-left, y up.

/// A rectangle in points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A monitor's physical bounds as tauri reports them: x, y, width, height.
pub type Bounds = (i32, i32, u32, u32);

/// Rounding to whole physical pixels moves an edge by at most half a pixel.
const TOLERANCE: f64 = 1.0;

/// A tauri monitor in Quartz points: undoes tao's multiplication by the monitor's own scale.
pub fn monitor_points((x, y, width, height): Bounds, scale: f64) -> Rect {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    Rect {
        x: f64::from(x) / scale,
        y: f64::from(y) / scale,
        width: f64::from(width) / scale,
        height: f64::from(height) / scale,
    }
}

/// `rect` rounded to whole points: a monitor's area as the controller compares them. In points,
/// every display of a mirror set has the same origin, whatever scale tao gave it (a display with
/// no NSScreen of its own, like a mirror, gets 1.0 there).
pub fn rounded(rect: Rect) -> Bounds {
    (
        rect.x.round() as i32,
        rect.y.round() as i32,
        rect.width.round() as u32,
        rect.height.round() as u32,
    )
}

/// Converts between Cocoa and Quartz by flipping y around the primary screen (`NSScreen.screens[0]`,
/// the one with the menu bar, at the origin of both spaces). The flip is its own inverse.
pub fn flip_y(rect: Rect, primary: Rect) -> Rect {
    Rect {
        y: primary.y + primary.height - (rect.y + rect.height),
        ..rect
    }
}

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() <= TOLERANCE
}

/// The screen (Quartz points) that shows `monitor` (Quartz points). Same bounds first; then the
/// same origin, in case a display mode reports its size in pixels rather than points. Displays
/// never share an origin unless they mirror each other, and then either one is right. `None`
/// while the two lists disagree, as they can for a moment during a display change: the caller
/// retries.
pub fn match_screen(monitor: Rect, screens: &[Rect]) -> Option<usize> {
    let same_origin = |s: &Rect| near(s.x, monitor.x) && near(s.y, monitor.y);
    screens
        .iter()
        .position(|s| {
            same_origin(s) && near(s.width, monitor.width) && near(s.height, monitor.height)
        })
        .or_else(|| screens.iter().position(same_origin))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }
    /// A 1512×982 pt Retina laptop (primary, scale 2), a 2560×1440 pt monitor at scale 1 to its
    /// right with its top 200 pt higher, and a 1920×1080 pt one above the laptop at scale 2.
    fn cocoa_screens() -> Vec<Rect> {
        vec![
            rect(0.0, 0.0, 1512.0, 982.0),
            rect(1512.0, -258.0, 2560.0, 1440.0),
            rect(-204.0, 982.0, 1920.0, 1080.0),
        ]
    }
    fn quartz_screens() -> Vec<Rect> {
        let screens = cocoa_screens();
        screens.iter().map(|s| flip_y(*s, screens[0])).collect()
    }

    #[test]
    fn monitor_points_undoes_each_monitors_own_scale() {
        assert_eq!(
            monitor_points((0, 0, 3024, 1964), 2.0),
            rect(0.0, 0.0, 1512.0, 982.0)
        );
        assert_eq!(
            monitor_points((1512, -200, 2560, 1440), 1.0),
            rect(1512.0, -200.0, 2560.0, 1440.0)
        );
        // A scale-2 monitor left of and above the primary: negative origins scale too.
        assert_eq!(
            monitor_points((-408, -2160, 3840, 2160), 2.0),
            rect(-204.0, -1080.0, 1920.0, 1080.0)
        );
    }

    #[test]
    fn monitor_points_survives_a_missing_scale() {
        assert_eq!(
            monitor_points((10, 20, 30, 40), 0.0),
            rect(10.0, 20.0, 30.0, 40.0)
        );
        assert_eq!(
            monitor_points((10, 20, 30, 40), f64::NAN),
            rect(10.0, 20.0, 30.0, 40.0)
        );
    }

    #[test]
    fn a_mirror_set_shares_its_area_origin_whatever_the_scale() {
        // A Retina laptop (scale 2) mirrored to a projector that has no NSScreen (tao: scale 1).
        let laptop = rounded(monitor_points((0, 0, 3024, 1964), 2.0));
        let projector = rounded(monitor_points((0, 0, 1280, 800), 1.0));
        assert_eq!(laptop, (0, 0, 1512, 982));
        assert_eq!((laptop.0, laptop.1), (projector.0, projector.1));
        // Off the origin, physical pixels differ by scale but points agree.
        assert_eq!(
            rounded(monitor_points((3024, -400, 5120, 2880), 2.0)),
            rounded(monitor_points((1512, -200, 2560, 1440), 1.0))
        );
        // tao's rounding to whole pixels doesn't leak into the key.
        assert_eq!(
            rounded(monitor_points((1502, 0, 1920, 1080), 1.5)),
            (1001, 0, 1280, 720)
        );
    }

    #[test]
    fn flip_y_maps_cocoa_to_quartz() {
        let quartz = quartz_screens();
        assert_eq!(quartz[0], rect(0.0, 0.0, 1512.0, 982.0));
        // Bottom edge 258 pt below the primary's bottom (y = 982 in Quartz) → top at 982 + 258 − 1440.
        assert_eq!(quartz[1], rect(1512.0, -200.0, 2560.0, 1440.0));
        // Sits on top of the primary: its bottom edge is the primary's top edge.
        assert_eq!(quartz[2], rect(-204.0, -1080.0, 1920.0, 1080.0));
    }

    #[test]
    fn flip_y_is_its_own_inverse() {
        let screens = cocoa_screens();
        for screen in &screens {
            assert_eq!(flip_y(flip_y(*screen, screens[0]), screens[0]), *screen);
        }
    }

    #[test]
    fn matches_each_monitor_to_its_screen_whatever_the_order() {
        let screens = quartz_screens();
        // tao lists displays in CGGetActiveDisplayList order, not NSScreen order.
        let monitors = [
            ((-408, -2160, 3840, 2160), 2.0, 2),
            ((1512, -200, 2560, 1440), 1.0, 1),
            ((0, 0, 3024, 1964), 2.0, 0),
        ];
        for (bounds, scale, expected) in monitors {
            assert_eq!(
                match_screen(monitor_points(bounds, scale), &screens),
                Some(expected)
            );
        }
    }

    #[test]
    fn tolerates_rounding_to_whole_pixels() {
        // A 1.5× display at a fractional point origin: tao rounds 1001.5 * 1.5 to 1502.
        let screens = [
            rect(0.0, 0.0, 1000.0, 800.0),
            rect(1001.5, 0.0, 1280.0, 720.0),
        ];
        let monitor = monitor_points((1502, 0, 1920, 1080), 1.5);
        assert_eq!(match_screen(monitor, &screens), Some(1));
    }

    #[test]
    fn falls_back_to_the_screen_at_the_same_origin() {
        // Size reported in pixels instead of points: the origin still identifies the screen.
        let screens = [
            rect(0.0, 0.0, 1512.0, 982.0),
            rect(1512.0, 0.0, 1920.0, 1080.0),
        ];
        let monitor = rect(1512.0, 0.0, 3840.0, 2160.0);
        assert_eq!(match_screen(monitor, &screens), Some(1));
    }

    #[test]
    fn exact_bounds_beat_a_shared_origin() {
        // Mirrored displays share an origin; prefer the one with the same size too.
        let screens = [
            rect(0.0, 0.0, 1920.0, 1080.0),
            rect(0.0, 0.0, 1512.0, 982.0),
        ];
        assert_eq!(
            match_screen(rect(0.0, 0.0, 1512.0, 982.0), &screens),
            Some(1)
        );
    }

    #[test]
    fn no_match_while_the_lists_disagree() {
        let screens = quartz_screens();
        assert_eq!(
            match_screen(rect(5000.0, 0.0, 800.0, 600.0), &screens),
            None
        );
        assert_eq!(match_screen(rect(0.0, 0.0, 1512.0, 982.0), &[]), None);
    }
}
