mod auth;
mod keybinds;
mod lyrics;
mod overlay;
mod spotify;
mod system;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

fn toggle_interactive(app: &tauri::AppHandle) {
    // Never hide the window here. Hiding/showing a maximized always-on-top
    // transparent window drops exclusive-fullscreen games out of focus and
    // flashes the desktop compositor. Keep the window visible and let the
    // frontend flip click-through instead.
    if let Some(win) = app.get_webview_window("main") {
        if !win.is_visible().unwrap_or(true) {
            let _ = win.show();
        }
        // Deliberately no set_focus: focusing steals the game on every toggle.
    }
    let _ = app.emit("overlay-toggle-active", ());
}

fn toggle_visibility(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let visible = win.is_visible().unwrap_or(true);
        if visible {
            let _ = win.hide();
        } else {
            let _ = win.show();
            // Deliberately no set_focus: showing must not steal the game.
        }
        let _ = app.emit("overlay-visibility-changed", !visible);
    }
}

/// Frontend command surface for `toggle_visibility`: dock, settings, tray,
/// and the global hotkey all funnel through the same flip so the paths
/// cannot drift. The frontend already invokes this name.
#[tauri::command]
fn toggle_visibility_cmd(app: tauri::AppHandle) {
    toggle_visibility(&app);
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let visibility =
        MenuItem::with_id(app, "toggle-visibility", "Show / Hide window", true, None::<&str>)?;
    let show_hide = MenuItem::with_id(app, "show-hide", "Interact / Pass through", true, None::<&str>)?;
    let edit = MenuItem::with_id(app, "toggle-edit", "Edit lock", true, None::<&str>)?;
    let preset = MenuItem::with_id(app, "cycle-preset", "Cycle preset", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "open-settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&visibility, &show_hide, &edit, &preset, &settings, &quit])?;

    let icon = match app.default_window_icon().cloned() {
        Some(i) => i,
        None => {
            eprintln!("tray init skipped: no default window icon");
            return Ok(());
        }
    };

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Snapify - Spotify Overlay")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle-visibility" => toggle_visibility(app),
            "show-hide" => toggle_interactive(app),
            "toggle-edit" => {
                let _ = app.emit("tray-toggle-edit", ());
            }
            "cycle-preset" => {
                let _ = app.emit("tray-cycle-preset", ());
            }
            "open-settings" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                let _ = app.emit("tray-open-settings", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_interactive(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn register_shortcuts(app: &tauri::AppHandle, map: &HashMap<String, String>) -> Vec<String> {
    let mut failed: Vec<String> = Vec::new();
    for action in keybinds::GLOBAL_ACTIONS {
        let Some(acc) = map.get(*action) else { continue };
        let Ok(shortcut) = acc.parse::<tauri_plugin_global_shortcut::Shortcut>() else {
            let msg = format!("{action} (\"{acc}\"): cannot parse shortcut");
            eprintln!("global shortcut {msg}");
            failed.push(msg);
            continue;
        };
        match app.global_shortcut().register(shortcut) {
            Ok(()) => {}
            Err(e) => {
                let msg = format!("{action} (\"{acc}\"): {e}");
                eprintln!("global shortcut {action} (\"{acc}\") not registered: {e}");
                failed.push(msg);
            }
        }
    }
    failed
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Boot instant for the boot-to-first-overlay-report timing log (the
    // elapsed time prints from `overlay::set_overlay_mode/regions` on the
    // first frontend report).
    overlay::note_boot();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch focuses the live window instead of silently
            // exiting. show() first so a hidden window never swallows the
            // relaunch without a trace.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            // Autostart relaunches with `--minimized`; `setup` hides the
            // window below so boot never flashes over a game. The tray
            // icon restores it.
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let action = app
                        .try_state::<keybinds::KeybindStore>()
                        .and_then(|store| {
                            let map = store.0.lock().unwrap().clone();
                            keybinds::action_for_shortcut(&map, shortcut)
                        });
                    match action.as_deref() {
                        Some(s) if s == keybinds::ACTION_PLAYPAUSE => {
                            let _ = app.emit("shortcut-playpause", ());
                        }
                        Some(s) if s == keybinds::ACTION_NEXT => {
                            let _ = app.emit("shortcut-next", ());
                        }
                        Some(s) if s == keybinds::ACTION_MUTE => {
                            let _ = app.emit("shortcut-mute", ());
                        }
                        Some(s) if s == keybinds::ACTION_LIKE => {
                            let _ = app.emit("shortcut-like", ());
                        }
                        Some(s) if s == keybinds::ACTION_SEEK_BACK => {
                            let _ = app.emit("shortcut-seek-back", ());
                        }
                        Some(s) if s == keybinds::ACTION_SEEK_FWD => {
                            let _ = app.emit("shortcut-seek-forward", ());
                        }
                        Some(s) if s == keybinds::ACTION_INTERACT => {
                            toggle_interactive(app);
                        }
                        Some(s) if s == keybinds::ACTION_EDIT => {
                            let _ = app.emit("shortcut-edit", ());
                        }
                        Some(s) if s == keybinds::ACTION_VISIBILITY => {
                            toggle_visibility(app);
                        }
                        _ => {}
                    }
                })
                .build(),
        )
        .manage(auth::AuthState::default())
        .manage(overlay::OverlayState::default())
        .setup(|app| {
            auth::restore_session(&app.handle());
            // Boot click-through so a launch over a game never eats input
            // before the frontend effect runs.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_ignore_cursor_events(true);
                // Phase 5 desktop frost deliberately deferred: this window is
                // maximized and transparent so the game shows through the gaps.
                // A window-wide Mica/Acrylic/Vibrancy effect would frost the
                // whole screen, hiding the game. Cards carry their own CSS
                // frost plus the Chromium lens instead.
            }
            let map = keybinds::load_map(&app.handle());
            app.manage(keybinds::KeybindStore(Mutex::new(map.clone())));
            if let Err(e) = build_tray(&app.handle()) {
                eprintln!("tray init failed: {e}");
            }
            let shortcut_issues = register_shortcuts(&app.handle(), &map);
            app.manage(keybinds::KeybindIssues(Mutex::new(shortcut_issues)));
            // `--minimized` (autostart or manual) starts hidden: no boot
            // flash over a game, tray restores on demand.
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth::auth_status,
            auth::start_login,
            auth::logout,
            auth::get_fresh_token,
            spotify::get_player,
            spotify::get_devices,
            spotify::get_queue,
            spotify::play,
            spotify::pause,
            spotify::next_track,
            spotify::prev_track,
            spotify::seek,
            spotify::set_volume,
            spotify::set_shuffle,
            spotify::set_repeat,
            spotify::transfer_playback,
            spotify::add_to_queue,
            spotify::get_me,
            spotify::get_my_playlists,
            spotify::create_playlist,
            spotify::get_my_tracks,
            spotify::get_my_albums,
            spotify::get_my_shows,
            spotify::get_my_episodes,
            spotify::get_my_audiobooks,
            spotify::get_my_following,
            spotify::library_contains,
            spotify::library_save,
            spotify::library_remove,
            spotify::follow_put,
            spotify::follow_delete,
            spotify::get_followed_artists,
            spotify::get_my_top,
            spotify::get_recently_played,
            spotify::get_playlist,
            spotify::get_playlist_items,
            spotify::add_playlist_items,
            spotify::remove_playlist_items,
            spotify::reorder_playlist_items,
            spotify::get_track,
            spotify::get_artist,
            spotify::get_related_artists,
            spotify::get_artist_albums,
            spotify::get_album,
            spotify::get_album_tracks,
            spotify::get_show,
            spotify::get_show_episodes,
            spotify::get_episode,
            spotify::get_audiobook,
            spotify::get_audiobook_chapters,
            spotify::get_chapter,
            spotify::search,
            spotify::play_context,
            spotify::play_uris,
            spotify::request_log_counts,
            spotify::request_log_recent,
            lyrics::get_lyrics,
            system::autostart_state,
            system::set_autostart,
            overlay::set_overlay_mode,
            overlay::set_overlay_regions,
            toggle_visibility_cmd,
            keybinds::get_keybinds,
            keybinds::keybind_startup_errors,
            keybinds::set_keybind,
            keybinds::reset_keybinds,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
