# Stops the background gateway started by e2e-serve.ps1 on the given port.
# Usage: pnpm e2e:stop -- -Port 3900
param([int]$Port = 3000)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $root ".e2e/server-$Port.pid"

if ($IsWindows) {
    $listeners = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    foreach ($owner in ($listeners.OwningProcess | Sort-Object -Unique)) {
        Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $pidPath) {
        $launcherId = [int](Get-Content $pidPath -Raw)
        Stop-Process -Id $launcherId -Force -ErrorAction SilentlyContinue
    }
} elseif (Test-Path $pidPath) {
    $serverId = [int](Get-Content $pidPath -Raw)
    bash -c "kill $serverId 2>/dev/null; sleep 1; kill -9 $serverId 2>/dev/null" | Out-Null
}
Remove-Item $pidPath -ErrorAction SilentlyContinue
"Stopped server on port $Port"
