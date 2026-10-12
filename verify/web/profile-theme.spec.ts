// Profile theme matrix (Batch 2c): the profile pane holds the overlay chrome
// invariants across every theme x surface (transparent root, clipped pane
// backgrounds, one scrollport) and stays compact-clean at its minimum size.
import { test, expect, type Page } from "@playwright/test";
import { stubTauri } from "./tauri-mock";
import { PROFILE_ME_NAME } from "./fixtures";

const THEMES = ["dark", "light", "sparkles", "pastel"] as const;
const SURFACES = ["solid", "glass"] as const;

const PROFILE_LAYOUT = {
  version: 3,
  preset: "custom",
  panes: [
    { id: "profile", type: "profile", x: 24, y: 24, w: 420, h: 560, opacity: 1, visible: true, collapsed: false, z: 1 },
  ],
};

async function bootProfileAt(page: Page, theme: string, surface: string) {
  await stubTauri(page, { layout: PROFILE_LAYOUT, edit: true });
  await page.addInitScript(
    ({ theme, surface }) => {
      try {
        localStorage.setItem("snapify-theme", theme);
        localStorage.setItem("snapify-surface", surface);
      } catch { /* private mode: prefs last the session */ }
    },
    { theme, surface },
  );
  await page.goto("/");
  await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
  await expect(page.locator(".app")).toHaveAttribute("data-surface", surface);
  const profile = page.locator('section[data-pane="profile"]');
  await expect(profile).toBeVisible();
  await expect(profile.locator(".detail-head .detail-title")).toContainText(PROFILE_ME_NAME);
  return profile;
}

test("profile holds chrome invariants across every theme x surface", async ({ page }) => {
  for (const theme of THEMES) {
    for (const surface of SURFACES) {
      const profile = await bootProfileAt(page, theme, surface);

      // Transparent root: no fullscreen wash in any theme/surface.
      expect(
        await page.locator(".app").evaluate((el) => getComputedStyle(el).backgroundColor),
      ).toBe("rgba(0, 0, 0, 0)");
      // Pane backgrounds stay clipped inside the radius (halo invariant).
      expect(await profile.evaluate((el) => getComputedStyle(el).backgroundClip)).toBe(
        "padding-box",
      );

      // Single scroller: the pane body owns the scrollport; tiles, genre
      // chips, clock dials, and tops lists add no nested one.
      const nested = await profile.evaluate((el) => {
        const out: string[] = [];
        for (const n of Array.from(el.querySelectorAll("*"))) {
          const h = n as HTMLElement;
          if (h.classList.contains("pane-body")) continue;
          const oy = getComputedStyle(h).overflowY;
          if (oy === "auto" || oy === "scroll") {
            out.push(`${h.tagName}.${String(h.className ?? "")}`);
          }
        }
        return out;
      });
      expect(nested).toEqual([]);

      await page.screenshot({ path: `verify/web/test-results/profile-${theme}-${surface}.png` });
    }
  }
});

test("profile at its minimum size flags compact and keeps the header", async ({ page }) => {
  await stubTauri(page, {
    layout: {
      version: 3,
      preset: "custom",
      panes: [
        { id: "profile", type: "profile", x: 24, y: 24, w: 320, h: 420, opacity: 1, visible: true, collapsed: false, z: 1 },
      ],
    },
    edit: true,
  });
  await page.goto("/");
  const profile = page.locator('section[data-pane="profile"]');
  await expect(profile).toBeVisible();
  // 320 < 360: below the compact width breakpoint.
  await expect(profile).toHaveAttribute("data-compact", "true");
  await expect(profile.locator(".detail-head .detail-title")).toContainText(PROFILE_ME_NAME);
  await expect(profile.getByText("Stats", { exact: true })).toBeVisible();
  await page.screenshot({ path: "verify/web/test-results/profile-compact.png" });
});
