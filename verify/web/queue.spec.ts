import { test, expect } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";
import { QUEUE_NAMES } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await stubTauri(page);
  await page.goto("/");
});

test("upcoming rows render and refresh re-queries", async ({ page }) => {
  await page.getByTitle("Toggle Queue pane").click();
  const queue = page.locator('section[data-pane="queue"]');
  await expect(queue).toBeVisible();

  const before = (await commandsNamed(page, "get_queue")).length;
  await queue.getByRole("button", { name: "Refresh queue" }).click();

  const rows = queue.locator("ol.queue li.q");
  await expect(rows).toHaveCount(QUEUE_NAMES.length);
  for (const name of QUEUE_NAMES) {
    await expect(queue.locator("ol.queue")).toContainText(name);
  }

  const after = (await commandsNamed(page, "get_queue")).length;
  expect(after).toBeGreaterThan(before);
  await page.screenshot({ path: "verify/web/test-results/queue.png" });
});
