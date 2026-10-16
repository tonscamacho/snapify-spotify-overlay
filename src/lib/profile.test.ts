import { describe, expect, it } from "vitest";
import {
  bucketListeningClocks,
  DEFAULT_PROFILE_RANGE,
  deriveStats,
  deriveStreamGenres,
  deriveTopGenres,
  deriveTopGenresRanked,
  isClientSlice,
  loadProfileRange,
  parseProfileRange,
  parseRecentPlays,
  parseTopArtists,
  parseTopTracks,
  PROFILE_RANGE_KEY,
  PROFILE_RANGES,
  rangeHonestyNote,
  rankArtistsByStreams,
  saveProfileRange,
  sliceClientRange,
  STREAM_GENRE_TOP_ARTISTS,
  toApiTimeRange,
  TOP_GENRE_CAP,
} from "./profile";
import type { ProfileRange, RecentPlay } from "./types";
import type { HistoryPlay } from "./history";

/** Node has no localStorage: a Map-backed fake for the storage tests. */
function stubStorage(seed: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(seed));
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  return store;
}

function play(id: string, playedAt: number, over: Partial<HistoryPlay> = {}): HistoryPlay {
  return {
    trackId: id,
    trackName: `Song ${id}`,
    artists: "A",
    playedAt,
    image: null,
    uri: `spotify:track:${id}`,
    durationMs: 200000,
    ...over,
  };
}

function artist(id: string, name: string, genres: string[]) {
  return { id, name, genres, image: null, uri: "" };
}

describe("parseProfileRange", () => {
  it("passes the six known ranges through", () => {
    expect(parseProfileRange("today")).toBe("today");
    expect(parseProfileRange("week")).toBe("week");
    expect(parseProfileRange("fourWeeks")).toBe("fourWeeks");
    expect(parseProfileRange("sixMonths")).toBe("sixMonths");
    expect(parseProfileRange("year2026")).toBe("year2026");
    expect(parseProfileRange("lifetime")).toBe("lifetime");
  });

  it("coerces unknown values to the default, never to another range", () => {
    for (const v of [null, undefined, "", "weekly", "SHORT_TERM", 42, {}, []] as const) {
      expect(parseProfileRange(v)).toBe(DEFAULT_PROFILE_RANGE);
      expect(parseProfileRange(v)).not.toBe("lifetime");
    }
    expect(DEFAULT_PROFILE_RANGE).toBe("fourWeeks");
  });
});

describe("range constants", () => {
  it("pins the storage key and the six ranges", () => {
    expect(PROFILE_RANGE_KEY).toBe("snapify-profile-range");
    expect([...PROFILE_RANGES]).toEqual([
      "today",
      "week",
      "fourWeeks",
      "sixMonths",
      "year2026",
      "lifetime",
    ]);
    expect(PROFILE_RANGES).not.toContain("short_term");
  });
});

describe("toApiTimeRange", () => {
  it("maps fourWeeks/sixMonths to real ranges and slices the rest from long_term", () => {
    const mapped = Object.fromEntries(PROFILE_RANGES.map((r) => [r, toApiTimeRange(r)]));
    expect(mapped).toEqual({
      today: "long_term",
      week: "long_term",
      fourWeeks: "short_term",
      sixMonths: "medium_term",
      year2026: "long_term",
      lifetime: "long_term",
    });
  });
});

describe("isClientSlice", () => {
  it("marks today/week/year2026 sliced and the Spotify ranges direct", () => {
    expect(isClientSlice("today")).toBe(true);
    expect(isClientSlice("week")).toBe(true);
    expect(isClientSlice("year2026")).toBe(true);
    expect(isClientSlice("fourWeeks")).toBe(false);
    expect(isClientSlice("sixMonths")).toBe(false);
    expect(isClientSlice("lifetime")).toBe(false);
  });
});

describe("rangeHonestyNote", () => {
  it("disclaims the sliced ranges verbatim and stays silent for direct ones", () => {
    expect(rangeHonestyNote("today")).toBe(
      "Sliced from long-term tops plus recent streams. Not a Spotify range.",
    );
    expect(rangeHonestyNote("week")).toBe(
      "Sliced from long-term tops plus recent streams. Not a Spotify range.",
    );
    expect(rangeHonestyNote("year2026")).toBe(
      "2026 slice of lifetime tops. Spotify has no year range.",
    );
    expect(rangeHonestyNote("fourWeeks")).toBeNull();
    expect(rangeHonestyNote("sixMonths")).toBeNull();
    expect(rangeHonestyNote("lifetime")).toBeNull();
  });
});

describe("loadProfileRange/saveProfileRange", () => {
  it("round-trips the selection under the profile key", () => {
    const store = stubStorage();
    saveProfileRange("week");
    expect(store.get(PROFILE_RANGE_KEY)).toBe("week");
    expect(store.has("snapify-layout-v3")).toBe(false);
    expect(loadProfileRange()).toBe("week");
  });

  it("falls back to the default for missing or corrupt values", () => {
    stubStorage();
    expect(loadProfileRange()).toBe("fourWeeks");
    stubStorage({ [PROFILE_RANGE_KEY]: "yesterday" });
    expect(loadProfileRange()).toBe("fourWeeks");
  });
});

describe("parseRecentPlays", () => {
  it("returns [] for garbage input", () => {
    expect(parseRecentPlays(null)).toEqual([]);
    expect(parseRecentPlays({})).toEqual([]);
    expect(parseRecentPlays("nope")).toEqual([]);
    expect(parseRecentPlays({ items: "x" })).toEqual([]);
  });

  it("parses a full recently-played entry", () => {
    const at = new Date(2026, 9, 5, 14, 30).getTime();
    const out = parseRecentPlays({
      items: [
        {
          played_at: new Date(at).toISOString(),
          track: {
            id: "t1",
            name: "Song",
            artists: [{ name: "A" }, { name: "B" }],
            album: { images: [{ url: "http://img/x.jpg" }] },
            duration_ms: 200000,
            uri: "spotify:track:t1",
          },
        },
      ],
    });
    expect(out).toEqual([
      {
        trackId: "t1",
        trackName: "Song",
        artists: "A, B",
        playedAt: at,
        image: "http://img/x.jpg",
        uri: "spotify:track:t1",
        durationMs: 200000,
      },
    ]);
  });

  it("keeps the valid entry and drops the invalid ones", () => {
    const stamp = new Date(2026, 9, 5, 14, 30).toISOString();
    const out = parseRecentPlays({
      items: [
        { played_at: stamp, track: { id: "keep", name: "K", uri: "spotify:track:keep" } },
        { played_at: stamp, track: null },
        { played_at: stamp, track: { name: "NoId" } },
        { played_at: "not-a-date", track: { id: "bad-date" } },
        { track: { id: "no-stamp" } },
        null,
      ],
    });
    expect(out.map((p) => p.trackId)).toEqual(["keep"]);
    expect(out.map((p) => p.trackId)).not.toContain("bad-date");
  });

  it("falls back display fields but never invents identity or time", () => {
    const stamp = new Date(2026, 9, 5, 14, 30).toISOString();
    const out = parseRecentPlays({
      items: [{ played_at: stamp, track: { id: "t9", uri: "spotify:track:t9" } }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      trackId: "t9",
      trackName: "Unknown",
      artists: "",
      uri: "spotify:track:t9",
      image: null,
      durationMs: 0,
    });
  });
});

describe("parseTopTracks", () => {
  it("returns [] for garbage input", () => {
    expect(parseTopTracks(null)).toEqual([]);
    expect(parseTopTracks({})).toEqual([]);
    expect(parseTopTracks({ items: "x" })).toEqual([]);
  });

  it("parses rows and drops entries without a uri", () => {
    const out = parseTopTracks({
      items: [
        {
          name: "Hit",
          artists: [{ name: "A" }],
          duration_ms: 180000,
          uri: "spotify:track:h1",
        },
        { name: "Unplayable" },
      ],
    });
    expect(out).toEqual([
      { name: "Hit", artists: "A", durationMs: 180000, uri: "spotify:track:h1" },
    ]);
  });
});

describe("parseTopArtists", () => {
  it("returns [] for garbage input", () => {
    expect(parseTopArtists(null)).toEqual([]);
    expect(parseTopArtists({})).toEqual([]);
    expect(parseTopArtists({ items: "x" })).toEqual([]);
  });

  it("parses artists and keeps only real genre strings", () => {
    const out = parseTopArtists({
      items: [
        {
          id: "a1",
          name: "Band",
          genres: ["rock", 42, "", "  ", null, "indie"],
          images: [{ url: "http://img/a.jpg" }],
          uri: "spotify:artist:a1",
        },
        { name: "NoId" },
      ],
    });
    expect(out).toEqual([
      {
        id: "a1",
        name: "Band",
        genres: ["rock", "indie"],
        image: "http://img/a.jpg",
        uri: "spotify:artist:a1",
      },
    ]);
    expect(out.map((a) => a.id)).not.toContain("");
  });
});

describe("deriveStats", () => {
  it("aggregates plays, minutes, hours, tracks, artists, albums", () => {
    const stats = deriveStats([
      play("t1", 1000, { artists: "A, B", durationMs: 200000, albumName: "LP One" }),
      play("t1", 2000, { artists: "A", durationMs: 180000, albumName: "lp one" }),
      play("t2", 3000, { artists: "C", durationMs: 60000, albumName: "LP Two" }),
    ]);
    expect(stats).toEqual({ plays: 3, minutes: 7, hours: 0, uniqueTracks: 2, uniqueArtists: 3, uniqueAlbums: 2 });
  });

  it("counts skipped-long rows and drops only short/podcast rows", () => {
    const stats = deriveStats([
      play("t1", 1000, { durationMs: 200000, skipped: true }),
      play("t2", 2000, { durationMs: 5000, skipped: true }),
      play("t3", 3000, { durationMs: 200000, uri: "spotify:episode:pod" }),
    ]);
    expect(stats.plays).toBe(1);
    expect(stats.minutes).toBe(3);
  });

  it("rolls minutes into whole hours (stats.fm parity)", () => {
    const plays = Array.from({ length: 20 }, (_, i) => play(`h${i}`, 1000 + i, { durationMs: 3600000, albumName: `Album ${i % 3}` }));
    const stats = deriveStats(plays);
    expect(stats.minutes).toBe(1200);
    expect(stats.hours).toBe(20);
    expect(stats.uniqueAlbums).toBe(3);
  });

  it("returns zeros for no plays", () => {
    expect(deriveStats([])).toEqual({
      plays: 0,
      minutes: 0,
      hours: 0,
      uniqueTracks: 0,
      uniqueArtists: 0,
      uniqueAlbums: 0,
    });
  });
});

describe("deriveTopGenres", () => {
  it("counts, sorts desc, and cuts at the cap", () => {
    expect(TOP_GENRE_CAP).toBe(5);
    const artists = [
      { id: "a1", genres: ["rock", "indie"] },
      { id: "a2", genres: ["rock", "pop"] },
      { id: "a3", genres: ["rock", "jazz"] },
      { id: "a4", genres: ["pop", "jazz"] },
      { id: "a5", genres: ["classical"] },
      { id: "a6", genres: ["ambient"] },
      { id: "a7", genres: ["ska"] },
    ].map((a) => ({ ...a, name: a.id, image: null, uri: "" }));
    const top = deriveTopGenres(artists);
    expect(top).toEqual([
      { genre: "rock", count: 3 },
      { genre: "jazz", count: 2 },
      { genre: "pop", count: 2 },
      { genre: "ambient", count: 1 },
      { genre: "classical", count: 1 },
    ]);
    expect(top.map((g) => g.genre)).not.toContain("ska");
    expect(top.map((g) => g.genre)).not.toContain("indie");
  });

  it("folds case and returns [] when there is nothing to count", () => {
    const artists = [
      { id: "a1", name: "x", genres: ["Rock"], image: null, uri: "" },
      { id: "a2", name: "y", genres: ["rock"], image: null, uri: "" },
    ];
    expect(deriveTopGenres(artists)).toEqual([{ genre: "rock", count: 2 }]);
    expect(deriveTopGenres([])).toEqual([]);
  });
});

describe("rankArtistsByStreams", () => {
  it("ranks by counted streams desc with an alphabetical tie-break", () => {
    const ranks = rankArtistsByStreams([
      play("t1", 1000, { artists: "Beta" }),
      play("t2", 2000, { artists: "Alpha" }),
      play("t3", 3000, { artists: "Beta" }),
      play("t4", 4000, { artists: "alpha, Beta" }),
    ]);
    expect(ranks).toEqual([
      { artist: "Beta", streams: 3, minutes: 10 },
      { artist: "Alpha", streams: 2, minutes: 7 },
    ]);
  });

  it("splits joint rows, skips blank names, counts skipped-long, ignores short", () => {
    const ranks = rankArtistsByStreams([
      play("t1", 1000, { artists: "A, B" }),
      play("t2", 2000, { artists: " , " }),
      play("t3", 3000, { artists: "A", msPlayed: 5000 }),
      play("t4", 4000, { artists: "B", skipped: true, msPlayed: 200000, durationMs: 200000 }),
    ]);
    expect(ranks.map((r) => r.artist)).toEqual(["B", "A"]);
    expect(ranks.find((r) => r.artist === "A")).toMatchObject({ streams: 1 });
    expect(ranks.find((r) => r.artist === "B")).toMatchObject({ streams: 2 });
  });

  it("caps at topN and returns [] for no countable plays", () => {
    expect(STREAM_GENRE_TOP_ARTISTS).toBeGreaterThan(0);
    const plays = Array.from({ length: 8 }, (_, i) =>
      play(`t${i}`, 1000 + i, { artists: `Band ${String(i).padStart(2, "0")}` }),
    );
    expect(rankArtistsByStreams(plays, 3)).toHaveLength(3);
    expect(rankArtistsByStreams(plays, 3).map((r) => r.artist)).toEqual([
      "Band 00",
      "Band 01",
      "Band 02",
    ]);
    expect(rankArtistsByStreams([])).toEqual([]);
  });
});

describe("deriveStreamGenres", () => {
  const fetched = [
    artist("a1", "Heavy Rotation", ["rock", "indie"]),
    artist("a2", "Rare Spin", ["jazz"]),
    artist("a3", "Genreless", []),
  ];

  it("weighs genres by the carrier's streams, not one vote each", () => {
    const plays = [
      play("t1", 1000, { artists: "Heavy Rotation" }),
      play("t2", 2000, { artists: "Heavy Rotation" }),
      play("t3", 3000, { artists: "Heavy Rotation" }),
      play("t4", 4000, { artists: "Rare Spin" }),
    ];
    expect(deriveStreamGenres({ plays, artists: fetched })).toEqual([
      { genre: "indie", count: 3 },
      { genre: "rock", count: 3 },
      { genre: "jazz", count: 1 },
    ]);
  });

  it("matches artist names case-insensitively and skips unmatched history", () => {
    const plays = [
      play("t1", 1000, { artists: "heavy rotation" }),
      play("t2", 2000, { artists: "Unknown Import Band" }),
    ];
    const top = deriveStreamGenres({ plays, artists: fetched });
    expect(top.map((g) => g.genre)).toEqual(["indie", "rock"]);
    expect(top.map((g) => g.genre)).not.toContain("jazz");
  });

  it("returns [] when no ranked artist carries genre data", () => {
    expect(
      deriveStreamGenres({
        plays: [play("t1", 1000, { artists: "Unknown Import Band" })],
        artists: fetched,
      }),
    ).toEqual([]);
    expect(deriveStreamGenres({ plays: [], artists: fetched })).toEqual([]);
    expect(
      deriveStreamGenres({ plays: [play("t1", 1000, { artists: "Heavy Rotation" })], artists: [] }),
    ).toEqual([]);
  });
});

describe("deriveTopGenresRanked", () => {
  const fetched = [
    artist("a1", "Heavy Rotation", ["rock"]),
    artist("a2", "Rare Spin", ["jazz"]),
  ];

  it("prefers stream weights over the equal-count fallback", () => {
    const plays = [
      play("t1", 1000, { artists: "Heavy Rotation" }),
      play("t2", 2000, { artists: "Heavy Rotation" }),
      play("t3", 3000, { artists: "Rare Spin" }),
    ];
    expect(deriveTopGenresRanked({ plays, artists: fetched })).toEqual([
      { genre: "rock", count: 2 },
      { genre: "jazz", count: 1 },
    ]);
  });

  it("falls back to the API-only count when history matches nothing", () => {
    const plays = [play("t1", 1000, { artists: "Unknown Import Band" })];
    expect(deriveTopGenresRanked({ plays, artists: fetched })).toEqual([
      { genre: "jazz", count: 1 },
      { genre: "rock", count: 1 },
    ]);
    expect(deriveTopGenresRanked({ plays: [], artists: fetched })).toEqual(
      deriveTopGenres(fetched),
    );
  });

  it("stays empty only when there is truly no genre data", () => {
    expect(deriveTopGenresRanked({ plays: [], artists: [] })).toEqual([]);
    expect(
      deriveTopGenresRanked({
        plays: [play("t1", 1000, { artists: "Nobody" })],
        artists: [artist("a9", "Genreless", [])],
      }),
    ).toEqual([]);
  });
});

describe("bucketListeningClocks", () => {
  it("buckets plays by local hour and always returns 24 buckets", () => {
    const buckets = bucketListeningClocks([
      play("t1", new Date(2026, 9, 5, 14, 10).getTime()),
      play("t2", new Date(2026, 9, 5, 14, 50).getTime()),
      play("t3", new Date(2026, 9, 5, 9, 5).getTime()),
    ]);
    expect(buckets).toHaveLength(24);
    expect(buckets.map((b) => b.hour)).toEqual(Array.from({ length: 24 }, (_, h) => h));
    expect(buckets[14]).toEqual({ hour: 14, plays: 2, minutes: 7 });
    expect(buckets[9]).toEqual({ hour: 9, plays: 1, minutes: 3 });
    expect(buckets[0]).toEqual({ hour: 0, plays: 0, minutes: 0 });
    expect(buckets.reduce((n, b) => n + b.plays, 0)).toBe(3);
  });

  it("sums listened minutes per hour from msPlayed with the stats rounding", () => {
    const at = new Date(2026, 9, 5, 19, 5).getTime();
    const buckets = bucketListeningClocks([
      play("a", at, { msPlayed: 60000 }),
      play("b", at + 1000, { msPlayed: 90000 }),
      play("c", at + 2000, { durationMs: 120000 }),
    ]);
    expect(buckets[19]).toEqual({ hour: 19, plays: 3, minutes: 5 });
    expect(buckets[19].minutes).toBe(5);
    expect(buckets.reduce((n, b) => n + b.minutes, 0)).toBe(5);
  });

  it("excludes only short rows; skipped-long counts in both streams and minutes", () => {
    const at = new Date(2026, 9, 5, 19, 5).getTime();
    const buckets = bucketListeningClocks([
      play("short", at, { msPlayed: 10000 }),
      play("skip", at + 1000, { msPlayed: 200000, skipped: true }),
      play("kept", at + 2000, { msPlayed: 200000 }),
    ]);
    expect(buckets[19]).toEqual({ hour: 19, plays: 2, minutes: 7 });
  });

  it("returns all-zero buckets for no plays", () => {
    const buckets = bucketListeningClocks([]);
    expect(buckets).toHaveLength(24);
    expect(buckets.every((b) => b.plays === 0 && b.minutes === 0)).toBe(true);
  });
});

describe("sliceClientRange", () => {
  const now = new Date(2026, 10, 4, 12, 0, 0).getTime();
  const ids = (ps: RecentPlay[]): string[] => ps.map((p) => p.trackId);

  it("keeps plays since local midnight for today, bounds inclusive", () => {
    const midnight = new Date(2026, 10, 4).getTime();
    const out = sliceClientRange({
      plays: [
        play("before", midnight - 1),
        play("edge", midnight),
        play("noon", now),
        play("future", now + 1000),
      ],
      range: "today",
      now,
    });
    expect(ids(out)).toEqual(["edge", "noon"]);
    expect(ids(out)).not.toContain("before");
  });

  it("keeps the rolling 7-day window for week, bounds inclusive", () => {
    const start = now - 7 * 86400000;
    const out = sliceClientRange({
      plays: [play("old", start - 1), play("edge", start), play("fresh", now)],
      range: "week",
      now,
    });
    expect(ids(out)).toEqual(["edge", "fresh"]);
    expect(ids(out)).not.toContain("old");
  });

  it("keeps plays since Jan 1 2026 for year2026, bounds inclusive", () => {
    const jan1 = new Date(2026, 0, 1).getTime();
    const out = sliceClientRange({
      plays: [
        play("nye", jan1 - 1),
        play("midnight", jan1),
        play("nov", now),
        play("xmas", new Date(2025, 11, 25, 12).getTime()),
      ],
      range: "year2026",
      now,
    });
    expect(ids(out)).toEqual(["midnight", "nov"]);
    expect(ids(out)).not.toContain("xmas");
  });

  it("windows fourWeeks/sixMonths and passes lifetime through", () => {
    const m28 = now - 28 * 86400000;
    const four = sliceClientRange({
      plays: [play("old", m28 - 1), play("edge", m28)],
      range: "fourWeeks",
      now,
    });
    expect(ids(four)).toEqual(["edge"]);

    const m182 = now - 182 * 86400000;
    const six = sliceClientRange({
      plays: [play("old", m182 - 1), play("edge", m182)],
      range: "sixMonths",
      now,
    });
    expect(ids(six)).toEqual(["edge"]);

    const ancient = play("ancient", new Date(2024, 5, 1, 12).getTime());
    const all = sliceClientRange({ plays: [ancient], range: "lifetime", now });
    expect(ids(all)).toEqual(["ancient"]);

    const each: ProfileRange[] = ["today", "week", "fourWeeks", "sixMonths", "year2026", "lifetime"];
    expect(each.map((range) => ids(sliceClientRange({ plays: [ancient], range, now })))).toEqual([
      [],
      [],
      [],
      [],
      [],
      ["ancient"],
    ]);
  });
});
