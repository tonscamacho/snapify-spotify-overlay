// uiScale strand repro: a 420-wide PROFILE at x=1440 is legal at k=1
// (right 1860 <= 1920) but the 1.25 zoom wrapper paints x=1800 w=525
// (right 2325, 405px clipped) with no resize to trigger the resize clamp.
// The uiScale effect re-clamps into the shrunken effective stage, so every
// arm asserts the shared positioning invariants from ./geometry: pane
// inside the viewport, top chrome centered, regions tight to paint.
import { test, expect, type Page } from "@playwright/test";
import { stubTauri } from "./tauri-mock";
import {
  assertNotchCentered,
  assertPaneWithinStage,
  assertRegionTight,
  paneBox,
} from "./geometry";

test.use({ viewport: { width: 1920, height: 1080 } });

const STRAND_LAYOUT = {
  version: 3,
  preset: "custom",
  panes: [
    {
      id: "profile",
      type: "profile",
      x: 1440,
      y: 24,
      w: 420,
      h: 560,
      opacity: 0.92,
      visible: true,
      z: 1,
    },
  ],
};

async function dismissCoach(page: Page) {
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
}

/** notchHover:true parks the dock behind the pill; hover reveals it. */
async function openSettings(page: Page) {
  const notch = page.locator(".notch");
  await expect(notch).toBeVisible();
  const nb = await notch.boundingBox();
  if (!nb) throw new Error("notch has no box");
  await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
  await expect(page.locator(".dock")).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function setUiScale125(page: Page, dialog: ReturnType<Page["locator"]>) {
  const scale = dialog.getByLabel("UI scale");
  await scale.focus();
  await page.keyboard.press("End");
  await expect(scale).toHaveAttribute("aria-valuetext", "130 percent");
  for (let i = 0; i < 5; i += 1) await page.keyboard.press("ArrowLeft");
  await expect(scale).toHaveAttribute("aria-valuetext", "125 percent");
}

test("boot at persisted 125% clamps the strand layout inside the stage", async ({
  page,
}) => {
  await stubTauri(page, { layout: STRAND_LAYOUT, edit: true, notchHover: true });
  // Persisted pref (snapify-ui-scale): boot clamps with the real k, not 1.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("snapify-ui-scale", "1.25");
    } catch {
      // Private mode: the load path still defaults to 1.
    }
  });
  await page.goto("/");
  await dismissCoach(page);

  // Logical x=1116 (1536 - 420) paints x=1395 w=525, right exactly 1920.
  const box = await assertPaneWithinStage(page, "profile");
  expect(box).toMatchObject({ x: 1395, w: 525 });
  await assertNotchCentered(page);
  await assertRegionTight(page, box, { tolerance: 2 });
});

test("raising UI scale to 125% re-clamps panes inside the stage", async ({
  page,
}) => {
  await stubTauri(page, { layout: STRAND_LAYOUT, edit: true, notchHover: true });
  await page.goto("/");
  await dismissCoach(page);

  // Control: legal at k=1, painted 1:1.
  expect(await paneBox(page, "profile")).toMatchObject({ x: 1440, w: 420 });

  const dialog = await openSettings(page);
  await setUiScale125(page, dialog);
  expect(await page.evaluate(() => localStorage.getItem("snapify-ui-scale"))).toBe(
    "1.25",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Back to the collapsed pill, then wait out the 250 ms clamp settle.
  await page.mouse.move(960, 600);
  await expect(page.locator(".notch")).toBeVisible();
  await expect
    .poll(
      async () => {
        const b = await paneBox(page, "profile");
        return b.x + b.w;
      },
      { timeout: 10000 },
    )
    .toBeLessThanOrEqual(1921.5);

  const box = await assertPaneWithinStage(page, "profile");
  await assertNotchCentered(page);
  await assertRegionTight(page, box, { tolerance: 2 });
});

test.describe("devicePixelRatio 1.5", () => {
  test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1.5 });

  test("boot at 125% keeps regions tight to the painted pane", async ({
    page,
  }) => {
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1.5);
    await stubTauri(page, { layout: STRAND_LAYOUT, edit: true, notchHover: true });
    await page.addInitScript(() => {
      try {
        localStorage.setItem("snapify-ui-scale", "1.25");
      } catch {
        // Private mode: the load path still defaults to 1.
      }
    });
    await page.goto("/");
    await dismissCoach(page);

    const box = await assertPaneWithinStage(page, "profile");
    await assertNotchCentered(page);
    await assertRegionTight(page, box, { tolerance: 2 });
  });
});
