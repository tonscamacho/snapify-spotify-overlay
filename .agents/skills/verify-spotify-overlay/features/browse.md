# Browse

Sub-features: library section select (always present `Library section`
select driving the seven lib tabs: playlists/albums/tracks/artists/
shows/episodes/audiobooks), search with local recents (last 8 in
`snapify-search-recents`, clearable) and sentinel paging past the first
window, playlist detail (empty hides Play and says no tracks, populated
plays its context, follow toggles optimistically, track rows open
detail where Save reconciles against the server), artist detail with
top songs backfilled from search and marked as the source, episode
detail with a show-notes link plus resume chip, ±15 s seek, notes, and
honest speed, truthful walls for others' playlists (Play kept on
metadata-only detail, no fake controls; single 403 recovers the track
list on Retry, persistent 403 keeps the wall with Play + Retry + Open
in Spotify; alternate embed source behind the `SNAPIFY_EMBED_FALLBACK`
kill-switch — double-403 gate, ≤50 tracks with a truncation note,
`embed:`-namespaced cache, no bearer token sent, and ANY failure
returns the original 403 so the wall above stands; see the embed block
in `src-tauri/src/spotify.rs` and
`docs/plans/friend-playlist-tracks-patch.md`), throttled lists (capped notice
plus retry, terminal errors re-arm on manual retry), scope honesty (a
403 names the missing permission and the toast offers Reconnect).

How to get to it: browse pane, the dock Browse chip, queue context
(`Next from:`), or the queue empty-state Browse button (non-destructive,
see `features/layout.md`).

Driving it: search, recents record locally and page two fires at offset
10. Open an artist, top songs backfill with the source marked. Open an
episode, show-notes link, resume chip, ±15 s, and speed all respond.
Follow a playlist, the toggle flips at once and reconciles. Throttle a
list, the capped note shows with retry. Fail `get_playlist_items` once
with 403 on a walled playlist, the wall shows then Retry renders the
tracks with Play intact; fail it always and the wall keeps Play (header
+ wall), Retry, and Open in Spotify with no invented rows. Production also tries the embed
alternate source after a double 403 when the kill-switch allows it; the
mocked suite pins the wall contract (the Tauri stub has no embed seam,
so flag-OFF-equivalent behavior is what the specs drive). See
`verify/web/playlist-play.spec.ts` (10 tests: playlists, search,
backfill, episodes, heart) and `verify/web/walled-tracks.spec.ts`
(3 tests: 403-then-retry tracks, persistent-403 wall, owned path).

Gotchas: search never invents top tracks — without search-derived data
the strip stays honestly empty. Cursor paging adapts (offset numbers,
keyset strings) through one shared hook. Detail lists render in 20-item
windows behind the sentinel.
