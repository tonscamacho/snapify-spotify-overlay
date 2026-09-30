# Synthesis — ship A as base, graft B's Flume accents (2.5.2 proposal)

Design read (locked): operate-mode overlay UI, quiet Apple-solid by
default, Flume blush echo in light. One accent per theme, motion =
opacity only 120–160ms.

## Decision

- **Base: Sketch A (Rail).** Zero-spill by construction (single
  flexible zone), cheapest diff (one `data-variant` attribute, no
  logic change), lowest verification risk against
  `verify/web/compact-player.spec.ts` (row ≤72, scroll ≤ client+1,
  single Play/Pause resolution, collapsed header-only).
- **Graft from B (Flume Disc):**
  1. Light-theme blush wash on the mini row (pane `#fceef1`, progress
     rose `#c4748c`, play-disc cocoa `#4a3c2e`) — the brief's explicit
     Flume echo, theme-scoped so dark stays signal-green solid/glass.
  2. `color-mix` pill treatment for transport ONLY as an opt-in
     `data-variant="disc"` (persisted setting, default `"rail"`), so
     the overlap risk ships behind a flag and the default path stays
     provably spill-free.
  3. Side-by-side full-player grid at `roomy` (≥480px) from B, gated
     behind the same variant flag (A keeps stacked; no behavior change
     until opted in).
- **Rejected from B for default path:** the −10px art overlap (costs a
  200px-floor spill proof for the default; keep it in the variant),
  `color-mix` without fallback (fallback `background: var(--surface-2)`
  required for older WebViews).

## Final token table (what 2.5.2 implements)

| Token | Mini default (rail) | Disc variant | Full player ≥480 |
|---|---|---|---|
| Art | `clamp(32px,14cqw,40px)` circle, flush | `clamp(36px,16cqw,44px)`, −10px overlap + surface ring | `clamp(120px,46cqw,220px)` stacked (rail) / `clamp(140px,38cqw,260px)` side-by-side (disc) |
| Title | `clamp(12.5px,5cqw,15px)` 600 −0.02em, ellipsis | same + `5.2cqw` slope | `clamp(15px,4.5cqw,20px)` (rail) / `22px` cap (disc) |
| Artist | `clamp(10.5px,4cqw,12px)` dim, ellipsis | same | 12px dim |
| Transport | 32px nav / 32px play, transparent | pill cluster, 26–30px nav / 30–34px play | `clamp(36px,10cqw,48px)` overlay disc |
| Progress | 3px full-bleed hairline, row bottom | 3px under meta+transport (cols 2–3) | times-flank bar, tabular 10–11px |
| Gaps/pad | gap 6–10, pad-x 8–12 | gap 4–8, pad 8–10, pill 2/6 | gap 2 (card) / 10–20 (disc grid) |
| Row budget | ≤68px box (72 ceiling) | ≤68px box (44px art cap) | n/a (full chrome) |
| Collapsed | header-only ≈36px, no mini (both) | same | same |

Shape rule (documented): circles for art/play, 8–10px controls,
999px ONLY for the disc-variant transport pill. Radius scale
`--r-lg/--r-md/--r-sm` untouched.

## Dials (shipped)

`DESIGN_VARIANCE: 4 / MOTION_INTENSITY: 2 / VISUAL_DENSITY: 6`
(default rail). Opting into `disc` raises effective variance to 7;
motion and density unchanged. No infinite loops, no scroll hijack,
marquee stays hover-gated + reduced-motion-killed.

## Implementation plan (for the feature worker, not this branch)

1. `PlayerPane.tsx`: add `variant?: "rail" | "disc"` (default
   `"rail"`), set `data-variant` on `.player-full` + `.mini-row`.
2. `App.tsx`: persist variant (settings/localStorage), pass through;
   `compact` gate, collapsed exclusion, `MINI_PLAYER_W`/`160px` gates
   untouched.
3. `App.css`: append rail rules (default, no attribute needed) +
   `[data-variant="disc"]` overrides + light blush wash + roomy
   side-by-side grid + `color-mix` fallback. No existing selector
   edited except additive variant blocks.
4. Verify: `npm run test:unit`, `compact-player.spec.ts` (280/360/
   short/light/collapsed), plus a 200px-floor spill check for the
   disc variant and a ≥480px side-by-side capture.

## Files in this branch (design-only, no src changes)

- `docs/design/responsive-player/00-breakpoint-domain.md`
- `docs/design/responsive-player/sketch-a-rail.md`
- `docs/design/responsive-player/sketch-b-flume-disc.md`
- `docs/design/responsive-player/synthesis-2.5.2.md` (this file)

No merge to main, no tag, no release (per handoff).
