# Real-Spotify shapes: live API shape checks only. Short-lived token, env only.
# Mint: Spotify Web API Console (developer.spotify.com/console) -> sign in ->
# copy the OAuth token (about 1 hour) -> $env:SPOTIFY_VERIFY_TOKEN="<token>".
# Never log, print, or commit the token. No token: SKIP, exit 0.
$root = Split-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot)))
if (-not $env:SPOTIFY_VERIFY_TOKEN) {
  echo "SKIP set SPOTIFY_VERIFY_TOKEN to run live API shape checks (short-lived token only, env only)"
  exit 0
}
Push-Location $root
try {
  npx playwright test -c playwright.config.ts verify/web/real-spotify.spec.ts
  if ($LASTEXITCODE -ne 0) { echo "FAIL real-spotify exit $LASTEXITCODE (token may have expired; mint a fresh one)"; exit 1 }
  echo "WEB_REAL_OK live shapes fit the parsers"
} finally { Pop-Location }
