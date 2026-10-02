# Settings

Sub-features: tray menu (Show/Hide window, Interact/Pass through,
edit lock, preset, settings, quit; left-click toggles interact),
appearance (Theme dark/light persisted via `snapify-theme` assert
`.app[data-theme]`; Density compact/default/spacious via
`snapify-density` on each pane; Surface solid default / glass opt-in
via `snapify-surface` assert `.app[data-surface]`; Corners rounded
default / sharp opt-in via `snapify-corners` assert `.app[data-corners]`;
Preset minimal/full/lyrics/spotlight with preview-then-Apply/Revert;
UI scale 85-130% session slider with `aria-valuetext` percent, reported
regions re-align at every scale; per-pane opacity 0.4-1.0 in pane
headers), window rows (Show/Hide action button routing through
`toggle_visibility`, Edit lock, Interact/Pass through with the
pass-through hint), launch on login (autostart plugin, checkbox reflects
registry state, relaunch passes `--minimized` so boot starts hidden and
the tray restores it), click-through with taskbar refocus escape,
click-lyric-to-seek toggle, word karaoke toggle, lyric translation
(off/es/fr/de/pt/ja), lyrics display rows (text size 85–130% slider
with percent `aria-valuetext`, dyslexia-friendly checkbox), lyrics
cache row (`Lyrics cache: N tracks, K KB` with confirm-free Clear that
refreshes the size in place), Spotify usage row (`N total · N ok · N
on cooldown · N quota cooldown`, `No requests recorded yet.` when
empty, most-recent cooldown hint naming method/path/wait), Scene seg
(commits immediately, never a preview), Cycle preset row (names the
current chord, `Next preset` button), Auto-hide on pause (2.5 s hint)
plus Dim instead of hiding (disabled unless auto-hide is on), layout
reset, logout. Shell notes: a second launch
focuses the live window instead of exiting (show + unminimize, and
visibility toggles never steal focus); `capabilities/default.json`
scopes `windows ["main"]` with hide/show, autostart, global-shortcut,
updater, opener, and process rights. Shortcuts live in their own
[shortcuts](shortcuts.md) map.

How to get to it: gear button in the top bar (`Open settings`), or tray
> Settings. Appearance rows are `role="group"` named Theme, Density,
Surface (`solid`/`glass`), Corners (`rounded`/`sharp`), Preset
(`minimal`/`full`/`lyrics`/`spotlight`). Surface/Corners/Theme persist
to localStorage keys `snapify-surface` / `snapify-corners` /
`snapify-theme` and to `.app` data attributes `data-surface` /
`data-corners` / `data-theme`.

Driving it: open Settings, switch Theme dark to light, confirm
`.app[data-theme="light"]` and `localStorage snapify-theme="light"`,
reload, light persists (see `verify/web/settings.spec.ts`). Switch
Surface solid to glass, confirm `.app[data-surface="glass"]` and
`snapify-surface="glass"`; switch back, solid is pixel-identical
default. Switch Corners rounded to sharp, confirm
`.app[data-corners="sharp"]` zeroes `--r-lg/--r-md/--r-sm` while dock
chips stay `999px`; switch back. Toggle launch on login, confirm
`HKCU:\Software\Microsoft\Windows\CurrentVersion\Run` gains and loses the
app value. Pick a preset, confirm the Previewing row with Apply/Revert
appears and nothing persists until Apply (see `features/layout.md`).
Move UI scale to 130%, confirm `aria-valuetext` reads `130 percent` and
reported regions still align with the panes (see
`verify/web/overlay-passthrough.spec.ts`); scale is session-only.
Press Hide, the window hides through `toggle_visibility`; press Show, it
returns without stealing focus, and no direct hide/show invoke fires.
Enable click-through, confirm mouse passes below, refocus from
the taskbar and press Esc to exit. Quit from the tray, confirm the process
ends.

Gotchas: focused shortcuts (preset cycle, legacy toggle) need focus; see
[shortcuts](shortcuts.md) for the editable chords. Global registration can
fail if another app owns the chord; the backend logs and continues. No
custom tray art yet; default app icon is used. Sparkles theme: LANDED in
2.2 (`8568b22` — Theme seg is dark/light/sparkles, plus pastel in 2.3.0;
surface `src/App.tsx:301` + `SettingsModal.tsx:474-486` + `App.css:1861`;
covered in `verify/web/settings.spec.ts`: "sparkles theme selectable,
persisted, and coherent" (seg select, `.app[data-theme]` assert,
`snapify-theme` key, reload persist, `sparkles-settings.png` /
`sparkles-pane.png` screenshots) plus the unknown-value coerce test
(bogus stored value falls back to dark). Drive new theme lanes like
Theme above. Solid + rounded is the
default and stays pixel-identical; glass only restyles
pane/dock/modal (toasts stay solid). Light + glass uses an opaque white
scrim (`rgba(255,255,255,0.62)`) so dark text `#1d1d1f` stays legible over
any backdrop. Theme also reads legacy `nebula-theme="light"` once, then
 writes `snapify-theme`.

Color row (2.5.4 — NOT landed on main): no Color/Accent row exists in
`SettingsModal.tsx` (rows are Theme, Density, Surface, Corners,
Preset, Scene). Do not assert any accent key, swatch, or
`data-accent` hook until the owning track lands it; `drive.ps1`
reports the lane INCONCLUSIVE, never FAIL. Driver hooks, intended
selectors, and persist-key conventions live in
[settings-color](settings-color.md) — that file is a map, not a spec.
