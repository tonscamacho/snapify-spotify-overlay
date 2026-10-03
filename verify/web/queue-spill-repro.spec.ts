import { test, expect } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";

// Queue spill repro (2.5.5): the queue's window controls and scroll content
// must stay inside the queue pane box, expanded and collapsed.
// Expanded 280/360/480 with a 25-item queue (forces the virtualized
// scroller), plus the collapsed header-only contract:
// - No horizontal overflow anywhere in the chain
//   (scrollWidth <= clientWidth + 1 on body, scroller, rows).
// - The virtual grid converges: the pinned row height matches the natural
//   row height (unpinned clone) within 2 px, the ol spans total * rowH, and
//   rendered rows tile exactly (no overlap, no drift). Before the fix the
//   measure read the row's own inline height pin back, freezing ROW_GUESS
//   (64) forever: dead air per row, a lying scrollbar, and row overlap in
//   any environment whose natural rows exceed the guess.
// - No painted spill: an elementFromPoint sweep just outside all four pane
//   edges never lands inside the queue pane (below-fold rows are scroll
//   overflow clipped by the scroller, not spill).
// - Collapsed: body display none, header-only box (h <= 48), zero painted
//   spill (locks the 2.5.0 specificity fix: the (0,4,0) hide still wins).
// - The overlay region report covers the live pane box in both states.

function layoutFor(w: number) {
  return {
    version: 3,
    preset: "custom",
    panes: [
      { id: "queue", type: "queue", x: 400, y: 200, w, h: 260, opacity: 0.92, visible: true, z: 2 },
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

async function gridReport(page) {
  return page.locator('section[data-pane="queue"]').evaluate((el) => {
    const pr = el.getBoundingClientRect();
    const body = el.querySelector(".pane-body") as HTMLElement;
    const scroller = el.querySelector(".queue-scroll") as HTMLElement;
    const ol = el.querySelector("ol.queue") as HTMLElement;
    const rows = Array.from(el.querySelectorAll("li.q")) as HTMLElement[];
    const tops = rows.map((r) => r.getBoundingClientRect().top);
    const rowH = rows.length ? rows[0].offsetHeight : -1;
    // Natural height via an unpinned clone (independent of the inline pin).
    let natural = -1;
    if (rows[0]) {
      const c = rows[0].cloneNode(true) as HTMLElement;
      c.style.position = "absolute";
      c.style.visibility = "hidden";
      c.style.height = "auto";
      c.style.top = "-9999px";
      el.appendChild(c);
      natural = c.offsetHeight;
      c.remove();
    }
    // Rows must tile the virtual grid exactly: uniform step, no overlap.
    const steps = tops.slice(1).map((t, i) => Math.round(t - tops[i]));
    // Horizontal containment: no legitimate horizontal overflow exists.
    const eps = 1.5;
    const hOutside = rows.filter((r) => {
      const b = r.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) return false;
      return b.left < pr.left - eps || b.right > pr.right + eps;
    }).length;
    return {
      box: { x: Math.round(pr.left), y: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height) },
      collapsed: el.getAttribute("data-collapsed"),
      bodyDisplay: getComputedStyle(body).display,
      bodyOverflowX: getComputedStyle(body).overflowX,
      bodyScrollW: body.scrollWidth,
      bodyClientW: body.clientWidth,
      scrollScrollW: scroller.scrollWidth,
      scrollClientW: scroller.clientWidth,
      rowCount: rows.length,
      rowH,
      natural,
      olH: ol ? ol.style.height : "none",
      steps,
      hOutside,
    };
  });
}

/** Painted spill: points just outside every pane edge must never hit queue DOM. */
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
  test(`queue spill repro at ${w}px: grid converges, zero spill`, async ({ page }) => {
    await stubTauri(page, { layout: layoutFor(w), fixtures: { queue: queue25() } });
    await page.goto("/");
    const queue = page.locator('section[data-pane="queue"]');
    await expect(queue).toBeVisible();
    await expect(queue.locator("ol.queue[data-virtualized='true']")).toHaveAttribute("data-total", "25");
    await expect(queue).toContainText("Long Queue 1");
    await page.waitForTimeout(400);

    const rep: any = await gridReport(page);
    console.log(`QUEUE-GRID@${w}: ` + JSON.stringify(rep));
    // No horizontal overflow anywhere in the chain.
    expect(rep.bodyScrollW).toBeLessThanOrEqual(rep.bodyClientW + 1);
    expect(rep.scrollScrollW).toBeLessThanOrEqual(rep.scrollClientW + 1);
    expect(rep.hOutside).toBe(0);
    // The virtual grid converges on the natural row height.
    expect(Math.abs(rep.rowH - rep.natural)).toBeLessThanOrEqual(2);
    expect(rep.olH).toBe(`${25 * rep.rowH}px`);
    for (const s of rep.steps) expect(s).toBe(rep.rowH);
    // Nothing paints outside the pane box.
    expect(await paintedSpill(page)).toEqual([]);
    await expectRegionCovers(page, rep.box);

    // Scrolled-to-bottom tail obeys the same contract.
    await queue.locator(".queue-scroll").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(queue).toContainText("Long Queue 25");
    await page.waitForTimeout(300);
    const tail: any = await gridReport(page);
    console.log(`QUEUE-TAIL@${w}: ` + JSON.stringify(tail));
    expect(tail.bodyScrollW).toBeLessThanOrEqual(tail.bodyClientW + 1);
    expect(tail.scrollScrollW).toBeLessThanOrEqual(tail.scrollClientW + 1);
    expect(tail.hOutside).toBe(0);
    expect(Math.abs(tail.rowH - tail.natural)).toBeLessThanOrEqual(2);
    for (const s of tail.steps) expect(s).toBe(tail.rowH);
    expect(await paintedSpill(page)).toEqual([]);
    await expectRegionCovers(page, tail.box);

    await page.screenshot({ path: `docs/bug-reports/2.5.5/queue-${w}.png` });
  });
}

test("queue spill repro collapsed: header-only, body none, zero spill", async ({ page }) => {
  await stubTauri(page, { layout: layoutFor(360), fixtures: { queue: queue25() } });
  await page.goto("/");
  const queue = page.locator('section[data-pane="queue"]');
  await expect(queue).toBeVisible();
  await expect(queue.locator("ol.queue[data-virtualized='true']")).toHaveAttribute("data-total", "25");
  await queue.getByRole("button", { name: "Collapse Queue pane" }).click();
  await expect(queue).toHaveAttribute("data-collapsed", "true");
  await page.waitForTimeout(400);

  const rep: any = await gridReport(page);
  console.log("QUEUE-COLLAPSED: " + JSON.stringify(rep));
  expect(rep.bodyDisplay).toBe("none");
  expect(rep.box.h).toBeLessThanOrEqual(48);
  expect(await paintedSpill(page)).toEqual([]);
  await expectRegionCovers(page, rep.box);
  await page.screenshot({ path: "docs/bug-reports/2.5.5/queue-collapsed.png" });
});
