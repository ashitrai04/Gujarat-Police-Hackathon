#!/usr/bin/env bash
#
# One-time setup for the prompt-search service on a GPU host.
#
#   bash setup.sh
#
# Everything lands under this user's home. Nothing needs root: on a shared
# research box you rarely have it, and a setup that demands sudo is a setup
# that does not get run. Ollama is installed from its release tarball rather
# than the official install script for the same reason — that script writes to
# /usr/local and adds a systemd unit.
#
# Safe to re-run. Each step checks whether it already happened.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASK_DIR="$(dirname "$HERE")"          # .../pipeline/ask
PIPELINE="$(dirname "$ASK_DIR")"      # .../pipeline
ROOT="${SENTINEL_HOME:-$HOME/sentinel}"
VENV="$ROOT/venv"
OLLAMA_DIR="$ROOT/ollama"

mkdir -p "$ROOT"
echo "==> installing into $ROOT"

# ── What the card can take ─────────────────────────────────────────────
# The GPU is shared. Picking the device with the most free memory, rather
# than assuming device 0, is the difference between starting and dying on an
# allocation someone else's job already owns.
if command -v nvidia-smi >/dev/null 2>&1; then
  echo "==> GPUs"
  nvidia-smi --query-gpu=index,name,memory.free --format=csv,noheader
  BEST=$(nvidia-smi --query-gpu=index,memory.free --format=csv,noheader,nounits \
         | sort -t, -k2 -n -r | head -1 | cut -d, -f1 | tr -d ' ')
  FREE=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits \
         | sort -n -r | head -1 | tr -d ' ')
  echo "    most free: GPU $BEST with ${FREE} MiB"
else
  echo "!! no nvidia-smi; this will run on CPU and be very slow"
  BEST=0; FREE=0
fi

# ── Python ─────────────────────────────────────────────────────────────
if [ ! -d "$VENV" ]; then
  echo "==> creating the virtualenv"
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
python -m pip install -q --upgrade pip wheel

echo "==> installing Python packages (a few minutes the first time)"
python - <<'PY'
import importlib.util, subprocess, sys
def have(mod): return importlib.util.find_spec(mod) is not None
if not have('torch'):
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q',
                           'torch', 'torchvision',
                           '--index-url', 'https://download.pytorch.org/whl/cu124'])
PY
python -m pip install -q \
  'transformers>=4.45' 'accelerate' 'safetensors' 'sentencepiece' \
  'ultralytics>=8.3' 'opencv-python-headless' 'numpy' 'pillow'

python - <<'PY'
import torch
print(f'    torch {torch.__version__} | cuda {torch.cuda.is_available()} | '
      f'devices {torch.cuda.device_count()}')
PY

# ── Ollama, in user space ──────────────────────────────────────────────
if [ ! -x "$OLLAMA_DIR/bin/ollama" ]; then
  echo "==> fetching Ollama"
  mkdir -p "$OLLAMA_DIR"
  curl -fsSL https://ollama.com/download/ollama-linux-amd64.tgz \
    -o "$OLLAMA_DIR/ollama.tgz"
  tar -xzf "$OLLAMA_DIR/ollama.tgz" -C "$OLLAMA_DIR"
  rm -f "$OLLAMA_DIR/ollama.tgz"
fi
export PATH="$OLLAMA_DIR/bin:$PATH"
export OLLAMA_MODELS="$ROOT/ollama-models"
mkdir -p "$OLLAMA_MODELS"

if ! curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "==> starting Ollama"
  CUDA_VISIBLE_DEVICES="$BEST" OLLAMA_MODELS="$OLLAMA_MODELS" \
    nohup "$OLLAMA_DIR/bin/ollama" serve > "$ROOT/ollama.log" 2>&1 &
  for _ in $(seq 1 60); do
    curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
    sleep 1
  done
fi
curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1 \
  && echo "    Ollama up" || { echo "!! Ollama did not start; see $ROOT/ollama.log"; exit 1; }

# ── Models ─────────────────────────────────────────────────────────────
# 40 GB of card is worth a bigger vision-language model than a laptop can
# hold: 7B parses and verifies noticeably better than 3B, and both are small
# next to what is free here. The embedding tower stays base-384 unless
# ASK_EMBED_MODEL says otherwise, because changing it invalidates the index.
VLM="${ASK_VLM_MODEL:-qwen2.5vl:7b}"
EMB="${ASK_EMBED_MODEL:-google/siglip2-base-patch16-384}"

echo "==> pulling $VLM"
"$OLLAMA_DIR/bin/ollama" pull "$VLM"

echo "==> fetching $EMB"
python - "$EMB" <<'PY'
import sys
from huggingface_hub import snapshot_download
p = snapshot_download(sys.argv[1])
print('    at', p)
PY

# ── Record the environment the service should run with ─────────────────
cat > "$ROOT/env.sh" <<EOF
# Written by setup.sh. Sourced by run.sh and by the notebook.
export SENTINEL_HOME="$ROOT"
export PATH="$OLLAMA_DIR/bin:\$PATH"
export OLLAMA_MODELS="$OLLAMA_MODELS"
export CUDA_VISIBLE_DEVICES="$BEST"
export ASK_VLM_MODEL="$VLM"
export ASK_EMBED_MODEL="$EMB"
export PIPELINE_DIR="$PIPELINE"
export VENV="$VENV"
# Keep the model resident: on a shared box a reload competes for memory that
# may have been taken in the meantime, and a query then waits on a fight it
# cannot win.
export OLLAMA_KEEP_ALIVE=24h
EOF

echo
echo "==> done. Next:"
echo "    1. put footage under $ROOT/footage/"
echo "    2. bash $HERE/build_index.sh"
echo "    3. bash $HERE/run.sh"
