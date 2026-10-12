import { DEFAULT_KEYBINDS } from "../../src/lib/keybinds";

export const TRACK_ID = "verify-track-01";
export const TRACK_NAME = "Fixture Anthem";
export const TRACK_ARTISTS = "Fixture Band";
export const TRACK_ALBUM = "Fixture Album";
export const TRACK_DURATION_MS = 203000;
export const TRACK_PROGRESS_MS = 65000;
export const TRACK_URI = "spotify:track:verify-track-01";
export const DEVICE_ID = "dev-verify-1";
export const APP_VERSION = "9.9.9-verify";

/** 1px PNG data URI: exercises cover art + ambient tint with zero network. */
export const COVER_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export interface LyricCueFixture {
  t: number;
  text: string;
}

export const CUES: LyricCueFixture[] = [
  { t: 0, text: "Streetlight hums the intro" },
  { t: 15000, text: "Sidewalk drums and neon rain" },
  { t: 30000, text: "We chase the midnight metro" },
  { t: 45000, text: "Every window glows the same" },
  { t: 60000, text: "Halfway home we sing along" },
  { t: 75000, text: "Static blooms to stereo" },
  { t: 90000, text: "Last train out, we hold the song" },
  { t: 120000, text: "Dawn rewinds the radio" },
];

/** Active cue for TRACK_PROGRESS_MS (65 s): index 4. */
export const ACTIVE_LINE = "Halfway home we sing along";
export const ACTIVE_CUE_T = 60000;

export const QUEUE_NAMES = ["Next Up One", "Second in Line", "Third Time Round"];

export interface VerifyFixtures {
  version: string;
  keybinds: Record<string, string>;
  player: unknown;
  devices: unknown;
  queue: unknown;
  lyrics: {
    trackId: string;
    synced: boolean;
    instrumental: boolean;
    cues: LyricCueFixture[];
    plain: string | null;
    cached: boolean;
  };
  me: unknown;
  /** Per-time_range top windows. The tauri mock branches get_my_top on the
   *  timeRange arg: short_term -> topShort, medium_term -> topMedium,
   *  long_term (or legacy null) -> topLong. Each window carries the artists
   *  and tracks pages so kind selects within the window. */
  topShort: unknown;
  topMedium: unknown;
  topLong: unknown;
  /** Recently-played page: items are [{ track, played_at }] (not a bare
   *  track list) so the mock returns the real Spotify shape. */
  recentPlays: unknown;
  playlists: unknown;
  savedTracks: unknown;
  savedAlbums: unknown;
  savedShows: unknown;
  savedEpisodes: unknown;
  savedAudiobooks: unknown;
  followedArtists: unknown;
  playlistDetail: unknown;
  playlistItems: unknown;
  trackDetail: unknown;
  artistDetail: unknown;
  albumDetail: unknown;
  showDetail: unknown;
  audiobookDetail: unknown;
  search: unknown;
}

function trackShape(id: string, name: string, artists: string) {
  return {
    id,
    name,
    artists: [{ name: artists }],
    album: { name: TRACK_ALBUM, images: [] },
    duration_ms: 180000,
    uri: `spotify:track:${id}`,
    explicit: false,
  };
}

function mainTrackShape() {
  return {
    id: TRACK_ID,
    name: TRACK_NAME,
    artists: [{ name: TRACK_ARTISTS }],
    album: { name: TRACK_ALBUM, images: [{ url: COVER_DATA_URI }] },
    duration_ms: TRACK_DURATION_MS,
    uri: TRACK_URI,
    explicit: false,
  };
}

export function buildFixtures(overrides: Partial<VerifyFixtures> = {}): VerifyFixtures {
  const base: VerifyFixtures = {
    version: APP_VERSION,
    keybinds: { ...DEFAULT_KEYBINDS },
    player: {
      is_playing: true,
      progress_ms: TRACK_PROGRESS_MS,
      item: mainTrackShape(),
      device: { id: DEVICE_ID, name: "Verify Speaker", volume_percent: 80 },
      shuffle_state: false,
      repeat_state: "off",
    },
    devices: {
      devices: [
        {
          id: DEVICE_ID,
          name: "Verify Speaker",
          type: "Speaker",
          is_active: true,
          volume_percent: 80,
        },
      ],
    },
    queue: {
      currently_playing: trackShape("verify-current-0", "Now Spinning", "House Band"),
      queue: QUEUE_NAMES.map((name, i) =>
        trackShape(`verify-next-${i + 1}`, name, `Guest Artist ${i + 1}`),
      ),
    },
    lyrics: {
      trackId: TRACK_ID,
      synced: true,
      instrumental: false,
      cues: CUES.map((c) => ({ ...c })),
      plain: null,
      cached: false,
    },
    me: { id: "verify-user", display_name: "Verify User", images: [{ url: COVER_DATA_URI }] },
    topShort: topWindow("short", PROFILE_SHORT_ALBUM, PROFILE_SHORT_TRACKS, PROFILE_SHORT_ARTISTS, PROFILE_GENRES),
    topMedium: topWindow("medium", PROFILE_MEDIUM_ALBUM, PROFILE_MEDIUM_TRACKS, PROFILE_MEDIUM_ARTISTS, PROFILE_GENRES),
    topLong: topWindow("long", PROFILE_LONG_ALBUM, PROFILE_LONG_TRACKS, PROFILE_LONG_ARTISTS, PROFILE_GENRES),
    recentPlays: buildRecentPlays(),
    playlists: {
      items: [
        {
          id: "pl-verify-1",
          name: "Verify Jams",
          owner: { display_name: "verify-user" },
          images: [],
          uri: "spotify:playlist:pl-verify-1",
        },
      ],
      total: 1,
    },
    savedTracks: { items: [{ track: mainTrackShape() }], total: 1 },
    savedAlbums: {
      items: [
        {
          album: {
            id: "alb-verify-1",
            name: TRACK_ALBUM,
            artists: [{ name: TRACK_ARTISTS }],
            images: [],
            uri: "spotify:album:alb-verify-1",
          },
        },
      ],
      total: 1,
    },
    savedShows: { items: [], total: 0 },
    savedEpisodes: { items: [], total: 0 },
    savedAudiobooks: { items: [], total: 0 },
    followedArtists: {
      artists: {
        items: [
          {
            id: "art-verify-1",
            name: TRACK_ARTISTS,
            images: [],
            uri: "spotify:artist:art-verify-1",
          },
        ],
        cursors: { after: null },
      },
    },
    playlistDetail: {
      id: "pl-verify-1",
      name: "Verify Jams",
      owner: { display_name: "verify-user" },
      images: [],
      tracks: { items: [], total: 0 },
      uri: "spotify:playlist:pl-verify-1",
    },
    playlistItems: { items: [], total: 0 },
    trackDetail: mainTrackShape(),
    artistDetail: {
      id: "art-verify-1",
      name: TRACK_ARTISTS,
      images: [],
      genres: ["indie"],
      uri: "spotify:artist:art-verify-1",
    },
    albumDetail: {
      id: "alb-verify-1",
      name: TRACK_ALBUM,
      images: [],
      artists: [{ name: TRACK_ARTISTS }],
      tracks: { items: [] },
      uri: "spotify:album:alb-verify-1",
    },
    showDetail: {
      id: "show-verify-1",
      name: "Verify Cast",
      images: [],
      publisher: "Verify FM",
      uri: "spotify:show:show-verify-1",
    },
    audiobookDetail: {
      id: "ab-verify-1",
      name: "Verify Tales",
      images: [],
      authors: [{ name: "Verify Author" }],
      uri: "spotify:audiobook:ab-verify-1",
    },
    search: {
      tracks: { items: [mainTrackShape()] },
      artists: { items: [] },
      playlists: { items: [] },
      albums: { items: [] },
      shows: { items: [] },
      episodes: { items: [] },
      audiobooks: { items: [] },
    },
  };
  return { ...base, ...overrides };
}

/** Profile pane windows (Batch 2c). Top artists carry genres + images,
 *  top tracks carry duration_ms, recent plays carry played_at + duration_ms,
 *  and me carries an avatar image. played_at stamps span the client-slice
 *  windows (today / week / 2026) so range specs can assert filtering. */
export const PROFILE_ME_NAME = "Verify User";
export const PROFILE_ME_ID = "verify-user";

function profileArtist(id: string, name: string, genres: string[]) {
  return {
    id,
    name,
    genres,
    images: [{ url: COVER_DATA_URI }],
    uri: `spotify:artist:${id}`,
  };
}

function profileTrack(
  id: string,
  name: string,
  artist: string,
  durationMs: number,
  album: { id: string; name: string },
) {
  return {
    id,
    name,
    artists: [{ name: artist }],
    album: {
      id: album.id,
      name: album.name,
      images: [{ url: COVER_DATA_URI }],
      uri: `spotify:album:${album.id}`,
    },
    duration_ms: durationMs,
    uri: `spotify:track:${id}`,
    explicit: false,
  };
}

function topWindow(
  prefix: string,
  albumName: string,
  trackNames: string[],
  artistNames: string[],
  genres: string[][],
) {
  const album = { id: `${prefix}-album`, name: albumName };
  return {
    artists: {
      items: artistNames.map((name, i) =>
        profileArtist(`${prefix}-artist-${i + 1}`, name, genres[i % genres.length]),
      ),
      total: artistNames.length,
    },
    tracks: {
      items: trackNames.map((name, i) =>
        profileTrack(
          `${prefix}-track-${i + 1}`,
          name,
          artistNames[i % artistNames.length],
          180000 + i * 15000,
          album,
        ),
      ),
      total: trackNames.length,
    },
  };
}

const PROFILE_GENRES = [
  ["indie rock", "indie"],
  ["rock"],
  ["indie", "pop"],
  ["pop", "dance pop"],
  ["jazz"],
];

export const PROFILE_SHORT_TRACKS = ["Short Fuse One", "Short Fuse Two", "Short Fuse Three", "Short Fuse Four"];
export const PROFILE_SHORT_ARTISTS = ["Short Band One", "Short Band Two", "Short Band Three", "Short Band Four"];
export const PROFILE_MEDIUM_TRACKS = ["Medium Wave One", "Medium Wave Two", "Medium Wave Three", "Medium Wave Four"];
export const PROFILE_MEDIUM_ARTISTS = ["Medium Band One", "Medium Band Two", "Medium Band Three", "Medium Band Four"];
export const PROFILE_LONG_TRACKS = ["Lifetime Gem One", "Lifetime Gem Two", "Lifetime Gem Three", "Lifetime Gem Four"];
export const PROFILE_LONG_ARTISTS = ["Lifetime Band One", "Lifetime Band Two", "Lifetime Band Three", "Lifetime Band Four"];

export const PROFILE_SHORT_ALBUM = "Short Fuse LP";
export const PROFILE_MEDIUM_ALBUM = "Medium Wave LP";
export const PROFILE_LONG_ALBUM = "Lifetime Gems LP";

function recentEntry(
  id: string,
  name: string,
  artist: string,
  playedAt: number,
  durationMs: number,
) {
  return {
    played_at: new Date(playedAt).toISOString(),
    track: profileTrack(id, name, artist, durationMs, { id: `${id}-album`, name: `${name} Single` }),
  };
}

/** Seven streams across the slice windows: today (1h ago), week (2d + 6d
 *  ago), fourWeeks-only (20d), sixMonths-only (100d), 2026-only (Valentine's
 *  2026), and lifetime-only (May 2024). Durations are real so stats tiles
 *  derive minutes; names are unique per window for filter assertions. */
export function buildRecentPlays(now: number = Date.now()) {
  const items = [
    recentEntry("rec-today", "Today Spin", "Short Band One", now - 3600000, 200000),
    recentEntry("rec-week-a", "Week Spin A", "Short Band Two", now - 2 * 86400000, 180000),
    recentEntry("rec-week-b", "Week Spin B", "Medium Band One", now - 6 * 86400000, 210000),
    recentEntry("rec-month", "Month Spin", "Medium Band Two", now - 20 * 86400000, 240000),
    recentEntry("rec-half", "Half-Year Spin", "Lifetime Band One", now - 100 * 86400000, 195000),
    recentEntry("rec-valentine", "Valentine Spin", "Lifetime Band Two", Date.UTC(2026, 1, 14, 12), 220000),
    recentEntry("rec-ancient", "Ancient Spin", "Lifetime Band Three", Date.UTC(2024, 4, 1, 12), 205000),
  ];
  return { items, total: items.length };
}

export const PROFILE_RECENT_NAMES = [
  "Today Spin",
  "Week Spin A",
  "Week Spin B",
  "Month Spin",
  "Half-Year Spin",
  "Valentine Spin",
  "Ancient Spin",
];

/** Minimal preset layout used to seed localStorage for layout specs. */
export const MINIMAL_LAYOUT = {  version: 3,
  preset: "minimal",
  panes: [
    {
      id: "player",
      type: "player",
      x: 24,
      y: 24,
      w: 340,
      h: 236,
      opacity: 0.92,
      visible: true,
      z: 1,
    },
  ],
};
