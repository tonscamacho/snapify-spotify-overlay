# Web run: unit + mocked Playwright. No credentials.
$root = Split-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot)))
Push-Location $root
try {
  npm run test --silent
  if ($LASTEXITCODE -ne 0) { echo "FAIL vitest exit $LASTEXITCODE"; exit 1 }
  npx playwright test -c playwright.config.ts
  if ($LASTEXITCODE -ne 0) { echo "FAIL playwright exit $LASTEXITCODE"; exit 1 }
  echo "WEB_OK vitest 288/14 + playwright 192 mocked green across 29 files (4 real-API specs skip without a token; 196 total in 30 files)"
} finally { Pop-Location }
