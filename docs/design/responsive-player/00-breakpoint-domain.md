# Responsive player — breakpoint domain (named first)

Source of truth: `src/lib/layout.ts` (`MINI_PLAYER_W`, `COMPACT_W`,
`EXPANDED_COMPACT_H`), `src/App.tsx` compact gate + stage tiers,
`src/App.css` container queries, `verify/web/compact-player.spec.ts`.

## Width tiers (pane box, includes 2px border)

| Name | Range | Behavior |
|---|---|---|
| `mini` | w ≤ 282 (`MINI_PLAYER_W` 280 + 2 border) | React `compact` gate + 280px container query: full player `display:none`, `.mini-row` flex. Row ≤ 72px, zero spill. |
| `tight` | 283–359 | Full player, but 330px container sheds `q-time`/`q-index`, shrinks overlay buttons (28/36px). 360px `COMPACT_W` tier sheds browse art/metadata. |
| `comfortable` | 360–479 | Full player, all metadata (`album-full` returns above 480). |
| `roomy` | ≥ 480 | Wide-pane tier: 44px browse thumbs, room for overlay row. Sketches scale art/type/transport here. |

## Height tiers (pane box)

| Name | Range | Behavior |
|---|---|---|
| `collapsed` | `height:auto`, header-only | Body `display:none`, no mini in DOM. Header ≈ 36px (spec ceiling 48). Never pinned to `EXPANDED_COMPACT_H`. |
| `short-compact` | h < 160 (expanded) | React `compact` gate fires even when wide: mini card. Boot clamp yields to compact floor (player 132). |
| `full` | h ≥ 190 (`PANE_MIN.player.h`) | Full chrome: art + times + meta + volume. |

## Stage tiers (effective = CSS px ÷ uiScale, 0.85–1.30)

| Name | Condition | Effect |
|---|---|---|
| `stage-narrow` | effW < 480 | Dock bottom icon row, toasts right, hint left, `pane-op` 60px, library select ≤ 46vw. |
| `stage-short` | effH < 420 | Slim handle (22px), art `min(44%,120px)`, volume row hidden. |

## Compactness flag (JS, because CQ cannot test height)

`isCompactPane(w,h,type) = w < 360 || h < full.h` → `data-compact`
sheds cover art/secondary metadata first, floors mirror
`COMPACT_PANE_MIN` (player 200×132). Collapse overrides floors
(`min-height:0` when collapsed+compact).
