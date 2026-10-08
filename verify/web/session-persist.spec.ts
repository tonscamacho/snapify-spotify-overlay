import { test, expect, type Page } from "@playwright/test";
import { stubTauri, commandsNamed, failNext } from "./tauri-mock";
import { TRACK_NAME } from "./fixtures";

const TRANSIENT_BOOT = "token refresh transient: accounts hiccup";
// Production InvalidGrant surface: Rust RefreshError::InvalidGrant reaches
// the UI through get_fresh_token as EXPIRED_MSG. The backend never emits a
// `refresh failed: {...}` string, so revoked cases fail get_fresh_token
// with EXPIRED_MSG instead of forging that legacy shape through get_player.
const EXPIRED_MSG = "Session expired. Please login again.";

async function bootWithFault(page: Page, cmd: string, message: string, times: number) {
  await stubTauri(page);
  await page.addInitScript(
    ({ cmd, message, times }: { cmd: string; message: string; times: number }) => {
      const w = window as unknown as {
        __MOCK_FAIL_NEXT__?: (cmd: string, error: string, times: number) => void;
      };
      w.__MOCK_FAIL_NEXT__?.(cmd, message, times);
    },
    { cmd, message, times },
  );
  await page.goto("/");
}

function emitAuthChanged(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as {
      __TAURI_EMIT_TO_APP__?: (event: string, payload: unknown) => void;
    };
    w.__TAURI_EMIT_TO_APP__?.("auth-changed", true);
  });
}

test("transient failure at boot keeps the session and recovers", async ({ page }) => {
  await bootWithFault(page, "get_fresh_token", TRANSIENT_BOOT, 1);

  await expect
    .poll(async () => (await commandsNamed(page, "get_fresh_token")).length, { timeout: 10000 })
    .toBeGreaterThanOrEqual(2);

  await expect(page.locator(".gate")).toHaveCount(0);
  await expect(page.locator(".stage")).toBeVisible();

  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".gate")).toHaveCount(0);
});

test("expired session at boot opens a clean login prompt", async ({ page }) => {
  await stubTauri(page);
  await page.addInitScript(
    ({ message }: { message: string }) => {
      const w = window as unknown as {
        __MOCK_FAIL_NEXT__?: (cmd: string, error: string, times: number) => void;
      };
      w.__MOCK_FAIL_NEXT__?.("get_fresh_token", message, 50);
    },
    { message: EXPIRED_MSG },
  );
  await page.goto("/");

  const gate = page.locator(".gate");
  await expect(gate).toBeVisible({ timeout: 10000 });
  await expect(gate.getByRole("button", { name: "Login with Spotify" })).toBeVisible();
  expect(await commandsNamed(page, "start_login")).toHaveLength(0);
});

test("revoked session at boot opens the login gate", async ({ page }) => {
  // A revoked refresh token is an InvalidGrant: the backend kills the
  // session and get_fresh_token rejects with the production EXPIRED_MSG.
  await bootWithFault(page, "get_fresh_token", EXPIRED_MSG, 50);

  const gate = page.locator(".gate");
  await expect(gate).toBeVisible({ timeout: 10000 });
  await expect(gate.getByRole("button", { name: "Login with Spotify" })).toBeVisible();
  expect(await commandsNamed(page, "start_login")).toHaveLength(0);
  // Even gated, the app consults credential_status (the backend clears the
  // dead credential from keyring + fallback file) without auto-login.
  await expect
    .poll(async () => (await commandsNamed(page, "credential_status")).length, { timeout: 10000 })
    .toBeGreaterThanOrEqual(1);
});

test("logged-out boot shows the gate without auto login", async ({ page }) => {
  await stubTauri(page, { authStatus: { logged_in: false, awaiting_callback: false } });
  await page.goto("/");

  const gate = page.locator(".gate");
  await expect(gate).toBeVisible({ timeout: 10000 });
  await expect(gate.getByRole("button", { name: "Login with Spotify" })).toBeVisible();
  expect(await commandsNamed(page, "start_login")).toHaveLength(0);
  expect(await commandsNamed(page, "get_fresh_token")).toHaveLength(0);
});

test("transient mid-run never opens the gate, revoked mid-run does", async ({ page }) => {
  await stubTauri(page);
  await page.goto("/");
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();

  const before = (await commandsNamed(page, "get_player")).length;
  await failNext(page, "get_player", TRANSIENT_BOOT, 50);
  await emitAuthChanged(page);
  await expect
    .poll(async () => (await commandsNamed(page, "get_player")).length, { timeout: 10000 })
    .toBeGreaterThan(before);
  await expect(page.locator(".gate")).toHaveCount(0);
  await expect(player.getByText(TRACK_NAME)).toBeVisible();

  await failNext(page, "get_fresh_token", EXPIRED_MSG, 50);
  await emitAuthChanged(page);
  const gate = page.locator(".gate");
  await expect(gate).toBeVisible({ timeout: 10000 });
  await expect(gate.getByRole("button", { name: "Login with Spotify" })).toBeVisible();
});

test("reload keeps the session without another login", async ({ page }) => {
  await stubTauri(page);
  await page.goto("/");
  await expect(page.locator('section[data-pane="player"]').getByText(TRACK_NAME)).toBeVisible();
  await expect(page.locator(".gate")).toHaveCount(0);

  await page.reload();
  await expect(page.locator('section[data-pane="player"]').getByText(TRACK_NAME)).toBeVisible();
  await expect(page.locator(".gate")).toHaveCount(0);
  expect(await commandsNamed(page, "start_login")).toHaveLength(0);
});

test("restart keeping disk relaunches without a login gate", async ({ page }) => {
  await stubTauri(page);
  await page.goto("/");
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();
  await expect(page.locator(".gate")).toHaveCount(0);
  expect(await commandsNamed(page, "get_fresh_token")).not.toHaveLength(0);

  // Quit keeping disk, relaunch: reload re-boots the app while the stored
  // credential survives (mock auth_status stays logged_in, like the
  // keyring/fallback pair surviving a process restart). The init script
  // re-runs on reload, so the command log below reflects the fresh boot.
  await page.reload();
  await expect(player.getByText(TRACK_NAME)).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".gate")).toHaveCount(0);
  expect(await commandsNamed(page, "get_fresh_token")).not.toHaveLength(0);
  expect(await commandsNamed(page, "start_login")).toHaveLength(0);
});

test("offline-then-online boot recovers without a gate", async ({ page }) => {
  // Locked keyring / no network at autostart: the first refreshes fail
  // transiently, then the network comes back. Boot backoff must ride
  // through (a 4th get_fresh_token attempt) instead of giving up after 3.
  await bootWithFault(page, "get_fresh_token", TRANSIENT_BOOT, 3);

  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".gate")).toHaveCount(0);
  expect(await commandsNamed(page, "get_fresh_token")).not.toHaveLength(0);
  expect((await commandsNamed(page, "get_fresh_token")).length).toBeGreaterThanOrEqual(4);
  expect(await commandsNamed(page, "start_login")).toHaveLength(0);
});
