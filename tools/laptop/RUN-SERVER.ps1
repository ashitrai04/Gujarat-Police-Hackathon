<#
.SYNOPSIS
    Start the Sentinel server half. Run SETUP.ps1 once first.

.DESCRIPTION
    Starts the continuous worker: plate reading plus crowd, fire and accident
    over every camera in the registry, writing to Supabase. That is the part
    the control room reads, and it needs no inbound access to this laptop.

    -WithSearch also starts the prompt-search service, which is the only thing
    the browser calls directly, and so the only thing that needs a tunnel.

    Windows has no setsid, so these hold the window open. Closing it stops
    them. Leave it running, or wrap it with NSSM to survive a logout.

.EXAMPLE
    .\RUN-SERVER.ps1
    .\RUN-SERVER.ps1 -Seconds 45
    .\RUN-SERVER.ps1 -WithSearch
    .\RUN-SERVER.ps1 -TestOnly
#>
[CmdletBinding()]
param(
    [int] $Seconds = 30,
    [string] $Events = 'crowd,fire,accident',
    [switch] $WithSearch,
    [switch] $TestOnly
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$py = Join-Path $root '.venv\Scripts\python.exe'
$pipeline = Join-Path $root 'pipeline'

if (-not (Test-Path $py)) {
    Write-Host "No .venv here. Run SETUP.ps1 first." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $pipeline '.env.worker'))) {
    Write-Host "No pipeline\.env.worker. Run SETUP.ps1 first - without" -ForegroundColor Red
    Write-Host "credentials nothing can be stored." -ForegroundColor Red
    exit 1
}

Push-Location $pipeline
try {
    if ($TestOnly) {
        # Proves the whole chain on one live camera without committing to a
        # long run: sign-in, capture, decode, both models, and the write.
        Write-Host "Scene analysis on one live camera (cam08)..." -ForegroundColor Cyan
        & $py events.py "https://cctv.corp8.cloud/cam08/index.m3u8" `
            --camera cam08 --seconds 20 --store-all
        Write-Host "`nIf that wrote rows, everything works. Run without" -ForegroundColor Cyan
        Write-Host "-TestOnly to start the continuous worker." -ForegroundColor Cyan
        return
    }

    if ($WithSearch) {
        $index = Join-Path $root '_index'
        if (Test-Path $index) {
            Write-Host "Starting prompt search on http://127.0.0.1:8077" -ForegroundColor Cyan
            Start-Process -FilePath $py `
                -ArgumentList '-m', 'ask.serve', '--index', $index, '--host', '127.0.0.1', '--port', '8077' `
                -WorkingDirectory $pipeline
            Write-Host "  It is local-only. For the deployed site to reach it," -ForegroundColor Yellow
            Write-Host "  run:  cloudflared tunnel --url http://localhost:8077" -ForegroundColor Yellow
            Write-Host "  then open <your site>/?ask=<the printed URL>" -ForegroundColor Yellow
        } else {
            Write-Host "No search index at $index - skipping prompt search." -ForegroundColor Yellow
            Write-Host "Build one with:  python -m ask.index --footage <folder>" -ForegroundColor Yellow
        }
    }

    Write-Host ""
    Write-Host "==============================================================="
    # Tee to a file as well as the window.
    #
    # Start-Transcript does NOT capture this: the worker is a native process,
    # and a transcript only records what PowerShell itself writes. Wrapping the
    # launch in one records the banner and nothing else, which looks like a
    # worker producing no output when it is in fact working normally.
    #
    # The streams are merged inside cmd, not by PowerShell. In 5.1, letting
    # PowerShell redirect a native command's stderr wraps every line in a
    # NativeCommandError, so a plain warning arrives looking like a crash.
    # Merging at the OS level keeps the output exactly as the worker wrote it,
    # with stderr interleaved in the right order.
    $log = Join-Path $root 'worker.log'
    Write-Host " Worker running: plates + $Events, $Seconds s per camera"
    Write-Host " Writing to Supabase. Ctrl-C stops it."
    Write-Host " Log: $log"
    Write-Host "==============================================================="
    Write-Host ""
    & cmd /c "`"$py`" -u live_worker.py --seconds $Seconds --events $Events 2>&1" |
        Tee-Object -FilePath $log -Append
}
finally {
    Pop-Location
}
