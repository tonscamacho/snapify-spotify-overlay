// Multi-file history import: the dialog opens with multiple:true + a
// .json filter, each path is read Rust-side (read_history_file per
// path, no frontend fs reads), and the combined rows land in a single
// import_history call so cross-file dedupe/tally is one transaction.
// A bad file yields a per-file note while the good files still import.
import { test, expect, type Page } from "@playwright/test";
import { stubTauri, commandsNamed, invokedCommands, mockHistoryFiles } from "./tauri-mock";
import { PROFILE_ME_NAME } from "./fixtures";

const PROFILE_LAYOUT = {
  version: 3,
  preset: "custom",
  panes: [
    { id: "profile", type: "profile", x: 24, y: 24, w: 420, h: 560, opacity: 0.92, visible: true, z: 1 },
    { id: "player", type: "player", x: 456, y: 24, w: 340, h: 230, opacity: 0.92, visible: true, z: 2 },
  ],
};

async function bootProfile(page: Page) {
  await stubTauri(page, { layout: PROFILE_LAYOUT, edit: true });
  await page.goto("/");
  const profile = page.locator('section[data-pane="profile"]');
  await expect(profile).toBeVisible();
  return profile;
}

function row(uri: string, ts: string, ms = 200000, over: Record<string, unknown> = {}) {
  return {
    ts,
    ms_played: ms,
    master_metadata_track_name: `Song ${uri}`,
    master_metadata_album_artist_name: "Multi Band",
    master_metadata_album_album_name: `Album ${uri.slice(-1)}`,
    spotify_track_uri: uri,
    reason_end: "trackdone",
    skipped: false,
    ...over,
  };
}

test("multi-file import reads 3 paths and calls import_history once", async ({ page }) => {
  const profile = await bootProfile(page);
  await expect(profile.locator(".detail-head .detail-title")).toContainText(PROFILE_ME_NAME);

  const now = Date.now();
  const iso = (agoMs: number) => new Date(now - agoMs).toISOString();
  const paths = ["endsong_0.json", "endsong_1.json", "endsong_bad.json"];
  await mockHistoryFiles(
    page,
    paths,
    {
      "endsong_0.json": JSON.stringify([row("spotify:track:multi-a", iso(3600000))]),
      "endsong_1.json": JSON.stringify([
        row("spotify:track:multi-a", iso(3600000)),
        row("spotify:track:multi-b", iso(7200000)),
      ]),
      "endsong_bad.json": "{not-json",
    },
  );

  await profile.getByRole("button", { name: "Import history" }).click();

  // The combined tally arrives: 3 rows read across the good files, one
  // cross-file dupe, surfaced with the 3-file count.
  await expect(profile.getByText(/Imported 2 of 3/, { exact: false })).toBeVisible({ timeout: 10000 });
  await expect(profile.getByText(/across 3 files/, { exact: false })).toBeVisible();
  // The bad file is a per-file note in the existing import slot, and the
  // import still completed instead of aborting.
  await expect(profile.getByText(/endsong_bad\.json/, { exact: false })).toBeVisible();

  const reads = await commandsNamed(page, "read_history_file");
  expect(reads.length).toBe(3);
  expect(reads.map((a) => String(a["path"])).sort()).toEqual([...paths].sort());

  const imports = await commandsNamed(page, "import_history");
  expect(imports.length).toBe(1);
  const rows = (imports[0]?.["rows"] ?? []) as unknown[];
  expect(rows.length).toBe(3);

  // The dialog opened multi-select with a .json filter.
  const all = await invokedCommands(page);
  const dialogs = all.filter((c) => c.cmd === "plugin:dialog|open");
  expect(dialogs.length).toBeGreaterThanOrEqual(1);
  const opts = dialogs[dialogs.length - 1]?.args as Record<string, unknown>;
  const openOpts = (opts["options"] ?? opts) as Record<string, unknown>;
  expect(openOpts["multiple"]).toBe(true);
  const filters = (openOpts["filters"] ?? []) as Array<{ extensions?: string[] }>;
  expect(filters.some((f) => (f.extensions ?? []).includes("json"))).toBe(true);
});

test("3-file import with a skipped-long row counts it and shows hours/albums", async ({ page }) => {
  const profile = await bootProfile(page);
  await expect(profile.locator(".detail-head .detail-title")).toContainText(PROFILE_ME_NAME);

  const now = Date.now();
  const iso = (agoMs: number) => new Date(now - agoMs).toISOString();
  const paths = ["endsong_0.json", "endsong_1.json", "endsong_2.json"];
  await mockHistoryFiles(
    page,
    paths,
    {
      "endsong_0.json": JSON.stringify([row("spotify:track:multi-a", iso(3600000))]),
      "endsong_1.json": JSON.stringify([
        row("spotify:track:multi-b", iso(7200000), 200000, { skipped: true }),
        row("spotify:track:multi-short", iso(7300000), 10000),
      ]),
      "endsong_2.json": JSON.stringify([
        row("spotify:episode:pod1", iso(7400000)),
        row("spotify:track:multi-c", iso(8000000)),
      ]),
    },
  );

  await profile.getByRole("button", { name: "Import history" }).click();

  // 5 rows read: 3 kept (a, skipped-long b, c), 1 short, 1 podcast/no-uri.
  // Skipped-long COUNTS (stats.fm parity); only short/podcast drop.
  await expect(profile.getByText(/Imported 3 of 5/, { exact: false })).toBeVisible({ timeout: 10000 });
  await expect(profile.getByText(/1 short/, { exact: false })).toBeVisible();
  await expect(profile.getByText(/1 no-uri/, { exact: false })).toBeVisible();
  await expect(profile.getByText(/across 3 files/, { exact: false })).toBeVisible();

  // Lifetime totals are honest: the skipped-long row lifts Streams.
  // Default 4W slice holds the 3 imports (all within 28d) plus the 4
  // recent-window recents = 7 streams; Hours + Albums tiles render.
  await expect(profile.getByText("Hours", { exact: true })).toBeVisible();
  await expect(profile.getByText("Albums", { exact: true })).toBeVisible();
  await expect(profile.getByText(/Includes imported Extended history\./)).toBeVisible();

  const imports = await commandsNamed(page, "import_history");
  expect(imports.length).toBeGreaterThanOrEqual(1);
  const sent = (imports[imports.length - 1]?.["rows"] ?? []) as unknown[];
  expect(sent.length).toBe(5);
});
