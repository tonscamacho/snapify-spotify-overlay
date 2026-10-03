# Intake: queue pane window-controls/scrolling spill (2026-10-02)

- Source: user report 2026-10-02 (01-queue-spill). No image bytes arrived
  in-chat, so no PNG was copied into `docs/media-incoming/`; this note is
  the intake record per the standing order (describe symptom, no bytes).
- Symptom: queue pane controls and scroll content spill past the queue
  pane bounds. Report covers both the expanded scrolled list (virtualized
  rows / scroll container escaping the box) and the collapsed state
  (header-only contract broken by visible body content).
- Surfaces: expanded queue at 280/360/480 px widths plus collapsed queue.
- Prior premise (attack it, do not assume it): the 2.5.0 spill returned
  via `.pane-body` display-rule specificity (queue flex rule outranking
  the collapse hide). SO-5 fixed it by scoping the hide to
  `.pane[data-pane][data-collapsed]`. This worker re-checks that premise
  with runtime measurements before touching CSS.
- Pointers: `src/components/QueuePane.tsx`, `src/App.tsx` renderPane,
  `src/App.css` pane/queue/collapse rules, `src/lib/layout.ts`,
  `src/lib/overlay.ts`, `verify/web/queue-spill-repro.spec.ts`.
