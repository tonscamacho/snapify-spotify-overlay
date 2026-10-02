# Theme + surface (map, not spec)

This file is a driver map for 2.5.4 tracks A/B/C. The owning track
writes the spec; this file only says where to drive and what good
looks like. Anything marked NOT landed must stay INCONCLUSIVE in
`drive.ps1`, never FAIL.

Sub-features (landed): Theme seg `dark`/`light`/`sparkles`/`pastel`
(`src/components/SettingsModal.tsx:472-490`, `role="group"`
`aria-label="Theme"`, per-lane hint rows — "Night-sky build" for
sparkles, "sleepy-cat" for pastel). Surface seg `solid`/`glass`
(`SettingsModal.tsx:508-522`, `aria-label="Surface"`). Corners seg
`rounded`/`sharp` (`SettingsModal.tsx:523-535`,
`aria-label="Corners"`). State lives in `src/App.tsx:301-305`
(`"dark" | "light" | "sparkles" | "pastel"`, reads `snapify-theme`,
reads legacy `nebula-theme="light"` once, unknown values coerce to
dark), renders as `.app` attributes (`App.tsx:2433` `data-theme`;
surface `snapify-surface` `App.tsx:320` → `data-surface`; corners
`snapify-corners` `App.tsx:327` → `data-corners`), writes go through
`App.tsx:2666` (`localStorage.setItem("snapify-theme", v)`).

Sub-features (NOT landed): pastel+glass scrim. Only light+glass has a
scrim rule (`src/App.css:2309-2320`, `--glass-regular
rgba(255,255,255,0.62)`). There is no
`.app[data-theme="pastel"][data-surface="glass"]` rule on main.

How to get to it (user POV): Settings > Theme / Surface / Corners
segs. Login gate card is a `.pane`, so it reflects surface choice
before login.

Driving it: set each Theme lane, confirm `.app[data-theme="<lane>"]`
and `localStorage snapify-theme="<lane>"`, reload, lane persists —
the exact pattern is already locked in `verify/web/settings.spec.ts`
(sparkles :300-323 with `sparkles-settings.png` /
`sparkles-pane.png`; unknown-value coerce :325; pastel :332-355 with
`pastel-settings.png` / `pastel-pane.png`; unknown-value coerce
:357). Drive a pastel+glass spec the same way once the rule lands:
set pastel + glass together, confirm the scrim rule applies and dark
text stays legible (mirror the light+glass steps in
`features/liquid-glass.md`). Surface/corners steps are unchanged
(see `features/liquid-glass.md`).

Selectors: `.app` (`page.locator(".app")`), Theme group
(`dialog.getByRole("group", { name: "Theme" })`, lane buttons by
`exact: true` name — "Player" collides with "Play" under substring
matching, so scope to the group). Persist keys: `snapify-theme`,
`snapify-surface`, `snapify-corners` (plus one-time legacy read of
`nebula-theme`).

Reduced-motion notes: `prefers-reduced-motion: reduce` kills
transitions globally (`App.css:2322-2331`); there are no
`prefers-reduced-transparency` or `prefers-contrast` carve-outs.
Theme switches are opacity/background-color only, 120-160 ms.

Gotchas: solid + rounded is the pixel-identical default; glass only
restyles pane/dock/modal, toasts stay solid. No SVG lens anywhere
(see `features/liquid-glass.md` gotchas).
