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

function queue25() {
  return {
    currently_playing: {
      id: "verify-current-0",
      name: "Now Spinning",
      artists: [{ name: "House Band" }],
      album: { name: "House", images: [] },
      duration_ms: 180000,
      uri: "spotify:track:verify-current-0",
      explicit: false,
    },
    queue: Array.from({ length: 25 }, (_, i) => ({
      id: `verify-long-${i + 1}`,
      name: `Long Queue ${i + 1}`,
      artists: [{ name: `Guest Artist ${i + 1}` }],
      album: { name: "Long Album", images: [] },
      duration_ms: 180000 + i * 1000,
      uri: `spotify:track:verify-long-${i + 1}`,
      explicit: false,
    })),
  };
}

test("25-item queue renders virtualized and scrolls to the last row", async ({ page }) => {
  await stubTauri(page, { fixtures: { queue: queue25() } });
  await page.goto("/");
  await page.getByTitle("Toggle Queue pane").click();
  const queue = page.locator('section[data-pane="queue"]');
  await expect(queue).toBeVisible();

  const list = queue.locator("ol.queue[data-virtualized='true']");
  await expect(list).toHaveAttribute("data-total", "25");
  await expect(queue).toContainText("Long Queue 1");

  // Windowing: fewer rows in the DOM than in the queue.
  const rendered = await queue.locator("ol.queue li.q").count();
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(25);

  // Scroll the windowed container: the tail materializes on demand.
  await queue.locator(".queue-scroll").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(queue).toContainText("Long Queue 25");
  await page.screenshot({ path: "verify/web/test-results/queue-virtualized.png" });
});

test("queue rows are buttons: Enter plays the focused row", async ({ page }) => {
  await page.getByTitle("Toggle Queue pane").click();
  const queue = page.locator('section[data-pane="queue"]');
  await expect(queue).toBeVisible();

  const row = queue.getByRole("button", { name: `Play ${QUEUE_NAMES[0]} by` });
  await expect(row).toBeVisible();
  await row.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await commandsNamed(page, "play_uris")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
  const calls = await commandsNamed(page, "play_uris");
  expect(JSON.stringify(calls[0])).toContain("verify-next-1");
});
