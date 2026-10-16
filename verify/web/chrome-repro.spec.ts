import { test, expect } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";
import { STADIUM_CLAMP_DIVISOR } from "./geometry";
import { TRACK_NAME } from "./fixtures";

// Track B (2.5.1 window chrome) + Track E (2.5.4 see-through verdict): the
// app is frameless transparent at all sizes.
// - No native caption buttons exist in-page: the dock exposes only its own
//   Close (minimize/maximize/close live in no pane header, at no width).
// - Collapsed panes are header-only with zero painted spill past their box
//   (collapsed player carries no mini card: header-only like the queue).
// - Overlay regions carry the painted corner radius (panes 14 px, dock
//   stadium) so the OS round-rect shape never leaves a grey halo.
// - 2.5.4 live-Tauri verdict: caption buttons photographed "in" the
//   overlay are the behind-window seen through transparency (maximized
//   CopyFromScreen shows the browser + its min/max/close while the
//   overlay paints only its gate rect). This spec locks the in-DOM half:
//   the overlay itself paints no chrome. Screenshots land in 2.5.4.

function layoutFor(w: number) {
  return {
    version: 3,
    preset: "custom",
    panes: [
      { id: "lyrics", type: "lyrics", x: 1280 - w - 24, y: 24, w, h: 260, opacity: 0.92, visible: true, z: 3 },
      { id: "player", type: "player", x: 24, y: 200, w, h: 260, opacity: 0.92, visible: true, z: 1 },
      { id: "queue", type: "queue", x: 400, y: 200, w, h: 260, opacity: 0.92, visible: true, z: 2 },
    ],
  };
}

/** Every visible descendant border-box must sit inside the pane box. */
async function spillReport(page, sel: string) {
  return page.locator(sel).evaluate((el) => {
    const pr = el.getBoundingClientRect();
    const bad: Array<{ tag: string; cls: string; rect: object }> = [];
    for (const n of Array.from(el.querySelectorAll("*"))) {
      const h = n as HTMLElement;
      const s = getComputedStyle(h);
      if (s.display === "none" || s.visibility === "hidden") continue;
      const r = h.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const eps = 1.5;
      if (
        r.left < pr.left - eps ||
        r.top < pr.top - eps ||
        r.right > pr.right + eps ||
        r.bottom > pr.bottom + eps
      ) {
        bad.push({
          tag: h.tagName.toLowerCase(),
          cls: (h.className?.toString?.() ?? "").slice(0, 60),
          rect: {
            l: Math.round(r.left),
            t: Math.round(r.top),
            r: Math.round(r.right),
            b: Math.round(r.bottom),
          },
        });
        if (bad.length >= 12) break;
      }
    }
    return {
      box: { x: Math.round(pr.left), y: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height) },
      bad,
    };
  });
}

async function collapse(page, name: string) {
  const pane = page.locator(`section[data-pane="${name}"]`);
  await pane.getByRole("button", { name: `Collapse ${name[0].toUpperCase()}${name.slice(1)} pane` }).click();
  await expect(pane).toHaveAttribute("data-collapsed", "true");
}

async function expectNoCaptionButtons(page) {
  // No native-style caption controls anywhere in-page, at any width.
  expect(await page.getByRole("button", { name: /minimize/i }).count()).toBe(0);
  expect(await page.getByRole("button", { name: /maximize/i }).count()).toBe(0);
  // The dock exposes exactly its own Close and nothing caption-like.
  expect(await page.locator('.dock [aria-label="Close"]').count()).toBe(1);
}

async function expectRadii(page, paneRadius: number) {
  const regions = await commandsNamed(page, "set_overlay_regions");
  expect(regions.length).toBeGreaterThan(0);
  const last = regions[regions.length - 1] as unknown as {
    regions: Array<{ x: number; y: number; w: number; h: number; radius: number }>;
  };
  // Match each live pane box to its reported region: the region must carry
  // the painted corner radius (14 px panes), never the old square 0.
  const boxes: Array<{ x: number; y: number; w: number; h: number }> = await page
    .locator("section.pane")
    .evaluateAll((els) =>
      els.map((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      }),
    );
  expect(boxes.length).toBeGreaterThan(0);
  for (const b of boxes) {
    const hit = (last.regions ?? []).find(
      (r) => Math.abs(r.x - b.x) <= 1 && Math.abs(r.y - b.y) <= 1 && Math.abs(r.w - b.w) <= 1 && Math.abs(r.h - b.h) <= 1,
    );
    expect(hit, `region for pane ${JSON.stringify(b)}`).toBeDefined();
    expect(hit!.radius).toBe(paneRadius);
  }
  const dock = (last.regions ?? []).find((r) => r.h > 70 && r.h < 90);
  if (dock) expect(dock.radius).toBeGreaterThanOrEqual(Math.round(dock.h / STADIUM_CLAMP_DIVISOR));
}

for (const w of [280, 360]) {
  test(`chrome census at ${w}px: header-only, zero spill, painted radii`, async ({ page }) => {
    await stubTauri(page, { layout: layoutFor(w), edit: true });
    await page.goto("/");
    await expect(page.locator('section[data-pane="player"]').getByText(TRACK_NAME).first()).toBeAttached();
    await collapse(page, "lyrics");
    await collapse(page, "player");
    await collapse(page, "queue");
    await page.waitForTimeout(400);

    for (const name of ["lyrics", "player", "queue"]) {
      const rep: any = await spillReport(page, `section[data-pane="${name}"]`);
      console.log(`${name.toUpperCase()}@${w}: ` + JSON.stringify(rep));
      expect(rep.bad).toEqual([]);
    }
    const pm: any = await spillReport(page, 'section[data-pane="player"]');
    const qm: any = await spillReport(page, 'section[data-pane="queue"]');
    const lm: any = await spillReport(page, 'section[data-pane="lyrics"]');
    expect(pm.box.h).toBeLessThanOrEqual(48);
    expect(qm.box.h).toBeLessThanOrEqual(48);
    expect(lm.box.h).toBeLessThanOrEqual(48);
    await expectNoCaptionButtons(page);
    await expectRadii(page, 14);
    await page.screenshot({ path: `docs/bug-reports/2.5.4/chrome-${w}.png` });
  });
}

test("chrome census on narrow stage", async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 800 });
  await stubTauri(page, {
    edit: true,
    layout: {
      version: 3,
      preset: "custom",
      panes: [
        { id: "lyrics", type: "lyrics", x: 160, y: 24, w: 280, h: 260, opacity: 0.92, visible: true, z: 3 },
        { id: "player", type: "player", x: 8, y: 100, w: 280, h: 260, opacity: 0.92, visible: true, z: 1 },
      ],
    },
  });
  await page.goto("/");
  await expect(page.locator('section[data-pane="player"]').getByText(TRACK_NAME).first()).toBeAttached();
  await collapse(page, "lyrics");
  await collapse(page, "player");
  await page.waitForTimeout(400);
  for (const name of ["lyrics", "player"]) {
    const rep: any = await spillReport(page, `section[data-pane="${name}"]`);
    console.log(`${name.toUpperCase()}@narrow: ` + JSON.stringify(rep));
    expect(rep.bad).toEqual([]);
  }
  const lm: any = await spillReport(page, 'section[data-pane="lyrics"]');
  const pm: any = await spillReport(page, 'section[data-pane="player"]');
  expect(lm.box.h).toBeLessThanOrEqual(48);
  expect(pm.box.h).toBeLessThanOrEqual(48);
  await expectNoCaptionButtons(page);
  await expectRadii(page, 14);
  await page.screenshot({ path: `docs/bug-reports/2.5.4/chrome-narrow.png` });
});

test("edit-OFF to interactive-ON leaves no light strip atop PLAYER", async ({ page }) => {
  // The behind-window -/square/X is out of scope here (see the header
  // note): this test pins the in-DOM half after the edit-OFF flip. With
  // interact seeded on, Lock turns editing off while staying interactive.
  await stubTauri(page, { layout: layoutFor(360), edit: true });
  await page.goto("/");
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME).first()).toBeAttached();
  // Edit mode paints the dock pill at top:12px.
  await expect(page.locator(".dock")).toBeVisible();
  await expect(page.locator(".app")).toHaveAttribute("data-editing", "true");

  await page.getByRole("button", { name: "Toggle edit lock" }).click();

  // The edit-mode dock unmounts synchronously: no lingering top pill paints
  // for a frame, and the CSS data-editing backstop hides any retained node
  // before the region flush.
  await expect(page.locator(".app")).not.toHaveAttribute("data-editing", "true");
  await expect(page.locator(".dock")).toHaveCount(0);
  await expect(page.locator(".notch, .notch-strip")).toHaveCount(0);

  // The backstop rule survives in the stylesheet even when no dock node does.
  const backstop: string[] = await page.evaluate(() => {
    const found: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try {
        rules = (sheet as CSSStyleSheet).cssRules;
      } catch {
        continue;
      }
      for (const r of Array.from(rules)) {
        if (r.cssText.includes('[data-editing="true"]')) found.push(r.cssText);
      }
    }
    return found;
  });
  expect(backstop.some((c) => c.includes(".dock"))).toBe(true);

  // PLAYER top edge: painted 14px clip, transparent/dark header, no
  // near-white bar spanning the card, collapse grouped with the title.
  const audit: any = await player.evaluate((el) => {
    const pane = el as HTMLElement;
    const pr = pane.getBoundingClientRect();
    const ps = getComputedStyle(pane);
    const head = pane.querySelector(".pane-handle") as HTMLElement | null;
    const hs = head ? getComputedStyle(head) : null;
    const btn = pane.querySelector(".collapse-btn") as HTMLElement | null;
    const br = btn?.getBoundingClientRect();
    const parse = (bg: string) => {
      const m = bg.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(",").map((s) => Number(s.trim()));
      return { r: p[0], g: p[1], b: p[2], a: p.length === 4 ? p[3] : 1 };
    };
    const whiteBars: string[] = [];
    if (head) {
      for (const n of Array.from(head.querySelectorAll("*"))) {
        const h = n as HTMLElement;
        const s = getComputedStyle(h);
        if (s.display === "none" || s.visibility === "hidden") continue;
        const c = parse(s.backgroundColor);
        if (!c || c.a <= 0.5) continue;
        if (Math.min(c.r, c.g, c.b) < 200) continue;
        const r = h.getBoundingClientRect();
        if (r.width > pr.width * 0.5) {
          whiteBars.push(
            `${h.tagName.toLowerCase()}.${(h.className?.toString?.() ?? "").slice(0, 40)}:${Math.round(r.width)}px`,
          );
        }
      }
    }
    return {
      radiusTL: ps.borderTopLeftRadius,
      radiusTR: ps.borderTopRightRadius,
      overflow: ps.overflow,
      headerBg: hs?.backgroundColor ?? null,
      whiteBars,
      btnRightGap: br ? Math.round(pr.right - br.right) : null,
    };
  });
  console.log("PLAYER@edit-off: " + JSON.stringify(audit));
  expect(audit.radiusTL).toBe("14px");
  expect(audit.radiusTR).toBe("14px");
  expect(audit.overflow).toBe("hidden");
  // Transparent (alpha 0) or dark: no light strip.
  expect(audit.headerBg).not.toBeNull();
  const m = (audit.headerBg as string).match(/rgba?\(([^)]+)\)/);
  expect(m).not.toBeNull();
  const parts = m![1].split(",").map((s: string) => Number(s.trim()));
  const alpha = parts.length === 4 ? parts[3] : 1;
  const peak = Math.max(parts[0], parts[1], parts[2]);
  expect(alpha === 0 || peak <= 40).toBe(true);
  expect(audit.whiteBars).toEqual([]);
  // Collapse grouped with the title, well clear of the caption corner.
  expect(audit.btnRightGap).not.toBeNull();
  expect(audit.btnRightGap).toBeGreaterThan(40);
  await page.screenshot({ path: `docs/bug-reports/2.5.4/chrome-edit-off-player.png` });
});
