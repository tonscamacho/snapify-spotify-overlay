# User image 2026-09-30-01 — player dead space (description stands in)

Original bytes not available in-chat; this description stands in per pilot brief.
No PNG was pasted, so no `user-2026-09-30-01-*.png` binary exists in this folder.

## What the screenshot shows

- The Player pane at a mid height (taller than its content needs, shorter
  than a full tall layout).
- Player content (cover art, transport, times, title/artist, volume) sits
  top-aligned in the pane body.
- A visibly empty band fills the bottom of the pane body below the volume
  row. No scroll, no clip, just unused space.

## Why it matters

The pane body is a block box and `.pane-fill` (`flex: 1`) is not a flex
item of it, so the fill wraps content height instead of stretching the
body. Leftover space pools at the bottom instead of centering the card.
Track A centers `.pane-fill` / `.player-full` / `.mini-row` with balanced
padding so top and bottom gaps agree within 8 px at every size.

## Pointers

- Card: `src/components/PlayerPane.tsx` (player-full / mini layout)
- Paint: `src/App.css` (`.pane-body` ~196, `.pane-fill` ~205,
  `.player-full` ~2828, `.mini-row` ~2382, art tiers ~2878+)
- Gate: `src/App.tsx` `renderPane` ~2201 (compact prop), drag floors ~2019
- Floors: `src/lib/layout.ts` (`PANE_MIN`, `COMPACT_PANE_MIN`,
  `clampPaneToArea`, `coercePane`, `getPaneMin`)
- Proof: `verify/web/player-center.spec.ts`,
  `docs/bug-reports/2.5.3/before-*.png` / `after-*.png`
