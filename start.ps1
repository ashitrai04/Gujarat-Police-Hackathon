# Sentinel — bring the whole console up on this machine.
#
#   .\start.ps1              # everything: Ollama, the search service, the web app
#   .\start.ps1 -NoAsk       # web app only, no prompt search
#   .\start.ps1 -Tunnel      # also expose the search service so a hosted page can reach it
#   .\start.ps1 -Status      # report what is running and stop
#   .\start.ps1 -Stop        # shut it all down
#
# Order matters and the script enforces it. The retrieval model and the
# language model both want host memory while they load, and on a 16 GB laptop
# with a 6 GB card the wrong order fails with a Windows commit-charge error
# ("the paging file is too small") that reads like a corrupt download.

param(
    [switch] $NoAsk,
    [switch] $Tunnel,
    [switch] $Status,
    [switch] $Stop
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$python = Join-Path (Split-Path -Parent $root) '.venv\Scripts\python.exe'
$ollamaExe = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
$cloudflared = "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe"
$ngrok = (Get-Command ngrok -ErrorAction SilentlyContinue).Source

function Test-Port([int] $Port) {
    [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Show-Status {
    $rows = @(
        @{ n = 'Ollama          :11434'; up = (Test-Port 11434) }
        @{ n = 'Search service  :8077 '; up = (Test-Port 8077) }
        @{ n = 'Web app         :5173 '; up = (Test-Port 5173) }
        @{ n = 'Tunnel                '; up = [bool](Get-Process cloudflared, ngrok -ErrorAction SilentlyContinue) }
    )
    Write-Host ''
    foreach ($r in $rows) {
        $mark = if ($r.up) { 'up  ' } else { 'DOWN' }
        $col = if ($r.up) { 'Green' } else { 'DarkGray' }
        Write-Host ("  {0}  {1}" -f $r.n, $mark) -ForegroundColor $col
    }
    Write-Host ''
}

# ── Stop ───────────────────────────────────────────────────────────────
if ($Stop) {
    Write-Host 'Stopping...' -ForegroundColor Cyan
    # By command line, not by port. HTTPServer sets allow_reuse_address, so on
    # Windows a second instance binds the same port instead of failing and
    # requests go to whichever answers first — killing "the one on 8077" can
    # leave an older one alive and serving stale code.
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
        Where-Object { $_.CommandLine -like '*ask.serve*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*vite*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-Process cloudflared, ngrok -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Show-Status
    return
}

if ($Status) { Show-Status; return }

# ── Ollama ─────────────────────────────────────────────────────────────
if (-not (Test-Port 11434)) {
    Write-Host 'Starting Ollama...' -ForegroundColor Cyan
    if (-not (Test-Path $ollamaExe)) { Write-Error "Ollama not found at $ollamaExe" }
    Start-Process -FilePath $ollamaExe -ArgumentList 'serve' -WindowStyle Hidden
    $n = 0
    while (-not (Test-Port 11434) -and $n -lt 40) { Start-Sleep -Milliseconds 500; $n++ }
}
Write-Host '  Ollama ready' -ForegroundColor Green

# ── Search service ─────────────────────────────────────────────────────
if (-not $NoAsk) {
    $index = Join-Path $root 'pipeline\ask\_index\vectors.npy'
    if (-not (Test-Path $index)) {
        Write-Host '  No search index. Build one with:' -ForegroundColor Yellow
        Write-Host '    cd pipeline; python -m ask.index <folder-of-mp4s> --every 1.0' -ForegroundColor Yellow
    } else {
        # The token is read from .env so the service and the browser agree
        # without it being typed twice.
        $askToken = ''
        $envFile = Join-Path $root '.env'
        if (Test-Path $envFile) {
            $m = Select-String -Path $envFile -Pattern '^VITE_ASK_TOKEN=(.+)$' | Select-Object -First 1
            if ($m) { $askToken = $m.Matches[0].Groups[1].Value.Trim() }
        }

        if (Test-Port 8077) {
            Write-Host '  Search service already up' -ForegroundColor Green
        } else {
            Write-Host 'Starting the search service (loads ~1 GB of models)...' -ForegroundColor Cyan
            $cmd = "`$env:HF_HUB_OFFLINE='1'; `$env:ASK_TOKEN='$askToken'; " +
                   "Set-Location '$root\pipeline'; & '$python' -u -m ask.serve --port 8077"
            Start-Process powershell -ArgumentList '-NoProfile', '-NoExit', '-Command', $cmd -WindowStyle Minimized
            $n = 0
            while (-not (Test-Port 8077) -and $n -lt 180) { Start-Sleep -Seconds 1; $n++ }
            if (Test-Port 8077) { Write-Host '  Search service ready' -ForegroundColor Green }
            else { Write-Host '  Search service did not come up — check its window' -ForegroundColor Red }
        }
    }
}

# ── Web app ────────────────────────────────────────────────────────────
if (Test-Port 5173) {
    Write-Host '  Web app already up' -ForegroundColor Green
} else {
    Write-Host 'Starting the web app...' -ForegroundColor Cyan
    # The demo credentials are passed to this process only. Putting them in
    # .env would hand the shared account to anyone who can read the repo.
    $cmd = "Set-Location '$root'; npm run dev -- --host --port 5173 --strictPort"
    Start-Process powershell -ArgumentList '-NoProfile', '-NoExit', '-Command', $cmd -WindowStyle Minimized
    $n = 0
    while (-not (Test-Port 5173) -and $n -lt 90) { Start-Sleep -Seconds 1; $n++ }
    if (Test-Port 5173) { Write-Host '  Web app ready' -ForegroundColor Green }
}

# ── Optional tunnel ────────────────────────────────────────────────────
#
# ngrok with a reserved domain when one is configured, because the address has
# to survive a restart. A Cloudflare quick tunnel invents a new hostname every
# time it starts, so anything pointed at yesterday's is already broken — which
# is fine for one demo and useless as a permanent arrangement.
if ($Tunnel -and -not $NoAsk) {
    $domain = ''
    $envFile = Join-Path $root '.env'
    if (Test-Path $envFile) {
        $m = Select-String -Path $envFile -Pattern '^NGROK_DOMAIN=(.+)$' | Select-Object -First 1
        if ($m) { $domain = $m.Matches[0].Groups[1].Value.Trim() }
    }

    if (Get-Process ngrok, cloudflared -ErrorAction SilentlyContinue) {
        Write-Host '  Tunnel already running' -ForegroundColor Green
    } elseif ($ngrok -and $domain) {
        Write-Host "Opening the tunnel at $domain ..." -ForegroundColor Cyan
        # The flag was renamed: --domain up to about 3.20, --url after it.
        # Ask the binary rather than assume, so this keeps working across an
        # ngrok update instead of failing with "unknown flag" on whichever
        # one it is not.
        $help = & $ngrok http --help 2>&1 | Out-String
        $tunnelArgs = if ($help -match '--url ') {
            @('http', '8077', '--url', "https://$domain")
        } else {
            @('http', '8077', '--domain', $domain)
        }
        Start-Process $ngrok -ArgumentList $tunnelArgs -WindowStyle Minimized
        Start-Sleep -Seconds 4
        Write-Host "  https://$domain  - the same address every time" -ForegroundColor Green
    } elseif ($ngrok) {
        Write-Host '  ngrok is installed but no NGROK_DOMAIN is set in .env.' -ForegroundColor Yellow
        Write-Host '  Reserve a free domain at dashboard.ngrok.com > Domains, then add' -ForegroundColor Yellow
        Write-Host '    NGROK_DOMAIN=<your-name>.ngrok-free.app' -ForegroundColor Yellow
        Write-Host '  A random address is no use: it would have to be re-pasted each time.' -ForegroundColor Yellow
    } elseif (Test-Path $cloudflared) {
        Write-Host 'No ngrok domain configured; opening a throwaway tunnel.' -ForegroundColor Yellow
        Start-Process $cloudflared -ArgumentList 'tunnel', '--url', 'http://127.0.0.1:8077', '--no-autoupdate'
        Write-Host '  Its URL changes on every restart — read it from that window.' -ForegroundColor Yellow
    } else {
        Write-Host '  No tunnel tool:  winget install ngrok.ngrok' -ForegroundColor Yellow
    }
}

Show-Status
$lan = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object -First 1).IPAddress
Write-Host "  Console      http://localhost:5173"
if ($lan) { Write-Host "  Same network http://${lan}:5173" }
Write-Host ''
Write-Host '  The first question after a quiet spell takes ~12s: Ollama unloads the' -ForegroundColor DarkGray
Write-Host '  model when idle and has to load 3 GB back onto the card. It is not stuck.' -ForegroundColor DarkGray
Write-Host ''
