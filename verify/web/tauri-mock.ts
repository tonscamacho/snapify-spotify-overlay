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
  /** Seeds snapify-interact (panes stay interactive). Defaults to true. */
  interact?: boolean;
  /** Seeds snapify-edit: the editor dock/notch render only while editing.
   *  Defaults to false; specs that drive dock controls pass edit: true. */
  edit?: boolean;
  /** Seeds snapify-notch-hover. Defaults to false so an edit-seeded dock
   *  stays visible without hover choreography; the autohide-ON path is
   *  covered by notch-hover.spec.ts (plus the layout.ts default-true unit
   *  test for the missing-key default). */
  notchHover?: boolean;
  authStatus?: { logged_in: boolean; awaiting_callback: boolean } | null;
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
  edit: boolean,
  notchHover: boolean,
  authSeed: { logged_in: boolean; awaiting_callback: boolean } | null,
): string {
  const fx = JSON.stringify(fixtures).replace(/</g, "\\u003c");
  const seedLayout = layout ? JSON.stringify(layout).replace(/</g, "\\u003c") : "null";
  const seedAuth = authSeed ? JSON.stringify(authSeed).replace(/</g, "\\u003c") : "null";
  return (
    "(" +
    "function(FIXTURES, SEED_LAYOUT, SEED_INTERACT, SEED_EDIT, SEED_NOTCH, SEED_AUTH) {\n" +
    "  function safeSetItem(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }\n" +
    "  // Private mode: prefs last the session.\n" +
    "  safeSetItem('snapify-interact', SEED_INTERACT ? '1' : '0');\n" +
    "  safeSetItem('snapify-edit', SEED_EDIT ? '1' : '0');\n" +
    "  safeSetItem('snapify-notch-hover', SEED_NOTCH ? '1' : '0');\n" +
    "  if (SEED_LAYOUT) safeSetItem('snapify-layout-v3', JSON.stringify(SEED_LAYOUT));\n" +
  "  window.__INVOKED__ = [];\n" +
  "  function FakePlayer(opts) { this._opts = opts || {}; this._ev = {}; window.__SDK_INIT_VOLUME__ = (opts || {}).volume; }\n" +
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
    "  FakePlayer.prototype.setVolume = function (v) {\n" +
    "    window.__SDK_LAST_VOLUME__ = v;\n" +
    "    return Promise.resolve();\n" +
    "  };\n" +
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
  "  var lyricsCache = { entries: 3, bytes: 4096 };\n" +
    "  function emptyPage() { return { items: [], total: 0 }; }\n" +
    "  var mockFaults = {};\n" +
    "  var mockAuthStatus = SEED_AUTH;\n" +
    "  window.__MOCK_DIALOG_PATH__ = null;\n" +
    "  window.__MOCK_DIALOG_PATHS__ = null;\n" +
    "  window.__MOCK_FILE_TEXT__ = null;\n" +
    "  window.__MOCK_FILE_TEXTS__ = null;\n" +
    "  window.__MOCK_FILE_ERRORS__ = null;\n" +
    "  var historySeen = {};\n" +
    "  var historyImported = !!(FIXTURES.historyHasImported);\n" +
    "  var historyPlays = [];\n" +
    "  var historyRanges = historyImported ? ['mock-import'] : [];\n" +
    "  window.__MOCK_AUTH_STATUS__ = function (s) {\n" +
    "    mockAuthStatus = s;\n" +
    "  };\n" +
    "  window.__MOCK_FAIL_NEXT__ = function (cmd, error, times) {\n" +
    "    mockFaults[cmd] = { error: error, remaining: times || 1 };\n" +
    "  };\n" +
    // Slow-cloud injector (Track B): holds the next N invocations of one
    // command for ms before answering, so specs can prove the UI reacts
    // (optimistic state, per-action busy) before the cloud resolves.
    // Mock-side only; the invoke contract is untouched.
    "  var mockDelays = {};\n" +
    "  window.__MOCK_DELAY_NEXT__ = function (cmd, ms, times) {\n" +
    "    mockDelays[cmd] = { ms: ms, remaining: times || 1 };\n" +
    "  };\n" +
    "  async function invoke(cmd, args) {\n" +
    "    args = args || {};\n" +
    "    window.__INVOKED__.push({ cmd: cmd, args: args });\n" +
    "    var fault = mockFaults[cmd];\n" +
    "    if (fault && fault.remaining > 0) {\n" +
    "      fault.remaining -= 1;\n" +
    "      throw new Error(fault.error);\n" +
    "    }\n" +
    "    var dl = mockDelays[cmd];\n" +
    "    if (dl && dl.remaining > 0) {\n" +
    "      dl.remaining -= 1;\n" +
    "      await new Promise(function (r) { setTimeout(r, dl.ms); });\n" +
    "    }\n" +
    "    switch (cmd) {\n" +
    "      case 'auth_status': return mockAuthStatus || { logged_in: true, awaiting_callback: false };\n" +
    "      case 'credential_status': return { stored: true, location: 'keyring', verified_at: null, keyring_ok: true };\n" +
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
    "      case 'set_volume':\n" +
    "        if (typeof args.volumePercent === 'number') player.device.volume_percent = args.volumePercent;\n" +
    "        return null;\n" +
    "      case 'set_shuffle': player.shuffle_state = !!args.enabled; return null;\n" +
    "      case 'set_repeat': player.repeat_state = args.mode || 'off'; return null;\n" +
    "      case 'transfer_playback': return null;\n" +
    "      case 'add_to_queue': return null;\n" +
    "      case 'play_context': return null;\n" +
    "      case 'play_uris': return null;\n" +
    "      case 'get_lyrics': return FIXTURES.lyrics;\n" +
  "      case 'lyrics_cache_size': return { entries: lyricsCache.entries, bytes: lyricsCache.bytes };\n" +
  "      case 'clear_lyrics_cache': { var n = lyricsCache.entries; lyricsCache = { entries: 0, bytes: 0 }; return { cleared: n }; }\n" +
    "      case 'get_me': return FIXTURES.me;\n" +
    "      case 'get_my_playlists': {\n" +
    "        var plItems = (FIXTURES.playlists && FIXTURES.playlists.items) || [];\n" +
    "        var plTotal = (FIXTURES.playlists && typeof FIXTURES.playlists.total === 'number') ? FIXTURES.playlists.total : plItems.length;\n" +
    "        var plLim = Number(args.limit) || 20; if (plLim < 1) plLim = 20; if (plLim > 50) plLim = 50;\n" +
    "        var plOff = Number(args.offset) || 0; if (plOff < 0) plOff = 0;\n" +
    "        return { items: plItems.slice(plOff, plOff + plLim), total: plTotal };\n" +
    "      }\n" +
    "      case 'create_playlist': return { id: 'pl-new', uri: 'spotify:playlist:pl-new' };\n" +
    "      case 'get_my_tracks': return FIXTURES.savedTracks;\n" +
    "      case 'get_my_albums': return FIXTURES.savedAlbums;\n" +
    "      case 'get_my_shows': return FIXTURES.savedShows;\n" +
    "      case 'get_my_episodes': return FIXTURES.savedEpisodes;\n" +
    "      case 'get_my_audiobooks': return FIXTURES.savedAudiobooks;\n" +
    "      case 'get_followed_artists': return FIXTURES.followedArtists;\n" +
    "      case 'get_my_following': return emptyPage();\n" +
    "      case 'library_contains': { var list = args.uris || args.ids || []; return list.map(function () { return true; }); }\n" +
    "      case 'library_save': return null;\n" +
    "      case 'library_remove': return null;\n" +
    "      case 'follow_put': return null;\n" +
    "      case 'follow_delete': return null;\n" +
     "      case 'set_overlay_mode': return null;\n" +
     "      case 'set_overlay_regions': return null;\n" +
     "      case 'set_overlay_mode_with_regions': return null;\n" +
      "      case 'get_my_top': {\n" +
      "        var tr = args.timeRange || args.time_range || null;\n" +
      "        var win = tr === 'short_term' ? FIXTURES.topShort : tr === 'medium_term' ? FIXTURES.topMedium : FIXTURES.topLong;\n" +
      "        if (!win) return emptyPage();\n" +
      "        if (args.kind === 'artists') return (win && win.artists) || emptyPage();\n" +
      "        return (win && win.tracks) || emptyPage();\n" +
      "      }\n" +
      "      case 'get_recently_played': return FIXTURES.recentPlays || emptyPage();\n" +
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
    "      case 'get_history_stats': {\n" +
    "        var nowMs = (args && typeof args.now === 'number' && args.now > 0) ? args.now : Date.now();\n" +
    "        var startMs = (args && typeof args.start === 'number') ? args.start : null;\n" +
    "        var tot = 0, totMs = 0; var tr = {}, ar = {}, al = {};\n" +
    "        var mph = []; for (var hi = 0; hi < 24; hi++) mph.push({ hour: hi, plays: 0, minutes: 0 });\n" +
    "        var msH = []; for (var hj = 0; hj < 24; hj++) msH.push(0);\n" +
    "        var byArt = {};\n" +
    "        for (var pi = 0; pi < historyPlays.length; pi++) {\n" +
    "          var hp = historyPlays[pi];\n" +
    "          if (hp.playedAt > nowMs) continue;\n" +
    "          if (startMs !== null && hp.playedAt < startMs) continue;\n" +
    "          var hms = (typeof hp.msPlayed === 'number') ? hp.msPlayed : hp.durationMs;\n" +
    "          if (!(hms >= 30000)) continue;\n" +
    "          if (!hp.uri || hp.uri.indexOf('spotify:track:') !== 0) continue;\n" +
    "          tot += 1; totMs += hms;\n" +
    "          tr[hp.trackId] = 1;\n" +
    "          var parts = String(hp.artists || '').split(',');\n" +
    "          for (var ai = 0; ai < parts.length; ai++) { var an = parts[ai].trim(); if (an) { ar[an] = 1; var ak = an.toLowerCase(); if (!byArt[ak]) byArt[ak] = { artist: an, streams: 0, ms: 0 }; byArt[ak].streams += 1; byArt[ak].ms += hms; } }\n" +
    "          var alb = (hp.albumName || hp.album || '').trim(); if (alb) al[alb.toLowerCase()] = 1;\n" +
    "          var hh = new Date(hp.playedAt).getHours(); if (hh >= 0 && hh < 24) { mph[hh].plays += 1; msH[hh] += hms; }\n" +
    "        }\n" +
    "        for (var kh = 0; kh < 24; kh++) mph[kh].minutes = Math.round(msH[kh] / 60000);\n" +
    "        var ph = 0; for (var q = 1; q < 24; q++) if (mph[q].plays > mph[ph].plays) ph = q;\n" +
    "        var ranks = Object.keys(byArt).map(function(k) { return { artist: byArt[k].artist, streams: byArt[k].streams, minutes: Math.round(byArt[k].ms / 60000) }; });\n" +
    "        ranks.sort(function(a, b) { return b.streams - a.streams || (a.artist.toLowerCase() < b.artist.toLowerCase() ? -1 : 1); });\n" +
    "        var mins = Math.round(totMs / 60000);\n" +
    "        return { total: tot, totalMs: totMs, minutes: mins, hours: Math.round(mins / 60), uniqueTracks: Object.keys(tr).length, uniqueArtists: Object.keys(ar).length, uniqueAlbums: Object.keys(al).length, hasImported: !!historyImported, importedRanges: historyRanges.slice(), clocks: mph, peakHour: ph, artistRanks: ranks.slice(0, 50) };\n" +
    "      }\n" +
    "      case 'get_history_plays': return { version: 2, plays: historyPlays.slice(), importedRanges: historyRanges.slice() };\n" +
    "      case 'get_history_page': {\n" +
    "        var pNow = (args && typeof args.now === 'number' && args.now > 0) ? args.now : Date.now();\n" +
    "        var pStart = (args && typeof args.start === 'number') ? args.start : null;\n" +
    "        var pCur = (args && typeof args.cursor === 'string') ? args.cursor : null;\n" +
    "        var pLim = (args && typeof args.limit === 'number' && args.limit >= 1) ? Math.min(500, Math.floor(args.limit)) : 100;\n" +
    "        var win = [];\n" +
    "        for (var wi = 0; wi < historyPlays.length; wi++) {\n" +
    "          var wp = historyPlays[wi];\n" +
    "          if (wp.playedAt > pNow) continue;\n" +
    "          if (pStart !== null && wp.playedAt < pStart) continue;\n" +
    "          var wms = (typeof wp.msPlayed === 'number') ? wp.msPlayed : wp.durationMs;\n" +
    "          if (!(wms >= 30000)) continue;\n" +
    "          if (!wp.uri || wp.uri.indexOf('spotify:track:') !== 0) continue;\n" +
    "          win.push(wp);\n" +
    "        }\n" +
    "        win.sort(function(a, b) { return b.playedAt - a.playedAt || (a.uri < b.uri ? -1 : 1); });\n" +
    "        var ix0 = 0;\n" +
    "        if (pCur) { for (var ci = 0; ci < win.length; ci++) { if ((win[ci].uri + '@' + win[ci].playedAt) === pCur) { ix0 = ci + 1; break; } } }\n" +
    "        var slice = win.slice(ix0, ix0 + pLim);\n" +
    "        var nxt = (ix0 + pLim < win.length && slice.length > 0) ? (slice[slice.length - 1].uri + '@' + slice[slice.length - 1].playedAt) : null;\n" +
    "        return { items: slice, nextCursor: nxt, total: win.length };\n" +
    "      }\n" +
      "      case 'read_history_file': {\n" +
    "        var perErr = window.__MOCK_FILE_ERRORS__;\n" +
    "        if (perErr && args.path && perErr[args.path]) throw new Error(perErr[args.path]);\n" +
    "        var perText = window.__MOCK_FILE_TEXTS__;\n" +
    "        if (perText && args.path && typeof perText[args.path] !== 'undefined' && perText[args.path] !== null) return String(perText[args.path]);\n" +
    "        if (typeof window.__MOCK_FILE_TEXT__ !== 'undefined' && window.__MOCK_FILE_TEXT__ !== null) return String(window.__MOCK_FILE_TEXT__);\n" +
    "        throw new Error('mock file missing');\n" +
    "      }\n" +
    "      case 'import_history': {\n" +
    "        var rows = args.rows || [];\n" +
    "        var seenImp = {};\n" +
    "        for (var hi = 0; hi < historyPlays.length; hi++) { seenImp[historyPlays[hi].uri + '@' + historyPlays[hi].playedAt] = 1; }\n" +
    "        var kept = 0; var dShort = 0; var dSkip = 0; var dNoUri = 0; var dDup = 0; var dInv = 0;\n" +
    "        for (var ri = 0; ri < rows.length; ri++) {\n" +
    "          var r = rows[ri];\n" +
    "          if (!r || typeof r !== 'object') { dInv += 1; continue; }\n" +
    "          var tsRaw = r.ts || r.playedAt || r.played_at;\n" +
    "          var ts = (typeof tsRaw === 'string' && /^\\d+$/.test(tsRaw.trim())) ? Number(tsRaw.trim()) : (typeof tsRaw === 'string' ? Date.parse(tsRaw) : (typeof tsRaw === 'number' ? tsRaw : NaN));\n" +
    "          var ms = typeof r.ms_played === 'number' ? r.ms_played : (typeof r.msPlayed === 'number' ? r.msPlayed : (typeof r.durationMs === 'number' ? r.durationMs : null));\n" +
    "          if (!isFinite(ts) || ts <= 0 || ms === null || ms < 0 || ts > Date.now()) { dInv += 1; continue; }\n" +
    "          var uri = (r.spotify_track_uri || r.uri || '').trim();\n" +
    "          if (!uri || uri.indexOf('spotify:track:') !== 0) { dNoUri += 1; continue; }\n" +
    "          if (ms < 30000) { dShort += 1; continue; }\n" +
    "          var k = uri + '@' + ts;\n" +
    "          if (seenImp[k]) { dDup += 1; continue; }\n" +
    "          seenImp[k] = 1; kept += 1;\n" +
    "          var skippedFlag = (r.skipped === true) || ((r.reason_end || r.reasonEnd || '').trim() === 'fwdbtn');\n" +
    "          historyPlays.push({ trackId: uri.split(':').pop() || uri, trackName: r.master_metadata_track_name || r.trackName || 'Unknown', artists: r.master_metadata_album_artist_name || r.artists || '', playedAt: ts, image: null, uri: uri, durationMs: ms, msPlayed: ms, skipped: !!skippedFlag, albumName: r.master_metadata_album_album_name || r.albumName || '', album: r.master_metadata_album_album_name || r.albumName || '', source: 'imported' });\n" +
    "        }\n" +
    "        historyPlays.sort(function(a, b) { return b.playedAt - a.playedAt || (a.uri < b.uri ? -1 : 1); });\n" +
    "        if (kept > 0) { historyImported = true; if (historyRanges.indexOf('mock-import') === -1) historyRanges.push('mock-import'); }\n" +
    "        return { total: rows.length, kept: kept, droppedShort: dShort, droppedSkipped: dSkip, droppedNoUri: dNoUri, droppedDuplicate: dDup, droppedInvalid: dInv };\n" +
    "      }\n" +
    "      case 'append_listen_cmd': {\n" +
    "        var pl = args.play || {};\n" +
    "        var puri = (pl.uri || '').trim();\n" +
    "        var patRaw = pl.playedAt;\n" +
    "        var pat = (typeof patRaw === 'string' && /^\\d+$/.test(String(patRaw).trim())) ? Number(String(patRaw).trim()) : Number(patRaw);\n" +
    "        if (!puri || puri.indexOf('spotify:track:') !== 0) return { reason: 'no-uri' };\n" +
    "        if (!isFinite(pat) || pat <= 0) return { reason: 'invalid' };\n" +
    "        if (pat > Date.now()) return { reason: 'future' };\n" +
    "        var pms = typeof pl.msPlayed === 'number' ? pl.msPlayed : (typeof pl.durationMs === 'number' ? pl.durationMs : 0);\n" +
    "        if (pms < 30000) return { reason: 'short' };\n" +
    "        var pk = puri + '@' + pat;\n" +
    "        if (historySeen[pk]) return { reason: 'duplicate' };\n" +
    "        historySeen[pk] = 1;\n" +
    "        return { reason: 'appended' };\n" +
    "      }\n" +
      "      case 'plugin:dialog|open': {\n" +
    "        if (window.__MOCK_DIALOG_PATHS__ !== null && typeof window.__MOCK_DIALOG_PATHS__ !== 'undefined') return window.__MOCK_DIALOG_PATHS__;\n" +
    "        return (typeof window.__MOCK_DIALOG_PATH__ !== 'undefined' && window.__MOCK_DIALOG_PATH__ !== null) ? window.__MOCK_DIALOG_PATH__ : null;\n" +
    "      }\n" +
    "      case 'plugin:fs|read_text_file': {\n" +
    "        if (typeof window.__MOCK_FILE_TEXT__ !== 'undefined' && window.__MOCK_FILE_TEXT__ !== null) { var _t = String(window.__MOCK_FILE_TEXT__); try { return Array.from(new TextEncoder().encode(_t)); } catch (e) { return _t; } }\n" +
    "        throw new Error('mock file missing');\n" +
    "      }\n" +
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
    "," +
    (edit ? "true" : "false") +
    "," +
    (notchHover ? "true" : "false") +
    "," +
    seedAuth +
    ");"
  );
}

/** Seed localStorage before boot without failing in private mode. */
export async function seedStorage(page: Page, entries: Record<string, string>): Promise<void> {
  await page.addInitScript((seed) => {
    try {
      for (const [k, v] of Object.entries(seed as Record<string, string>)) localStorage.setItem(k, v);
    } catch {
      /* private mode: prefs last the session */
    }
  }, entries);
}

/**
 * Installs the Tauri v2 boundary stub (plus Spotify SDK + localStorage seeds)
 * so the real src/main.tsx -> src/App.tsx boots logged-in with fixtures.
 * Call before page.goto(); the init script re-runs on every reload.
 */
export async function stubTauri(page: Page, opts: StubTauriOptions = {}): Promise<VerifyFixtures> {
  const fixtures = buildFixtures(opts.fixtures);
  await page.addInitScript(
    buildInitScript(
      fixtures,
      opts.layout ?? null,
      opts.interact ?? true,
      opts.edit ?? false,
      opts.notchHover ?? false,
      opts.authStatus ?? null,
    ),
  );
  // index.html references the real SDK tag; the suite stays hermetic via
  // the route stub below, which fires the ready callback.
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

/** Fail the next N invocations of one command with a throttle-style error.
 *  Used for 429 fixtures: the mock throws, the app queues, then flushes. */
export async function failNext(page: Page, cmd: string, error: string, times = 1): Promise<void> {
  await page.evaluate(
    ([c, e, n]) => {
      const w = window as unknown as {
        __MOCK_FAIL_NEXT__?: (cmd: string, error: string, times: number) => void;
      };
      w.__MOCK_FAIL_NEXT__?.(c as string, e as string, n as number);
    },
    [cmd, error, times] as unknown as [string, string, number],
  );
}

/** Hold the next N invocations of one command for ms before answering.
 *  Used for slow-cloud fixtures: the mock answers late, so the spec can
 *  prove the UI reacted (optimistic flip, per-action busy) first. */
export async function delayNext(page: Page, cmd: string, ms: number, times = 1): Promise<void> {
  await page.evaluate(
    ([c, m, n]) => {
      const w = window as unknown as {
        __MOCK_DELAY_NEXT__?: (cmd: string, ms: number, times: number) => void;
      };
      w.__MOCK_DELAY_NEXT__?.(c as string, m as number, n as number);
    },
    [cmd, ms, times] as unknown as [string, number, number],
  );
}

/** Seed the dialog pick + file text for history-import specs. */
export async function mockHistoryFile(page: Page, path: string | null, text: string | null): Promise<void> {
  await page.evaluate(
    ([p, t]) => {
      const w = window as unknown as {
        __MOCK_DIALOG_PATH__?: string | null;
        __MOCK_DIALOG_PATHS__?: string[] | null;
        __MOCK_FILE_TEXT__?: string | null;
        __MOCK_FILE_TEXTS__?: Record<string, string> | null;
        __MOCK_FILE_ERRORS__?: Record<string, string> | null;
      };
      w.__MOCK_DIALOG_PATH__ = p as string | null;
      w.__MOCK_DIALOG_PATHS__ = null;
      w.__MOCK_FILE_TEXT__ = t as string | null;
      w.__MOCK_FILE_TEXTS__ = null;
      w.__MOCK_FILE_ERRORS__ = null;
    },
    [path, text] as unknown as [string | null, string | null],
  );
}

/** Seed a multi-file dialog pick. `texts` maps path -> file text;
 *  `errors` maps path -> read error (import continues with a note).
 *  Pass `paths: null` to simulate dialog cancel. */
export async function mockHistoryFiles(
  page: Page,
  paths: string[] | null,
  texts: Record<string, string> = {},
  errors: Record<string, string> = {},
): Promise<void> {
  await page.evaluate(
    ([p, t, e]) => {
      const w = window as unknown as {
        __MOCK_DIALOG_PATH__?: string | null;
        __MOCK_DIALOG_PATHS__?: string[] | null;
        __MOCK_FILE_TEXT__?: string | null;
        __MOCK_FILE_TEXTS__?: Record<string, string> | null;
        __MOCK_FILE_ERRORS__?: Record<string, string> | null;
      };
      w.__MOCK_DIALOG_PATHS__ = p as string[] | null;
      w.__MOCK_DIALOG_PATH__ = null;
      w.__MOCK_FILE_TEXTS__ = t as Record<string, string>;
      w.__MOCK_FILE_ERRORS__ = e as Record<string, string>;
      w.__MOCK_FILE_TEXT__ = null;
    },
    [paths, texts, errors] as unknown as [string[] | null, Record<string, string>, Record<string, string>],
  );
}
