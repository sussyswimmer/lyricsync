//! Launch at login on macOS, as the user last set it anywhere. tauri-plugin-autostart keeps the
//! login item as a LaunchAgent plist (`~/Library/LaunchAgents/Undertone.plist`) and calls it on
//! whenever that file exists, so turning Undertone off under System Settings › General › Login
//! Items › Allow in the Background went unseen: launch at login stopped, the switch stayed on.
//! macOS 13+ reports what it does with such a plist (`SMAppService.statusForLegacyURL`); that
//! status decides here. Windows needs none of this: auto-launch already reads Task Manager's
//! StartupApproved state.
//!
//! The decisions are portable and tested on every OS; `native` asks macOS.
use std::path::{Path, PathBuf};

/// `SMAppServiceStatus` values.
pub const NOT_REGISTERED: isize = 0;
pub const ENABLED: isize = 1;
/// Registered, but the user has turned it off in System Settings.
pub const REQUIRES_APPROVAL: isize = 2;
pub const NOT_FOUND: isize = 3;

/// The plist the autostart plugin writes: named after the app (`productName`).
pub fn legacy_plist(home: &Path, app_name: &str) -> PathBuf {
    home.join("Library")
        .join("LaunchAgents")
        .join(format!("{app_name}.plist"))
}

/// Whether Undertone starts at login: its plist exists and System Settings hasn't turned it off.
/// Not registered and not found count as on while the plist exists: Background Task Management
/// may not have seen a plist written a moment ago, and calling that off would turn the switch
/// back off right after the user turned it on.
pub fn is_on(plist_exists: bool, status: isize) -> bool {
    plist_exists && status != REQUIRES_APPROVAL
}

/// After the plist is written: an error while System Settings still keeps Undertone from starting
/// at login, which rewriting the plist can't undo. Only the user can, there.
pub fn check_enabled(status: isize) -> Result<(), String> {
    if status == REQUIRES_APPROVAL {
        Err("launch at login: turned off in System Settings › General › Login Items".into())
    } else {
        Ok(())
    }
}

#[cfg(all(feature = "desktop", target_os = "macos"))]
pub mod native {
    use objc2_foundation::NSURL;
    use objc2_service_management::SMAppService;
    use std::path::Path;

    /// What macOS does with the LaunchAgent plist at `plist`; `NOT_FOUND` when it can't be asked.
    pub fn status(plist: &Path) -> isize {
        let Some(url) = NSURL::from_file_path(plist) else {
            return super::NOT_FOUND;
        };
        // SAFETY: a class method that only reads, given a valid file URL. Any thread may call it.
        unsafe { SMAppService::statusForLegacyURL(&url) }.0
    }

    /// Opens System Settings at Login Items, where Undertone can be allowed again.
    pub fn open_login_items() {
        // SAFETY: a class method without arguments; the caller is on the main thread.
        unsafe { SMAppService::openSystemSettingsLoginItems() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plist_is_named_after_the_app_in_the_users_launch_agents() {
        assert_eq!(
            legacy_plist(Path::new("/Users/demo"), "Undertone"),
            PathBuf::from("/Users/demo/Library/LaunchAgents/Undertone.plist")
        );
    }

    #[test]
    fn off_in_system_settings_is_off_whatever_the_plist() {
        for status in [NOT_REGISTERED, ENABLED, REQUIRES_APPROVAL, NOT_FOUND, -1, 9] {
            assert!(!is_on(false, status), "no plist, status {status}");
        }
        assert!(is_on(true, ENABLED));
        assert!(!is_on(true, REQUIRES_APPROVAL));
        // Not known to macOS yet: the plist decides.
        assert!(is_on(true, NOT_REGISTERED));
        assert!(is_on(true, NOT_FOUND));
    }

    #[test]
    fn turning_it_on_fails_while_system_settings_keeps_it_off() {
        for status in [NOT_REGISTERED, ENABLED, NOT_FOUND] {
            assert_eq!(check_enabled(status), Ok(()), "status {status}");
        }
        let refused = check_enabled(REQUIRES_APPROVAL).unwrap_err();
        assert!(refused.contains("System Settings › General › Login Items"));
    }
}
