// Profile range switching (Batch 2): the Timeframe menu maps 4 weeks /
// 6 months / Lifetime to real Spotify time_range fetches (short_term /
// medium_term / long_term) while Today / Week / 2026 re-fetch long_term and
// slice the history store on the client with an honesty note. Rapid switches
// settle on the last pick (200 ms gen guard), throttles show a banner with
// Retry, and empty tops render honest empty states.
import { test, expect, type Page } from "@playwright/test";
import { stubTauri, commandsNamed, failNext } from "./tauri-mock";
import {
  PROFILE_LONG_TRACKS,
  PROFILE_ME_NAME,
  PROFILE_MEDIUM_TRACKS,
  PROFILE_SHORT_ALBUM,
  PROFILE_SHORT_TRACKS,
} from "./fixtures";

const PROFILE_LAYOUT = {
  version: 3,
  preset: "custom",
  panes: [
    { id: "profile", type: "profile", x: 24, y: 24, w: 460, h: 600, opacity: 0.92, visible: true, z: 1 },
  ],
};

async function bootProfile(page: Page, fixtures?: Record<string, unknown>) {
  await stubTauri(page, { layout: PROFILE_LAYOUT, edit: true, fixtures });
  await page.goto("/");
  const profile = page.locator('section[data-pane="profile"]');
  await expect(profile).toBeVisible();
  await expect(profile.locator(".detail-head .detail-title")).toContainText(PROFILE_ME_NAME);
  return profile;
}

function timeframe(profile: ReturnType<Page["locator"]>) {
  return profile.locator(".range-btn");
}

async function selectRange(profile: ReturnType<Page["locator"]>, value: string) {
  await profile.locator(".range-btn").click();
  await profile.locator(`[role="option"][data-value="${value}"]`).click();
}

async function topTimeRanges(page: Page): Promise<string[]> {
  const calls = await commandsNamed(page, "get_my_top");
  return calls.map((a) => String(a["timeRange"] ?? a["time_range"] ?? "null"));
}

test("4 weeks / 6 months / Lifetime request short / medium / long_term", async ({ page }) => {
  const profile = await bootProfile(page);
  const menu = timeframe(profile);
  await expect(menu).toContainText("4 weeks");

  const cases: Array<[string, string, string, string]> = [
    ["fourWeeks", "4 weeks", "short_term", PROFILE_SHORT_TRACKS[0]],
    ["sixMonths", "6 months", "medium_term", PROFILE_MEDIUM_TRACKS[0]],
    ["lifetime", "Lifetime", "long_term", PROFILE_LONG_TRACKS[0]],
  ];
  for (const [value, label, timeRange, track] of cases) {
    await selectRange(profile, value);
    await expect(menu).toContainText(label);
    // The 200 ms gen guard commits, then the three tops lists refetch.
    await expect
      .poll(async () => (await topTimeRanges(page)).join(","), { timeout: 10000 })
      .toContain(timeRange);
    await expect(profile).toContainText(track);
  }

  // Lifetime content is the long window, not the 4W window.
  await expect(profile).not.toContainText(PROFILE_SHORT_TRACKS[0]);
  expect(await page.evaluate(() => localStorage.getItem("snapify-profile-range"))).toBe("lifetime");
});

test("Today / Week / 2026 slice long_term on the client with an honesty note", async ({ page }) => {
  const profile = await bootProfile(page);

  await selectRange(profile, "today");
  await expect
    .poll(async () => (await topTimeRanges(page)).join(","), { timeout: 10000 })
    .toContain("long_term");
  await expect(
    profile.getByText("Sliced from long-term tops plus recent streams. Not a Spotify range."),
  ).toBeVisible();
  // Client filter: only today's stream survives.
  await expect(profile).toContainText("Today Spin");
  await expect(profile).not.toContainText("Ancient Spin");

  await selectRange(profile, "week");
  await expect(
    profile.getByText("Sliced from long-term tops plus recent streams. Not a Spotify range."),
  ).toBeVisible();
  await expect(profile).toContainText("Week Spin A");
  await expect(profile).toContainText("Week Spin B");
  await expect(profile).not.toContainText("Month Spin");

  await selectRange(profile, "year2026");
  await expect(
    profile.getByText("2026 slice of lifetime tops. Spotify has no year range."),
  ).toBeVisible();
  await expect(profile).toContainText("Valentine Spin");
  await expect(profile).not.toContainText("Ancient Spin");

  // Direct ranges owe no disclaimer.
  await selectRange(profile, "fourWeeks");
  await expect(profile.getByText("Not a Spotify range.")).toHaveCount(0);
  await expect(profile.getByText("Spotify has no year range.")).toHaveCount(0);
});

test("menu keyboard selects and closes", async ({ page }) => {
  const profile = await bootProfile(page);
  const btn = timeframe(profile);
  const box = profile.locator(".range-listbox");
  await expect(btn).toHaveAttribute("aria-haspopup", "listbox");
  await expect(box).toHaveAttribute("role", "listbox");
  expect(await profile.locator('[role="option"]').count()).toBe(6);

  await btn.focus();
  await page.keyboard.press("Enter");
  await expect(box).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(box).toBeHidden();

  await btn.click();
  await expect(box).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(box).toBeHidden();

  await btn.click();
  expect(await box.evaluate((el) => getComputedStyle(el).position)).toBe("absolute");
  expect(await box.evaluate((el) => getComputedStyle(el).maxHeight)).toBe("240px");
  await page.keyboard.press("Escape");
});

test("imported store names Extended history in the honesty note", async ({ page }) => {
  const profile = await bootProfile(page, { historyHasImported: true });
  await selectRange(profile, "today");
  await expect(profile.getByText(/Includes imported Extended history\./)).toBeVisible();
  await selectRange(profile, "fourWeeks");
  await expect(profile.getByText(/Includes imported Extended history\./)).toBeVisible();
});

test("rapid range switches settle on the last range (gen guard)", async ({ page }) => {
  const profile = await bootProfile(page);

  // Two quick menu picks: the guard must commit only the last one.
  await selectRange(profile, "fourWeeks");
  await selectRange(profile, "lifetime");
  await expect
    .poll(async () => (await topTimeRanges(page)).pop(), { timeout: 10000 })
    .toBe("long_term");
  await expect(profile).toContainText(PROFILE_LONG_TRACKS[0]);
  await expect(profile).not.toContainText(PROFILE_SHORT_TRACKS[0]);
  expect(await page.evaluate(() => localStorage.getItem("snapify-profile-range"))).toBe("lifetime");
});

test("throttled tops show banners with Retry and recover", async ({ page }) => {
  // Seed the pane hidden so the fault registers before the mount fetches.
  const hidden = {
    version: 3,
    preset: "custom",
    panes: [
      { id: "profile", type: "profile", x: 24, y: 24, w: 460, h: 600, opacity: 0.92, visible: false, z: 1 },
    ],
  };
  await stubTauri(page, { layout: hidden, edit: true });
  await page.goto("/");
  // All three tops lists (songs, artists, albums) hit the 429 on mount.
  await failNext(page, "get_my_top", "rate-limited: retry after 1s", 3);
  await page.getByTitle("Toggle Profile pane").click();
  const profile = page.locator('section[data-pane="profile"]');
  await expect(profile).toBeVisible();
  await expect(profile.locator(".detail-head .detail-title")).toContainText(PROFILE_ME_NAME);

  const banners = profile.locator(".throttled-note");
  await expect(banners.first()).toBeVisible({ timeout: 10000 });
  // Stale content stays: the header still renders from get_me.
  await expect(profile.locator(".detail-head .detail-title")).toContainText(PROFILE_ME_NAME);

  const before = (await commandsNamed(page, "get_my_top")).length;
  const retries = profile.getByRole("button", { name: "Retry", exact: true });
  const n = await retries.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    await retries.first().click();
  }
  await expect(banners).toHaveCount(0, { timeout: 10000 });
  // Full recovery across every section.
  await expect(profile).toContainText(PROFILE_SHORT_TRACKS[0]);
  await expect(profile).toContainText(PROFILE_SHORT_ALBUM);
  expect((await commandsNamed(page, "get_my_top")).length).toBeGreaterThan(before);
  await page.screenshot({ path: "verify/web/test-results/profile-throttled.png" });
});

test("empty tops and recents render honest empty states", async ({ page }) => {
  const emptyWindow = { artists: { items: [], total: 0 }, tracks: { items: [], total: 0 } };
  const profile = await bootProfile(page, {
    topShort: emptyWindow,
    topMedium: emptyWindow,
    topLong: emptyWindow,
    recentPlays: { items: [], total: 0 },
  });

  await expect(profile.getByText("No top songs", { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(profile.getByText("No top artists", { exact: true })).toBeVisible();
  await expect(profile.getByText("No top albums", { exact: true })).toBeVisible();
  await expect(profile.getByText("No recent streams", { exact: true })).toBeVisible();
  // The header still renders: only the lists are empty.
  await expect(profile.locator(".detail-head .detail-title")).toContainText(PROFILE_ME_NAME);
  await page.screenshot({ path: "verify/web/test-results/profile-empty.png" });
});
