import { test, expect } from "@playwright/test";
import { stubTauri } from "./tauri-mock";
import { TRACK_NAME, TRACK_ARTISTS } from "./fixtures";

// Track A (player-center-120, 2.5.3): dead space under the player at mid
// heights is gone. The body is a flex column so .pane-fill stretches it,
// and the card centers on leftover space with safe auto margins (margins
// collapse when content overflows, so scrolled panes never clip the top).
// The drag floor drops to 120 px while the mini/full swap stays at the
// full-content threshold (h <= 190), so 120-190 rests on the mini card
// without clipping. Marquee + reduced-motion are untouched (mini marquee
// + volume arrive via the sibling mini track). On this base
// the mini carries prev/play/next only (shuffle/repeat arrive via the
// sibling mini track); this spec asserts the shared transport, the mini
// volume presence (closed, zero width, no spill), and makes
// no claim about the sibling buttons either way.
//
// Generator (record): this file writes the captures.
//   pre-fix:  CENTER_SNAP_PREFIX=before npx playwright test -c playwright.config.ts verify/web/player-center.spec.ts
//   post-fix: npx playwright test -c playwright.config.ts verify/web/player-center.spec.ts
// Both runs seed the same geometry; the app clamps per its own floors, so
// `before-*` shows the 190 px floor + top-aligned card and `after-*` shows
// the 120 px floor + centered card. The pre-fix run is expected to fail
// the centering and 120-floor assertions (that failure is the repro); the
// screenshots are written before the assertions either way.

const PREFIX = process.env.CENTER_SNAP_PREFIX ?? "after";
const DIR = "docs/bug-reports/2.5.3";

interface Case {
  w: number;
  h: number;
  card: "mini" | "full";
}

const CASES: Case[] = [
  { w: 280, h: 190, card: "mini" },
  { w: 280, h: 120, card: "mini" },
  { w: 360, h: 200, card: "full" },
  { w: 480, h: 260, card: "full" },
  { w: 360, h: 120, card: "mini" },
  { w: 360, h: 160, card: "mini" },
  // Tall enough that the full card fits: proves real vertical centering
  // (gap diff), not just scroll-top pinning.
  { w: 480, h: 520, card: "full" },
];

function layoutFor(w: number, h: number) {
  return {
    version: 3,
    preset: "custom",
    panes: [
      {
        id: "player",
        type: "player",
        x: 24,
        y: 100,
        w,
        h,
        opacity: 0.92,
        visible: true,
        z: 1,
      },
    ],
  };
}

test("reduced-motion still kills the title marquee", async ({ page }) => {
  await stubTauri(page, { layout: layoutFor(480, 520) });
  await page.goto("/");
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();
  // The marqueeCSS survives: static ellipsis, nowrap, transform-only
  // keyframes, and the reduced-motion kill block still in the cascade.
  const title = player.locator(".track-title");
  const cs = await title.evaluate((el) => {
    const s = getComputedStyle(el);
    return { ws: s.whiteSpace, ov: s.overflow, to: s.textOverflow };
  });
  expect(cs.ws).toBe("nowrap");
  expect(cs.ov).toBe("hidden");
  expect(cs.to).toBe("ellipsis");
  const killBlock = await page.evaluate(() => {
    const hits: string[] = [];
    for (const sh of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try {
        rules = sh.cssRules;
      } catch {
        continue;
      }
      if (!rules) continue;
      for (const r of Array.from(rules)) {
        if (r instanceof CSSMediaRule && r.conditionText.includes("prefers-reduced-motion")) {
          hits.push(r.conditionText);
        }
      }
    }
    return hits;
  });
  expect(killBlock.length).toBeGreaterThan(0);
});

for (const c of CASES) {
  test(`player ${c.w}x${c.h} shows ${c.card}, centered, no spill`, async ({ page }) => {
    await stubTauri(page, { layout: layoutFor(c.w, c.h) });
    await page.goto("/");
    await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();
    const player = page.locator('section[data-pane="player"]');
    // Card-aware first paint: the hidden twin (display:none via the :has
    // swap) still matches getByText, so wait on the expected card itself.
    if (c.card === "mini") {
      await expect(player.locator(".mini-row")).toBeVisible();
    } else {
      await expect(player.locator(".player-full")).toBeVisible();
    }

    await page.screenshot({ path: `${DIR}/${PREFIX}-${c.w}x${c.h}.png` });

    const box = await player.boundingBox();
    if (!box) throw new Error("player has no box");

    if (c.card === "mini") {
      const mini = player.locator(".mini-row");
      await expect(mini).toBeVisible();
      await expect(player.locator(".player-full")).toBeHidden();
      await expect(mini.locator("img.mini-cover")).toBeVisible();
      await expect(mini.locator(".mini-title")).toContainText(TRACK_NAME);
      await expect(mini.locator(".mini-artist")).toContainText(TRACK_ARTISTS);
      await expect(mini.getByRole("button", { name: "Previous track" })).toBeVisible();
      await expect(mini.getByRole("button", { name: "Next track" })).toBeVisible();
      // Mini volume rides along closed: icon-button visible, slider present
      // at zero width, still no spill anywhere in the swap band.
      await expect(mini.getByRole("button", { name: "Adjust volume" })).toBeVisible();
      await expect(mini.locator("input.vol")).toHaveCount(1);
      const miniVolW = await mini.locator("input.vol").evaluate((el) => el.getBoundingClientRect().width);
      expect(miniVolW).toBeLessThanOrEqual(1);
      await expect(player.getByRole("button", { name: "Pause", exact: true })).toHaveCount(1);

      // The 120 px floor holds: the seeded height survives boot clamping.
      expect(Math.round(box.height)).toBe(c.h);

      // No clip anywhere in the swap band: row, body, and pane never scroll.
      for (const sel of [
        'section[data-pane="player"] .mini-row',
        'section[data-pane="player"] .pane-body',
        'section[data-pane="player"]',
      ]) {
        const m = await page.locator(sel).evaluate((el) => ({
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
          scrollH: el.scrollHeight,
          clientH: el.clientHeight,
        }));
        expect(m.scrollW, `${sel} horizontal`).toBeLessThanOrEqual(m.clientW + 1);
        expect(m.scrollH, `${sel} vertical`).toBeLessThanOrEqual(m.clientH + 1);
      }
      const rowBox = await mini.boundingBox();
      if (!rowBox) throw new Error("mini-row has no box");
      expect(rowBox.height).toBeLessThanOrEqual(72);

      // Centered: the cover's vertical center meets the body content-box
      // center (pre-fix the row sat top-aligned with dead space below).
      const m = await player.evaluate((pane) => {
        const body = pane.querySelector(".pane-body") as HTMLElement;
        const cover = pane.querySelector(".mini-cover") as HTMLElement;
        const b = body.getBoundingClientRect();
        const bs = getComputedStyle(body);
        const top = b.top + parseFloat(bs.paddingTop);
        const bottom = b.bottom - parseFloat(bs.paddingBottom);
        const cr = cover.getBoundingClientRect();
        return {
          bodyCenterY: (top + bottom) / 2,
          coverCenterY: cr.top + cr.height / 2,
        };
      });
      console.log(`CENTER ${c.w}x${c.h}: ` + JSON.stringify(m));
      expect(Math.abs(m.coverCenterY - m.bodyCenterY)).toBeLessThanOrEqual(8);
    } else {
      await expect(player.locator(".player-full")).toBeVisible();
      await expect(player.locator(".mini-row")).toHaveCount(0);

      // No horizontal spill anywhere in the full stack.
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

      // Transport baseline: one shared flex row, never wrapped, centers
      // within a pixel (the nowrap the overlay row depends on).
      const wrap = await player.locator(".art-transport").evaluate(
        (el) => getComputedStyle(el).flexWrap,
      );
      expect(wrap).toBe("nowrap");
      const centers = await player.locator(".art-transport").evaluate((el) =>
        Array.from(el.querySelectorAll("button")).map((b) => {
          const r = b.getBoundingClientRect();
          return r.top + r.height / 2;
        }),
      );
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);

      // Volume row never spills horizontally; the slider stays live
      // (measured before any scroll so the gap probe below sees scrollTop 0).
      const vm = await player.locator(".volume-row").evaluate((el) => ({
        scrollW: el.scrollWidth,
        clientW: el.clientWidth,
      }));
      console.log(`VOLUME ${c.w}x${c.h}: ` + JSON.stringify(vm));
      expect(vm.scrollW).toBeLessThanOrEqual(vm.clientW + 1);

      // Art fills its spec (no flex squeeze): min(52%,148px) below the
      // 478 px growth tier, growing above it.
      const artW = await player
        .locator(".art-top .art-img")
        .evaluate((el) => el.getBoundingClientRect().width);
      console.log(`ART ${c.w}x${c.h}: ` + JSON.stringify({ artW }));
      if (c.w < 478) {
        expect(artW).toBeGreaterThan(100);
      } else {
        expect(artW).toBeGreaterThan(148);
      }

      const g = await player.evaluate((pane) => {
        const body = pane.querySelector(".pane-body") as HTMLElement;
        const card = pane.querySelector(".player-full") as HTMLElement;
        const art = pane.querySelector(".art-top") as HTMLElement;
        const b = body.getBoundingClientRect();
        const bs = getComputedStyle(body);
        const padT = parseFloat(bs.paddingTop);
        const padB = parseFloat(bs.paddingBottom);
        const padL = parseFloat(bs.paddingLeft);
        const padR = parseFloat(bs.paddingRight);
        const c = card.getBoundingClientRect();
        const a = art.getBoundingClientRect();
        return {
          bodyContentH: b.height - padT - padB,
          cardH: c.height,
          topGap: c.top - (b.top + padT),
          bottomGap: b.bottom - padB - c.bottom,
          cardCenterY: c.top + c.height / 2,
          bodyCenterY: b.top + padT + (b.height - padT - padB) / 2,
          artCenterX: a.left + a.width / 2,
          bodyCenterX: b.left + padL + (b.width - padL - padR) / 2,
          scrollTop: body.scrollTop,
        };
      });
      console.log(`FULL ${c.w}x${c.h}: ` + JSON.stringify(g));
      if (g.cardH <= g.bodyContentH + 1) {
        // Fits: top and bottom gaps agree — no dead space pooling below.
        expect(Math.abs(g.topGap - g.bottomGap)).toBeLessThanOrEqual(8);
        expect(Math.abs(g.cardCenterY - g.bodyCenterY)).toBeLessThanOrEqual(8);
        expect(Math.abs(g.artCenterX - g.bodyCenterX)).toBeLessThanOrEqual(8);
      } else {
        // Scrolls: the top pins to the body (safe centering never clips it).
        expect(Math.abs(g.topGap)).toBeLessThanOrEqual(1);
        expect(g.scrollTop).toBe(0);
      }

      // The slider stays live even when it starts below the fold.
      await player.locator(".volume-row .vol").scrollIntoViewIfNeeded();
      await expect(player.locator(".volume-row .vol")).toBeVisible();
    }
  });
}
