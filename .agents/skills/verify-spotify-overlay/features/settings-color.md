# Settings color row (map, not spec)

This file is a driver map for the 2.5.4 color track. The owning track
writes the spec; this file only reserves the hooks. NOTHING in this
file is landed on main: there is no Color/Accent row in
`src/components/SettingsModal.tsx` (rows are Theme, Density,
Surface, Corners, Preset, Scene), no `snapify-accent` (or similar)
key is read or written anywhere in `src/`, and no `data-accent`
(or similar) hook reaches `.app` or the built CSS/JS. Until the track
lands, assert nothing — `drive.ps1` reports this lane INCONCLUSIVE,
never FAIL.

Sub-features (intended, all TBD by the owning track): accent
color-picker row in Settings, accent wash on player accents
(play-disc / primary buttons / progress fill), persist + reload,
unknown-value coerce (follow the sparkles/pastel pattern:
bogus stored value falls back to dark, see
`verify/web/settings.spec.ts`:325,357).

How to get to it (user POV): TBD — expected Settings > Color (or
Accent) row. If the track names it otherwise, update this map first
(structure encodes the lesson: map before spec).

Driving it (template for the owning spec, mirror the pastel spec at
`verify/web/settings.spec.ts`:332-355): open Settings, pick a color,
confirm the hook attribute on `.app` and the persist key in
localStorage, screenshot `*-settings.png`, close, screenshot
`*-pane.png`, reload, color persists. Coerce test: store a bogus
value, reload, confirm fallback. Screenshots go to
`verify/web/test-results/` (git-ignored, per-run only).

Selectors (intended, confirm on landing): settings group by
`role="group"` named Color (or Accent — whichever the track ships;
`getByRole(name)` is substring matching, so scope to the group and
use `exact: true`). Persist keys: TBD — expected `snapify-accent`;
do NOT assert any key name until the track writes it in `src/App.tsx
and it appears in the built JS the way `snapify-surface` /
`snapify-corners` / `snapify-theme` do today (see `drive.ps1` built-JS
block).

Reduced-motion notes: accent changes must stay inside the theme
motion budget — opacity and background-color only, 120-160 ms;
`prefers-reduced-motion: reduce` already kills transitions globally
(`App.css:2322-2331`), so no new carve-outs should be needed. If the
track adds animation, it must add the matching reduce kill next to
the marquee one.

Gotchas: keep solid + rounded pixel-identical default; accent only
restyles the same surfaces glass touches (pane/dock/modal), toasts
stay solid. Never invent a `prefers-reduced-transparency` carve-out;
none exists in this CSS.
