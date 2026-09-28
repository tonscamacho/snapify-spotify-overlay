import { describe, expect, it } from "vitest";
import tauriConf from "../../src-tauri/tauri.conf.json";

// Window-chrome contract: the app is frameless transparent at all sizes.
// No native caption (minimize/maximize/close) may ever appear, so every
// declared window must stay borderless, see-through, and shadowless. The
// in-app dock exposes only its own Close button (see App.tsx); the OS
// frame stays off here.
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
  }
});
