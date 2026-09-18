import { test, expect } from "@playwright/test";
import { stubTauri, commandsNamed, failNext } from "./tauri-mock";
import { QUEUE_NAMES, TRACK_NAME } from "./fixtures";

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

test("throttled write shows queued chip in queue and browse, then flushes once", async ({ page }) => {
  const queue = page.locator('section[data-pane="queue"]');
  if (!(await queue.isVisible())) {
    await page.getByTitle("Toggle Queue pane").click();
  }
  await expect(queue).toBeVisible();
  const browse = page.locator('section[data-pane="browse"]');
  if (!(await browse.isVisible())) {
    await page.getByTitle("Toggle Browse pane").click();
  }
  await expect(browse).toBeVisible();

  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();
  await player.getByRole("button", { name: "Pause", exact: true }).click();
  await expect
    .poll(async () => (await commandsNamed(page, "pause")).length, { timeout: 10000 })
    .toBeGreaterThan(0);

  await failNext(page, "play", "rate-limited: retry after 1s", 1);
  await player.getByRole("button", { name: "Play", exact: true }).click();

  // The global pending count surfaces in every pane that owns a chip.
  await expect(queue.getByText(/Queued/)).toBeVisible({ timeout: 10000 });
  await expect(browse.getByText(/Queued/)).toBeVisible({ timeout: 10000 });

  await expect
    .poll(async () => (await commandsNamed(page, "play")).length, { timeout: 10000 })
    .toBe(2);
  await expect(queue.getByText(/Queued/)).toHaveCount(0, { timeout: 10000 });
  await expect(browse.getByText(/Queued/)).toHaveCount(0, { timeout: 10000 });

  await page.waitForTimeout(1200);
  expect((await commandsNamed(page, "play")).length).toBe(2);
});
