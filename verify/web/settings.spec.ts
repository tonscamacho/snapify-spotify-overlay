import { test, expect } from "@playwright/test";
import { stubTauri } from "./tauri-mock";
import { APP_VERSION } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await stubTauri(page);
  await page.goto("/");
});

test("settings opens and shows the app version", async ({ page }) => {
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(APP_VERSION)).toBeVisible();
  await page.screenshot({ path: "verify/web/test-results/settings.png" });
});

test("theme toggle persists across reload", async ({ page }) => {
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();

  await dialog
    .getByRole("group", { name: "Theme" })
    .getByRole("button", { name: "light", exact: true })
    .click();

  await expect(page.locator(".app")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("snapify-theme"))).toBe("light");

  await page.reload();
  await expect(page.locator(".stage")).toBeVisible();
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "light");
});
