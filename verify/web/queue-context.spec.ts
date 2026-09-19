import { test, expect } from "@playwright/test";
import { stubTauri } from "./tauri-mock";
import { buildFixtures } from "./fixtures";

test("queue shows its playlist context and opens it in browse", async ({ page }) => {
  const seed = buildFixtures();
  await stubTauri(page, {
    fixtures: {
      queue: {
        ...(seed.queue as Record<string, unknown>),
        context: { type: "playlist", uri: "spotify:playlist:pl-verify-1" },
      },
    },
  });
  await page.goto("/");

  await page.getByTitle("Toggle Queue pane").click();
  const queue = page.locator('section[data-pane="queue"]');
  await expect(queue).toBeVisible();

  const context = queue.getByRole("button", { name: "Open Verify Jams" });
  await expect(context).toBeVisible();
  await expect(context).toContainText("Next from:");
  await expect(context).toContainText("Verify Jams");

  await context.click();
  const browse = page.locator('section[data-pane="browse"]');
  await expect(browse).toBeVisible();
  await expect(browse.locator(".detail-title")).toContainText("Verify Jams");
  await page.screenshot({ path: "verify/web/test-results/queue-context.png" });
});

test("queue context opens from the keyboard without losing Next-from", async ({ page }) => {
  const seed = buildFixtures();
  await stubTauri(page, {
    fixtures: {
      queue: {
        ...(seed.queue as Record<string, unknown>),
        context: { type: "playlist", uri: "spotify:playlist:pl-verify-1" },
      },
    },
  });
  await page.goto("/");

  await page.getByTitle("Toggle Queue pane").click();
  const queue = page.locator('section[data-pane="queue"]');
  await expect(queue).toBeVisible();

  const context = queue.getByRole("button", { name: "Open Verify Jams" });
  await context.focus();
  await page.keyboard.press("Enter");
  const browse = page.locator('section[data-pane="browse"]');
  await expect(browse).toBeVisible();
  await expect(browse.locator(".detail-title")).toContainText("Verify Jams");
});
