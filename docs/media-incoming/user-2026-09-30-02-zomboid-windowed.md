# User image 2026-09-30-02 — zomboid windowed (description stands in)

Original bytes not available in-chat; this description stands in per pilot brief.
No PNG was pasted, so no `user-2026-09-30-02-*.png` binary exists in this folder.

## What the screenshot shows

- Project Zomboid running windowed (not fullscreen) with the Snapify
  overlay stage visible over / around the game window.
- The live window is smaller than the stored fullscreen arrangement, so
  pane geometry seeded for a big canvas meets a small live canvas.
- Player pane readable; no content clipped by the game window edge in the
  capture.

## Why it matters

A windowed game (or any OS shrink / resolution switch) leaves the live
window smaller than the stored layout. Boot already clamps; a runtime
shrink must pull stranded panes back on-screen with regions following.
That clamp path is sibling Track C scope
(`verify/web/zomboid-windowed.spec.ts`, currently untracked in-tree);
Track A only notes the context here so short-window player sizes
(120-190 px heights) stay consistent with it.

## Pointers

- Sibling spec: `verify/web/zomboid-windowed.spec.ts` (Track C, do not edit)
- Clamp: `src/lib/layout.ts` (`clampPaneToArea`, `clampLayoutToArea`)
- Live size: `src/App.tsx` viewport / resize handling, drag floors ~2019
- Track A overlap: mini/full swap at 120-190 px must not clip in windowed
  sizes either (`verify/web/player-center.spec.ts`)
