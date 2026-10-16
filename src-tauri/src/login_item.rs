//! Launch at login, as the user last set it anywhere, starting this copy of Undertone.
//! tauri-plugin-autostart keeps the login item as a LaunchAgent plist on macOS
//! (`~/Library/LaunchAgents/Undertone.plist`) and as a Run value on Windows (`Undertone` under
//! `HKCU\…\CurrentVersion\Run`), and calls it on whenever that exists.
//!
//! - macOS: turning Undertone off under System Settings › General › Login Items › Allow in the
//!   Background went unseen: launch at login stopped, the switch stayed on. macOS 13+ reports what
//!   it does with such a plist (`SMAppService.statusForLegacyURL`); that status decides here.
//!   Windows needs none of this: auto-launch already reads Task Manager's StartupApproved state.
//! - Both: the item holds the program's path from when it was turned on. Once the user moves
//!   Undertone, it starts nothing at login yet still reads as on. Startup points it at this copy
//!   again (`refresh`), unless this copy runs from a place it won't be at the next login.
//!
//! The decisions and parsers are portable and tested on every OS; `native` asks macOS and reads
//! the Windows registry.
use std::path::{Path, PathBuf};

/// `SMAppServiceStatus` values.
pub const NOT_REGISTERED: isize = 0;
pub const ENABLED: isize = 1;
/// Registered, but the user has turned it off in System Settings.
pub const REQUIRES_APPROVAL: isize = 2;
pub const NOT_FOUND: isize = 3;

/// Where auto-launch writes the Run value, under HKCU (HKLM when Undertone runs as an
/// administrator), and Task Manager's on/off for it, which auto-launch reads.
pub const RUN_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run";
pub const STARTUP_APPROVED_KEY: &str =
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

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

/// A `statusForLegacyURL` value as `--diagnose` names it.
pub fn status_name(status: isize) -> String {
    match status {
        NOT_REGISTERED => "Not registered".into(),
        ENABLED => "Enabled".into(),
        REQUIRES_APPROVAL => "Requires approval (turned off under Allow in the Background)".into(),
        NOT_FOUND => "Not found".into(),
        other => format!("unknown ({other})"),
    }
}

/// The program a LaunchAgent plist starts: the first string of its `ProgramArguments`. The
/// auto-launch crate writes `<key>ProgramArguments</key>` then `<array><string>path</string>…`
/// with the path unescaped; a plist saved by Apple's tools escapes it, so entities are decoded.
/// `None` when there is no such string.
pub fn plist_program(plist: &str) -> Option<String> {
    const KEY: &str = "<key>ProgramArguments</key>";
    let after = &plist[plist.find(KEY)? + KEY.len()..];
    let array = after.trim_start().strip_prefix("<array>")?;
    let string = array.trim_start().strip_prefix("<string>")?;
    let path = &string[..string.find("</string>")?];
    let path = path
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&");
    Some(path).filter(|path| !path.is_empty())
}

/// The program the plist at `path` starts; `Ok(None)` when there is no plist, an error when it
/// can't be read or names no program (a binary plist, say).
pub fn read_plist_program(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read(path) {
        Ok(bytes) => plist_program(&String::from_utf8_lossy(&bytes))
            .map(Some)
            .ok_or_else(|| format!("{} names no program", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

/// The program a Run value starts. auto-launch writes the path as is, unquoted even with spaces,
/// then a space and its arguments (none for Undertone): `C:\Program Files\Undertone\undertone.exe `.
/// Another writer may quote it. Unquoted, the path ends after its last `.exe` that a space or the
/// end follows (a folder may be named `My.exe Tools`), so arguments after it don't count. `None`
/// when there's no path.
pub fn run_program(command: &str) -> Option<String> {
    let command = command.trim();
    let path = match command.strip_prefix('"') {
        Some(quoted) => &quoted[..quoted.find('"')?],
        None => {
            // ASCII lowercasing keeps every byte where it was, so its indices fit `command`.
            let lower = command.to_ascii_lowercase();
            let end = lower
                .rmatch_indices(".exe")
                .map(|(start, _)| start + 4)
                .find(|&end| {
                    command[end..]
                        .chars()
                        .next()
                        .is_none_or(char::is_whitespace)
                });
            &command[..end.unwrap_or(command.len())]
        }
    };
    Some(path.trim().to_owned()).filter(|path| !path.is_empty())
}

/// Task Manager's on/off for a Run value (`StartupApproved\Run`), over HKCU and HKLM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupApproved {
    /// No entry in either: Windows starts it.
    NoEntry,
    Enabled,
    /// Turned off in Task Manager or Settings › Apps › Startup.
    Disabled,
}

/// The entries found, read as auto-launch reads them: off when any entry's last eight bytes (when
/// it was turned off) aren't all zero. An entry too short to tell counts as on.
pub fn startup_approved(entries: &[&[u8]]) -> StartupApproved {
    let off = |entry: &&[u8]| entry.len() >= 8 && entry[entry.len() - 8..].iter().any(|&b| b != 0);
    if entries.iter().any(off) {
        StartupApproved::Disabled
    } else if entries.is_empty() {
        StartupApproved::NoEntry
    } else {
        StartupApproved::Enabled
    }
}

/// Why this copy runs from a place it won't be at the next login, if it does. macOS runs an app
/// opened from where it was downloaded from a random read-only App Translocation path until it's
/// moved; a disk image is mounted under /Volumes. On Windows, an exe opened straight from a zip
/// runs from the temp folder. `exe` and `temp_dir` with links resolved.
pub fn temporary_place(os: &str, exe: &str, temp_dir: Option<&str>) -> Option<&'static str> {
    match os {
        "macos" if exe.contains("/AppTranslocation/") => Some("an App Translocation path"),
        "macos" if exe.starts_with("/Volumes/") => Some("a mounted disk image"),
        "windows" if temp_dir.is_some_and(|temp| windows_inside(exe, temp)) => {
            Some("the temp folder")
        }
        _ => None,
    }
}

/// Whether Windows path `path` is inside `dir`, ignoring case and a `\\?\` prefix (what
/// `canonicalize` adds).
fn windows_inside(path: &str, dir: &str) -> bool {
    let plain = |p: &str| {
        p.strip_prefix(r"\\?\")
            .unwrap_or(p)
            .replace('/', "\\")
            .to_lowercase()
    };
    let (path, dir) = (plain(path), plain(dir));
    let dir = dir.trim_end_matches('\\');
    !dir.is_empty()
        && path
            .strip_prefix(dir)
            .is_some_and(|rest| rest.starts_with('\\'))
}

/// Whether two program paths are the same as the OS compares them: Windows ignores case.
pub fn same_program(os: &str, a: &str, b: &str) -> bool {
    if os == "windows" {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

/// This copy of Undertone, as `refresh` compares it with the login item.
#[derive(Debug, Clone, PartialEq)]
pub struct Here {
    /// The path the autostart plugin writes for it: on macOS the executable with links resolved,
    /// on Windows the executable as it was started.
    pub program: String,
    /// `temporary_place`.
    pub temporary: Option<&'static str>,
}
impl Here {
    /// The running copy.
    pub fn current() -> Result<Here, String> {
        let exe = std::env::current_exe().map_err(|e| format!("this program: {e}"))?;
        let resolved = exe.canonicalize().unwrap_or_else(|_| exe.clone());
        let temp_dir = std::env::temp_dir();
        let temp_dir = temp_dir.canonicalize().unwrap_or(temp_dir);
        let program = if cfg!(target_os = "macos") {
            &resolved
        } else {
            &exe
        };
        Ok(Here {
            program: program.display().to_string(),
            temporary: temporary_place(
                std::env::consts::OS,
                &resolved.display().to_string(),
                Some(&temp_dir.display().to_string()),
            ),
        })
    }
}

impl Here {
    /// This copy as a build of `kind`. A development build (`pnpm tauri dev`) shares the app's
    /// name, so its login item too: it never points that at `target/debug`, which would start
    /// with no dev server at the next login and announce a background item at every switch.
    pub fn for_build(mut self, debug: bool) -> Here {
        if debug && self.temporary.is_none() {
            self.temporary = Some("a development build");
        }
        self
    }
}

/// The program the login item starts, from what each place auto-launch may have written holds
/// (Windows: HKCU's Run value, then HKLM's). One that starts this copy wins, so an item that
/// does isn't rewritten because a stale one sits in the other hive.
pub fn stored_program<'a>(os: &str, programs: &'a [String], here: &Here) -> Option<&'a str> {
    programs
        .iter()
        .find(|program| same_program(os, program, &here.program))
        .or_else(|| programs.first())
        .map(String::as_str)
}

/// What startup does about a login item that may start another copy of Undertone.
#[derive(Debug, Clone, PartialEq)]
pub enum Refresh {
    /// Nothing: launch at login is off, there's no item (or its program can't be read), or it
    /// starts this copy.
    Keep,
    /// It starts another copy (Undertone was moved): turn it on again, which writes this copy.
    Rewrite,
    /// It starts another copy, but this one runs from a temporary place (why): leave it alone.
    Temporary(&'static str),
}

/// Whether the login item must be pointed at this copy. `stored` is the program it starts. Only
/// a real difference rewrites it: macOS announces every rewritten LaunchAgent as a new background
/// item.
pub fn refresh(os: &str, launch_at_login: bool, stored: Option<&str>, here: &Here) -> Refresh {
    match stored {
        Some(stored) if launch_at_login && !same_program(os, stored, &here.program) => {
            match here.temporary {
                Some(place) => Refresh::Temporary(place),
                None => Refresh::Rewrite,
            }
        }
        _ => Refresh::Keep,
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

#[cfg(all(feature = "desktop", target_os = "windows"))]
pub mod native {
    use windows_registry::{Key, CURRENT_USER, LOCAL_MACHINE};

    /// `ERROR_FILE_NOT_FOUND` as an HRESULT: the key or the value isn't there.
    const FILE_NOT_FOUND: i32 = 0x8007_0002_u32 as i32;
    /// Where auto-launch writes: the current user's unless Undertone ran as an administrator.
    const HIVES: [(&str, &Key); 2] = [("HKCU", CURRENT_USER), ("HKLM", LOCAL_MACHINE)];

    /// The Run values auto-launch wrote for `app_name`, with their hives: HKCU's, then HKLM's.
    /// Empty when neither has one. Both can: an item turned on as a user, then again as an
    /// administrator.
    pub fn run_values(app_name: &str) -> Result<Vec<(&'static str, String)>, String> {
        let mut values = Vec::new();
        for (hive, root) in HIVES {
            match root
                .open(super::RUN_KEY)
                .and_then(|key| key.get_string(app_name))
            {
                Ok(command) => values.push((hive, command)),
                Err(error) if error.code().0 == FILE_NOT_FOUND => {}
                Err(error) => return Err(format!(r"{hive}\{}: {error}", super::RUN_KEY)),
            }
        }
        Ok(values)
    }

    /// Task Manager's entries for `app_name` in both hives, as auto-launch reads them.
    pub fn startup_approved(app_name: &str) -> Result<super::StartupApproved, String> {
        let mut entries = Vec::new();
        for (hive, root) in HIVES {
            match root
                .open(super::STARTUP_APPROVED_KEY)
                .and_then(|key| key.get_value(app_name))
            {
                Ok(entry) => entries.push(entry.to_vec()),
                Err(error) if error.code().0 == FILE_NOT_FOUND => {}
                Err(error) => {
                    return Err(format!(r"{hive}\{}: {error}", super::STARTUP_APPROVED_KEY))
                }
            }
        }
        let entries: Vec<&[u8]> = entries.iter().map(Vec::as_slice).collect();
        Ok(super::startup_approved(&entries))
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

    #[test]
    fn statuses_are_named_as_service_management_names_them() {
        assert_eq!(status_name(ENABLED), "Enabled");
        assert!(status_name(REQUIRES_APPROVAL).starts_with("Requires approval"));
        assert_eq!(status_name(NOT_REGISTERED), "Not registered");
        assert_eq!(status_name(NOT_FOUND), "Not found");
        assert_eq!(status_name(7), "unknown (7)");
    }

    /// What auto-launch 0.6's `build_launch_agent_plist` writes for Undertone (no arguments, no
    /// bundle identifiers, no extra config), byte for byte.
    fn auto_launch_plist(path: &str) -> String {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD \
             PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist \
             version=\"1.0\">\n  <dict>\n  <key>Label</key>\n  <string>Undertone</string>\n  \
             <key>AssociatedBundleIdentifiers</key>\n  <array></array>\n  \
             <key>ProgramArguments</key>\n  <array><string>{path}</string></array>\n  \
             <key>RunAtLoad</key>\n  <true/>\n  </dict>\n</plist>"
        )
    }

    #[test]
    fn the_plist_program_is_the_first_program_argument() {
        let app = "/Applications/Undertone.app/Contents/MacOS/undertone";
        assert_eq!(plist_program(&auto_launch_plist(app)).as_deref(), Some(app));
        // Unescaped as auto-launch writes it, or escaped as Apple's tools save it.
        let odd = "/Users/demo/Rock & Roll/Undertone.app/Contents/MacOS/undertone";
        assert_eq!(plist_program(&auto_launch_plist(odd)).as_deref(), Some(odd));
        let escaped = auto_launch_plist("/Users/demo/Rock &amp; Roll/&lt;1&gt;/undertone");
        assert_eq!(
            plist_program(&escaped).as_deref(),
            Some("/Users/demo/Rock & Roll/<1>/undertone")
        );
        // Reformatted, with arguments after the program.
        let spaced = "<dict><key>ProgramArguments</key>\n\t<array>\n\t\t<string>/a/b</string>\n\
                      \t\t<string>--flag</string>\n\t</array></dict>";
        assert_eq!(plist_program(spaced).as_deref(), Some("/a/b"));
        // The Label's string is not a program; nothing after the key is none.
        for none in [
            "<dict><key>Label</key><string>Undertone</string></dict>",
            "<key>ProgramArguments</key><array/>",
            "<key>ProgramArguments</key><array></array><string>/a</string>",
            "<key>ProgramArguments</key><array><string></string></array>",
            "<key>ProgramArguments</key><array><string>/a",
            "bplist00",
            "",
        ] {
            assert_eq!(plist_program(none), None, "{none}");
        }
    }

    #[test]
    fn a_missing_plist_is_no_item_and_an_unusable_one_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let plist = legacy_plist(dir.path(), "Undertone");
        assert_eq!(read_plist_program(&plist), Ok(None));
        std::fs::create_dir_all(plist.parent().unwrap()).unwrap();
        std::fs::write(&plist, auto_launch_plist("/Applications/Undertone.app/x")).unwrap();
        assert_eq!(
            read_plist_program(&plist),
            Ok(Some("/Applications/Undertone.app/x".into()))
        );
        std::fs::write(&plist, b"bplist00\x00\x01").unwrap();
        assert!(read_plist_program(&plist)
            .unwrap_err()
            .ends_with("Undertone.plist names no program"));
    }

    #[test]
    fn the_run_program_is_the_path_auto_launch_wrote_without_its_arguments() {
        let exe = r"C:\Program Files\Undertone\undertone.exe";
        for (command, expected) in [
            // auto-launch: the path, a space and the (empty) arguments.
            (format!("{exe} "), Some(exe)),
            (format!("{exe} --minimized --x"), Some(exe)),
            (exe.to_owned(), Some(exe)),
            (format!("\"{exe}\" --minimized"), Some(exe)),
            (
                r"C:\Apps\My.exe Tools\Undertone.EXE ".into(),
                Some(r"C:\Apps\My.exe Tools\Undertone.EXE"),
            ),
            (r"C:\Apps\undertone".into(), Some(r"C:\Apps\undertone")),
            ("\"\" --x".into(), None),
            ("\"C:\\unterminated".into(), None),
            ("   ".into(), None),
        ] {
            assert_eq!(run_program(&command).as_deref(), expected, "{command}");
        }
    }

    #[test]
    fn task_manager_entries_are_read_as_auto_launch_reads_them() {
        let enabled = [2u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let disabled = [3u8, 0, 0, 0, 0x10, 0x2f, 0x6a, 0x1c, 0x3e, 0x01, 0xdb, 0x01];
        assert_eq!(startup_approved(&[]), StartupApproved::NoEntry);
        assert_eq!(startup_approved(&[&enabled]), StartupApproved::Enabled);
        assert_eq!(startup_approved(&[&disabled]), StartupApproved::Disabled);
        // Off in either hive is off.
        assert_eq!(
            startup_approved(&[&enabled, &disabled]),
            StartupApproved::Disabled
        );
        assert_eq!(startup_approved(&[&[3, 1]]), StartupApproved::Enabled);
    }

    #[test]
    fn only_translocated_disk_image_and_temp_copies_are_temporary() {
        let temp = Some(r"\\?\C:\Users\Demo\AppData\Local\Temp");
        for (os, exe, expected) in [
            (
                "macos",
                "/private/var/folders/x/T/AppTranslocation/5A1F/d/Undertone.app/Contents/MacOS/undertone",
                Some("an App Translocation path"),
            ),
            (
                "macos",
                "/Volumes/Undertone/Undertone.app/Contents/MacOS/undertone",
                Some("a mounted disk image"),
            ),
            (
                "macos",
                "/Applications/Undertone.app/Contents/MacOS/undertone",
                None,
            ),
            (
                "windows",
                r"\\?\C:\Users\demo\appdata\local\TEMP\Temp1_undertone.zip\undertone.exe",
                Some("the temp folder"),
            ),
            ("windows", r"C:\Users\Demo\AppData\Local\Temp\u.exe", Some("the temp folder")),
            ("windows", r"C:\Users\Demo\AppData\Local\Temporary\u.exe", None),
            ("windows", r"C:\Users\Demo\AppData\Local\Undertone\undertone.exe", None),
            ("windows", "/Volumes/AppTranslocation/undertone.exe", None),
        ] {
            assert_eq!(temporary_place(os, exe, temp), expected, "{os} {exe}");
        }
        assert_eq!(temporary_place("windows", r"C:\Temp\u.exe", None), None);
        assert_eq!(temporary_place("windows", r"C:\Temp\u.exe", Some("")), None);
    }

    #[test]
    fn the_login_item_is_pointed_here_only_when_it_starts_another_copy() {
        let mac = "/Applications/Undertone.app/Contents/MacOS/undertone";
        let moved = "/Users/demo/Apps/Undertone.app/Contents/MacOS/undertone";
        let win = r"C:\Users\Demo\AppData\Local\Undertone\undertone.exe";
        let here = |program: &str, temporary| Here {
            program: program.into(),
            temporary,
        };
        let translocated = Some("an App Translocation path");
        let dmg = Some("a mounted disk image");
        let temp = Some("the temp folder");
        let (mac_upper, win_upper) = (mac.to_uppercase(), win.to_uppercase());
        for (name, os, on, stored, here, expected) in [
            (
                "same path",
                "macos",
                true,
                Some(mac),
                here(mac, None),
                Refresh::Keep,
            ),
            (
                "moved",
                "macos",
                true,
                Some(mac),
                here(moved, None),
                Refresh::Rewrite,
            ),
            (
                "translocated",
                "macos",
                true,
                Some(mac),
                here(moved, translocated),
                Refresh::Temporary("an App Translocation path"),
            ),
            (
                "disk image",
                "macos",
                true,
                Some(mac),
                here(moved, dmg),
                Refresh::Temporary("a mounted disk image"),
            ),
            // Opened from the disk image again: the item already starts it, so nothing is logged.
            (
                "same, temporary",
                "macos",
                true,
                Some(mac),
                here(mac, dmg),
                Refresh::Keep,
            ),
            (
                "missing item",
                "macos",
                true,
                None,
                here(moved, None),
                Refresh::Keep,
            ),
            (
                "off",
                "macos",
                false,
                Some(mac),
                here(moved, None),
                Refresh::Keep,
            ),
            (
                "same path",
                "windows",
                true,
                Some(win),
                here(win, None),
                Refresh::Keep,
            ),
            (
                "other case",
                "windows",
                true,
                Some(win_upper.as_str()),
                here(win, None),
                Refresh::Keep,
            ),
            // macOS volumes may be case-sensitive: another case is another path.
            (
                "other case",
                "macos",
                true,
                Some(mac_upper.as_str()),
                here(mac, None),
                Refresh::Rewrite,
            ),
            (
                "moved",
                "windows",
                true,
                Some(r"D:\Old\undertone.exe"),
                here(win, None),
                Refresh::Rewrite,
            ),
            (
                "temp",
                "windows",
                true,
                Some(win),
                here(r"C:\Users\Demo\AppData\Local\Temp\u.exe", temp),
                Refresh::Temporary("the temp folder"),
            ),
            (
                "missing item",
                "windows",
                true,
                None,
                here(win, None),
                Refresh::Keep,
            ),
            (
                "off",
                "windows",
                false,
                Some(r"D:\Old\undertone.exe"),
                here(win, None),
                Refresh::Keep,
            ),
        ] {
            assert_eq!(refresh(os, on, stored, &here), expected, "{os}: {name}");
        }
    }

    #[test]
    fn a_development_build_never_points_the_login_item_at_itself() {
        let here = |temporary| Here {
            program: r"C:\Dev\undertone\src-tauri\target\debug\undertone.exe".into(),
            temporary,
        };
        let stored = Some(r"C:\Users\demo\AppData\Local\Undertone\undertone.exe");
        let debug = here(None).for_build(true);
        assert_eq!(debug.temporary, Some("a development build"));
        assert_eq!(
            refresh("windows", true, stored, &debug),
            Refresh::Temporary("a development build")
        );
        // a release build of the same copy would be pointed at
        let release = here(None).for_build(false);
        assert_eq!(refresh("windows", true, stored, &release), Refresh::Rewrite);
        // a temporary place keeps its own reason
        let zipped = here(Some("the temp folder")).for_build(true);
        assert_eq!(zipped.temporary, Some("the temp folder"));
    }

    #[test]
    fn a_stale_value_in_the_other_hive_doesnt_rewrite_an_item_that_starts_this_copy() {
        let here = Here {
            program: r"C:\Apps\Undertone\undertone.exe".into(),
            temporary: None,
        };
        let stale = r"C:\Old\Undertone\undertone.exe".to_owned();
        let current = r"c:\apps\undertone\UNDERTONE.EXE".to_owned();
        // HKCU stale, HKLM current (turned on again as an administrator): keep
        let both = [stale.clone(), current.clone()];
        let picked = stored_program("windows", &both, &here);
        assert_eq!(picked, Some(current.as_str()));
        assert_eq!(refresh("windows", true, picked, &here), Refresh::Keep);
        // only stale ones: the first, and it is pointed at this copy
        let only_stale = [stale.clone()];
        let picked = stored_program("windows", &only_stale, &here);
        assert_eq!(picked, Some(stale.as_str()));
        assert_eq!(refresh("windows", true, picked, &here), Refresh::Rewrite);
        // none
        assert_eq!(stored_program("windows", &[], &here), None);
    }

    #[test]
    fn this_copy_is_the_running_program() {
        let here = Here::current().unwrap();
        let exe = std::env::current_exe().unwrap();
        assert!(here
            .program
            .ends_with(&*exe.file_name().unwrap().to_string_lossy()));
        assert_eq!(here.temporary, None, "{}", here.program);
    }
}
