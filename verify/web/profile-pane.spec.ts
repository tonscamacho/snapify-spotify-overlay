// Profile pane (Batch 2): section[data-pane="profile"] shows the signed-in
// user header, the Timeframe range menu, stats tiles, the genre strip, the
// listening clocks, and the tops + recents grids from the get_me +
// get_my_top + get_recently_played fixtures. The mock branches get_my_top on
// the timeRange arg (short_term -> 4W window, medium_term -> 6M,
// long_term/null -> lifetime) and returns [{ track, played_at }] recents.
import { test, expect, type Page } from "@playwright/test";
import { stubTauri, invokedCommands, commandsNamed, mockHistoryFile } from "./tauri-mock";
import {
  PROFILE_LONG_ARTISTS,
  PROFILE_ME_NAME,
  PROFILE_SHORT_ALBUM,
  PROFILE_SHORT_ARTISTS,
  PROFILE_SHORT_TRACKS,
} from "./fixtures";

// Live-width dock clearance (resolution matrix): at the default 1280x720
// harness viewport the live dock is 140..1140, so a y24 seed sits under it
// (the old 1920-ref 460..1460 left 24..444 just clear by 16px). Seed below
// the band (y96) so boot is idempotent and no pane/dock overlap is possible.
const PROFILE_LAYOUT = {
  version: 3,
  preset: "custom",
  panes: [
    { id: "profile", type: "profile", x: 24, y: 96, w: 420, h: 560, opacity: 0.92, visible: true, z: 1 },
    { id: "player", type: "player", x: 456, y: 96, w: 340, h: 230, opacity: 0.92, visible: true, z: 2 },
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

async function selectRangeMenu(profile: ReturnType<Page["locator"]>, value: string) {
  await profile.locator(".range-btn").click();
  await profile.locator(`[role="option"][data-value="${value}"]`).click();
}

/** Real-hover a clock wedge at its geometric midpoint (a thin wedge's
 *  box center can fall off the sliver). Centers the chart first so pane
 *  chrome never covers the point. */
async function hoverClockWedge(
  page: Page,
  profile: ReturnType<Page["locator"]>,
  clock: "streams" | "minutes",
  hour: string,
) {
  const chart = profile.locator(`[data-clock="${clock}"]`);
  await chart.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const pt = await chart.locator(`[data-hour="${hour}"]`).evaluate((el) => {
    const path = el as unknown as SVGPathElement;
    const svg = path.ownerSVGElement;
    if (!svg) throw new Error("wedge has no svg");
    const rect = svg.getBoundingClientRect();
    const h = Number(path.getAttribute("data-hour") ?? "0");
    const mid = ((-90 + (h + 0.5) * 15) * Math.PI) / 180;
    // Every wedge spans radially from the R_IN hole (30) outward, so the
    // baseline mid-ring (31) is always on the fill, however thin.
    const rr = 31;
    const scale = rect.width / 200;
    return {
      x: rect.x + (100 + rr * Math.cos(mid)) * scale,
      y: rect.y + (100 + rr * Math.sin(mid)) * scale,
    };
  });
  await page.mouse.move(pt.x, pt.y);
  return chart;
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

  // Timeframe menu defaults to the stored range (4 weeks fresh).
  await expect(profile.locator("#profile-range-label")).toContainText("Timeframe");
  const timeframe = profile.locator(".range-btn");
  await expect(timeframe).toBeVisible();
  await expect(timeframe).toContainText("4 weeks");
  await expect(timeframe).toHaveAttribute("aria-haspopup", "listbox");
  await expect(profile.locator(".range-menu")).toBeVisible();
  await expect(profile.locator(".range-listbox")).toHaveAttribute("role", "listbox");
  expect(await profile.locator('[role="option"]').count()).toBe(6);

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

  // Genre strip follows the slice's most-streamed artists: Short Band One
  // and Short Band Two each stream once in the 4W window, so indie weighs 1.
  await expect(profile.getByText("Top genres", { exact: true })).toBeVisible();
  await expect(profile.getByText("indie · 1").first()).toBeVisible();

  // Listening clocks: two 24-wedge radial coxcombs (streams + minutes
  // streamed) sharing the slice buckets; each wedge carries its tooltip.
  await expect(profile.getByText("Listening clocks", { exact: true })).toBeVisible();
  await expect(profile.locator('[data-clock="streams"] [data-hour]')).toHaveCount(24);
  await expect(profile.locator('[data-clock="minutes"] [data-hour]')).toHaveCount(24);
  await expect(profile.getByText("streams", { exact: true })).toBeVisible();
  await expect(profile.getByText("minutes streamed", { exact: true })).toBeVisible();
  const streamsAria = profile.locator('[data-clock="streams"]');
  await expect(streamsAria.locator("svg")).toHaveAttribute(
    "aria-label",
    /streams listening clock: 4 streams/,
  );
  // Hovering an hour wedge surfaces its tooltip copy (midpoint hover:
  // a thin wedge's box center can fall off the sliver).
  const streamsClock = await hoverClockWedge(page, profile, "streams", "0");
  await expect(streamsClock.locator(".cox-tip")).toContainText(
    /00:00 - 01:00: \d[\d,]* streams?/,
  );
  const minutesClock = await hoverClockWedge(page, profile, "minutes", "0");
  await expect(minutesClock.locator(".cox-tip")).toContainText(
    /00:00 - 01:00: \d[\d,]* minutes?/,
  );

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
  // History flag loads once on mount; the poll sync appends the live track.
  await expect
    .poll(async () => (await commandsNamed(page, "get_history_stats")).length, { timeout: 10000 })
    .toBeGreaterThanOrEqual(1);
  expect(PROFILE_LONG_ARTISTS.length).toBeGreaterThan(0);
  await page.screenshot({ path: "verify/web/test-results/profile-pane.png" });
});

test("range menu opens, selects, and respects keyboard", async ({ page }) => {
  const profile = await bootProfile(page);
  await expect(profile.locator("#profile-range-label")).toContainText("Timeframe");
  const btn = profile.locator(".range-btn");
  const box = profile.locator(".range-listbox");
  await expect(btn).toHaveAttribute("aria-haspopup", "listbox");
  await expect(box).toHaveAttribute("role", "listbox");
  expect(await profile.locator('[role="option"]').count()).toBe(6);

  // Mouse: open and pick Today.
  await btn.click();
  await expect(box).toBeVisible();
  await profile.locator('[role="option"][data-value="today"]').click();
  await expect(btn).toContainText("Today");
  await expect(
    profile.getByText("Sliced from long-term tops plus recent streams. Not a Spotify range."),
  ).toBeVisible();

  // Keyboard: focus, Enter opens, Arrows move, Enter selects, Esc closes.
  await btn.focus();
  await page.keyboard.press("Enter");
  await expect(box).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(box).toBeHidden();
  // Esc closes an open menu.
  await btn.click();
  await expect(box).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(box).toBeHidden();

  // Listbox floats with a capped height.
  await btn.click();
  expect(await box.evaluate((el) => getComputedStyle(el).position)).toBe("absolute");
  expect(await box.evaluate((el) => getComputedStyle(el).maxHeight)).toBe("240px");
  await page.keyboard.press("Escape");

  expect(await profile.evaluate((el) => getComputedStyle(el).backgroundClip)).toBe("padding-box");
});

test("history import shows counts and names imports in the honesty note", async ({ page }) => {
  const profile = await bootProfile(page);
  await expect(profile.locator(".detail-head .detail-title")).toContainText(PROFILE_ME_NAME);

  const rows = JSON.stringify([
    {
      ts: new Date(Date.now() - 3600000).toISOString(),
      ms_played: 200000,
      master_metadata_track_name: "Import Spin",
      master_metadata_album_artist_name: "Import Band",
      spotify_track_uri: "spotify:track:import-1",
      reason_end: "trackdone",
      skipped: false,
    },
    {
      ts: new Date(Date.now() - 7200000).toISOString(),
      ms_played: 10000,
      master_metadata_track_name: "Short Skip",
      master_metadata_album_artist_name: "Import Band",
      spotify_track_uri: "spotify:track:import-short",
      reason_end: "trackdone",
      skipped: false,
    },
  ]);
  await mockHistoryFile(page, "endsong_0.json", rows);
  await profile.getByRole("button", { name: "Import history" }).click();
  await expect(profile.getByText(/Imported 1 of 2/, { exact: false })).toBeVisible({ timeout: 10000 });
  await expect(profile.getByText(/1 short/, { exact: false })).toBeVisible();
  const imports = await commandsNamed(page, "import_history");
  expect(imports.length).toBeGreaterThanOrEqual(1);

  // The honesty note now names the import on a sliced range.
  await selectRangeMenu(profile, "today");
  await expect(profile.getByText(/Includes imported Extended history\./)).toBeVisible();
});

test("player poll syncs history with idempotent appends", async ({ page }) => {
  await bootProfile(page);
  await expect
    .poll(async () => (await commandsNamed(page, "append_listen_cmd")).length, { timeout: 15000 })
    .toBeGreaterThanOrEqual(1);
  const calls = await commandsNamed(page, "append_listen_cmd");
  const first = calls[0]?.["play"] as Record<string, unknown> | undefined;
  expect(typeof first?.["uri"]).toBe("string");
  expect(String(first?.["uri"])).toContain("spotify:track:");
  expect(Number(first?.["playedAt"])).toBeGreaterThan(0);
});

test("toggle off/on restores the exact profile geometry", async ({ page }) => {
  await bootProfile(page);
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
  const before = await paneBox(page, "profile");
  expect(before).toEqual({ x: 24, y: 96, w: 420, h: 560 });

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
  expect(await paneBox(page, "profile")).toEqual({ x: 24, y: 96, w: 420, h: 560 });
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
  expect(await paneBox(page, "profile")).toEqual({ x: 24, y: 96, w: 420, h: 560 });
  await expect(profile.locator(".detail-head .detail-title")).toContainText(PROFILE_ME_NAME);
});
