# Mini player + title marquee + volume (map, not spec)

This file is a driver map for the 2.5.4 mini track. The owning track
writes the spec; this file only says where to drive and what good
looks like. Mini/compact/collapse/volume/marquee all exist on main;
the map pins their current drivers so the track spec asserts real
selectors, not invented ones.

Sub-features: compact mini card (player pane renders the mini card in
DOM when expanded but below the compact gate — `src/App.tsx:2311-2316`,
`compact={!pane.collapsed && (pane.w < COMPACT_W || pane.h <=
PLAYER_FULL_H)}`; covered `verify/web/compact-player.spec.ts`).
Per-pane collapse (header-only strips, `pane.collapsed === true`,
`data-collapsed="true"`, `.collapse-btn` with
`aria-label="Collapse <Pane> pane"` / `"Expand <Pane> pane"` and
`aria-expanded`, `src/App.tsx:1724-1748,2235-2277`; collapse persists
with the layout store, see `features/layout.md`; covered
`verify/web/collapse-spill-repro.spec.ts`). Hover title marquee
(`.track-title.is-marquee` + `.marquee-inner` + `--marquee-dist`
overflow width, `title-marquee` 6s linear infinite alternate,
`src/App.css:597-617`; JS adds `.is-marquee` only while the pointer
hovers an overflowing title, short titles never animate). Volume
slider (`.volume-row .vol`, `App.css:629-641`) driving device gain
with the 50%-parity curve (covered `verify/web/volume.spec.ts` +
`verify/web/device-volume-parity.spec.ts`); mute chord toggles
0/restore (covered `verify/web/settings.spec.ts`:83); mini progress
fill (`.mini-progress i`, per-theme rules alongside `.bar i`).

How to get to it (user POV): shrink the player pane to hit the
compact gate (mini card appears, no clip); press the pane-header
`▾` (collapse to header-only, `▸` expands); hover a long track
title (marquee scrolls); drag the volume slider or press the mute
chord.

Driving it: resize player below the gate, confirm the mini card
shows while collapsed stays header-only with no mini (see
`compact-player.spec.ts` + `collapse-spill-repro.spec.ts`
patterns). Hover an overflowing title, confirm `.is-marquee` +
`--marquee-dist` > 0 and the inner animates; hover a short title,
confirm no `.is-marquee`. Drag volume, confirm device gain follows
the parity curve; mute chord → 0, again → restore
(`settings.spec.ts`:83 pattern). Screenshots to
`verify/web/test-results/` (git-ignored).

Selectors: `.pane[data-pane="player"]`, `.collapse-btn`
(`aria-label` Collapse/Expand, `aria-expanded`),
`[data-collapsed="true"]`, `.mini-progress`, `.volume-row .vol`,
`.track-title` / `.track-title.is-marquee .marquee-inner`.
Persist keys: NONE for volume — volume is device/session state
(seeds from `snap.volume ?? 50`, `App.tsx:1340,1443-1462`), no
`snapify-*` key exists, so never assert one. Collapse persists via
the layout store (`togglePaneCollapsed`, `App.tsx:1728-1748`;
see `features/layout.md`).

Reduced-motion notes: `prefers-reduced-motion: reduce` sets
`.track-title.is-marquee .marquee-inner { animation: none }` —
marquee degrades to a plain ellipsis (`App.css:2322-2331`). A mini
spec must assert the still frame under reduced motion, not the
scroll. Collapse/mini have no motion beyond the global
opacity/background-color budget (120-160 ms).

Gotchas: mini progress and bar fills are per-theme (`light`
`App.css:1771-1778`, sparkles `:1938-1945`, pastel `:2122-2129`) —
a volume/mini spec that only checks dark will miss theme regressions.
`getByRole(name)` substring rule applies: scope pane queries to
`section[data-pane="..."]`.
