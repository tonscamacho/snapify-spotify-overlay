import { test, expect } from "@playwright/test";
import { stubTauri, commandsNamed, invokedCommands } from "./tauri-mock";
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

// Region reports stay under 10/s during a live drag: the 120 ms trailing
// scheduler in App coalesces per-frame layout writes, and the overlay.ts
// dirty-rect diff skips unchanged resolves, so a drag reports at most
// ~8/s by construction (1 per 120 ms window).
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

// Visibility truth lives in Rust: dock hide/show and settings hide/show
// must both invoke `toggle_visibility` (tray + global hotkey already do)
// and must never call win.hide()/show() directly (`plugin:window|hide`
// / `plugin:window|show`), so the three paths cannot drift.
test("dock + settings hide/show route through toggle_visibility", async ({ page }) => {
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();

  const directCount = async () =>
    (await invokedCommands(page)).filter(
      (c) => c.cmd === "plugin:window|hide" || c.cmd === "plugin:window|show",
    ).length;
  expect(await directCount()).toBe(0);

  // Dock path.
  await page.getByRole("button", { name: "Hide window" }).click();
  await expect
    .poll(async () => (await commandsNamed(page, "toggle_visibility")).length, {
      timeout: 5000,
    })
    .toBeGreaterThan(0);

  // Settings path.
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  const seen = (await commandsNamed(page, "toggle_visibility")).length;
  await dialog.getByRole("button", { name: "Hide", exact: true }).click();
  await expect
    .poll(async () => (await commandsNamed(page, "toggle_visibility")).length, {
      timeout: 5000,
    })
    .toBeGreaterThan(seen);

  // Neither path bypassed Rust truth with a direct hide/show.
  expect(await directCount()).toBe(0);
});

// Startup timing, frontend half of the Rust note_boot/note_first_report
// pair: the snapify-boot mark lands at module load and the first-report
// mark + console line land on the first successful region report.
test("boot timing mark is present through first region report", async ({ page }) => {
  await expect
    .poll(async () => (await commandsNamed(page, "set_overlay_regions")).length, {
      timeout: 10000,
    })
    .toBeGreaterThan(0);
  const marks = await page.evaluate(() => ({
    boot: performance.getEntriesByName("snapify-boot").length,
    first: performance.getEntriesByName("snapify-first-region-report").length,
  }));
  expect(marks.boot).toBeGreaterThan(0);
  expect(marks.first).toBeGreaterThan(0);
});

// Zoom-drift check (cheap path: keep `zoom`, prove regions still match).
// At 130% UI scale the reported regions must still align with the panes
// (both derive from getBoundingClientRect, so zoom cannot drift them).
// Measured 2026-09-19: pane {"x":31,"y":31,"w":442,"h":307} == region
// {"x":31,"y":31,"w":442,"h":307} (exact, <=1px tolerance) — zoom kept.
test("130% UI scale keeps reported regions aligned with panes", async ({ page }) => {
  await stubTauri(page, { layout: MINIMAL_LAYOUT });
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();

  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  const scale = dialog.getByLabel("UI scale");
  const before = (await commandsNamed(page, "set_overlay_regions")).length;
  await scale.focus();
  await page.keyboard.press("End");
  await expect(scale).toHaveAttribute("aria-valuetext", "130 percent");

  // The zoom reflow changes resolved rects, so the diff must re-report.
  // Reports are trailing-debounced (120 ms): under parallel load the first
  // new report can be an intermediate stale reflow, not the final. Poll
  // until the latest report matches the live pane rect (quiescence) instead
  // of asserting on the first new report.
  await expect
    .poll(
      async () => {
        const reports = await commandsNamed(page, "set_overlay_regions");
        if (reports.length <= before) return "waiting-for-report";
        const last = reports[reports.length - 1] as unknown as {
          regions: Array<{ x: number; y: number; w: number; h: number }>;
        };
        const pane = await page.locator('section[data-pane="player"]').evaluate((el) => {
          const r = el.getBoundingClientRect();
          return {
            x: Math.round(r.left),
            y: Math.round(r.top),
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
        });
        const ok = (last.regions ?? []).some(
          (rg) =>
            Math.abs(rg.x - pane.x) <= 1 &&
            Math.abs(rg.y - pane.y) <= 1 &&
            Math.abs(rg.w - pane.w) <= 1 &&
            Math.abs(rg.h - pane.h) <= 1,
        );
        if (ok) return "aligned";
        return `pane ${JSON.stringify(pane)} vs regions ${JSON.stringify(last.regions)}`;
      },
      { timeout: 10000 },
    )
    .toBe("aligned");

  const reports = await commandsNamed(page, "set_overlay_regions");
  const last = reports[reports.length - 1] as unknown as {
    regions: Array<{ x: number; y: number; w: number; h: number }>;
  };
  const pane = await page.locator('section[data-pane="player"]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });
  // eslint-disable-next-line no-console
  console.log(`130% zoom: pane ${JSON.stringify(pane)} vs regions ${JSON.stringify(last.regions)}`);
  const match = (last.regions ?? []).some(
    (rg) =>
      Math.abs(rg.x - pane.x) <= 1 &&
      Math.abs(rg.y - pane.y) <= 1 &&
      Math.abs(rg.w - pane.w) <= 1 &&
      Math.abs(rg.h - pane.h) <= 1,
  );
  expect(match).toBe(true);
});
