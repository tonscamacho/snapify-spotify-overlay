// Resolution matrix for the window placement fix (2.10.0 follow-up):
// the maximized lock must sit well on other resolutions too, not just
// 1080p. Each arm reuses ./geometry helpers: the window itself fills the
// viewport (stage covers exactly, no body scroll), top chrome stays
// centered, the far-corner pane stays within the stage with tight regions,
// the uiScale clamp holds (no east overflow), and the dock stays single-row
// (or graceful wrap) with no pane/dock overlap.
//
// Seeds:
// - CORNER (1500,800 w340 h236): legal at 1920, off-stage at 1366/portrait
//   so the boot clamp must rescue it (the restored-rect half of the fix).
// - DOCK_PROBE (600,24 + 1500,24): the 1500,24 lyrics sits just right of the
//   1920 dock (legal) but under the live dock on wider/narrower stages, so
//   only a live-width dock clearance keeps no-overlap green.
// - STRAND (1440,24 w420 h560 profile): legal at k=1, strands east at
//   k=1.25 without the uiScale clamp.
//
// Screenshots: capped at 4 PNGs total in docs/bug-reports/2.10.0 (2 already
// there), so only 1366 laptop + 3440 ultrawide take new shots here.
import { test, expect, type Page } from "@playwright/test";
import { stubTauri, seedStorage } from "./tauri-mock";
import {
  assertNotchCentered,
  assertPaneWithinStage,
  assertRegionTight,
  assertWindowFillsViewport,
  boxesOverlap,
  dockBox,
  paneBox,
  type StageBox,
} from "./geometry";

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

// Dock stress: stale center (healed via the 1920 ref) plus a probe just
// right of the 1920 dock column (460..1460). On 1920 both clear; on any
// other width the probe lands under the live centered dock unless the boot
// path clears with the live width.
const DOCK_MATRIX_LAYOUT = {
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
    {
      id: "queue",
      type: "queue",
      x: 600,
      y: 24,
      w: 360,
      h: 230,
      opacity: 0.92,
      visible: true,
      z: 2,
    },
    {
      id: "lyrics",
      type: "lyrics",
      x: 1500,
      y: 24,
      w: 360,
      h: 230,
      opacity: 0.92,
      visible: true,
      z: 3,
    },
  ],
};

const STRAND_LAYOUT = {
  version: 3,
  preset: "custom",
  panes: [
    {
      id: "profile",
      type: "profile",
      x: 1440,
      y: 24,
      w: 420,
      h: 560,
      opacity: 0.92,
      visible: true,
      z: 1,
    },
  ],
};

async function dismissCoach(page: Page) {
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
}

/** Dock: single-row centered, or graceful wrap contained with no overlap. */
async function expectDockPlaced(page: Page, stageW: number): Promise<StageBox> {
  const dock = page.locator(".dock");
  await expect(dock).toBeVisible();
  const box = await dockBox(page);
  if (!box) throw new Error("dock has no box");
  expect(await dock.evaluate((el) => getComputedStyle(el).borderRadius)).toContain(
    "999px",
  );
  const center = box.x + box.w / 2;
  if (box.h <= 60) {
    expect(box.h, `dock single-row height (got ${box.h})`).toBeLessThanOrEqual(60);
    expect(
      Math.abs(center - stageW / 2),
      `dock center ${center.toFixed(1)} vs stage center ${(stageW / 2).toFixed(1)}`,
    ).toBeLessThanOrEqual(8);
  } else {
    // Graceful wrap (sub-desktop widths): contained, never overflowing.
    expect(box.x, "wrapped dock left within stage").toBeGreaterThanOrEqual(-1.5);
    expect(box.x + box.w, "wrapped dock right within stage").toBeLessThanOrEqual(
      stageW + 1.5,
    );
    expect(
      Math.abs(center - stageW / 2),
      `wrapped dock center ${center.toFixed(1)} vs ${(stageW / 2).toFixed(1)}`,
    ).toBeLessThanOrEqual(12);
  }
  return box;
}

async function expectNoPaneDockOverlap(
  page: Page,
  dock: StageBox,
  panes: string[],
) {
  for (const pane of panes) {
    const box = await paneBox(page, pane);
    expect(boxesOverlap(box, dock), `${pane} clears the painted dock`).toBe(false);
  }
}

interface MatrixArm {
  name: string;
  vw: number;
  vh: number;
  dpr?: number;
  screenshot?: string;
}

const ARMS: MatrixArm[] = [
  { name: "1366x768 laptop", vw: 1366, vh: 768, screenshot: "docs/bug-reports/2.10.0/window-1366x768-laptop.png" },
  { name: "1920x1080 @125% DPR", vw: 1920, vh: 1080, dpr: 1.25 },
  { name: "1920x1080 @150% DPR", vw: 1920, vh: 1080, dpr: 1.5 },
  { name: "2560x1440 QHD", vw: 2560, vh: 1440 },
  { name: "3840x2160 4K", vw: 3840, vh: 2160 },
  { name: "3440x1440 ultrawide", vw: 3440, vh: 1440, screenshot: "docs/bug-reports/2.10.0/window-3440x1440-ultrawide.png" },
  { name: "1080x1920 portrait", vw: 1080, vh: 1920 },
];

for (const arm of ARMS) {
  test.describe(`${arm.name} (${arm.vw}x${arm.vh}${arm.dpr ? ` dpr=${arm.dpr}` : ""})`, () => {
    test.use({
      viewport: { width: arm.vw, height: arm.vh },
      ...(arm.dpr ? { deviceScaleFactor: arm.dpr } : {}),
    });

    test("window fills, far-corner pane within stage, notch centered", async ({
      page,
    }) => {
      await stubTauri(page, {
        layout: CORNER_LAYOUT,
        edit: true,
        notchHover: true,
      });
      await page.goto("/");
      await dismissCoach(page);

      const win = await assertWindowFillsViewport(page, arm.vw, arm.vh);
      expect(win.dpr).toBeGreaterThan(0);
      if (arm.dpr) {
        expect(Math.abs(win.dpr - arm.dpr)).toBeLessThanOrEqual(0.01);
      }
      // Far-corner survives boot: clamped inside on small stages, untouched
      // on large ones, always with tight regions.
      const box = await assertPaneWithinStage(page, "player");
      await assertNotchCentered(page);
      await assertRegionTight(page, box, { tolerance: 2 });
    });

    test("dock single-row or graceful wrap, no pane/dock overlap", async ({
      page,
    }) => {
      await stubTauri(page, { layout: DOCK_MATRIX_LAYOUT, edit: true });
      await page.goto("/");
      await dismissCoach(page);

      await assertWindowFillsViewport(page, arm.vw, arm.vh);
      const dock = await expectDockPlaced(page, arm.vw);
      await expectNoPaneDockOverlap(page, dock, ["player", "queue", "lyrics"]);
      for (const pane of ["player", "queue", "lyrics"]) {
        const box = await assertPaneWithinStage(page, pane);
        await assertRegionTight(page, box, { tolerance: 2 });
      }
      await assertRegionTight(page, dock, { tolerance: 2 });

      if (arm.screenshot) {
        await page.screenshot({ path: arm.screenshot });
      }
    });

    test("uiScale 125% clamp holds with no east overflow", async ({ page }) => {
      await stubTauri(page, {
        layout: STRAND_LAYOUT,
        edit: true,
        notchHover: true,
      });
      await seedStorage(page, { "snapify-ui-scale": "1.25" });
      await page.goto("/");
      await dismissCoach(page);

      await assertWindowFillsViewport(page, arm.vw, arm.vh);
      const box = await assertPaneWithinStage(page, "profile");
      // No east overflow in painted pixels: logical right * k <= viewport.
      const paintedRight = await page
        .locator('section[data-pane="profile"]')
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          return Math.round(r.right);
        });
      // Painted (zoomed) pixels must stay inside the viewport: the uiScale
      // clamp keeps logical right <= vw/k so painted right <= vw.
      expect(paintedRight, "painted profile right within viewport").toBeLessThanOrEqual(
        arm.vw + 1.5,
      );
      expect(box.x + box.w, "painted profile right within stage").toBeLessThanOrEqual(
        arm.vw + 1.5,
      );
      await assertNotchCentered(page);
      await assertRegionTight(page, box, { tolerance: 2 });
    });
  });
}
