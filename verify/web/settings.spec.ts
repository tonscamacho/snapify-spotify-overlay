import { test, expect, type Page } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";
import { APP_VERSION, TRACK_PROGRESS_MS, TRACK_URI } from "./fixtures";

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

test("media keybinds list as global; focused chords state the focus need", async ({ page }) => {
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  const keys = dialog.locator(".keys");

  for (const label of [
    "Mute / Unmute",
    "Like / Unlike track",
    "Seek back 10 seconds",
    "Seek forward 10 seconds",
  ]) {
    const row = keys.locator("div", { hasText: label }).first();
    await expect(row).toContainText("global");
  }
  await expect(keys.getByText("Cycle preset (needs overlay focus)")).toBeVisible();
  await expect(keys.getByText("Interact toggle, legacy (needs overlay focus)")).toBeVisible();
  await expect(keys.getByText("focused").first()).toBeVisible();
});

test("Shift+Tab row carries the re-entry warning", async ({ page }) => {
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();

  await expect(dialog.getByText("re-entry", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/strand you in pass-through/)).toBeVisible();
});

function emitShortcut(page: Page, event: string) {
  return page.evaluate((name: string) => {
    const w = window as unknown as {
      __TAURI_EMIT_TO_APP__?: (event: string, payload: unknown) => void;
    };
    w.__TAURI_EMIT_TO_APP__?.(name, null);
  }, event);
}

// Shortcut listeners register in a mount effect; the first player poll
// resolving proves boot finished, so one-shot emits never fire into the void.
async function emitWhenReady(page: Page, event: string) {
  await expect
    .poll(async () => (await commandsNamed(page, "get_player")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
  await emitShortcut(page, event);
}

test("mute chord toggles volume to zero and back", async ({ page }) => {
  await emitWhenReady(page, "shortcut-mute");
  await expect
    .poll(async () => (await commandsNamed(page, "set_volume")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
  let calls = await commandsNamed(page, "set_volume");
  expect(calls[calls.length - 1].volumePercent).toBe(0);

  await emitShortcut(page, "shortcut-mute");
  await expect
    .poll(async () => (await commandsNamed(page, "set_volume")).length, { timeout: 10000 })
    .toBeGreaterThan(1);
  calls = await commandsNamed(page, "set_volume");
  expect(calls[calls.length - 1].volumePercent).toBe(80);
});

test("seek chords jump ±10s from the live position", async ({ page }) => {
  await emitWhenReady(page, "shortcut-seek-back");
  await expect
    .poll(async () => (await commandsNamed(page, "seek")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
  let calls = await commandsNamed(page, "seek");
  const back = calls[calls.length - 1].positionMs as number;
  expect(back).toBeGreaterThan(TRACK_PROGRESS_MS - 11000);
  expect(back).toBeLessThan(TRACK_PROGRESS_MS - 9000);

  await emitShortcut(page, "shortcut-seek-forward");
  await expect
    .poll(async () => (await commandsNamed(page, "seek")).length, { timeout: 10000 })
    .toBeGreaterThan(1);
  calls = await commandsNamed(page, "seek");
  const fwd = calls[calls.length - 1].positionMs as number;
  expect(fwd).toBeGreaterThan(back);
});

test("like chord removes the saved track and toasts", async ({ page }) => {
  // The mock reports every URI as saved, so the toggle removes.
  await emitWhenReady(page, "shortcut-like");
  await expect
    .poll(async () => (await commandsNamed(page, "library_remove")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
  const calls = await commandsNamed(page, "library_remove");
  expect(calls[calls.length - 1].uris).toEqual([TRACK_URI]);
  await expect(page.locator(".toasts").getByText("Removed from Liked Songs")).toBeVisible();
});
