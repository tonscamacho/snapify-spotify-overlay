import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));

import { invoke } from "@tauri-apps/api/core";
import {
  currentOverlayEpoch,
  isOverlayDragCover,
  reportOverlayMode,
  reportOverlayRegions,
  resetOverlayRegionDiff,
  setOverlayDragCover,
} from "./overlay";

const invokeMock = vi.mocked(invoke);

function fakeEl(rect: { left: number; top: number; width: number; height: number }) {
  return {
    isConnected: true,
    offsetParent: {},
    getBoundingClientRect: () => ({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON() {
        return {};
      },
    }),
  };
}

function installDom(opts: { paneRect?: { left: number; top: number; width: number; height: number } } = {}) {
  const seen: string[] = [];
  const paneRect = opts.paneRect ?? { left: 10, top: 10, width: 200, height: 100 };
  (globalThis as unknown as Record<string, unknown>).HTMLElement ??= class {};
  (globalThis as unknown as Record<string, unknown>).getComputedStyle = () => ({
    display: "block",
    visibility: "visible",
    position: "absolute",
    borderTopLeftRadius: "0px",
    borderTopRightRadius: "0px",
    borderBottomRightRadius: "0px",
    borderBottomLeftRadius: "0px",
  });
  (globalThis as unknown as Record<string, unknown>).window = {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    screenX: 0,
    screenY: 0,
  };
  const querySelectorAll = vi.fn((sel: string) => {
    seen.push(sel);
    if (sel === "section.pane") return [fakeEl(paneRect)];
    return [];
  });
  (globalThis as unknown as Record<string, unknown>).document = { querySelectorAll };
  return { seen, querySelectorAll };
}

function regionsOf(callIndex: number): Array<{ x: number; y: number; w: number; h: number }> {
  const call = invokeMock.mock.calls[callIndex];
  expect(call).toBeDefined();
  return (call[1] as { regions: Array<{ x: number; y: number; w: number; h: number }> }).regions;
}

beforeEach(() => {
  resetOverlayRegionDiff();
  setOverlayDragCover(false);
  invokeMock.mockClear();
  installDom();
});

describe("overlay mode+regions sequencing (window-controls spill fix)", () => {
  it("mode flip is a single atomic invoke with mode+regions together", async () => {
    const before = currentOverlayEpoch();
    await reportOverlayMode(true);

    expect(currentOverlayEpoch()).toBeGreaterThan(before);
    // Root fix: no interim set_overlay_mode with stale regions. One invoke
    // carries both so Rust stores+applies under one lock.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe("set_overlay_mode_with_regions");
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ interactive: true });
    expect(regionsOf(0)).toEqual([{ x: 10, y: 10, w: 200, h: 100, radius: 0 }]);
    // DPR + origin ride the atomic payload for the Rust signature.
    expect(invokeMock.mock.calls[0][1]).toMatchObject({
      devicePixelRatio: 1,
      monitorOrigin: { x: 0, y: 0 },
    });
  });

  it("passive mode flip clears a stranded dragCover and reports tight", async () => {
    setOverlayDragCover(true);
    expect(isOverlayDragCover()).toBe(true);

    await reportOverlayMode(false);

    expect(isOverlayDragCover()).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe("set_overlay_mode_with_regions");
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ interactive: false });
    // Tight pane rect, not the fullscreen drag-cover payload.
    expect(regionsOf(0)).toEqual([{ x: 10, y: 10, w: 200, h: 100, radius: 0 }]);
  });

  it("atomic flush suppresses the trailing debounced duplicate", async () => {
    await reportOverlayMode(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    invokeMock.mockClear();
    // Same rects right after the atomic flush diff-skips: no second OS apply.
    await reportOverlayRegions();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("dragCover release re-tightens to per-pane rects", async () => {
    setOverlayDragCover(true);
    await reportOverlayRegions();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(regionsOf(0)).toEqual([{ x: 0, y: 0, w: 1280, h: 800, radius: 0 }]);

    invokeMock.mockClear();
    setOverlayDragCover(false);
    await reportOverlayRegions();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe("set_overlay_regions");
    expect(regionsOf(0)).toEqual([{ x: 10, y: 10, w: 200, h: 100, radius: 0 }]);
  });

  it("excludes the transparent notch-strip from OS hit-region selectors", async () => {    const { seen } = installDom();
    invokeMock.mockClear();
    resetOverlayRegionDiff();
    await reportOverlayRegions();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((s) => s.includes("notch-strip"))).toBe(false);
    // Interactive affordances that must stay clickable keep reporting.
    const joined = seen.join(" ");
    for (const keep of ["section.pane", ".dock", ".modal", ".toast", ".hint-chip"]) {
      expect(joined).toContain(keep);
    }
  });
});

describe("tall pane single rect (profile contract)", () => {
  it("reports one region for a tall profile-height pane, not a split", async () => {
    // The profile pane runs tall (header + tiles + genres + grids + clocks +
    // recents in one scrollport). The reporter must emit exactly one rect so
    // the OS shape matches the painted box with no seams.
    installDom({ paneRect: { left: 24, top: 24, width: 420, height: 900 } });
    resetOverlayRegionDiff();
    invokeMock.mockClear();
    await reportOverlayRegions();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe("set_overlay_regions");
    expect(regionsOf(0)).toEqual([{ x: 24, y: 24, w: 420, h: 900, radius: 0 }]);
  });

  it("keeps the single rect after a same-shape duplicate report", async () => {
    installDom({ paneRect: { left: 24, top: 24, width: 420, height: 900 } });
    resetOverlayRegionDiff();
    invokeMock.mockClear();
    await reportOverlayRegions();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    // Unchanged rects diff-skip: no second OS apply.
    await reportOverlayRegions();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
