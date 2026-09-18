use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_global_shortcut::Shortcut;

pub const ACTION_PLAYPAUSE: &str = "playpause";
pub const ACTION_NEXT: &str = "next";
pub const ACTION_MUTE: &str = "mute";
pub const ACTION_LIKE: &str = "toggleLike";
pub const ACTION_SEEK_BACK: &str = "seekBack10";
pub const ACTION_SEEK_FWD: &str = "seekForward10";
pub const ACTION_INTERACT: &str = "toggleInteract";
pub const ACTION_EDIT: &str = "toggleEdit";
pub const ACTION_VISIBILITY: &str = "toggleVisibility";
pub const ACTION_PRESET: &str = "cyclePreset";
pub const ACTION_LEGACY: &str = "legacyInteract";

pub const DEFAULTS: &[(&str, &str)] = &[
    (ACTION_PLAYPAUSE, "Ctrl+Alt+P"),
    (ACTION_NEXT, "Ctrl+Alt+N"),
    (ACTION_MUTE, "Ctrl+Alt+M"),
    (ACTION_LIKE, "Ctrl+Alt+K"),
    (ACTION_SEEK_BACK, "Ctrl+Alt+B"),
    (ACTION_SEEK_FWD, "Ctrl+Alt+F"),
    (ACTION_INTERACT, "Shift+Tab"),
    (ACTION_EDIT, "Ctrl+Alt+E"),
    (ACTION_VISIBILITY, "Ctrl+Alt+H"),
    (ACTION_PRESET, "Ctrl+Alt+L"),
    (ACTION_LEGACY, "Ctrl+Alt+C"),
];

pub const GLOBAL_ACTIONS: &[&str] = &[
    ACTION_PLAYPAUSE,
    ACTION_NEXT,
    ACTION_MUTE,
    ACTION_LIKE,
    ACTION_SEEK_BACK,
    ACTION_SEEK_FWD,
    ACTION_INTERACT,
    ACTION_EDIT,
    ACTION_VISIBILITY,
];

pub struct KeybindStore(pub Mutex<HashMap<String, String>>);

/// Startup registration failures (busy/conflicting globals) collected in
/// `register_shortcuts` so Settings can surface them instead of only
/// logging to stderr.
pub struct KeybindIssues(pub Mutex<Vec<String>>);

pub fn default_map() -> HashMap<String, String> {
    DEFAULTS
        .iter()
        .map(|(a, s)| ((*a).to_string(), (*s).to_string()))
        .collect()
}

fn keybinds_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("keybinds.json"))
}

pub fn action_label(action: &str) -> &'static str {
    match action {
        s if s == ACTION_PLAYPAUSE => "Play / Pause",
        s if s == ACTION_NEXT => "Next track",
        s if s == ACTION_MUTE => "Mute / Unmute",
        s if s == ACTION_LIKE => "Like / Unlike track",
        s if s == ACTION_SEEK_BACK => "Seek back 10 seconds",
        s if s == ACTION_SEEK_FWD => "Seek forward 10 seconds",
        s if s == ACTION_INTERACT => "Interact / Pass through",
        s if s == ACTION_EDIT => "Edit lock",
        s if s == ACTION_VISIBILITY => "Show / Hide window",
        s if s == ACTION_PRESET => "Cycle preset (needs overlay focus)",
        s if s == ACTION_LEGACY => "Interact toggle, legacy (needs overlay focus)",
        _ => "Shortcut",
    }
}

fn parse_accelerator(accelerator: &str) -> Result<Shortcut, String> {
    accelerator
        .parse::<Shortcut>()
        .map_err(|e| format!("\"{accelerator}\" is not a valid shortcut ({e})"))
}

fn normalize_id(accelerator: &str) -> Option<u32> {
    accelerator.parse::<Shortcut>().ok().map(|s| s.id())
}

fn reject_unsafe_accelerator(accelerator: &str) -> Result<(), String> {
    let lower = accelerator.to_lowercase();
    let has_ctrl = lower.contains("ctrl") || lower.contains("control");
    let has_alt = lower.contains("alt") || lower.contains("option");
    let has_super = lower.contains("super")
        || lower.contains("meta")
        || lower.contains("win")
        || lower.contains("cmd")
        || lower.contains("command");
    let has_shift = lower.contains("shift");
    let key = accelerator
        .split('+')
        .next_back()
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_default();
    let is_escape = key == "escape" || key == "esc";
    if is_escape && !(has_ctrl || has_alt || has_super) {
        return Err("Esc alone exits edit mode. Add Ctrl, Alt, or Win.".into());
    }
    if !(has_ctrl || has_alt || has_super) {
        let shift_special = has_shift
            && (key == "tab"
                || key == "space"
                || (key.starts_with('f')
                    && key[1..].parse::<u32>().map(|n| (1..=24).contains(&n)).unwrap_or(false)));
        if !shift_special {
            return Err(
                "Add Ctrl, Alt, or Win to a global shortcut. Bare keys would steal typing.".into(),
            );
        }
    }
    Ok(())
}

pub fn load_map(app: &AppHandle) -> HashMap<String, String> {
    let mut map = default_map();
    let path = match keybinds_path(app) {
        Some(p) => p,
        None => return map,
    };
    let text = fs::read_to_string(path).unwrap_or_default();
    if text.is_empty() {
        return map;
    }
    let parsed: HashMap<String, String> = serde_json::from_str(&text).unwrap_or_default();
    for (action, _) in DEFAULTS {
        if let Some(v) = parsed.get(*action) {
            let v = v.trim();
            if v.is_empty() || parse_accelerator(v).is_err() {
                continue;
            }
            let duplicate = DEFAULTS.iter().any(|(other, def)| {
                if *other == *action {
                    return false;
                }
                let effective = parsed
                    .get(*other)
                    .map(|o| o.trim())
                    .filter(|o| !o.is_empty() && parse_accelerator(o).is_ok())
                    .unwrap_or(def);
                normalize_id(effective) == normalize_id(v)
            });
            if duplicate {
                continue;
            }
            map.insert((*action).to_string(), v.to_string());
        }
    }
    map
}

fn save_map(app: &AppHandle, map: &HashMap<String, String>) {
    if let Some(path) = keybinds_path(app) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string(map) {
            let _ = fs::write(path, text);
        }
    }
}

fn shortcut_for(map: &HashMap<String, String>, action: &str) -> Option<Shortcut> {
    map.get(action)?.parse::<Shortcut>().ok()
}

pub fn action_for_shortcut(map: &HashMap<String, String>, shortcut: &Shortcut) -> Option<String> {
    for action in GLOBAL_ACTIONS {
        if let Some(owned) = shortcut_for(map, action) {
            if shortcut == &owned {
                return Some((*action).to_string());
            }
        }
    }
    None
}

#[tauri::command]
pub fn get_keybinds(store: State<'_, KeybindStore>) -> HashMap<String, String> {
    store.0.lock().unwrap().clone()
}

/// Startup global-shortcut failures (busy/conflicting registrations) for
/// the Settings keybind rows. Empty when every global chord grabbed cleanly.
#[tauri::command]
pub fn keybind_startup_errors(state: State<'_, KeybindIssues>) -> Vec<String> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_keybind(
    app: AppHandle,
    store: State<'_, KeybindStore>,
    action: String,
    accelerator: String,
) -> Result<HashMap<String, String>, String> {
    if !DEFAULTS.iter().any(|(a, _)| *a == action) {
        return Err(format!("unknown shortcut \"{action}\""));
    }
    let accelerator = accelerator.trim().to_string();
    parse_accelerator(&accelerator)?;
    reject_unsafe_accelerator(&accelerator)?;
    let new_id = normalize_id(&accelerator).ok_or("could not parse shortcut")?;
    {
        let map = store.0.lock().unwrap();
        for (other, other_acc) in map.iter() {
            if *other != action && normalize_id(other_acc) == Some(new_id) {
                return Err(format!(
                    "\"{accelerator}\" is already used by {}",
                    action_label(other)
                ));
            }
        }
    }
    let is_global = GLOBAL_ACTIONS.contains(&action.as_str());
    if is_global {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let old = store
            .0
            .lock()
            .unwrap()
            .get(&action)
            .cloned()
            .unwrap_or_default();
        if normalize_id(&old) != Some(new_id) {
            let fresh: Shortcut = parse_accelerator(&accelerator)?;
            app.global_shortcut()
                .register(fresh)
                .map_err(|e| format!("could not grab \"{accelerator}\" ({e})"))?;
            if let Ok(old_shortcut) = old.parse::<Shortcut>() {
                let _ = app.global_shortcut().unregister(old_shortcut);
            }
        }
    }
    let cloned = {
        let out = {
            let mut map = store.0.lock().unwrap();
            map.insert(action, accelerator);
            map.clone()
        };
        save_map(&app, &out);
        out
    };
    Ok(cloned)
}

#[tauri::command]
pub fn reset_keybinds(
    app: AppHandle,
    store: State<'_, KeybindStore>,
) -> Result<HashMap<String, String>, String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let current: HashMap<String, String> = store.0.lock().unwrap().clone();
    for action in GLOBAL_ACTIONS {
        if let Some(acc) = current.get(*action) {
            if let Ok(s) = acc.parse::<Shortcut>() {
                let _ = app.global_shortcut().unregister(s);
            }
        }
    }
    let defaults = default_map();
    let mut failed: Vec<String> = Vec::new();
    let mut applied = current.clone();
    for action in GLOBAL_ACTIONS {
        if let Some(acc) = defaults.get(*action) {
            if let Ok(s) = acc.parse::<Shortcut>() {
                if let Err(e) = app.global_shortcut().register(s) {
                    failed.push(format!("{action} ({acc}): {e}"));
                } else {
                    applied.insert((*action).to_string(), acc.clone());
                }
            }
        }
    }
    for (action, acc) in defaults.iter() {
        if !GLOBAL_ACTIONS.contains(&action.as_str()) {
            applied.insert((*action).to_string(), (*acc).to_string());
        }
    }
    {
        let out = {
            let mut map = store.0.lock().unwrap();
            *map = applied.clone();
            map.clone()
        };
        save_map(&app, &out);
    }
    if failed.is_empty() {
        Ok(applied)
    } else {
        Err(format!("reset, but some shortcuts are busy: {}", failed.join(", ")))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        action_for_shortcut, default_map, normalize_id, reject_unsafe_accelerator, ACTION_EDIT,
        ACTION_INTERACT, ACTION_LIKE, ACTION_MUTE, ACTION_NEXT, ACTION_PLAYPAUSE,
        ACTION_SEEK_BACK, ACTION_SEEK_FWD, ACTION_VISIBILITY, GLOBAL_ACTIONS,
    };

    #[test]
    fn defaults_cover_all_global_actions() {
        let map = default_map();
        for action in GLOBAL_ACTIONS {
            assert!(map.contains_key(*action), "missing {action}");
        }
        assert_eq!(map.len(), 11);
    }

    #[test]
    fn dispatch_resolves_each_global_shortcut() {
        let map = default_map();
        for action in GLOBAL_ACTIONS {
            let shortcut: tauri_plugin_global_shortcut::Shortcut =
                map[*action].parse().expect("default must parse");
            assert_eq!(
                action_for_shortcut(&map, &shortcut).as_deref(),
                Some(*action)
            );
        }
    }

    #[test]
    fn known_defaults_parse() {
        for key in [
            ACTION_PLAYPAUSE,
            ACTION_NEXT,
            ACTION_MUTE,
            ACTION_LIKE,
            ACTION_SEEK_BACK,
            ACTION_SEEK_FWD,
            ACTION_INTERACT,
            ACTION_EDIT,
            ACTION_VISIBILITY,
        ] {
            let map = default_map();
            map[key].parse::<tauri_plugin_global_shortcut::Shortcut>().unwrap();
        }
    }

    #[test]
    fn focused_actions_stay_out_of_global_dispatch() {
        use super::{ACTION_LEGACY, ACTION_PRESET};
        let map = default_map();
        for key in [ACTION_PRESET, ACTION_LEGACY] {
            let shortcut: tauri_plugin_global_shortcut::Shortcut =
                map[key].parse().expect("focused default must parse");
            assert_eq!(action_for_shortcut(&map, &shortcut), None);
        }
    }

    #[test]
    fn duplicate_detection_uses_shortcut_id() {
        let a: tauri_plugin_global_shortcut::Shortcut = "Ctrl+Alt+P".parse().unwrap();
        let b: tauri_plugin_global_shortcut::Shortcut = "ctrl+alt+KeyP".parse().unwrap();
        assert_eq!(a.id(), b.id());
    }

    #[test]
    fn alias_respelling_is_same_id() {
        assert_eq!(normalize_id("Ctrl+Alt+P"), normalize_id("ctrl+alt+KeyP"));
    }

    #[test]
    fn rejects_bare_keys_and_bare_escape() {
        assert!(reject_unsafe_accelerator("P").is_err());
        assert!(reject_unsafe_accelerator("Escape").is_err());
        assert!(reject_unsafe_accelerator("Shift+Escape").is_err());
        assert!(reject_unsafe_accelerator("Ctrl+Alt+P").is_ok());
        assert!(reject_unsafe_accelerator("Shift+Tab").is_ok());
        assert!(reject_unsafe_accelerator("Ctrl+Alt+H").is_ok());
    }
}
