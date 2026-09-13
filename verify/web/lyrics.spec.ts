import { test, expect } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";
import { ACTIVE_CUE_T, ACTIVE_LINE } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await stubTauri(page);
  await page.goto("/");
});

test("synced lines render with an active highlight", async ({ page }) => {
  const lyrics = page.locator('section[data-pane="lyrics"]');
  await expect(lyrics).toBeVisible();

  const lines = lyrics.locator("button.line");
  await expect(lines.first()).toBeVisible();
  expect(await lines.count()).toBeGreaterThanOrEqual(4);

  const active = lyrics.locator("button.line.on");
  await expect(active).toHaveAttribute("aria-current", "true");
  await expect(active).toContainText(ACTIVE_LINE);
  await page.screenshot({ path: "verify/web/test-results/lyrics.png" });
});

test("clicking the active line seeks to its cue", async ({ page }) => {
  const active = page.locator('section[data-pane="lyrics"] button.line.on');
  await expect(active).toBeVisible();
  await active.click();

  await expect
    .poll(
      async () =>
        (await commandsNamed(page, "seek")).map(
          (a) => (a["positionMs"] ?? a["position_ms"]) as number,
        ),
      { timeout: 10000 },
    )
    .toContain(ACTIVE_CUE_T);
});
