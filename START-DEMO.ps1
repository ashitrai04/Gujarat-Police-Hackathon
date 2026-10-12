<#
.SYNOPSIS
    Bring the Sentinel demo server up on this laptop.

.DESCRIPTION
    Starts the prompt-search service and the ngrok tunnel on the reserved
    domain the deployed site already points at. Ollama runs as a Windows
    service and starts with the machine, so it is only checked here.

    Safe to re-run: anything already up is left alone.

    Run this after a reboot. The two processes it starts survive the terminal
    closing but not a logout.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\START-DEMO.ps1
    .\START-DEMO.ps1 -Status
    .\START-DEMO.ps1 -Stop
#>
[CmdletBinding()]
param([switch] $Status, [switch] $Stop)

$ErrorActionPreference = 'Stop'

# The token the deployed site was built with. The service and Vercel must
# agree or every request comes back 401 -- which the page reports as "not
# answering", so a mismatch looks like a network fault.
$TOKEN  = 'hZNkBd9KJ7alpKelxk0YHuc2'
$DOMAIN = 'moonlight-grading-ferret.ngrok-free.dev'
$PORT   = 8077

$root = $PSScriptRoot
$py   = 'D:\React folder\.venv\Scripts\python.exe'
$ngrok = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe\ngrok.exe"
$pipeline = Join-Path $root 'pipeline'
$index = 'ask\_index'          # relative: the absolute path has a space in it

function Probe($url) {
    try {
        $r = Invoke-WebRequest -Uri $url -TimeoutSec 15 -UseBasicParsing `
             -Headers @{ 'x-ask-token' = $TOKEN; 'ngrok-skip-browser-warning' = '1' }
        return $r.Content
    } catch { return $null }
}

if ($Stop) {
    Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
        Where-Object { $_.CommandLine -like '*ask.serve*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Write-Host "stopped"
    exit 0
}

if ($Status) {
    Write-Host "local   : $(if (Probe "http://127.0.0.1:$PORT/health") { 'up' } else { 'DOWN' })"
    Write-Host "tunnel  : $(if (Probe "https://$DOMAIN/health") { 'up' } else { 'DOWN' })"
    Write-Host "ollama  : $(if (Probe 'http://127.0.0.1:11434/api/tags') { 'up' } else { 'DOWN' })"
    exit 0
}

Write-Host "=============================================================="
Write-Host " Sentinel demo server"
Write-Host "=============================================================="

# -- 1. Ollama --------------------------------------------------------------
# Installed as a Windows service, so normally already running. Only the
# prompt parser needs it; retrieval works without it, at lower quality.
Write-Host "`n[1/3] Ollama"
if (Probe 'http://127.0.0.1:11434/api/tags') {
    Write-Host "      up"
} else {
    Write-Host "      starting"
    Start-Process -FilePath 'ollama' -ArgumentList 'serve' -WindowStyle Hidden -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 8
    Write-Host "      $(if (Probe 'http://127.0.0.1:11434/api/tags') { 'up' } else { 'still down - queries will use the fallback parser' })"
}

# -- 2. Search service ------------------------------------------------------
Write-Host "`n[2/3] search service (port $PORT)"
if (Probe "http://127.0.0.1:$PORT/health") {
    Write-Host "      already up"
} else {
    $env:ASK_TOKEN = $TOKEN
    Start-Process -FilePath $py `
        -ArgumentList '-u','-m','ask.serve','--index',$index,'--host','127.0.0.1','--port',"$PORT" `
        -WorkingDirectory $pipeline `
        -RedirectStandardOutput "$env:TEMP\ask.out" -RedirectStandardError "$env:TEMP\ask.err" `
        -WindowStyle Hidden | Out-Null
    # Loading SigLIP takes the better part of a minute on a cold start.
    Write-Host "      loading" -NoNewline
    $body = $null
    foreach ($i in 1..40) {
        Start-Sleep -Seconds 3
        $body = Probe "http://127.0.0.1:$PORT/health"
        if ($body) { break }
        Write-Host "." -NoNewline
    }
    Write-Host ""
    if ($body) { Write-Host "      $body" }
    else {
        Write-Host "      DID NOT START. Last error:" -ForegroundColor Red
        Get-Content "$env:TEMP\ask.err" -Tail 12 -ErrorAction SilentlyContinue
        exit 1
    }
}

# -- 3. Tunnel --------------------------------------------------------------
# The free tier allows one agent online, so anything else holding this domain
# -- a Kaggle session, another laptop -- has to stop first.
Write-Host "`n[3/3] tunnel ($DOMAIN)"
if (Probe "https://$DOMAIN/health") {
    Write-Host "      already up"
} else {
    Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Process -FilePath $ngrok `
        -ArgumentList 'http',"$PORT",'--url',"https://$DOMAIN",'--log','stdout' `
        -RedirectStandardOutput "$env:TEMP\ngrok.out" -RedirectStandardError "$env:TEMP\ngrok.err" `
        -WindowStyle Hidden | Out-Null
    Write-Host "      connecting" -NoNewline
    $ok = $null
    foreach ($i in 1..15) {
        Start-Sleep -Seconds 3
        $ok = Probe "https://$DOMAIN/health"
        if ($ok) { break }
        Write-Host "." -NoNewline
    }
    Write-Host ""
    if ($ok) { Write-Host "      up" }
    else {
        Write-Host "      NOT ANSWERING." -ForegroundColor Red
        Write-Host "      Most likely another ngrok agent holds this domain --" -ForegroundColor Yellow
        Write-Host "      a Kaggle session or the other laptop. Stop it, re-run." -ForegroundColor Yellow
        Get-Content "$env:TEMP\ngrok.err" -Tail 8 -ErrorAction SilentlyContinue
    }
}

Write-Host "`n=============================================================="
Write-Host " https://$DOMAIN"
Write-Host " Reload the site; the assistant connects on its own."
Write-Host ""
Write-Host " .\START-DEMO.ps1 -Status    what is up"
Write-Host " .\START-DEMO.ps1 -Stop      shut it down"
Write-Host "=============================================================="
