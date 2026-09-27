import { test, expect } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";
import { TRACK_NAME } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await stubTauri(page);
  await page.goto("/");
});

// R1 no-autosteal at the web boundary: arming the headless SDK while
// another device is playing must register the overlay row WITHOUT moving
// sound. Unit cover lives in src/lib/devices.test.ts (shouldRegisterOverlayDevice)
// + src/lib/player-sdk.test.ts (ready guard); this proves the guard runs in
// the app instead of the SDK never booting.
test("arming the overlay never steals playback while another device plays", async ({
  page,
}) => {
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();

  // First user gesture arms ensurePlayer (autoplay policy). The fixture
  // session is playing on Verify Speaker, so the ready handler must skip
  // the transfer_playback claim. Bare "p" matches no global chord; it only
  // feeds the arm-on-keydown listener.
  await page.keyboard.press("p");

  // The overlay row appearing proves SDK ready fired and the app registered
  // the device id — the guard ran, not that the SDK never booted.
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const panel = dialog.getByRole("group", { name: "Playback device" });
  await expect(panel.getByRole("button", { name: "Snapify Overlay" })).toBeVisible({
    timeout: 10000,
  });
  // The guard consulted the cloud session before deciding.
  await expect
    .poll(async () => (await commandsNamed(page, "get_player")).length, { timeout: 10000 })
    .toBeGreaterThan(0);

  // Settle: any trailing claim would have fired by now. Sound stays where
  // it was — zero transfers.
  await page.waitForTimeout(1500);
  expect(await commandsNamed(page, "transfer_playback")).toHaveLength(0);

  await dialog.getByRole("button", { name: "Close settings" }).click();
  await expect(dialog).toBeHidden();
});

// Volume parity: the same percent must sound the same as the Spotify apps.
// The slider commits the raw percent to the cloud API while the local SDK
// gain takes the curved value (percent/100)^2. Unit cover lives in
// src/lib/player-sdk.test.ts (percentToSdkGain + end-to-end fractional
// drive); this drives the real slider end to end.
test("volume 50 percent drives curved SDK gain with matching API percent", async ({
  page,
}) => {
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();

  // Arm the headless device first so the slider move reaches a live player.
  await page.keyboard.press("p");
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.locator(".device-cell", { hasText: "Snapify Overlay" })).toHaveCount(1, {
    timeout: 10000,
  });
  await dialog.getByRole("button", { name: "Close settings" }).click();
  await expect(dialog).toBeHidden();

  // Commit exactly 50 through the real input path (input event stages the
  // local value, keyup commits it like a keyboard user).
  const vol = player.locator("input.vol");
  await vol.evaluate((el: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, "50");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await vol.dispatchEvent("keyup");
  await expect(vol).toHaveAttribute("aria-valuetext", "50 percent");

  // Cloud side: the raw percent travels to the API untouched.
  await expect
    .poll(
      async () =>
        (await commandsNamed(page, "set_volume")).some((a) => a["volumePercent"] === 50),
      { timeout: 10000 },
    )
    .toBe(true);

  // Room side: the SDK gain takes the native taper, 0.5^2 = 0.25 — not the
  // old linear 0.5 that sounded twice as loud as the Spotify app.
  const lastVol = await page.evaluate(
    () => (window as unknown as Record<string, unknown>)["__SDK_LAST_VOLUME__"],
  );
  expect(lastVol).toBeCloseTo(0.25, 10);
  await page.screenshot({ path: "verify/web/test-results/device-volume-parity.png" });
});
