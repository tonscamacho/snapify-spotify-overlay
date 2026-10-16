// Listening clocks + stream-weighted genres: two 24-wedge radial coxcombs
// (streams, minutes streamed) with per-wedge hover/focus tooltips, and a
// genre strip that follows the slice's most-streamed artists instead of the
// raw top-10 count. Wedges paint token colors only, so every theme x surface
// holds without extra work.
import { test, expect, type Page } from "@playwright/test";
import { stubTauri, mockHistoryFile, seedStorage } from "./tauri-mock";
import { PROFILE_ME_NAME } from "./fixtures";

const PROFILE_LAYOUT = {
  version: 3,
  preset: "custom",
  panes: [
    { id: "profile", type: "profile", x: 24, y: 24, w: 420, h: 560, opacity: 0.92, visible: true, z: 1 },
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

async function bootThemed(page: Page, theme: string, surface: string) {
  await stubTauri(page, { layout: PROFILE_LAYOUT, edit: true });
  await seedStorage(page, { "snapify-theme": theme, "snapify-surface": surface });
  await page.goto("/");
  await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
  await expect(page.locator(".app")).toHaveAttribute("data-surface", surface);
  const profile = page.locator('section[data-pane="profile"]');
  await expect(profile).toBeVisible();
  await expect(profile.locator(".detail-head .detail-title")).toContainText(PROFILE_ME_NAME);
  return profile;
}

/** Real-hover a wedge at its geometric midpoint. A thin (zero-value)
 *  wedge's bounding-box center can fall off the sliver, so hovering the
 *  box center is unreliable; the mid-angle point at mid-radius is always
 *  on the fill. The chart is centered in the pane scroller first so
 *  resize handles and sticky subheads never cover the point. */
async function hoverWedge(
  page: Page,
  profile: ReturnType<Page["locator"]>,
  clock: "streams" | "minutes",
  hour: string,
) {
  const chart = profile.locator(`[data-clock="${clock}"]`);
  await chart.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const wedge = chart.locator(`[data-hour="${hour}"]`);
  const pt = await wedge.evaluate((el) => {
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

test("coxcombs paint 24 wedges each with captions and slice totals", async ({ page }) => {  const profile = await bootProfile(page);

  const streams = profile.locator('[data-clock="streams"]');
  const minutes = profile.locator('[data-clock="minutes"]');
  await expect(streams.locator("[data-hour]")).toHaveCount(24);
  await expect(minutes.locator("[data-hour]")).toHaveCount(24);
  // One tick spoke per hour per chart.
  expect(await streams.locator(".cox-spoke").count()).toBe(24);
  expect(await minutes.locator(".cox-spoke").count()).toBe(24);
  await expect(profile.getByText("streams", { exact: true })).toBeVisible();
  await expect(profile.getByText("minutes streamed", { exact: true })).toBeVisible();

  // The default 4W slice holds 4 streams; the minutes chart totals the
  // same slice in whole minutes (200+180+210+240s -> 14).
  await expect(streams.locator("svg")).toHaveAttribute(
    "aria-label",
    /streams listening clock: 4 streams/,
  );
  await expect(minutes.locator("svg")).toHaveAttribute(
    "aria-label",
    /minutes streamed listening clock: 14 minutes/,
  );

  // Wedges size by value/max: the busiest hour extends past an idle one.
  const radii = await streams.locator("[data-hour]").evaluateAll((els) =>
    els.map((el) => {
      const d = (el as SVGPathElement).getAttribute("d") ?? "";
      const m = /A ([\d.]+) [\d.]+ 0 0 1/.exec(d);
      return Number(m?.[1] ?? 0);
    }),
  );
  expect(Math.max(...radii)).toBeGreaterThan(Math.min(...radii));
});

test("wedge hover and keyboard focus surface the hour tooltip", async ({ page }) => {
  const profile = await bootProfile(page);
  const streams = await hoverWedge(page, profile, "streams", "19");
  const tip = streams.locator(".cox-tip");
  await expect(tip).toBeVisible();
  await expect(tip).toHaveAttribute("role", "tooltip");
  await expect(tip).toContainText(/19:00 - 20:00: [\d,]+ streams?/);

  // Keyboard: focusing a wedge shows the same copy, blurring hides it.
  await streams.locator('[data-hour="9"]').focus();
  await expect(tip).toContainText(/09:00 - 10:00: [\d,]+ streams?/);
  await streams.locator('[data-hour="9"]').blur();
  await expect(tip).toHaveCount(0);
});

test("imported history reweighs the genre strip toward what was heard", async ({ page }) => {
  const profile = await bootProfile(page);
  await expect(profile.getByText("indie · 1").first()).toBeVisible();

  // Five imported spins for Short Band Three (short-term genres indie+pop):
  // indie climbs to 6, pop to 5, ahead of the one-off recents.
  const now = Date.now();
  const rows = Array.from({ length: 5 }, (_, i) => ({
    ts: new Date(now - (i + 1) * 86400000).toISOString(),
    ms_played: 200000,
    master_metadata_track_name: `Import Spin ${i}`,
    master_metadata_album_artist_name: "Short Band Three",
    spotify_track_uri: `spotify:track:import-weighted-${i}`,
    reason_end: "trackdone",
    skipped: false,
  }));
  await mockHistoryFile(page, "endsong_weighted.json", JSON.stringify(rows));
  await profile.getByRole("button", { name: "Import history" }).click();
  await expect(profile.getByText(/Imported 5 of 5/, { exact: false })).toBeVisible({ timeout: 10000 });

  await expect(profile.getByText("indie · 6").first()).toBeVisible();
  await expect(profile.getByText("pop · 5").first()).toBeVisible();
  // The Top genre tile follows the same weights.
  await expect(profile.getByText("indie", { exact: true }).first()).toBeVisible();
});

test("empty tops and empty streams keep the honest genre empty state", async ({ page }) => {
  const emptyWindow = { artists: { items: [], total: 0 }, tracks: { items: [], total: 0 } };
  const profile = await bootProfile(page, {
    topShort: emptyWindow,
    topMedium: emptyWindow,
    topLong: emptyWindow,
    recentPlays: { items: [], total: 0 },
  });
  await expect(profile.getByText("Top genres", { exact: true })).toBeVisible();
  await expect(profile.getByText("No genres yet.", { exact: true })).toBeVisible();
  // The clocks still paint their full 24-wedge shape with zero totals.
  await expect(profile.locator('[data-clock="streams"] [data-hour]')).toHaveCount(24);
  await expect(profile.locator('[data-clock="minutes"] [data-hour]')).toHaveCount(24);
});

test("clocks resolve token colors across dark and light glass", async ({ page }) => {
  for (const [theme, surface] of [["dark", "solid"], ["light", "glass"]] as const) {
    const profile = await bootThemed(page, theme, surface);
    const streams = await hoverWedge(page, profile, "streams", "0");
    const wedge = streams.locator('[data-hour="0"]');
    await expect(wedge).toBeVisible();
    const fill = await wedge.evaluate((el) => getComputedStyle(el).fill);
    expect(fill).toMatch(/rgb/);
    expect(fill).not.toContain("rgba(0, 0, 0, 0)");

    // The tooltip keeps the halo treatment (clipped, stroked) in glass.
    const tip = streams.locator(".cox-tip");
    await expect(tip).toBeVisible();
    await expect
      .poll(async () => tip.evaluate((el) => getComputedStyle(el).backgroundClip), {
        timeout: 5000,
      })
      .toBe("padding-box");
    await page.screenshot({ path: `verify/web/test-results/clocks-${theme}-${surface}.png` });
  }
});
