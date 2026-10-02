# Lyrics

Sub-features: synced highlight with auto-scroll, click line to seek,
per-track offset calibration (±500 ms stepper to ±5000 ms, persisted in
`snapify-lyrics-offset-v1` and mirrored into the Rust cache entry's
`user_offset_ms`, invalidated on duration change), true word timing
where the provider ships it with word-by-word karaoke highlight and
linear interpolation fallback, translation batches over the visible
window (off/es/fr/de/pt/ja via free-service autodetect, cached per
line, `lang` tags, stale lines replaced on track change, silent
offline), romaji under kana lines (pure local map, tagged latin
Japanese), plain-only static view, instrumental state, no-match state
with retry, 500-track LRU file cache with 24 h negative TTL (positive
entries 30 d, TTL-expired entries still donate their calibration).
Synced view stacks a Meta row (`Synced`, `· Cached` when served from
cache), the `Lyric sync calibration` stepper (`Sync ±N ms` live plus
−500/+500 ms and Reset), line buttons (active/past/gap rows carrying
karaoke words, romaji, and translation rows), and a `Lyrics provided
by LRCLIB` footer. Off-synced states: idle (`Lyrics wait for music` +
Retry), loading (`Finding lyrics` skeletons), error (`No synced
lyrics` + message + Retry), instrumental (`Instrumental` / `No words
in this one.`), plain (`Unsynced` meta with the static text).

How to get to it: lyrics pane, or the lyrics preset (large lyrics plus
compact player).

Driving it: play a known-synced track, the active line highlights within
about 500 ms of the vocal. Click a line, playback jumps there. Nudge
+500 ms, the active line shifts and survives reload. Switch translation
to Spanish, visible lines gain `ES:` batches with lang tags; change
track, no stale lines remain. Test one track per fallback: plain-only,
instrumental, unknown. See `verify/web/lyrics.spec.ts` (highlight,
click-to-seek, offset persist, word highlight vs interpolation,
translation batching + replacement, romaji).

Gotchas: LRCLIB needs title/artist/album/duration; remixes miss without the
album. Drift over ~750 ms snaps instead of slewing. Cache serves offline
with a Cached badge. Word spans render only in a ~61-row window around
the active cue, so long tracks stay cheap on each tick. The Rust cache
entry already carries the same offset field, but its setter IPC is still
landing — treat the local per-track calibration as the source of truth.
