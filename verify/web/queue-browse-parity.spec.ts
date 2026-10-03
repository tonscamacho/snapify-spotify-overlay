import { test, expect } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";

// Queue/browse scroll parity (2.5.6): the queue's virtualized scroller must
// follow the browse pane-body pattern byte-for-byte — container chain (one
// scroller per pane, inner ol fills without nesting), overflow-x/y,
// scrollbar-gutter, padding, sticky headers, ::-webkit-scrollbar
// width/thumb/track, scrollbar-width/color, hover, glass/pastel/overlay
// tinting — while keeping virtualization, the 120 drag floor, and the mini
// contracts untouched. Expanded 280/360/480 side-by-side plus the collapsed
// header-only contract. Screenshots land in docs/bug-reports/2.5.6/.

function layoutFor(w: number) {
  // Equal widths on purpose: --pad-pane is container-relative (cqw), so
  // only same-width panes can resolve byte-identical scrollport metrics.
  return {
    version: 3,
    preset: "custom",
    panes: [
      { id: "queue", type: "queue", x: 40, y: 200, w, h: 260, opacity: 0.92, visible: true, z: 2 },
      { id: "browse", type: "browse", x: 40 + w + 24, y: 200, w, h: 260, opacity: 0.92, visible: true, z: 1 },
    ],
  };
}

function queue25() {
  return {
    currently_playing: {
      id: "verify-current-0",
      name: "Now Spinning",
      artists: [{ name: "House Band" }],
      album: { name: "House", images: [] },
      duration_ms: 180000,
      uri: "spotify:track:verify-current-0",
      explicit: false,
    },
    queue: Array.from({ length: 25 }, (_, i) => ({
      id: `verify-long-${i + 1}`,
      name: `Long Queue ${i + 1} with a tail long enough to force an ellipsis inside the row`,
      artists: [{ name: `Guest Artist ${i + 1} and associates` }],
      album: { name: "Long Album", images: [] },
      duration_ms: 180000 + i * 1000,
      uri: `spotify:track:verify-long-${i + 1}`,
      explicit: false,
    })),
  };
}

async function parityReport(page) {
  return page.evaluate(() => {
    const cs = (el: Element | null) => (el ? getComputedStyle(el as HTMLElement) : null);
    const qPane = document.querySelector('section[data-pane="queue"]') as HTMLElement;
    const bPane = document.querySelector('section[data-pane="browse"]') as HTMLElement;
    const qBody = qPane.querySelector(".pane-body") as HTMLElement;
    const qScroll = qPane.querySelector(".queue-scroll") as HTMLElement;
    const bBody = bPane.querySelector(".pane-body") as HTMLElement;
    const qOl = qPane.querySelector("ol.queue") as HTMLElement;
    const bOl = bPane.querySelector("ol.queue") as HTMLElement;
    const qHead = qPane.querySelector(".pane-subhead") as HTMLElement;
    const bTabs = bPane.querySelector(".browse-tabs") as HTMLElement;
    const qb = cs(bBody)!;
    const qs = cs(qScroll)!;
    const scroller = (s: CSSStyleDeclaration) => ({
      overflowX: s.overflowX,
      overflowY: s.overflowY,
      gutter: s.getPropertyValue("scrollbar-gutter"),
      padT: s.paddingTop,
      padR: s.paddingRight,
      padB: s.paddingBottom,
      padL: s.paddingLeft,
      sbWidth: s.getPropertyValue("scrollbar-width"),
      sbColor: s.getPropertyValue("scrollbar-color"),
      bg: s.backgroundColor,
    });
    // Stylesheet scan: which scroller selectors carry the webkit
    // width/thumb rules (browse pattern) and the shared hover reveal.
    const found = {
      widthQueue: false,
      thumbQueue: false,
      trackQueue: "",
      widthBrowse: false,
      thumbBrowse: false,
      padDeclQueue: false,
      padDeclBrowse: false,
      rowHover: false,
      glassQueueHead: false,
      glassBrowseTabs: false,
    };
    const walk = (rules: CSSRuleList) => {
      for (const r of Array.from(rules)) {
        if (r.type === 4 /* MEDIA */ || r.type === 11 /* SUPPORTS */) {
          walk((r as CSSGroupingRule).cssRules);
          continue;
        }
        if (r.type !== 1) continue;
        const sel = ((r as CSSStyleRule).selectorText || "").replace(/\s+/g, " ");
        const st = (r as CSSStyleRule).style;
        if (!st) continue;
        const hasQ = sel.includes(".queue-scroll");
        const hasB = sel.includes(".pane-body");
        if (sel.includes("::-webkit-scrollbar-thumb")) {
          if (hasQ && st.background.includes("255, 255, 255") && st.borderRadius === "999px") found.thumbQueue = true;
          if (hasB && st.background.includes("255, 255, 255") && st.borderRadius === "999px") found.thumbBrowse = true;
        } else if (sel.includes("::-webkit-scrollbar-track")) {
          if (hasQ) found.trackQueue = st.background || st.backgroundColor || "present";
        } else if (sel.includes("::-webkit-scrollbar")) {
          if (hasQ && st.width === "5px") found.widthQueue = true;
          if (hasB && st.width === "5px") found.widthBrowse = true;
        }
        if (sel.includes(".q:hover .row-act")) found.rowHover = true;
        if (sel === ".queue-scroll.queue-fill" && st.getPropertyValue("padding-inline") === "var(--pad-pane)") found.padDeclQueue = true;
        if (sel === ".pane-body" && st.padding === "var(--pad-pane)") found.padDeclBrowse = true;
        if (sel.includes(".pane[data-pane=\"queue\"] .pane-subhead") && st.backgroundColor !== "") found.glassQueueHead = true;
        if (sel.includes(".pane[data-pane=\"browse\"] .browse-tabs") && st.backgroundColor !== "") found.glassBrowseTabs = true;
      }
    };
    for (const sh of Array.from(document.styleSheets)) {
      try {
        walk(sh.cssRules);
      } catch {
        continue;
      }
    }
    const qScrollEl = qScroll as HTMLElement;
    const bBodyEl = bBody as HTMLElement;
    const clampPad = (clientW: number) => Math.min(16, Math.max(8, 0.04 * clientW));
    return {
      browsePaneW: bPane.clientWidth,
      queuePaneW: qPane.clientWidth,
      browsePadExpected: clampPad(bPane.clientWidth),
      queuePadExpected: clampPad(qPane.clientWidth),
      browse: { ...scroller(qb), scrollW: bBodyEl.scrollWidth, clientW: bBodyEl.clientWidth },
      queue: { ...scroller(qs), scrollW: qScrollEl.scrollWidth, clientW: qScrollEl.clientWidth },
      queueBody: {
        overflow: cs(qBody)?.overflow ?? "",
        display: cs(qBody)?.display ?? "",
        padT: cs(qBody)?.paddingTop ?? "",
        padB: cs(qBody)?.paddingBottom ?? "",
        padL: cs(qBody)?.paddingLeft ?? "",
        padR: cs(qBody)?.paddingRight ?? "",
      },
      queueOl: {
        virtualized: qOl?.getAttribute("data-virtualized") ?? null,
        total: qOl?.getAttribute("data-total") ?? null,
        overflow: cs(qOl)?.overflow ?? "",
        height: (qOl as HTMLElement)?.style?.height ?? "",
      },
      browseOl: { overflow: cs(bOl)?.overflow ?? "" },
      headers: {
        queuePos: cs(qHead)?.position ?? "",
        queueTop: cs(qHead)?.top ?? "",
        queueBg: cs(qHead)?.backgroundColor ?? "",
        queuePad: cs(qHead) ? [cs(qHead)!.paddingTop, cs(qHead)!.paddingRight] : [],
        browsePos: cs(bTabs)?.position ?? "",
        browseTop: cs(bTabs)?.top ?? "",
        browseBg: cs(bTabs)?.backgroundColor ?? "",
        browsePad: cs(bTabs) ? [cs(bTabs)!.paddingTop, cs(bTabs)!.paddingRight] : [],
      },
      found,
    };
  });
}

async function paintedSpill(page): Promise<Array<object>> {
  return page.evaluate(() => {
    const pane = document.querySelector('section[data-pane="queue"]') as HTMLElement;
    const pr = pane.getBoundingClientRect();
    const hits: Array<object> = [];
    const pts: Array<[number, number]> = [];
    for (let x = pr.left - 6; x <= pr.right + 6; x += 8) {
      pts.push([x, pr.top - 3]);
      pts.push([x, pr.bottom + 3]);
    }
    for (let y = pr.top - 6; y <= pr.bottom + 6; y += 8) {
      pts.push([pr.left - 3, y]);
      pts.push([pr.right + 3, y]);
    }
    for (const [x, y] of pts) {
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      if (hit && pane.contains(hit)) {
        hits.push({ x: Math.round(x), y: Math.round(y), cls: (hit.className?.toString?.() ?? "").slice(0, 60) });
        if (hits.length >= 12) break;
      }
    }
    return hits;
  });
}

async function expectRegionCovers(page, box: { x: number; y: number; w: number; h: number }) {
  await expect
    .poll(
      async () => {
        const all = await commandsNamed(page, "set_overlay_regions");
        const latest = all[all.length - 1] as unknown as
          | { regions: Array<{ x: number; y: number; w: number; h: number }> }
          | undefined;
        return (latest?.regions ?? []).some(
          (r) =>
            Math.abs(r.x - box.x) <= 1 &&
            Math.abs(r.y - box.y) <= 1 &&
            Math.abs(r.w - box.w) <= 1 &&
            Math.abs(r.h - box.h) <= 1,
        );
      },
      { timeout: 10000 },
    )
    .toBe(true);
}

for (const w of [280, 360, 480]) {
  test(`queue-browse scroll parity at ${w}px`, async ({ page }) => {
    await stubTauri(page, { layout: layoutFor(w), fixtures: { queue: queue25() } });
    await page.goto("/");
    const queue = page.locator('section[data-pane="queue"]');
    const browse = page.locator('section[data-pane="browse"]');
    await expect(queue).toBeVisible();
    await expect(browse).toBeVisible();
    await expect(queue.locator("ol.queue[data-virtualized='true']")).toHaveAttribute("data-total", "25");
    await expect(queue).toContainText("Long Queue 1");
    await page.waitForTimeout(400);

    // Force the browse body to overflow so both scrollers actually scroll:
    // filler rows appended after the library list, removed never (spec-only).
    await browse.locator(".pane-body").evaluate((el) => {
      if (el.querySelector("[data-parity-filler]")) return;
      const fill = document.createElement("div");
      fill.setAttribute("data-parity-filler", "true");
      for (let i = 0; i < 30; i++) {
        const d = document.createElement("div");
        d.style.height = "40px";
        d.textContent = `parity filler ${i}`;
        fill.appendChild(d);
      }
      el.appendChild(fill);
    });

    const rep: any = await parityReport(page);
    console.log(`QUEUE-BROWSE-PARITY@${w}: ` + JSON.stringify(rep));

    // One scroller per pane: the queue body stays a flex column with no
    // scroll of its own; the virtualized viewport owns the scroll.
    expect(rep.queueBody.overflow).toBe("hidden");
    expect(rep.queueOl.virtualized).toBe("true");
    expect(rep.queueOl.total).toBe("25");
    // Inner lists fill instead of nesting: no nested scroller in either pane.
    expect(rep.queueOl.overflow).toBe("visible");
    expect(rep.browseOl.overflow).toBe("visible");

    // Scroller metrics identical: overflow-x/y, gutter, scrollbar-width/
    // color, scroller background. Padding is container-relative (cqw) and
    // the browse pane floors at 300px, so at 280 the resolved px legitimately
    // differ: each side must equal its own container's clamp expectation,
    // and both declarations must be the same var(--pad-pane) token
    // (byte-for-byte at the rule level). Track stays default on both
    // (no explicit track rule anywhere: parity is both-absent).
    expect(rep.queue.overflowX).toBe(rep.browse.overflowX);
    expect(rep.queue.overflowY).toBe(rep.browse.overflowY);
    expect(rep.queue.overflowY).toBe("auto");
    expect(rep.queue.gutter).toBe(rep.browse.gutter);
    expect(rep.queue.gutter).toBe("stable");
    expect(rep.found.padDeclQueue).toBe(true);
    expect(rep.found.padDeclBrowse).toBe(true);
    // Inline padding lives on the viewport itself (full-bleed, like the
    // sticky headers): each side equals its own container's clamp.
    for (const side of ["padL", "padR"]) {
      expect(Math.abs(parseFloat(rep.queue[side]) - rep.queuePadExpected)).toBeLessThanOrEqual(0.06);
      expect(Math.abs(parseFloat(rep.browse[side]) - rep.browsePadExpected)).toBeLessThanOrEqual(0.06);
    }
    // Block padding lives on the body (same var): the viewport carries
    // none, and the per-side total (body + viewport) equals browse.
    expect(rep.queue.padT).toBe("0px");
    expect(rep.queue.padB).toBe("0px");
    expect(Math.abs(parseFloat(rep.queueBody.padT) - rep.queuePadExpected)).toBeLessThanOrEqual(0.06);
    expect(Math.abs(parseFloat(rep.queueBody.padB) - rep.queuePadExpected)).toBeLessThanOrEqual(0.06);
    if (rep.queuePaneW === rep.browsePaneW) {
      expect(rep.queue.padR).toBe(rep.browse.padR);
      expect(rep.queue.padL).toBe(rep.browse.padL);
      // Per-side totals agree at equal widths: inline is viewport padding,
      // block is body padding + (zero) viewport padding.
      expect(parseFloat(rep.queueBody.padT) + parseFloat(rep.queue.padT)).toBe(parseFloat(rep.browse.padT));
      expect(parseFloat(rep.queueBody.padB) + parseFloat(rep.queue.padB)).toBe(parseFloat(rep.browse.padB));
    }
    expect(rep.queue.sbWidth).toBe(rep.browse.sbWidth);
    expect(rep.queue.sbColor).toBe(rep.browse.sbColor);
    expect(rep.queue.bg).toBe(rep.browse.bg);

    // Webkit scrollbar pattern ported: 5px width + shared thumb on the
    // queue viewport, same as the pane body. Track stays default on both
    // (no explicit track rule anywhere: parity is both-absent).
    expect(rep.found.widthBrowse).toBe(true);
    expect(rep.found.thumbBrowse).toBe(true);
    expect(rep.found.widthQueue).toBe(true);
    expect(rep.found.thumbQueue).toBe(true);
    expect(rep.found.trackQueue).toBe("");

    // Hover reveal is one shared rule, never forked per pane.
    expect(rep.found.rowHover).toBe(true);
    // Glass/pastel per-pane sticky tints survive for both headers.
    expect(rep.found.glassQueueHead).toBe(true);
    expect(rep.found.glassBrowseTabs).toBe(true);

    // Sticky headers: same position, same container-relative offset, same
    // surface, same text inset — queue keeps its section head while rows
    // scroll beneath it, exactly like the browse tab bar. Offsets resolve
    // per-container, so compare against each pane's own expectation, with
    // strict cross-pane equality only at equal widths.
    expect(rep.headers.queuePos).toBe("sticky");
    expect(rep.headers.queuePos).toBe(rep.headers.browsePos);
    expect(rep.headers.queueBg).toBe(rep.headers.browseBg);
    expect(Math.abs(parseFloat(rep.headers.queueTop) + rep.queuePadExpected)).toBeLessThanOrEqual(0.06);
    expect(Math.abs(parseFloat(rep.headers.browseTop) + rep.browsePadExpected)).toBeLessThanOrEqual(0.06);
    if (rep.queuePaneW === rep.browsePaneW) {
      expect(rep.headers.queueTop).toBe(rep.headers.browseTop);
      expect(rep.headers.queuePad).toEqual(rep.headers.browsePad);
    }

    // Behavior: scroll both to the bottom; both headers stay pinned at the
    // top of their pane and the tails render.
    await queue.locator(".queue-scroll").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await browse.locator(".pane-body").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(queue).toContainText("Long Queue 25");
    await page.waitForTimeout(300);
    const stuck = await page.evaluate(() => {
      const qp = document.querySelector('section[data-pane="queue"]')!.getBoundingClientRect();
      const bp = document.querySelector('section[data-pane="browse"]')!.getBoundingClientRect();
      const qh = document.querySelector('section[data-pane="queue"] .pane-subhead')!.getBoundingClientRect();
      const bt = document.querySelector('section[data-pane="browse"] .browse-tabs')!.getBoundingClientRect();
      return {
        qHeadTop: Math.round(qh.top - qp.top),
        qHeadH: Math.round(qh.height),
        bTabsTop: Math.round(bt.top - bp.top),
        bTabsH: Math.round(bt.height),
        qpH: Math.round(qp.height),
      };
    });
    console.log(`QUEUE-BROWSE-STUCK@${w}: ` + JSON.stringify(stuck));
    // Both headers fully inside their pane box near the top after scrolling.
    expect(stuck.qHeadTop).toBeGreaterThanOrEqual(0);
    expect(stuck.qHeadTop + stuck.qHeadH).toBeLessThanOrEqual(stuck.qpH);
    expect(stuck.bTabsTop).toBeGreaterThanOrEqual(0);

    // No horizontal overflow anywhere in the queue chain.
    expect(rep.queue.scrollW).toBeLessThanOrEqual(rep.queue.clientW + 1);
    expect(rep.browse.scrollW).toBeLessThanOrEqual(rep.browse.clientW + 1);
    // Nothing paints outside the queue pane box.
    expect(await paintedSpill(page)).toEqual([]);

    const box: any = await queue.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    });
    await expectRegionCovers(page, box);
    await page.screenshot({ path: `docs/bug-reports/2.5.6/queue-browse-${w}.png` });
  });
}

test("queue-browse parity collapsed: header-only, body none, zero spill", async ({ page }) => {
  await stubTauri(page, { layout: layoutFor(360), fixtures: { queue: queue25() } });
  await page.goto("/");
  const queue = page.locator('section[data-pane="queue"]');
  await expect(queue).toBeVisible();
  await expect(queue.locator("ol.queue[data-virtualized='true']")).toHaveAttribute("data-total", "25");
  await queue.getByRole("button", { name: "Collapse Queue pane" }).click();
  await expect(queue).toHaveAttribute("data-collapsed", "true");
  await page.waitForTimeout(400);

  const rep: any = await queue.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const body = el.querySelector(".pane-body") as HTMLElement;
    return {
      box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      bodyDisplay: getComputedStyle(body).display,
    };
  });
  console.log("QUEUE-BROWSE-COLLAPSED: " + JSON.stringify(rep));
  expect(rep.bodyDisplay).toBe("none");
  expect(rep.box.h).toBeLessThanOrEqual(48);
  expect(await paintedSpill(page)).toEqual([]);
  await expectRegionCovers(page, rep.box);
  await page.screenshot({ path: "docs/bug-reports/2.5.6/queue-browse-collapsed.png" });
});
