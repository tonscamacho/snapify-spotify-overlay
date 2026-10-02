import { describe, expect, it } from "vitest";
import tauriConf from "../../src-tauri/tauri.conf.json";

// Window-chrome contract: the app is frameless transparent at all sizes.
// No native caption (minimize/maximize/close) may ever appear, so every
// declared window must stay borderless, see-through, and shadowless. The
// in-app dock exposes only its own Close button (see App.tsx); the OS
// frame stays off here.
//
// Forensics note (fix/tauri-frame-2.5.1, tao 0.35.3 / wry 0.55.1 /
// tauri 2.11.5): `GetWindowLong(GWL_STYLE)` on the live window ALWAYS
// reports WS_CAPTION|WS_THICKFRAME|WS_SYSMENU|WS_MIN/MAXBOX with WS_POPUP
// clear (e.g. 0x34CF0000 windowed, 0x15CF0000 maximized) even with
// `decorations:false`. That is tao's borderless mechanism, not a bug:
// `to_window_styles` keeps the bits and hides the frame via
// `WM_NCCALCSIZE -> 0`, so the client fills the whole window (measured:
// 1280x800 client == 1280x800 window; maximized caption height 0) and no
// caption/title/buttons ever paint. Do NOT "fix" the bits with
// SetWindowLong: tao's apply_diff rewrites GWL_STYLE from its internal
// flags on every show/hide, always-on-top, and cursor-mode change (the
// login flow alone reverts it within seconds), so surgery only buys
// flicker. Likewise keep `maximized:true`: un-maximizing at creation
// leaves the bits identical (0x14CF0000 measured) while adding boot flash.
//
// Live verdict (fix/window-controls-2.5.4, fresh cargo build of 2.5.3,
// HWND CLASS=Tauri Window TITLE=Snapify - Spotify Overlay):
// - Premise census. P1 (2.5.0) assumed the halo was a rectangular OS
//   region around rounded pills (fixed: round-rect + painted radii).
//   P2 (2.5.1) assumed WS_CAPTION bits paint a real caption (disproved:
//   tao hides the frame via WM_NCCALCSIZE, client == window). P3 (2.5.3)
//   assumed Resized could strand a stale region (fixed: Resized/Moved/
//   ScaleFactorChanged re-apply). P4 assumed the user photo shows the
//   overlay's OWN caption buttons. Live evidence kills P4: windowed
//   0x14CF0000 (1280x800 client == 1280x800 window), maximized 0x15CF0000
//   (1920x1032 client inside a -8,-8 overscan frame, caption height 0),
//   iconic 0x34CF0000 at boot. GetWindowRgn returns SIMPLEREGION with a
//   single gate-card rect (240x268, re-centered 520,266 -> 848,390 on
//   maximize: the 2.5.3 Resized arm works). A maximized CopyFromScreen
//   capture looks straight THROUGH the overlay to the browser behind
//   (its tabs and min/max/close) while the overlay paints only the gate.
//   The photo's buttons are the behind-window seen through transparency,
//   not overlay chrome, so no config/style surgery ships: it would only
//   revert (tao rewrites GWL_STYLE on every state transition, observed
//   0x34 -> 0x15 -> 0x14 across iconic/maximize/restore) or shrink
//   coverage. Evidence: docs/bug-reports/2.5.4/chrome-*.png.
// - Harness artifact (not shipped behavior): a standalone `cargo build`
//   debug exe run WITHOUT `tauri dev` (stale dist, no dev server) shows
//   WebView2's localhost-refused error page and self-minimizes within
//   seconds. Under `tauri dev` the same binary never self-minimizes.
//   The shipped artifact is the `tauri build` bundle, so no fix here.
describe("window chrome (frameless transparent)", () => {
  const windows = (tauriConf as { app: { windows: Array<Record<string, unknown>> } }).app.windows;

  it("declares at least one window", () => {
    expect(windows.length).toBeGreaterThan(0);
  });

  for (const w of windows) {
    it(`window "${String(w["label"] ?? "?")}" stays frameless transparent`, () => {
      expect(w["transparent"]).toBe(true);
      expect(w["decorations"]).toBe(false);
      expect(w["shadow"]).toBe(false);
    });

    it(`window "${String(w["label"] ?? "?")}" stays a maximized fullscreen-surface`, () => {
      // The click-through surface must cover the screen from creation:
      // region coords and frame_offset assume a maximized window.
      expect(w["maximized"]).toBe(true);
      expect(w["fullscreen"]).toBe(false);
    });
  }
});
