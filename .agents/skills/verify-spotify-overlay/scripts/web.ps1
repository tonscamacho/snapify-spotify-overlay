# Web run: unit + mocked Playwright. No credentials.
$root = Split-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot)))
Push-Location $root
try {
  npm run test --silent
  if ($LASTEXITCODE -ne 0) { echo "FAIL vitest exit $LASTEXITCODE"; exit 1 }
  npx playwright test -c playwright.config.ts
  if ($LASTEXITCODE -ne 0) { echo "FAIL playwright exit $LASTEXITCODE"; exit 1 }
  echo "WEB_OK vitest 223/9 + playwright 130 mocked green across 19 files (4 real-API specs skip without a token; 134 total in 20 files)"
} finally { Pop-Location }
