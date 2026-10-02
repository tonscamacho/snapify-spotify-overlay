import { test, expect, type Page } from "@playwright/test";
import { stubTauri } from "./tauri-mock";

test.beforeEach(async ({ page }) => {
  await stubTauri(page);
  await page.goto("/");
});

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("overlay color picker renders after Surface/Corners at theme default", async ({
  page,
}) => {
  const dialog = await openSettings(page);

  const color = dialog.getByLabel("Overlay color", { exact: true });
  const hex = dialog.getByLabel("Overlay color hex");
  const overlayRow = dialog.locator(".row", { hasText: "Overlay color" });
  const reset = overlayRow.getByRole("button", { name: "Reset", exact: true });
  await expect(color).toBeVisible();
  await expect(hex).toBeVisible();
  await expect(reset).toBeVisible();
  await expect(reset).toBeDisabled();

  // Row order: Overlay color sits after Surface/Corners, before Preset.
  const labels = await dialog.locator(".row > span:first-child").allTextContents();
  const at = (name: string) => labels.findIndex((t) => t.trim() === name);
  expect(at("Surface")).toBeGreaterThanOrEqual(0);
  expect(at("Corners")).toBeGreaterThanOrEqual(0);
  expect(at("Overlay color")).toBeGreaterThan(at("Corners"));
  expect(at("Preset")).toBeGreaterThan(at("Overlay color"));

  // Theme default: no override attr, swatch shows the dark default.
  await expect(page.locator(".app")).not.toHaveAttribute("data-overlay-color", "custom");
  await expect(color).toHaveValue("#17171a");
  await page.screenshot({ path: "docs/bug-reports/2.5.4/color-picker.png" });
});

test("picker sets var, persists, and reload restores", async ({ page }) => {
  const dialog = await openSettings(page);
  const hex = dialog.getByLabel("Overlay color hex");

  await hex.fill("#1e6ff2");
  await hex.press("Enter");

  const app = page.locator(".app");
  await expect(app).toHaveAttribute("data-overlay-color", "custom");
  expect(await app.evaluate((el) => el.style.getPropertyValue("--overlay"))).toBe("#1e6ff2");
  expect(await page.evaluate(() => localStorage.getItem("snapify-overlay-color"))).toBe(
    "#1e6ff2",
  );

  // The player pane paints the custom color (solid surface).
  const paneBg = await page
    .locator('section[data-pane="player"]')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(paneBg).toBe("rgb(30, 111, 242)");
  await page.screenshot({ path: "docs/bug-reports/2.5.4/color-custom.png" });

  await page.reload();
  await expect(page.locator(".stage")).toBeVisible();
  await expect(page.locator(".app")).toHaveAttribute("data-overlay-color", "custom");
  expect(await page.evaluate(() => localStorage.getItem("snapify-overlay-color"))).toBe(
    "#1e6ff2",
  );

  await openSettings(page);
  await expect(page.getByLabel("Overlay color hex")).toHaveValue("#1e6ff2");
});

test("invalid values coerce to theme default", async ({ page }) => {
  // Stored garbage falls back to the theme (no override attr).
  await page.evaluate(() => localStorage.setItem("snapify-overlay-color", "banana"));
  await page.reload();
  await expect(page.locator(".stage")).toBeVisible();
  await expect(page.locator(".app")).not.toHaveAttribute("data-overlay-color", "custom");

  const dialog = await openSettings(page);
  const hex = dialog.getByLabel("Overlay color hex");

  // Typed garbage commits back to the default (key removed, no attr).
  await hex.fill("not-a-color");
  await hex.press("Enter");
  await expect(page.locator(".app")).not.toHaveAttribute("data-overlay-color", "custom");
  expect(await page.evaluate(() => localStorage.getItem("snapify-overlay-color"))).toBeNull();

  // Shorthand expands and normalizes.
  await hex.fill("#f00");
  await hex.press("Enter");
  await expect(page.locator(".app")).toHaveAttribute("data-overlay-color", "custom");
  expect(await page.evaluate(() => localStorage.getItem("snapify-overlay-color"))).toBe(
    "#ff0000",
  );
});

test("reset returns to the theme default", async ({ page }) => {
  const dialog = await openSettings(page);
  const hex = dialog.getByLabel("Overlay color hex");
  const reset = dialog
    .locator(".row", { hasText: "Overlay color" })
    .getByRole("button", { name: "Reset", exact: true });

  await hex.fill("#1e6ff2");
  await hex.press("Enter");
  await expect(page.locator(".app")).toHaveAttribute("data-overlay-color", "custom");
  await expect(reset).toBeEnabled();

  await reset.click();
  await expect(page.locator(".app")).not.toHaveAttribute("data-overlay-color", "custom");
  expect(await page.evaluate(() => localStorage.getItem("snapify-overlay-color"))).toBeNull();
  await expect(reset).toBeDisabled();
  await expect(dialog.getByLabel("Overlay color", { exact: true })).toHaveValue("#17171a");
});

test("custom color stays coherent on pastel, sparkles, and glass", async ({ page }) => {
  const dialog = await openSettings(page);

  await dialog
    .getByRole("group", { name: "Theme" })
    .getByRole("button", { name: "pastel", exact: true })
    .click();
  const hex = dialog.getByLabel("Overlay color hex");
  await hex.fill("#1e6ff2");
  await hex.press("Enter");

  // Pastel candy washes yield to the custom color.
  const player = page.locator('section[data-pane="player"]');
  expect(await player.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    "rgb(30, 111, 242)",
  );
  await page.screenshot({ path: "docs/bug-reports/2.5.4/color-pastel.png" });

  // Sparkles starfield yields too (no layered star gradients).
  await dialog
    .getByRole("group", { name: "Theme" })
    .getByRole("button", { name: "sparkles", exact: true })
    .click();
  expect(await player.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    "rgb(30, 111, 242)",
  );
  expect(await player.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe("none");
  await page.screenshot({ path: "docs/bug-reports/2.5.4/color-sparkles.png" });

  // Glass stays translucent in the custom tint, never opaque.
  await dialog
    .getByRole("group", { name: "Surface" })
    .getByRole("button", { name: "glass", exact: true })
    .click();
  const glassBg = await player.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(glassBg).toContain("30, 111, 242");
  expect(glassBg).toContain("0.42");
});
