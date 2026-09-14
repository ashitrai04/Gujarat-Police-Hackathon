# Sentinel — run the whole platform on this laptop.
#
# Starts two things and keeps them running:
#
#   1. the web application, bound to 0.0.0.0 so other devices on the same
#      network can open it;
#   2. the ANPR worker, looping over cameras and writing sightings into
#      Supabase.
#
# The worker deliberately has no public endpoint. It is a writer: the browser
# never calls it, the control room reads `detections` from Postgres, and the
# worker's only job is to put rows there. That is also why the deployed Vercel
# app shows the same data — anything this laptop writes is visible anywhere,
# without exposing the laptop.
#
#   .\start_local.ps1                       # everything, default cameras
#   .\start_local.ps1 -Cameras cam08,cam04  # specific cameras
#   .\start_local.ps1 -NoWorker             # web only
#   .\start_local.ps1 -NoWeb                # worker only

param(
    [string] $Cameras   = "cam08,cam19,cam20,cam23",
    [int]    $Seconds   = 45,
    [int]    $LoopEvery = 600,
    [string] $Source    = "hls",     # hls survives networks that block 8554
    [switch] $NoWorker,
    [switch] $NoWeb
)

$ErrorActionPreference = "Stop"
$root   = Split-Path -Parent $PSScriptRoot
$python = Join-Path (Split-Path -Parent $root) ".venv\Scripts\python.exe"

if (-not (Test-Path $python)) {
    Write-Error "Python venv not found at $python"
}

# ── Read .env so the worker gets the same project the web app uses ──────
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) { Write-Error "No .env at $envFile" }

$cfg = @{}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim() }
}

$env:SUPABASE_URL = $cfg['VITE_SUPABASE_URL']
$env:SENTINEL_PIPELINE_DIR = Join-Path $root "pipeline\sentinel-gujarat-pipeline"

# The service key is intentionally NOT read from .env: that file feeds the
# browser bundle, and a service-role key there would ship full database access
# to every visitor. Set it in this shell only.
if (-not $env:SUPABASE_SERVICE_KEY) {
    Write-Host "SUPABASE_SERVICE_KEY is not set in this shell." -ForegroundColor Yellow
    Write-Host "The worker will print detections instead of storing them." -ForegroundColor Yellow
    Write-Host 'Set it with:  $env:SUPABASE_SERVICE_KEY = "eyJ..."' -ForegroundColor Yellow
    Write-Host ""
}

if (-not (Test-Path $env:SENTINEL_PIPELINE_DIR)) {
    Write-Host "Cloning the detection pipeline..." -ForegroundColor Cyan
    git clone --depth 1 https://github.com/ayushtriapty88-hue/sentinel-gujarat-pipeline.git `
        $env:SENTINEL_PIPELINE_DIR
}

# ── Web application ────────────────────────────────────────────────────
if (-not $NoWeb) {
    Write-Host "Starting the web application..." -ForegroundColor Cyan
    # --host binds every interface so a phone or a second laptop on the same
    # Wi-Fi can open it. Only do this on a network you trust.
    Start-Process -FilePath "npm" -ArgumentList "run","dev","--","--host" `
        -WorkingDirectory $root -WindowStyle Minimized

    $lan = (Get-NetIPAddress -AddressFamily IPv4 |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
            Select-Object -First 1).IPAddress
    Write-Host "  this machine : http://localhost:5173"
    if ($lan) { Write-Host "  other devices: http://${lan}:5173" }
    Write-Host "  deployed     : https://gujarat-police-hackathon.vercel.app"
    Write-Host ""
}

# ── ANPR worker ────────────────────────────────────────────────────────
if (-not $NoWorker) {
    Write-Host "Starting the ANPR worker..." -ForegroundColor Cyan
    Write-Host "  cameras: $Cameras"
    Write-Host "  $Seconds s per camera, a pass every $LoopEvery s, over $Source"
    Write-Host "  Ctrl+C stops it; the web app keeps running."
    Write-Host ""

    # With the web app running here, the worker fetches through its proxy and
    # shares its grid session: the grid allows one session per address, and two
    # separate sign-ins from this machine evict each other.
    $via = @()
    if (-not $NoWeb -and $Source -eq "hls") { $via = @("--hls-host", "http://localhost:5173/sentinel") }

    & $python (Join-Path $PSScriptRoot "run_batch.py") `
        --cameras $Cameras --seconds $Seconds --loop $LoopEvery --source $Source @via
}
