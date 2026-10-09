import { test, expect, type Page } from "@playwright/test";
import { stubTauri } from "./tauri-mock";

// Pastel + glass surface matrix (2.5.4 Track A): candy washes used to beat
// the glass base (opaque, specificity 0,4,0 over 0,3,0), the glass tokens
// stayed dark navy (fragmented dock/modal), browse had no wash at all,
// and opaque inner surfaces (sticky headers, search, device well) covered
// the blur. The fix adds warm-cream + per-pane tinted scrims at >=
// (0,4,0) with translucent inner surfaces; solid pastel and
// dark/light/sparkles stay pixel-identical.

const THEMES = ["dark", "light", "sparkles", "pastel", "neo-light", "neo-dark"] as const;
const SURFACES = ["solid", "glass"] as const;

// All five panes visible at once so every wash/scrim resolves in one DOM.
const FULL_LAYOUT = {
  version: 3,
  preset: "custom",
  panes: [
    { id: "player", type: "player", x: 24, y: 24, w: 340, h: 236, opacity: 1, visible: true, collapsed: false, z: 1 },
    { id: "queue", type: "queue", x: 376, y: 24, w: 300, h: 236, opacity: 1, visible: true, collapsed: false, z: 2 },
    { id: "visualizer", type: "visualizer", x: 688, y: 24, w: 300, h: 200, opacity: 1, visible: true, collapsed: false, z: 3 },
    { id: "lyrics", type: "lyrics", x: 24, y: 272, w: 420, h: 360, opacity: 1, visible: true, collapsed: false, z: 4 },
    { id: "browse", type: "browse", x: 456, y: 272, w: 400, h: 400, opacity: 1, visible: true, collapsed: false, z: 5 },
  ],
};

async function bootAt(page: Page, theme: string, surface: string) {
  await stubTauri(page, { layout: FULL_LAYOUT, edit: true });
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
  await expect(page.locator(".stage")).toBeVisible();
}

async function bgOf(page: Page, sel: string): Promise<string | null> {
  return page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    return el ? getComputedStyle(el).backgroundColor : null;
  }, sel);
}

function alphaOf(bg: string): number {
  const m = bg.match(/rgba?\(([^)]+)\)/);
  if (!m) return 1;
  const parts = m[1].split(",").map((s) => s.trim());
  return parts.length === 4 ? Number(parts[3]) : 1;
}

function rgbOf(bg: string): [number, number, number] {
  const m = bg.match(/rgba?\(([^)]+)\)/);
  if (!m) return [0, 0, 0];
  const parts = m[1].split(",").map((s) => Number(s.trim()));
  return [parts[0], parts[1], parts[2]];
}

test("matrix renders every theme x surface and captures screenshots", async ({ page }) => {
  for (const theme of THEMES) {
    for (const surface of SURFACES) {
      await bootAt(page, theme, surface);
      await expect(page.locator('section[data-pane="player"]')).toBeVisible();
      await expect(page.locator(".dock")).toBeVisible();
      await page.screenshot({ path: `docs/bug-reports/2.5.4/theme-${theme}-${surface}.png` });
    }
  }
});

test("pastel glass uses warm-cream scrim and tinted scrims, panes+dock+modal agree", async ({ page }) => {
  await bootAt(page, "pastel", "glass");
  const player = await bgOf(page, 'section[data-pane="player"]');
  const lyrics = await bgOf(page, 'section[data-pane="lyrics"]');
  const queue = await bgOf(page, 'section[data-pane="queue"]');
  const visualizer = await bgOf(page, 'section[data-pane="visualizer"]');
  const browse = await bgOf(page, 'section[data-pane="browse"]');
  const dock = await bgOf(page, ".dock");
  for (const bg of [player, lyrics, queue, visualizer, browse, dock]) {
    expect(bg).not.toBeNull();
    const a = alphaOf(bg!);
    expect(a).toBeGreaterThan(0.4);
    expect(a).toBeLessThan(0.85);
    // The old dark-navy glass base must be gone everywhere.
    expect(bg!.replace(/\s+/g, "")).not.toContain("20,24,32");
  }
  // Tinted twins of the solid candy washes: pink player, warm dock.
  const [pr, pg, pb] = rgbOf(player!);
  expect(pr).toBeGreaterThan(240);
  expect(pg).toBeGreaterThan(220);
  expect(pb).toBeGreaterThan(220);
  const [dr, dg, db] = rgbOf(dock!);
  expect(dr).toBeGreaterThan(245);
  expect(dg).toBeGreaterThan(225);
  expect(db).toBeGreaterThan(190);
  // Cocoa text stays legible over the light scrims.
  const titleColor = await page.evaluate(() => {
    const el = document.querySelector(".track-title") as HTMLElement | null;
    return el ? getComputedStyle(el).color : null;
  });
  expect(titleColor).toBe("rgb(68, 55, 40)");
  // Modal agrees: warm translucent, never the dark scrim.
  await page.getByRole("button", { name: "Open settings" }).click();
  const modal = await bgOf(page, ".modal");
  expect(modal).not.toBeNull();
  expect(alphaOf(modal!)).toBeLessThan(0.85);
  expect(modal!.replace(/\s+/g, "")).not.toContain("20,24,32");
  await page.screenshot({ path: "docs/bug-reports/2.5.4/theme-pastel-glass-modal.png" });
});

test("pastel glass clears opaque overrides so the blur shows through", async ({ page }) => {
  await bootAt(page, "pastel", "glass");
  // Every pastel-glass background rule carries >= (0,4,0): the five
  // per-pane scrims plus dock plus modal must all be present.
  const selectors = await page.evaluate(() => {
    const found: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try {
        rules = (sheet as CSSStyleSheet).cssRules;
      } catch { continue; }
      for (const r of Array.from(rules)) {
        if (r.cssText.includes('[data-theme="pastel"][data-surface="glass"]')) found.push(r.cssText);
      }
    }
    return found;
  });
  for (const pane of ["player", "lyrics", "queue", "visualizer", "browse"]) {
    expect(selectors.some((c) => c.includes(`.pane[data-pane="${pane}"]`))).toBe(true);
  }
  expect(selectors.some((c) => c.includes(".dock"))).toBe(true);
  expect(selectors.some((c) => c.includes(".modal"))).toBe(true);
  // Sticky headers ride a near-opaque frosted twin of their pane tint so
  // scrolled lines slide under the bar instead of ghosting through text.
  const tabs = await bgOf(page, ".browse-tabs");
  expect(tabs).not.toBeNull();
  expect(alphaOf(tabs!)).toBeGreaterThan(0.8);
  const lyricsMeta = await bgOf(page, ".lyrics-meta");
  expect(lyricsMeta).not.toBeNull();
  expect(alphaOf(lyricsMeta!)).toBeGreaterThan(0.8);
  // Search + device well turn translucent instead of opaque cream.
  await page.getByRole("button", { name: "Open settings" }).click();
  const well = await bgOf(page, ".settings-device");
  expect(well).not.toBeNull();
  expect(alphaOf(well!)).toBeLessThan(1);
});

test("solid pastel keeps opaque candy washes including browse", async ({ page }) => {
  await bootAt(page, "pastel", "solid");
  expect(await bgOf(page, 'section[data-pane="player"]')).toBe("rgb(252, 238, 241)");
  expect(await bgOf(page, 'section[data-pane="lyrics"]')).toBe("rgb(234, 246, 237)");
  expect(await bgOf(page, 'section[data-pane="queue"]')).toBe("rgb(252, 243, 216)");
  expect(await bgOf(page, 'section[data-pane="visualizer"]')).toBe("rgb(239, 233, 250)");
  expect(await bgOf(page, 'section[data-pane="browse"]')).toBe("rgb(233, 241, 251)");
  expect(await bgOf(page, ".dock")).toBe("rgb(253, 240, 213)");
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.screenshot({ path: "docs/bug-reports/2.5.4/theme-pastel-solid-modal.png" });
});

test("neo themes render matte base, dual shadows, and passing focus", async ({ page }) => {
  await bootAt(page, "neo-light", "solid");
  expect(await bgOf(page, 'section[data-pane="player"]')).toBe("rgb(224, 229, 236)");
  const lightRadius = await page.evaluate(() => {
    const el = document.querySelector('section[data-pane="player"]') as HTMLElement | null;
    return el ? getComputedStyle(el).borderRadius : null;
  });
  expect(lightRadius).toBe("20px");
  const lightShadow = await page.evaluate(() => {
    const el = document.querySelector('section[data-pane="player"]') as HTMLElement | null;
    return el ? getComputedStyle(el).boxShadow : null;
  });
  expect(lightShadow).not.toBeNull();
  expect(lightShadow!.replace(/\s+/g, "")).toContain("163,177,198");
  await bootAt(page, "neo-dark", "solid");
  expect(await bgOf(page, 'section[data-pane="player"]')).toBe("rgb(42, 45, 52)");
  const darkShadow = await page.evaluate(() => {
    const el = document.querySelector('section[data-pane="player"]') as HTMLElement | null;
    return el ? getComputedStyle(el).boxShadow : null;
  });
  expect(darkShadow).not.toBeNull();
  expect(darkShadow!.replace(/\s+/g, "")).toContain("0,0,0,0.5");
  // Prototype-measured focus tokens ship as spec assertions.
  const rules = await page.evaluate(() => {
    const found: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let css: CSSRuleList | null = null;
      try {
        css = (sheet as CSSStyleSheet).cssRules;
      } catch { continue; }
      for (const r of Array.from(css)) found.push(r.cssText);
    }
    return found.join("\n");
  });
  expect(rules).toContain("#005bd1");
  expect(rules).toContain("--neu-inset");
  await page.screenshot({ path: "docs/bug-reports/2.5.4/theme-neo-solid.png" });
});

test("neo disables glass: opaque base with no backdrop even when opted in", async ({ page }) => {
  await bootAt(page, "neo-light", "glass");
  const player = await bgOf(page, 'section[data-pane="player"]');
  expect(player).not.toBeNull();
  expect(alphaOf(player!)).toBe(1);
  const backdrop = await page.evaluate(() => {
    const el = document.querySelector('section[data-pane="player"]') as HTMLElement | null;
    return el ? getComputedStyle(el).backdropFilter : null;
  });
  expect(backdrop === "none" || backdrop === "").toBe(true);
});

test("dark, light, and sparkles stay intact", async ({ page }) => {
  await bootAt(page, "dark", "solid");
  expect(await bgOf(page, 'section[data-pane="player"]')).toBe("rgb(23, 23, 26)");
  await bootAt(page, "light", "solid");
  expect(await bgOf(page, 'section[data-pane="player"]')).toBe("rgb(255, 255, 255)");
  await bootAt(page, "sparkles", "solid");
  expect(await bgOf(page, 'section[data-pane="player"]')).toBe("rgb(11, 19, 48)");
  // No pastel pink leaks into the other presets.
  for (const theme of ["dark", "light", "sparkles"] as const) {
    await bootAt(page, theme, "solid");
    expect(await bgOf(page, 'section[data-pane="player"]')).not.toBe("rgb(252, 238, 241)");
  }
});

test("pastel glass selectable from Settings surface controls", async ({ page }) => {
  await stubTauri(page, { layout: FULL_LAYOUT, edit: true });
  await page.goto("/");
  await expect(page.locator(".stage")).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: "pastel", exact: true }).click();
  await dialog.getByRole("group", { name: "Surface", exact: true }).getByRole("button", { name: "glass", exact: true }).click();
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "pastel");
  await expect(page.locator(".app")).toHaveAttribute("data-surface", "glass");
  expect(await page.evaluate(() => localStorage.getItem("snapify-theme"))).toBe("pastel");
  expect(await page.evaluate(() => localStorage.getItem("snapify-surface"))).toBe("glass");
  const player = await bgOf(page, 'section[data-pane="player"]');
  expect(player).not.toBeNull();
  expect(alphaOf(player!)).toBeLessThan(1);
});

test("neo-light selectable from Settings theme controls", async ({ page }) => {
  await stubTauri(page, { layout: FULL_LAYOUT, edit: true });
  await page.goto("/");
  await expect(page.locator(".stage")).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: "neo-light", exact: true }).click();
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "neo-light");
  expect(await page.evaluate(() => localStorage.getItem("snapify-theme"))).toBe("neo-light");
  expect(await bgOf(page, 'section[data-pane="player"]')).toBe("rgb(224, 229, 236)");
});
