# Starts the built gateway (`next start`) in the background and returns as soon as /health answers.
# The server is launched through WMI (Windows) or nohup (elsewhere), so it is NOT a child of the
# calling shell and holds none of its handles. Agent shells therefore never hang waiting for it.
# Usage: pnpm e2e:serve -- -Port 3900
param(
    [int]$Port = 3000,
    [int]$TimeoutSeconds = 120
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root '.e2e'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$logPath = Join-Path $stateDir "server-$Port.log"
$pidPath = Join-Path $stateDir "server-$Port.pid"
$nextBin = Join-Path $root 'node_modules/next/dist/bin/next'

if (Test-Path $pidPath) {
    & (Join-Path $PSScriptRoot 'e2e-stop.ps1') -Port $Port | Out-Null
}

if ($IsWindows) {
    $command = "cmd.exe /c set PORT=$Port&& node `"$nextBin`" start -p $Port > `"$logPath`" 2>&1"
    # ShowWindow = 0 (SW_HIDE): the cmd/node console is created hidden, so no window pops up.
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command; CurrentDirectory = $root; ProcessStartupInformation = $startup }
    if ($result.ReturnValue -ne 0) { throw "Could not start the server (WMI return value $($result.ReturnValue))." }
    $result.ProcessId | Set-Content $pidPath
} else {
    $launcher = "cd '$root' && PORT=$Port nohup node '$nextBin' start -p $Port > '$logPath' 2>&1 & echo `$!"
    (bash -c $launcher) | Set-Content $pidPath
}

$launcherId = [int](Get-Content $pidPath -Raw)
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $launcherId -ErrorAction SilentlyContinue)) {
        "Server process exited before listening on port $Port. Last log lines:"
        Get-Content $logPath -Tail 30 -ErrorAction SilentlyContinue
        Remove-Item $pidPath -ErrorAction SilentlyContinue
        exit 1
    }
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        if ($client.ConnectAsync('127.0.0.1', $Port).Wait(1000)) {
            $health = try { (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5 -SkipHttpErrorCheck).StatusCode } catch { 'no response' }
            "Server ready on port $Port, /health = $health (log: .e2e/server-$Port.log)"
            exit 0
        }
    } catch { } finally { $client.Dispose() }
    Start-Sleep -Seconds 1
}
"Server did not become healthy on port $Port within $TimeoutSeconds s. Last log lines:"
Get-Content $logPath -Tail 30 -ErrorAction SilentlyContinue
exit 1
