//! X5 global shortcuts. The bindings are a portable table; `runtime` registers each one with
//! tauri-plugin-global-shortcut and runs the same actions as the tray.

/// Shortcut sync step. Positive offsets show lyrics earlier.
pub const SHORTCUT_NUDGE_MS: f64 = 50.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ShortcutAction {
    ToggleLyrics,
    /// Adds this many ms to the current song's offset.
    Nudge(f64),
}

/// Accelerator, action. `]` sits right of `[`, so it moves the lyrics forward (earlier).
///
/// Shift is part of every binding, a deliberate change from AGENTS.md's Cmd/Ctrl+Alt. Windows
/// reports AltGr as Ctrl+Alt, so a Ctrl+Alt hotkey swallows AltGr characters on many layouts
/// (German `\`, Polish `ł`, French `]`); Microsoft's guidance is to avoid Ctrl+Alt for that
/// reason. On macOS, ⌘⌥L is Downloads in Finder and Safari and Reformat Code in JetBrains IDEs, and
/// ⌘⌥[ / ] move or fold lines in Xcode and VS Code. A global shortcut takes the keys from every app,
/// so it has to stay clear of those.
pub const BINDINGS: [(&str, ShortcutAction); 3] = [
    ("CmdOrCtrl+Alt+Shift+L", ShortcutAction::ToggleLyrics),
    (
        "CmdOrCtrl+Alt+Shift+]",
        ShortcutAction::Nudge(SHORTCUT_NUDGE_MS),
    ),
    (
        "CmdOrCtrl+Alt+Shift+[",
        ShortcutAction::Nudge(-SHORTCUT_NUDGE_MS),
    ),
];

#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
mod runtime {
    use super::ShortcutAction;
    use tauri::{AppHandle, Manager, Wry};
    use tauri_plugin_global_shortcut::{GlobalShortcut, ShortcutState};

    /// Registers each binding on its own, so one that another app already owns is logged and
    /// skipped instead of failing startup or taking the others down with it.
    pub fn install(app: &AppHandle) -> Result<(), String> {
        let Some(shortcuts) = app.try_state::<GlobalShortcut<Wry>>() else {
            eprintln!("global shortcuts unavailable");
            return Ok(());
        };
        for (accelerator, action) in super::BINDINGS {
            let registered = shortcuts.on_shortcut(accelerator, move |app, _shortcut, event| {
                // Press only: a release would undo a toggle and double a nudge.
                if event.state == ShortcutState::Pressed {
                    run(app, action);
                }
            });
            if let Err(error) = registered {
                eprintln!(
                    "shortcut {accelerator} not registered (another app may own it): {error}"
                );
            }
        }
        Ok(())
    }

    /// Runs on the main thread while the plugin holds its shortcut table: never (un)register here.
    fn run(app: &AppHandle, action: ShortcutAction) {
        let result = match action {
            ShortcutAction::ToggleLyrics => {
                crate::tray::toggle_lyrics(app);
                Ok(())
            }
            ShortcutAction::Nudge(delta_ms) => crate::tray::nudge(app, delta_ms),
        };
        if let Err(error) = result {
            eprintln!("shortcut: {error}");
        }
    }
}
#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
pub use runtime::install;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bindings_match_the_spec() {
        assert_eq!(
            BINDINGS[0],
            ("CmdOrCtrl+Alt+Shift+L", ShortcutAction::ToggleLyrics)
        );
        // Positive is earlier.
        assert_eq!(
            BINDINGS[1],
            ("CmdOrCtrl+Alt+Shift+]", ShortcutAction::Nudge(50.0))
        );
        assert_eq!(
            BINDINGS[2],
            ("CmdOrCtrl+Alt+Shift+[", ShortcutAction::Nudge(-50.0))
        );
    }
    #[test]
    fn accelerators_are_distinct() {
        let mut accelerators: Vec<_> = BINDINGS.iter().map(|(a, _)| a.to_lowercase()).collect();
        accelerators.sort();
        accelerators.dedup();
        assert_eq!(accelerators.len(), BINDINGS.len());
    }
    /// A string the plugin can't parse is only logged at startup, so check the keys here (CI runs
    /// this on macOS and Windows).
    #[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
    #[test]
    fn accelerators_parse_to_the_intended_keys() {
        use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
        let cmd_or_ctrl = if cfg!(target_os = "macos") {
            Modifiers::SUPER
        } else {
            Modifiers::CONTROL
        };
        let keys = [Code::KeyL, Code::BracketRight, Code::BracketLeft];
        for ((accelerator, _), key) in BINDINGS.iter().zip(keys) {
            let parsed: Shortcut = accelerator.parse().expect(accelerator);
            assert_eq!(
                parsed,
                Shortcut::new(Some(cmd_or_ctrl | Modifiers::ALT | Modifiers::SHIFT), key)
            );
        }
    }
}
