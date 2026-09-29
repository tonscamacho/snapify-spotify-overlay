import { test, expect } from "@playwright/test";
import { stubTauri } from "./tauri-mock";
import { TRACK_NAME, TRACK_ARTISTS } from "./fixtures";

// Track B (2.5.1): collapsed is header-only (no mini in the DOM); the mini
// is an expanded-only compact state (narrow/short) — circular cover +
// title/artist + thin progress + prev/play/next — at most 72 px tall with
// zero spill, and track text plus transport resolve exactly once.

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
  await page.screenshot({ path: `docs/bug-reports/2.5.1/${shot}` });
}

async function expectMiniCard(page, shot: string) {
  const player = page.locator('section[data-pane="player"]');
  await expect(player).not.toHaveAttribute("data-collapsed", "true");
  const mini = player.locator(".mini-row");
  await expect(mini).toBeVisible();
  await expect(player.locator(".player-full")).toBeHidden();
  // Reference content: cover, title, artist, progress, three transport buttons.
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
  await page.screenshot({ path: `docs/bug-reports/2.5.1/${shot}` });
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
  // Narrow but not collapsed: the 280 px container query swaps the full
  // player for the same mini card; the row itself stays compact.
  await stubTauri(page, { layout: layoutFor(280, false) });
  await page.goto("/");
  const player = page.locator('section[data-pane="player"]');
  await expect(player).not.toHaveAttribute("data-collapsed", "true");
  await expectMiniCard(page, "expanded-compact-280.png");
  // Light theme keeps the same exquisite mini: recolor only, no layout shift.
  await page.evaluate(() => {
    document.querySelector(".app")?.setAttribute("data-theme", "light");
  });
  await expect(player.locator(".mini-row")).toBeVisible();
  await page.screenshot({ path: "docs/bug-reports/2.5.1/expanded-compact-280-light.png" });
});

test("expanded compact mini card when short", async ({ page }) => {
  // Short stage: the boot clamp yields to the compact floor (h<160), so an
  // EXPANDED wide pane still swaps the full player for the mini card.
  await page.setViewportSize({ width: 800, height: 170 });
  await stubTauri(page, { layout: layoutFor(340, false, 260) });
  await page.goto("/");
  const player = page.locator('section[data-pane="player"]');
  await expect(player).not.toHaveAttribute("data-collapsed", "true");
  await expectMiniCard(page, "expanded-compact-short.png");
});
