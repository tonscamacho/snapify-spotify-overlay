import { test, expect } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";
import { TRACK_NAME, TRACK_ARTISTS } from "./fixtures";

// Track gate (2.5.3): collapsed is header-only (no mini in the DOM); the
// mini is an expanded-only compact state (w < COMPACT_W 360 or
// h <= 190 floor-inclusive) — circular cover + title/artist + thin
// progress + shuffle/prev/play/next/repeat — at most 72 px tall with zero
// spill, and track text plus transport resolve exactly once. No volume at
// this size.

function layoutFor(w: number, collapsed: boolean, h = 260) {
  return {
    version: 3,
    preset: "custom",
    panes: [
      {
        id: "player",
        type: "player",
        x: 24,
        y: 200,
        w,
        h,
        opacity: 0.92,
        visible: true,
        collapsed,
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

async function expectHeaderOnly(page, shot: string) {
  const player = page.locator('section[data-pane="player"]');
  await expect(player).toHaveAttribute("data-collapsed", "true");
  await expect(player.locator(".pane-body")).toBeHidden();
  await expect(player.locator(".mini-row")).toHaveCount(0);
  const box = await player.boundingBox();
  if (!box) throw new Error("player has no box");
  expect(box.height).toBeLessThanOrEqual(48);
  await page.screenshot({ path: `docs/bug-reports/2.5.3/${shot}` });
}

async function expectMiniCard(page, shot: string) {
  const player = page.locator('section[data-pane="player"]');
  await expect(player).not.toHaveAttribute("data-collapsed", "true");
  const mini = player.locator(".mini-row");
  await expect(mini).toBeVisible();
  await expect(player.locator(".player-full")).toBeHidden();
  // Reference content: cover, title, artist, progress, five transport buttons.
  await expect(mini.locator("img.mini-cover")).toBeVisible();
  await expect(mini.locator(".mini-title")).toContainText(TRACK_NAME);
  await expect(mini.locator(".mini-artist")).toContainText(TRACK_ARTISTS);
  const fillW = await mini.locator(".mini-progress i").evaluate((el) => {
    const w = parseFloat((el as HTMLElement).style.width || "0");
    const r = (el as HTMLElement).getBoundingClientRect();
    return { pct: w, px: r.width };
  });
  expect(fillW.pct).toBeGreaterThan(0);
  expect(fillW.px).toBeGreaterThan(0);
  await expect(mini.getByRole("button", { name: "Previous track" })).toBeVisible();
  await expect(mini.getByRole("button", { name: "Next track" })).toBeVisible();
  // Shuffle + repeat flank the transport, reusing the full-player
  // behavior: icon-btn, aria-pressed, tooltips, disabled when free.
  const shuffle = mini.getByRole("button", { name: "Toggle shuffle" });
  const repeat = mini.getByRole("button", { name: "Cycle repeat mode" });
  await expect(shuffle).toBeVisible();
  await expect(repeat).toBeVisible();
  await expect(shuffle).toHaveAttribute("aria-pressed", "false");
  await expect(repeat).toHaveAttribute("aria-pressed", "false");
  await expect(shuffle).toHaveClass(/mini-aux/);
  await expect(repeat).toHaveClass(/mini-aux/);
  // No volume at this size.
  await expect(mini.locator("input.vol, .volume-row")).toHaveCount(0);
  // Single resolution: exactly one accessible Play/Pause in the pane —
  // display:none keeps the full player's twin out of the a11y tree.
  await expect(
    player.getByRole("button", { name: "Pause", exact: true }),
  ).toHaveCount(1);
  // Zero spill: nothing scrolls inside the row, body, or pane box.
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
  await page.screenshot({ path: `docs/bug-reports/2.5.3/${shot}` });
}

for (const w of [280, 360]) {
  test(`collapsed player is header-only at ${w}px`, async ({ page }) => {
    await stubTauri(page, { layout: layoutFor(w, true) });
    await page.goto("/");
    await expectHeaderOnly(page, `collapsed-header-${w}.png`);
  });
}

test("collapsed player is header-only on narrow stage", async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 800 });
  await stubTauri(page, {
    layout: {
      version: 3,
      preset: "custom",
      panes: [
        { id: "player", type: "player", x: 8, y: 100, w: 280, h: 260, opacity: 0.92, visible: true, collapsed: true, z: 1 },
      ],
    },
  });
  await page.goto("/");
  await expectHeaderOnly(page, "collapsed-header-narrow.png");
});

test("expanded compact mini card at 280px", async ({ page }) => {
  // Narrow but not collapsed: below COMPACT_W the React gate + 359 px
  // container query swap the full player for the same mini card; the row
  // itself stays compact.
  await stubTauri(page, { layout: layoutFor(280, false) });
  await page.goto("/");
  const player = page.locator('section[data-pane="player"]');
  await expect(player).not.toHaveAttribute("data-collapsed", "true");
  await expectMiniCard(page, "mini-shuffle-280.png");
  // Light theme keeps the same exquisite mini: recolor only, no layout shift.
  await page.evaluate(() => {
    document.querySelector(".app")?.setAttribute("data-theme", "light");
  });
  await expect(player.locator(".mini-row")).toBeVisible();
  await page.screenshot({ path: "docs/bug-reports/2.5.3/mini-shuffle-280-light.png" });
});

for (const w of [300, 340]) {
  test(`expanded compact mini card at ${w}px (reachable by normal resize)`, async ({ page }) => {
    // 2.5.2 gate (w < 360): these widths are reachable by normal drag
    // resize (min 280) and must show the mini, not a squeezed full player.
    await stubTauri(page, { layout: layoutFor(w, false) });
    await page.goto("/");
    await expectMiniCard(page, `mini-shuffle-${w}.png`);
  });
}

test("expanded full player above the compact gate", async ({ page }) => {
  // Tall-wide stays full: w=400 clears w<360 and h=260 clears h<=190, so
  // the full player renders and no mini reaches the DOM.
  await stubTauri(page, { layout: layoutFor(400, false, 260) });
  await page.goto("/");
  const player = page.locator('section[data-pane="player"]');
  await expect(player).not.toHaveAttribute("data-collapsed", "true");
  await expect(player.locator(".player-full")).toBeVisible();
  await expect(player.locator(".mini-row")).toHaveCount(0);
  await expect(player.getByText(TRACK_NAME).first()).toBeVisible();
});

test("expanded compact mini card at the height floor (h=190, reachable)", async ({ page }) => {
  // Floor-inclusive height arm: the normal drag minimum (h=190) itself
  // reaches mini without lowering drag minima, even when wide.
  await stubTauri(page, { layout: layoutFor(400, false, 190) });
  await page.goto("/");
  await expectMiniCard(page, "mini-shuffle-h190.png");
});

test("expanded compact mini card when short", async ({ page }) => {
  // Short stage: the boot clamp yields to the compact floor (h<=190), so
  // an EXPANDED wide pane still swaps the full player for the mini card.
  await page.setViewportSize({ width: 800, height: 170 });
  await stubTauri(page, { layout: layoutFor(340, false, 260) });
  await page.goto("/");
  const player = page.locator('section[data-pane="player"]');
  await expect(player).not.toHaveAttribute("data-collapsed", "true");
  await expectMiniCard(page, "mini-shuffle-short.png");
});

test("mini shuffle + repeat fire the matching commands", async ({ page }) => {
  await stubTauri(page, { layout: layoutFor(300, false) });
  await page.goto("/");
  const player = page.locator('section[data-pane="player"]');
  const mini = player.locator(".mini-row");
  await expect(mini).toBeVisible();

  await mini.getByRole("button", { name: "Toggle shuffle" }).click();
  await expect
    .poll(async () => (await commandsNamed(page, "set_shuffle")).length, { timeout: 10000 })
    .toBeGreaterThan(0);

  await mini.getByRole("button", { name: "Cycle repeat mode" }).click();
  await expect
    .poll(async () => (await commandsNamed(page, "set_repeat")).length, { timeout: 10000 })
    .toBeGreaterThan(0);

  // Single resolution still holds after both presses.
  await expect(player.getByRole("button", { name: "Pause", exact: true })).toHaveCount(1);
  await page.screenshot({ path: "docs/bug-reports/2.5.3/mini-shuffle-commands.png" });
});
