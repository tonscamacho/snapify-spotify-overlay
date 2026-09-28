// Walled (friend / non-owned) playlist tracks.
//
// Contract for the walled-tracks patch (see docs/plans/friend-playlist-tracks-patch.md):
// an alternate track source behind a kill-switch flag (default ON per the
// GO gate; SNAPIFY_EMBED_FALLBACK=0 restores the wall) with the honest wall
// as the fallback. These specs pin the flag-OFF behavior with the existing
// mock seams only (stubTauri fixtures + failNext on get_playlist_items):
//
// - a single 403 recovers to rendered tracks on Retry (the fallback half of
//   the contract: the list is recoverable, Play stays intact throughout);
// - a persistent 403 keeps the honest wall with Play + Retry + Open in
//   Spotify, and Play still fires play_context from the wall;
// - an owned playlist with seeded tracks renders without ever touching the wall.
//
// When the patch's alternate source lands (flag ON), the first test's wall
// step is replaced by an automatic tracks render: the spec already accepts
// both orders (race-poll below) and the final assertions — track rows
// visible, Play intact — hold in both worlds.

import { test, expect, type Page } from "@playwright/test";
import { stubTauri, commandsNamed, failNext } from "./tauri-mock";
import { buildFixtures, type VerifyFixtures } from "./fixtures";

const FRIEND_OWNER = "someone-else";
const WALL_403 = "get_playlist_items failed: 403 Restriction violated";
const FRIEND_TRACKS = [
  {
    id: "friend-track-1",
    name: "Friend Track One",
    artists: [{ name: "Friend Band" }],
    album: { name: "Friend Album", images: [] },
    duration_ms: 200000,
    uri: "spotify:track:friend-track-1",
    explicit: false,
  },
  {
    id: "friend-track-2",
    name: "Friend Track Two",
    artists: [{ name: "Friend Band" }],
    album: { name: "Friend Album", images: [] },
    duration_ms: 180000,
    uri: "spotify:track:friend-track-2",
    explicit: false,
  },
];

/** Metadata-only detail: no tracks/items node, so parsePlaylistDetail flags it walled. */
function walledDetail() {
  return {
    id: "pl-verify-1",
    name: "Verify Jams",
    owner: { display_name: FRIEND_OWNER },
    images: [],
    uri: "spotify:playlist:pl-verify-1",
  };
}

function itemsOf(tracks: typeof FRIEND_TRACKS) {
  return { items: tracks.map((track) => ({ track })), total: tracks.length };
}

async function bootFriendPlaylist(page: Page, fixtures?: Partial<VerifyFixtures>) {
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
}

async function openFriendPlaylistDetail(page: Page) {
  await page.getByTitle("Toggle Queue pane").click();
  const queue = page.locator('section[data-pane="queue"]');
  await expect(queue).toBeVisible();
  await queue.getByRole("button", { name: "Open Verify Jams" }).click();

  const browse = page.locator('section[data-pane="browse"]');
  await expect(browse).toBeVisible();
  await expect(browse.locator(".detail-title")).toContainText("Verify Jams");
  return browse;
}

test("walled 403 falls back to tracks on retry with Play intact", async ({ page }) => {
  await bootFriendPlaylist(page, {
    playlistDetail: walledDetail(),
    playlistItems: itemsOf(FRIEND_TRACKS),
  });
  // Register before the detail fetch fires so the first items call 403s.
  await failNext(page, "get_playlist_items", WALL_403, 1);
  const browse = await openFriendPlaylistDetail(page);

  const rows = browse.locator("ol.queue li.q");
  const wall = browse.getByText("Tracks unavailable");
  // Flag OFF shows the wall first and Retry recovers; a flag-ON alternate
  // source would render the rows directly. Accept either order.
  await expect
    .poll(
      async () => ((await rows.count()) > 0 ? "tracks" : (await wall.count()) > 0 ? "wall" : "pending"),
      { timeout: 10000 },
    )
    .not.toBe("pending");
  if ((await rows.count()) === 0) {
    await expect(wall).toBeVisible();
    await browse.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(rows.first()).toBeVisible({ timeout: 10000 });
  }

  await expect(rows).toHaveCount(FRIEND_TRACKS.length);
  await expect(browse).toContainText("Friend Track One");
  await expect(browse).toContainText("Friend Track Two");
  await expect(wall).toHaveCount(0);
  await expect(browse.getByRole("button", { name: "Play", exact: true }).first()).toBeVisible();
  await expect
    .poll(async () => (await commandsNamed(page, "get_playlist_items")).length, { timeout: 10000 })
    .toBeGreaterThan(0);
});

test("persistent 403 keeps the honest wall with Play intact", async ({ page }) => {
  await bootFriendPlaylist(page, {
    playlistDetail: walledDetail(),
    playlistItems: itemsOf(FRIEND_TRACKS),
  });
  // Every items call fails, including manual retries.
  await failNext(page, "get_playlist_items", WALL_403, 99);
  const browse = await openFriendPlaylistDetail(page);

  await expect(browse.getByText("Tracks unavailable")).toBeVisible({ timeout: 10000 });
  await expect(browse).toContainText(`owner: ${FRIEND_OWNER}`);
  // Header Play plus the wall's own Play: both stay available.
  const plays = browse.getByRole("button", { name: "Play", exact: true });
  await expect(plays).toHaveCount(2);
  await expect(browse.getByRole("button", { name: "Open in Spotify" })).toBeVisible();
  await expect(browse.locator("ol.queue li.q")).toHaveCount(0);

  // Play still works from the wall: the context URI plays even though the
  // track list is owner-only.
  await plays.first().click();
  await expect
    .poll(async () => (await commandsNamed(page, "play_context")).length, { timeout: 10000 })
    .toBeGreaterThan(0);

  // The alternate source is also unavailable in this mock, so Retry keeps
  // the wall instead of inventing tracks.
  await browse.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(browse.getByText("Tracks unavailable")).toBeVisible({ timeout: 10000 });
  await expect(browse.locator("ol.queue li.q")).toHaveCount(0);
  await expect
    .poll(async () => (await commandsNamed(page, "get_playlist_items")).length, { timeout: 10000 })
    .toBeGreaterThan(1);
  await page.screenshot({ path: "verify/web/test-results/walled-tracks.png" });
});

test("owned playlist renders tracks without the wall", async ({ page }) => {
  const seed = buildFixtures();
  await bootFriendPlaylist(page, {
    playlistDetail: {
      ...(seed.playlistDetail as Record<string, unknown>),
      tracks: { items: FRIEND_TRACKS.map((track) => ({ track })), total: FRIEND_TRACKS.length },
    },
  });
  const browse = await openFriendPlaylistDetail(page);

  const rows = browse.locator("ol.queue li.q");
  await expect(rows).toHaveCount(FRIEND_TRACKS.length);
  await expect(browse).toContainText("Friend Track One");
  await expect(browse.getByText("Tracks unavailable")).toHaveCount(0);
  await expect(browse.getByText("Couldn't load tracks")).toHaveCount(0);
  await expect(browse.getByRole("button", { name: "Play", exact: true }).first()).toBeVisible();
});
