import { test, expect } from "@playwright/test";
import { stubTauri } from "./tauri-mock";
import { MINIMAL_LAYOUT } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await stubTauri(page, { layout: MINIMAL_LAYOUT });
  await page.goto("/");
});

test("cycle preset swaps the visible pane set", async ({ page }) => {
  await expect(page.locator('section[data-pane="player"]')).toBeVisible();
  await expect(page.locator('section[data-pane="queue"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Cycle preset" }).click();

  await expect(page.locator('section[data-pane="player"]')).toBeVisible();
  await expect(page.locator('section[data-pane="queue"]')).toBeVisible();
  await page.screenshot({ path: "verify/web/test-results/layout.png" });
});

test("pane toggle hides and shows the queue pane", async ({ page }) => {
  const chip = page.getByTitle("Toggle Queue pane");
  const queue = page.locator('section[data-pane="queue"]');

  await chip.click();
  await expect(queue).toBeVisible();
  await expect(chip).toHaveAttribute("aria-pressed", "true");

  await chip.click();
  await expect(queue).toHaveCount(0);
  await expect(chip).toHaveAttribute("aria-pressed", "false");
});
