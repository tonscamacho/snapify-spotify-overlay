import { test, expect } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";
import { MINIMAL_LAYOUT } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await stubTauri(page, { interact: true });
  await page.goto("/");
});

// Repro for: interactive mode pauses the game behind the overlay.
// Root cause: whole maximized window takes all mouse input, stealing
// focus from the game. Fixed shape: empty stage stays click-through
// (pointer-events none + regions reported), only panes/dock/modal take input.
test("interactive mode keeps empty stage click-through", async ({ page }) => {
  const stage = page.locator(".stage");
  await expect(stage).toBeVisible();

  // Stage itself must not capture: game below keeps input + focus.
  const stagePe = await stage.evaluate((el) => getComputedStyle(el).pointerEvents);
  expect(stagePe).toBe("none");

  // Panes stay interactive.
  const panePe = await page
    .locator('section[data-pane="player"]')
    .evaluate((el) => getComputedStyle(el).pointerEvents);
  expect(panePe).toBe("auto");

  // Frontend must report hit regions so Rust can keep empty pixels transparent.
  await expect
    .poll(async () => (await commandsNamed(page, "set_overlay_regions")).length, {
      timeout: 10000,
    })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await commandsNamed(page, "set_overlay_mode")).length, {
      timeout: 10000,
    })
    .toBeGreaterThan(0);
});

// Panes must not drift on their own: position reports are read-only and the
// backend never moves the window, so two samples with no input are identical.
test("panes hold still with no input", async ({ page }) => {
  const pane = page.locator('section[data-pane="player"]');
  await expect(pane).toBeVisible();
  const first = await pane.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height].join(",");
  });
  await page.waitForTimeout(1500);
  const second = await pane.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height].join(",");
  });
  expect(second).toBe(first);
});

// The first-run coach pill is display-only: it must not swallow empty-stage
// clicks, which keep passing through to the game behind the overlay.
test("empty-stage clicks hit nothing interactive, even with the coach pill up", async ({ page }) => {
  const pill = page.getByRole("button", { name: "Dismiss shortcut hint" });
  await expect(pill).toBeVisible();

  const hit = await page.evaluate(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const picks: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < h; y += 40) {
      for (let x = 0; x < w; x += 40) picks.push({ x: x + 5, y: y + 5 });
    }
    for (const pt of picks) {
      const el = document.elementFromPoint(pt.x, pt.y) as HTMLElement | null;
      if (!el) continue;
      if (el.closest("section.pane, .dock, .modal, .toast, .hint-chip, .gate-card")) continue;
      return { x: pt.x, y: pt.y, tag: el.tagName, cls: el.className?.toString?.() ?? "" };
    }
    return null;
  });
  if (!hit) throw new Error("no empty-stage point found");
  // The point resolves to bare stage/app/toasts chrome: a real click here
  // reaches the game, never an overlay control.
  expect(String(hit.cls)).toMatch(/stage|^app|toasts|^$/);
  await page.mouse.click(hit.x, hit.y);
  await expect(page.locator('section[data-pane="player"]')).toBeVisible();
});

// Region reports stay under 10/s during a live drag: the 80 ms debounce in
// App coalesces per-frame layout writes into a trailing report.
test("region reports stay under 10 per second during a drag", async ({ page }) => {
  await stubTauri(page, { layout: MINIMAL_LAYOUT });
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
  await page.getByRole("button", { name: "Toggle edit lock" }).click();

  const pane = page.locator('section[data-pane="player"]');
  await expect(pane).toBeVisible();
  const handle = pane.locator(".pane-handle");
  const start = await handle.boundingBox();
  if (!start) throw new Error("pane handle has no box");

  const before = (await commandsNamed(page, "set_overlay_regions")).length;
  const t0 = Date.now();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(start.x + i * 12, start.y + start.height / 2 + i * 4);
    await page.waitForTimeout(100);
  }
  await page.mouse.up();
  // Let the trailing debounced report land.
  await page.waitForTimeout(500);
  const elapsedS = (Date.now() - t0) / 1000;
  const after = (await commandsNamed(page, "set_overlay_regions")).length;
  const rate = (after - before) / elapsedS;
  // eslint-disable-next-line no-console
  console.log(`region reports during drag: ${after - before} in ${elapsedS.toFixed(2)}s = ${rate.toFixed(2)}/s`);
  expect(rate).toBeLessThan(10);
});
