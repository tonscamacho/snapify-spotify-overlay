import { test, expect } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";
import { TRACK_ID, TRACK_URI, TRACK_ALBUM, TRACK_DURATION_MS, TRACK_PROGRESS_MS, DEVICE_ID, COVER_DATA_URI } from "./fixtures";

// Track C (mini-marquee-volume, 2.5.4): the mini card carries the
// full-player marquee mechanics (hover/focus-gated, scrollWidth >
// clientWidth + 1, --marquee-dist, reduced-motion kills) on BOTH title and
// artist, plus a compact volume icon-button that expands to the same slider
// (same set_volume + curved-gain contract as the full player). Closed the
// volume costs one aux slot and zero slider width, so the row keeps its
// 72 px cap with zero spill at 280/300/340 + 280x120.
//
// Design note (bar vs icon): an inline thin bar was measured and rejected —
// a permanent 56-64 px slider leaves ~43 px of meta at 280 px and collapses
// the title to nothing. The icon-button costs 26-28 px closed (one more aux
// slot next to shuffle/repeat) and reveals the slider only on hover/focus.

const DIR = "docs/bug-reports/2.5.4";

const LONG_NAME = "A Very Long Fixture Anthem That Keeps Going And Going Beyond The Mini Row";
const LONG_ARTISTS = "The Extraordinarily Long-Named Fixture Band Featuring Guests";

function playerWith(name: string, artists: string) {
  return {
    is_playing: true,
    progress_ms: TRACK_PROGRESS_MS,
    item: {
      id: TRACK_ID,
      name,
      artists: [{ name: artists }],
      album: { name: TRACK_ALBUM, images: [{ url: COVER_DATA_URI }] },
      duration_ms: TRACK_DURATION_MS,
      uri: TRACK_URI,
      explicit: false,
    },
    device: { id: DEVICE_ID, name: "Verify Speaker", volume_percent: 80 },
    shuffle_state: false,
    repeat_state: "off",
  };
}

function layoutFor(w: number, h = 260) {
  return {
    version: 3,
    preset: "custom",
    panes: [
      {
        id: "player",
        type: "player",
        x: 24,
        y: 100,
        w,
        h,
        opacity: 0.92,
        visible: true,
        collapsed: false,
        z: 1,
      },
    ],
  };
}

async function spillOf(page, sel: string) {
  return page.locator(sel).evaluate((el) => ({
    scrollW: el.scrollWidth,
    clientW: el.clientWidth,
    scrollH: el.scrollHeight,
    clientH: el.clientHeight,
  }));
}

test("long mini title marquees on hover with --marquee-dist", async ({ page }) => {
  await stubTauri(page, { fixtures: { player: playerWith(LONG_NAME, LONG_ARTISTS) }, layout: layoutFor(300) });
  await page.goto("/");
  const mini = page.locator('section[data-pane="player"] .mini-row');
  await expect(mini).toBeVisible();
  const title = mini.locator(".mini-title");
  await expect(title).toContainText(LONG_NAME.slice(0, 20));

  await title.hover();
  await expect(title).toHaveClass(/is-marquee/, { timeout: 5000 });
  const dist = await title.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--marquee-dist"));
  expect(parseFloat(dist)).toBeGreaterThan(0);
  // Single marquee at a time: the artist stays static while the title runs.
  await expect(mini.locator(".mini-artist")).not.toHaveClass(/is-marquee/);
  await page.screenshot({ path: `${DIR}/mini-marquee-long.png` });
});

test("long mini artist marquees on hover", async ({ page }) => {
  await stubTauri(page, { fixtures: { player: playerWith(LONG_NAME, LONG_ARTISTS) }, layout: layoutFor(300) });
  await page.goto("/");
  const mini = page.locator('section[data-pane="player"] .mini-row');
  await expect(mini).toBeVisible();
  const artist = mini.locator(".mini-artist");

  await artist.hover();
  await expect(artist).toHaveClass(/is-marquee/, { timeout: 5000 });
  const dist = await artist.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--marquee-dist"));
  expect(parseFloat(dist)).toBeGreaterThan(0);
  await page.screenshot({ path: `${DIR}/mini-marquee-artist.png` });
});

test("mini title marquees on keyboard focus", async ({ page }) => {
  await stubTauri(page, { fixtures: { player: playerWith(LONG_NAME, LONG_ARTISTS) }, layout: layoutFor(300) });
  await page.goto("/");
  const mini = page.locator('section[data-pane="player"] .mini-row');
  await expect(mini).toBeVisible();
  const title = mini.locator(".mini-title");

  await title.focus();
  await expect(title).toHaveClass(/is-marquee/, { timeout: 5000 });
  await page.screenshot({ path: `${DIR}/mini-marquee-focus.png` });
});

test("short mini title and artist never animate", async ({ page }) => {
  await stubTauri(page, { fixtures: { player: playerWith("Hi", "Al") }, layout: layoutFor(300) });
  await page.goto("/");
  const mini = page.locator('section[data-pane="player"] .mini-row');
  await expect(mini).toBeVisible();

  await mini.locator(".mini-title").hover();
  await mini.locator(".mini-artist").hover();
  await page.waitForTimeout(400);
  await expect(mini.locator(".mini-title.is-marquee")).toHaveCount(0);
  await expect(mini.locator(".mini-artist.is-marquee")).toHaveCount(0);
  await page.screenshot({ path: `${DIR}/mini-marquee-short.png` });
});

test("reduced-motion kills the mini marquee", async ({ page }) => {
  await stubTauri(page, { fixtures: { player: playerWith(LONG_NAME, LONG_ARTISTS) }, layout: layoutFor(300) });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const mini = page.locator('section[data-pane="player"] .mini-row');
  await expect(mini).toBeVisible();

  await mini.locator(".mini-title").hover();
  await page.waitForTimeout(400);
  await expect(mini.locator(".mini-title.is-marquee")).toHaveCount(0);

  // The kill block covers the mini selectors too, not just the full title.
  const killCoversMini = await page.evaluate(() => {
    for (const sh of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try {
        rules = sh.cssRules;
      } catch {
        continue;
      }
      if (!rules) continue;
      for (const r of Array.from(rules)) {
        if (r instanceof CSSMediaRule && r.conditionText.includes("prefers-reduced-motion")) {
          const text = Array.from(r.cssRules).map((x) => x.cssText).join("\n");
          if (text.includes("mini-title") && text.includes("mini-artist")) return true;
        }
      }
    }
    return false;
  });
  expect(killCoversMini).toBe(true);
  await page.screenshot({ path: `${DIR}/mini-marquee-reduced.png` });
});

test("mini volume slider drives the set_volume + curved-gain contract", async ({ page }) => {
  await stubTauri(page, { layout: layoutFor(300), edit: true });
  await page.goto("/");
  const player = page.locator('section[data-pane="player"]');
  const mini = player.locator(".mini-row");
  await expect(mini).toBeVisible();

  // Closed: icon-button visible, slider present at zero width.
  await expect(mini.getByRole("button", { name: "Adjust volume" })).toBeVisible();
  const vol = mini.locator("input.vol");
  await expect(vol).toHaveAttribute("aria-valuetext", "80 percent");

  // Arm the headless device first (same as the full-player volume spec):
  // later slider moves must reach the local gain of the live player.
  await page.keyboard.press("p");
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const sdkRow = dialog.locator(".device-cell", { hasText: "Snapify Overlay" });
  await expect(sdkRow).toHaveCount(1, { timeout: 10000 });
  await dialog.getByRole("button", { name: "Close settings" }).click();
  await expect(dialog).toBeHidden();

  // Open the cluster, then drive the slider like the full player does.
  await mini.locator(".mini-vol").hover();
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

  // Curved local gain follows (0 -> 0 through the perceptual taper).
  const lastVol = await page.evaluate(
    () => (window as unknown as Record<string, unknown>)["__SDK_LAST_VOLUME__"],
  );
  expect(lastVol).toBe(0);

  // Single resolution still holds after the write.
  await expect(player.getByRole("button", { name: "Pause", exact: true })).toHaveCount(1);
  await page.screenshot({ path: `${DIR}/mini-volume-open.png` });
});

for (const w of [280, 300, 340]) {
  test(`mini volume keeps zero spill at ${w}px`, async ({ page }) => {
    await stubTauri(page, { layout: layoutFor(w) });
    await page.goto("/");
    const player = page.locator('section[data-pane="player"]');
    const mini = player.locator(".mini-row");
    await expect(mini).toBeVisible();
    await expect(player.locator(".player-full")).toBeHidden();
    await expect(mini.getByRole("button", { name: "Adjust volume" })).toBeVisible();
    await expect(mini.locator("input.vol")).toHaveCount(1);
    await expect(player.getByRole("button", { name: "Pause", exact: true })).toHaveCount(1);
    for (const sel of [
      'section[data-pane="player"] .mini-row',
      'section[data-pane="player"] .pane-body',
      'section[data-pane="player"]',
    ]) {
      const m = await spillOf(page, sel);
      expect(m.scrollW, `${sel} horizontal`).toBeLessThanOrEqual(m.clientW + 1);
      expect(m.scrollH, `${sel} vertical`).toBeLessThanOrEqual(m.clientH + 1);
    }
    const rowBox = await mini.boundingBox();
    if (!rowBox) throw new Error("mini-row has no box");
    expect(rowBox.height).toBeLessThanOrEqual(72);
    await page.screenshot({ path: `${DIR}/mini-volume-${w}.png` });
  });
}

for (const size of ["280x120", "360x120"] as const) {
  test(`mini volume keeps zero spill at ${size}`, async ({ page }) => {
    const [w, h] = size.split("x").map(Number);
    await stubTauri(page, { layout: layoutFor(w, h) });
    await page.goto("/");
    const player = page.locator('section[data-pane="player"]');
    const mini = player.locator(".mini-row");
    await expect(mini).toBeVisible();
    await expect(player.locator(".player-full")).toBeHidden();
    await expect(mini.getByRole("button", { name: "Adjust volume" })).toBeVisible();
    await expect(player.getByRole("button", { name: "Pause", exact: true })).toHaveCount(1);
    for (const sel of [
      'section[data-pane="player"] .mini-row',
      'section[data-pane="player"] .pane-body',
      'section[data-pane="player"]',
    ]) {
      const m = await spillOf(page, sel);
      expect(m.scrollW, `${sel} horizontal`).toBeLessThanOrEqual(m.clientW + 1);
      expect(m.scrollH, `${sel} vertical`).toBeLessThanOrEqual(m.clientH + 1);
    }
    const rowBox = await mini.boundingBox();
    if (!rowBox) throw new Error("mini-row has no box");
    expect(rowBox.height).toBeLessThanOrEqual(72);
    await page.screenshot({ path: `${DIR}/mini-volume-${size}.png` });
  });
}
