# Media incoming

Drop zone for images the user sends in chat. Copy each chat upload here
before spawning workers, so every worker brief can point at committed
files instead of pasting image bytes.

## What goes here

- Screenshots and photos supplied by the user in chat.
- Reference images the user asks workers to match.
- Keep curated copies where they belong: versioned bug captures stay in
  `docs/bug-reports/<version>/`, user-facing shots stay in `assets/readme/`.
  This folder is intake only.

## Naming

Save each file as:

`user-YYYY-MM-DD-NN-<slug>.png`

Use the date the user sent the image, `NN` as the zero-padded index for
that day, and a short slug (`dock-halo`, `light-stage`). Keep the original
extension when the upload is not PNG.

## Standing order for the orchestrator

1. Copy every chat-uploaded image into `docs/media-incoming/` under the
   naming above before spawning workers.
2. Pass the folder path plus the file list in every worker brief, for
   example: `docs/media-incoming/user-2026-09-29-01-dock-halo.png`.
3. Never pass chat-only images by bytes alone. If the folder is empty,
   state that in the brief.
