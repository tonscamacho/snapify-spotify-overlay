import type { Page } from "@playwright/test";
import { buildFixtures, type VerifyFixtures } from "./fixtures";

export interface InvokedCall {
  cmd: string;
  args: Record<string, unknown>;
}

export interface StubTauriOptions {
  /** Deep-merged over the default fixtures (shallow per top-level key). */
  fixtures?: Partial<VerifyFixtures>;
  /** When set, seeded into localStorage as snapify-layout-v3 before boot. */
  layout?: Record<string, unknown> | null;
  /** Seeds snapify-interact so the dock renders. Defaults to true. */
  interact?: boolean;
}

/**
 * Builds the addInitScript payload. Plain ES2019 in a template string on
 * purpose: it must run verbatim in the browser before any app module loads.
 * It replicates the mockIPC/mockWindows contract from @tauri-apps/api/mocks
 * (invoke + transformCallback/unregisterCallback/runCallback + metadata)
 * backed by the given fixtures, and records every command in
 * window.__INVOKED__ for assertions.
 */
function buildInitScript(
  fixtures: VerifyFixtures,
  layout: Record<string, unknown> | null,
  interact: boolean,
): string {
  const fx = JSON.stringify(fixtures).replace(/</g, "\\u003c");
  const seedLayout = layout ? JSON.stringify(layout).replace(/</g, "\\u003c") : "null";
  return (
    "(" +
    "function(FIXTURES, SEED_LAYOUT, SEED_INTERACT) {\n" +
    "  try {\n" +
    "    localStorage.setItem('snapify-interact', SEED_INTERACT ? '1' : '0');\n" +
    "    if (SEED_LAYOUT) localStorage.setItem('snapify-layout-v3', JSON.stringify(SEED_LAYOUT));\n" +
    "  } catch (e) {}\n" +
    "  window.__INVOKED__ = [];\n" +
    "  try {\n" +
    "    var sdkTag = document.createElement('script');\n" +
    "    sdkTag.setAttribute('data-spotify-sdk', '1');\n" +
    "    (document.head || document.documentElement).appendChild(sdkTag);\n" +
    "  } catch (e) {}\n" +
    "  function FakePlayer(opts) { this._opts = opts || {}; this._ev = {}; }\n" +
    "  FakePlayer.prototype.addListener = function (name, cb) {\n" +
    "    if (!this._ev[name]) this._ev[name] = [];\n" +
    "    this._ev[name].push(cb);\n" +
    "    return true;\n" +
    "  };\n" +
    "  FakePlayer.prototype._fire = function (name, payload) {\n" +
    "    (this._ev[name] || []).forEach(function (cb) { try { cb(payload); } catch (e) {} });\n" +
    "  };\n" +
    "  FakePlayer.prototype.connect = function () {\n" +
    "    this._fire('ready', { device_id: 'sdk-device-1' });\n" +
    "    return Promise.resolve(true);\n" +
    "  };\n" +
    "  FakePlayer.prototype.disconnect = function () {};\n" +
    "  FakePlayer.prototype.getCurrentState = function () { return Promise.resolve(null); };\n" +
    "  FakePlayer.prototype.setVolume = function () { return Promise.resolve(); };\n" +
    "  FakePlayer.prototype.pause = function () { return Promise.resolve(); };\n" +
    "  FakePlayer.prototype.resume = function () { return Promise.resolve(); };\n" +
    "  window.Spotify = { Player: FakePlayer };\n" +
    "  var callbacks = new Map();\n" +
    "  var nextCbId = 1;\n" +
    "  var eventListeners = new Map();\n" +
    "  function runCallback(id, data) {\n" +
    "    var cb = callbacks.get(id);\n" +
    "    if (cb) { try { cb(data); } catch (e) {} }\n" +
    "  }\n" +
    "  function dispatch(event, payload) {\n" +
    "    (eventListeners.get(event) || []).slice().forEach(function (id) {\n" +
    "      runCallback(id, { event: event, payload: payload });\n" +
    "    });\n" +
    "  }\n" +
    "  window.__TAURI_EMIT_TO_APP__ = dispatch;\n" +
    "  var player = JSON.parse(JSON.stringify(FIXTURES.player));\n" +
    "  var keybinds = Object.assign({}, FIXTURES.keybinds);\n" +
    "  function emptyPage() { return { items: [], total: 0 }; }\n" +
    "  async function invoke(cmd, args) {\n" +
    "    args = args || {};\n" +
    "    window.__INVOKED__.push({ cmd: cmd, args: args });\n" +
    "    switch (cmd) {\n" +
    "      case 'auth_status': return { logged_in: true, awaiting_callback: false };\n" +
    "      case 'start_login': return 'https://example.invalid/authorize';\n" +
    "      case 'logout': return null;\n" +
    "      case 'get_fresh_token': return 'fixture-token';\n" +
    "      case 'autostart_state': return false;\n" +
    "      case 'set_autostart': return null;\n" +
    "      case 'get_keybinds': return Object.assign({}, keybinds);\n" +
    "      case 'set_keybind':\n" +
    "        if (args.action) keybinds[args.action] = args.accelerator;\n" +
    "        return Object.assign({}, keybinds);\n" +
    "      case 'reset_keybinds':\n" +
    "        keybinds = Object.assign({}, FIXTURES.keybinds);\n" +
    "        return Object.assign({}, keybinds);\n" +
    "      case 'get_player': return player;\n" +
    "      case 'get_devices': return FIXTURES.devices;\n" +
    "      case 'get_queue': return FIXTURES.queue;\n" +
    "      case 'play': player.is_playing = true; return null;\n" +
    "      case 'pause': player.is_playing = false; return null;\n" +
    "      case 'next_track': return null;\n" +
    "      case 'prev_track': return null;\n" +
    "      case 'seek':\n" +
    "        if (typeof args.positionMs === 'number') player.progress_ms = args.positionMs;\n" +
    "        else if (typeof args.position_ms === 'number') player.progress_ms = args.position_ms;\n" +
    "        return null;\n" +
    "      case 'set_volume': return null;\n" +
    "      case 'set_shuffle': player.shuffle_state = !!args.enabled; return null;\n" +
    "      case 'set_repeat': player.repeat_state = args.mode || 'off'; return null;\n" +
    "      case 'transfer_playback': return null;\n" +
    "      case 'add_to_queue': return null;\n" +
    "      case 'play_context': return null;\n" +
    "      case 'play_uris': return null;\n" +
    "      case 'get_lyrics': return FIXTURES.lyrics;\n" +
    "      case 'get_me': return FIXTURES.me;\n" +
    "      case 'get_my_playlists': return FIXTURES.playlists;\n" +
    "      case 'create_playlist': return { id: 'pl-new', uri: 'spotify:playlist:pl-new' };\n" +
    "      case 'get_my_tracks': return FIXTURES.savedTracks;\n" +
    "      case 'get_my_albums': return FIXTURES.savedAlbums;\n" +
    "      case 'get_my_shows': return FIXTURES.savedShows;\n" +
    "      case 'get_my_episodes': return FIXTURES.savedEpisodes;\n" +
    "      case 'get_my_audiobooks': return FIXTURES.savedAudiobooks;\n" +
    "      case 'get_followed_artists': return FIXTURES.followedArtists;\n" +
    "      case 'get_my_following': return emptyPage();\n" +
    "      case 'library_contains': return (args.ids || []).map(function () { return true; });\n" +
    "      case 'library_save': return null;\n" +
    "      case 'library_remove': return null;\n" +
    "      case 'follow_put': return null;\n" +
    "      case 'follow_delete': return null;\n" +
    "      case 'get_my_top': return emptyPage();\n" +
    "      case 'get_recently_played': return emptyPage();\n" +
    "      case 'get_playlist': return FIXTURES.playlistDetail;\n" +
    "      case 'get_playlist_items': return FIXTURES.playlistItems;\n" +
    "      case 'add_playlist_items': return null;\n" +
    "      case 'remove_playlist_items': return null;\n" +
    "      case 'reorder_playlist_items': return null;\n" +
    "      case 'get_track': return FIXTURES.trackDetail;\n" +
    "      case 'get_artist': return FIXTURES.artistDetail;\n" +
    "      case 'get_related_artists': return { artists: [] };\n" +
    "      case 'get_artist_albums': return emptyPage();\n" +
    "      case 'get_album': return FIXTURES.albumDetail;\n" +
    "      case 'get_album_tracks': return emptyPage();\n" +
    "      case 'get_show': return FIXTURES.showDetail;\n" +
    "      case 'get_show_episodes': return emptyPage();\n" +
    "      case 'get_episode': return FIXTURES.trackDetail;\n" +
    "      case 'get_audiobook': return FIXTURES.audiobookDetail;\n" +
    "      case 'get_audiobook_chapters': return emptyPage();\n" +
    "      case 'get_chapter': return FIXTURES.trackDetail;\n" +
    "      case 'search': return FIXTURES.search;\n" +
    "      case 'request_log_counts':\n" +
    "        return { total: 0, ok: 0, rate_limited: 0, quota_exceeded: 0, unauthorized: 0, other: 0 };\n" +
    "      case 'request_log_recent': return [];\n" +
    "      case 'plugin:event|listen': {\n" +
    "        var id = args.handler;\n" +
    "        if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);\n" +
    "        eventListeners.get(args.event).push(id);\n" +
    "        return id;\n" +
    "      }\n" +
    "      case 'plugin:event|unlisten': {\n" +
    "        var arr = eventListeners.get(args.event) || [];\n" +
    "        var ix = arr.indexOf(args.eventId);\n" +
    "        if (ix !== -1) arr.splice(ix, 1);\n" +
    "        return null;\n" +
    "      }\n" +
    "      case 'plugin:event|emit':\n" +
    "        dispatch(args.event, args.payload);\n" +
    "        return null;\n" +
    "      case 'plugin:event|emit_to': return null;\n" +
    "      case 'plugin:opener|open_url': return null;\n" +
    "      case 'plugin:opener|open_path': return null;\n" +
    "      case 'plugin:app|version': return FIXTURES.version;\n" +
    "      case 'plugin:updater|check': return null;\n" +
    "      case 'plugin:process|restart': return null;\n" +
    "      case 'plugin:process|exit': return null;\n" +
    "      default:\n" +
    "        return null;\n" +
    "    }\n" +
    "  }\n" +
    "  window.__TAURI_INTERNALS__ = {\n" +
    "    invoke: invoke,\n" +
    "    transformCallback: function (cb, once) {\n" +
    "      var id = nextCbId++;\n" +
    "      callbacks.set(id, function (data) {\n" +
    "        if (once) callbacks.delete(id);\n" +
    "        if (cb) cb(data);\n" +
    "      });\n" +
    "      return id;\n" +
    "    },\n" +
    "    unregisterCallback: function (id) { callbacks.delete(id); },\n" +
    "    runCallback: runCallback,\n" +
    "    callbacks: callbacks,\n" +
    "    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },\n" +
    "    convertFileSrc: function (p) { return p; }\n" +
    "  };\n" +
    "  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {\n" +
    "    unregisterListener: function (event, id) {\n" +
    "      var arr = eventListeners.get(event) || [];\n" +
    "      var ix = arr.indexOf(id);\n" +
    "      if (ix !== -1) arr.splice(ix, 1);\n" +
    "    }\n" +
    "  };\n" +
    "})(" +
    fx +
    "," +
    seedLayout +
    "," +
    (interact ? "true" : "false") +
    ");"
  );
}

/**
 * Installs the Tauri v2 boundary stub (plus Spotify SDK + localStorage seeds)
 * so the real src/main.tsx -> src/App.tsx boots logged-in with fixtures.
 * Call before page.goto(); the init script re-runs on every reload.
 */
export async function stubTauri(page: Page, opts: StubTauriOptions = {}): Promise<VerifyFixtures> {
  const fixtures = buildFixtures(opts.fixtures);
  await page.addInitScript(buildInitScript(fixtures, opts.layout ?? null, opts.interact ?? true));
  // index.html references the real SDK tag; keep the suite hermetic by
  // serving a stub that fires the ready callback. The injected
  // <script data-spotify-sdk> tag from the init script does not survive HTML
  // parsing, so the product's own loadScript() element takes this path.
  await page.route(/sdk\.scdn\.co/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "window.onSpotifyWebPlaybackSDKReady&&window.onSpotifyWebPlaybackSDKReady();",
    }),
  );
  return fixtures;
}

/** Every Tauri command invoked so far, in order. */
export async function invokedCommands(page: Page): Promise<InvokedCall[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __INVOKED__?: InvokedCall[] };
    return w.__INVOKED__ ?? [];
  });
}

/** Args of every invocation of one command, in order. */
export async function commandsNamed(page: Page, cmd: string): Promise<Record<string, unknown>[]> {
  const all = await invokedCommands(page);
  return all.filter((c) => c.cmd === cmd).map((c) => c.args ?? {});
}
