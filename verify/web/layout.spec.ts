import { test, expect } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";
import { MINIMAL_LAYOUT, buildFixtures } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await stubTauri(page, { layout: MINIMAL_LAYOUT });
  await page.goto("/");
});

test("cycle preset swaps the visible pane set", async ({ page }) => {
  await expect(page.locator('section[data-pane="player"]')).toBeVisible();
  await expect(page.locator('section[data-pane="queue"]')).toHaveCount(0);

  // Slim dock: the cycle control lives in Settings and commits immediately.
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Next preset" }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

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
  expect(saved.version).toBe(4);
  expect(saved.scenes[saved.activeScene].preset).toBe("custom");
  expect(saved.scenes[saved.activeScene].panes.find((p) => p.type === "player")).toMatchObject(before);
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
  expect(saved.scenes[saved.activeScene].preset).toBe("custom");
  expect(saved.scenes[saved.activeScene].panes.find((p) => p.type === "player")).toMatchObject(before);
  expect(saved.scenes[saved.activeScene].panes.some((p) => p.type === "browse" && p.visible)).toBe(true);
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
  expect(saved.scenes[saved.activeScene].preset).toBe("minimal");
  expect(saved.scenes[saved.activeScene].panes.some((p) => p.type === "lyrics")).toBe(false);

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
  expect(saved.scenes[saved.activeScene].preset).toBe("full");
  expect(saved.scenes[saved.activeScene].panes.some((p) => p.type === "queue")).toBe(true);
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
  expect(saved.scenes[saved.activeScene].preset).toBe("minimal");
});

test("Reset still restores the default arrangement", async ({ page }) => {
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.locator("div.row", { hasText: "Layout" }).getByRole("button").click();
  await expect(page.locator('section[data-pane="player"]')).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("snapify-layout-v3")!));
  expect(saved.scenes[saved.activeScene].panes.length).toBeGreaterThan(0);
  expect(saved.scenes[saved.activeScene].preset).toBe("full");
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
  for (const want of ["Hide", "Edit", "Pass", "Undo", "Settings", "Done", "Close"]) {
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

// Coach-pill region gap (PR1 fold-in): the pill is in the interactive-mode
// regions, so it is clickable when visible. Passive click-through is intact
// by construction (Rust ignores regions unless interactive + the window
// starts with ignoreCursorEvents), and the empty-stage spec in
// overlay-passthrough covers the passthrough geometry.
test("coach pill is topmost under its center and covered by reported regions", async ({
  page,
}) => {
  const pill = page.getByRole("button", { name: "Dismiss shortcut hint" });
  await expect(pill).toBeVisible();

  const box = await pill.boundingBox();
  if (!box) throw new Error("coach pill has no box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Interactive mode (seeded): the pill itself wins hit-testing at its center.
  const hit = await page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!el) return "none";
      return el.closest(".hint-chip")
        ? "pill"
        : `${el.tagName}.${String(el.className ?? "")}`;
    },
    { x: cx, y: cy },
  );
  expect(hit).toBe("pill");

  // And the reported hit-regions cover the pill, so Rust makes it clickable.
  await expect
    .poll(async () => (await commandsNamed(page, "set_overlay_regions")).length, {
      timeout: 10000,
    })
    .toBeGreaterThan(0);
  const reports = await commandsNamed(page, "set_overlay_regions");
  const last = reports[reports.length - 1] as unknown as {
    regions: Array<{ x: number; y: number; w: number; h: number }>;
  };
  const covers = (last.regions ?? []).some(
    (rg) =>
      rg.x <= box.x + 2 &&
      rg.y <= box.y + 2 &&
      rg.x + rg.w >= box.x + box.width - 2 &&
      rg.y + rg.h >= box.y + box.height - 2,
  );
  expect(covers).toBe(true);
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
  expect(saved.scenes[saved.activeScene].preset).toBe("custom");
  expect(saved.scenes[saved.activeScene].panes.find((p) => p.type === "player")).toMatchObject({ x: before.x + 8, y: 150 });

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
  expect(saved.scenes[saved.activeScene].panes.find((p) => p.type === "player")).toMatchObject({ w: 348, h: 236 });
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
  expect(saved.scenes[saved.activeScene].panes.find((p) => p.type === "player")).toMatchObject({ w: 348 });
});

const SCENES_V4 = {
  version: 4,
  activeScene: "game",
  scenes: {
    game: {
      preset: "minimal",
      panes: [
        { id: "player", type: "player", x: 24, y: 24, w: 340, h: 236, opacity: 0.92, visible: true, z: 1 },
      ],
    },
    focus: {
      preset: "lyrics",
      panes: [
        { id: "lyrics", type: "lyrics", x: 24, y: 24, w: 420, h: 380, opacity: 0.92, visible: true, z: 1 },
        { id: "player", type: "player", x: 24, y: 416, w: 420, h: 190, opacity: 0.92, visible: true, z: 2 },
      ],
    },
    stream: {
      preset: "full",
      panes: [
        { id: "player", type: "player", x: 24, y: 24, w: 340, h: 236, opacity: 0.92, visible: true, z: 1 },
        { id: "queue", type: "queue", x: 376, y: 24, w: 300, h: 236, opacity: 0.92, visible: true, z: 2 },
      ],
    },
  },
};

test("Game/Focus/Stream swap per-scene geometry and persist it", async ({ page }) => {
  await stubTauri(page, { layout: SCENES_V4 });
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();

  // Game: player only. Slim dock: scenes live in the Settings Scene seg.
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const scenes = dialog.getByRole("group", { name: "Scene" });
  await expect(page.locator('section[data-pane="player"]')).toBeVisible();
  await expect(page.locator('section[data-pane="lyrics"]')).toHaveCount(0);
  await expect(page.locator('section[data-pane="queue"]')).toHaveCount(0);

  // Focus swaps in its own arrangement.
  await scenes.getByRole("button", { name: "Focus", exact: true }).click();
  await expect(page.locator('section[data-pane="lyrics"]')).toBeVisible();
  await expect(scenes.getByRole("button", { name: "Focus", exact: true })).toHaveAttribute("aria-pressed", "true");
  let saved = await page.evaluate(() => JSON.parse(localStorage.getItem("snapify-layout-v3")!));
  expect(saved.version).toBe(4);
  expect(saved.activeScene).toBe("focus");

  // Per-scene divergence: hide the player in Focus only. The dock chip sits
  // behind the modal overlay, so close Settings first.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByTitle("Toggle Player pane").click();
  await expect(page.locator('section[data-pane="player"]')).toHaveCount(0);

  // Game still has its player; back in Focus the player stays hidden.
  await page.getByRole("button", { name: "Open settings" }).click();
  await scenes.getByRole("button", { name: "Game", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator('section[data-pane="player"]')).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  await scenes.getByRole("button", { name: "Focus", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator('section[data-pane="player"]')).toHaveCount(0);

  saved = await page.evaluate(() => JSON.parse(localStorage.getItem("snapify-layout-v3")!));
  expect(saved.scenes.focus.panes.find((p) => p.type === "player").visible).toBe(false);
  expect(saved.scenes.game.panes.find((p) => p.type === "player").visible).toBe(true);

  // The active scene survives reload.
  await stubTauri(page, { layout: JSON.parse(JSON.stringify(saved)) });
  await page.reload();
  await expect(page.locator('section[data-pane="lyrics"]')).toBeVisible();
  await expect(page.locator('section[data-pane="player"]')).toHaveCount(0);
  const reloaded = await page.evaluate(() => JSON.parse(localStorage.getItem("snapify-layout-v3")!));
  expect(reloaded.activeScene).toBe("focus");
});

test("stored v3 migrates into every v4 scene", async ({ page }) => {
  await stubTauri(page, { layout: CUSTOM_LAYOUT });
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();

  // The v3 seed upgrades to a v4 doc on boot, parked on Game, with the
  // custom arrangement seeded into every scene.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("snapify-layout-v3")!));
  expect(saved.version).toBe(4);
  expect(saved.activeScene).toBe("game");
  for (const s of ["game", "focus", "stream"]) {
    expect(saved.scenes[s].preset).toBe("custom");
    expect(saved.scenes[s].panes.find((p) => p.type === "player")).toMatchObject({ x: 100, y: 150 });
  }
  expect(await playerBox(page)).toEqual({ x: 100, y: 150, w: 340, h: 230 });
});

test("pause auto-hide hides the stage after 2.5s; resume restores; Dim ghosts", async ({ page }) => {
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
  const app = page.locator(".app");
  const player = page.locator('section[data-pane="player"]');

  // Slim dock: Auto-hide/Dim live in Settings now, scoped to the modal.
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  const autoHide = dialog.getByLabel("Auto-hide on pause");
  const dim = dialog.getByLabel("Dim instead of hiding");
  await expect(dim).toBeDisabled();
  await autoHide.check();
  await expect(autoHide).toBeChecked();
  await expect(dim).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Seeded playing: pause, wait out the fixed delay, the stage hides.
  await player.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(player.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(app).toHaveAttribute("data-stream", "hidden", { timeout: 8000 });

  // Resume restores instantly.
  await player.getByRole("button", { name: "Play", exact: true }).click();
  await expect(app).not.toHaveAttribute("data-stream", "hidden");

  // The toggle persists outside scene geometry.
  expect(await page.evaluate(() => localStorage.getItem("snapify-stream"))).toBe(
    JSON.stringify({ hideOnPause: true, dimInstead: false }),
  );

  // Dim ghosts instead of hiding.
  await page.getByRole("button", { name: "Open settings" }).click();
  await dim.check();
  await expect(dim).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await player.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(app).toHaveAttribute("data-stream", "dimmed", { timeout: 8000 });
});

const BROWSE_NARROW_LAYOUT = {
  version: 3,
  preset: "custom",
  panes: [
    {
      id: "player",
      type: "player",
      x: 24,
      y: 24,
      w: 340,
      h: 230,
      opacity: 0.92,
      visible: true,
      z: 1,
    },
    {
      id: "browse",
      type: "browse",
      x: 376,
      y: 24,
      w: 320,
      h: 480,
      opacity: 0.92,
      visible: true,
      z: 2,
    },
  ],
};

test("narrow browse shows a section select; lists skip off-screen paint", async ({ page }) => {
  await stubTauri(page, { layout: BROWSE_NARROW_LAYOUT });
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();

  // The browse pane needs revealing: the narrow layout seeds it visible.
  const browse = page.locator('section[data-pane="browse"]');
  await expect(browse).toBeVisible();

  // Under a 380 px container the library tab buttons are gone and the
  // select shows instead (the narrow layout seeds the pane visible).
  await expect(browse.getByLabel("Library section")).toBeVisible();
  await expect(browse.locator(".lib-tab")).toHaveCount(0);
  // The wider tablist shell (Library/Search/Profile) is still in the tree.
  await expect(browse.locator('[role="tablist"]')).toBeVisible();

  // The select drives the same section state.
  await browse.getByLabel("Library section").selectOption("tracks");
  await expect(browse.getByLabel("Library section")).toHaveValue("tracks");

  // Headless no-jank assertion: long lists carry content-visibility.
  const cv = await browse
    .locator("ol.queue")
    .first()
    .evaluate((el) => getComputedStyle(el).contentVisibility);
  expect(cv).toBe("auto");
});
