import { test, expect } from "@playwright/test";
import { stubTauri } from "./tauri-mock";
import { MINIMAL_LAYOUT, buildFixtures } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await stubTauri(page, { layout: MINIMAL_LAYOUT });
  await page.goto("/");
});

test("cycle preset swaps the visible pane set", async ({ page }) => {
  await expect(page.locator('section[data-pane="player"]')).toBeVisible();
  await expect(page.locator('section[data-pane="queue"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Cycle preset" }).click();

  await expect(page.locator('section[data-pane="player"]')).toBeVisible();
  await expect(page.locator('section[data-pane="queue"]')).toBeVisible();
  await page.screenshot({ path: "verify/web/test-results/layout.png" });
});

test("pane toggle hides and shows the queue pane", async ({ page }) => {
  const chip = page.getByTitle("Toggle Queue pane");
  const queue = page.locator('section[data-pane="queue"]');

  await chip.click();
  await expect(queue).toBeVisible();
  await expect(chip).toHaveAttribute("aria-pressed", "true");

  await chip.click();
  await expect(queue).toHaveCount(0);
  await expect(chip).toHaveAttribute("aria-pressed", "false");
});

const CUSTOM_LAYOUT = {
  version: 3,
  preset: "custom",
  panes: [
    {
      id: "player",
      type: "player",
      x: 100,
      y: 150,
      w: 340,
      h: 230,
      opacity: 0.92,
      visible: true,
      z: 1,
    },
    {
      id: "queue",
      type: "queue",
      x: 460,
      y: 150,
      w: 300,
      h: 236,
      opacity: 0.92,
      visible: true,
      z: 2,
    },
  ],
};

async function playerBox(page) {
  return page.locator('section[data-pane="player"]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  });
}

test("toggle off/on restores the exact custom geometry", async ({ page }) => {
  const seed = buildFixtures();
  await stubTauri(page, {
    layout: CUSTOM_LAYOUT,
    fixtures: { queue: { ...(seed.queue as Record<string, unknown>) } },
  });
  await page.goto("/");
  // Dismiss the coach pill so it never covers a control mid-test.
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();

  const before = await playerBox(page);
  expect(before).toEqual({ x: 100, y: 150, w: 340, h: 230 });

  const chip = page.getByTitle("Toggle Player pane");
  await chip.click();
  await expect(page.locator('section[data-pane="player"]')).toHaveCount(0);
  await chip.click();
  await expect(page.locator('section[data-pane="player"]')).toBeVisible();
  expect(await playerBox(page)).toEqual(before);

  // The toggle persisted as custom, not as a factory preset.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("snapify-layout-v3")!));
  expect(saved.preset).toBe("custom");
  expect(saved.panes.find((p) => p.type === "player")).toMatchObject(before);
});

test("reload keeps the persisted custom layout", async ({ page }) => {
  await stubTauri(page, { layout: CUSTOM_LAYOUT });
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();

  // Hide the queue so there is a post-seed mutation to survive reload.
  await page.getByTitle("Toggle Queue pane").click();
  await expect(page.locator('section[data-pane="queue"]')).toHaveCount(0);
  const saved = await page.evaluate(() => localStorage.getItem("snapify-layout-v3"));

  // Re-seed boot storage with the mutated arrangement, then reload: boot
  // must load the custom geometry instead of a factory preset.
  await stubTauri(page, { layout: JSON.parse(saved!) });
  await page.reload();
  expect(await playerBox(page)).toEqual({ x: 100, y: 150, w: 340, h: 230 });
  await expect(page.locator('section[data-pane="queue"]')).toHaveCount(0);
});

test("queue Browse reveals browse without destroying custom geometry", async ({ page }) => {
  const seed = buildFixtures();
  await stubTauri(page, {
    layout: CUSTOM_LAYOUT,
    fixtures: { queue: { currently_playing: null, queue: [] } },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();

  const before = await playerBox(page);
  await expect(page.locator('section[data-pane="browse"]')).toHaveCount(0);

  // Empty queue shows the Browse button (the old path applied the "full"
  // preset here, resetting the player to 24,24).
  await page.locator('section[data-pane="queue"]').getByRole("button", { name: "Browse" }).click();
  await expect(page.locator('section[data-pane="browse"]')).toBeVisible();
  expect(await playerBox(page)).toEqual(before);

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("snapify-layout-v3")!));
  expect(saved.preset).toBe("custom");
  expect(saved.panes.find((p) => p.type === "player")).toMatchObject(before);
  expect(saved.panes.some((p) => p.type === "browse" && p.visible)).toBe(true);
});

test("preset select previews without persisting; Apply saves, Revert restores", async ({ page }) => {
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  const presetGroup = dialog.getByRole("group", { name: "Preset" });

  // Preview: stage repaints, storage does not.
  await presetGroup.getByRole("button", { name: "lyrics", exact: true }).click();
  await expect(page.locator('section[data-pane="lyrics"]')).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Apply" })).toBeVisible();
  let saved = await page.evaluate(() => JSON.parse(localStorage.getItem("snapify-layout-v3")!));
  expect(saved.preset).toBe("minimal");
  expect(saved.panes.some((p) => p.type === "lyrics")).toBe(false);

  // Revert: back to the untouched arrangement.
  await dialog.getByRole("button", { name: "Revert" }).click();
  await expect(page.locator('section[data-pane="lyrics"]')).toHaveCount(0);
  await expect(page.locator('section[data-pane="player"]')).toBeVisible();

  // Apply: the preview persists.
  await presetGroup.getByRole("button", { name: "full", exact: true }).click();
  await expect(page.locator('section[data-pane="queue"]')).toBeVisible();
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog.getByRole("button", { name: "Apply" })).toHaveCount(0);
  saved = await page.evaluate(() => JSON.parse(localStorage.getItem("snapify-layout-v3")!));
  expect(saved.preset).toBe("full");
  expect(saved.panes.some((p) => p.type === "queue")).toBe(true);
});

test("closing settings without Apply restores the pre-preview layout", async ({ page }) => {
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("group", { name: "Preset" }).getByRole("button", { name: "spotlight", exact: true }).click();
  await expect(page.locator('section[data-pane="visualizer"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('section[data-pane="visualizer"]')).toHaveCount(0);
  await expect(page.locator('section[data-pane="player"]')).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("snapify-layout-v3")!));
  expect(saved.preset).toBe("minimal");
});

test("Reset still restores the default arrangement", async ({ page }) => {
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.locator("div.row", { hasText: "Layout" }).getByRole("button").click();
  await expect(page.locator('section[data-pane="player"]')).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("snapify-layout-v3")!));
  expect(saved.panes.length).toBeGreaterThan(0);
  expect(saved.preset).toBe("full");
});

test("Ctrl+Z in edit mode undoes the last geometry change", async ({ page }) => {
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
  await page.getByRole("button", { name: "Toggle edit lock" }).click();
  const undo = page.getByRole("button", { name: "Undo layout change" });
  await expect(undo).toBeDisabled();

  await page.getByTitle("Toggle Queue pane").click();
  const queue = page.locator('section[data-pane="queue"]');
  await expect(queue).toBeVisible();
  await expect(undo).toBeEnabled();

  // Focus sits on the chip (a button, not an input), so Ctrl+Z reaches undo.
  await page.keyboard.press("Control+z");
  await expect(queue).toHaveCount(0);
  await expect(undo).toBeDisabled();
});

test("dock has labeled distinct controls and wraps at 800px", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.reload();
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
  const dock = page.locator(".dock");
  await expect(dock).toBeVisible();

  // Seeded interactive: the interact control shows its action ("Pass").
  let labels = (await dock.locator(".dock-label").allTextContents()).map((s) => s.trim());
  for (const want of ["Hide", "Edit", "Pass", "Undo", "Settings", "Done", "Preset", "Close"]) {
    expect(labels).toContain(want);
  }
  // Keep the dock up via edit mode, drop to pass-through: the control now
  // offers the opposite action ("Interact").
  await page.getByRole("button", { name: "Toggle edit lock" }).click();
  await page.getByRole("button", { name: "Toggle interact" }).click();
  labels = (await dock.locator(".dock-label").allTextContents()).map((s) => s.trim());
  expect(labels).toContain("Interact");
  expect(labels).toContain("Lock");

  // Every tbtn carries a visible text label next to a distinct icon.
  const glyphs = await dock.locator(".tbtn svg").evaluateAll((els) =>
    els.map((el) => el.innerHTML),
  );
  expect(new Set(glyphs).size).toBe(glyphs.length);

  // Wrap: the toolbar never overflows a narrow window.
  expect(await dock.evaluate((el) => getComputedStyle(el).flexWrap)).toBe("wrap");
  const box = await dock.boundingBox();
  if (!box) throw new Error("dock has no box");
  expect(box.width).toBeLessThanOrEqual(800);
  expect(box.x).toBeGreaterThanOrEqual(0);
  await dock.screenshot({ path: "verify/web/test-results/dock-800.png" });
});

test("first-run coach pill shows the keys, then dismisses forever", async ({ page }) => {
  const pill = page.getByRole("button", { name: "Dismiss shortcut hint" });
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("Shift+Tab");
  await expect(pill).toContainText("Esc");
  await pill.click();
  await expect(pill).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("snapify-coach-dismissed"))).toBe("1");
  await page.reload();
  await expect(page.getByRole("button", { name: "Dismiss shortcut hint" })).toHaveCount(0);
});

test("Alt+Arrows moves the focused pane, persists, flashes guides, undoes", async ({ page }) => {
  await stubTauri(page, { layout: CUSTOM_LAYOUT });
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();

  // Focus the player pane so the keyboard target is deterministic.
  await page.locator('section[data-pane="player"] .pane-handle').click();
  const before = await playerBox(page);
  expect(before).toEqual({ x: 100, y: 150, w: 340, h: 230 });

  await page.keyboard.press("Alt+ArrowRight");
  await expect
    .poll(async () => (await playerBox(page)).x, { timeout: 5000 })
    .toBe(before.x + 8);
  // Snap to the queue's y (same row) flashes a horizontal guide.
  await expect(page.locator(".guide-h")).toHaveCount(1);

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("snapify-layout-v3")!));
  expect(saved.preset).toBe("custom");
  expect(saved.panes.find((p) => p.type === "player")).toMatchObject({ x: before.x + 8, y: 150 });

  // The nudge is one undo step: Ctrl+Z in edit mode restores it.
  await page.getByRole("button", { name: "Toggle edit lock" }).click();
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await playerBox(page)).x, { timeout: 5000 })
    .toBe(before.x);
});

test("Alt+Shift+Arrows resizes the focused pane and persists", async ({ page }) => {
  await stubTauri(page, { layout: CUSTOM_LAYOUT });
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
  await page.locator('section[data-pane="player"] .pane-handle').click();

  await page.keyboard.press("Alt+Shift+ArrowRight");
  await expect
    .poll(async () => (await playerBox(page)).w, { timeout: 5000 })
    .toBe(348);
  // 230+8=238 snaps to the queue pane's bottom edge (150+236=386): the
  // keyboard path reuses snapSize, so the snap is the correct outcome.
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await expect
    .poll(async () => (await playerBox(page)).h, { timeout: 5000 })
    .toBe(236);

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("snapify-layout-v3")!));
  expect(saved.panes.find((p) => p.type === "player")).toMatchObject({ w: 348, h: 236 });
});

test("resize handles are sliders: labeled, valued, keyboard-operable, focus-ringed", async ({ page }) => {
  await stubTauri(page, { layout: CUSTOM_LAYOUT });
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
  await page.getByRole("button", { name: "Toggle edit lock" }).click();

  const east = page.locator('section[data-pane="player"] .rz-e');
  await expect(east).toHaveAttribute("role", "slider");
  await expect(east).toHaveAttribute("aria-label", "Player resize right edge");
  await expect(east).toHaveAttribute("aria-valuenow", "340");
  await expect(east).toHaveAttribute("aria-orientation", "horizontal");
  const corner = page.locator('section[data-pane="player"] .rz-se');
  await expect(corner).toHaveAttribute("aria-label", "Player resize bottom right corner");
  await expect(corner).toHaveAttribute("aria-valuetext", "340 by 230 pixels");

  await east.focus();
  // Visible focus ring (handles are divs, outside the generic button rule).
  const outline = await east.evaluate((el) => getComputedStyle(el).outlineWidth);
  expect(outline).toBe("2px");

  await page.keyboard.press("ArrowRight");
  await expect(east).toHaveAttribute("aria-valuenow", "348");
  expect(await playerBox(page)).toMatchObject({ w: 348 });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("snapify-layout-v3")!));
  expect(saved.panes.find((p) => p.type === "player")).toMatchObject({ w: 348 });
});
