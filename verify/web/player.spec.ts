import { test, expect } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";
import { TRACK_NAME } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await stubTauri(page);
  await page.goto("/");
});

function toSeconds(text: string | null): number {
  const m = /(\d+):(\d{2})/.exec(text ?? "");
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]);
}

test("stage renders past the login gate with the playing track", async ({ page }) => {
  await expect(page.locator(".gate")).toHaveCount(0);
  await expect(page.locator(".stage")).toBeVisible();
  const player = page.locator('section[data-pane="player"]');
  await expect(player).toBeVisible();
  await expect(player.getByText(TRACK_NAME)).toBeVisible();
  await expect(player.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.screenshot({ path: "verify/web/test-results/player.png" });
});

test("pause then play invoke the matching commands", async ({ page }) => {
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();

  await player.getByRole("button", { name: "Pause", exact: true }).click();
  await expect
    .poll(async () => (await commandsNamed(page, "pause")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
  await expect(player.getByRole("button", { name: "Play", exact: true })).toBeVisible();

  await player.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(async () => (await commandsNamed(page, "play")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
});

test("next invokes next_track", async ({ page }) => {
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();

  await page.getByRole("button", { name: "Next track" }).click();
  await expect
    .poll(async () => (await commandsNamed(page, "next_track")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
});

test("progress advances while playing", async ({ page }) => {
  const elapsed = page.locator('section[data-pane="player"] .times span').first();
  await expect(elapsed).toBeVisible();
  const t1 = toSeconds(await elapsed.textContent());
  expect(t1).toBeGreaterThanOrEqual(0);
  await page.waitForTimeout(1800);
  const t2 = toSeconds(await elapsed.textContent());
  expect(t2).toBeGreaterThan(t1);
});
