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
