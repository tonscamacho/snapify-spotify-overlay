# Updater

Sub-features: version row in Settings (runtime `getVersion`), Check for
updates, download progress, Install + Restart now, error hint.
Signed update feed at
`.../releases/latest/download/latest.json`, public key pinned in
`tauri.conf.json` (`plugins.updater.pubkey`). Releases are built and
signed by the `Publish` workflow on `v*` tags (draft release, publish by
hand). Login, layout, and keybinds survive updates (separate storage).

How to get to it: Settings, bottom, below Shortcuts.

Driving it: open Settings, confirm the version matches the installed
build. Press Check for updates with no release published: the hint reads
"No published releases found yet." Publish, press
Publish, check again: Install + release notes appear. Install hands off
to the system installer on Windows (a Restart now button surfaces on
macOS/Linux); the new version shows in Settings after.

Gotchas: the feed URL 404s until the first release is published — that
is the expected idle state, not a bug. A version mismatch between tag
and `tauri.conf.json` re-offers the same update forever; bump all three
version spots before tagging. Downgrades are refused.
