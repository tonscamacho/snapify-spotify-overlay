# User report 2026-09-30-01 — Project Zomboid windowed 1080p (words stand in)

Original bytes not available in-chat; this description stands in per pilot brief.
No `user-2026-09-30-01-*.png` binary exists in this folder — the friend's
report arrived as words only ("yellow highlighted box" is their annotation /
the confine region they saw, not overlay paint: the overlay ships no yellow
chrome).

## Reported symptoms

- Game: Project Zomboid, windowed 1080p.
- Overlay pane positioning "way off" versus the windowed game viewport.
- A pane can only be moved across a small box (their yellow highlight), as if
  the overlay thinks the screen is smaller / offset relative to the live
  window.

## Why it matters

The overlay window is a maximized fullscreen surface
(`src-tauri/tauri.conf.json` `maximized:true`, `decorations:false`), while a
windowed game (or any OS shrink / resolution switch / un-maximize) can leave
the live window smaller than the stored layout. Layout clamped only at boot,
so a post-boot shrink stranded panes off-screen where no drag could reach
them. Fixed on `fix/zomboid-windowed-2.5.3`.

## Pointers

- Drag/clamp: `src/App.tsx` (`beginDrag`, `applyDrag`, resize-settle clamp)
- Clamp math: `src/lib/layout.ts` (`clampPaneToArea`, `clampLayoutToArea`)
- Region pipeline: `src/lib/overlay.ts`, `src-tauri/src/overlay.rs`
  (window listeners now cover `Resized` too)
- Regression: `verify/web/zomboid-windowed.spec.ts`
  (1280x720 windowed + 1920x1080 roam, runtime-shrink rescue)
- Live Zomboid was never run here: game-side verification is inconclusive.
