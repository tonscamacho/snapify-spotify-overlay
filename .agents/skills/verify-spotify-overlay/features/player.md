# Player

Sub-features: cover/title/artist, progress with click-to-seek and countdown
remaining, play/pause disc, prev/next, shuffle, repeat off/context/track,
volume (slider commits the raw percent to the cloud API and drives the
overlay device gain through the native taper `(p/100)^2`, so 50 percent
sounds the same as the Spotify app; mute remembers the pre-mute level),
like heart reconciled
against the server on every track change (optimistic toggles roll back
on disagreement, in-flight guard stops double-click interleaves),
device panel (`details.device-panel` under the `Playback device`
group in Settings, summary reads `Sound plays on: <name>` with the
remembered note; one tap is the whole choice — the overlay row builds
the headless SDK player if needed and moves sound onto it, every other
row transfers straight to its id, no confirm buttons; the overlay
renders exactly once, stale same-named registrations collapse; arming
the SDK while another device plays never steals sound), remembered
destination (`snapify-device-choice`: `sdk` kind vs
concrete Connect id, restored as the panel selection on boot, never as
a silent transfer), tier chip (`Free`/`Premium`, upgrade blurb as
title; free accounts get an info-only `free-bar` with `GET PREMIUM`
instead of the seek slider), episode treatment (±15 s seek buttons, Resume chip
from the local per-episode store, honest speed control, show-notes link
in detail), throttled-write parking (coalesced pending queue, `Queued`
chip with count, single flush on cooldown, degraded pin to last-known
content with one degrade + one recovery note per episode).

How to get to it: player pane in every preset. Top-left in full and minimal.

Driving it: play a track in Spotify, watch the pane update within one poll
(5 s playing, 20 s paused, 30 s with no device; hidden tab skips polls
and refetches on return). Press the disc, skip, drag the bar, change volume, switch device.
Ctrl+Alt+P pauses over a fullscreen app (remappable, see shortcuts.md).
Tray left-click toggles interact/pass-through. See
`verify/web/player.spec.ts` (render, pause/play/next/progress, throttled
play chip + flush, single-tap overlay/device rows + memory, no confirm
buttons),
`verify/web/device-volume-parity.spec.ts` (arm-never-steals while
another device plays; 50 percent drives curved SDK gain 0.25 with a
matching API percent) and
`verify/web/playlist-play.spec.ts` (heart reconcile, episode resume chip
+ 15 s seek + notes + speed).

Gotchas: empty state reads "Nothing playing" on 204/404. Free accounts are
read-only; control calls fail with a toast (`account_error` drops the
tier to free without touching login). Volume commits on pointer
release / key-up / blur to avoid slider spam. The heart starts unliked until the server answers.
