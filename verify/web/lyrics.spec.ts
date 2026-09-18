import { test, expect, type Page } from "@playwright/test";
import { stubTauri, commandsNamed } from "./tauri-mock";
import { ACTIVE_CUE_T, ACTIVE_LINE, TRACK_ID, TRACK_NAME, TRACK_ARTISTS, TRACK_ALBUM, TRACK_DURATION_MS, TRACK_URI, DEVICE_ID, type LyricCueFixture } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await stubTauri(page);
  await page.goto("/");
});

test("synced lines render with an active highlight", async ({ page }) => {
  const lyrics = page.locator('section[data-pane="lyrics"]');
  await expect(lyrics).toBeVisible();

  const lines = lyrics.locator("button.line");
  await expect(lines.first()).toBeVisible();
  expect(await lines.count()).toBeGreaterThanOrEqual(4);

  const active = lyrics.locator("button.line.on");
  await expect(active).toHaveAttribute("aria-current", "true");
  await expect(active).toContainText(ACTIVE_LINE);
  await page.screenshot({ path: "verify/web/test-results/lyrics.png" });
});

test("clicking the active line seeks to its cue", async ({ page }) => {
  const active = page.locator('section[data-pane="lyrics"] button.line.on');
  await expect(active).toBeVisible();
  await active.click();

  await expect
    .poll(
      async () =>
        (await commandsNamed(page, "seek")).map(
          (a) => (a["positionMs"] ?? a["position_ms"]) as number,
        ),
      { timeout: 10000 },
    )
    .toContain(ACTIVE_CUE_T);
});

// 1 s-spaced cues around the 65 s fixture progress so a ±500 ms nudge
// visibly moves the active line.
const OFFSET_CUES: LyricCueFixture[] = [
  { t: 60000, text: "early line" },
  { t: 63000, text: "warming up" },
  { t: 64000, text: "line-before" },
  { t: 65000, text: "target-line" },
  { t: 66000, text: "after line" },
  { t: 70000, text: "later line" },
];

// Paused player: positionMs stays pinned at 65 s (no interpolation
// tick, no sawtooth), so cue-boundary assertions are deterministic.
function pausedPlayer(trackId: string) {
  return {
    is_playing: false,
    progress_ms: 65000,
    item: {
      id: trackId,
      name: TRACK_NAME,
      artists: [{ name: TRACK_ARTISTS }],
      album: { name: TRACK_ALBUM, images: [] },
      duration_ms: TRACK_DURATION_MS,
      uri: trackId === TRACK_ID ? TRACK_URI : `spotify:track:${trackId}`,
      explicit: false,
    },
    device: { id: DEVICE_ID, name: "Verify Speaker", volume_percent: 80 },
    shuffle_state: false,
    repeat_state: "off",
  };
}

async function gotoWithLyrics(page: Page, lyrics: object) {
  const trackId = (lyrics as { trackId?: string }).trackId ?? TRACK_ID;
  await stubTauri(page, {
    fixtures: { lyrics: lyrics as never, player: pausedPlayer(trackId) as never },
  });
  await page.goto("/");
}

test("offset stepper shifts the active line and persists across reload", async ({
  page,
}) => {
  await gotoWithLyrics(page, {
    trackId: TRACK_ID,
    synced: true,
    instrumental: false,
    cues: OFFSET_CUES,
    plain: null,
    cached: false,
  });
  const pane = page.locator('section[data-pane="lyrics"]');

  await expect(pane.locator("button.line.on")).toContainText("target-line");
  await expect(pane.getByText("Sync ±0 ms")).toBeVisible();

  await pane.getByRole("button", { name: /shift lyrics later/i }).click();
  await expect(pane.getByText("Sync +500 ms")).toBeVisible();
  await expect(pane.locator("button.line.on")).toContainText("line-before");

  await page.reload();
  const pane2 = page.locator('section[data-pane="lyrics"]');
  await expect(pane2.getByText("Sync +500 ms")).toBeVisible();
  await expect(pane2.locator("button.line.on")).toContainText("line-before");

  await pane2.getByRole("button", { name: /reset lyric sync/i }).click();
  await expect(pane2.getByText("Sync ±0 ms")).toBeVisible();
  await expect(pane2.locator("button.line.on")).toContainText("target-line");
});

test("word-timed cues render word highlight, plain cues interpolate", async ({
  page,
}) => {
  const cues = [
    { t: 60000, text: "early line" },
    {
      t: 65000,
      text: "half way home",
      words: [
        { t: 65000, text: "half" },
        { t: 65400, text: "way" },
        { t: 65800, text: "home" },
      ],
    },
    { t: 70000, text: "later line" },
  ] as unknown as LyricCueFixture[];
  await gotoWithLyrics(page, {
    trackId: TRACK_ID,
    synced: true,
    instrumental: false,
    cues,
    plain: null,
    cached: false,
  });
  const active = page.locator('section[data-pane="lyrics"] button.line.on');
  await expect(active).toContainText("half way home");
  // First word elapsed at exactly 65 s; the tail words are still pending.
  // (Done spans carry both classes, so pending selects :not(.w-done).)
  await expect(active.locator("span.w-done")).toHaveCount(1);
  await expect(active.locator("span.w:not(.w-done)")).toHaveCount(2);
  // A cue without word timing renders its plain text as before.
  await expect(
    page.locator('section[data-pane="lyrics"] button.line', { hasText: "later line" }),
  ).toBeVisible();
});

test("translation batches visible lines with auto-detect and lang tags", async ({
  page,
}) => {
  const seen: string[] = [];
  await page.route("https://api.mymemory.translated.net/**", (route) => {
    seen.push(route.request().url());
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        responseData: { translatedText: `ES:${q}` },
        responseStatus: 200,
      }),
    });
  });
  await stubTauri(page, { fixtures: { player: pausedPlayer(TRACK_ID) as never } });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("snapify-translang", "es");
    } catch {
      // Ignore storage failures in the test browser.
    }
  });
  await page.goto("/");

  const pane = page.locator('section[data-pane="lyrics"]');
  const tagged = pane.locator('.trans[lang="es"]');
  await expect
    .poll(async () => tagged.count(), { timeout: 15000 })
    .toBeGreaterThanOrEqual(2);
  // Batch, not active-line-only: more than the one active line resolves.
  await expect.poll(async () => seen.length, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
  // Source auto-detect: no assumed English source in any request.
  // (Playwright reports the URL decoded, so the pipe stays literal.)
  expect(seen.length).toBeGreaterThan(0);
  for (const url of seen) {
    expect(url).toContain("langpair=autodetect|es");
    expect(url).not.toContain("langpair=en|");
  }
  await expect(tagged.first()).toContainText("ES:");
});

test("track change replaces translations, leaving no stale lines", async ({
  page,
}) => {
  await page.route("https://api.mymemory.translated.net/**", (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        responseData: { translatedText: `ES:${q}` },
        responseStatus: 200,
      }),
    });
  });
  await stubTauri(page, { fixtures: { player: pausedPlayer(TRACK_ID) as never } });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("snapify-translang", "es");
    } catch {
      // Ignore storage failures in the test browser.
    }
  });
  await page.goto("/");
  const pane = page.locator('section[data-pane="lyrics"]');
  await expect(pane.locator('button.line.on .trans[lang="es"]')).toContainText(
    "ES:Halfway home",
    { timeout: 15000 },
  );

  // New track, new lines: the old batch must not linger under it.
  await gotoWithLyrics(page, {
    trackId: "verify-track-02",
    synced: true,
    instrumental: false,
    cues: [
      { t: 60000, text: "morning static fades" },
      { t: 65000, text: "second track chorus line" },
      { t: 70000, text: "tail of the second song" },
    ],
    plain: null,
    cached: false,
  });
  const pane2 = page.locator('section[data-pane="lyrics"]');
  await expect(pane2.locator("button.line.on")).toContainText("second track chorus", {
    timeout: 15000,
  });
  await expect(pane2.locator('button.line.on .trans[lang="es"]')).toContainText(
    "ES:second track chorus",
    { timeout: 15000 },
  );
  await expect(pane2.locator(".trans", { hasText: "Halfway home" })).toHaveCount(0);
});

test("kana lines offer romaji tagged as latin Japanese", async ({ page }) => {
  const cues = [
    { t: 60000, text: "early line" },
    { t: 65000, text: "こんにちは" },
    { t: 70000, text: "later line" },
  ] as unknown as LyricCueFixture[];
  await gotoWithLyrics(page, {
    trackId: TRACK_ID,
    synced: true,
    instrumental: false,
    cues,
    plain: null,
    cached: false,
  });
  const active = page.locator('section[data-pane="lyrics"] button.line.on');
  await expect(active).toContainText("こんにちは");
  await expect(active.locator('.trans[lang="ja-Latn"]')).toContainText("konnichiha");
});
