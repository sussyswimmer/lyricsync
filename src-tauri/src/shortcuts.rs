//! X5 global shortcuts, configured in `Settings.shortcuts` (contract v3). The accelerator rules,
//! the registration plan and the suspension are portable and tested on every OS; `runtime`
//! registers the bindings with tauri-plugin-global-shortcut, runs the same actions as the tray, and
//! reports `shortcuts-status`.
//!
//! An accelerator is case-insensitive tokens joined by "+": modifiers, each at most once (CmdOrCtrl
//! or CommandOrControl; Ctrl or Control; Cmd, Command or Super; Alt or Option; Shift), then one key:
//! A–Z, 0–9, F1–F24, Space, Up, Down, Left, Right, Home, End, PageUp, PageDown, Insert, Delete,
//! Backspace, Tab, Enter, or one of `[ ] ; ' , . / \ ` - =`. It needs CmdOrCtrl, Control, Super or
//! Alt, so a shortcut never takes plain or shifted typing. Case folding is ASCII only. Accepted
//! accelerators are stored in one spelling: modifiers in the order CmdOrCtrl, Control, Super, Alt,
//! Shift, then the key as listed above, uppercase for letters ("CmdOrCtrl+Alt+Shift+L"). The global
//! shortcut plugin's parser reads every one of them (a desktop test checks each key). The mock
//! bridge and the Settings recorder apply the same rules (`src/core/accelerator.ts`), and both
//! halves test against one table, `tests/fixtures/accelerators.json`.
//!
//! The default bindings (contract `DEFAULT_SETTINGS.shortcuts`) all include Shift, a deliberate
//! change from AGENTS.md's Cmd/Ctrl+Alt. Windows reports AltGr as Ctrl+Alt, so a Ctrl+Alt hotkey
//! swallows AltGr characters on many layouts (German `\`, Polish `ł`, French `]`); Microsoft's
//! guidance is to avoid Ctrl+Alt for that reason. On macOS, ⌘⌥L is Downloads in Finder and Safari
//! and Reformat Code in JetBrains IDEs, and ⌘⌥[ / ] move or fold lines in Xcode and VS Code. A
//! global shortcut takes the keys from every app. Shift narrows the clash, it can't remove it:
//! AltGr+Shift still types on some layouts (Polish `Ł`), and JetBrains IDEs use Ctrl/⌘+Alt+Shift+L
//! for their Reformat File dialog. That is why the bindings can be changed or turned off.
use crate::contract::{ShortcutAction, ShortcutState, Shortcuts, ShortcutsStatus};
use std::time::Duration;

/// Shortcut sync step. Positive offsets show lyrics earlier.
pub const SHORTCUT_NUDGE_MS: f64 = 50.0;
/// How long Settings may keep the shortcuts suspended before they come back on their own.
pub const SUSPEND_LIMIT: Duration = Duration::from_secs(30);
/// Every action, in the order bindings are registered and reported.
pub const ACTIONS: [ShortcutAction; 3] = [
    ShortcutAction::ToggleLyrics,
    ShortcutAction::NudgeEarlier,
    ShortcutAction::NudgeLater,
];

/// Each modifier's stored spelling, then every name it may be written with (lowercase), in the
/// stored order. The first four are the ones a shortcut needs at least one of.
const MODIFIERS: [(&str, &[&str]); 5] = [
    ("CmdOrCtrl", &["cmdorctrl", "commandorcontrol"]),
    ("Control", &["control", "ctrl"]),
    ("Super", &["super", "cmd", "command"]),
    ("Alt", &["alt", "option"]),
    ("Shift", &["shift"]),
];
const REQUIRED_MODIFIERS: usize = 4;
const NAMED_KEYS: [&str; 14] = [
    "Space",
    "Up",
    "Down",
    "Left",
    "Right",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Insert",
    "Delete",
    "Backspace",
    "Tab",
    "Enter",
];
/// The plugin's parser reads these characters as the keys that type them on a US layout.
const PUNCTUATION: [&str; 11] = ["[", "]", ";", "'", ",", ".", "/", "\\", "`", "-", "="];

/// An accelerator in its stored spelling, `Some("")` for "" (no shortcut), `None` when it isn't one
/// Undertone accepts.
pub fn normalize(accelerator: &str) -> Option<String> {
    if accelerator.is_empty() {
        return Some(String::new());
    }
    let tokens: Vec<&str> = accelerator.split('+').collect();
    let (key, modifiers) = tokens.split_last()?;
    let mut used = [false; MODIFIERS.len()];
    for token in modifiers {
        let token = token.to_ascii_lowercase();
        let index = MODIFIERS
            .iter()
            .position(|(_, names)| names.contains(&token.as_str()))?;
        if std::mem::replace(&mut used[index], true) {
            return None;
        }
    }
    if !used[..REQUIRED_MODIFIERS].contains(&true) {
        return None;
    }
    let mut parts: Vec<String> = MODIFIERS
        .iter()
        .zip(used)
        .filter(|(_, used)| *used)
        .map(|((name, _), _)| (*name).to_owned())
        .collect();
    parts.push(key_name(key)?);
    Some(parts.join("+"))
}

/// A key token in its stored spelling.
fn key_name(token: &str) -> Option<String> {
    let bytes = token.as_bytes();
    if bytes.len() == 1 && bytes[0].is_ascii_alphanumeric() {
        return Some(token.to_ascii_uppercase());
    }
    if PUNCTUATION.contains(&token) {
        return Some(token.to_owned());
    }
    if let Some(name) = NAMED_KEYS.iter().find(|n| n.eq_ignore_ascii_case(token)) {
        return Some((*name).to_owned());
    }
    // F1–F24, without leading zeros.
    let number = token.strip_prefix(['F', 'f'])?;
    let n: u8 = number.parse().ok()?;
    ((1..=24).contains(&n) && n.to_string() == number).then(|| format!("F{n}"))
}

impl Shortcuts {
    pub fn binding(&self, action: ShortcutAction) -> &str {
        match action {
            ShortcutAction::ToggleLyrics => &self.toggle_lyrics,
            ShortcutAction::NudgeEarlier => &self.nudge_earlier,
            ShortcutAction::NudgeLater => &self.nudge_later,
        }
    }
    pub fn binding_mut(&mut self, action: ShortcutAction) -> &mut String {
        match action {
            ShortcutAction::ToggleLyrics => &mut self.toggle_lyrics,
            ShortcutAction::NudgeEarlier => &mut self.nudge_earlier,
            ShortcutAction::NudgeLater => &mut self.nudge_later,
        }
    }
}
impl ShortcutsStatus {
    pub fn get(&self, action: ShortcutAction) -> ShortcutState {
        match action {
            ShortcutAction::ToggleLyrics => self.toggle_lyrics,
            ShortcutAction::NudgeEarlier => self.nudge_earlier,
            ShortcutAction::NudgeLater => self.nudge_later,
        }
    }
    pub fn set(&mut self, action: ShortcutAction, state: ShortcutState) {
        match action {
            ShortcutAction::ToggleLyrics => self.toggle_lyrics = state,
            ShortcutAction::NudgeEarlier => self.nudge_earlier = state,
            ShortcutAction::NudgeLater => self.nudge_later = state,
        }
    }
    /// Takes a pass's status as the last one reported. True when it changed, so `shortcuts-status`
    /// goes out; a pass that changes nothing sends no event.
    pub fn record(&mut self, next: &ShortcutsStatus) -> bool {
        if self == next {
            return false;
        }
        self.clone_from(next);
        true
    }
}

/// The key of an action's binding in `Settings.shortcuts` (its wire name).
pub fn field(action: ShortcutAction) -> &'static str {
    match action {
        ShortcutAction::ToggleLyrics => "toggleLyrics",
        ShortcutAction::NudgeEarlier => "nudgeEarlier",
        ShortcutAction::NudgeLater => "nudgeLater",
    }
}
/// What a nudge adds to the current song's offset; `None` for the toggle, which flips
/// `Settings.enabled`. `]` sits right of `[`, so the default earlier nudge is the right bracket.
pub fn nudge_ms(action: ShortcutAction) -> Option<f64> {
    match action {
        ShortcutAction::ToggleLyrics => None,
        ShortcutAction::NudgeEarlier => Some(SHORTCUT_NUDGE_MS),
        ShortcutAction::NudgeLater => Some(-SHORTCUT_NUDGE_MS),
    }
}

/// What a registration pass does with one binding.
#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    /// Shortcuts are off, or the action has none.
    Off,
    /// Not usable here: not an accelerator Undertone accepts, a key this OS's keyboards lack, or
    /// the keys of an earlier action on this OS.
    Invalid,
    /// Register this accelerator.
    Register(String),
}

/// The modifiers and key an accelerator presses on one OS: CmdOrCtrl is ⌘ (Super) on macOS and
/// Ctrl elsewhere, so "CmdOrCtrl+L" and "Control+L" are distinct settings but the same keys on
/// Windows.
fn keys_on(accelerator: &str, macos: bool) -> (Vec<&str>, &str) {
    let mut tokens: Vec<&str> = accelerator.split('+').collect();
    let key = tokens.pop().unwrap_or_default();
    let cmd_or_ctrl = if macos { "Super" } else { "Control" };
    let mut modifiers: Vec<&str> = tokens
        .into_iter()
        .map(|m| if m == "CmdOrCtrl" { cmd_or_ctrl } else { m })
        .collect();
    modifiers.sort_unstable();
    modifiers.dedup();
    (modifiers, key)
}

/// Keys global-hotkey has no macOS key code for.
const MISSING_ON_MACOS: [&str; 4] = ["F21", "F22", "F23", "F24"];

/// What a registration pass does with each binding, in `ACTIONS` order. Settings only ever hold
/// accepted bindings, but one may still be unusable here: a key Mac keyboards lack is invalid
/// rather than taken by another app, and so is a binding that presses the same keys as an earlier
/// action on this OS.
pub fn plan(shortcuts: &Shortcuts, macos: bool) -> [(ShortcutAction, Plan); 3] {
    let mut planned: Vec<String> = Vec::new();
    ACTIONS.map(|action| {
        let binding = shortcuts.binding(action);
        if !shortcuts.enabled || binding.is_empty() {
            return (action, Plan::Off);
        }
        let Some(accelerator) = normalize(binding) else {
            return (action, Plan::Invalid);
        };
        let keys = keys_on(&accelerator, macos);
        let missing = macos && MISSING_ON_MACOS.contains(&keys.1);
        let taken = planned
            .iter()
            .any(|earlier| keys_on(earlier, macos) == keys);
        if missing || taken {
            return (action, Plan::Invalid);
        }
        planned.push(accelerator.clone());
        (action, Plan::Register(accelerator))
    })
}

/// Settings suspends the shortcuts while it records a new one, so the current bindings don't
/// swallow the keys. Each suspend gets a new ticket: the time limit of an earlier suspend can't end
/// a later one.
#[derive(Debug, Default)]
pub struct Suspension {
    ticket: u64,
    active: bool,
}
impl Suspension {
    /// Starts (or restarts) a suspension; its ticket goes to the time limit.
    pub fn suspend(&mut self) -> u64 {
        self.ticket += 1;
        self.active = true;
        self.ticket
    }
    /// Ends the suspension. True when there was one to end.
    pub fn resume(&mut self) -> bool {
        std::mem::take(&mut self.active)
    }
    /// The time limit of `ticket` ran out: ends the suspension unless a later one replaced it.
    pub fn expire(&mut self, ticket: u64) -> bool {
        self.ticket == ticket && self.resume()
    }
    pub fn is_active(&self) -> bool {
        self.active
    }
}

#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
mod runtime {
    use super::{Plan, Suspension, SUSPEND_LIMIT};
    use crate::{
        contract::{ShortcutAction, ShortcutState, ShortcutsStatus, SHORTCUTS_STATUS_EVENT},
        state::AppState,
    };
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter, Manager, Wry};
    use tauri_plugin_global_shortcut::{GlobalShortcut, Shortcut, ShortcutState as KeyState};

    /// The plugin registers and unregisters on the main thread and blocks until that is done, so
    /// a pass waits for the main thread. Passes therefore run only on the blocking pool, one at a
    /// time: `registered` is held for a whole pass and never locked on the main thread.
    ///
    /// Not inside a shortcut's handler either: the plugin runs handlers on the main thread with
    /// its shortcut table locked, and registering locks it again. `run_on_main_thread` is no way
    /// out there, because on the main thread it runs the task at once, still inside the handler.
    /// A pass on the blocking pool instead queues its work behind the handler.
    struct Registrar {
        /// What this app registered, to unregister on the next pass.
        registered: Mutex<Vec<Shortcut>>,
        suspension: Mutex<Suspension>,
    }

    pub fn install(app: &AppHandle) -> Result<(), String> {
        if app.try_state::<GlobalShortcut<Wry>>().is_none() {
            eprintln!("global shortcuts unavailable");
        }
        app.manage(Registrar {
            registered: Mutex::new(Vec::new()),
            suspension: Mutex::new(Suspension::default()),
        });
        refresh(app);
        Ok(())
    }

    /// Registers the bindings in the current settings, replacing Undertone's previous ones, on
    /// the blocking pool. Safe from any thread, a shortcut's handler included. The settings are
    /// read when the pass runs, so the last pass always applies the latest bindings.
    pub fn refresh(app: &AppHandle) {
        spawn_pass(app);
    }

    fn spawn_pass(app: &AppHandle) -> tauri::async_runtime::JoinHandle<()> {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || pass(&app))
    }

    /// `suspend_shortcuts`: true unregisters every Undertone shortcut until false, the time limit,
    /// or Settings hiding (`resume`). Returns once the shortcuts are off (or back).
    pub async fn suspend(app: &AppHandle, suspended: bool) -> Result<(), String> {
        let registrar = app
            .try_state::<Registrar>()
            .ok_or("global shortcuts unavailable")?;
        if suspended {
            let ticket = registrar
                .suspension
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .suspend();
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(SUSPEND_LIMIT).await;
                let expired = handle.try_state::<Registrar>().is_some_and(|registrar| {
                    registrar
                        .suspension
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .expire(ticket)
                });
                if expired {
                    eprintln!("shortcuts: suspended for too long; registering them again");
                    spawn_pass(&handle);
                }
            });
        } else if !registrar
            .suspension
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .resume()
        {
            return Ok(());
        }
        spawn_pass(app).await.map_err(|e| e.to_string())
    }

    /// Ends a suspension Settings left behind: it hid, was minimized or lost focus. Cheap when
    /// nothing is suspended.
    pub fn resume(app: &AppHandle) {
        let resumed = app.try_state::<Registrar>().is_some_and(|registrar| {
            registrar
                .suspension
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .resume()
        });
        if resumed {
            spawn_pass(app);
        }
    }

    /// One registration pass (blocking pool only, see `Registrar`). Unregisters what Undertone
    /// registered, then, unless suspended, registers each binding on its own, so one that
    /// another app owns doesn't take the others down, and publishes the status. While suspended
    /// the last status stands: the bindings come back as they were, and Settings shows no
    /// warning while it records.
    fn pass(app: &AppHandle) {
        let Some(registrar) = app.try_state::<Registrar>() else {
            return;
        };
        let mut registered = registrar
            .registered
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let plugin = app.try_state::<GlobalShortcut<Wry>>();
        if let Some(plugin) = &plugin {
            for shortcut in registered.drain(..) {
                if let Err(error) = plugin.unregister(shortcut) {
                    eprintln!("shortcut {shortcut} not unregistered: {error}");
                }
            }
        }
        if registrar
            .suspension
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_active()
        {
            return;
        }
        let shortcuts = app
            .state::<AppState>()
            .settings
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .shortcuts
            .clone();
        let mut status = ShortcutsStatus::default();
        for (action, plan) in super::plan(&shortcuts, cfg!(target_os = "macos")) {
            let state = match plan {
                Plan::Off => ShortcutState::Off,
                Plan::Invalid => ShortcutState::Invalid,
                Plan::Register(accelerator) => {
                    register(plugin.as_deref(), &accelerator, action, &mut registered)
                }
            };
            status.set(action, state);
        }
        publish(app, status);
    }

    fn register(
        plugin: Option<&GlobalShortcut<Wry>>,
        accelerator: &str,
        action: ShortcutAction,
        registered: &mut Vec<Shortcut>,
    ) -> ShortcutState {
        let Ok(shortcut) = accelerator.parse::<Shortcut>() else {
            return ShortcutState::Invalid;
        };
        let Some(plugin) = plugin else {
            return ShortcutState::Unavailable;
        };
        let result = plugin.on_shortcut(shortcut, move |app, _shortcut, event| {
            // Press only: a release would undo a toggle and double a nudge.
            if event.state == KeyState::Pressed {
                run(app, action);
            }
        });
        match result {
            Ok(()) => {
                registered.push(shortcut);
                ShortcutState::Ok
            }
            Err(error) => {
                eprintln!(
                    "shortcut {accelerator} not registered (another app may own it): {error}"
                );
                ShortcutState::Unavailable
            }
        }
    }

    /// Stores the status for `get_shortcuts_status` and sends `shortcuts-status` when it changed.
    /// Called with `registered` held, so the events go out in pass order.
    fn publish(app: &AppHandle, status: ShortcutsStatus) {
        {
            let state = app.state::<AppState>();
            let mut last = state
                .shortcuts_status
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if !last.record(&status) {
                return;
            }
        }
        if let Err(error) = app.emit(SHORTCUTS_STATUS_EVENT, &status) {
            eprintln!("shortcuts-status: {error}");
        }
    }

    /// Runs on the main thread while the plugin holds its shortcut table: never (un)register
    /// here. A settings change is fine: one that changes the bindings only queues a pass.
    fn run(app: &AppHandle, action: ShortcutAction) {
        let result = match super::nudge_ms(action) {
            None => crate::settings::runtime::toggle_enabled(app).map(drop),
            Some(delta_ms) => crate::tray::nudge(app, delta_ms),
        };
        if let Err(error) = result {
            eprintln!("shortcut: {error}");
        }
    }
}
#[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
pub use runtime::{install, refresh, resume, suspend};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::Settings;

    /// Accepted spellings and what they are stored as. The mock bridge's validator uses the same
    /// table.
    const ACCEPTED: &[(&str, &str)] = &[
        ("CmdOrCtrl+Alt+Shift+L", "CmdOrCtrl+Alt+Shift+L"),
        ("cmdorctrl+alt+shift+l", "CmdOrCtrl+Alt+Shift+L"),
        ("Shift+Alt+CommandOrControl+L", "CmdOrCtrl+Alt+Shift+L"),
        ("Ctrl+K", "Control+K"),
        ("CONTROL+k", "Control+K"),
        ("Cmd+Option+P", "Super+Alt+P"),
        ("Command+1", "Super+1"),
        ("Super+Shift+0", "Super+Shift+0"),
        ("Alt+F5", "Alt+F5"),
        ("Option+f24", "Alt+F24"),
        (
            "Shift+Control+CmdOrCtrl+Alt+Super+Z",
            "CmdOrCtrl+Control+Super+Alt+Shift+Z",
        ),
        ("Alt+space", "Alt+Space"),
        ("Ctrl+PAGEUP", "Control+PageUp"),
        ("Ctrl+pagedown", "Control+PageDown"),
        ("Alt+up", "Alt+Up"),
        ("Alt+BackSpace", "Alt+Backspace"),
        ("CmdOrCtrl+Shift+]", "CmdOrCtrl+Shift+]"),
        ("CmdOrCtrl+Alt+Shift+[", "CmdOrCtrl+Alt+Shift+["),
        ("Alt+\\", "Alt+\\"),
        ("Alt+`", "Alt+`"),
        ("Alt+-", "Alt+-"),
        ("Alt+=", "Alt+="),
    ];
    /// Not accepted, with why.
    const REJECTED: &[(&str, &str)] = &[
        ("L", "no modifier"),
        ("Shift+L", "Shift alone types"),
        ("Shift+F5", "Shift alone"),
        ("CmdOrCtrl+Alt", "no key"),
        ("Alt+Shift", "a modifier as the key"),
        ("Alt+L+Shift", "a modifier after the key"),
        ("Alt+L+K", "two keys"),
        ("Alt+Alt+L", "a modifier twice"),
        ("Cmd+Super+L", "the same modifier twice under two names"),
        ("Ctrl+Control+L", "the same modifier twice under two names"),
        ("Alt++", "an empty token: + can't be a key"),
        ("+Alt+L", "an empty token"),
        ("Alt+L+", "an empty token"),
        (" ", "blank"),
        ("Alt + L", "spaces around tokens"),
        ("Alt+KeyL", "a code name instead of the key"),
        ("Alt+ArrowUp", "a code name instead of the key"),
        ("Alt+F0", "no F0"),
        ("Alt+F25", "no F25"),
        ("Alt+F05", "a leading zero"),
        ("Alt+Escape", "Esc cancels recording"),
        ("Alt+Num0", "keypad keys are not offered"),
        ("Hyper+L", "an unknown modifier"),
        ("Alt+é", "not a listed key"),
        ("Alt+\u{212a}", "Kelvin sign: case folding is ASCII only"),
        ("Meta+L", "not a listed modifier name"),
    ];

    #[test]
    fn accelerators_normalize_to_one_spelling() {
        for &(input, stored) in ACCEPTED {
            assert_eq!(normalize(input).as_deref(), Some(stored), "{input}");
            // The stored spelling is stable.
            assert_eq!(normalize(stored).as_deref(), Some(stored), "{stored}");
        }
        assert_eq!(normalize("").as_deref(), Some(""));
    }
    #[test]
    fn unusable_accelerators_are_rejected() {
        for &(input, why) in REJECTED {
            assert_eq!(normalize(input), None, "{input:?}: {why}");
        }
    }
    /// The table the frontend's validator (`src/core/accelerator.ts`) is tested with too.
    const SHARED_FIXTURE: &str = include_str!("../../tests/fixtures/accelerators.json");
    fn shared_fixture() -> (Vec<(String, String)>, Vec<String>) {
        let fixture: serde_json::Value = serde_json::from_str(SHARED_FIXTURE).unwrap();
        let accept = serde_json::from_value(fixture["accept"].clone()).unwrap();
        let reject = serde_json::from_value(fixture["reject"].clone()).unwrap();
        (accept, reject)
    }
    #[test]
    fn both_halves_accept_and_reject_the_shared_cases_alike() {
        let (accept, reject) = shared_fixture();
        assert!(!accept.is_empty() && !reject.is_empty());
        for (input, stored) in accept {
            assert_eq!(normalize(&input), Some(stored), "{input:?}");
        }
        for input in reject {
            assert_eq!(normalize(&input), None, "{input:?}");
        }
    }

    #[test]
    fn every_listed_key_is_accepted_with_each_required_modifier() {
        for key in every_key() {
            for modifier in ["CmdOrCtrl", "Control", "Super", "Alt"] {
                let accelerator = format!("{modifier}+{key}");
                assert_eq!(normalize(&accelerator), Some(accelerator.clone()));
            }
        }
    }
    /// Every key Undertone accepts, in its stored spelling.
    fn every_key() -> Vec<String> {
        let mut keys: Vec<String> = ('A'..='Z').chain('0'..='9').map(String::from).collect();
        keys.extend((1..=24).map(|n| format!("F{n}")));
        keys.extend(NAMED_KEYS.iter().map(|k| (*k).to_owned()));
        keys.extend(PUNCTUATION.iter().map(|k| (*k).to_owned()));
        keys
    }

    #[test]
    fn the_default_bindings_are_stored_spellings_with_shift() {
        let defaults = Settings::default().shortcuts;
        assert!(defaults.enabled);
        for action in ACTIONS {
            let binding = defaults.binding(action);
            assert_eq!(normalize(binding).as_deref(), Some(binding));
            assert!(binding.starts_with("CmdOrCtrl+Alt+Shift+"), "{binding}");
        }
        assert_eq!(defaults.toggle_lyrics, "CmdOrCtrl+Alt+Shift+L");
        // `]` sits right of `[`: earlier (positive) on the right.
        assert_eq!(defaults.nudge_earlier, "CmdOrCtrl+Alt+Shift+]");
        assert_eq!(defaults.nudge_later, "CmdOrCtrl+Alt+Shift+[");
    }
    #[test]
    fn actions_fields_and_nudges() {
        assert_eq!(nudge_ms(ShortcutAction::ToggleLyrics), None);
        // Positive is earlier.
        assert_eq!(nudge_ms(ShortcutAction::NudgeEarlier), Some(50.0));
        assert_eq!(nudge_ms(ShortcutAction::NudgeLater), Some(-50.0));
        for action in ACTIONS {
            assert_eq!(serde_json::to_value(action).unwrap(), field(action));
        }
        let mut shortcuts = Settings::default().shortcuts;
        *shortcuts.binding_mut(ShortcutAction::NudgeLater) = "Alt+1".into();
        assert_eq!(shortcuts.nudge_later, "Alt+1");
        assert_eq!(shortcuts.binding(ShortcutAction::NudgeLater), "Alt+1");
        let mut status = ShortcutsStatus::default();
        status.set(ShortcutAction::NudgeEarlier, ShortcutState::Unavailable);
        assert_eq!(
            status.get(ShortcutAction::NudgeEarlier),
            ShortcutState::Unavailable
        );
        assert_eq!(status.get(ShortcutAction::ToggleLyrics), ShortcutState::Off);
    }

    fn plans(shortcuts: &Shortcuts, macos: bool) -> Vec<Plan> {
        plan(shortcuts, macos).into_iter().map(|(_, p)| p).collect()
    }
    #[test]
    fn the_plan_registers_each_binding_unless_off_or_unusable() {
        let mut shortcuts = Settings::default().shortcuts;
        for macos in [true, false] {
            assert_eq!(
                plans(&shortcuts, macos),
                [
                    Plan::Register("CmdOrCtrl+Alt+Shift+L".into()),
                    Plan::Register("CmdOrCtrl+Alt+Shift+]".into()),
                    Plan::Register("CmdOrCtrl+Alt+Shift+[".into()),
                ]
            );
        }
        assert_eq!(plan(&shortcuts, true).map(|(action, _)| action), ACTIONS);
        // "" is no shortcut; a hand-edited binding Undertone doesn't accept is invalid.
        shortcuts.nudge_earlier = String::new();
        shortcuts.nudge_later = "Shift+L".into();
        assert_eq!(plans(&shortcuts, false)[1..], [Plan::Off, Plan::Invalid]);
        // Off turns every one off, whatever it is.
        shortcuts.enabled = false;
        assert_eq!(plans(&shortcuts, false), [Plan::Off, Plan::Off, Plan::Off]);
    }
    #[test]
    fn the_plan_knows_the_keys_each_os_lacks_or_shares() {
        let shortcuts = Shortcuts {
            enabled: true,
            toggle_lyrics: "Alt+F21".into(),
            nudge_earlier: "CmdOrCtrl+K".into(),
            nudge_later: "Control+K".into(),
        };
        // macOS: no F21–F24; CmdOrCtrl is ⌘, so ⌘K and ⌃K are both fine.
        assert_eq!(
            plans(&shortcuts, true),
            [
                Plan::Invalid,
                Plan::Register("CmdOrCtrl+K".into()),
                Plan::Register("Control+K".into()),
            ]
        );
        // Windows: F21 exists; CmdOrCtrl is Ctrl, so the second Ctrl+K is the first one's keys.
        assert_eq!(
            plans(&shortcuts, false),
            [
                Plan::Register("Alt+F21".into()),
                Plan::Register("CmdOrCtrl+K".into()),
                Plan::Invalid,
            ]
        );
        let on_mac = Shortcuts {
            nudge_later: "Super+K".into(),
            ..shortcuts
        };
        assert_eq!(plans(&on_mac, true)[2], Plan::Invalid);
        assert_eq!(plans(&on_mac, false)[2], Plan::Register("Super+K".into()));
    }

    #[test]
    fn a_suspension_ends_on_resume_or_its_own_time_limit_only() {
        let mut suspension = Suspension::default();
        assert!(!suspension.is_active());
        assert!(!suspension.resume(), "nothing to resume");
        let first = suspension.suspend();
        assert!(suspension.is_active());
        // Settings records again before the first limit runs out: the old limit can't end it.
        let second = suspension.suspend();
        assert!(!suspension.expire(first));
        assert!(suspension.is_active());
        assert!(suspension.expire(second));
        assert!(!suspension.is_active());
        assert!(!suspension.expire(second), "already over");
        let third = suspension.suspend();
        assert!(suspension.resume());
        assert!(!suspension.expire(third), "resumed before the limit");
        assert_eq!(SUSPEND_LIMIT, Duration::from_secs(30));
    }

    #[test]
    fn a_status_is_reported_only_when_a_pass_changes_it() {
        // AppState starts with every action off.
        let mut last = ShortcutsStatus::default();
        assert!(!last.record(&ShortcutsStatus::default()));
        let mut status = ShortcutsStatus::default();
        status.set(ShortcutAction::ToggleLyrics, ShortcutState::Ok);
        status.set(ShortcutAction::NudgeLater, ShortcutState::Unavailable);
        assert!(last.record(&status));
        assert_eq!(last, status);
        assert!(!last.record(&status), "the same again sends nothing");
        status.set(ShortcutAction::NudgeLater, ShortcutState::Ok);
        assert!(last.record(&status));
        assert_eq!(last.get(ShortcutAction::NudgeLater), ShortcutState::Ok);
    }

    /// A string the plugin can't parse would only fail at registration, so check every key here
    /// (CI runs this on macOS and Windows).
    #[cfg(all(feature = "desktop", any(target_os = "windows", target_os = "macos")))]
    #[test]
    fn every_accepted_accelerator_parses_to_the_intended_keys() {
        use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
        let cmd_or_ctrl = if cfg!(target_os = "macos") {
            Modifiers::SUPER
        } else {
            Modifiers::CONTROL
        };
        let defaults = Settings::default().shortcuts;
        let keys = [Code::KeyL, Code::BracketRight, Code::BracketLeft];
        for (action, key) in ACTIONS.into_iter().zip(keys) {
            let parsed: Shortcut = defaults.binding(action).parse().unwrap();
            assert_eq!(
                parsed,
                Shortcut::new(Some(cmd_or_ctrl | Modifiers::ALT | Modifiers::SHIFT), key)
            );
        }
        for key in every_key() {
            let parsed: Shortcut = format!("Control+{key}").parse().expect(&key);
            assert_eq!(parsed.mods, Modifiers::CONTROL, "{key}");
        }
        let (shared, _) = shared_fixture();
        let shared = shared
            .iter()
            .map(|(input, stored)| (input.as_str(), stored.as_str()));
        for (input, stored) in ACCEPTED.iter().copied().chain(shared) {
            let parsed: Shortcut = stored.parse().expect(input);
            let modifiers = [
                ("CmdOrCtrl", cmd_or_ctrl),
                ("Control", Modifiers::CONTROL),
                ("Super", Modifiers::SUPER),
                ("Alt", Modifiers::ALT),
                ("Shift", Modifiers::SHIFT),
            ]
            .into_iter()
            .filter(|(name, _)| stored.split('+').any(|token| token == *name))
            .fold(Modifiers::empty(), |all, (_, bits)| all | bits);
            assert_eq!(parsed.mods, modifiers, "{stored}");
        }
        let parsed: Shortcut = "Alt+PageDown".parse().unwrap();
        assert_eq!(parsed.key, Code::PageDown);
        let parsed: Shortcut = "Alt+`".parse().unwrap();
        assert_eq!(parsed.key, Code::Backquote);
    }
}
