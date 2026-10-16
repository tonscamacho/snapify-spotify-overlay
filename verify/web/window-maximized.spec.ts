// Window-level maximized lock (1080p misplacement report): prior fixes
// covered in-window pane geometry; this pins the WINDOW itself. On a
// 1920x1080 display the overlay surface must sit at the monitor origin with
// the viewport filling the work area — a window stuck in its restored
// 1280x800 rect misplaces the whole surface while every pane still renders.
//
// Playwright cannot move a real Tauri window, so the viewport IS the
// simulated window: 1920x1080 asserts the maximized fill (the AFTER state),
// 1280x800 documents the restored rect the bug left behind (the BEFORE
// state, same layout, visibly smaller surface). Screenshots land in
// docs/bug-reports/2.10.0/.
import { test, expect } from "@playwright/test";
import { stubTauri } from "./tauri-mock";
import {
  assertNotchCentered,
  assertPaneWithinStage,
  assertRegionTight,
  assertWindowFillsViewport,
  paneBox,
} from "./geometry";

// Far-corner layout: legal only when the window truly fills 1080p. In a
// restored 1280x800 window the boot clamp drags it on-screen (the frontend
// half); the window-size difference is the window-level signal.
const CORNER_LAYOUT = {
  version: 3,
  preset: "custom",
  panes: [
    {
      id: "player",
      type: "player",
      x: 1500,
      y: 800,
      w: 340,
      h: 236,
      opacity: 0.92,
      visible: true,
      z: 1,
    },
  ],
};

test.use({ viewport: { width: 1920, height: 1080 } });

test("maximized 1920x1080 window fills the work area, pane untouched", async ({
  page,
}) => {
  await stubTauri(page, { layout: CORNER_LAYOUT, edit: true, notchHover: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();

  // Window-level: the surface itself sits at the origin and fills 1080p.
  const win = await assertWindowFillsViewport(page, 1920, 1080);
  expect(win.dpr).toBeGreaterThan(0);

  // In-window: the far-corner pane survives boot untouched at full size.
  expect(await paneBox(page, "player")).toMatchObject({
    x: 1500,
    y: 800,
    w: 340,
  });
  const box = await assertPaneWithinStage(page, "player");
  await assertNotchCentered(page);
  await assertRegionTight(page, box, { tolerance: 2 });

  await page.screenshot({
    path: "docs/bug-reports/2.10.0/window-after-maximized-1920x1080.png",
  });
});

test.describe("restored-rect contrast", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("restored 1280x800 window is visibly smaller (the before state)", async ({
    page,
  }) => {
    await stubTauri(page, { layout: CORNER_LAYOUT, edit: true });
    await page.goto("/");
    await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();

    // The window itself is only 1280x800 here — same layout, smaller
    // surface. That size gap (640x280 of missing overlay) is the reported
    // "panes render but the whole window is misplaced" on a 1080p monitor.
    await assertWindowFillsViewport(page, 1280, 800);
    const box = await paneBox(page, "player");
    // The frontend boot clamp keeps the pane reachable, so it no longer
    // sits at the far corner: the rescue proves the window shrank.
    expect(box.x + box.w).toBeLessThanOrEqual(1281.5);
    expect(box.y + box.h).toBeLessThanOrEqual(801.5);

    await page.screenshot({
      path: "docs/bug-reports/2.10.0/window-before-restored-1280x800.png",
    });
  });
});
