import { test, expect } from "@playwright/test";
import { stubTauri } from "./tauri-mock";

const STRANDED = {
  version: 3,
  preset: "custom",
  panes: [
    {
      id: "player",
      type: "player",
      x: 1100,
      y: 600,
      w: 340,
      h: 236,
      opacity: 0.92,
      visible: true,
      z: 1,
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await stubTauri(page, { layout: STRANDED });
  await page.goto("/");
});

// Repro for panes stranded past the screen edge: the boot clamp used the
// pane-type minimum instead of the pane's own size, so anything wider than
// its minimum kept hanging off-screen after every launch.
test("boot pulls a stranded pane fully on-screen", async ({ page }) => {
  const pane = page.locator('section[data-pane="player"]');
  await expect(pane).toBeVisible();
  const box = await pane.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  expect(box.right).toBeLessThanOrEqual(1280);
  expect(box.bottom).toBeLessThanOrEqual(720);
  expect(box.left).toBe(940);
  expect(box.top).toBe(484);
});

test("dragged pane cannot leave the east edge", async ({ page }) => {
  await page.getByRole("button", { name: "Toggle edit lock" }).click();
  const pane = page.locator('section[data-pane="player"]');
  await expect(pane).toBeVisible();
  const handle = pane.locator(".pane-handle");
  const start = await handle.boundingBox();
  if (!start) throw new Error("pane handle has no box");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 1100, start.y + start.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        pane.evaluate((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.right;
        }),
      { timeout: 5000 },
    )
    .toBeLessThanOrEqual(1280);
});
