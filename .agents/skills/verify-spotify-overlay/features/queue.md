# Queue

Sub-features: upcoming rows with refresh, virtualized list
(`data-virtualized`, measured row height, overscan so fast scrolls never
flash blank), rows as buttons (Enter or click plays the row now),
playlist context (`Next from:` opens the source in browse, keyboard and
pointer, without losing the context), empty state with Refresh plus a
non-destructive Browse reveal, throttled states (`Queued` chip with
count parks coalesced writes until the cooldown flush fires each once;
`capped` pins the list to the first 10 with an honest note while the
full queue is throttled). The matching request counts live in the
`Spotify usage` row (see [settings](settings.md)).

How to get to it: queue pane in full/spotlight presets, or the dock
Queue chip. Context appears above the list when Spotify reports one.

Driving it: play a queue, rows render and Refresh re-queries. Scroll a
25-item queue to the last row, windowing holds. Focus a row, press
Enter, that URI plays now. Open the context, browse lands on the source
playlist. Force a 429 on a queue write, the chip shows the count, then
one flush sends it once (queue and browse agree). See
`verify/web/queue.spec.ts` and `verify/web/queue-context.spec.ts`.

Gotchas: a fresh short queue rewinds to the top. Track change refetches
the queue only while the queue pane is live. While degraded, the list
pins to the surviving 10 instead of emptying — one info note per
episode, never per retry.
