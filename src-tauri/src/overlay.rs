use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct OverlayRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Frontend-reported window origin in CSS px (`window.screenX/Y`).
/// Additive PR-7 report field: Rust keeps converting rects with its live
/// `scale_factor()` (no scaling-math change); the origin only tags the
/// report so a same-CSS-rects move across mixed-DPI monitors still changes
/// the applied signature and re-applies regions.
#[derive(Clone, Copy, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct MonitorOrigin {
    pub x: i32,
    pub y: i32,
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
    /// Last frontend-reported `window.devicePixelRatio` / `screenX|Y`.
    /// Informational tags for the applied signature only; conversion still
    /// uses the live window scale factor read per apply.
    last_dpr: Option<f64>,
    last_origin: Option<MonitorOrigin>,
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

fn apply_signature(
    interactive: bool,
    dpr: Option<f64>,
    origin: Option<(i32, i32)>,
    rects: &[(i32, i32, i32, i32)],
) -> String {
    // DPR + origin ride the signature so a same-CSS-rects hop across
    // mixed-DPI monitors (identical rects, new display) still re-applies.
    format!("{interactive}|{dpr:?}|{origin:?}|{rects:?}")
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

/// Path of the single backup copy kept next to a persisted JSON file:
/// `<name>.json` -> `<name>.json.bak`.
pub(crate) fn backup_path_for(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".bak");
    PathBuf::from(name)
}

/// Atomically replaces `path` with `text`: write a temp file in the SAME
/// directory, keep one backup of the previous payload, then rename over.
/// The rename is atomic on one volume, so readers never see a half-written
/// JSON even if the app is killed mid-write. Backup rotation is best
/// effort: a failed backup must never block the fresh write.
pub(crate) fn atomic_write_json(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    if path.exists() {
        let bak = backup_path_for(path);
        let _ = std::fs::remove_file(&bak);
        let _ = std::fs::copy(path, &bak);
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Reads a persisted JSON file with single-backup recovery.
/// `parse_ok` decides whether a payload is usable (callers pass their own
/// `serde_json::from_str::<T>(t).is_ok()` check).
///
/// - Good primary -> returned as-is (backup untouched).
/// - Missing/empty/corrupt primary -> the `.bak` copy is tried; a good
///   backup is restored over the primary and returned. The restore writes
///   temp-plus-rename WITHOUT rotating the backup (using
///   `atomic_write_json` here would copy the corrupt file over the good
///   backup and destroy the only rescue copy).
/// - Both bad -> `None`; callers fall back to defaults.
pub(crate) fn read_json_guarded(
    path: &Path,
    parse_ok: impl Fn(&str) -> bool,
) -> Option<String> {
    let primary = std::fs::read_to_string(path)
        .ok()
        .filter(|t| !t.trim().is_empty());
    if let Some(text) = primary.as_deref() {
        if parse_ok(text) {
            return primary;
        }
    }
    let bak = backup_path_for(path);
    let btext = std::fs::read_to_string(&bak)
        .ok()
        .filter(|t| !t.trim().is_empty())?;
    if !parse_ok(&btext) {
        return None;
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, &btext).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
    Some(btext)
}

static BOOT_INSTANT: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
static FIRST_REPORT_ONCE: std::sync::Once = std::sync::Once::new();
static WINDOW_LISTENERS_ONCE: std::sync::Once = std::sync::Once::new();

/// Records process boot. Called once from `lib.rs run()` before the Tauri
/// event loop starts; the elapsed time is logged on the first overlay
/// report (see `note_first_report`).
pub fn note_boot() {
    let _ = BOOT_INSTANT.set(std::time::Instant::now());
}

fn note_first_report(kind: &str) {
    FIRST_REPORT_ONCE.call_once(|| match BOOT_INSTANT.get() {
        Some(t0) => eprintln!(
            "snapify: boot-to-first-overlay-report ({kind}) {}ms",
            t0.elapsed().as_millis()
        ),
        None => eprintln!("snapify: first overlay report ({kind}); boot instant unknown"),
    });
}

/// Registers one-shot window listeners that re-apply click-through regions
/// when the OS moves the window across monitors (`Moved`, which changes the
/// live scale factor and frame offset) or reports a DPI change
/// (`ScaleFactorChanged`). Registered lazily on the first overlay command
/// so no `lib.rs` wiring beyond boot timing is needed; `Once` keeps
/// repeated commands from stacking handlers.
fn ensure_window_listeners(app: &AppHandle) {
    WINDOW_LISTENERS_ONCE.call_once(|| {
        let Some(win) = app.get_webview_window("main") else {
            return;
        };
        let handle = app.clone();
        win.on_window_event(move |event| match event {
            tauri::WindowEvent::ScaleFactorChanged { .. } => apply_region(&handle),
            tauri::WindowEvent::Moved(_) => apply_region(&handle),
            _ => {}
        });
    });
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
    let (dpr, origin) = match state.inner.lock() {
        Ok(g) => (g.last_dpr, g.last_origin.map(|o| (o.x, o.y))),
        Err(_) => return,
    };
    let sig = apply_signature(interactive, dpr, origin, &rects);
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
    ensure_window_listeners(&app);
    apply_region(&app);
    note_first_report("mode");
    Ok(())
}

#[tauri::command]
pub fn set_overlay_regions(
    app: AppHandle,
    regions: Vec<OverlayRect>,
    device_pixel_ratio: Option<f64>,
    monitor_origin: Option<MonitorOrigin>,
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
        // Additive tags only: conversion still uses the live window scale
        // factor per apply. Invalid reports keep the previous tag rather
        // than poisoning the signature.
        if device_pixel_ratio
            .map(|d| d.is_finite() && d > 0.0)
            .unwrap_or(false)
        {
            guard.last_dpr = device_pixel_ratio;
        }
        if monitor_origin.is_some() {
            guard.last_origin = monitor_origin;
        }
    }
    ensure_window_listeners(&app);
    apply_region(&app);
    note_first_report("regions");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{apply_signature, atomic_write_json, backup_path_for, phys_rects, read_json_guarded};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIRS: AtomicU64 = AtomicU64::new(0);

    fn test_dir(name: &str) -> PathBuf {
        let n = TEST_DIRS.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("snapify-overlay-test-{name}-{}-{n}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn parse_ok_json(t: &str) -> bool {
        serde_json::from_str::<serde_json::Value>(t).is_ok()
    }

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
    fn fractional_and_double_dpi_scale() {
        let regions = vec![super::OverlayRect {
            x: 10.0,
            y: 20.0,
            w: 100.0,
            h: 50.0,
        }];
        assert_eq!(phys_rects(&regions, 1.25, -7.0, 0.0), vec![(6, 25, 131, 88)]);
        assert_eq!(phys_rects(&regions, 2.0, -7.0, 0.0), vec![(13, 40, 213, 140)]);
    }

    #[test]
    fn signature_tags_dpr_and_origin() {
        let rects = vec![(8, 30, 158, 105)];
        // Same CSS rects on a new monitor must still re-apply: DPR hop.
        assert_ne!(
            apply_signature(true, Some(1.0), Some((0, 0)), &rects),
            apply_signature(true, Some(2.0), Some((0, 0)), &rects)
        );
        // Same rects, same DPR, new monitor origin must still re-apply.
        assert_ne!(
            apply_signature(true, Some(1.0), Some((0, 0)), &rects),
            apply_signature(true, Some(1.0), Some((1920, 0)), &rects)
        );
        // Identical tags settle.
        assert_eq!(
            apply_signature(true, Some(1.0), Some((0, 0)), &rects),
            apply_signature(true, Some(1.0), Some((0, 0)), &rects)
        );
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
            apply_signature(true, None, None, &rects),
            apply_signature(true, None, None, &rects)
        );
        assert_ne!(
            apply_signature(true, None, None, &rects),
            apply_signature(true, None, None, &[(8, 30, 159, 105)])
        );
        assert_ne!(
            apply_signature(true, None, None, &rects),
            apply_signature(false, None, None, &rects)
        );
    }

    #[test]
    fn empty_region_list_means_passthrough() {
        assert!(phys_rects(&[], 1.0, 0.0, 0.0).is_empty());
    }

    #[test]
    fn atomic_write_roundtrips_through_guarded_read() {
        let dir = test_dir("roundtrip");
        let path = dir.join("k.json");
        atomic_write_json(&path, r#"{"a":1}"#).unwrap();
        let back = read_json_guarded(&path, parse_ok_json).expect("read back");
        assert_eq!(back, r#"{"a":1}"#);
        // First write has no previous payload, so no backup yet.
        assert!(!backup_path_for(&path).exists());
        atomic_write_json(&path, r#"{"a":2}"#).unwrap();
        let bak = std::fs::read_to_string(backup_path_for(&path)).unwrap();
        assert_eq!(bak, r#"{"a":1}"#);
    }

    #[test]
    fn corrupt_primary_restores_from_backup() {
        let dir = test_dir("restore");
        let path = dir.join("k.json");
        atomic_write_json(&path, r#"{"good":true}"#).unwrap();
        atomic_write_json(&path, r#"{"good":false}"#).unwrap();
        std::fs::write(&path, "{corrupt").unwrap();
        let back = read_json_guarded(&path, parse_ok_json).expect("backup rescue");
        assert_eq!(back, r#"{"good":true}"#);
        // Primary is healed in place; the good backup is not clobbered.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"good":true}"#);
        assert_eq!(
            std::fs::read_to_string(backup_path_for(&path)).unwrap(),
            r#"{"good":true}"#
        );
    }

    #[test]
    fn missing_or_doubly_corrupt_yields_none() {
        let dir = test_dir("none");
        let path = dir.join("absent.json");
        assert!(read_json_guarded(&path, parse_ok_json).is_none());
        std::fs::write(&path, "{bad").unwrap();
        std::fs::write(backup_path_for(&path), "{alsobad").unwrap();
        assert!(read_json_guarded(&path, parse_ok_json).is_none());
    }
}
