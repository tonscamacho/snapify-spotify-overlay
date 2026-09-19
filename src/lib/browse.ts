import type {
  BrowseEntry,
  BrowseState,
  DetailData,
  LibraryItem,
  QueueItem,
  SearchResults,
  UserProfile,
} from "./types";

export const initialBrowse: BrowseState = { view: "library", stack: [], query: "" };

export function push(s: BrowseState, e: BrowseEntry): BrowseState {
  return { ...s, stack: [...s.stack, e] };
}

export function pop(s: BrowseState): BrowseState {
  return { ...s, stack: s.stack.slice(0, -1) };
}

export function switchView(s: BrowseState, view: BrowseState["view"]): BrowseState {
  return { ...s, view, stack: [] };
}

/** Reconnect prompt, and only for errors that actually name a missing
 *  scope. Anything else returns null so the caller surfaces Spotify's
 *  real message: a generic 403 (Restriction violated, gateway quirks)
 *  must never send the user on a pointless re-login loop. */
export function scopeHint(m: string): string | null {
  const missing =
    /missing permission "([^"]+)"/i.exec(m) ??
    /Insufficient client scope:\s*([A-Za-z0-9_-]+)/.exec(m);
  if (!missing) return null;
  return `Spotify is missing permission “${missing[1]}”. Log out in Settings, then login again.`;
}

function img(images: unknown): string | null {
  if (!Array.isArray(images) || images.length === 0) return null;
  const mid = images[Math.min(1, images.length - 1)] as Record<string, unknown>;
  const first = images[0] as Record<string, unknown>;
  const pick = typeof mid["url"] === "string" ? mid : first;
  return typeof pick["url"] === "string" ? (pick["url"] as string) : null;
}

function artists(o: Record<string, unknown>): string {
  if (!Array.isArray(o["artists"])) return "";
  return (o["artists"] as Array<Record<string, unknown>>)
    .map((a) => (typeof a["name"] === "string" ? (a["name"] as string) : ""))
    .filter(Boolean)
    .join(", ");
}

function queueItem(o: Record<string, unknown>): QueueItem {
  return {
    name: typeof o["name"] === "string" ? (o["name"] as string) : "Unknown",
    artists: artists(o),
    durationMs: typeof o["duration_ms"] === "number" ? (o["duration_ms"] as number) : 0,
    uri: typeof o["uri"] === "string" ? (o["uri"] as string) : "",
  };
}

export function toLibraryItem(o: Record<string, unknown>, fallbackSubtitle = ""): LibraryItem {
  const owner = o["owner"] as Record<string, unknown> | undefined;
  return {
    id: typeof o["id"] === "string" ? (o["id"] as string) : "",
    name: typeof o["name"] === "string" ? (o["name"] as string) : "Unknown",
    subtitle:
      artists(o) ||
      (owner && typeof owner["display_name"] === "string"
        ? (owner["display_name"] as string)
        : fallbackSubtitle),
    image: img(o["images"]),
    uri: typeof o["uri"] === "string" ? (o["uri"] as string) : "",
  };
}

export function parsePlaylistPage(raw: unknown): { items: LibraryItem[]; total: number } {
  if (!raw || typeof raw !== "object") return { items: [], total: 0 };
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o["items"]) ? (o["items"] as Array<Record<string, unknown>>) : [];
  return {
    items: list.filter((i) => typeof i["id"] === "string").map((i) => toLibraryItem(i, "Playlist")),
    total: typeof o["total"] === "number" ? (o["total"] as number) : list.length,
  };
}

export function parseSavedAlbums(raw: unknown): { items: LibraryItem[]; total: number } {
  if (!raw || typeof raw !== "object") return { items: [], total: 0 };
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o["items"]) ? (o["items"] as Array<Record<string, unknown>>) : [];
  const items = list
    .map((w) => w["album"] as Record<string, unknown> | undefined)
    .filter((a): a is Record<string, unknown> => !!a && typeof a["id"] === "string")
    .map((a) => toLibraryItem(a, "Album"));
  return { items, total: typeof o["total"] === "number" ? (o["total"] as number) : items.length };
}

function playlistEntry(w: unknown): Record<string, unknown> | undefined {
  if (!w || typeof w !== "object") return undefined;
  const r = w as Record<string, unknown>;
  for (const k of ["item", "track", "episode"]) {
    const v = r[k];
    if (v && typeof v === "object") return v as Record<string, unknown>;
  }
  return r;
}

export function parsePlaylistItems(raw: unknown): { items: QueueItem[]; total: number } {
  if (!raw || typeof raw !== "object") return { items: [], total: 0 };
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o["items"]) ? (o["items"] as Array<Record<string, unknown>>) : [];
  const items = list
    .map(playlistEntry)
    .filter((t): t is Record<string, unknown> => !!t && typeof t["uri"] === "string")
    .map(queueItem);
  return { items, total: typeof o["total"] === "number" ? (o["total"] as number) : items.length };
}

export function parseSavedTracks(raw: unknown): { items: QueueItem[]; total: number } {
  if (!raw || typeof raw !== "object") return { items: [], total: 0 };
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o["items"]) ? (o["items"] as Array<Record<string, unknown>>) : [];
  const items = list
    .map(playlistEntry)
    .filter((t): t is Record<string, unknown> => !!t && typeof t["uri"] === "string")
    .map(queueItem);
  return { items, total: typeof o["total"] === "number" ? (o["total"] as number) : items.length };
}

export function parseFollowedArtists(raw: unknown): { items: LibraryItem[]; after: string | null } {
  if (!raw || typeof raw !== "object") return { items: [], after: null };
  const o = raw as Record<string, unknown>;
  const artistsNode = o["artists"] as Record<string, unknown> | undefined;
  if (!artistsNode) return { items: [], after: null };
  const list = Array.isArray(artistsNode["items"])
    ? (artistsNode["items"] as Array<Record<string, unknown>>)
    : [];
  return {
    items: list.map((a) => toLibraryItem(a, "Artist")),
    after:
      typeof artistsNode["cursors"] === "object" &&
      artistsNode["cursors"] !== null &&
      typeof (artistsNode["cursors"] as Record<string, unknown>)["after"] === "string"
        ? ((artistsNode["cursors"] as Record<string, unknown>)["after"] as string)
        : null,
  };
}

export function parsePlaylistDetail(raw: unknown): DetailData | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["id"] !== "string") return null;
  const owner = o["owner"] as Record<string, unknown> | undefined;
  const tracksNode = o["tracks"] as Record<string, unknown> | undefined;
  const itemsNode = o["items"] as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  let list: Array<Record<string, unknown>> = [];
  if (tracksNode && Array.isArray(tracksNode["items"])) {
    list = tracksNode["items"] as Array<Record<string, unknown>>;
  } else if (itemsNode && !Array.isArray(itemsNode) && Array.isArray(itemsNode["items"])) {
    list = itemsNode["items"] as Array<Record<string, unknown>>;
  } else if (Array.isArray(itemsNode)) {
    list = itemsNode;
  }
  const tracks = list
    .map(playlistEntry)
    .filter((t): t is Record<string, unknown> => !!t && typeof t["uri"] === "string")
    .map(queueItem);
  const totalOf = (n: Record<string, unknown> | undefined): number | null =>
    n && typeof n["total"] === "number" ? (n["total"] as number) : null;
  const tracksTotal =
    totalOf(tracksNode) ??
    (itemsNode && !Array.isArray(itemsNode) ? totalOf(itemsNode) : null) ??
    tracks.length;
  const walled = !tracksNode && itemsNode == null;
  return {
    kind: "playlist",
    name: typeof o["name"] === "string" ? (o["name"] as string) : "Playlist",
    image: img(o["images"]),
    owner:
      owner && typeof owner["display_name"] === "string"
        ? (owner["display_name"] as string)
        : "",
    tracks,
    tracksTotal,
    uri: typeof o["uri"] === "string" ? (o["uri"] as string) : "",
    walled,
  };
}

export function parseAlbumDetail(raw: unknown): DetailData | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["id"] !== "string") return null;
  const tracksNode = o["tracks"] as Record<string, unknown> | undefined;
  const list = tracksNode && Array.isArray(tracksNode["items"]) ? tracksNode["items"] : [];
  const albumArtists = artists(o);
  const albumImage = img(o["images"]);
  const tracks = (list as Array<Record<string, unknown>>).map((t) =>
    queueItem({ ...t, artists: t["artists"] ?? o["artists"], uri: t["uri"] ?? "" }),
  );
  return {
    kind: "album",
    name: typeof o["name"] === "string" ? (o["name"] as string) : "Album",
    image: albumImage,
    artists: albumArtists,
    tracks,
    uri: typeof o["uri"] === "string" ? (o["uri"] as string) : "",
    explicit: o["explicit"] === true,
  };
}

export function parseShowDetail(raw: unknown, episodesRaw: unknown): DetailData | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["id"] !== "string") return null;
  const e = (episodesRaw as Record<string, unknown> | null) ?? {};
  const list = Array.isArray(e["items"]) ? (e["items"] as Array<Record<string, unknown>>) : [];
  return {
    kind: "show",
    name: typeof o["name"] === "string" ? (o["name"] as string) : "Show",
    image: img(o["images"]),
    publisher: typeof o["publisher"] === "string" ? (o["publisher"] as string) : "",
    episodes: list.filter((t) => typeof t["uri"] === "string").map(queueItem),
    uri: typeof o["uri"] === "string" ? (o["uri"] as string) : "",
    explicit: o["explicit"] === true,
  };
}

export function parseEpisodeDetail(raw: unknown): DetailData | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["id"] !== "string") return null;
  const show = o["show"] as Record<string, unknown> | undefined;
  return {
    kind: "episode",
    name: typeof o["name"] === "string" ? (o["name"] as string) : "Episode",
    image: img(o["images"]),
    show: show && typeof show["name"] === "string" ? (show["name"] as string) : "",
    durationMs: typeof o["duration_ms"] === "number" ? (o["duration_ms"] as number) : 0,
    uri: typeof o["uri"] === "string" ? (o["uri"] as string) : "",
    explicit: o["explicit"] === true,
    uriType: "episode",
  };
}

export function parseAudiobookDetail(raw: unknown, chaptersRaw: unknown): DetailData | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["id"] !== "string") return null;
  const c = (chaptersRaw as Record<string, unknown> | null) ?? {};
  const list = Array.isArray(c["items"]) ? (c["items"] as Array<Record<string, unknown>>) : [];
  const authorList = Array.isArray(o["authors"])
    ? (o["authors"] as Array<Record<string, unknown>>)
        .map((a) => (typeof a["name"] === "string" ? (a["name"] as string) : ""))
        .filter(Boolean)
        .join(", ")
    : "";
  return {
    kind: "audiobook",
    name: typeof o["name"] === "string" ? (o["name"] as string) : "Audiobook",
    image: img(o["images"]),
    authors: authorList,
    chapters: list.filter((t) => typeof t["uri"] === "string").map(queueItem),
    uri: typeof o["uri"] === "string" ? (o["uri"] as string) : "",
    explicit: o["explicit"] === true,
  };
}

export function parseChapterDetail(raw: unknown): DetailData | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["id"] !== "string") return null;
  const book = o["audiobook"] as Record<string, unknown> | undefined;
  return {
    kind: "chapter",
    name: typeof o["name"] === "string" ? (o["name"] as string) : "Chapter",
    image: img(o["images"]),
    book: book && typeof book["name"] === "string" ? (book["name"] as string) : "",
    durationMs: typeof o["duration_ms"] === "number" ? (o["duration_ms"] as number) : 0,
    uri: typeof o["uri"] === "string" ? (o["uri"] as string) : "",
    explicit: o["explicit"] === true,
    uriType: "chapter",
  };
}

export function parseTrackDetail(raw: unknown): DetailData | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["id"] !== "string") return null;
  const album = o["album"] as Record<string, unknown> | undefined;
  return {
    kind: "track",
    name: typeof o["name"] === "string" ? (o["name"] as string) : "Track",
    image: album ? img(album["images"]) : null,
    artists: artists(o),
    album: album && typeof album["name"] === "string" ? (album["name"] as string) : "",
    durationMs: typeof o["duration_ms"] === "number" ? (o["duration_ms"] as number) : 0,
    uri: typeof o["uri"] === "string" ? (o["uri"] as string) : "",
    explicit: o["explicit"] === true,
    uriType: "track",
  };
}

export function parseArtistDetail(
  artist: unknown,
  albums: unknown,
  related: unknown,
  searchFallback?: QueueItem[],
): DetailData | null {
  if (!artist || typeof artist !== "object") return null;
  const o = artist as Record<string, unknown>;
  if (typeof o["id"] !== "string") return null;
  // Dropped GET /artists/{id}/top-tracks. Replaced with albums strip +
  // search fallback. Top tracks now come from the search-derived backfill
  // when the caller supplies it (see BrowsePane artist detail); without it
  // the strip stays honestly empty instead of guessing.
  void related;
  const al = (albums as Record<string, unknown> | null) ?? {};
  const alList = Array.isArray(al["items"]) ? (al["items"] as Array<Record<string, unknown>>) : [];
  const topList: QueueItem[] = Array.isArray(searchFallback) ? searchFallback : [];
  return {
    kind: "artist",
    name: typeof o["name"] === "string" ? (o["name"] as string) : "Artist",
    image: img(o["images"]),
    genres: Array.isArray(o["genres"])
      ? (o["genres"] as unknown[]).filter((g): g is string => typeof g === "string").slice(0, 3)
      : [],
    topTracks: topList,
    albums: alList.map((a) => toLibraryItem(a, "Album")),
    uri: typeof o["uri"] === "string" ? (o["uri"] as string) : "",
  };
}

/** Search parser. `offset` pages into each bucket's raw items with a window
 *  of SEARCH_PAGE (10), matching the backend limit clamp: page N fetches
 *  offset N*10 and the caller merges bucket windows across pages. */
export const SEARCH_PAGE = 10;

export function parseSearch(raw: unknown, offset = 0): SearchResults {
  const out: SearchResults = { tracks: [], artists: [], playlists: [], albums: [], shows: [], episodes: [], audiobooks: [] };
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  const off = Math.max(0, Math.floor(offset) || 0);
  const windowOf = <T>(items: T[]): T[] => items.slice(off, off + SEARCH_PAGE);
  const t = o["tracks"] as Record<string, unknown> | undefined;
  if (t && Array.isArray(t["items"])) {
    out.tracks = windowOf(t["items"] as Array<Record<string, unknown>>).map(queueItem);
  }
  const a = o["artists"] as Record<string, unknown> | undefined;
  if (a && Array.isArray(a["items"])) {
    out.artists = windowOf(a["items"] as Array<Record<string, unknown>>).map((x) =>
      toLibraryItem(x, "Artist"),
    );
  }
  const p = o["playlists"] as Record<string, unknown> | undefined;
  if (p && Array.isArray(p["items"])) {
    out.playlists = windowOf(
      (p["items"] as Array<Record<string, unknown>>).filter((x) => x && typeof x["id"] === "string"),
    ).map((x) => toLibraryItem(x, "Playlist"));
  }
  const al = o["albums"] as Record<string, unknown> | undefined;
  if (al && Array.isArray(al["items"])) {
    out.albums = windowOf(al["items"] as Array<Record<string, unknown>>).map((x) =>
      toLibraryItem(x, "Album"),
    );
  }
  const sh = o["shows"] as Record<string, unknown> | undefined;
  if (sh && Array.isArray(sh["items"])) {
    out.shows = windowOf(
      (sh["items"] as Array<Record<string, unknown>>).filter(
        (x) => x && typeof x["id"] === "string",
      ),
    ).map((x) => toLibraryItem(x, "Show"));
  }
  const ep = o["episodes"] as Record<string, unknown> | undefined;
  if (ep && Array.isArray(ep["items"])) {
    out.episodes = windowOf(
      (ep["items"] as Array<Record<string, unknown>>).filter(
        (x) => x && typeof x["uri"] === "string",
      ),
    ).map(queueItem);
  }
  const ab = o["audiobooks"] as Record<string, unknown> | undefined;
  if (ab && Array.isArray(ab["items"])) {
    out.audiobooks = windowOf(
      (ab["items"] as Array<Record<string, unknown>>).filter(
        (x) => x && typeof x["id"] === "string",
      ),
    ).map((x) => toLibraryItem(x, "Audiobook"));
  }
  return out;
}

export function parseUserProfile(raw: unknown): UserProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["id"] !== "string") return null;
  // Users self only. Dropped GET /users/{id}; use account_id for linking.
  // Stale followers/product fields are not read.
  return {
    id: o["id"] as string,
    name:
      typeof o["display_name"] === "string" && o["display_name"]
        ? (o["display_name"] as string)
        : (o["id"] as string),
    image: img(o["images"]),
    accountId: typeof o["id"] === "string" ? (o["id"] as string) : "",
  };
}

export function parseSavedShows(raw: unknown): { items: LibraryItem[]; total: number } {
  if (!raw || typeof raw !== "object") return { items: [], total: 0 };
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o["items"]) ? (o["items"] as Array<Record<string, unknown>>) : [];
  const items = list
    .map((w) => (w["show"] as Record<string, unknown> | undefined) ?? w)
    .filter((a): a is Record<string, unknown> => !!a && typeof a["id"] === "string")
    .map((a) => toLibraryItem(a, "Show"));
  return { items, total: typeof o["total"] === "number" ? (o["total"] as number) : items.length };
}

export function parseSavedEpisodes(raw: unknown): { items: QueueItem[]; total: number } {
  if (!raw || typeof raw !== "object") return { items: [], total: 0 };
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o["items"]) ? (o["items"] as Array<Record<string, unknown>>) : [];
  const items = list
    .map((w) => (w["episode"] as Record<string, unknown> | undefined) ?? w)
    .filter((t): t is Record<string, unknown> => !!t && typeof t["uri"] === "string")
    .map(queueItem);
  return { items, total: typeof o["total"] === "number" ? (o["total"] as number) : items.length };
}

export function parseSavedAudiobooks(raw: unknown): { items: LibraryItem[]; total: number } {
  if (!raw || typeof raw !== "object") return { items: [], total: 0 };
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o["items"]) ? (o["items"] as Array<Record<string, unknown>>) : [];
  const items = list
    .filter((a): a is Record<string, unknown> => !!a && typeof a["id"] === "string")
    .map((a) => toLibraryItem(a, "Audiobook"));
  return { items, total: typeof o["total"] === "number" ? (o["total"] as number) : items.length };
}
