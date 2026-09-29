import { test, expect } from "@playwright/test";
import { stubTauri } from "./tauri-mock";
import { TRACK_NAME } from "./fixtures";

function layoutFor(w: number) {
  return {
    version: 3,
    preset: "custom",
    panes: [
      { id: "player", type: "player", x: 24, y: 200, w, h: 260, opacity: 0.92, visible: true, z: 1 },
      { id: "queue", type: "queue", x: 400, y: 200, w, h: 260, opacity: 0.92, visible: true, z: 2 },
      { id: "lyrics", type: "lyrics", x: 780, y: 200, w: 300, h: 260, opacity: 0.92, visible: true, z: 3 },
    ],
  };
}

async function measure(page, sel: string) {
  return page.locator(sel).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const body = el.querySelector(".pane-body") as HTMLElement | null;
    const head = el.querySelector(".pane-handle") as HTMLElement | null;
    const bcs = body ? getComputedStyle(body) : null;
    const full = el.querySelector(".player-full") as HTMLElement | null;
    const mini = el.querySelector(".mini-row") as HTMLElement | null;
    const vis = (n: Element | null) => {
      if (!n) return "absent";
      const s = getComputedStyle(n as HTMLElement);
      const rr = (n as HTMLElement).getBoundingClientRect();
      return `${s.display}/${Math.round(rr.width)}x${Math.round(rr.height)}`;
    };
    return {
      box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      headerH: head ? Math.round(head.getBoundingClientRect().height) : -1,
      collapsed: el.getAttribute("data-collapsed"),
      bodyDisplay: bcs?.display ?? "absent",
      bodyClientH: body?.clientHeight ?? -1,
      playerFull: vis(full),
      miniRow: vis(mini),
    };
  });
}

async function collapseAll(page, force = false) {
  for (const name of ["Player", "Queue", "Lyrics"]) {
    const pane = page.locator(`section[data-pane="${name.toLowerCase()}"]`);
    const btn = pane.getByRole("button", { name: `Collapse ${name} pane` });
    if (force) await btn.click({ force: true });
    else await btn.click();
    await expect(pane).toHaveAttribute("data-collapsed", "true");
  }
  await page.waitForTimeout(300);
}

for (const w of [280, 360]) {
  test(`collapsed census at ${w}px, all types`, async ({ page }) => {
    await stubTauri(page, { layout: layoutFor(w) });
    await page.goto("/");
    await expect(page.locator('section[data-pane="player"]').getByText(TRACK_NAME).first()).toBeAttached();
    await collapseAll(page);

    const pm = await measure(page, 'section[data-pane="player"]');
    const qm = await measure(page, 'section[data-pane="queue"]');
    const lm = await measure(page, 'section[data-pane="lyrics"]');
    console.log(`PLAYER@${w}: ` + JSON.stringify(pm));
    console.log(`QUEUE@${w}: ` + JSON.stringify(qm));
    console.log(`LYRICS@${w}: ` + JSON.stringify(lm));
    await page.screenshot({ path: `docs/bug-reports/2.5.1/collapsed-after-${w}.png` });

    expect(pm.box.h).toBeLessThanOrEqual(48);
    expect(pm.bodyDisplay).toBe("none");
    expect(pm.miniRow.split("/")[0]).toBe("absent");
    expect(qm.bodyDisplay).toBe("none");
    expect(qm.box.h).toBeLessThanOrEqual(48);
    expect(lm.bodyDisplay).toBe("none");
    expect(lm.box.h).toBeLessThanOrEqual(48);
  });
}

test("collapsed census on narrow stage", async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 800 });
  await stubTauri(page, {
    layout: {
      version: 3,
      preset: "custom",
      panes: [
        { id: "player", type: "player", x: 8, y: 100, w: 280, h: 260, opacity: 0.92, visible: true, z: 1 },
        { id: "queue", type: "queue", x: 8, y: 380, w: 260, h: 260, opacity: 0.92, visible: true, z: 2 },
      ],
    },
  });
  await page.goto("/");
  await expect(page.locator('section[data-pane="player"]').getByText(TRACK_NAME).first()).toBeAttached();
  const player = page.locator('section[data-pane="player"]');
  const queue = page.locator('section[data-pane="queue"]');
  await player.getByRole("button", { name: "Collapse Player pane" }).click();
  await queue.getByRole("button", { name: "Collapse Queue pane" }).click();
  await expect(player).toHaveAttribute("data-collapsed", "true");
  await expect(queue).toHaveAttribute("data-collapsed", "true");
  await page.waitForTimeout(300);
  const pm = await measure(page, 'section[data-pane="player"]');
  const qm = await measure(page, 'section[data-pane="queue"]');
  console.log(`PLAYER@narrow: ` + JSON.stringify(pm));
  console.log(`QUEUE@narrow: ` + JSON.stringify(qm));
  await page.screenshot({ path: `docs/bug-reports/2.5.1/collapsed-after-narrow.png` });
  expect(pm.box.h).toBeLessThanOrEqual(48);
  expect(pm.bodyDisplay).toBe("none");
  expect(pm.miniRow.split("/")[0]).toBe("absent");
  expect(qm.bodyDisplay).toBe("none");
  expect(qm.box.h).toBeLessThanOrEqual(48);
});
