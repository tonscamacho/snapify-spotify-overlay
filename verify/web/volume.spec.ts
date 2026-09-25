import { test, expect } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";
import { TRACK_NAME, DEVICE_ID } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await stubTauri(page);
  await page.goto("/");
});

// Repro for overlay playback blasting louder than the Spotify app: the
// headless SDK device kept a fixed local gain that the volume slider never
// touched, so only the server-side value moved while the room heard 80%.
test("volume slider drives the overlay device gain", async ({ page }) => {
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();

  // Arm the headless device first: any later slider move must reach the
  // local gain of the already-constructed player.
  await page.keyboard.press("p");
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const sdkRow = dialog.locator(".device-cell", { hasText: "Snapify Overlay" });
  await expect(sdkRow).toHaveCount(1, { timeout: 10000 });
  await dialog.getByRole("button", { name: "Close settings" }).click();
  await expect(dialog).toBeHidden();

  const vol = player.locator("input.vol");
  await vol.focus();
  await vol.press("Home");
  await expect(vol).toHaveAttribute("aria-valuetext", "0 percent");

  await expect
    .poll(
      async () =>
        (await commandsNamed(page, "set_volume")).some(
          (a) => a["volumePercent"] === 0 && a["deviceId"] === DEVICE_ID,
        ),
      { timeout: 10000 },
    )
    .toBe(true);

  const lastVol = await page.evaluate(
    () => (window as unknown as Record<string, unknown>)["__SDK_LAST_VOLUME__"],
  );
  expect(lastVol).toBe(0);
});
