// Profile pane (Batch 2c): section[data-pane="profile"] shows the signed-in
// user header, the Timeframe select, stats tiles, the genre strip, the
// listening clocks, and the tops + recents grids from the get_me +
// get_my_top + get_recently_played fixtures. The mock branches get_my_top on
// the timeRange arg (short_term -> 4W window, medium_term -> 6M,
// long_term/null -> lifetime) and returns [{ track, played_at }] recents.
import { test, expect, type Page } from "@playwright/test";
import { stubTauri, invokedCommands, commandsNamed } from "./tauri-mock";
import {
  PROFILE_LONG_ARTISTS,
  PROFILE_ME_NAME,
  PROFILE_SHORT_ALBUM,
  PROFILE_SHORT_ARTISTS,
  PROFILE_SHORT_TRACKS,
} from "./fixtures";

const PROFILE_LAYOUT = {
  version: 3,
  preset: "custom",
  panes: [
    { id: "profile", type: "profile", x: 24, y: 24, w: 420, h: 560, opacity: 0.92, visible: true, z: 1 },
    { id: "player", type: "player", x: 456, y: 24, w: 340, h: 230, opacity: 0.92, visible: true, z: 2 },
  ],
};

async function bootProfile(page: Page, fixtures?: Record<string, unknown>) {
  await stubTauri(page, { layout: PROFILE_LAYOUT, edit: true, fixtures });
  await page.goto("/");
  const profile = page.locator('section[data-pane="profile"]');
  await expect(profile).toBeVisible();
  return profile;
}

async function paneBox(page: Page, pane: string) {
  return page.locator(`section[data-pane="${pane}"]`).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  });
}

test("chip toggle hides and shows the profile pane", async ({ page }) => {
  await bootProfile(page);
  const chip = page.getByTitle("Toggle Profile pane");
  const profile = page.locator('section[data-pane="profile"]');

  await chip.click();
  await expect(profile).toHaveCount(0);
  await expect(chip).toHaveAttribute("aria-pressed", "false");

  await chip.click();
  await expect(profile).toBeVisible();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
});

test("header, timeframe, tiles, genres, clocks, and grids render", async ({ page }) => {
  const profile = await bootProfile(page);

  // Header from get_me.
  await expect(profile.locator(".detail-head .detail-title")).toContainText(PROFILE_ME_NAME);

  // Timeframe select defaults to the stored range (4 weeks fresh).
  const timeframe = profile.getByLabel("Timeframe");
  await expect(timeframe).toBeVisible();
  await expect(timeframe).toHaveValue("fourWeeks");

  // Stats tiles: the default 4W slice keeps the 4 recent streams inside 28d
  // (Today + Week A/B + Month = 200+180+210+240s = 830000ms -> 14 minutes,
  // 4 tracks, 4 artists, top genre indie).
  const stats = profile.getByText("Stats", { exact: true });
  await expect(stats).toBeVisible();
  await expect(profile).toContainText("4 streams");
  for (const label of ["Streams", "Minutes", "Tracks", "Artists", "Top genre", "Peak hour"]) {
    await expect(profile.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(profile.getByText("14", { exact: true }).first()).toBeVisible();
  await expect(profile.getByText("indie", { exact: true }).first()).toBeVisible();

  // Genre strip derives from the short_term artists window.
  await expect(profile.getByText("Top genres", { exact: true })).toBeVisible();
  await expect(profile.getByText("indie · 2").first()).toBeVisible();

  // Listening clocks: one AM dial + one PM dial, totals sum to the slice.
  await expect(profile.getByText("Listening clocks", { exact: true })).toBeVisible();
  const dials = profile.getByRole("img", { name: /listening clock/ });
  await expect(dials).toHaveCount(2);
  const labels = await dials.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
  expect(labels.some((l) => l.startsWith("AM listening clock"))).toBe(true);
  expect(labels.some((l) => l.startsWith("PM listening clock"))).toBe(true);
  const total = labels.reduce((n, l) => n + Number(/(\d+) streams?/.exec(l)?.[1] ?? 0), 0);
  expect(total).toBe(4);

  // Grids: default range fetches short_term, so tops come from the 4W window.
  await expect(profile.getByText("Top songs", { exact: true })).toBeVisible();
  for (const name of PROFILE_SHORT_TRACKS) {
    await expect(profile).toContainText(name);
  }
  await expect(profile.getByText("Top artists", { exact: true })).toBeVisible();
  for (const name of PROFILE_SHORT_ARTISTS) {
    await expect(profile).toContainText(name);
  }
  await expect(profile.getByText("Top albums · from top songs", { exact: true })).toBeVisible();
  await expect(profile).toContainText(PROFILE_SHORT_ALBUM);
  await expect(profile.getByText("Recent streams", { exact: true })).toBeVisible();
  await expect(profile).toContainText("Today Spin");

  // Two tops kinds fetched with the 4W time_range, plus the recents page.
  await expect
    .poll(async () => (await commandsNamed(page, "get_my_top")).length, { timeout: 10000 })
    .toBeGreaterThanOrEqual(2);
  const tops = await commandsNamed(page, "get_my_top");
  expect(tops.map((a) => String(a["kind"]))).toEqual(
    expect.arrayContaining(["artists", "tracks"]),
  );
  for (const args of tops) {
    expect(String(args["timeRange"])).toBe("short_term");
  }
  await expect
    .poll(async () => (await commandsNamed(page, "get_recently_played")).length, { timeout: 10000 })
    .toBeGreaterThanOrEqual(1);
  expect(PROFILE_LONG_ARTISTS.length).toBeGreaterThan(0);
  await page.screenshot({ path: "verify/web/test-results/profile-pane.png" });
});

test("toggle off/on restores the exact profile geometry", async ({ page }) => {
  await bootProfile(page);
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
  const before = await paneBox(page, "profile");
  expect(before).toEqual({ x: 24, y: 24, w: 420, h: 560 });

  const chip = page.getByTitle("Toggle Profile pane");
  await chip.click();
  await expect(page.locator('section[data-pane="profile"]')).toHaveCount(0);
  await chip.click();
  await expect(page.locator('section[data-pane="profile"]')).toBeVisible();
  expect(await paneBox(page, "profile")).toEqual(before);

  // The toggle persisted as custom, not as a factory preset.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("snapify-layout-v3")!));
  expect(saved.version).toBe(4);
  expect(saved.scenes[saved.activeScene].preset).toBe("custom");
  expect(saved.scenes[saved.activeScene].panes.find((p: { type: string }) => p.type === "profile")).toMatchObject(before);
});

test("reload keeps the persisted profile geometry", async ({ page }) => {
  await bootProfile(page);
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();

  // Hide the player so there is a post-seed mutation to survive reload.
  await page.getByTitle("Toggle Player pane").click();
  await expect(page.locator('section[data-pane="player"]')).toHaveCount(0);
  const saved = await page.evaluate(() => localStorage.getItem("snapify-layout-v3"));

  await stubTauri(page, { layout: JSON.parse(saved!) });
  await page.reload();
  expect(await paneBox(page, "profile")).toEqual({ x: 24, y: 24, w: 420, h: 560 });
  await expect(page.locator('section[data-pane="player"]')).toHaveCount(0);
});

test("collapse is header-only and the OS region tightens to the header", async ({ page }) => {
  const profile = await bootProfile(page);
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();

  await profile.getByRole("button", { name: "Collapse Profile pane" }).click();
  await expect(profile).toHaveAttribute("data-collapsed", "true");
  expect(
    await profile.locator(".pane-body").evaluate((el) => getComputedStyle(el).display),
  ).toBe("none");
  await expect
    .poll(async () => (await paneBox(page, "profile")).h, { timeout: 5000 })
    .toBeLessThanOrEqual(48);
  const collapsed = await paneBox(page, "profile");

  // The collapse path flushes regions post-paint without waiting for the
  // 120 ms debounce; mode flips ride the atomic invoke instead. Accept
  // either path so the spec locks behavior, not the invoke name.
  await expect
    .poll(
      async () => {
        const all = await invokedCommands(page);
        const reports = all.filter(
          (c) => c.cmd === "set_overlay_regions" || c.cmd === "set_overlay_mode_with_regions",
        );
        const latest = reports[reports.length - 1]?.args as unknown as
          | { regions: Array<{ x: number; y: number; w: number; h: number }> }
          | undefined;
        const regs = latest?.regions ?? [];
        return regs.some(
          (r) =>
            Math.abs(r.x - collapsed.x) <= 6 &&
            Math.abs(r.y - collapsed.y) <= 6 &&
            r.h <= 64,
        );
      },
      { timeout: 10000 },
    )
    .toBe(true);

  // Expand restores the full pane.
  await profile.getByRole("button", { name: "Expand Profile pane" }).click();
  await expect(profile).not.toHaveAttribute("data-collapsed", "true");
  expect(await paneBox(page, "profile")).toEqual({ x: 24, y: 24, w: 420, h: 560 });
  await expect(profile.locator(".detail-head .detail-title")).toContainText(PROFILE_ME_NAME);
});
