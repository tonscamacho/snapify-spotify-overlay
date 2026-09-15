import { test, expect, type Page } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";
import { buildFixtures, type VerifyFixtures } from "./fixtures";

async function openPlaylistDetail(page: Page, fixtures?: Partial<VerifyFixtures>) {
  const seed = buildFixtures();
  await stubTauri(page, {
    fixtures: {
      queue: {
        ...(seed.queue as Record<string, unknown>),
        context: { type: "playlist", uri: "spotify:playlist:pl-verify-1" },
      },
      ...fixtures,
    },
  });
  await page.goto("/");

  await page.getByTitle("Toggle Queue pane").click();
  const queue = page.locator('section[data-pane="queue"]');
  await expect(queue).toBeVisible();
  await queue.getByRole("button", { name: "Open Verify Jams" }).click();

  const browse = page.locator('section[data-pane="browse"]');
  await expect(browse).toBeVisible();
  await expect(browse.locator(".detail-title")).toContainText("Verify Jams");
  return browse;
}

test("empty playlist hides Play and says no tracks", async ({ page }) => {
  const browse = await openPlaylistDetail(page);
  await expect(browse).toContainText("No tracks here");
  await expect(browse.getByRole("button", { name: "Play", exact: true })).toHaveCount(0);
});

test("playlist with tracks plays its context", async ({ page }) => {
  const seed = buildFixtures();
  const browse = await openPlaylistDetail(page, {
    playlistDetail: {
      ...(seed.playlistDetail as Record<string, unknown>),
      tracks: { items: [{ track: seed.trackDetail }], total: 1 },
    },
  });

  const play = browse.getByRole("button", { name: "Play", exact: true });
  await expect(play).toBeVisible();
  await play.click();
  await expect
    .poll(async () => (await commandsNamed(page, "play_context")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
});

test("walled playlist keeps Play on metadata-only detail", async ({ page }) => {
  const browse = await openPlaylistDetail(page, {
    playlistDetail: {
      id: "pl-verify-1",
      name: "Verify Jams",
      owner: { display_name: "someone-else" },
      images: [],
      uri: "spotify:playlist:pl-verify-1",
    },
    playlistItems: { items: [], total: 0 },
  });
  await expect(browse.getByRole("button", { name: "Play", exact: true })).toBeVisible();
});
