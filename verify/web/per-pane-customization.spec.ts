import { test, expect, type Page } from "@playwright/test";
import { stubTauri } from "./tauri-mock";

// Per-pane customization matrix: unset panes render pixel-identical to the
// global theme, bg overrides beat candy/custom washes, one neo pane
// coexists beside global panes, and the glass/sharp/custom conflict
// defaults hold (neo opaque, 20px floor, color-mix derive).

function pane(id: string, type: string, x: number, y: number, w: number, h: number, z: number, style?: Record<string, unknown>) {
  const p: Record<string, unknown> = {
    id, type, x, y, w, h, opacity: 1, visible: true, collapsed: false, z,
  };
  if (style !== undefined) p.style = style;
  return p;
}

const BASE_PANES = [
  pane("player", "player", 24, 24, 340, 236, 1),
  pane("lyrics", "lyrics", 376, 24, 420, 360, 2),
];

function docWith(panes: Record<string, unknown>[]) {
  return { version: 3, preset: "custom", panes };
}

async function bootWith(
  page: Page,
  opts: { theme: string; surface?: string; corners?: string; panes: Record<string, unknown>[] },
) {
  await stubTauri(page, { layout: docWith(opts.panes), edit: true });
  await page.addInitScript(
    ({ theme, surface, corners }) => {
      try {
        localStorage.setItem("snapify-theme", theme);
        localStorage.setItem("snapify-surface", surface);
        localStorage.setItem("snapify-corners", corners);
      } catch { /* private mode: prefs last the session */ }
    },
    { theme: opts.theme, surface: opts.surface ?? "solid", corners: opts.corners ?? "rounded" },
  );
  await page.goto("/");
  await expect(page.locator(".app")).toHaveAttribute("data-theme", opts.theme);
  await expect(page.locator(".stage")).toBeVisible();
}

async function bgOf(page: Page, sel: string): Promise<string | null> {
  return page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    return el ? getComputedStyle(el).backgroundColor : null;
  }, sel);
}

async function cssOf(page: Page, sel: string, prop: string): Promise<string | null> {
  return page.evaluate(
    ({ sel, prop }: { sel: string; prop: string }) =>
      (document.querySelector(sel) as HTMLElement | null)?.style.getPropertyValue(prop) ?? null,
    { sel, prop },
  );
}

test("unset panes carry no override attr and match the global theme", async ({ page }) => {
  await bootWith(page, { theme: "dark", panes: BASE_PANES });
  expect(await page.locator('section[data-pane-id="player"]').getAttribute("data-pane-override")).toBeNull();
  expect(await page.locator('section[data-pane-id="lyrics"]').getAttribute("data-pane-override")).toBeNull();
  expect(await bgOf(page, 'section[data-pane-id="player"]')).toBe("rgb(23, 23, 26)");
  expect(await bgOf(page, 'section[data-pane-id="lyrics"]')).toBe("rgb(23, 23, 26)");
});

test("bg override beats the pastel candy wash while unset siblings keep it", async ({ page }) => {
  await bootWith(page, {
    theme: "pastel",
    panes: [pane("player", "player", 24, 24, 340, 236, 1, { bg: "#ddeeff" }), BASE_PANES[1]],
  });
  expect(await bgOf(page, 'section[data-pane-id="player"]')).toBe("rgb(221, 238, 255)");
  expect(await bgOf(page, 'section[data-pane-id="lyrics"]')).toBe("rgb(234, 246, 237)");
  expect(await page.locator('section[data-pane-id="player"]').getAttribute("data-pane-override")).toBe("true");
});

test("one neo pane coexists beside untouched global panes", async ({ page }) => {
  await bootWith(page, {
    theme: "dark",
    panes: [BASE_PANES[0], pane("lyrics", "lyrics", 376, 24, 420, 360, 2, { theme: "neo-light" })],
  });
  const lyrics = page.locator('section[data-pane-id="lyrics"]');
  await expect(lyrics).toHaveAttribute("data-pane-theme", "neo-light");
  expect(await bgOf(page, 'section[data-pane-id="lyrics"]')).toBe("rgb(224, 229, 236)");
  expect(await bgOf(page, 'section[data-pane-id="player"]')).toBe("rgb(23, 23, 26)");
  const radius = await page.evaluate(() => {
    const el = document.querySelector('section[data-pane-id="lyrics"]') as HTMLElement | null;
    return el ? getComputedStyle(el).borderRadius : null;
  });
  expect(radius).toBe("20px");
  await page.screenshot({ path: "docs/bug-reports/2.5.4/per-pane-mixed-neo.png" });
});

test("radius, shadow, text-style, and surface mappings apply", async ({ page }) => {
  await bootWith(page, {
    theme: "dark",
    panes: [
      pane("player", "player", 24, 24, 340, 236, 1, {
        radius: 24,
        shadow: "sm",
        fontSize: 18,
        textAlign: "center",
        fontWeight: 600,
      }),
      BASE_PANES[1],
    ],
  });
  const player = page.locator('section[data-pane-id="player"]');
  await expect(player).toHaveAttribute("data-pane-shadow", "sm");
  const style = await page.evaluate(() => {
    const el = document.querySelector('section[data-pane-id="player"]') as HTMLElement | null;
    if (!el) return null;
    const c = getComputedStyle(el);
    return { radius: c.borderRadius, align: c.textAlign, size: c.fontSize, shadow: c.boxShadow };
  });
  expect(style).not.toBeNull();
  expect(style!.radius).toBe("24px");
  expect(style!.align).toBe("center");
  expect(style!.size).toBe("18px");
  expect(style!.shadow.replace(/\s+/g, "")).toContain("0,0,0,0.32");
  expect(await cssOf(page, 'section[data-pane-id="player"]', "--pane-weight")).toBe("600");
});

test("per-pane glass opts one pane into translucency under a solid global", async ({ page }) => {
  await bootWith(page, {
    theme: "dark",
    panes: [pane("player", "player", 24, 24, 340, 236, 1, { surface: "glass" }), BASE_PANES[1]],
  });
  await expect(page.locator('section[data-pane-id="player"]')).toHaveAttribute("data-pane-surface", "glass");
  const player = await bgOf(page, 'section[data-pane-id="player"]');
  const lyrics = await bgOf(page, 'section[data-pane-id="lyrics"]');
  const alpha = (bg: string) => {
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const parts = m[1].split(",").map((s) => s.trim());
    return parts.length === 4 ? Number(parts[3]) : 1;
  };
  expect(alpha(player!)).toBeLessThan(1);
  expect(alpha(lyrics!)).toBe(1);
});

test("glass x neo stays opaque with no backdrop", async ({ page }) => {
  await bootWith(page, {
    theme: "dark",
    surface: "glass",
    panes: [BASE_PANES[0], pane("lyrics", "lyrics", 376, 24, 420, 360, 2, { theme: "neo-light", surface: "glass" })],
  });
  const lyrics = await bgOf(page, 'section[data-pane-id="lyrics"]');
  expect(lyrics).not.toBeNull();
  const m = lyrics!.match(/rgba?\(([^)]+)\)/);
  const parts = m ? m[1].split(",").map((s) => s.trim()) : [];
  expect(parts.length === 4 ? Number(parts[3]) : 1).toBe(1);
  const backdrop = await page.evaluate(() => {
    const el = document.querySelector('section[data-pane-id="lyrics"]') as HTMLElement | null;
    return el ? getComputedStyle(el).backdropFilter : null;
  });
  expect(backdrop === "none" || backdrop === "").toBe(true);
});

test("sharp x neo keeps the 20px floor while siblings go sharp", async ({ page }) => {
  await bootWith(page, {
    theme: "dark",
    corners: "sharp",
    panes: [BASE_PANES[0], pane("lyrics", "lyrics", 376, 24, 420, 360, 2, { theme: "neo-dark" })],
  });
  const radii = await page.evaluate(() => {
    const q = (id: string) => {
      const el = document.querySelector(`section[data-pane-id="${id}"]`) as HTMLElement | null;
      return el ? getComputedStyle(el).borderRadius : null;
    };
    return { player: q("player"), lyrics: q("lyrics") };
  });
  expect(radii.player).toBe("0px");
  expect(radii.lyrics).toBe("20px");
});

test("settings per-pane controls set and reset to inherit", async ({ page }) => {
  await bootWith(page, { theme: "dark", panes: BASE_PANES });
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Per-pane style" })).toBeVisible();
  await dialog.getByRole("group", { name: "Per-pane theme" }).getByRole("button", { name: "neo-light", exact: true }).click();
  await expect(page.locator('section[data-pane-id="player"]')).toHaveAttribute("data-pane-theme", "neo-light");
  expect(await bgOf(page, 'section[data-pane-id="player"]')).toBe("rgb(224, 229, 236)");
  await dialog.getByRole("group", { name: "Per-pane theme" }).getByRole("button", { name: "inherit", exact: true }).click();
  await expect(page.locator('section[data-pane-id="player"]')).not.toHaveAttribute("data-pane-theme", "neo-light");
  expect(await bgOf(page, 'section[data-pane-id="player"]')).toBe("rgb(23, 23, 26)");
  expect(await page.evaluate(() => localStorage.getItem("snapify-layout-v3"))).not.toBeNull();
});
