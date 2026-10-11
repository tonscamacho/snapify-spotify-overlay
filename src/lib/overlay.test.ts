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
  it("mode flip forces an immediate regions invoke, mode first", async () => {
    const before = currentOverlayEpoch();
    await reportOverlayMode(true);

    expect(currentOverlayEpoch()).toBeGreaterThan(before);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[0][0]).toBe("set_overlay_mode");
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ interactive: true });
    // No 120 ms debounce gap: regions follow synchronously in the same flush.
    expect(invokeMock.mock.calls[1][0]).toBe("set_overlay_regions");
    expect(regionsOf(1)).toEqual([{ x: 10, y: 10, w: 200, h: 100, radius: 0 }]);
  });

  it("passive mode flip clears a stranded dragCover and reports tight", async () => {
    setOverlayDragCover(true);
    expect(isOverlayDragCover()).toBe(true);

    await reportOverlayMode(false);

    expect(isOverlayDragCover()).toBe(false);
    expect(invokeMock.mock.calls[0][0]).toBe("set_overlay_mode");
    expect(invokeMock.mock.calls[1][0]).toBe("set_overlay_regions");
    // Tight pane rect, not the fullscreen drag-cover payload.
    expect(regionsOf(1)).toEqual([{ x: 10, y: 10, w: 200, h: 100, radius: 0 }]);
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

  it("excludes the transparent notch-strip from OS hit-region selectors", async () => {
    const { seen } = installDom();
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
