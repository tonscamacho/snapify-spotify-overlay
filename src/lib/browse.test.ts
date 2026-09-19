import { describe, expect, it } from "vitest";
import {
  initialBrowse,
  parseAlbumDetail,
  parseArtistDetail,
  parseAudiobookDetail,
  parseChapterDetail,
  parseEpisodeDetail,
  parseFollowedArtists,
  parsePlaylistDetail,
  parsePlaylistItems,
  parsePlaylistPage,
  parseSavedAlbums,
  parseSavedAudiobooks,
  parseSavedEpisodes,
  parseSavedShows,
  parseSavedTracks,
  parseSearch,
  parseShowDetail,
  parseTrackDetail,
  parseUserProfile,
  pop,
  push,
  scopeHint,
  switchView,
  toLibraryItem,
} from "./browse";

describe("browse navigation", () => {
  it("starts on the library view with an empty stack", () => {
    expect(initialBrowse).toEqual({ view: "library", stack: [], query: "" });
  });

  it("pushes an entry onto the stack", () => {
    const s = push(initialBrowse, { kind: "playlist", id: "p1" });
    expect(s.stack).toEqual([{ kind: "playlist", id: "p1" }]);
  });

  it("pops the last entry", () => {
    const s = push(initialBrowse, { kind: "playlist", id: "p1" });
    expect(pop(s).stack).toEqual([]);
  });

  it("switchView resets the stack", () => {
    const s = push(initialBrowse, { kind: "playlist", id: "p1" });
    expect(switchView(s, "search")).toEqual({ view: "search", stack: [], query: "" });
  });
});

describe("scopeHint", () => {
  it("names the missing scope for re-login", () => {
    expect(scopeHint('spotify 403 Forbidden: missing permission "user-top-read" — logout')).toContain(
      "user-top-read",
    );
    expect(
      scopeHint('{"error":{"status":403,"message":"Insufficient client scope: user-top-read"}}'),
    ).toContain("user-top-read");
  });

  it("stays quiet for generic 403s so failures surface truthfully", () => {
    expect(
      scopeHint('spotify 403 Forbidden: {"error":{"status":403,"message":"Player command failed: Restriction violated"}}'),
    ).toBeNull();
    expect(scopeHint("spotify 502 Bad Gateway: <html>bad gateway</html>")).toBeNull();
    expect(scopeHint("rate-limited: retry after 7s")).toBeNull();
  });
});

describe("toLibraryItem", () => {
  it("prefers artist names over the owner for the subtitle", () => {
    const item = toLibraryItem({
      id: "p1",
      name: "Mix",
      artists: [{ name: "A" }, { name: "B" }],
      owner: { display_name: "Owner" },
      images: [{ url: "i1" }, { url: "i2" }],
      uri: "u:p1",
    });
    expect(item).toEqual({
      id: "p1",
      name: "Mix",
      subtitle: "A, B",
      image: "i2",
      uri: "u:p1",
    });
  });

  it("falls back to the owner name, then the fallback subtitle", () => {
    expect(
      toLibraryItem({ id: "p1", name: "P", owner: { display_name: "O" } }).subtitle,
    ).toBe("O");
    expect(toLibraryItem({ id: "p1", name: "P" }, "Playlist").subtitle).toBe("Playlist");
  });

  it("picks the single image when only one exists", () => {
    expect(
      toLibraryItem({ id: "a", name: "N", images: [{ url: "only" }] }).image,
    ).toBe("only");
  });

  it("returns null image and Unknown name on missing fields", () => {
    expect(toLibraryItem({ id: "a" })).toEqual({
      id: "a",
      name: "Unknown",
      subtitle: "",
      image: null,
      uri: "",
    });
  });
});

describe("parsePlaylistPage", () => {
  it("returns empty for garbage input", () => {
    expect(parsePlaylistPage(null)).toEqual({ items: [], total: 0 });
    expect(parsePlaylistPage({})).toEqual({ items: [], total: 0 });
  });

  it("filters items without an id and keeps the reported total", () => {
    const out = parsePlaylistPage({
      items: [
        {
          id: "p1",
          name: "P1",
          owner: { display_name: "O1" },
          images: [{ url: "i1" }, { url: "i2" }],
          uri: "u:p1",
        },
        { name: "NoId" },
        { id: "p2", name: "P2" },
      ],
      total: 7,
    });
    expect(out.total).toBe(7);
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toEqual({
      id: "p1",
      name: "P1",
      subtitle: "O1",
      image: "i2",
      uri: "u:p1",
    });
    expect(out.items[1].subtitle).toBe("Playlist");
  });

  it("falls back to the list length when total is missing", () => {
    expect(parsePlaylistPage({ items: [{ id: "a" }] }).total).toBe(1);
  });
});

describe("parseSavedAlbums", () => {
  it("unwraps album wrappers and drops entries without an id", () => {
    const out = parseSavedAlbums({
      items: [
        { album: { id: "a1", name: "Alb", artists: [{ name: "A" }], uri: "u:a1" } },
        { album: { name: "NoId" } },
        {},
      ],
      total: 3,
    });
    expect(out.total).toBe(3);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ id: "a1", name: "Alb", subtitle: "A" });
  });

  it("returns empty for garbage input", () => {
    expect(parseSavedAlbums(null)).toEqual({ items: [], total: 0 });
  });
});

describe("parsePlaylistItems / parseSavedTracks", () => {
  const raw = {
    items: [
      {
        track: {
          name: "T1",
          artists: [{ name: "A" }],
          duration_ms: 1000,
          uri: "spotify:track:1",
        },
      },
      {
        item: { name: "T2", artists: [], duration_ms: 2000, uri: "spotify:track:2" },
      },
      { name: "NoUri" },
    ],
    total: 99,
  };

  it("unwraps track/item wrappers and keeps the total", () => {
    const out = parsePlaylistItems(raw);
    expect(out.total).toBe(99);
    expect(out.items).toEqual([
      { name: "T1", artists: "A", durationMs: 1000, uri: "spotify:track:1" },
      { name: "T2", artists: "", durationMs: 2000, uri: "spotify:track:2" },
    ]);
  });

  it("parseSavedTracks reads the same wrapper shapes", () => {
    const out = parseSavedTracks(raw);
    expect(out.total).toBe(99);
    expect(out.items).toHaveLength(2);
    expect(out.items[0].name).toBe("T1");
  });

  it("returns empty for garbage input", () => {
    expect(parsePlaylistItems(null)).toEqual({ items: [], total: 0 });
    expect(parseSavedTracks(null)).toEqual({ items: [], total: 0 });
  });
});

describe("parseFollowedArtists", () => {
  it("reads items and the paging cursor", () => {
    const out = parseFollowedArtists({
      artists: {
        items: [{ id: "a1", name: "A1" }],
        cursors: { after: "cur1" },
      },
    });
    expect(out.after).toBe("cur1");
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ id: "a1", name: "A1" });
  });

  it("nulls the cursor when missing", () => {
    expect(parseFollowedArtists({ artists: { items: [] } }).after).toBeNull();
    expect(parseFollowedArtists(null)).toEqual({ items: [], after: null });
    expect(parseFollowedArtists({})).toEqual({ items: [], after: null });
  });
});

describe("parsePlaylistDetail", () => {
  it("returns null for garbage or id-less input", () => {
    expect(parsePlaylistDetail(null)).toBeNull();
    expect(parsePlaylistDetail({})).toBeNull();
  });

  it("parses a full playlist with wrapped tracks", () => {
    const d = parsePlaylistDetail({
      id: "pl1",
      name: "My Pl",
      images: [{ url: "cover" }],
      owner: { display_name: "Owner" },
      tracks: {
        items: [
          {
            track: {
              name: "T",
              artists: [{ name: "X" }],
              duration_ms: 100,
              uri: "u:t",
            },
          },
        ],
        total: 5,
      },
      uri: "u:pl",
    });
    expect(d).toEqual({
      kind: "playlist",
      name: "My Pl",
      image: "cover",
      owner: "Owner",
      tracks: [{ name: "T", artists: "X", durationMs: 100, uri: "u:t" }],
      tracksTotal: 5,
      uri: "u:pl",
      walled: false,
    });
  });

  it("defaults fields on a minimal playlist", () => {
    expect(parsePlaylistDetail({ id: "x" })).toMatchObject({
      kind: "playlist",
      name: "Playlist",
      tracks: [],
      tracksTotal: 0,
      owner: "",
      walled: true,
    });
  });

  it("flags metadata-only responses as walled but keeps the context uri", () => {
    const d = parsePlaylistDetail({
      id: "other123",
      name: "Someone Else Mix",
      images: [{ url: "cover" }],
      owner: { display_name: "Other" },
      uri: "spotify:playlist:other123",
    });
    expect(d).toMatchObject({
      kind: "playlist",
      tracksTotal: 0,
      uri: "spotify:playlist:other123",
      walled: true,
    });
  });

  it("reads the renamed items field for owned playlists", () => {
    const d = parsePlaylistDetail({
      id: "pl2",
      name: "Owned",
      owner: { display_name: "Me" },
      items: {
        items: [
          {
            item: {
              name: "T",
              artists: [{ name: "X" }],
              duration_ms: 100,
              uri: "u:t",
            },
          },
        ],
        total: 1,
      },
      uri: "u:pl2",
    });
    expect(d).toMatchObject({ kind: "playlist", tracksTotal: 1, walled: false });
  });
});

describe("parseAlbumDetail", () => {
  it("returns null for garbage input", () => {
    expect(parseAlbumDetail(null)).toBeNull();
    expect(parseAlbumDetail({})).toBeNull();
  });

  it("inherits album artists onto tracks missing their own", () => {
    const d = parseAlbumDetail({
      id: "al1",
      name: "Alb",
      artists: [{ name: "A1" }, { name: "A2" }],
      images: [{ url: "cov" }],
      tracks: {
        items: [
          { name: "S1", duration_ms: 120, uri: "u:s1" },
          {
            name: "S2",
            artists: [{ name: "Feat" }],
            duration_ms: 130,
            uri: "u:s2",
          },
        ],
      },
      uri: "u:al",
      explicit: true,
    });
    expect(d).toMatchObject({
      kind: "album",
      name: "Alb",
      artists: "A1, A2",
      image: "cov",
      explicit: true,
    });
    expect(d?.kind === "album" && d.tracks[0].artists).toBe("A1, A2");
    expect(d?.kind === "album" && d.tracks[1].artists).toBe("Feat");
  });
});

describe("parseShowDetail / parseEpisodeDetail", () => {
  it("parses a show with filtered episodes", () => {
    const d = parseShowDetail(
      {
        id: "s1",
        name: "Show",
        images: [{ url: "img" }],
        publisher: "Pub",
        uri: "u:s",
        explicit: false,
      },
      { items: [{ name: "E1", duration_ms: 10, uri: "u:e1" }, { name: "NoUri" }] },
    );
    expect(d).toMatchObject({ kind: "show", name: "Show", publisher: "Pub" });
    expect(d?.kind === "show" && d.episodes).toHaveLength(1);
  });

  it("returns null for a show without an id", () => {
    expect(parseShowDetail(null, null)).toBeNull();
    expect(parseShowDetail({}, {})).toBeNull();
  });

  it("parses an episode with its parent show", () => {
    expect(
      parseEpisodeDetail({
        id: "e1",
        name: "Ep",
        images: [{ url: "i" }],
        show: { name: "Parent" },
        duration_ms: 5000,
        uri: "u:e",
        explicit: true,
      }),
    ).toEqual({
      kind: "episode",
      name: "Ep",
      image: "i",
      show: "Parent",
      durationMs: 5000,
      uri: "u:e",
      explicit: true,
      uriType: "episode",
    });
  });
});

describe("parseAudiobookDetail / parseChapterDetail", () => {
  it("parses an audiobook with joined authors", () => {
    const d = parseAudiobookDetail(
      {
        id: "b1",
        name: "Book",
        images: [],
        authors: [{ name: "Au1" }, { name: "Au2" }],
        uri: "u:b",
      },
      { items: [{ name: "C1", uri: "u:c1" }] },
    );
    expect(d).toMatchObject({
      kind: "audiobook",
      name: "Book",
      authors: "Au1, Au2",
      image: null,
    });
    expect(d?.kind === "audiobook" && d.chapters).toHaveLength(1);
  });

  it("parses a chapter with its parent book", () => {
    expect(
      parseChapterDetail({
        id: "c1",
        name: "Ch",
        audiobook: { name: "Book" },
        duration_ms: 100,
        uri: "u:c",
      }),
    ).toMatchObject({ kind: "chapter", book: "Book", uriType: "chapter" });
  });

  it("returns null for id-less input", () => {
    expect(parseAudiobookDetail({}, {})).toBeNull();
    expect(parseChapterDetail({})).toBeNull();
  });
});

describe("parseTrackDetail", () => {
  it("parses a track with album art", () => {
    expect(
      parseTrackDetail({
        id: "t1",
        name: "T",
        artists: [{ name: "A" }],
        album: { name: "Alb", images: [{ url: "cov" }] },
        duration_ms: 200,
        uri: "u:t",
        explicit: false,
      }),
    ).toEqual({
      kind: "track",
      name: "T",
      image: "cov",
      artists: "A",
      album: "Alb",
      durationMs: 200,
      uri: "u:t",
      explicit: false,
      uriType: "track",
    });
  });

  it("nulls the image when there is no album", () => {
    expect(parseTrackDetail({ id: "t1" })).toMatchObject({
      kind: "track",
      image: null,
      album: "",
    });
  });
});

describe("parseArtistDetail", () => {
  it("parses genres capped at three plus the albums strip", () => {
    const d = parseArtistDetail(
      {
        id: "ar1",
        name: "Art",
        images: [{ url: "pic" }, { url: "pic2" }],
        genres: ["rock", "pop", "jazz", "extra"],
        uri: "u:ar",
      },
      { items: [{ id: "al1", name: "A" }] },
      {},
    );
    expect(d).toMatchObject({
      kind: "artist",
      name: "Art",
      image: "pic2",
      genres: ["rock", "pop", "jazz"],
    });
    expect(d?.kind === "artist" && d.topTracks).toEqual([]);
    expect(d?.kind === "artist" && d.albums).toHaveLength(1);
  });

  it("stays honestly empty without a search backfill", () => {
    const d = parseArtistDetail(
      {
        id: "ar1",
        name: "Art",
        images: [{ url: "pic" }, { url: "pic2" }],
        genres: ["rock", "pop", "jazz", "extra"],
        uri: "u:ar",
      },
      { items: [{ id: "al1", name: "A" }] },
      {},
    );
    expect(d?.kind === "artist" && d.topTracks).toEqual([]);
  });

  it("backfills top tracks from search-derived data when supplied", () => {
    const d = parseArtistDetail(
      { id: "ar1", name: "Art", images: [], genres: [], uri: "u:ar" },
      { items: [] },
      {},
      [
        { name: "Hit One", artists: "Art", durationMs: 200, uri: "u:h1" },
        { name: "Hit Two", artists: "Art", durationMs: 210, uri: "u:h2" },
      ],
    );
    expect(d?.kind === "artist" && d.topTracks).toEqual([
      { name: "Hit One", artists: "Art", durationMs: 200, uri: "u:h1" },
      { name: "Hit Two", artists: "Art", durationMs: 210, uri: "u:h2" },
    ]);
  });

  it("returns null without an artist id", () => {
    expect(parseArtistDetail(null, null, null)).toBeNull();
    expect(parseArtistDetail({}, {}, {})).toBeNull();
  });
});

describe("parseSearch", () => {
  it("returns empty buckets for garbage input", () => {
    expect(parseSearch(null)).toEqual({
      tracks: [],
      artists: [],
      playlists: [],
      albums: [],
      shows: [],
      episodes: [],
      audiobooks: [],
    });
  });

  it("windows tracks at ten per page and pages with offset", () => {
    const mk = (i: number) => ({ name: `T${i}`, uri: `u:${i}` });
    const items = Array.from({ length: 12 }, (_, i) => mk(i));
    const page0 = parseSearch({ tracks: { items } });
    expect(page0.tracks).toHaveLength(10);
    expect(page0.tracks[0].name).toBe("T0");
    expect(page0.tracks[9].name).toBe("T9");
    const page1 = parseSearch({ tracks: { items } }, 10);
    expect(page1.tracks).toHaveLength(2);
    expect(page1.tracks[0].name).toBe("T10");
    expect(parseSearch({ tracks: { items } }, 20).tracks).toHaveLength(0);
  });

  it("filters playlists without ids and episodes without uris", () => {
    const out = parseSearch({
      playlists: { items: [{ id: "p1", name: "P" }, { name: "NoId" }] },
      episodes: { items: [{ name: "E", uri: "u:e" }, { name: "NoUri" }] },
    });
    expect(out.playlists).toHaveLength(1);
    expect(out.episodes).toHaveLength(1);
  });
});

describe("parseUserProfile", () => {
  it("parses a profile with display name and avatar", () => {
    expect(
      parseUserProfile({ id: "u1", display_name: "Name", images: [{ url: "av" }] }),
    ).toEqual({ id: "u1", name: "Name", image: "av", accountId: "u1" });
  });

  it("falls back to the id when the display name is missing", () => {
    expect(parseUserProfile({ id: "u1" })).toMatchObject({ name: "u1", image: null });
  });

  it("returns null without an id", () => {
    expect(parseUserProfile(null)).toBeNull();
    expect(parseUserProfile({})).toBeNull();
  });
});

describe("saved library parsers", () => {
  it("parseSavedShows unwraps show wrappers", () => {
    const out = parseSavedShows({
      items: [{ show: { id: "s1", name: "S" } }, { id: "s2", name: "Direct" }],
      total: 2,
    });
    expect(out.total).toBe(2);
    expect(out.items).toHaveLength(2);
    expect(out.items[0].id).toBe("s1");
  });

  it("parseSavedEpisodes unwraps episode wrappers", () => {
    const out = parseSavedEpisodes({
      items: [{ episode: { name: "E", uri: "u:e" } }],
      total: 1,
    });
    expect(out.total).toBe(1);
    expect(out.items).toEqual([{ name: "E", artists: "", durationMs: 0, uri: "u:e" }]);
  });

  it("parseSavedAudiobooks drops entries without an id", () => {
    const out = parseSavedAudiobooks({
      items: [{ id: "b1", name: "B" }, { name: "NoId" }],
      total: 2,
    });
    expect(out.total).toBe(2);
    expect(out.items).toHaveLength(1);
  });

  it("returns empty for garbage input", () => {
    expect(parseSavedShows(null)).toEqual({ items: [], total: 0 });
    expect(parseSavedEpisodes(null)).toEqual({ items: [], total: 0 });
    expect(parseSavedAudiobooks(null)).toEqual({ items: [], total: 0 });
  });
});
