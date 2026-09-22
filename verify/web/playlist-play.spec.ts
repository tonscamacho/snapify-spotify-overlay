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

test("playlist follow toggles optimistically", async ({ page }) => {
  const browse = await openPlaylistDetail(page);
  const follow = browse.getByRole("button", { name: "Follow", exact: true });
  await expect(follow).toBeVisible();
  await follow.click();
  await expect
    .poll(async () => (await commandsNamed(page, "follow_put")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
  // Accessible name flips to Unfollow while the label reads Following.
  await expect(browse.getByRole("button", { name: "Unfollow", exact: true })).toBeVisible();
  await expect(browse).toContainText("Following ✓");
});

test("track rows open detail where Save reconciles against the server", async ({ page }) => {
  const seed = buildFixtures();
  const browse = await openPlaylistDetail(page, {
    playlistDetail: {
      ...(seed.playlistDetail as Record<string, unknown>),
      tracks: { items: [{ track: seed.trackDetail }], total: 1 },
    },
  });
  await browse.getByRole("button", { name: "Open Fixture Anthem" }).click();
  await expect(browse.locator(".detail-title")).toContainText("Fixture Anthem");
  // The mock library is saved, so reconcile flips Save to Remove on load.
  const remove = browse.getByRole("button", { name: "Remove from your library" });
  await expect(remove).toBeVisible({ timeout: 10000 });
  await remove.click();
  await expect
    .poll(async () => (await commandsNamed(page, "library_remove")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
});

test("search records recents locally and pages past the first window", async ({ page }) => {
  const songs = Array.from({ length: 10 }, (_, i) => ({
    id: `page-song-${i + 1}`,
    name: `Page Song ${i + 1}`,
    artists: [{ name: "Page Band" }],
    album: { name: "Page Album", images: [] },
    duration_ms: 180000,
    uri: `spotify:track:page-song-${i + 1}`,
    explicit: false,
  }));
  await stubTauri(page, {
    fixtures: {
      search: {
        tracks: { items: songs },
        artists: { items: [] },
        playlists: { items: [] },
        albums: { items: [] },
        shows: { items: [] },
        episodes: { items: [] },
        audiobooks: { items: [] },
      },
    },
  });
  await page.goto("/");
  await page.getByTitle("Toggle Browse pane").click();
  const browse = page.locator('section[data-pane="browse"]');
  await expect(browse).toBeVisible();
  await browse.getByRole("tab", { name: "Search" }).click();
  await browse.getByLabel("Search Spotify").fill("page band");

  await expect(browse).toContainText("Page Song 1");
  // Recents sit above the results, local only.
  await expect(browse.getByLabel("Recent searches", { exact: true })).toContainText("page band");

  // A full first window fires the sentinel for page two (offset 10); the
  // duplicate guard stops paging there and merges without doubling rows.
  await browse.locator(".sentinel").first().scrollIntoViewIfNeeded();
  await expect
    .poll(async () => (await commandsNamed(page, "search")).length, { timeout: 10000 })
    .toBe(2);
  const calls = await commandsNamed(page, "search");
  expect(calls[0]["offset"]).toBe(0);
  expect(calls[1]["offset"]).toBe(10);
  await expect(browse.locator("ol.queue li.q")).toHaveCount(10);
});

test("artist detail backfills top songs from search and marks the source", async ({ page }) => {
  await stubTauri(page);
  await page.goto("/");
  await page.getByTitle("Toggle Browse pane").click();
  const browse = page.locator('section[data-pane="browse"]');
  await expect(browse).toBeVisible();
  await browse.getByLabel("Library section").selectOption("artists");
  await browse.getByRole("button", { name: "Open Fixture Band" }).click();
  await expect(browse.locator(".detail-title")).toContainText("Fixture Band");
  await expect(browse.getByText("Top songs · from search")).toBeVisible({ timeout: 10000 });
  await expect(browse).toContainText("Fixture Anthem");
  await page.screenshot({ path: "verify/web/test-results/artist-backfill.png" });
});

test("episode detail carries a show-notes link", async ({ page }) => {
  // The mock episode endpoint returns the trackDetail fixture verbatim, so
  // shape it like the episode the UI asked for.
  await stubTauri(page, {
    fixtures: {
      trackDetail: {
        id: "ep-verify-1",
        name: "Verify Episode",
        images: [],
        show: { name: "Verify Cast" },
        duration_ms: 3600000,
        uri: "spotify:episode:ep-verify-1",
        explicit: false,
      },
      savedEpisodes: {
        items: [
          {
            episode: {
              id: "ep-verify-1",
              name: "Verify Episode",
              images: [],
              show: { name: "Verify Cast" },
              duration_ms: 3600000,
              uri: "spotify:episode:ep-verify-1",
              explicit: false,
            },
          },
        ],
        total: 1,
      },
    },
  });
  await page.goto("/");
  await page.getByTitle("Toggle Browse pane").click();
  const browse = page.locator('section[data-pane="browse"]');
  await expect(browse).toBeVisible();
  await browse.getByLabel("Library section").selectOption("episodes");
  await browse.getByRole("button", { name: "Open Verify Episode" }).click();
  await expect(browse.locator(".detail-title")).toContainText("Verify Episode");
  const notes = browse.getByRole("button", { name: "Open show notes in Spotify" });
  await expect(notes).toBeVisible();
  await notes.click();
  await expect(browse.locator(".detail-title")).toContainText("Verify Episode");
});

// PlayerPane episode/like behaviors live here because player.spec.ts is
// reserved for the device panel under the v2 track bounds.
test("episode resume chip, 15s seek, notes, and honest speed", async ({ page }) => {
  const seed = buildFixtures();
  await stubTauri(page, {
    fixtures: {
      player: {
        ...(seed.player as Record<string, unknown>),
        is_playing: false,
        progress_ms: 120000,
        item: {
          id: "ep-verify-1",
          name: "Verify Episode",
          artists: [{ name: "Verify FM" }],
          album: { name: "Verify Cast", images: [] },
          duration_ms: 3600000,
          uri: "spotify:episode:ep-verify-1",
          explicit: false,
        },
      },
    },
  });
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem("snapify-episode-resume", JSON.stringify({ "ep-verify-1": 600000 })),
  );
  await page.reload();
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText("Verify Episode")).toBeVisible();

  const resume = player.getByRole("button", { name: "Resume from 10:00" });
  await expect(resume).toBeVisible();
  await resume.click();
  await expect
    .poll(async () => (await commandsNamed(page, "seek")).length, { timeout: 10000 })
    .toBeGreaterThan(0);

  await expect(player.getByRole("button", { name: "Back 15 seconds" })).toBeVisible();
  await expect(player.getByRole("button", { name: "Forward 15 seconds" })).toBeVisible();
  await expect(player.getByRole("button", { name: "Open show notes in Spotify" })).toBeVisible();
  await expect(player.locator("#ep-speed")).toBeDisabled();
  await expect(player).toContainText("N/A via SDK");
  await page.screenshot({ path: "verify/web/test-results/player-episode.png" });
});

test("player heart reconciles against the server on load", async ({ page }) => {
  await stubTauri(page);
  await page.goto("/");
  const player = page.locator('section[data-pane="player"]');
  await expect(player.getByText("Fixture Anthem")).toBeVisible();
  // The mock library holds the track, so the heart settles pressed.
  const heart = player.getByRole("button", { name: "Remove from library" });
  await expect(heart).toBeVisible({ timeout: 10000 });
  await heart.click();
  await expect
    .poll(async () => (await commandsNamed(page, "library_remove")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
});
