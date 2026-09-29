# Sketch B — "Flume Disc" (overlapping art + transport cluster)

Reading this as: operate-mode app UI with a premium-consumer accent for
the mini moment, leaning toward the light-pink Flume "Say it" reference
(overlapping circular art, transport as one cluster, progress as a thin
under-bar), built with native CSS grid + negative-margin overlap.

Dials: `DESIGN_VARIANCE: 7 / MOTION_INTENSITY: 3 / VISUAL_DENSITY: 5`.
Higher variance (deliberate overlap breaks the grid), near-static motion
(art crossfade on track change only, opacity 160ms, killed under
reduced-motion), balanced density (art earns size by eating gaps, not
by adding chrome).

## Structure (distinct from A: overlap, not separation)

Mini = two-layer cluster. The circular art OVERLAPS the transport row
by −10px and the play-disc is visually anchored to the art edge,
echoing the Flume reference where cover + prev/pause/next read as one
object:

```
+--------------------------------------------------+
|  (art 44px circle, -10px overlap into cluster)   |
|  [art] title / artist   (prev [play] next)       |
|        progress 3px under meta+transport         |
+--------------------------------------------------+
```

- Grid: `art | meta | transport`, but art has `margin-right: -10px`
  and `z-index: 1` with a 2px surface-color ring (`box-shadow: 0 0 0
  2px var(--surface)`) so the overlap reads as intentional layering,
  not collision. Transport cluster gets `background: color-mix(in srgb,
  var(--surface-2) 70%, transparent)` pill (`border-radius: 999px`,
  padding 2px 6px) so prev/next dock against the disc.
- Progress is a 3px bar under meta+transport (grid row 2, columns
  2–3), NOT full-bleed — structurally distinct from A's full-bleed
  hairline and the reason B can afford 44px art in the same 72px.
- Full player diverges from A too: at `roomy` (≥480px) it goes
  SIDE-BY-SIDE (art left 40%, meta+transport right) instead of
  stacked, so large sizes feel composed rather than stretched.

## Tokens (fluid, container-relative)

```css
/* Mini disc — scoped: .pane[data-pane="player"] .mini-row[data-variant="disc"] */
.mini-row[data-variant="disc"] {
  --disc-art: clamp(36px, 16cqw, 44px);
  --disc-play: clamp(30px, 12cqw, 34px);
  --disc-nav: clamp(26px, 10cqw, 30px);
  --disc-title: clamp(12.5px, 5.2cqw, 15px);
  --disc-artist: clamp(10.5px, 4.2cqw, 12px);
  --disc-gap: clamp(4px, 2.5cqw, 8px);

  display: grid;
  grid-template-columns: var(--disc-art) minmax(0, 1fr) auto;
  grid-template-rows: 1fr 3px;
  grid-template-areas: "art meta transport" ". progress progress";
  column-gap: var(--disc-gap);
  row-gap: 3px;
  padding: 5px 10px 5px 8px;
  overflow: hidden;
  min-width: 0;
}
.mini-row[data-variant="disc"] .mini-cover {
  grid-area: art; width: var(--disc-art); height: var(--disc-art);
  border-radius: 50%; align-self: center; z-index: 1;
  margin-right: -10px;
  box-shadow: 0 0 0 2px var(--surface), 0 2px 8px rgba(0,0,0,.35);
}
.mini-row[data-variant="disc"] .mini-transport {
  grid-area: transport; align-self: center;
  background: color-mix(in srgb, var(--surface-2) 70%, transparent);
  border: 1px solid var(--stroke-soft);
  border-radius: 999px; padding: 2px 6px; gap: 0;
}
.mini-row[data-variant="disc"] .mini-play {
  width: var(--disc-play); height: var(--disc-play); margin: 0 2px;
}
.mini-row[data-variant="disc"] .mini-progress {
  grid-area: progress; height: 3px;
}
@media (prefers-reduced-motion: reduce) {
  .mini-row[data-variant="disc"] .mini-cover { transition: none; }
}
```

Art sizes per tier: mini (≤282) 36–40px, tight via `16cqw` up to
44px cap; overlap (−10px) refunds horizontal space so meta keeps
~90px even at 200px pane width. Row math: 5 + 44 + 3 + 3 + 5 = 60px
content + header ≈ 26px → 68px box; the 44px cap is the ceiling that
keeps the ≤72px contract with 4px margin.

Spacing scale: 0 (transport internals) / 2 (pill pad) / 4–8 (gap) /
8–10 (pad) / 3 (progress). Radius rule: circles + one pill per row
(documented exception to the shape lock: "transport docks as a pill,
everything else circular/flat").

## Full-player scale-up (side-by-side at roomy)

```css
@container (min-width: 480px) {
  .player-card[data-variant="disc"] {
    display: grid;
    grid-template-columns: minmax(140px, 40%) minmax(0, 1fr);
    grid-template-areas: "art rest";
    gap: clamp(10px, 3cqw, 20px);
    align-items: center;
  }
}
@container (max-width: 479px) {
  .player-card[data-variant="disc"] { display: flex; flex-direction: column; }
}
```

Art `clamp(140px, 38cqw, 260px)`, title `clamp(15px,4.5cqw,22px)`,
transport `clamp(36px,9cqw,52px)`. Below 480px it collapses to the
current stacked column — one explicit mobile fallback per layout
family, no Tailwind-handles-it assumptions.

## Theme

- Dark glass: the transport pill uses the glass stroke
  (`border-color: var(--lg-stroke)`) under `data-surface="glass"` so
  the cluster reads as frosted; solid fallback is the surface-2 pill.
- Light Flume echo (the brief's explicit ask): the mini row gets the
  blush treatment — pane wash `#fceef1` (reuse pastel player wash),
  art ring in surface color, progress rose `#c4748c`, play-disc cocoa
  `#4a3c2e` with cream glyph `#fff9ef`. Dark keeps signal green; ONE
  accent per theme, locked.

## TSX diff (additive, both branches render, CSS picks)

```tsx
// PlayerPane.tsx: thread an optional variant, default "rail":
interface Props { ... variant?: "rail" | "disc"; }
<div className="player-full player-card" data-variant={p.variant ?? "rail"} ...>
<div className="mini-row" data-variant={p.variant ?? "rail"} ...>
```

App passes `variant` from a persisted setting (default `"rail"` so
current behavior is unchanged until the user opts in). Collapsed
still renders no mini; single-resolution and `compact` gate untouched.

## Strengths / risks

+ Flume echo is explicit (overlap + pill cluster + blush), large
  sizes get a composed side-by-side instead of a stretched stack.
− Overlap costs verification: the −10px margin + ring must be
  asserted at 200px width (narrowest compact floor) for zero-spill;
  `color-mix` needs a fallback (`background: var(--surface-2)`) for
  older WebViews. Higher variance = higher review bar.
