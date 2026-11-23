# One-shot e2e: start the built app in the background, run Playwright, always stop the app.
# Exits with Playwright's exit code. Build first with `pnpm build`.
# Usage: pnpm e2e:run -- -Port 3900 -MockPort 4911 [-Specs e2e/agents.spec.ts,e2e/layout.spec.ts] [-Grep "chatflow"]
param(
    [int]$Port = 3000,
    [int]$MockPort = 4010,
    [string[]]$Specs = @(),
    [string]$Grep = ''
)
$ErrorActionPreference = 'Continue'
& (Join-Path $PSScriptRoot 'e2e-serve.ps1') -Port $Port
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$env:E2E_BASE_URL = "http://localhost:$Port"
$env:MOCK_UPSTREAM_PORT = "$MockPort"
# Through `pnpm e2e:run -- -Specs a,b` the list can arrive as one "a b" or "a,b" string.
$specList = @($Specs | ForEach-Object { $_ -split '[,\s]+' } | Where-Object { $_ })
$playwrightArgs = @('exec', 'playwright', 'test') + $specList
if ($Grep) { $playwrightArgs += @('--grep', $Grep) }
try {
    & pnpm @playwrightArgs
    $code = $LASTEXITCODE
} finally {
    & (Join-Path $PSScriptRoot 'e2e-stop.ps1') -Port $Port | Out-Null
}
exit $code
