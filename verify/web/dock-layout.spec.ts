// Desktop positioning repro: the edit-mode dock wrapped to a 760x78
// two-row pill at 1920x1080 (15 children under a 760 px cap), and stale
// custom docs reloaded with panes sitting under the toolbar band.
// Locks, via the shared ./geometry helpers: the pill stays a single row
// (h <= 60) centered within ±8 px, every healed pane clears the painted
// dock, healed geometry persists, and the dock hit-region hugs the new
// box — at 1920x1080, 1366x768, and k=1.25.
import { test, expect, type Page } from "@playwright/test";
import { stubTauri, seedStorage } from "./tauri-mock";
import {
  assertPaneWithinStage,
  assertRegionTight,
  boxesOverlap,
  dockBox,
  paneBox,
  type StageBox,
} from "./geometry";

// Stale custom persisted under the old two-row pill: both panes start in
// the dock band and overlap each other, so boot must clear the dock row
// (y -> 96) and de-overlap pane-to-pane (shift, never resize).
const STALE_LAYOUT = {
  version: 3,
  preset: "custom",
  panes: [
    {
      id: "player",
      type: "player",
      x: 600,
      y: 24,
      w: 360,
      h: 230,
      opacity: 0.92,
      visible: true,
      z: 1,
    },
    {
      id: "queue",
      type: "queue",
      x: 700,
      y: 30,
      w: 360,
      h: 236,
      opacity: 0.92,
      visible: true,
      z: 2,
    },
  ],
};

async function dismissCoach(page: Page) {
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
}

/** Single-row pill, stadium radii, centered on the stage. */
async function expectDockSingleRow(page: Page, stageW: number): Promise<StageBox> {
  const dock = page.locator(".dock");
  await expect(dock).toBeVisible();
  const box = await dockBox(page);
  if (!box) throw new Error("dock has no box");
  expect(box.h, `dock single-row height (got ${box.h})`).toBeLessThanOrEqual(60);
  // The widened cap keeps the r999 pill contract and the graceful wrap
  // fallback for sub-desktop widths.
  expect(await dock.evaluate((el) => getComputedStyle(el).borderRadius)).toContain(
    "999px",
  );
  expect(await dock.evaluate((el) => getComputedStyle(el).flexWrap)).toBe("wrap");
  const center = box.x + box.w / 2;
  expect(
    Math.abs(center - stageW / 2),
    `dock center ${center.toFixed(1)} vs stage center ${(stageW / 2).toFixed(1)}`,
  ).toBeLessThanOrEqual(8);
  return box;
}

async function expectNoPaneDockOverlap(
  page: Page,
  dock: StageBox,
  panes: string[],
): Promise<void> {
  for (const pane of panes) {
    const box = await paneBox(page, pane);
    expect(boxesOverlap(box, dock), `${pane} clears the painted dock`).toBe(false);
  }
}

async function expectHealPersisted(page: Page): Promise<void> {
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem("snapify-layout-v3")!) as {
      scenes: Record<string, { panes: Array<{ type: string; y: number; w: number }> }>;
      activeScene: string;
    },
  );
  const panes = saved.scenes[saved.activeScene].panes;
  expect(panes.find((p) => p.type === "player")).toMatchObject({ y: 96, w: 360 });
  const queue = panes.find((p) => p.type === "queue");
  if (!queue) throw new Error("healed queue missing from storage");
  // Queue clears the dock row and the player: strictly below y=96+230.
  expect(queue.y).toBeGreaterThan(96 + 230);
  expect(queue.w).toBe(360);
}

test.use({ viewport: { width: 1920, height: 1080 } });

test("stale custom heals below a single-row dock at 1920x1080", async ({
  page,
}) => {
  await stubTauri(page, { layout: STALE_LAYOUT, edit: true });
  await page.goto("/");
  await dismissCoach(page);

  const dock = await expectDockSingleRow(page, 1920);
  // Load-time heal, painted 1:1 at k=1.
  expect(await paneBox(page, "player")).toMatchObject({ x: 600, y: 96, w: 360 });
  await expectNoPaneDockOverlap(page, dock, ["player", "queue"]);
  await assertPaneWithinStage(page, "player");
  await assertPaneWithinStage(page, "queue");
  // Region contract: the dock region hugs the new (wider, single-row) box.
  await assertRegionTight(page, dock, { tolerance: 2 });
  await expectHealPersisted(page);
});

test.describe("1366x768 stage", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test("stale custom heals below a single-row dock at 1366x768", async ({
    page,
  }) => {
    await stubTauri(page, { layout: STALE_LAYOUT, edit: true });
    await page.goto("/");
    await dismissCoach(page);

    const dock = await expectDockSingleRow(page, 1366);
    await expectNoPaneDockOverlap(page, dock, ["player", "queue"]);
    await assertPaneWithinStage(page, "player");
    await assertPaneWithinStage(page, "queue");
    await assertRegionTight(page, dock, { tolerance: 2 });
    await expectHealPersisted(page);
  });
});

test.describe("125% UI scale", () => {
  test("stale custom heals clear of the dock at k=1.25", async ({ page }) => {
    await stubTauri(page, { layout: STALE_LAYOUT, edit: true });
    await seedStorage(page, { "snapify-ui-scale": "1.25" });
    await page.goto("/");
    await dismissCoach(page);

    // The dock lives outside the zoom wrapper: CSS pixels, still centered.
    const dock = await expectDockSingleRow(page, 1920);
    await expectNoPaneDockOverlap(page, dock, ["player", "queue"]);
    await assertPaneWithinStage(page, "player");
    await assertPaneWithinStage(page, "queue");
    await assertRegionTight(page, dock, { tolerance: 2 });
  });
});
