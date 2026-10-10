<#
.SYNOPSIS
    One-time setup for the Sentinel server half on a Windows laptop.

.DESCRIPTION
    Run this once after unzipping. It installs what is missing, creates the
    environment, pulls the language model, asks for the four credentials, and
    checks the result. Afterwards RUN-SERVER.ps1 starts everything.

    Safe to re-run. Every step checks before acting, so a second run repairs
    whatever failed the first time rather than starting over.

    Most of the time is downloads: roughly 3 GB for the language model and
    2-3 GB for PyTorch. On a slow connection expect half an hour.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\SETUP.ps1
#>
[CmdletBinding()]
param(
    [string] $Model = 'qwen2.5vl:3b',
    [switch] $SkipModel
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$venv = Join-Path $root '.venv'
$py = Join-Path $venv 'Scripts\python.exe'

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    $text" -ForegroundColor Yellow }
function Die($text) { Write-Host "`n    $text" -ForegroundColor Red; exit 1 }

Write-Host "==============================================================="
Write-Host " Sentinel server - one-time setup"
Write-Host "==============================================================="
Write-Host " Folder: $root"

# -- 1. Python ---------------------------------------------------------------
Step 1 "Python"
$sysPy = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $sysPy) {
    Warn "not found - installing via winget"
    winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
    Warn "Python installed. CLOSE this window, open a new one, and run SETUP.ps1 again"
    Warn "so the new PATH is picked up."
    exit 0
}
$ver = & python -c "import sys;print('%d.%d'%sys.version_info[:2])"
Ok "python $ver at $sysPy"
if ([version]$ver -lt [version]'3.10' -or [version]$ver -ge [version]'3.13') {
    Warn "3.10-3.12 is what this is tested on. Continuing, but if the installs"
    Warn "below fail on a wheel, that is why."
}

# -- 2. GPU ------------------------------------------------------------------
Step 2 "Graphics card"
$hasCuda = $false
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    $name = (& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader) -join '; '
    Ok "$name"
    $hasCuda = $true
} else {
    Warn "no NVIDIA driver found - everything still runs, on the CPU."
    Warn "Expect a pass over one camera to take minutes rather than seconds."
}

# -- 3. Environment ----------------------------------------------------------
Step 3 "Python environment"
if (Test-Path $py) {
    Ok "already at .venv"
} else {
    & python -m venv $venv
    if (-not (Test-Path $py)) { Die "could not create .venv" }
    Ok "created .venv"
}
& $py -m pip install --quiet --upgrade pip setuptools wheel

# -- 4. PyTorch --------------------------------------------------------------
# Installed before everything else and on its own. Pulled in as a dependency
# of something else, pip resolves the CPU build and the card goes unused with
# no error to say so.
Step 4 "PyTorch"
# "Already fine" means torch imports, and sees the card if there is one.
# Torch installed without CUDA on a machine that has a card is the quiet
# failure worth catching: everything runs, just thirty times slower.
$probe = 'import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)'
if (-not $hasCuda) { $probe = 'import torch,sys; sys.exit(0)' }
& $py -c $probe 2>$null
$torchOk = ($LASTEXITCODE -eq 0)
if ($torchOk) {
    $t = & $py -c "import torch;print(torch.__version__, 'cuda' if torch.cuda.is_available() else 'cpu')" 2>$null
    Ok "already installed: $t"
} else {
    if ($hasCuda) {
        Warn "installing the CUDA build (~2.5 GB)"
        & $py -m pip install --quiet torch torchvision --index-url https://download.pytorch.org/whl/cu124
    } else {
        Warn "installing the CPU build"
        & $py -m pip install --quiet torch torchvision
    }
    $t = & $py -c "import torch;print(torch.__version__, 'cuda' if torch.cuda.is_available() else 'cpu')"
    Ok "$t"
    if ($hasCuda -and $t -notmatch 'cuda') {
        Warn "a card is present but torch cannot see it. Update the NVIDIA driver."
    }
}

# -- 5. The rest -------------------------------------------------------------
Step 5 "Pipeline packages"
$req = Join-Path $root 'pipeline\requirements.txt'
if (Test-Path $req) { & $py -m pip install --quiet -r $req }
& $py -m pip install --quiet supabase paddleocr paddlepaddle `
    "open-image-models[onnx]" opencv-python-headless imageio-ffmpeg `
    transformers pillow numpy ultralytics
# Imported by name only, so the patch has something to attach to; PaddleOCR
# does the actual reading. Checked here so a missing one is a line of output
# rather than a crash mid-pass.
$missing = & $py -c @"
import importlib.util as u
names = ['supabase','paddleocr','paddle','open_image_models','cv2','torch',
         'transformers','ultralytics','PIL','numpy']
print(','.join(n for n in names if not u.find_spec(n)))
"@
if ($missing) { Die "could not import: $missing - scroll up for the pip error" }
Ok "all imports resolve"

# -- 6. Ollama ---------------------------------------------------------------
Step 6 "Ollama and the language model"
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Warn "not found - installing via winget"
    winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
}
if (Get-Command ollama -ErrorAction SilentlyContinue) {
    Ok "ollama present"
    if (-not $SkipModel) {
        $have = (& ollama list 2>$null) -join "`n"
        if ($have -match [regex]::Escape($Model.Split(':')[0])) {
            Ok "$Model already pulled"
        } else {
            Warn "pulling $Model - this is the big download"
            & ollama pull $Model
        }
    }
} else {
    Warn "Ollama is not on PATH. Install it from https://ollama.com/download,"
    Warn "then run:  ollama pull $Model"
    Warn "Plate reading and crowd detection work without it; only the"
    Warn "assistant's prompt parsing needs it."
}

# -- 7. Credentials ----------------------------------------------------------
Step 7 "Credentials"
$envFile = Join-Path $root 'pipeline\.env.worker'
if (Test-Path $envFile) {
    Ok ".env.worker already exists - leaving it alone"
} else {
    Write-Host "    These are not in the archive and are needed to store anything."
    Write-Host "    Supabase -> Project Settings -> API for the first two."
    Write-Host ""
    $url = Read-Host "    SUPABASE_URL"
    $key = Read-Host "    SUPABASE_SERVICE_KEY (service_role)" -AsSecureString
    $keyPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($key))
    $mail = Read-Host "    SENTINEL_ACCESS_EMAIL"
    $gkey = Read-Host "    SENTINEL_ACCESS_KEY" -AsSecureString
    $gkeyPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($gkey))

    if ($keyPlain -and ($keyPlain.Split('.').Count -ne 3)) {
        Warn "that service key is not a JWT - a real one has exactly two dots."
        Warn "Writing it anyway; the worker will refuse it and say so."
    }
    @(
        "SUPABASE_URL=$url",
        "SUPABASE_SERVICE_KEY=$keyPlain",
        "SENTINEL_ACCESS_EMAIL=$mail",
        "SENTINEL_ACCESS_KEY=$gkeyPlain",
        "SENTINEL_PIPELINE_DIR=./sentinel-gujarat-pipeline"
    ) | Set-Content -Path $envFile -Encoding ascii
    Ok "written to pipeline\.env.worker"
    Warn "This file is gitignored. Do not commit it, paste it, or screenshot it."
}

# -- 8. Does it actually work ------------------------------------------------
Step 8 "Checking"
$check = & $py -c @"
import os, sys
sys.path.insert(0, 'pipeline')
os.environ.setdefault('SENTINEL_PIPELINE_DIR', './pipeline/sentinel-gujarat-pipeline')
import torch
print('torch     :', torch.__version__, 'cuda' if torch.cuda.is_available() else 'cpu')
try:
    import events
    print('events    : ok, device plan', events.device_plan()[0])
except Exception as e:
    print('events    : FAILED', e)
try:
    from sentinel_worker import default_profile, free_vram_gb
    print('worker    : ok, profile', default_profile(), f'({free_vram_gb():.1f} GB free)')
except Exception as e:
    print('worker    : FAILED', e)
print('pipeline  :', 'present' if os.path.isdir('pipeline/sentinel-gujarat-pipeline') else 'MISSING')
"@ 2>&1
$check | ForEach-Object { Write-Host "    $_" }

Write-Host "`n==============================================================="
Write-Host " Done. To start the server:"
Write-Host ""
Write-Host "     .\RUN-SERVER.ps1"
Write-Host ""
Write-Host " First, in Supabase, run supabase\migrations\0007_events.sql if it"
Write-Host " has not been applied - crowd, fire and accident write to that"
Write-Host " table and the writes fail silently without it."
Write-Host "==============================================================="
