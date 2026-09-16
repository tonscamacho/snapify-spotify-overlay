use std::sync::Mutex;
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
    applied_sig: Option<String>,
    ignore_applied: Option<bool>,
}

const MAX_REGIONS: usize = 64;

fn phys_rects(
    regions: &[OverlayRect],
    scale: f64,
    dx: f64,
    dy: f64,
) -> Vec<(i32, i32, i32, i32)> {
    regions
        .iter()
        .filter(|r| r.w > 0.0 && r.h > 0.0 && r.x.is_finite() && r.y.is_finite())
        .take(MAX_REGIONS)
        .filter_map(|r| {
            let l = (r.x * scale + dx).round() as i32;
            let t = (r.y * scale + dy).round() as i32;
            let rr = ((r.x + r.w) * scale + dx).round() as i32;
            let b = ((r.y + r.h) * scale + dy).round() as i32;
            if rr > l && b > t {
                Some((l, t, rr, b))
            } else {
                None
            }
        })
        .collect()
}

fn apply_signature(interactive: bool, rects: &[(i32, i32, i32, i32)]) -> String {
    format!("{interactive}|{rects:?}")
}

#[cfg(windows)]
const RGN_OR: i32 = 2;

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn SetWindowRgn(h_wnd: isize, h_rgn: isize, b_redraw: i32) -> i32;
}

#[cfg(windows)]
#[link(name = "gdi32")]
extern "system" {
    fn CreateRectRgn(l: i32, t: i32, r: i32, b: i32) -> isize;
    fn CombineRgn(h_dest: isize, h_src1: isize, h_src2: isize, mode: i32) -> i32;
    fn DeleteObject(h: isize) -> i32;
}

#[cfg(windows)]
fn set_window_region(hwnd: isize, rects: &[(i32, i32, i32, i32)]) {
    unsafe {
        let acc = CreateRectRgn(0, 0, 0, 0);
        if acc == 0 {
            return;
        }
        for (l, t, r, b) in rects {
            let part = CreateRectRgn(*l, *t, *r, *b);
            if part == 0 {
                continue;
            }
            CombineRgn(acc, acc, part, RGN_OR);
            DeleteObject(part);
        }
        // Success transfers ownership to the system; failure means we free it.
        if SetWindowRgn(hwnd, acc, 1) == 0 {
            DeleteObject(acc);
        }
    }
}

fn frame_offset(win: &tauri::WebviewWindow) -> (f64, f64) {
    match (win.inner_position(), win.outer_position()) {
        (Ok(inner), Ok(outer)) => (
            f64::from(inner.x - outer.x),
            f64::from(inner.y - outer.y),
        ),
        _ => (0.0, 0.0),
    }
}

fn apply_region(app: &AppHandle) {
    let (interactive, regions) = match app.try_state::<OverlayState>() {
        Some(s) => match s.inner.lock() {
            Ok(g) => (g.interactive, g.regions.clone()),
            Err(_) => return,
        },
        None => return,
    };
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if !win.is_visible().unwrap_or(true) {
        return;
    }
    let Some(state) = app.try_state::<OverlayState>() else {
        return;
    };
    // Whole-window transparency flips only on explicit mode switches, the
    // same cadence as before the region work. Cursor movement alone must
    // never restyle the window: each restyle flashes a maximized window.
    let want_ignore = !interactive;
    {
        let mut guard = match state.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if guard.ignore_applied != Some(want_ignore) {
            guard.ignore_applied = Some(want_ignore);
            drop(guard);
            let _ = win.set_ignore_cursor_events(want_ignore);
        }
    }
    if !interactive {
        if let Ok(mut guard) = state.inner.lock() {
            guard.applied_sig = None;
        }
        return;
    }
    let scale = win.scale_factor().unwrap_or(1.0);
    if !(scale > 0.0) {
        return;
    }
    let (dx, dy) = frame_offset(&win);
    let rects = phys_rects(&regions, scale, dx, dy);
    let sig = apply_signature(interactive, &rects);
    {
        let mut guard = match state.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if guard.applied_sig.as_deref() == Some(sig.as_str()) {
            return;
        }
        guard.applied_sig = Some(sig);
    }
    #[cfg(windows)]
    {
        let hwnd = match win.hwnd() {
            Ok(h) => h.0 as isize,
            Err(_) => return,
        };
        set_window_region(hwnd, &rects);
    }
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
    apply_region(&app);
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
            .take(MAX_REGIONS)
            .collect();
    }
    apply_region(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{apply_signature, phys_rects};

    #[test]
    fn css_rects_scale_and_offset_to_physical() {
        let regions = vec![super::OverlayRect {
            x: 10.0,
            y: 20.0,
            w: 100.0,
            h: 50.0,
        }];
        assert_eq!(phys_rects(&regions, 1.5, -7.0, 0.0), vec![(8, 30, 158, 105)]);
    }

    #[test]
    fn degenerate_rects_never_reach_the_os() {
        let regions = vec![
            super::OverlayRect { x: 0.0, y: 0.0, w: 0.0, h: 10.0 },
            super::OverlayRect { x: 5.0, y: 5.0, w: -3.0, h: 4.0 },
            super::OverlayRect { x: f64::NAN, y: 0.0, w: 4.0, h: 4.0 },
        ];
        assert!(phys_rects(&regions, 1.0, 0.0, 0.0).is_empty());
    }

    #[test]
    fn signature_settles_identical_reports() {
        let rects = vec![(8, 30, 158, 105)];
        assert_eq!(
            apply_signature(true, &rects),
            apply_signature(true, &rects)
        );
        assert_ne!(
            apply_signature(true, &rects),
            apply_signature(true, &[(8, 30, 159, 105)])
        );
        assert_ne!(
            apply_signature(true, &rects),
            apply_signature(false, &rects)
        );
    }

    #[test]
    fn empty_region_list_means_passthrough() {
        assert!(phys_rects(&[], 1.0, 0.0, 0.0).is_empty());
    }
}
