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

/** Painted box of the edit-mode dock pill in stage pixels, or null while
 *  the toolbar is collapsed behind the notch (autohide) or edit is off. */
export async function dockBox(page: Page): Promise<StageBox | null> {
  const box = await page.locator(".dock").boundingBox();
  if (!box) return null;
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    w: Math.round(box.width),
    h: Math.round(box.height),
  };
}

export const STADIUM_CLAMP_DIVISOR = 2;

/** Two painted boxes share no pixels (strict area overlap). */
export function boxesOverlap(
  a: StageBox,
  b: StageBox,
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
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

export interface MaximizedWindow {
  innerW: number;
  innerH: number;
  screenX: number;
  screenY: number;
  dpr: number;
  stageW: number;
  stageH: number;
  stageX: number;
  stageY: number;
}

/**
 * Window-level maximized invariant (1080p misplacement lock).
 *
 * In-window pane geometry is covered by assertPaneWithinStage; this asserts
 * the WINDOW itself: on a 1920x1080 display the overlay surface must sit at
 * the monitor origin (screenX/Y ~ 0) with the viewport filling the work
 * area (innerWidth/Height == expected) and the .stage covering it exactly
 * (no letterbox offset, no body scroll). In Playwright the viewport IS the
 * simulated maximized window, so a 1920x1080 viewport must report a full
 * 1920x1080 stage while a 1280x800 (restored-rect) viewport reports only
 * 1280x800 — the same layout strands in the smaller window, which is the
 * reported bug.
 */
export async function assertWindowFillsViewport(
  page: Page,
  vw: number,
  vh: number,
  eps = 1.5,
): Promise<MaximizedWindow> {
  const info = await page.evaluate(() => {
    const stage = document.querySelector(".stage");
    const r = stage?.getBoundingClientRect();
    return {
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      screenX: window.screenX,
      screenY: window.screenY,
      dpr: window.devicePixelRatio,
      stageW: r ? Math.round(r.width) : -1,
      stageH: r ? Math.round(r.height) : -1,
      stageX: r ? Math.round(r.left) : -9999,
      stageY: r ? Math.round(r.top) : -9999,
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
    };
  });
  expect(info.innerW, `window width fills ${vw}`).toBeGreaterThanOrEqual(vw - eps);
  expect(info.innerW, `window width fills ${vw}`).toBeLessThanOrEqual(vw + eps);
  expect(info.innerH, `window height fills ${vh}`).toBeGreaterThanOrEqual(vh - eps);
  expect(info.innerH, `window height fills ${vh}`).toBeLessThanOrEqual(vh + eps);
  expect(Math.abs(info.screenX), `window origin x ~ 0 (got ${info.screenX})`).toBeLessThanOrEqual(
    8,
  );
  expect(Math.abs(info.screenY), `window origin y ~ 0 (got ${info.screenY})`).toBeLessThanOrEqual(
    8,
  );
  expect(info.stageX, "stage starts at window left").toBeLessThanOrEqual(eps);
  expect(info.stageY, "stage starts at window top").toBeLessThanOrEqual(eps);
  expect(info.stageW, `stage covers window width ${vw}`).toBeGreaterThanOrEqual(vw - eps);
  expect(info.stageH, `stage covers window height ${vh}`).toBeGreaterThanOrEqual(vh - eps);
  expect(info.scrollW, "no horizontal body scroll").toBeLessThanOrEqual(vw + eps);
  expect(info.scrollH, "no vertical body scroll").toBeLessThanOrEqual(vh + eps);
  return {
    innerW: info.innerW,
    innerH: info.innerH,
    screenX: info.screenX,
    screenY: info.screenY,
    dpr: info.dpr,
    stageW: info.stageW,
    stageH: info.stageH,
    stageX: info.stageX,
    stageY: info.stageY,
  };
}
