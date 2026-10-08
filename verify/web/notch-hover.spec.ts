import { test, expect } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";
import { MINIMAL_LAYOUT } from "./fixtures";

// Notch autohide (snapify-notch-hover, default on): while editing, the full
// editor dock hides behind a top-center notch until the cursor reaches the
// top edge. Interactive-alone shows panes only (no chrome); passive shows
// the same minus input. The dock is therefore edit-only: Esc / global
// hotkeys / tray remain the way out of interactive (no stranding).

async function dismissCoach(page) {
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
}

async function notchBox(page) {
  const box = await page.locator(".notch").boundingBox();
  if (!box) throw new Error("notch has no box");
  return box;
}

test("edit mode with autohide on collapses the dock behind a top notch", async ({
  page,
}) => {
  await stubTauri(page, { layout: MINIMAL_LAYOUT, edit: true, notchHover: true });
  await page.goto("/");
  await dismissCoach(page);

  await expect(page.locator(".notch")).toBeVisible();
  await expect(page.locator(".notch-strip")).toBeAttached();
  await expect(page.locator(".dock")).toHaveCount(0);
  // Panes still render under the notch.
  await expect(page.locator('section[data-pane="player"]')).toBeVisible();
});

test("hovering the notch reveals the full dock; leaving collapses it", async ({
  page,
}) => {
  await stubTauri(page, { layout: MINIMAL_LAYOUT, edit: true, notchHover: true });
  await page.goto("/");
  await dismissCoach(page);
  await expect(page.locator(".notch")).toBeVisible();

  // Real mouse onto the pill (clientY ~7 <= 12): the full dock expands.
  const nb = await notchBox(page);
  await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
  const dock = page.locator(".dock");
  await expect(dock).toBeVisible();
  await expect(page.locator(".notch")).toHaveCount(0);

  // The revealed dock joins the reported hit-regions (OS hit-holes follow).
  const dockRect = await dock.boundingBox();
  if (!dockRect) throw new Error("dock has no box");
  await expect
    .poll(
      async () => {
        const all = await commandsNamed(page, "set_overlay_regions");
        const last = all[all.length - 1] as unknown as
          | { regions: Array<{ x: number; y: number; w: number; h: number }> }
          | undefined;
        const regs = last?.regions ?? [];
        return regs.some(
          (rg) =>
            Math.abs(rg.x - dockRect.x) <= 2 &&
            Math.abs(rg.y - dockRect.y) <= 2 &&
            Math.abs(rg.w - dockRect.width) <= 2 &&
            Math.abs(rg.h - dockRect.height) <= 2,
        );
      },
      { timeout: 10000 },
    )
    .toBe(true);

  // Dropping below the toolbar zone collapses back to the notch.
  await page.mouse.move(640, 600);
  await expect(page.locator(".notch")).toBeVisible();
  await expect(dock).toHaveCount(0);
  const nb2 = await notchBox(page);
  await expect
    .poll(
      async () => {
        const all = await commandsNamed(page, "set_overlay_regions");
        const last = all[all.length - 1] as unknown as
          | { regions: Array<{ x: number; y: number; w: number; h: number }> }
          | undefined;
        const regs = last?.regions ?? [];
        return regs.some(
          (rg) =>
            Math.abs(rg.x - nb2.x) <= 2 &&
            Math.abs(rg.y - nb2.y) <= 2 &&
            Math.abs(rg.w - nb2.width) <= 2 &&
            Math.abs(rg.h - nb2.height) <= 2,
        );
      },
      { timeout: 10000 },
    )
    .toBe(true);
});

test("interactive-alone shows panes with no chrome; Esc still exits", async ({
  page,
}) => {
  await stubTauri(page, { layout: MINIMAL_LAYOUT, interact: true });
  await page.goto("/");
  await dismissCoach(page);

  // Panes stay interactive; neither dock nor notch may render.
  await expect(page.locator('section[data-pane="player"]')).toBeVisible();
  await expect(page.locator(".dock")).toHaveCount(0);
  await expect(page.locator(".notch")).toHaveCount(0);
  await expect(page.locator(".notch-strip")).toHaveCount(0);

  // Esc cascades out of interactive (no stranding: panes stay put, chrome
  // stays gone in passive too).
  await page.keyboard.press("Escape");
  await expect(page.locator('section[data-pane="player"]')).toBeVisible();
  await expect(page.locator(".dock")).toHaveCount(0);
  await expect(page.locator(".notch")).toHaveCount(0);
});

test("autohide off keeps the dock pinned; the setting round-trips", async ({
  page,
}) => {
  await stubTauri(page, { layout: MINIMAL_LAYOUT, edit: true });
  await page.goto("/");
  await dismissCoach(page);

  // Seeded off: full dock, no notch.
  await expect(page.locator(".dock")).toBeVisible();
  await expect(page.locator(".notch")).toHaveCount(0);

  // The Settings row flips it on and persists under snapify-notch-hover.
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  const toggle = dialog.getByLabel("Autohide editor toolbar");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  expect(await page.evaluate(() => localStorage.getItem("snapify-notch-hover"))).toBe("1");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".notch")).toBeVisible();
  await expect(page.locator(".dock")).toHaveCount(0);

  // And back off again.
  await page.getByRole("button", { name: "Show editor toolbar" }).click();
  await expect(page.locator(".dock")).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  await dialog.getByLabel("Autohide editor toolbar").uncheck();
  expect(await page.evaluate(() => localStorage.getItem("snapify-notch-hover"))).toBe("0");
  await page.keyboard.press("Escape");
  await expect(page.locator(".dock")).toBeVisible();
  await expect(page.locator(".notch")).toHaveCount(0);
});

test("a missing notch key defaults to autohide on", async ({ page }) => {
  await stubTauri(page, { layout: MINIMAL_LAYOUT, edit: true });
  // Drop the mock seed after it runs so boot sees no key at all.
  await page.addInitScript(() => {
    try {
      localStorage.removeItem("snapify-notch-hover");
    } catch {
      // Private mode: the load path still defaults on.
    }
  });
  await page.goto("/");
  await dismissCoach(page);

  await expect(page.locator(".notch")).toBeVisible();
  await expect(page.locator(".dock")).toHaveCount(0);
});
