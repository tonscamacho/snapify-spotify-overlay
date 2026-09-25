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

test("lyrics display rows render with current values", async ({ page }) => {
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  const size = dialog.getByRole("slider", { name: "Lyrics text size" });
  await expect(size).toBeVisible();
  await expect(size).toHaveValue("100");
  await expect(
    dialog.getByRole("checkbox", { name: "Dyslexia-friendly lyrics" }),
  ).toBeVisible();
});

test("lyrics display prefs persist across reload", async ({ page }) => {
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();

  const size = dialog.getByRole("slider", { name: "Lyrics text size" });
  await size.evaluate((el: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, "115");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await dialog.getByRole("checkbox", { name: "Dyslexia-friendly lyrics" }).check();

  expect(await page.evaluate(() => localStorage.getItem("snapify-lyric-scale"))).toBe("1.15");
  expect(await page.evaluate(() => localStorage.getItem("snapify-dyslexia"))).toBe("1");

  await page.reload();
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog2 = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog2.getByRole("slider", { name: "Lyrics text size" })).toHaveValue("115");
  await expect(
    dialog2.getByRole("checkbox", { name: "Dyslexia-friendly lyrics" }),
  ).toBeChecked();
  await expect(
    page.locator('section[data-pane="lyrics"] .lyrics.lyrics-dyslexia'),
  ).toBeVisible();
});

test("spotify usage row shows request counts from the log", async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__?: {
        invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
      __INVOKED__?: Array<{ cmd: string; args: Record<string, unknown> }>;
    };
    const internals = w.__TAURI_INTERNALS__;
    if (!internals) return;
    const orig = internals.invoke.bind(internals);
    internals.invoke = (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "request_log_counts" || cmd === "request_log_recent") {
        w.__INVOKED__?.push({ cmd, args: args ?? {} });
        if (cmd === "request_log_counts") {
          return Promise.resolve({
            total: 14,
            ok: 12,
            rate_limited: 1,
            quota_exceeded: 1,
            unauthorized: 0,
            other: 0,
          });
        }
        return Promise.resolve([
          { method: "GET", path: "/me/player", result: "429-rate", retry_after: 3 },
        ]);
      }
      return orig(cmd, args);
    };
  });
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Spotify usage")).toBeVisible();
  await expect(
    dialog.getByText("14 total · 12 ok · 1 on cooldown · 1 quota cooldown"),
  ).toBeVisible();
  await expect(dialog.getByText(/cooling down rather than failing/)).toBeVisible();
  await expect(dialog.getByText(/GET \/me\/player/)).toBeVisible();
  await expect
    .poll(async () => (await commandsNamed(page, "request_log_counts")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
});

test("playback device section lists, transfers, and remembers", async ({ page }) => {
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const panel = dialog.getByRole("group", { name: "Playback device" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Sound plays on:");
  await expect(panel).toContainText("Verify Speaker");
  await expect(panel.getByRole("button", { name: "Play here via this overlay" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Keep playback there" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Refresh devices" })).toBeVisible();
  await page.screenshot({ path: "verify/web/test-results/settings-device.png" });

  // Selecting the listed device and keeping there transfers to it.
  await panel.locator(".device-cell", { hasText: "Verify Speaker" }).click();
  await panel.getByRole("button", { name: "Keep playback there" }).click();
  await expect
    .poll(async () => (await commandsNamed(page, "transfer_playback")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => localStorage.getItem("snapify-device-choice"))).toContain(
    "dev-verify-1",
  );

  await page.reload();
  await page.getByRole("button", { name: "Open settings" }).click();
  const panel2 = page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("group", { name: "Playback device" });
  await expect(panel2).toContainText("remembered");
});

test("lyrics cache row shows size and clears through", async ({ page }) => {
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Lyrics cache: 3 tracks, 4 KB")).toBeVisible();
  await expect
    .poll(async () => (await commandsNamed(page, "lyrics_cache_size")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
  await dialog.getByRole("button", { name: "Clear", exact: true }).click();
  await expect
    .poll(async () => (await commandsNamed(page, "clear_lyrics_cache")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
  await expect(dialog.getByText("Lyrics cache: 0 tracks, 0 KB")).toBeVisible();
});
