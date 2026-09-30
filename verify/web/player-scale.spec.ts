import { test, expect } from "@playwright/test";
import { stubTauri } from "./tauri-mock";
import { TRACK_NAME } from "./fixtures";

// Track Scaling (2.5.2): an expanded full player resized much bigger
// scales art + type + transport proportionally with no spill. Narrow
// compact (mini card) is covered by compact-player.spec.ts and untouched
// here — every growth tier fires at >=480 px container width.

function layoutFor(w: number) {
  return {
    version: 3,
    preset: "custom",
    panes: [
      {
        id: "player",
        type: "player",
        x: 24,
        y: 64,
        w,
        h: 480,
        opacity: 0.92,
        visible: true,
        z: 1,
      },
    ],
  };
}

const TIERS = [
  {
    w: 480,
    artMin: 200,
    titleMin: 17,
    icon: 38,
    disc: 48,
    glyph: 21,
    shot: "scale-480.png",
  },
  {
    w: 640,
    artMin: 260,
    titleMin: 22,
    icon: 44,
    disc: 56,
    glyph: 24,
    shot: "scale-640.png",
  },
  {
    w: 800,
    artMin: 320,
    titleMin: 26,
    icon: 52,
    disc: 68,
    glyph: 28,
    shot: "scale-800.png",
  },
] as const;

for (const t of TIERS) {
  test(`expanded full player scales with no spill at ${t.w}px`, async ({ page }) => {
    await stubTauri(page, { layout: layoutFor(t.w) });
    await page.goto("/");
    const player = page.locator('section[data-pane="player"]');
    await expect(player.getByText(TRACK_NAME)).toBeVisible();

    // Full player on stage, mini card never renders this wide.
    await expect(player.locator(".player-full")).toBeVisible();
    await expect(player.locator(".mini-row")).toHaveCount(0);

    // Art grows with the pane instead of sitting at the 148 px cap.
    const artW = await player
      .locator(".art-top .art-img")
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(artW).toBeGreaterThan(t.artMin);

    // Type grows with the pane instead of capping at 15 px.
    const titleFs = await player
      .locator(".track-title")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(titleFs).toBeGreaterThan(t.titleMin);

    // Transport grows per tier on one shared baseline.
    const metrics = await player.locator(".art-transport").evaluate((el) => {
      const btns = Array.from(el.querySelectorAll("button")).map((b) => {
        const r = b.getBoundingClientRect();
        const sr = b.querySelector("svg")?.getBoundingClientRect();
        return {
          cls: b.className,
          w: r.width,
          h: r.height,
          centerY: r.top + r.height / 2,
          svgW: sr?.width ?? -1,
        };
      });
      return { btns };
    });
    const icons = metrics.btns.filter((b) => b.cls.includes("icon-btn"));
    const discs = metrics.btns.filter((b) => b.cls.includes("play-disc"));
    expect(icons.length).toBe(4);
    expect(discs.length).toBe(1);
    for (const b of icons) {
      expect(Math.round(b.w)).toBe(t.icon);
      expect(Math.round(b.h)).toBe(t.icon);
      expect(Math.round(b.svgW)).toBe(t.glyph);
    }
    expect(Math.round(discs[0].w)).toBe(t.disc);
    expect(Math.round(discs[0].h)).toBe(t.disc);
    const centers = metrics.btns.map((b) => b.centerY);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);

    // No horizontal spill anywhere in the full player stack.
    for (const sel of [
      'section[data-pane="player"] .player-full',
      'section[data-pane="player"] .pane-body',
      'section[data-pane="player"]',
    ]) {
      const m = await page.locator(sel).evaluate((el) => ({
        scrollW: el.scrollWidth,
        clientW: el.clientWidth,
      }));
      expect(m.scrollW, `${sel} horizontal`).toBeLessThanOrEqual(m.clientW + 1);
    }

    // Everything stays reachable: scroll the volume row into view and
    // prove the slider and progress bar are live, not clipped away.
    await player.locator(".volume-row .vol").scrollIntoViewIfNeeded();
    await expect(player.locator(".volume-row .vol")).toBeVisible();
    await expect(player.locator(".times").first()).toBeVisible();

    await player.screenshot({ path: `docs/bug-reports/2.5.2/${t.shot}` });
  });
}
