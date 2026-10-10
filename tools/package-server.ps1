<#
.SYNOPSIS
    Build a zip of the Sentinel server half, to carry to another machine.

.DESCRIPTION
    Collects what that machine actually needs and nothing else: the pipeline,
    the migrations, the Windows launcher, the setup guide, and the parts that
    are deliberately absent from Git and so cannot be obtained by cloning --
    chiefly pipeline/sentinel-gujarat-pipeline, without which plate reading
    fails on a fresh checkout.

    Secrets are excluded by pattern and then checked for again in the staged
    copy before anything is compressed. A build that would ship a key fails
    instead. An archive is handed to someone else and may be copied onward,
    so "probably excluded" is not good enough.

    Ollama models are NOT included. They live in Ollama's own store, this
    machine has none, and they are pulled on the far side -- the guide says so.

.PARAMETER Output
    Where to write the zip. Defaults to the Desktop.

.PARAMETER NoWeights
    Leave out pipeline/weights (~1.1 GB of SigLIP and CLIP). Smaller archive,
    but the far side re-downloads them, and the full-precision SigLIP download
    is the one that fails on a 16 GB Windows machine with "the paging file is
    too small" -- which is why the fp16 copy exists and is worth carrying.

.EXAMPLE
    .\tools\package-server.ps1
    .\tools\package-server.ps1 -NoWeights -Output D:\sentinel-server.zip
#>
[CmdletBinding()]
param(
    [string] $Output = "$([Environment]::GetFolderPath('Desktop'))\sentinel-server.zip",
    [switch] $NoWeights
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $env:TEMP "sentinel-pack-$(Get-Random)"
$root = Join-Path $stage 'sentinel-server'

Write-Host "repo   : $repo"
Write-Host "staging: $stage"
New-Item -ItemType Directory -Path $root -Force | Out-Null

# Directories whose contents are never useful on the far side: build output,
# caches, local scratch, and the index, which is rebuilt from footage anyway.
$skipDirs = @(
    '.git', 'node_modules', 'dist', '__pycache__', '.venv', 'venv',
    '.vercel', '_capture', '_index', '_eval', '.pytest_cache', 'output'
)
# Anything matching these is a credential or a local override.
$skipFiles = @('.env', '.env.*', '*.key', '*.pem', 'creds.sh', '*.log')

function Copy-Tree {
    param([string] $From, [string] $To)
    if (-not (Test-Path $From)) {
        Write-Host "  (absent) $From"
        return
    }
    New-Item -ItemType Directory -Path $To -Force | Out-Null
    Get-ChildItem -Path $From -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($From.Length).TrimStart('\')
        $parts = $rel -split '\\'
        # Drop anything sitting inside a skipped directory at any depth.
        if ($parts | Where-Object { $skipDirs -contains $_ }) { return }
        foreach ($pat in $skipFiles) { if ($_.Name -like $pat) { return } }
        $dest = Join-Path $To $rel
        New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
        Copy-Item $_.FullName $dest
    }
}

Write-Host "`ncollecting:"
Write-Host "  pipeline/"
Copy-Tree (Join-Path $repo 'pipeline') (Join-Path $root 'pipeline')

if ($NoWeights) {
    $w = Join-Path $root 'pipeline\weights'
    if (Test-Path $w) { Remove-Item $w -Recurse -Force }
    Write-Host "  pipeline/weights  - skipped (-NoWeights)"
}

Write-Host "  supabase/migrations/"
Copy-Tree (Join-Path $repo 'supabase\migrations') (Join-Path $root 'supabase\migrations')

foreach ($f in @('start.ps1', 'README.md')) {
    $src = Join-Path $repo $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $root $f); Write-Host "  $f" }
}

$guide = Join-Path $repo 'pipeline\ask\server\LAPTOP_SETUP.md'
if (Test-Path $guide) {
    Copy-Item $guide (Join-Path $root 'LAPTOP_SETUP.md')
    Write-Host "  LAPTOP_SETUP.md  (also at the top level, so it is seen)"
}

# -- Refuse to ship a secret ------------------------------------------------
# The exclusions above are patterns, and a pattern only catches what it was
# written for. This looks at the staged bytes for the shapes a key actually
# takes, so a file nobody thought of still gets caught.
Write-Host "`nchecking the staged copy for credentials:"
# A plain foreach, not ForEach-Object. A pipeline block runs in a child scope,
# so `$leaks += ...` inside one assigns to a local copy and the parent array
# stays empty -- the check reports "clean" no matter what it finds. Caught by
# planting a JWT-shaped string and watching the build sail past it.
$leaks = @()
$scan = Get-ChildItem -Path $root -Recurse -File | Where-Object {
    $_.Length -lt 2MB -and
    $_.Extension -notin '.pt', '.onnx', '.bin', '.safetensors', '.mp4', '.jpg', '.png'
}
foreach ($f in $scan) {
    $text = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $text) { continue }
    # A Supabase service key is a JWT; HF and ngrok tokens have their own
    # shapes. Matching the shape, never a particular value.
    $isJwt = $text -match 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
    $isHf = $text -match 'hf_[A-Za-z0-9]{30,}'
    $isNgrok = $text -match '[0-9A-Za-z]{24,}_[0-9A-Za-z]{20,}'
    if ($isJwt -or $isHf -or $isNgrok) {
        $why = @(); if ($isJwt) { $why += 'JWT' }; if ($isHf) { $why += 'HF token' }
        if ($isNgrok) { $why += 'ngrok token' }
        $leaks += ('{0}  [{1}]' -f $f.FullName.Substring($root.Length).TrimStart('\'),
                   ($why -join ', '))
    }
}
if ($leaks.Count) {
    Write-Host "`n  REFUSING TO BUILD - these look like they carry a key:" -ForegroundColor Red
    $leaks | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    Write-Host "`n  Remove them, or add them to `$skipFiles, then run again." -ForegroundColor Red
    Remove-Item $stage -Recurse -Force
    exit 1
}
Write-Host "  clean - no key-shaped strings in the staged files"

# -- Compress ---------------------------------------------------------------
if (Test-Path $Output) { Remove-Item $Output -Force }
New-Item -ItemType Directory -Path (Split-Path $Output) -Force -ErrorAction SilentlyContinue | Out-Null
Write-Host "`ncompressing..."
Compress-Archive -Path $root -DestinationPath $Output -CompressionLevel Optimal

$files = (Get-ChildItem $root -Recurse -File).Count
$mb = [math]::Round((Get-Item $Output).Length / 1MB, 1)
Remove-Item $stage -Recurse -Force

Write-Host "`n$Output"
Write-Host "  $files files, $mb MB"
Write-Host ""
Write-Host "On the other laptop: unzip it, open LAPTOP_SETUP.md, and follow"
Write-Host "the Windows or Linux section. Credentials are not in the archive"
Write-Host "and are entered once there; the guide lists which four."
if (-not $NoWeights) {
    Write-Host "Weights are included, so only Ollama's model has to download."
}
