import { test, expect } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";
import { MINIMAL_LAYOUT } from "./fixtures";

// Track C (zomboid-windowed): the overlay window is a maximized fullscreen
// surface, but a windowed game (or any OS shrink / resolution switch) can
// leave the live window smaller than the stored layout. Drag/clamp must use
// the REAL current window size at both windowed sizes, and a post-boot
// shrink must pull stranded panes back on-screen (boot already clamps;
// runtime resize never did).

async function paneBox(page) {
  return page.locator('section[data-pane="player"]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });
}

async function dragHandleTo(page, dx: number, dy: number) {
  const pane = page.locator('section[data-pane="player"]');
  // Aim at the title text: the handle center can sit on the opacity slider
  // (which stopPropagations its own pointerdown), so center-drag never grabs.
  const title = pane.locator(".pane-title");
  const start = await title.boundingBox();
  if (!start) throw new Error("pane title has no box");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + dx, start.y + start.height / 2 + dy, {
    steps: 15,
  });
  await page.mouse.up();
}

async function latestRegions(page) {
  const all = await commandsNamed(page, "set_overlay_regions");
  const last = all[all.length - 1] as unknown as
    | { regions: Array<{ x: number; y: number; w: number; h: number }> }
    | undefined;
  return last?.regions ?? [];
}

test("windowed 1280x720: pane roams the full overlay surface, regions follow", async ({
  page,
}) => {
  await stubTauri(page, { layout: MINIMAL_LAYOUT });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
  await page.getByRole("button", { name: "Toggle edit lock" }).click();

  // The stage itself is the live window: no assumed/maximized rect.
  const stage = await page.evaluate(() => {
    const r = document.querySelector(".stage")!.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), vw: window.innerWidth, vh: window.innerHeight };
  });
  expect(stage.w).toBe(stage.vw);
  expect(stage.h).toBe(stage.vh);

  // Far corner: the clamp must let the pane reach the true window edge,
  // not strand it inside a smaller assumed box. The pointer itself cannot
  // leave the window (same as the maximized overlay: the cursor stops at
  // the screen edge), so the gesture stays inside viewport coords.
  await dragHandleTo(page, 1000, 460);
  await expect
    .poll(async () => paneBox(page), { timeout: 5000 })
    .toMatchObject({ x: 1280 - 340, y: 720 - 236 });

  // Reported hit-regions cover the landed pane (no region/viewport drift).
  const box = await paneBox(page);
  await expect
    .poll(
      async () => {
        const regs = await latestRegions(page);
        return regs.some(
          (rg) =>
            rg.x <= box.x + 1 &&
            rg.y <= box.y + 1 &&
            rg.x + rg.w >= box.x + box.w - 1 &&
            rg.y + rg.h >= box.y + box.h - 1,
        );
      },
      { timeout: 10000 },
    )
    .toBe(true);
});

test("fullscreen 1920x1080: pane roams the full overlay surface", async ({ page }) => {
  await stubTauri(page, { layout: MINIMAL_LAYOUT });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
  await page.getByRole("button", { name: "Toggle edit lock" }).click();

  await dragHandleTo(page, 1600, 820);
  await expect
    .poll(async () => paneBox(page), { timeout: 5000 })
    .toMatchObject({ x: 1920 - 340, y: 1080 - 236 });
});

// Repro for the friend's windowed-game report: the OS window shrinks after
// boot (resolution switch, un-maximize, windowed game on a big monitor) and
// the stored layout is suddenly bigger than the live window. Boot clamps;
// a runtime shrink left panes stranded off-screen where no drag can reach
// them, so the overlay "thinks the screen is smaller" forever.
const FAR_CORNER_LAYOUT = {
  version: 3,
  preset: "custom",
  panes: [
    {
      id: "player",
      type: "player",
      x: 1500,
      y: 800,
      w: 340,
      h: 236,
      opacity: 0.92,
      visible: true,
      z: 1,
    },
  ],
};

test("runtime shrink pulls a stranded pane fully on-screen and persists", async ({
  page,
}) => {
  await stubTauri(page, { layout: FAR_CORNER_LAYOUT });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();

  // Legal at 1920x1080: the far-corner seed survives boot untouched.
  expect(await paneBox(page)).toMatchObject({ x: 1500, y: 800 });

  // The window shrinks at runtime (no reload): the pane must follow it in.
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect
    .poll(async () => paneBox(page), { timeout: 8000 })
    .toMatchObject({ x: 1280 - 340, y: 720 - 236 });

  // The rescue persists through the scene doc, like the boot clamp does.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("snapify-layout-v3")!));
  expect(saved.scenes[saved.activeScene].panes.find((p) => p.type === "player")).toMatchObject({
    x: 1280 - 340,
    y: 720 - 236,
  });

  // Growing back never teleports an interior pane elsewhere.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(800);
  expect(await paneBox(page)).toMatchObject({ x: 1280 - 340, y: 720 - 236 });
});
