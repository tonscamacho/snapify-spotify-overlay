import { test, expect } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";

test.beforeEach(async ({ page }) => {
  await stubTauri(page, { interact: true });
  await page.goto("/");
});

// Repro for: interactive mode pauses the game behind the overlay.
// Root cause: whole maximized window takes all mouse input, stealing
// focus from the game. Fixed shape: empty stage stays click-through
// (pointer-events none + regions reported), only panes/dock/modal take input.
test("interactive mode keeps empty stage click-through", async ({ page }) => {
  const stage = page.locator(".stage");
  await expect(stage).toBeVisible();

  // Stage itself must not capture: game below keeps input + focus.
  const stagePe = await stage.evaluate((el) => getComputedStyle(el).pointerEvents);
  expect(stagePe).toBe("none");

  // Panes stay interactive.
  const panePe = await page
    .locator('section[data-pane="player"]')
    .evaluate((el) => getComputedStyle(el).pointerEvents);
  expect(panePe).toBe("auto");

  // Frontend must report hit regions so Rust can keep empty pixels transparent.
  await expect
    .poll(async () => (await commandsNamed(page, "set_overlay_regions")).length, {
      timeout: 10000,
    })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await commandsNamed(page, "set_overlay_mode")).length, {
      timeout: 10000,
    })
    .toBeGreaterThan(0);
});
