import { test, expect, type Page } from "@playwright/test";
import { stubTauri, commandsNamed, delayNext, failNext } from "./tauri-mock";
import { TRACK_NAME, buildFixtures } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await stubTauri(page);
  await page.goto("/");
});

function toSeconds(text: string | null): number {
  const m = /(\d+):(\d{2})/.exec(text ?? "");
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]);
}

test("stage renders past the login gate with the playing track", async ({ page }) => {
  await expect(page.locator(".gate")).toHaveCount(0);
  await expect(page.locator(".stage")).toBeVisible();
  const player = page.locator('section[data-pane="player"]');
  await expect(player).toBeVisible();
  await expect(player.getByText(TRACK_NAME)).toBeVisible();
  await expect(player.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.screenshot({ path: "verify/web/test-results/player.png" });
});

function emitShortcut(page: Page, event: string) {
  return page.evaluate((name: string) => {
    const w = window as unknown as {
      __TAURI_EMIT_TO_APP__?: (event: string, payload: unknown) => void;
    };
    w.__TAURI_EMIT_TO_APP__?.(name, null);
  }, event);
}

test("pause flips to Play in under 200ms even when the cloud is slow", async ({ page }) => {
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();
  await expect(player.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

  // Slow cloud: pause answers after 1.2 s. The icon must flip at once
  // (optimistic state), not after the cloud resolves.
  await delayNext(page, "pause", 1200, 1);
  const t0 = Date.now();
  await player.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(player.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  expect(Date.now() - t0).toBeLessThan(200);

  // Cloud confirms later: exactly one pause, still showing Play.
  await expect
    .poll(async () => (await commandsNamed(page, "pause")).length, { timeout: 10000 })
    .toBe(1);
  await expect(player.getByRole("button", { name: "Play", exact: true })).toBeVisible();
});

test("failed pause rolls back to Pause with an error note", async ({ page }) => {
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();

  await failNext(page, "pause", "spotify 503 Service Unavailable: boom", 1);
  await player.getByRole("button", { name: "Pause", exact: true }).click();

  // The press fired, then the hard failure rolled the optimistic flip
  // back: Pause is showing again and the error is noted app-wide.
  await expect
    .poll(async () => (await commandsNamed(page, "pause")).length, { timeout: 10000 })
    .toBe(1);
  await expect(player.getByRole("button", { name: "Pause", exact: true })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.locator(".toasts")).toContainText("boom", { timeout: 10000 });
});

test("rapid next presses coalesce in order; other buttons stay live", async ({ page }) => {
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();
  const next = player.getByRole("button", { name: "Next track" });

  // Slow cloud: every next answers after 600 ms, so a button press plus
  // two global-chord presses overlap in flight. (Buttons gate on busy;
  // chords are the real way two presses overlap.) The first runs, the
  // chords coalesce to one trailing run (latest wins): exactly two
  // invokes, in order, none silently dropped.
  await delayNext(page, "next_track", 600, 5);
  await next.click();
  // Per-action busy: only next gates while in flight. The old global busy
  // disabled every transport button here.
  await expect(next).toBeDisabled();
  await expect(player.getByRole("button", { name: "Previous track" })).toBeEnabled();
  await expect(player.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  // Pending mark: the card dims until the cloud confirms.
  const dimmed = await player
    .locator(".player-card")
    .evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(dimmed).toBeLessThan(1);
  await emitShortcut(page, "shortcut-next");
  await emitShortcut(page, "shortcut-next");
  await expect
    .poll(async () => (await commandsNamed(page, "next_track")).length, { timeout: 10000 })
    .toBe(2);
  // No stuck disabled state once the pair settles and confirms.
  await expect(next).toBeEnabled({ timeout: 10000 });
  await expect(player.getByRole("button", { name: "Previous track" })).toBeEnabled();
  await expect
    .poll(
      async () =>
        Number(
          await player.locator(".player-card").evaluate((el) => getComputedStyle(el).opacity),
        ),
      { timeout: 10000 },
    ).toBe(1);
});

test("pause then play invoke the matching commands", async ({ page }) => {
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();

  await player.getByRole("button", { name: "Pause", exact: true }).click();
  await expect
    .poll(async () => (await commandsNamed(page, "pause")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
  await expect(player.getByRole("button", { name: "Play", exact: true })).toBeVisible();

  await player.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(async () => (await commandsNamed(page, "play")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
});

test("next invokes next_track", async ({ page }) => {
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();

  await page.getByRole("button", { name: "Next track" }).click();
  await expect
    .poll(async () => (await commandsNamed(page, "next_track")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
});

test("progress advances while playing", async ({ page }) => {
  const elapsed = page.locator('section[data-pane="player"] .times span').first();
  await expect(elapsed).toBeVisible();
  const t1 = toSeconds(await elapsed.textContent());
  expect(t1).toBeGreaterThanOrEqual(0);
  await page.waitForTimeout(1800);
  const t2 = toSeconds(await elapsed.textContent());
  expect(t2).toBeGreaterThan(t1);
});

test("throttled play queues, shows chip, and flushes once", async ({ page }) => {
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();

  // Reach the Play state with a clean pause first.
  await player.getByRole("button", { name: "Pause", exact: true }).click();
  await expect
    .poll(async () => (await commandsNamed(page, "pause")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
  await expect(player.getByRole("button", { name: "Play", exact: true })).toBeVisible();

  // Next play hits a mocked 429 once, then succeeds on flush.
  await failNext(page, "play", "rate-limited: retry after 1s", 1);
  await player.getByRole("button", { name: "Play", exact: true }).click();

  // Queued chip appears while the write is parked.
  await expect(player.getByText(/Queued/)).toBeVisible({ timeout: 10000 });

  // Flush after the 1 s cooldown: failed attempt + one retry.
  await expect
    .poll(async () => (await commandsNamed(page, "play")).length, { timeout: 10000 })
    .toBe(2);

  // Chip clears once the queue drains.
  await expect(player.getByText(/Queued/)).toHaveCount(0, { timeout: 10000 });

  // Never fires twice: no third attempt after settling.
  await page.waitForTimeout(1500);
  expect((await commandsNamed(page, "play")).length).toBe(2);
});

test("device block lives in Settings, not the player pane", async ({ page }) => {
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();
  // No Connect controls in the pane: only the text-only destination line.
  await expect(player.getByRole("group", { name: "Playback device" })).toHaveCount(0);
  await expect(player.getByRole("button", { name: "Choose playback device" })).toHaveCount(0);
  await expect(player.locator(".device-line")).toContainText("Verify Speaker");
});

test("device section names where sound plays", async ({ page }) => {
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const panel = dialog.getByRole("group", { name: "Playback device" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Sound plays on:");
  await expect(panel).toContainText("Verify Speaker");
  await expect(panel.getByRole("button", { name: "Play here via this overlay" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Keep playback there" })).toBeVisible();
  await page.screenshot({ path: "verify/web/test-results/settings-device.png" });
});

test("Play here moves sound onto the overlay and remembers it", async ({ page }) => {
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const panel = dialog.getByRole("group", { name: "Playback device" });

  await panel.getByRole("button", { name: "Play here via this overlay" }).click();
  await expect
    .poll(async () => (await commandsNamed(page, "transfer_playback")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
  const calls = await commandsNamed(page, "transfer_playback");
  expect(JSON.stringify(calls[calls.length - 1])).toContain("sdk-device-1");

  const stored = await page.evaluate(() => localStorage.getItem("snapify-device-choice"));
  expect(stored).toContain('"sdk"');

  await page.reload();
  await page.getByRole("button", { name: "Open settings" }).click();
  const panel2 = page.getByRole("dialog", { name: "Settings" }).getByRole("group", { name: "Playback device" });
  await expect(panel2).toContainText("remembered: this overlay");
});

test("Keep there transfers to the chosen device and remembers it", async ({ page }) => {
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const panel = dialog.getByRole("group", { name: "Playback device" });

  await panel.getByRole("button", { name: "Keep playback there" }).click();
  await expect
    .poll(async () => (await commandsNamed(page, "transfer_playback")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
  const stored = await page.evaluate(() => localStorage.getItem("snapify-device-choice"));
  expect(stored).toContain("dev-verify-1");

  await page.reload();
  await page.getByRole("button", { name: "Open settings" }).click();
  const panel2 = page.getByRole("dialog", { name: "Settings" }).getByRole("group", { name: "Playback device" });
  await expect(panel2).toContainText("remembered");
});

test("long titles marquee on hover", async ({ page }) => {
  const seed = buildFixtures();
  const base = seed.player as Record<string, unknown>;
  const longName = "A Very Long Fixture Anthem Title That Must Overflow The Narrow Player Card";
  const item = {
    ...(base["item"] as Record<string, unknown>),
    id: "verify-long-01",
    name: longName,
    uri: "spotify:track:verify-long-01",
  };
  await stubTauri(page, { fixtures: { player: { ...base, item } } });
  await page.goto("/");
  const player = page.locator('section[data-pane="player"]');
  const title = player.locator(".track-title");
  await expect(title).toContainText(longName.slice(0, 24));

  await player.locator(".title-row").hover();
  await expect(title).toHaveClass(/is-marquee/, { timeout: 5000 });
  const dist = await title.evaluate((el) => getComputedStyle(el).getPropertyValue("--marquee-dist"));
  expect(parseFloat(dist)).toBeGreaterThan(0);

  // Leaving settles back to plain ellipsis.
  await page.mouse.move(4, 4);
  await expect(title).not.toHaveClass(/is-marquee/, { timeout: 5000 });
});

test("short titles never marquee", async ({ page }) => {
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();
  const title = player.locator(".track-title");
  await player.locator(".title-row").hover();
  await page.waitForTimeout(700);
  await expect(title).not.toHaveClass(/is-marquee/);
});

test("player collapses to the 64px mini row and persists", async ({ page }) => {
  // Lowered pane: the floating dock overlaps pane headers near the top.
  await stubTauri(page, {
    layout: {
      version: 3,
      preset: "custom",
      panes: [
        { id: "player", type: "player", x: 24, y: 200, w: 340, h: 260, opacity: 0.92, visible: true, z: 1 },
      ],
    },
  });
  await page.goto("/");
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();

  await player.getByRole("button", { name: "Collapse Player pane" }).click();
  await expect(player).toHaveAttribute("data-collapsed", "true");
  await expect(player.locator(".mini-row")).toBeVisible();
  await expect(player.locator(".player-full")).toBeHidden();
  await expect(player.locator(".mini-row")).toContainText(TRACK_NAME);
  await expect(
    player.locator(".mini-row").getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();

  const box = await player.boundingBox();
  if (!box) throw new Error("player has no box");
  expect(box.height).toBeLessThanOrEqual(72);

  // The collapsed flag persists per scene, not as a preset swap.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("snapify-layout-v3")!));
  expect(saved.version).toBe(4);
  expect(
    saved.scenes[saved.activeScene].panes.find((p) => p.type === "player").collapsed,
  ).toBe(true);

  await stubTauri(page, { layout: JSON.parse(JSON.stringify(saved)) });
  await page.reload();
  const reloaded = page.locator('section[data-pane="player"]');
  await expect(reloaded).toHaveAttribute("data-collapsed", "true");
  await expect(reloaded.locator(".mini-row")).toBeVisible();

  // Expand restores the full player.
  await reloaded.getByRole("button", { name: "Expand Player pane" }).click();
  await expect(reloaded.locator(".player-full")).toBeVisible();
  await expect(reloaded.locator(".mini-row")).toBeHidden();
});

const VIZ_LAYOUT = {
  version: 3,
  preset: "custom",
  panes: [
    {
      id: "player",
      type: "player",
      x: 24,
      y: 200,
      w: 340,
      h: 260,
      opacity: 0.92,
      visible: true,
      z: 1,
    },
    {
      id: "viz",
      type: "visualizer",
      x: 376,
      y: 200,
      w: 340,
      h: 260,
      opacity: 0.92,
      visible: true,
      z: 2,
    },
  ],
};

test("one banner type covers player and visualizer while throttled", async ({ page }) => {
  // Paused seed: the player poll backs off to 20 s, so the throttled
  // episode stays up long enough to assert both banners.
  const seed = buildFixtures();
  (seed.player as Record<string, unknown>)["is_playing"] = false;
  await stubTauri(page, { layout: VIZ_LAYOUT, fixtures: { player: seed.player } });
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss shortcut hint" }).click();

  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText(TRACK_NAME)).toBeVisible();

  // Every play attempt 429s: the write parks, the episode pins degraded UI.
  await failNext(page, "play", "rate-limited: retry after 1s", 50);
  await player.getByRole("button", { name: "Play", exact: true }).click();
  await expect(player.getByText(/Queued/)).toBeVisible({ timeout: 10000 });

  const bannerCopy = "Spotify throttled — retrying in background.";
  await expect(player.getByText(bannerCopy)).toBeVisible({ timeout: 4000 });
  const viz = page.locator('section[data-pane="visualizer"]');
  await expect(viz.getByText(bannerCopy)).toBeVisible({ timeout: 4000 });

  // Retry re-polls and clears the episode everywhere at once.
  await viz.getByRole("button", { name: "Retry" }).click();
  await expect(viz.getByText(bannerCopy)).toHaveCount(0);
  await expect(player.getByText(bannerCopy)).toHaveCount(0);
});
