use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct OverlayRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Default)]
pub struct OverlayState {
    inner: Mutex<OverlayInner>,
}

#[derive(Default)]
struct OverlayInner {
    interactive: bool,
    regions: Vec<OverlayRect>,
    applied_ignore: Option<bool>,
}

impl OverlayRect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

#[cfg(windows)]
#[repr(C)]
struct WinPoint {
    x: i32,
    y: i32,
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetCursorPos(lp_point: *mut WinPoint) -> i32;
}

#[cfg(windows)]
fn global_cursor() -> Option<(i32, i32)> {
    let mut p = WinPoint { x: 0, y: 0 };
    let ok = unsafe { GetCursorPos(&mut p as *mut WinPoint) };
    if ok == 0 {
        None
    } else {
        Some((p.x, p.y))
    }
}

fn cursor_over_regions(app: &AppHandle, regions: &[OverlayRect]) -> Option<bool> {
    #[cfg(windows)]
    {
        let win = app.get_webview_window("main")?;
        if !win.is_visible().unwrap_or(true) {
            return None;
        }
        let (cx, cy) = global_cursor()?;
        let pos = win.outer_position().ok()?;
        let scale = win.scale_factor().unwrap_or(1.0);
        if scale <= 0.0 {
            return None;
        }
        let lx = (f64::from(cx - pos.x)) / scale;
        let ly = (f64::from(cy - pos.y)) / scale;
        Some(regions.iter().any(|r| r.contains(lx, ly)))
    }
    #[cfg(not(windows))]
    {
        let _ = (app, regions);
        None
    }
}

fn apply_ignore(win: &tauri::WebviewWindow, ignore: bool, state: &OverlayState) {
    let changed = {
        let mut inner = match state.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if inner.applied_ignore == Some(ignore) {
            false
        } else {
            inner.applied_ignore = Some(ignore);
            true
        }
    };
    if changed {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}

pub fn poll_once(app: &AppHandle) {
    let (interactive, regions) = match app.try_state::<OverlayState>() {
        Some(s) => {
            let guard = match s.inner.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            (guard.interactive, guard.regions.clone())
        }
        None => return,
    };
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let Some(state) = app.try_state::<OverlayState>() else {
        return;
    };
    if !interactive {
        apply_ignore(&win, true, &state);
        return;
    }
    match cursor_over_regions(app, &regions) {
        Some(over) => apply_ignore(&win, !over, &state),
        None => {
            // No global cursor (non-Windows or probe failed): fall back to
            // whole-window interactive so panes stay usable. Empty pixels
            // still capture here, but focus is never stolen programmatically.
            apply_ignore(&win, regions.is_empty(), &state);
        }
    }
}

pub fn spawn_poller(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(50)).await;
            poll_once(&handle);
        }
    });
}

#[tauri::command]
pub fn set_overlay_mode(app: AppHandle, interactive: bool) -> Result<(), String> {
    let state = app
        .try_state::<OverlayState>()
        .ok_or("overlay state missing")?;
    {
        let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
        guard.interactive = interactive;
    }
    poll_once(&app);
    Ok(())
}

#[tauri::command]
pub fn set_overlay_regions(
    app: AppHandle,
    regions: Vec<OverlayRect>,
) -> Result<(), String> {
    let state = app
        .try_state::<OverlayState>()
        .ok_or("overlay state missing")?;
    {
        let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
        guard.regions = regions
            .into_iter()
            .filter(|r| r.w > 0.0 && r.h > 0.0)
            .take(64)
            .collect();
    }
    poll_once(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::OverlayRect;

    #[test]
    fn hit_test_covers_pane_edges() {
        let r = OverlayRect {
            x: 10.0,
            y: 20.0,
            w: 100.0,
            h: 50.0,
        };
        assert!(r.contains(10.0, 20.0));
        assert!(r.contains(50.0, 40.0));
        assert!(!r.contains(9.9, 40.0));
        assert!(!r.contains(110.0, 40.0));
        assert!(!r.contains(50.0, 70.0));
    }

    #[test]
    fn empty_region_list_means_passthrough() {
        let regions: Vec<OverlayRect> = vec![];
        assert!(!regions.iter().any(|r| r.contains(500.0, 500.0)));
    }
}
