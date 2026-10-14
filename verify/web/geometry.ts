// Shared positioning/geometry invariants for the overlay web harness.
//
// Three facts every pane-adjacent spec used to re-derive inline (paneBox,
// spill/reported-region polls, notch centering). Import from here so the
// tolerances live in one place; see features/web-harness.md.
import { expect, type Page } from "@playwright/test";
import { invokedCommands } from "./tauri-mock";

export interface StageBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Painted box of a pane, in stage pixels (rounded like the region reporter). */
export async function paneBox(page: Page, pane: string): Promise<StageBox> {
  return page.locator(`section[data-pane="${pane}"]`).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });
}

/** The whole pane box sits inside the viewport (boot clamp / roam invariant). */
export async function assertPaneWithinStage(
  page: Page,
  pane: string,
  eps = 1.5,
): Promise<StageBox> {
  const box = await paneBox(page, pane);
  const stage = await page.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  expect(box.x, `${pane} left edge within stage`).toBeGreaterThanOrEqual(-eps);
  expect(box.y, `${pane} top edge within stage`).toBeGreaterThanOrEqual(-eps);
  expect(box.x + box.w, `${pane} right edge within stage`).toBeLessThanOrEqual(
    stage.w + eps,
  );
  expect(box.y + box.h, `${pane} bottom edge within stage`).toBeLessThanOrEqual(
    stage.h + eps,
  );
  return box;
}

/** The autohide pill sits centered on the top edge (notch-centered invariant). */
export async function assertNotchCentered(page: Page, eps = 2): Promise<void> {
  const notch = page.locator(".notch");
  await expect(notch).toBeVisible();
  const box = await notch.boundingBox();
  if (!box) throw new Error("notch has no box");
  const stageW = await page.evaluate(() => window.innerWidth);
  const center = box.x + box.width / 2;
  expect(
    Math.abs(center - stageW / 2),
    `notch center ${center.toFixed(1)} vs stage center ${(stageW / 2).toFixed(1)}`,
  ).toBeLessThanOrEqual(eps);
}

export interface RegionTightOptions {
  /** Match slop per edge in stage pixels. Default 6 (region reporter rounds). */
  tolerance?: number;
  /** When set, the region height must only fit under the cap (header-only collapse). */
  maxH?: number;
  timeout?: number;
}

/**
 * The latest reported hit-region hugs the painted box. Mode flips ride the
 * atomic set_overlay_mode_with_regions invoke, debounced churn still uses
 * set_overlay_regions, so either path satisfies the invariant.
 */
export async function assertRegionTight(
  page: Page,
  box: StageBox,
  opts: RegionTightOptions = {},
): Promise<void> {
  const { tolerance = 6, maxH, timeout = 10000 } = opts;
  await expect
    .poll(
      async () => {
        const all = await invokedCommands(page);
        const reports = all.filter(
          (c) =>
            c.cmd === "set_overlay_regions" ||
            c.cmd === "set_overlay_mode_with_regions",
        );
        const latest = reports[reports.length - 1]?.args as unknown as
          | { regions?: Array<{ x: number; y: number; w: number; h: number }> }
          | undefined;
        const regs = latest?.regions ?? [];
        return regs.some(
          (r) =>
            Math.abs(r.x - box.x) <= tolerance &&
            Math.abs(r.y - box.y) <= tolerance &&
            Math.abs(r.w - box.w) <= tolerance &&
            (maxH === undefined
              ? Math.abs(r.h - box.h) <= tolerance
              : r.h <= maxH),
        );
      },
      { timeout },
    )
    .toBe(true);
}
