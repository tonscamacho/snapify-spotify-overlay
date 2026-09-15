import { test, expect, type Page } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";

test.beforeEach(async ({ page }) => {
  await stubTauri(page);
  await page.goto("/");
});

function emitSdkError(page: Page, payload: string) {
  return page.evaluate((msg: string) => {
    const w = window as unknown as {
      __TAURI_EMIT_TO_APP__?: (event: string, payload: unknown) => void;
    };
    w.__TAURI_EMIT_TO_APP__?.("sdk-error", msg);
  }, payload);
}

test("invalid token scopes toast offers reconnect and re-logs in", async ({ page }) => {
  await emitSdkError(
    page,
    'Player auth failed (token refreshed silently): {"message":"Invalid token scopes."}',
  );

  const toast = page.locator(".toasts .toast-error");
  await expect(toast).toContainText("new permissions");
  const reconnect = toast.getByRole("button", { name: "Reconnect" });
  await expect(reconnect).toBeVisible();

  await reconnect.click();
  await expect
    .poll(async () => (await commandsNamed(page, "start_login")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
});

test("other sdk errors keep the plain toast without reconnect", async ({ page }) => {
  await emitSdkError(page, "Snapify Overlay device went offline.");

  const toast = page.locator(".toasts .toast-error");
  await expect(toast).toContainText("went offline");
  await expect(toast.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
});
