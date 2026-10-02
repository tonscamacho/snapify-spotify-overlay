# Appearance: surface + corners + light theme

Sub-features: Solid default (opaque, pixel-identical; `:root`
`--surface #17171a`, radii `--r-lg 14px` / `--r-md 10px` / `--r-sm 8px`).
Glass opt-in via `.app[data-surface="glass"]` (translucent
`--glass-regular` + `backdrop-filter` blur/saturate/brightness/contrast +
diagonal sheen `::before` on pane/dock/modal only). Corners opt-in via
`.app[data-corners="sharp"]` (zeroes `--r-lg/--r-md/--r-sm`; pill shapes
dock/chips/hint-chip keep literal `999px`). Light preset via
`.app[data-theme="light"]` (`--txt #1d1d1f`, `--dim`/`--faint` dark-on-light
for contrast) plus light+glass scrim (`--glass-regular
rgba(255,255,255,0.62)`) so dark text stays legible over any backdrop.
Sparkles lane (2.2, `8568b22`): `.app[data-theme="sparkles"]` starry
night-sky build, moonlit accents, seg `dark`/`light`/`sparkles`
(`SettingsModal.tsx:474-486`, hint "Night-sky build", covered
`verify/web/settings.spec.ts`:300-323 plus unknown-value coerce
:325). Pastel lane (2.3.0): `.app[data-theme="pastel"]` warm cream +
candy per-pane washes (player/lyrics/queue/visualizer each tinted,
`App.css:2071-2250`), seg gains `pastel`, hint "sleepy-cat"
(`SettingsModal.tsx:489-490`, covered `settings.spec.ts`:332-359).
Pastel+glass scrim: NOT landed on main — only light+glass has a scrim
rule (`App.css:2309-2320`); a pastel×glass rule is a 2.5.4 track hook,
drive with the light+glass steps once it exists (see
`features/theme-surface.md`). Accent color-picker: NOT landed — no
Color/Accent row exists in `SettingsModal.tsx`; hooks live in
`features/settings-color.md`, assert nothing until the owning track
lands it.

How to get to it (user POV): Settings > Surface seg `solid`/`glass`
(`aria-label="Surface"`), Settings > Corners seg `rounded`/`sharp`
(`aria-label="Corners"`), Settings > Theme seg `dark`/`light`/
`sparkles`/`pastel`
(`aria-label="Theme"`). Keys persist to localStorage `snapify-surface` /
`snapify-corners` / `snapify-theme` and to `.app` attributes
`data-surface` / `data-corners` / `data-theme`. The login gate card is a
`.pane`, so it reflects the surface choice before login.

Driving it: set Surface to glass, confirm
`.app[data-surface="glass"]` and `snapify-surface="glass"`; computed
`.pane` `backdrop-filter` contains `blur(16px)`, `saturate(175%)`,
`brightness(1.08)`, `contrast(1.04)`. Set Corners to sharp, confirm
`.app[data-corners="sharp"]` and computed `--r-lg: 0` while
`.dock`/`.chip` still compute `border-radius: 999px`. Set Theme to light,
confirm `.app[data-theme="light"]` and `snapify-theme="light"`, reload,
light persists. Set light + glass together, confirm the white-base scrim
rule applies. Drive sparkles/pastel like Theme above (seg select,
`.app[data-theme]`, `snapify-theme`, reload persist; see
`features/theme-surface.md`). Pastel+glass scrim and accent
color-picker have no rules on main — INCONCLUSIVE until the owning
track lands them, never FAIL. Non-goals unchanged: drag, 8-handle resize, presets
minimal/full/lyrics/spotlight, per-pane opacity slider (0.4-1.0), 5/20/30 s
poll, layout persistence.

Gotchas: there is no SVG displacement lens in this tree — no `lgDisp-*`
ids, no `url(#lg-lens-*)`, no `data-lens` hooks, no `--lg-spring-*`,
`--lg-glow`, `--near`, or `lg-edge-travel`. Do not claim Chromium lens or
Safari frost differences; glass is one `backdrop-filter` everywhere.
Toasts stay solid (`::before` is the status dot, no sheen). The window is
maximized and transparent so the game shows through; never apply a
window-wide Mica/Acrylic effect. `prefers-reduced-motion: reduce` disables
transitions globally; there are no `prefers-reduced-transparency` or
`prefers-contrast` carve-outs in this CSS. Motion is opacity and
background-color only, 120-160 ms.
