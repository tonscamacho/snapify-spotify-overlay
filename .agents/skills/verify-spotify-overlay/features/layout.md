# Layout

Sub-features: locked mode by default, edit mode via top bar / tray /
interact chord (default Shift+Tab, remappable), header drag, 8 px magnet
snap to edges and panes (`SNAP_EDGE=8`, center/thirds zone `SNAP_ZONE=16`),
Shift bypass, corner resize (8 handles, keyboard-operable sliders),
presets minimal/full/lyrics/spotlight with preview-then-Apply/Revert,
layout undo (depth 20 via `LAYOUT_UNDO_DEPTH`, `Ctrl+Z` in edit mode,
dock Undo button), non-destructive queue Browse reveal
(`queueBrowseCb` flips/adds browse only), labeled wrapping dock
(`flex-wrap`, icon + text labels), hide/show action controls (button
names the action, all paths route through `toggle_visibility`),
first-run coach pill (`snapify-coach-dismissed`, clickable only in
interactive mode), toggle-off-then-on restores geometry, custom autosave
on toggle (`preset="custom"`), persistence in localStorage key
`snapify-layout-v3` (legacy `snapify-layout-v2`, `nebula-layout-v1`
fallback, corrupt entries coerced, boot clamped to the live window).

How to get to it: unlock with the top-bar lock button. Drag any pane
header. Cycle presets with the focused chord (default Ctrl+Alt+L,
remappable), the dock Cycle preset button, Settings > Preset seg
(`minimal`/`full`/`lyrics`/`spotlight`), or the tray menu. Selecting a
preset in Settings only previews it: Apply keeps the preview (the
pre-preview base becomes one undo step), Revert — or closing Settings —
restores the untouched arrangement. Undo with `Ctrl+Z` in edit mode or
the dock Undo button (disabled when the stack is empty).

Driving it: drag the player across the queue pane, guides snap at edges.
Toggle queue off and on from the dock chip, geometry returns. Empty
queue > Browse reveals browse without touching other panes (undoable,
saved as `custom`). Restart the app, geometry restores from
`snapify-layout-v3`. Settings > Layout > Reset returns to the preset
default. See `verify/web/layout.spec.ts`: cycle swaps the pane set, chip
toggles queue with `aria-pressed`, select previews without persisting
until Apply, close-without-Apply restores the base, `Ctrl+Z` pops the
last geometry change, dock wraps at 800 px with labeled distinct
controls, coach pill shows the keys then dismisses forever,
Alt+Arrows moves / Alt+Shift+Arrows resizes with guide flash and undo,
resize handles are labeled valued sliders with a focus ring.

Gotchas: snap uses stage pixels; UI zoom scales visuals only and
reported regions re-align at 130% (see
`verify/web/overlay-passthrough.spec.ts`). Minimum pane size is per-type
(player 280x190, lyrics 280x200, queue 260x180, visualizer 260x170,
browse 300x340) with a 240x120 global floor; opacity 0.4-1.0 persists
per pane. Keyboard geometry steps 8 px per press; the first Alt+Arrow in
a burst snapshots for undo, repeats within a second coalesce. The dock
and Settings hide/show buttons name the action (`Hide` while visible,
`Show` while hidden) and route through `toggle_visibility` like the tray
and the global chord — the frontend never calls hide/show directly, so
truth lives in Rust (`overlay-visibility-changed` settles the UI). The
coach pill is display-only over empty stage (clicks there still reach
the game) and resolves to a click region only in interactive mode —
passive mode is unaffected because Rust ignores regions unless
interactive.
