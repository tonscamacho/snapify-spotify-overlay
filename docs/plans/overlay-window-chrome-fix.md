# Overlay Window-Chrome Fix — Grey Strip Around Dock/Pill

## Title
Eliminate the light-grey rounded-rectangle window-chrome halo visible around the dock toolbar and drag pill on the transparent fullscreen overlay, without breaking click-through, drag, modal, or toast behavior.

## Goal
- At normal and narrow/short viewport sizes, the only visible pixels outside interactive elements (dock toolbar, drag pill / drag cover, panes, hint chip, toasts, settings modal) are those elements themselves. No fullscreen or pill-shaped grey halo.
- Click-through still works everywhere except live interactive rects. Drag still works via the pill/cover. Modal still closes on backdrop click. Toasts still render above the dock.
- Each PR below is stacked and independently verifiable on the real artifact (Windows `tauri dev` / built app + browser specs).

## Non-goals
- No redesign of the dock, pill, panes, or settings modal layout or visual style.
- No change to Spotify playback, auth, pane data flow, undo/toast logic, or login window behavior.
- No Linux/macOS region-path changes (region code is Windows-gated; other platforms keep current behavior).
- No perf optimization beyond rounding/dedupe correctness already in `apply_region`.

## Branch / SHA
- Branch: `main`
- SHA: `561dbf6`
- Step-1 decision: NOT a 1–2 file obvious change. The fault spans Rust (window region) + TS bridge (rect collection) + CSS (paint) + web specs, so a written plan is required before code.

## Prototype appendix ref
- Path: `C:\Users\User\AppData\Local\Temp\opencode\spotify-overlay-grey-strip-prototype.md`
- What each experiment would prove:
  - **E1a (region-dump logging):** proves whether the OS window region (what `SetWindowRgn` received) matches the interactive rects, i.e. shape fault vs. paint fault. Temporary `eprintln!`/log of phys rects + mode in `apply_region` / `set_window_region`.
  - **E1b (tauri-vs-vite A/B):** proves whether the halo comes from the Tauri WebView window itself (transparent/decorations/shadow flags) vs. Vite-rendered CSS. Compares identical DOM served two ways.
  - **E1c (DevTools hide / square-dock checks):** proves which DOM node paints the halo by hiding candidates (`.dock`, modal backdrop, toasts, hint) and by forcing a square (non-rounded) dock to isolate corner-antialias vs. full-halo causes. No behavior change.
  - **E2 (rounded-region shape fix):** proves `CreateRoundRectRgn` (vs. `CreateRectRgn`) removes corner halo pixels while keeping hit-testing correct, including DPR scaling and `frame_offset` rounding.
  - **E3 (passive-mode reset):** proves the stale-region finding at `src-tauri/src/overlay.rs:273-278` — the passive early-return path leaves a stale clickable/visible region behind — and that an explicit `SetWindowRgn(NULL)` reset on entering passive mode clears it.
  - **CreateRoundRectRgn feasibility note:** documents that `windows` crate already exposes `CreateRoundRectRgn`; the only work is corner-radius mapping (CSS px → physical px, per-rect) and fallback to `CreateRectRgn` on failure.
  - **Passive stale-region finding (`src-tauri/src/overlay.rs:273-278`):** documents that `apply_region` returns early in passive mode without resetting the window region, so the last interactive-mode region persists (clickable halo + potential paint rect).

---

## Context pointers (do not re-derive; use these bounds)

### Window (Tauri)
- `src-tauri/tauri.conf.json:12-32` — window config: `maximized:true:22`, `transparent:true:23`, `decorations:false:24`, `shadow:false:25`, `alwaysOnTop:true:26`.
- `src-tauri/src/main.rs:4-5` — entry, calls lib `run`.
- `src-tauri/src/lib.rs:163-338` — `run`; `note_boot:167`; `manage OverlayState:235`; `ignore_cursor_events` boot `true:240-242`; `invoke_handler` with `set_overlay_mode:326` / `set_overlay_regions:327`; `set_login_window:71-82`.

### Region (Rust)
- `src-tauri/src/overlay.rs:6-11` — `OverlayRect` contract.
- `src-tauri/src/overlay.rs:44-66` — `phys_rects` (logical → physical scaling).
- `src-tauri/src/overlay.rs:80-116` — `set_window_region` (`CreateRectRgn` / `CombineRgn` with `RGN_OR=2` / `SetWindowRgn`).
- `src-tauri/src/overlay.rs:118-126` — `frame_offset`.
- `src-tauri/src/overlay.rs:227-239` — event listeners.
- `src-tauri/src/overlay.rs:241-308` — `apply_region` (passive early-return `:273-278`, scale `:279`, offset `:283`, dedupe `:295-299`).
- `src-tauri/src/overlay.rs:310-359` — `set_overlay_mode` / `set_overlay_regions` entry points.
- `src-tauri/src/overlay.rs:381-495` — unit tests for region math.

### Bridge (TS → Rust)
- `src/lib/overlay.ts:10-20` — `SELECTORS`.
- `src/lib/overlay.ts:22-58` — `collectOverlayRegions` (dragCover fullscreen `:29-33`, `getBoundingClientRect :46`, `round :48-53`, 64-rect cap).
- `src/lib/overlay.ts:111-135` — `reportOverlayRegions`.
- `src/lib/overlay.ts:200-206` — `reportOverlayMode`.
- `src/lib/overlay.ts:144-198` — `watchRegionElementSizes` (resize observer → re-report).

### Frontend (DOM / CSS)
- `src/App.tsx:2396-2405` — `.app` root.
- `src/App.tsx:2447-2536` — `.dock` toolbar: Hide `2449-2458`, Lock `2459-2468`, Pass `2469-2478`, Undo `2479-2488`, chips `2490-2503` (from `PANE_TYPES:105` / `PANE_TITLES:109-115`), Settings `2505-2513`, Done `2515-2525`, Close `2526-2534`.
- `src/App.tsx:2538-2546` — hint-chip.
- `src/App.tsx:2548-2581` — toasts.
- `src/App.tsx:1977` — drag-cover unmount path (must flush a region clear; see PR2).
- `src/SettingsModal.tsx:453` — `modal-back` backdrop.
- `src/App.css:5-34` — tokens (`--surface #17171a` etc.).
- `src/App.css:40-70` — shell (transparent stage).
- `src/App.css:136-156` — stage/pane.
- `src/App.css:1126-1146` — `.dock` (`fixed top:12px`, wrap, `max-width min(94vw,760px)`, `radius 999px`, `z 200`).
- `src/App.css:1203-1220` — hint (`bottom:16px`).
- `src/App.css:1232-1240` — `modal-back` (`inset 0 rgba(4,6,10,.55)`, `pointer-events:none`).
- `src/App.css:1393-1420` — toasts (`z 300`).
- `src/App.css:1696-1708` — light theme.
- `src/App.css:1852-1877` — glass theme.
- `src/App.css:2275-2338` — narrow/short media queries (dock `bottom:10px`, nowrap scroll, icon-only).
- Entry: `index.html:1-15` → `src/main.tsx:1-9` → `src/App.tsx`.

### Tests / build
- `npm run test` (`vitest run`).
- `npm run test:unit` (`vitest run src`).
- `npm run test:web` (`playwright test -c playwright.config.ts`, testDir `verify/web`; specs `layout.spec.ts:216-249` dock wrap + `268-310` hit-test, `overlay-passthrough.spec.ts:14-39` / `60-85` / `122-157` / `181-225`).
- `npm run verify` (aggregate gate).
- `cargo test` (covers `overlay.rs:381-495`).
- `cargo build` / `npx tauri build` (Windows only for real region behavior).

---

## PR1 — Prove-it (diagnose only, no behavior change)

### Dependencies
- None. Base of stack (`main@561dbf6`).

### File bounds (exact paths + line ranges — read-only instrumentation + spec scaffolding, no product behavior edits)
- `src-tauri/src/overlay.rs:241-308` — add temporary region-dump log inside `apply_region` (log mode + logical rects + phys rects + dedupe hit/miss); no logic change.
- `src-tauri/src/overlay.rs:80-116` — temporary log at `set_window_region` entry/exit (rect count, combine result); no logic change.
- `src/lib/overlay.ts:22-58` — temporary `console.debug` of collected rects (selector → x/y/w/h); no change to rounding, cap, or selector set.
- `src/lib/overlay.ts:111-135` — temporary log of reported payload size; no invoke change.
- `verify/web/layout.spec.ts:216-249` + `:268-310` — read current dock-wrap and hit-test assertions to record baseline (no edits to assertions in PR1; may add `test.skip`-guarded probe tests only).
- `verify/web/overlay-passthrough.spec.ts:14-39`, `:60-85`, `:122-157`, `:181-225` — read baseline passthrough expectations (no edits in PR1).
- Prototype appendix `C:\Users\User\AppData\Local\Temp\opencode\spotify-overlay-grey-strip-prototype.md` E1a/E1b/E1c — execute as manual checklist, record outputs.

### Build command
- `npm run test:web` (baseline, headless Chromium) AND manual Windows `npx tauri dev` for E1b/E1c visual checks (DevTools element-hide + square-dock force via DevTools styles only, not committed).
- `cargo test` (region unit tests must stay green; instrumentation must not break them).

### Observable result (what user sees)
- No visual or interaction change. The deliverable is evidence: (a) logged OS-region rects vs. on-screen halo geometry, (b) tauri-vs-vite A/B verdict (halo follows window flags or CSS), (c) DevTools hide/square-dock verdict naming the painting node. This evidence selects the PR2/PR3 fix path and is pasted into the PR1 description.

### Manual experiment checklist (from appendix)
- [ ] E1a region-dump: `tauri dev`, toggle interactive/passive, drag pill, open/close modal; capture log lines showing phys rects.
- [ ] E1b tauri-vs-vite A/B: same DOM in `vite dev` vs. `tauri dev`; halo present in only one or both → record.
- [ ] E1c DevTools: hide `.dock` → halo gone?; force `.dock { border-radius: 0 }` → halo corners change?; hide modal-back/toasts/hint one at a time → record which removal kills the halo.

### Checkboxes
- [ ] unit (`cargo test` + `npm run test:unit` green)
- [ ] live (`npx tauri dev` on Windows; E1a/E1b/E1c outputs captured)
- [ ] perf (no perf claim; instrumentation removed or feature-flagged before merge — confirm no log spam in release path)
- [ ] review (appendix verdicts linked in PR description)
- [ ] merge (stack base; PR2 blocked until PR1 evidence lands)

---

## PR2 — Shape fix (window region geometry)

### Dependencies
- Stacked on PR1 (needs E1a/E3 verdict: phys rects vs. halo geometry + passive stale-region confirmation).

### File bounds (exact paths + line ranges)
- `src-tauri/src/overlay.rs:80-116` — replace/extend `CreateRectRgn` with `CreateRoundRectRgn` per rect (corner radius mapped from CSS px → physical px); fallback to rect on failure. Keep `CombineRgn RGN_OR=2` + `SetWindowRgn` flow.
- `src-tauri/src/overlay.rs:44-66` — `phys_rects`: fix DPR scaling + rounding so physical corners land on device pixels (no 1px overhang that paints as grey fringe).
- `src-tauri/src/overlay.rs:118-126` — `frame_offset`: rounding/offset correctness for maximized transparent window (verify no off-by-N shift between region and painted element).
- `src-tauri/src/overlay.rs:241-308` — `apply_region`: (a) remove/neutralize passive early-return `:273-278` so entering passive issues explicit `SetWindowRgn(NULL)` reset (clears stale interactive region); (b) keep dedupe `:295-299` but ensure reset path bypasses dedupe; (c) keep scale `:279` + offset `:283` consistent with new rounding.
- `src-tauri/src/overlay.rs:310-359` — `set_overlay_mode` / `set_overlay_regions`: ensure mode transitions always flow through the reset path (no caller can leave a stale region).
- `src-tauri/src/overlay.rs:381-495` — extend unit tests: rounded-rect mapping, DPR rounding, passive-reset bypasses dedupe.
- `src/lib/overlay.ts:22-58` — `collectOverlayRegions`: optionally shrink interactive rects by sub-pixel/1px inset OR pass corner radii through (whichever PR1 proves sufficient); keep 64-cap, `round :48-53`, dragCover fullscreen `:29-33` handling. If radii are passed, extend `OverlayRect` + `SELECTORS :10-20` minimally.
- `src/lib/overlay.ts:144-198` — `watchRegionElementSizes`: ensure resize/drag-cover changes re-report promptly (no stale rect after pill moves).
- `src/lib/overlay.ts:111-135` + `:200-206` — ensure mode + regions reports stay ordered (reset not clobbered by a late regions push).
- `src/App.tsx:1977` — drag-cover unmount path: flush an explicit region clear / mode report on unmount so no stale fullscreen dragCover rect survives (this is the dragCover counterpart of the passive reset).
- Remove all PR1 temporary logging from `overlay.rs` + `overlay.ts`.

### Build command
- `cargo test` (region math incl. new rounding/reset tests) + `npm run test:unit` + manual Windows `npx tauri dev` (toggle passive/interactive, drag pill across screen, open/close settings modal; confirm no stale clickable halo via click-through probing).
- `cargo build` (Windows) before PR handoff.

### Observable result (what user sees)
- Rounded corners of dock/pill no longer show a grey fringe; the clickable area matches the visible rounded shape (clicks just outside a rounded corner fall through to the app below instead of hitting the overlay).
- Switching to passive mode (and unmounting the drag cover) leaves no ghost clickable/visible rect: clicks pass through everywhere and no halo remnant stays on screen.

### Checkboxes
- [ ] unit (`cargo test` green incl. new rounding + passive-reset tests)
- [ ] live (Windows `tauri dev`: passive toggle, pill drag, modal open/close, corner click-through probe)
- [ ] perf (region recompute still deduped; no per-frame `SetWindowRgn` spam — verify via log/dedupe counter)
- [ ] review (reviewer checks `CreateRoundRectRgn` fallback + reset-bypasses-dedupe + unmount flush)
- [ ] merge (stack middle; PR3 rebases onto it)

---

## PR3 — Paint fix (CSS halo + spec updates)

### Dependencies
- Stacked on PR2 (needs true region shape so remaining halo can be attributed to CSS paint, not geometry).

### File bounds (exact paths + line ranges)
- `src/App.css:1126-1146` — `.dock`: fix wrap/pill background bleed (background scope, `background-clip`, overflow, wrapping behavior). Keep `fixed top:12px`, `max-width min(94vw,760px)`, `radius 999px`, `z 200`.
- `src/App.css:2275-2338` — narrow/short queries: fix dock `bottom:10px` nowrap-scroll icon-only path (the scrolled pill must not paint a full-width grey bar behind icons).
- `src/App.css:1852-1877` — glass theme scoping (backdrop-filter / translucent background must not extend beyond the pill).
- `src/App.css:1696-1708` — light theme scoping (`--surface #17171a` overrides; light surface must not read as fullscreen grey wash).
- `src/App.css:40-70` — shell/stage transparency (confirm root paints nothing; no inherited background on `.app`).
- `src/App.css:136-156` — stage/pane (panes must not contribute fullscreen tint when dock-only is visible).
- `src/App.css:1232-1240` — `modal-back` (`inset 0 rgba(4,6,10,.55)` + `pointer-events:none` preserved; scope dimming so it cannot be mistaken for the chrome halo; keep `onClick` close in `SettingsModal.tsx:453` working).
- `src/App.css:1203-1220` — hint chip (`bottom:16px`; ensure no bar behind it).
- `src/App.css:1393-1420` — toasts (`z 300` vs. pill `z 200` preserved; toast background must not widen the halo).
- `src/App.tsx:2396-2405` (`.app` root), `:2447-2536` (dock toolbar incl. Hide/Lock/Pass/Undo/chips/Settings/Done/Close), `:2538-2546` (hint-chip), `:2548-2581` (toasts), `SettingsModal.tsx:453` (modal-back) — structural/JSX changes only if CSS alone cannot scope the background (prefer CSS-only; any JSX change must preserve selectors in `src/lib/overlay.ts:10-20`).
- `verify/web/layout.spec.ts:216-249` (dock wrap) + `:268-310` (hit-test) — update/extend assertions: wrapped dock and narrow icon-only dock paint no full-width bar; hit-test reflects rounded shape.
- `verify/web/overlay-passthrough.spec.ts:14-39`, `:60-85`, `:122-157`, `:181-225` — update passthrough expectations to the fixed behavior (outside rounded corners passes through; passive mode fully passes through).
- `src/lib/overlay.ts:10-20` — only if JSX selectors changed; otherwise untouched.

### Build command
- `npm run test:web` (layout + passthrough specs green) + `npm run test:unit` + manual Windows `npx tauri dev` visual pass (normal + narrow ≤800px + short viewports; light + glass + dark themes; modal open/closed; toasts firing).
- `npx tauri build` (Windows only) as final pre-merge sanity if PR2 already did `cargo build`.

### Observable result (what user sees)
- No grey strip/bar behind the dock in any theme (dark/glass/light), at full width or wrapped or narrow icon-only, with or without hint/toasts/modal. The dock reads as a floating pill; the rest of the screen shows the app below with zero tint.
- Specs lock the fix: wrap, narrow, hit-test, and passthrough suites fail if the halo regresses.

### Checkboxes
- [ ] unit (`npm run test:unit` green)
- [ ] live (Windows `tauri dev` visual pass: 3 themes × normal/narrow/short × modal/toast states)
- [ ] perf (no new backdrop-filter over fullscreen area; glass blur scoped to pill — confirm via DevTools paint/overlay check)
- [ ] review (reviewer checks theme scoping + wrap@800px + modal/toast z-order preserved)
- [ ] merge (stack top; squash-merge in order PR1 → PR2 → PR3)

---

## PR4 — Player transport icons size/alignment

### Dependencies
- Independent of PR1–PR3 geometry/paint chain: no region, dock, modal, toast, or selector changes. Shares only the visual verification vehicle (Windows `npx tauri dev`); no rebase onto PR1–PR3 required.
- Overlap risk: another-tab agent may own a PlayerPane PR in flight. Only one writer may touch `PlayerPane.tsx` / transport CSS at a time — this PR rebases onto whichever lands first, and never edits alongside an unmerged PlayerPane diff.

### File bounds (exact paths + line ranges — the fixer owns src edits; this plan file changes nothing in src)
- `src/components/PlayerPane.tsx:377-458` — `.art-transport` row: `ShuffleIcon size={16}:397`, `PrevIcon size={18}:406`, `Play/Pause size={19}:416,427` (`play-disc`), `NextIcon size={18}:436`, `Repeat/RepeatOne size={16}:446`, episodic `SeekBack/SeekForward size={16}:386,456`; button classes `icon-btn` vs `play-disc`. Handler/onClick logic untouched.
- `src/components/PlayerPane.tsx:638-657` — mini-row `play-disc mini-play` (`Pause/Play size={15}`); keep in sync proportionally, no logic change.
- `src/App.css:309-335` — `.art-transport` flex (`align-items:center`, `justify-content:center`, `gap:2px`) + `.art-overlay .icon-btn` 32×32 + `.art-overlay .play-disc` 44×44 (oval/pill suspect: circle comes from base `border-radius:50%` + equal w/h; any w≠h or padding here reads as an oval).
- `src/App.css:463-530` — base `.icon-btn` 36×36 `grid place-items:center` + `.play-disc` 40×40 circle `margin:0 4px`; the per-icon `size=` px values above render inside these boxes, so box and glyph sizes must be normalized together.
- `src/App.css:1676-1683` — narrow `@container (max-width:330px)` shrink (28/36); must still pass after the fix.
- `src/App.css:1720-1737` — light-theme `play-disc`/`icon-btn` recolor (must still pass); `src/App.css:1852-1877` glass scoping untouched (must still pass).
- `src/components/icons.tsx:17-38` (`Base`: `viewBox 0 0 24`, `strokeWidth 1.8`, round caps) + `:40-65` (Play/Pause/Next/Prev filled paths) vs `:67-94` (Shuffle/Repeat stroked paths) — the filled-vs-stroked optical-weight mismatch is a suspected size contributor; touch only if CSS box/baseline work cannot equalize, prefer CSS.
- `src/App.tsx:2264-2293` — `MemoPlayerPane` mount + `compact` gate (`:2282`); read-only context, no edits (compact swaps full player for mini-row).
- `verify/web/player.spec.ts` — extend with transport-row assertions (equal box sizes, baseline alignment, play-disc circle proportion). `verify/web/layout.spec.ts:216-249` — narrow/wrap context only; no dock assertion changes. No `overlay-passthrough` spec changes.
- Explicitly out of bounds: `src-tauri/src/overlay.rs` region pipeline, `src/lib/overlay.ts` selectors/reporting, dock CSS (`App.css:1126-1146`, `:2275-2338`), `modal-back`, toasts.

### Build command
- `npm run test:unit` + `npm run test:web` (player + layout specs green) + manual Windows `npx tauri dev` visual pass: Player pane at 800px + narrow width, hover/focus the art overlay visible, dark + glass + light themes.

### Observable result (what user sees)
- Transport row below the art: shuffle / prev / play / next / repeat render at uniform optical size on one shared baseline, centered under the art; play/pause disc is a proportional circle (not an oversized white oval); shuffle/repeat no longer read tiny vs prev/next; progress `0:12 / -2:58` bar and volume slider unchanged with no layout shift.

### Checkboxes
- [ ] unit (`npm run test:unit` green)
- [ ] live (Windows `tauri dev`: 800px + narrow screenshots of the transport row, 3 themes, overlay revealed via hover/focus)
- [ ] perf (no new backdrop-filter or per-frame work; icon/CSS-only change — confirm no region-report churn)
- [ ] review (reviewer checks uniform optical size + shared baseline + play-disc proportion + narrow/light/glass still pass + no overlay.rs/dock-CSS touched)
- [ ] merge (independent lane; squash-merge after PlayerPane ownership is clear; never alongside a conflicting PlayerPane diff)

---

## Execution playbook

- **Named playbook: Shipping (single-track stacked PRs).** Not Orchestrate.
- **Reason:** the three PRs are causally ordered, not independent — PR2's shape fix depends on PR1's diagnose verdict (shape vs. paint, passive-stale confirmation), and PR3's paint fix depends on PR2's true geometry (otherwise CSS changes chase a geometry artifact). Parallel tracks would produce conflicting rect/CSS theories and stale-region races. Single-track stacked PRs keep each step independently verifiable while preserving the evidence chain (log → geometry → paint). Each PR merges in order; PR2 rebases onto PR1, PR3 onto PR2.

---

## Conventions to preserve (do not regress)

1. **solid-vs-glass-vs-light:** three distinct dock surfaces must keep working — solid dark (`--surface #17171a` family, `App.css:5-34`), glass (`App.css:1852-1877`, scoped `backdrop-filter`), light (`App.css:1696-1708`). Fixes scope backgrounds; they never unify the themes.
2. **wrap@800px assertion:** `layout.spec.ts:216-249` dock-wrap behavior at ~800px (wrap, `max-width min(94vw,760px)`, narrow icon-only path `2275-2338`) must keep passing (updated, not deleted). The wrapped/scrolled pill is the halo's favorite hiding place — keep an explicit assertion on it.
3. **modal-back `pointer-events:none` + `onClick` close:** `App.css:1232-1240` + `SettingsModal.tsx:453` — the backdrop dims (`rgba(4,6,10,.55)`) yet never intercepts clicks except its own close handler. Do not "fix" passthrough by making the backdrop click-transparent in a way that breaks close-on-click, and do not make it click-blocking fullscreen.
4. **toast z300 vs. pill z200:** `App.css:1393-1420` (`z 300`) stays above `.dock` (`z 200`, `1126-1146`). Paint scoping must not reorder stacking, clip toasts, or drag toast backgrounds into the dock halo calculation.

---

## Risks + rollbacks per PR

### PR1 risks
- **Risk:** temporary logging spams console / slows region reports and gets mistaken for product behavior.
  - *Mitigation:* clearly-marked `TODO(PR1-remove)` logs; no logic branches changed.
  - *Rollback:* revert log-only diff; specs untouched so `git revert` is clean and `npm run test:web` + `cargo test` return to baseline.
- **Risk:** DevTools-only style forcing (square dock) misread as the fix.
  - *Mitigation:* record as uncommitted manual step with screenshots; no committed CSS.
  - *Rollback:* n/a (nothing committed except logs).

### PR2 risks
- **Risk:** `CreateRoundRectRgn` unavailable/fails on some Windows builds → dock becomes unclickable (NULL/empty region).
  - *Mitigation:* per-rect fallback to `CreateRectRgn`; unit test the fallback; keep `CombineRgn` flow identical.
  - *Rollback:* revert `overlay.rs:80-116` hunk to `CreateRectRgn`-only; keep passive-reset hunk if proven safe (it is independent). `cargo test` + live click-through probe confirm.
- **Risk:** passive `SetWindowRgn(NULL)` reset causes flicker or steals/restores focus, or a late `reportOverlayRegions` re-installs a stale rect after the reset (ordering race).
  - *Mitigation:* reset bypasses dedupe exactly once per mode transition; order mode-before-regions in `overlay.ts:111-135/:200-206`; `watchRegionElementSizes:144-198` re-report covers transitions.
  - *Rollback:* restore early-return `:273-278` (revert reset hunk only); stale-region ghost returns but no worse than baseline. Verify with passive click-through probe.
- **Risk:** 1px shrink / rounding change makes pill edges unclickable or leaves 1px dead rim.
  - *Mitigation:* unit tests on `phys_rects:44-66` rounding; live edge-click probe around pill corners.
  - *Rollback:* revert rounding/shrink constants to baseline; region shape returns to PR1 geometry.
- **Risk:** drag-cover unmount flush (`App.tsx:1977`) double-fires reports causing region flicker.
  - *Mitigation:* flush only on real unmount/mode change, dedupe-guarded in `apply_region:295-299`.
  - *Rollback:* revert the unmount-flush hunk; dragCover ghost returns but baseline behavior otherwise intact.

### PR3 risks
- **Risk:** scoping dock background (`background-clip` / overflow / wrap fix) clips focus rings, chips overflow, or the narrow nowrap-scroll path (`2275-2338`) becomes unscrollable.
  - *Mitigation:* keep scroll + icon-only behavior; visual pass on narrow ≤800px with keyboard focus walk.
  - *Rollback:* revert `App.css` dock/narrow hunks; specs revert to pre-PR3 assertions. `npm run test:web` confirms baseline.
- **Risk:** glass/light scoping removes intended translucency (dock looks solid when it should blur / looks dark in light theme).
  - *Mitigation:* theme visual pass (dark/glass/light screenshots in PR description); scope blur/background to pill only, never delete the effect.
  - *Rollback:* revert `1852-1877` / `1696-1708` hunks independently.
- **Risk:** spec updates (`layout` + `passthrough`) overfit to one viewport/GPU and flake in CI.
  - *Mitigation:* keep assertions on geometry/visibility, not pixel-exact screenshots; reuse existing spec viewports.
  - *Rollback:* revert spec files only; product CSS stays and can be re-locked by a follow-up spec PR.
- **Risk:** JSX restructuring (if needed) breaks `SELECTORS` in `overlay.ts:10-20` → regions stop reporting → overlay fully click-through or fully blocking.
  - *Mitigation:* prefer CSS-only; if JSX changes, update selectors in the same PR and run `npm run test:web` hit-test suite.
  - *Rollback:* revert JSX + selector hunks together (they are one atomic unit).
