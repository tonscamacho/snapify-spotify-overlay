# Bug report 2.5.0 — collapsed pane spill (Track B pilot)

## User images (as described in the pilot brief)

1. Narrow LYRICS strip, dark UI: the collapsed strip shows spill at top-right
   (header controls crowd the edge) with a progress thumb leaking past the
   collapsed header line.
2. Full-window dark UI: QUEUE and PLAYER panes spill body content past their
   collapsed headers instead of showing header-only rows.
3. Reference, light-pink Flume "Say it" compact player: overlapping circular
   art with prev / pause / next transport plus a progress bar. Target feel
   for the collapsed player: one compact row, no leak.
4. This pilot's own captures below stand in for the fourth image: before
   (spill reproduced) and after (header-only / 64px mini row).

## Pilot captures in this directory

- `collapsed-before-340.png`: collapsed PLAYER clips its own mini row
  (cover, title, pause disc cut) while collapsed QUEUE spills its full body
  ("Up next" plus all rows) despite `data-collapsed="true"`.
- `collapsed-before-360.png`: same pair at 360 px pane width.
- `collapsed-after-280.png`: PLAYER is a clean 64 px mini row, QUEUE and
  LYRICS are 36 px header-only strips.
- `collapsed-after-360.png`: same at 360 px.
- `collapsed-after-narrow.png`: 460 px stage, same result.

## Root cause (pilot finding)

Two independent CSS holders, both in `src/App.css`:

1. `.pane[data-pane="queue"] .pane-body` (`display: flex`, one scroller per
   pane) sits later in the file than `.pane[data-collapsed="true"] .pane-body`
   (`display: none`) at equal specificity, so the collapsed queue never hides
   its body. Fixed by scoping the collapse hide to
   `.pane[data-pane][data-collapsed="true"] .pane-body`, which outranks the
   queue rule at any order while the later player `display: block` override
   still wins for the collapsed player.
2. `.pane-title` (the `h2` in every pane header) kept its UA block margin
   (~18 px), inflating the collapsed player header to ~35 px. Inside the
   fixed 64 px box that left ~27 px for the 42 px mini row, so the mini row
   clipped. Fixed with `margin: 0` on `.pane-title`; header is now 24 px
   (collapse-button bound), body 38 px, box 64 px, mini row fully visible.

## Verify

- `npm run test --silent` → 218 passed.
- `npx playwright test verify/web/player.spec.ts verify/web/pane-edges.spec.ts`
  → 20 passed.
- `npx playwright test verify/web/queue.spec.ts verify/web/layout.spec.ts`
  → 24 passed (blast radius: every pane header moved ~9 px up).
- `npx playwright test verify/web/collapse-spill-repro.spec.ts` → 3 passed
  (280 px, 360 px, narrow stage; asserts box heights, body display,
  player-full hidden, mini-row visible).
- 240 px pane widths are unreachable by seed/resize: `coercePane` and the
  resize path floor at the per-type minimums (queue 260, player 280); the
  280 px run plus the narrow-stage run cover that path.
