# Sketch A — "Rail" (strict 3-zone row)

Reading this as: operate-mode app UI for gamers/streamers, with a quiet
Apple-solid language, leaning toward native CSS + container queries +
single-accent tokens. No new deps, no motion beyond opacity.

Dials: `DESIGN_VARIANCE: 4 / MOTION_INTENSITY: 2 / VISUAL_DENSITY: 6`.
Low variance (strict grid, no overlap), static motion (progress fill is
instant state), cockpit-leaning density (every px earns its place ≤72px).

## Structure (distinct from B: separation, not overlap)

Mini = CSS grid, three sealed zones, progress as a bottom hairline
spanning the full row width (not inside the meta column):

```
+--------------------------------------------------+
| art  | title / artist            | prev play next |
| 40px | flex:1, minmax(0,1fr)     | auto           |
+--------------------------------------------------+
| progress hairline 3px, full-bleed, row bottom    |
+--------------------------------------------------+
```

- Art is flush-left, vertically centered, never overlapping text or
  buttons. Transport is flush-right, fixed `flex:none`.
- Title/artist stack is the ONLY flexible zone (`min-width:0` +
  ellipsis). Narrowing the pane steals from text first, never from
  art or buttons — this is the zero-spill guarantee by construction.
- Full player is unchanged in structure (art-top stacked → times-flank
  → meta → volume) so mini/full share zero layout code paths.

## Tokens (fluid, container-relative)

```css
/* Mini rail — scoped: .pane[data-pane="player"] .mini-row[data-variant="rail"] */
.mini-row[data-variant="rail"] {
  --rail-art: clamp(32px, 14cqw, 40px);
  --rail-play: clamp(30px, 12cqw, 36px);
  --rail-nav: clamp(28px, 11cqw, 32px);
  --rail-title: clamp(12.5px, 5cqw, 15px);
  --rail-artist: clamp(10.5px, 4cqw, 12px);
  --rail-gap: clamp(6px, 3cqw, 10px);
  --rail-pad-x: clamp(8px, 4cqw, 12px);

  display: grid;
  grid-template-columns: var(--rail-art) minmax(0, 1fr) auto;
  grid-template-rows: 1fr 3px;
  grid-template-areas: "art meta transport" "progress progress progress";
  column-gap: var(--rail-gap);
  row-gap: 3px;
  padding: 6px var(--rail-pad-x) 5px;
  overflow: hidden;
  min-width: 0;
}
.mini-row[data-variant="rail"] .mini-cover {
  grid-area: art; width: var(--rail-art); height: var(--rail-art);
  border-radius: 50%; align-self: center;
}
.mini-row[data-variant="rail"] .mini-meta {
  grid-area: meta; min-width: 0; justify-content: center;
}
.mini-row[data-variant="rail"] .mini-title {
  font-size: var(--rail-title);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mini-row[data-variant="rail"] .mini-artist {
  font-size: var(--rail-artist);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mini-row[data-variant="rail"] .mini-transport {
  grid-area: transport; gap: 2px;
}
.mini-row[data-variant="rail"] .mini-progress {
  grid-area: progress; height: 3px;
}
```

Art sizes per tier: mini (≤282) 32–36px, tight (283–359) 36px,
comfortable+ (mini never renders; full-player art `min(52%,148px)`).
Row math at worst case: 6 + 40 + 3 + 3 + 5 = 57px content + header
≈ 26px → 68px card box under the 72px ceiling; at 32px art the row
drops to ~60px total, leaving headroom for 1.30 uiScale.

Spacing scale: 2 / 4 / 6–10 (gap) / 8–12 (pad-x) / 3 (progress).
Type: title `clamp(12.5px,5cqw,15px)` 600 −0.02em; artist
`clamp(10.5px,4cqw,12px)` dim.

## Full-player scale-up (large sizes, no overflow)

```css
.player-card {
  --art-w: clamp(120px, 46cqw, 220px);
  --title-lg: clamp(15px, 4.5cqw, 20px);
  --transport-lg: clamp(36px, 10cqw, 48px);
}
.art-top.art-compact { width: min(var(--art-w), 52%); margin: 10px auto 0; }
@container (min-width: 480px) {
  .track-title { font-size: var(--title-lg); }
  .art-overlay .play-disc { width: var(--transport-lg); height: var(--transport-lg); }
}
```

Art, type, transport grow with the container; meta keeps
`min-width:0` + ellipsis so nothing overflows at 1280px.

## Theme

- Dark solid/glass: untouched tokens (`--surface` #17171a, signal
  #1ed760). Glass sheen `::before` stays behind content; rail grid
  adds no new stacking context.
- Light (Flume echo): blush-tinted wash scoped to the player pane
  only — `background: #fdf1f3` surface, `#1d1d1f` text, rose progress
  `#c4748c`, cocoa play-disc `#4a3c2e` (mirrors the existing pastel
  preset's player wash so the echo is consistent, not a second pink).

## TSX diff (minimal, additive)

```tsx
// PlayerPane.tsx mini block only:
<div className="mini-row" data-variant="rail" ...>
```

No logic change; the `compact` gate, collapsed exclusion, and
single-resolution rule are untouched. `:has(.mini-row)` hide rule
keeps working (attribute selector needs no update).

## Strengths / risks

+ Zero-spill by construction (one flexible zone). Trivial to verify
  against `compact-player.spec.ts` (row ≤72, scroll ≤ client+1).
+ Cheapest diff; no a11y tree change.
− Visually conservative; the Flume overlapping-art charm is absent
  (that is Sketch B's job).
