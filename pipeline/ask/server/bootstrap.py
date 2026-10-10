"""
Sentinel prompt search — move the ML half onto a GPU host.

Paste this whole file into one Jupyter cell on the server and run it. Then call
the steps in order:

    preflight()          # what this host has
    setup()              # venv, packages, Ollama, models   (once, ~15 min)
    # ... upload your .mp4 recordings into ~/sentinel/footage ...
    build_index()        # footage -> searchable index
    start()              # detached, watchdogged
    ask("a bus on the road")

    status() / logs() / stop()

WHAT THIS TOUCHES
    Only this machine, only under ~/sentinel, and the models it downloads.

WHAT IT DOES NOT TOUCH
    Nothing else in the platform changes. The camera grid, the R2 archive, the
    Supabase registry, the Vercel deployment and the existing ANPR worker are
    all left exactly as they are. This moves one service — the one that holds
    SigLIP, Qwen and YOLO — off a laptop and onto a card that is always on.
    The web app reaches it by an address, and an address is the only thing that
    has to change anywhere else.

WHY IT DETACHES
    The usual way to run this is a notebook cell, and a background job started
    from a cell is a child of the kernel: restart the kernel, or let the
    notebook idle-cull, and the service goes with it. Everything here starts
    under `setsid`, in its own session, so it outlives all of that. Do not run
    the server inside a cell and leave the cell running.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
import time
import urllib.error
import urllib.request

# ── Where things live ──────────────────────────────────────────────────
#
# Kaggle is a different shape of host and gets different defaults. Its home
# directory is thrown away when the session ends, while /kaggle/working is the
# 20 GB volume that is kept and saved as the notebook's output -- so the
# models, the index and the credentials go there, and a later session can
# attach that output as a dataset instead of downloading everything again.
ON_KAGGLE = os.path.isdir('/kaggle/working')
_DEFAULT_HOME = '/kaggle/working/sentinel' if ON_KAGGLE else '~/sentinel'
HOME = os.path.expanduser(os.environ.get('SENTINEL_HOME', _DEFAULT_HOME))
REPO = os.path.expanduser(os.environ.get('SENTINEL_REPO', '~/sentinel-command-center'))
GIT_URL = os.environ.get(
    'SENTINEL_GIT', 'https://github.com/ashitrai04/Gujarat-Police-Hackathon.git')

VENV = f'{HOME}/venv'
# Resolved by _ensure_python(); not every host can build a venv the usual way.
PY = f'{VENV}/bin/python'
OLLAMA_DIR = f'{HOME}/ollama'
OLLAMA = f'{OLLAMA_DIR}/bin/ollama'
FOOTAGE = f'{HOME}/footage'
INDEX = f'{HOME}/index'
PIPELINE = f'{REPO}/pipeline'
PORT = int(os.environ.get('ASK_PORT', '8077'))

# A 40 GB card is worth a better vision-language model than a laptop can hold.
# 7B parses and verifies noticeably better than 3B and is still small here.
VLM = os.environ.get('ASK_VLM_MODEL', 'qwen2.5vl:7b')
# The embedding tower is NOT a free choice: embeddings from two towers are not
# comparable, so changing this means rebuilding the index. The service refuses
# to start on a mismatch rather than returning confident nonsense.
EMB = os.environ.get('ASK_EMBED_MODEL', 'google/siglip2-base-patch16-384')


def sh(cmd, check=False, quiet=False, env=None):
    """Run a shell command, streaming output into the notebook."""
    p = subprocess.Popen(cmd, shell=True, executable='/bin/bash',
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, env={**os.environ, **(env or {})})
    out = []
    for line in p.stdout:
        out.append(line)
        if not quiet:
            print(line, end='')
    rc = p.wait()
    if check and rc != 0:
        raise RuntimeError(f'failed ({rc}): {cmd}')
    return rc, ''.join(out)


def _gpu_rows():
    rc, out = sh('nvidia-smi --query-gpu=index,name,memory.total,memory.free '
                 '--format=csv,noheader,nounits', quiet=True)
    if rc != 0:
        return []
    rows = []
    for line in out.strip().splitlines():
        parts = [x.strip() for x in line.split(',')]
        if len(parts) >= 4:
            rows.append({'index': int(parts[0]), 'name': parts[1],
                         'total': int(parts[2]), 'free': int(parts[3])})
    return rows


def best_gpu():
    """The device with the most free memory.

    Not device 0. The card is shared, and assuming device 0 is how a job dies
    on an allocation somebody else's training run already owns.
    """
    rows = _gpu_rows()
    return max(rows, key=lambda r: r['free'])['index'] if rows else 0


# ── 1. Preflight ───────────────────────────────────────────────────────
def preflight():
    print('=== GPUs ===')
    rows = _gpu_rows()
    for r in rows:
        print(f"  GPU {r['index']}  {r['name']:28s} free {r['free']:6d} / "
              f"{r['total']} MiB")
    if rows:
        b = best_gpu()
        free = next(r['free'] for r in rows if r['index'] == b)
        print(f'  -> will use GPU {b} ({free} MiB free)')
        if free < 12000:
            print('  !! under 12 GB free. The 7B model may not fit; if it '
                  'fails, set ASK_VLM_MODEL="qwen2.5vl:3b" and run setup() again.')
    else:
        print('  none found — this would run on CPU and be unusably slow')

    print('\n=== host ===')
    print('  cores :', os.cpu_count())
    sh("free -g | awk 'NR<=2 {printf \"  %s\\n\", $0}'", quiet=False)
    sh(f"df -h {os.path.expanduser('~')} | awk 'NR<=2 {{printf \"  %s\\n\", $0}}'")

    print('\n=== paths ===')
    for label, path in (('repo', REPO), ('install', HOME),
                        ('footage', FOOTAGE), ('index', INDEX)):
        mark = 'ok' if os.path.isdir(path) else 'not yet'
        print(f'  {label:9s} {path}  [{mark}]')
    print('\n  python :', sys.version.split()[0])
    print('  git    :', shutil.which('git') or 'MISSING')
    print('  ffmpeg :', shutil.which('ffmpeg') or 'missing (opencv will decode instead)')


# ── 2. Setup ───────────────────────────────────────────────────────────
def setup():
    """Virtualenv, packages, Ollama and models. Idempotent; re-run freely."""
    os.makedirs(HOME, exist_ok=True)

    # -- the code --
    if not os.path.isdir(f'{REPO}/.git'):
        print(f'==> cloning into {REPO}')
        rc, _ = sh(f'git clone --depth 1 {GIT_URL} {REPO}')
        if rc != 0:
            print(textwrap.dedent(f"""
                !! clone failed. If the repository is private, either
                     git clone https://<user>:<token>@github.com/... {REPO}
                   or upload the folder and set:
                     os.environ['SENTINEL_REPO'] = '/path/to/sentinel-command-center'
            """))
            return
    else:
        print('==> updating the checkout')
        sh(f'cd {REPO} && git pull --ff-only')

    # -- python --
    _ensure_python()
    sh(f'{PY} -m pip install -q --upgrade pip wheel', check=True)

    print('==> installing packages (several minutes the first time)')
    rc, _ = sh(f'{PY} -c "import torch" 2>/dev/null', quiet=True)
    if rc != 0:
        sh(f'{PY} -m pip install -q torch torchvision '
           f'--index-url https://download.pytorch.org/whl/cu124', check=True)
    sh(f'{PY} -m pip install -q "transformers>=4.45" accelerate safetensors '
       f'sentencepiece "ultralytics>=8.3" opencv-python-headless numpy pillow '
       f'huggingface_hub', check=True)
    sh(f'{PY} -c "import torch;print(f\'    torch {{torch.__version__}} cuda='
       f'{{torch.cuda.is_available()}} devices={{torch.cuda.device_count()}}\')"')

    # -- ollama, in user space: no root, nothing outside $HOME --
    _install_ollama()

    _write_env()
    if not os.path.isfile(OLLAMA):
        print('!! no Ollama binary; stopping before the model pull')
        return
    _start_ollama()

    print(f'==> pulling {VLM}  (a few GB)')
    sh(f'source {HOME}/env.sh && {OLLAMA} pull {VLM}', check=True)

    print(f'==> fetching {EMB}')
    sh(f'{PY} -c "from huggingface_hub import snapshot_download as d;'
       f'print(\'    \', d(\'{EMB}\'))"', check=True)

    os.makedirs(FOOTAGE, exist_ok=True)
    print(f'\n==> ready. Put .mp4 recordings in {FOOTAGE}, then build_index()')


def _works(py):
    """A python we can actually pip-install with."""
    if not py or not os.path.isfile(py):
        return False
    rc, _ = sh(f'{py} -m pip --version', quiet=True)
    return rc == 0


def _ensure_python():
    """Find or build an environment we can install into, and set PY to it.

    `python3 -m venv` is the obvious way and fails on a lot of shared Debian
    hosts: the distro splits `ensurepip` into a python3-venv package that is
    not installed, and installing it needs root that a research account does
    not have. The error it prints tells you to run apt, which is not advice you
    can take.

    So this tries, in order of how self-contained the result is:

      1. venv, the normal way
      2. venv --without-pip, then bootstrap pip into it with get-pip.py —
         --without-pip skips ensurepip entirely, which is the part that is
         missing, and get-pip.py needs nothing but the interpreter
      3. virtualenv, which vendors its own pip and never touches ensurepip
      4. conda, if this is a conda host
      5. no environment at all: install into the user site-packages of the
         interpreter already running. Always available, and last because it
         shares a dependency set with whatever else this account runs.
    """
    global PY

    # An interpreter named explicitly wins over all of it, and Kaggle names
    # itself. Its image already carries torch built against the right CUDA,
    # plus transformers, ultralytics and opencv; a fresh venv would see none
    # of them and spend several GB and a chunk of a weekly GPU allowance
    # rebuilding what is already installed. Only the few genuinely missing
    # packages get added to it.
    forced = os.environ.get('ASK_PYTHON', '').strip()
    if not forced and ON_KAGGLE:
        forced = sys.executable
    if forced and _works(forced):
        PY = forced
        print(f'    using the interpreter already here: {PY}')
        return PY

    if _works(f'{VENV}/bin/python'):
        PY = f'{VENV}/bin/python'
        print(f'    using the existing env at {VENV}')
        return PY

    print('==> preparing a Python environment')

    # 1. the normal way
    rc, _ = sh(f'python3 -m venv {VENV}', quiet=True)
    if rc == 0 and _works(f'{VENV}/bin/python'):
        PY = f'{VENV}/bin/python'
        print('    venv ok')
        return PY

    # 2. venv without ensurepip, then pip by hand
    print('    ensurepip is unavailable on this host; building the env without it')
    sh(f'rm -rf {VENV}', quiet=True)
    rc, _ = sh(f'python3 -m venv --without-pip {VENV}', quiet=True)
    if rc == 0 and os.path.isfile(f'{VENV}/bin/python'):
        sh(f'curl -fsSL https://bootstrap.pypa.io/get-pip.py -o {HOME}/get-pip.py',
           quiet=True)
        sh(f'{VENV}/bin/python {HOME}/get-pip.py -q', quiet=True)
        if _works(f'{VENV}/bin/python'):
            PY = f'{VENV}/bin/python'
            print('    venv + get-pip ok')
            return PY

    # 3. virtualenv, which carries its own pip
    print('    trying virtualenv')
    sh(f'rm -rf {VENV}', quiet=True)
    sh(f'{sys.executable} -m pip install -q --user virtualenv', quiet=True)
    rc, _ = sh(f'{sys.executable} -m virtualenv -q {VENV}', quiet=True)
    if rc == 0 and _works(f'{VENV}/bin/python'):
        PY = f'{VENV}/bin/python'
        print('    virtualenv ok')
        return PY

    # 4. conda, if this is one of those hosts
    if shutil.which('conda'):
        print('    trying conda')
        sh(f'rm -rf {VENV}', quiet=True)
        rc, _ = sh(f'conda create -y -q -p {VENV} python=3.11 pip', quiet=True)
        if rc == 0 and _works(f'{VENV}/bin/python'):
            PY = f'{VENV}/bin/python'
            print('    conda ok')
            return PY

    # 5. the interpreter we are already running, installing to ~/.local
    print(textwrap.dedent("""
        !! Could not build an isolated environment, so packages will go into
           this account's user site-packages instead. That works, but it shares
           a dependency set with everything else this user runs — if something
           here upgrades a package another project pins, that project breaks.

           The clean fix needs one command from whoever administers the host:
               sudo apt install python3.12-venv
           after which re-running setup() builds a proper isolated env.
    """))
    sh(f'rm -rf {VENV}', quiet=True)
    PY = sys.executable
    # Makes every later `pip install` in this process land in ~/.local without
    # each call having to remember the flag.
    os.environ['PIP_USER'] = '1'
    return PY


def _ollama_asset():
    """URL of the current linux-amd64 Ollama build, asked rather than assumed.

    The download address has moved and the archive format with it:
    ollama.com/download/ollama-linux-amd64.tgz is a 404, and the release asset
    is now a .tar.zst. Hard-coding either the host or the extension is how this
    breaks again in six months, so the release API is asked what exists and the
    extraction follows from the name that comes back.
    """
    api = 'https://api.github.com/repos/ollama/ollama/releases/latest'
    try:
        with urllib.request.urlopen(api, timeout=30) as r:
            rel = json.loads(r.read())
    except Exception as e:                                   # noqa: BLE001
        print(f'    could not reach the release API ({e})')
        return None, None

    # Plain amd64: not the ROCm build (AMD cards) and not the mlx one (Apple).
    best = None
    for a in rel.get('assets', []):
        n = a['name']
        if 'linux' in n and 'amd64' in n and 'rocm' not in n and 'mlx' not in n:
            if n.endswith(('.tgz', '.tar.gz', '.tar.zst')):
                best = a
                break
    if not best:
        return None, None
    print(f"    {rel.get('tag_name')}  {best['name']}  "
          f"{best['size'] / 1e6:.0f} MB")
    return best['browser_download_url'], best['name']


def _install_ollama():
    if os.path.isfile(OLLAMA):
        print('    Ollama already installed')
        return True

    print('==> fetching Ollama')
    os.makedirs(OLLAMA_DIR, exist_ok=True)
    url, name = _ollama_asset()
    if not url:
        print(textwrap.dedent("""
            !! Could not resolve an Ollama download. Install it by hand:
                 https://github.com/ollama/ollama/releases/latest
               extract so that ~/sentinel/ollama/bin/ollama exists, then
               re-run setup().
        """))
        return False

    archive = f'{OLLAMA_DIR}/{name}'
    rc, _ = sh(f'curl -fL --retry 3 -o {archive} "{url}"')
    if rc != 0 or not os.path.isfile(archive):
        print('!! download failed')
        return False

    print('    extracting')
    if name.endswith('.tar.zst'):
        # GNU tar 1.31+ can do this directly; older ones need unzstd piped in;
        # if the host has neither, the zstandard wheel always works.
        rc, _ = sh(f'tar --zstd -xf {archive} -C {OLLAMA_DIR}', quiet=True)
        if rc != 0:
            rc, _ = sh(f'unzstd -c {archive} | tar -xf - -C {OLLAMA_DIR}', quiet=True)
        if rc != 0:
            print('    no zstd in tar; decompressing with Python')
            sh(f'{PY} -m pip install -q zstandard', quiet=True)
            rc, _ = sh(
                f'{PY} -c "'
                f'import zstandard,tarfile,io;'
                f'f=open(r\'{archive}\',\'rb\');'
                f'r=zstandard.ZstdDecompressor().stream_reader(f);'
                f'tarfile.open(fileobj=r,mode=\'r|\').extractall(r\'{OLLAMA_DIR}\')"')
    else:
        rc, _ = sh(f'tar -xzf {archive} -C {OLLAMA_DIR}', quiet=True)

    os.remove(archive) if os.path.isfile(archive) else None

    if os.path.isfile(OLLAMA):
        sh(f'chmod +x {OLLAMA}', quiet=True)
        print('    installed')
        return True

    # Some builds nest the binary a level deeper than bin/.
    _, found = sh(f'find {OLLAMA_DIR} -maxdepth 4 -type f -name ollama | head -1',
                  quiet=True)
    found = found.strip()
    if found:
        os.makedirs(f'{OLLAMA_DIR}/bin', exist_ok=True)
        sh(f'cp {found} {OLLAMA} && chmod +x {OLLAMA}', quiet=True)
        print('    installed')
        return True

    print(f'!! extracted but no ollama binary under {OLLAMA_DIR}')
    return False


def _write_env():
    gpu = best_gpu()
    token = _token()
    # Resolved here so the worker inherits a usable path rather than hoping
    # `ffmpeg` is on PATH, which on this host it is not.
    ffmpeg = ffmpeg_path()
    with open(f'{HOME}/env.sh', 'w') as f:
        f.write(textwrap.dedent(f"""\
            export SENTINEL_HOME="{HOME}"
            export PIPELINE_DIR="{PIPELINE}"
            export VENV="{VENV}"
            export ASK_PYTHON="{PY}"
            export PATH="{OLLAMA_DIR}/bin:$PATH"
            # The release tarball carries its own CUDA libraries. Without this
            # the binary starts and then cannot find them, which it reports as
            # a GPU failure rather than a missing path.
            export LD_LIBRARY_PATH="{OLLAMA_DIR}/lib:{OLLAMA_DIR}/lib/ollama:${{LD_LIBRARY_PATH:-}}"
            export OLLAMA_MODELS="{HOME}/ollama-models"
            export CUDA_VISIBLE_DEVICES="{gpu}"
            export ASK_VLM_MODEL="{VLM}"
            export ASK_EMBED_MODEL="{EMB}"
            export ASK_TOKEN="{token}"
            export ASK_PORT="{PORT}"
            # Keep the model resident. On a shared box a reload competes for
            # memory that may have been taken meanwhile, and a query then waits
            # on a fight it cannot win.
            export OLLAMA_KEEP_ALIVE=24h
            export FFMPEG="{ffmpeg}"
            # Secrets live in their own file, because this one is rewritten
            # from scratch every time the service starts.
            [ -f "{HOME}/creds.sh" ] && . "{HOME}/creds.sh"
            """))
    os.makedirs(f'{HOME}/ollama-models', exist_ok=True)


def _token():
    p = f'{HOME}/token'
    if os.path.isfile(p):
        return open(p).read().strip()
    import secrets
    t = secrets.token_urlsafe(18)
    with open(p, 'w') as f:
        f.write(t)
    os.chmod(p, 0o600)
    return t


def _ollama_up():
    try:
        urllib.request.urlopen('http://127.0.0.1:11434/api/tags', timeout=4)
        return True
    except Exception:
        return False




def ollama_debug():
    """Everything needed to work out why the daemon will not come up."""
    print('=== binary ===')
    sh(f'ls -la {OLLAMA_DIR}/bin 2>/dev/null || echo "no bin/"')
    sh(f'ls -d {OLLAMA_DIR}/lib* 2>/dev/null || echo "no lib/"')
    print('\n=== does it run at all? ===')
    sh(f'source {HOME}/env.sh && {OLLAMA} --version 2>&1 | head -5')
    print('\n=== port 11434 ===')
    sh('(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep 11434 '
       '|| echo "nothing listening"')
    print('\n=== processes ===')
    sh('pgrep -a ollama || echo "none"')
    print('\n=== log ===')
    sh(f'tail -n 40 {HOME}/ollama.log 2>/dev/null || echo "(no log)"')
    print('\n=== env ===')
    sh(f'cat {HOME}/env.sh 2>/dev/null || echo "(no env.sh)"')


def ollama_restart():
    """Kill whatever is there and start again."""
    sh('pkill -f "ollama serve" 2>/dev/null; true', quiet=True)
    time.sleep(2)
    return _start_ollama()


def _start_ollama(wait=90):
    """Start the daemon and wait for it, visibly.

    The launch is detached and its output goes to a file, so nothing appears in
    the cell while it comes up. An earlier version simply slept for sixty
    seconds, which is indistinguishable from a hang and was reported as one.
    It prints a dot a second now, and on failure shows the log rather than
    naming a path and leaving the reader to go and look.
    """
    if _ollama_up():
        print('    Ollama already up')
        return True

    print('==> starting Ollama', end='', flush=True)
    # Not through sh(): that captures stdout, and a detached grandchild holding
    # the pipe open would block the read forever. Nothing here writes to the
    # pipe at all.
    subprocess.Popen(
        f'source {HOME}/env.sh && exec setsid {OLLAMA} serve '
        f'>> {HOME}/ollama.log 2>&1 < /dev/null &',
        shell=True, executable='/bin/bash',
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True)

    for _ in range(wait):
        if _ollama_up():
            print(' up')
            return True
        print('.', end='', flush=True)
        time.sleep(1)

    print(' failed\n')
    print(f'--- last of {HOME}/ollama.log ---')
    sh(f'tail -n 25 {HOME}/ollama.log 2>/dev/null || echo "(no log written)"')
    print(textwrap.dedent(f"""
        Things that cause this:
          - another Ollama is already bound to 11434 (try: pkill ollama)
          - the binary cannot find its libraries; check that both
            {OLLAMA_DIR}/bin and {OLLAMA_DIR}/lib exist
          - no write access to {HOME}/ollama-models
        Run ollama_debug() for the details.
    """))
    return False


# ── 3. Index ───────────────────────────────────────────────────────────
def build_index(footage=None, every=1.0):
    """Footage -> searchable index.

    Decode-bound rather than GPU-bound: every frame is decoded and one per
    `every` seconds kept. On 256 cores this is far quicker than on a laptop,
    and a smaller `every` costs almost nothing because the decode happens
    either way.
    """
    _ensure_python()
    src = footage or FOOTAGE
    vids = [f for f in os.listdir(src) if f.lower().endswith('.mp4')] \
        if os.path.isdir(src) else []
    if not vids and src == FOOTAGE and _stray_footage():
        print('==> uploads landed outside the footage directory; collecting them')
        collect_footage()
        vids = [f for f in os.listdir(src) if f.lower().endswith('.mp4')]

    if not vids:
        print(f'!! no .mp4 files in {src}')
        print('   upload them with the Jupyter file browser, or from your machine:')
        print(f'     rsync -av --progress <local-folder>/ '
              f'{os.environ.get("USER","user")}@{_hostname()}:{src}/')
        return
    print(f'==> {len(vids)} videos in {src}')
    sh(f'source {HOME}/env.sh && cd {PIPELINE} && '
       f'{PY} -m ask.index {src} --out {INDEX} --every {every}')
    # Arithmetic over boxes already stored — seconds, but it must run after
    # every rebuild or the "three on one motorcycle" filter matches nothing.
    sh(f'source {HOME}/env.sh && cd {PIPELINE} && '
       f'{PY} -m ask.riders --index {INDEX}')
    sh(f'du -sh {INDEX}')


# ── 4. Run ─────────────────────────────────────────────────────────────
_GUARD = r'''#!/usr/bin/env bash
source "$SENTINEL_HOME/env.sh"
# The env may be a venv, a conda prefix, or the host interpreter with packages
# in ~/.local — activate only if there is something to activate.
[ -f "$VENV/bin/activate" ] && source "$VENV/bin/activate"
PY="${ASK_PYTHON:-python}"
LOG="$SENTINEL_HOME/ask.log"
backoff=5
while true; do
  if ! curl -sf -m 5 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "[guard $(date -Is)] ollama down, restarting" >> "$LOG"
    nohup ollama serve >> "$SENTINEL_HOME/ollama.log" 2>&1 &
    sleep 8
  fi
  echo "[guard $(date -Is)] starting the service" >> "$LOG"
  cd "$PIPELINE_DIR"
  "$PY" -u -m ask.serve --index "$SENTINEL_HOME/index" \
      --host 0.0.0.0 --port "$ASK_PORT" >> "$LOG" 2>&1 &
  child=$!
  echo "$child" > "$SENTINEL_HOME/ask.pid"
  wait "$child" || true
  echo "[guard $(date -Is)] exited; restarting in ${backoff}s" >> "$LOG"
  sleep "$backoff"
  backoff=$(( backoff < 60 ? backoff * 2 : 60 ))
done
'''


def start():
    """Start the service detached, under a watchdog."""
    if not os.path.isdir(INDEX):
        print('!! no index yet — run build_index()')
        return
    _ensure_python()
    if _service_up():
        print('==> already running')
        return status()

    _write_env()
    _start_ollama()
    with open(f'{HOME}/guard.sh', 'w') as f:
        f.write(_GUARD)
    os.chmod(f'{HOME}/guard.sh', 0o755)
    open(f'{HOME}/ask.log', 'w').close()

    # setsid, so this outlives the kernel that started it.
    sh(f'source {HOME}/env.sh && setsid nohup bash {HOME}/guard.sh '
       f'> /dev/null 2>&1 < /dev/null & echo $! > {HOME}/guard.pid', quiet=True)

    print('==> starting', end='', flush=True)
    for _ in range(240):
        if _service_up():
            print(' ok')
            break
        print('.', end='', flush=True)
        time.sleep(2)
    else:
        print(f'\n!! did not come up — logs():\n')
        return logs(40)
    print()
    status()


def stop():
    # The watchdog first, or it helpfully restarts what we just killed.
    sh(f'[ -f {HOME}/guard.pid ] && kill $(cat {HOME}/guard.pid) 2>/dev/null; '
       f'rm -f {HOME}/guard.pid; pkill -f "ask.serve"; true', quiet=True)
    time.sleep(1)
    status()


def _hostname():
    _, out = sh('hostname -f 2>/dev/null || hostname', quiet=True)
    return out.strip() or 'this-host'


def _service_up():
    try:
        req = urllib.request.Request(
            f'http://127.0.0.1:{PORT}/health',
            headers={'x-ask-token': _token()})
        urllib.request.urlopen(req, timeout=5)
        return True
    except Exception:
        return False




def _is_private(ip):
    """True for addresses only routable inside a local network."""
    try:
        import ipaddress
        a = ipaddress.ip_address(ip)
        return a.is_private or a.is_loopback or a.is_link_local
    except ValueError:
        # Not an address at all — a hostname, which may or may not resolve
        # publicly. Treated as private so the advice errs towards a tunnel.
        return True


def status():
    up = _service_up()
    print(f'  service : {"up" if up else "down"}   (port {PORT})')
    print(f'  ollama  : {"up" if _ollama_up() else "down"}')
    if up:
        req = urllib.request.Request(f'http://127.0.0.1:{PORT}/health',
                                     headers={'x-ask-token': _token()})
        print('  health  :', urllib.request.urlopen(req, timeout=8).read().decode())
    _, raw = sh("hostname -I 2>/dev/null | awk '{print $1}'", quiet=True)
    ip = raw.strip()
    print()
    print(f'  token : {_token()}')

    # A tunnel already open is the address that works; say that first.
    public = None
    if os.path.isfile(f'{HOME}/tunnel.url'):
        cand = open(f'{HOME}/tunnel.url').read().strip()
        if cand:
            public = cand

    if public:
        print()
        print('  Vercel > Settings > Environment Variables, then redeploy once:')
        print(f'    VITE_ASK_API_URL={public}')
        print(f'    VITE_ASK_TOKEN={_token()}')
        return

    # Otherwise be honest about what this address is worth. Printing a private
    # IP under "point the web app at it" invites pasting an address that
    # cannot be routed to from anywhere the web app runs, and the failure then
    # looks like the service rather than the network.
    if _is_private(ip):
        print(f'  address : http://{ip}:{PORT}   <- PRIVATE, this host\'s network only')
        print()
        print('  A browser outside that network cannot reach it, so this is not')
        print('  the value to put in Vercel. Open a public URL instead:')
        print('      install_ngrok(authtoken="...")')
        print('      tunnel(domain="your-reserved.ngrok-free.app")')
        print()
        print('  If your browser IS on this network, it works as it stands.')
    else:
        print()
        print('  Vercel > Settings > Environment Variables, then redeploy once:')
        print(f'    VITE_ASK_API_URL=http://{ip}:{PORT}')
        print(f'    VITE_ASK_TOKEN={_token()}')


def logs(n=60, follow=False):
    sh(f'tail -n {n} {"-f " if follow else ""}{HOME}/ask.log')


# ── 5. Try it ──────────────────────────────────────────────────────────




def _stray_footage():
    """.mp4 files sitting where an upload would have put them by accident.

    Jupyter's upload button writes to whatever directory the file browser is
    showing, which is the home directory unless you navigated first. Reporting
    "0 mp4 in ~/sentinel/footage" while three of them sit one level up is
    technically true and useless.
    """
    import glob
    home = os.path.expanduser('~')
    seen = []
    for d in (home, f'{home}/Downloads', os.getcwd()):
        if not os.path.isdir(d) or os.path.abspath(d) == os.path.abspath(FOOTAGE):
            continue
        found = glob.glob(f'{d}/*.mp4')
        if found:
            seen.append((d, found))
    return seen


def collect_footage(move=True):
    """Move stray .mp4 files into the footage directory."""
    os.makedirs(FOOTAGE, exist_ok=True)
    moved = 0
    for d, files in _stray_footage():
        for f in files:
            dest = os.path.join(FOOTAGE, os.path.basename(f))
            if os.path.exists(dest):
                continue
            if move:
                shutil.move(f, dest)
            else:
                shutil.copy2(f, dest)
            moved += 1
        print(f'  {"moved" if move else "copied"} {len(files)} from {d}')
    n = len([f for f in os.listdir(FOOTAGE) if f.lower().endswith('.mp4')])
    print(f'  {n} mp4 now in {FOOTAGE}')
    return moved




NGROK = f'{HOME}/ngrok/ngrok'


def install_ngrok(authtoken=None):
    """Fetch ngrok into this account and save the authtoken.

    The token falls back to NGROK_AUTHTOKEN in the environment, which is what
    makes this work on a host that keeps nothing. ngrok writes its config into
    the home directory, and on Kaggle that is discarded with the session, so a
    token given once by hand is gone by the next run and the tunnel fails for
    a reason that has nothing to do with the tunnel. Read from the environment
    it comes back every time, out of the notebook's own secret store.

    Needed when the host answers only on its own network. This box reaches the
    internet outward — it pulled a gigabyte from GitHub — but nothing reaches
    port 8077 inward, and asking an administrator to open a port is a slower
    path than making the outward connection do the work.
    """
    if not os.path.isfile(NGROK):
        print('==> fetching ngrok')
        os.makedirs(f'{HOME}/ngrok', exist_ok=True)
        rc, _ = sh(f'curl -fsSL '
                   f'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz '
                   f'-o {HOME}/ngrok/n.tgz && tar -xzf {HOME}/ngrok/n.tgz '
                   f'-C {HOME}/ngrok && rm -f {HOME}/ngrok/n.tgz')
        if rc != 0 or not os.path.isfile(NGROK):
            print('!! download failed; get it from https://ngrok.com/download')
            return False
        sh(f'chmod +x {NGROK}', quiet=True)
    authtoken = authtoken or os.environ.get('NGROK_AUTHTOKEN', '').strip()
    if authtoken:
        sh(f'{NGROK} config add-authtoken {authtoken}', quiet=True)
        print('    authtoken saved')
    print(f'    {NGROK}')
    return True


def tunnel(domain=None, authtoken=None):
    """Put the service on a public URL.

    `domain` should be a reserved one — ngrok's free tier includes a single
    static domain. Without it the hostname changes every restart, and anything
    configured to point at yesterday's is already broken.
    """
    if not install_ngrok(authtoken):
        return None
    if not _service_up():
        print('!! the service is not running — start() first')
        return None

    sh('pkill -f "ngrok http" 2>/dev/null; true', quiet=True)
    time.sleep(1)

    domain = domain or os.environ.get('NGROK_DOMAIN', '')
    # The flag was renamed --domain -> --url around 3.20; ask rather than guess.
    _, help_text = sh(f'{NGROK} http --help 2>&1', quiet=True)
    if domain:
        flag = f'--url https://{domain}' if '--url ' in help_text \
            else f'--domain {domain}'
    else:
        flag = ''
        print('    no reserved domain: this URL changes on every restart')

    # Recorded so the resume script reuses this exact flag rather than working
    # it out again, differently, with nobody watching.
    with open(f'{HOME}/env.sh', 'a') as f:
        f.write(f'export NGROK_DOMAIN="{domain}"\n')
        f.write(f'export NGROK_FLAG="{flag}"\n')

    subprocess.Popen(
        f'exec setsid {NGROK} http {PORT} {flag} --log stdout '
        f'> {HOME}/ngrok.log 2>&1 < /dev/null &',
        shell=True, executable='/bin/bash',
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True)

    print('==> opening the tunnel', end='', flush=True)
    url = f'https://{domain}' if domain else ''
    for _ in range(40):
        time.sleep(1)
        print('.', end='', flush=True)
        if domain:
            break
        _, log = sh(f'grep -oE "https://[a-zA-Z0-9.-]+\\.ngrok[a-z.-]*\\.(app|io)" '
                    f'{HOME}/ngrok.log 2>/dev/null | head -1', quiet=True)
        if log.strip():
            url = log.strip()
            break
    print()

    if not url:
        print(f'!! no URL yet — check {HOME}/ngrok.log')
        sh(f'tail -n 20 {HOME}/ngrok.log')
        return None

    with open(f'{HOME}/tunnel.url', 'w') as f:
        f.write(url)

    # Confirm it reaches back, rather than reporting a URL nobody has tried.
    time.sleep(2)
    rc, out = sh(f'curl -s -o /dev/null -w "%{{http_code}}" -m 25 '
                 f'-H "x-ask-token: {_token()}" "{url}/health"', quiet=True)
    print(f'  {url}   (health: {out.strip() or "no answer"})')
    print()
    print('  Vercel > Settings > Environment Variables, then redeploy once:')
    print(f'    VITE_ASK_API_URL={url}')
    print(f'    VITE_ASK_TOKEN={_token()}')
    return url




# ── Credentials ────────────────────────────────────────────────────────

CRED_KEYS = (
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
    'SENTINEL_ACCESS_EMAIL',
    'SENTINEL_ACCESS_KEY',
)


def set_credentials(**kw):
    """Record the keys the ANPR worker needs, in ~/sentinel/creds.sh.

        set_credentials(
            SUPABASE_URL="https://xxxx.supabase.co",
            SUPABASE_SERVICE_KEY="eyJ...",
            SENTINEL_ACCESS_EMAIL="...",
            SENTINEL_ACCESS_KEY="...",
        )

    Kept in their own file, mode 600, sourced by env.sh. Two reasons it is not
    env.sh itself: env.sh is rewritten from scratch every time the service
    starts, and a secret that lives in a generated file gets regenerated away
    at the worst moment. Separating them also means env.sh can be shown to
    somebody without showing them the keys.

    Values are read from this cell, never from the repository. The service-role
    key in particular bypasses row-level security entirely — it belongs in a
    shell on a server and nowhere else, not in .env, not in a commit, not in a
    message.
    """
    path = f'{HOME}/creds.sh'
    have = {}
    if os.path.isfile(path):
        for line in open(path):
            m = re.match(r'export ([A-Z_]+)="(.*)"$', line.strip())
            if m:
                have[m.group(1)] = m.group(2)

    for k, v in kw.items():
        key = k.upper()
        if key not in CRED_KEYS:
            print(f'  ignoring unknown key {key}')
            continue
        have[key] = str(v).strip()

    with open(path, 'w') as f:
        f.write('# Written by set_credentials(). Not generated, not committed.\n')
        for k in CRED_KEYS:
            if have.get(k):
                f.write(f'export {k}="{have[k]}"\n')
    os.chmod(path, 0o600)

    # env.sh is regenerated often, so it sources this rather than copying it.
    _write_env()

    print(f'  written to {path} (mode 600)')
    for k in CRED_KEYS:
        v = have.get(k, '')
        print(f'    {k:24s} {"set, " + str(len(v)) + " chars" if v else "MISSING"}')
    missing = [k for k in CRED_KEYS if not have.get(k)]
    if missing:
        print(f'\n  still missing: {", ".join(missing)}')
    else:
        print('\n  all set. Restart the worker:  anpr_stop(); anpr_start()')
    return not missing


def check_feeds(host='https://cctv.corp8.cloud'):
    """Can this host reach the camera grid, and sign in to it?

    Worth answering separately from "are the credentials set", because they
    fail identically from the worker's point of view and have nothing to do
    with each other. A research network that blocks outbound traffic to an
    unfamiliar origin looks exactly like a missing access key in the log.
    """
    sh(f'source {HOME}/env.sh 2>/dev/null; '
       f'echo "  key set      : $([ -n \"$SENTINEL_ACCESS_KEY\" ] && echo yes || echo NO)"')
    print('  DNS          :', end=' ')
    sh(f'getent hosts {host.split("//")[1]} | head -1 || echo "does not resolve"')
    print('  catalogue    :', end=' ')
    sh(f'curl -s -o /dev/null -w "HTTP %{{http_code}} in %{{time_total}}s\n" -m 25 '
       f'-A "Mozilla/5.0 Chrome/131" {host}/cameras.json')
    print()
    print('  523 means Cloudflare reached the grid\'s origin and it did not answer:')
    print('  the feed host is down or refusing this network, not a key problem.')
    print('  200 with the key set means captures should work.')


# ── Live ANPR ──────────────────────────────────────────────────────────

_ANPR_GUARD = r'''#!/usr/bin/env bash
source "$SENTINEL_HOME/env.sh"
[ -f "$VENV/bin/activate" ] && source "$VENV/bin/activate"
PY="${ASK_PYTHON:-python}"
LOG="$SENTINEL_HOME/anpr.log"
backoff=10
while true; do
  echo "[guard $(date -Is)] starting the ANPR worker" >> "$LOG"
  cd "$PIPELINE_DIR"
  "$PY" -u live_worker.py --seconds "${ANPR_SECONDS:-30}" \
      --source "${ANPR_SOURCE:-hls}" \
      --events "${ANPR_EVENTS:-}" \
      --event-store "${ANPR_EVENT_STORE:-measure}" >> "$LOG" 2>&1 &
  child=$!
  echo "$child" > "$SENTINEL_HOME/anpr.pid"
  wait "$child" || true
  echo "[guard $(date -Is)] worker exited; restarting in ${backoff}s" >> "$LOG"
  sleep "$backoff"
  backoff=$(( backoff < 120 ? backoff * 2 : 120 ))
done
'''




# What the ANPR worker needs and the search service does not. setup() installs
# the retrieval side; this is the reading side, and the two have almost no
# overlap — which is why a machine can run prompt search perfectly and still
# not have a single package the plate pipeline imports.
ANPR_REQUIREMENTS = (
    ('supabase', 'supabase>=2.0', 'writes sightings into the registry'),
    ('paddleocr', 'paddleocr>=3.0', 'plate text recognition (PP-OCRv5)'),
    ('paddle', 'paddlepaddle', 'the runtime PaddleOCR needs'),
    ('open_image_models', 'open-image-models[onnx]', 'the plate detector'),
    ('cv2', 'opencv-python-headless', 'video decoding'),
    # Not a library: the pipeline shells out to ffmpeg to pull each clip. The
    # pip package carries a static binary, which is the only way to get one on
    # a host where apt needs root — and is what the laptop already uses.
    ('imageio_ffmpeg', 'imageio-ffmpeg', 'the ffmpeg binary, no root needed'),
)


def ffmpeg_path() -> str:
    """An ffmpeg this host can actually run.

    The system one if there is one, otherwise the static binary that ships
    inside imageio-ffmpeg. The worker calls ffmpeg by name, so without this it
    fails per camera with "No such file or directory: 'ffmpeg'" — thirty times
    a pass, fast enough to look like a different problem entirely.
    """
    found = shutil.which('ffmpeg')
    if found:
        return found
    script = f'{HOME}/_ffmpeg.py'
    with open(script, 'w') as f:
        f.write('import imageio_ffmpeg, sys\n')
        f.write('sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())\n')
    rc, out = sh(f'{PY} {script}', quiet=True)
    path = out.strip().splitlines()[-1].strip() if rc == 0 and out.strip() else ''
    return path if path and os.path.isfile(path) else ''


def anpr_missing() -> list:
    """Which ANPR packages are absent from the environment the worker uses."""
    names = [m for m, _, _ in ANPR_REQUIREMENTS]
    # Written to a file and run, not passed with -c.
    #
    # The probe needs quotes of both kinds, and threading those through a
    # shell command inside an f-string is how a check silently reports
    # everything as missing — the command fails, the output is empty, and
    # every package looks absent.
    script = f'{HOME}/_probe.py'
    with open(script, 'w') as f:
        f.write('import importlib.util as u\n')
        f.write(f'for m in {names!r}:\n')
        f.write("    print(('OK' if u.find_spec(m) else 'NO'), m)\n")
    _, out = sh(f'{PY} {script}', quiet=True)
    absent = {ln.split()[1] for ln in out.splitlines() if ln.startswith('NO ')}
    return [r for r in ANPR_REQUIREMENTS if r[0] in absent]


def capture_check(cam='cam08', seconds=20):
    """Walk one capture end to end and report which layer refused.

    "capture failed: no video" covers four unrelated faults -- no credentials,
    a sign-in the grid rejected, a playlist with no segments, and ffmpeg dying
    silently -- because it is printed whenever ffmpeg leaves no stderr behind.
    They need different fixes, so each step is done separately here.

    The default window is longer than the worker's because the most common
    cause is a live feed that is up but publishing slowly: 5 seconds of a
    stalled stream lands under the 50KB floor and reads as a dead camera.
    """
    probe = f'{PIPELINE}/ask/server/capcheck.py'
    if not os.path.isfile(probe):
        print('!! capcheck.py missing -- git pull in the repo first')
        return False
    print(f'=== one capture, step by step ({cam}, {seconds}s) ===')
    sh(f'source {HOME}/env.sh && cd {PIPELINE} && '
       f'PIPELINE_DIR={PIPELINE} {PY} {probe} {cam} {seconds}')
    return True


def anpr_test(recording=None, camera='cam08', profile=None):
    """Run the full plate pipeline over a recording already on this host.

    This is the measurement that does not depend on the feeds. The live worker
    can only be judged once detection, OCR, the Supabase write and the evidence
    images are known to work, and a capture that returns nothing tells you
    nothing about any of them. A recording removes that variable: whatever
    comes out is the pipeline's own accuracy.

    The camera id is what the rows are filed under, so pass the one the
    recording actually came from if you want the result searchable in place.
    """
    vids = sorted(f for f in os.listdir(FOOTAGE)
                  if f.lower().endswith('.mp4')) if os.path.isdir(FOOTAGE) else []
    if recording is None:
        if not vids:
            print(f'!! no .mp4 in {FOOTAGE}')
            print('   Upload one, or run collect_footage() if the upload '
                  'landed elsewhere.')
            return False
        recording = vids[0]
        if len(vids) > 1:
            print(f'  {len(vids)} recordings here; using {recording}')
            print(f"  others: {', '.join(vids[1:])}")
    path = recording if os.path.isabs(recording) else f'{FOOTAGE}/{recording}'
    if not os.path.isfile(path):
        print(f'!! not a file: {path}')
        return False

    missing = anpr_missing()
    if missing:
        print('!! cannot import: ' + ', '.join(m for m, _, _ in missing))
        print('   Run anpr_setup() first.')
        return False

    size = os.path.getsize(path) / 1e6
    print(f'=== plate pipeline over {os.path.basename(path)} '
          f'({size:.0f} MB), filed as {camera} ===')
    # Writes real rows, because a test that skips the write does not test the
    # half that has broken most often.
    if not _cred('SUPABASE_SERVICE_KEY'):
        print('  no service key in creds.sh -- detections will be printed, '
              'not stored')
    flag = f' --profile {profile}' if profile else ''
    sh(f'source {HOME}/env.sh && cd {PIPELINE} && '
       f'{PY} sentinel_worker.py "{path}" --camera {camera}{flag}')
    print()
    print('  "N vehicles, M plates" is the accuracy figure: M/N is how often a')
    print('  tracked vehicle gave up a readable plate. "K detections recorded"')
    print('  above zero means the Supabase path works too, and the only thing')
    print('  left unproven is the feed.')
    return True


def ffmpeg_check(cam='cam08'):
    """Work out which ffmpeg capability is broken, and whether it matters.

    Called when a capture dies of a signal rather than an error. A SIGSEGV
    leaves no stderr, so the binary, TLS, the -headers option and decoding are
    exercised one at a time, and the same fetch is then done in Python to see
    whether the CLI is needed at all.
    """
    probe = f'{PIPELINE}/ask/server/ffcheck.py'
    if not os.path.isfile(probe):
        print('!! ffcheck.py missing -- git pull in the repo first')
        return False
    sh(f'source {HOME}/env.sh && cd {PIPELINE} && '
       f'PIPELINE_DIR={PIPELINE} {PY} {probe} {cam}')
    return True


def events_test(recording=None, camera='cam08', device=None,
                store_all=True):
    """Score a recording for crowd, fire and accident, and print the numbers.

    Run this before turning the kinds on in the live worker. Two of the three
    are zero-shot screeners rather than trained detectors, so their thresholds
    are guesses until they have been seen against real footage from these
    cameras -- and the margins printed here are exactly what a threshold
    should be set from.

    store_all is on by default so the findings land in `events` even when
    nothing crossed its threshold. A row that did not fire is what makes the
    threshold adjustable later against footage already scored, rather than
    only against whatever happens to come past next.
    """
    if not os.path.isfile(f'{PIPELINE}/events.py'):
        print('!! events.py missing -- git pull in the repo first')
        return False

    vids = sorted(f for f in os.listdir(FOOTAGE)
                  if f.lower().endswith('.mp4')) if os.path.isdir(FOOTAGE) else []
    if recording is None:
        if not vids:
            print(f'!! no .mp4 in {FOOTAGE}')
            print('   Upload one, or run collect_footage() if the upload '
                  'landed elsewhere.')
            return False
        recording = vids[0]
        if len(vids) > 1:
            print(f'  {len(vids)} recordings here; using {recording}')
    path = recording if os.path.isabs(recording) else f'{FOOTAGE}/{recording}'
    if not os.path.isfile(path):
        print(f'!! not a file: {path}')
        return False

    flags = f' --device {device}' if device else ''
    if store_all:
        flags += ' --store-all'
    print(f'=== crowd / fire / accident over {os.path.basename(path)}, '
          f'filed as {camera} ===')
    sh(f'source {HOME}/env.sh && cd {PIPELINE} && '
       f'{PY} events.py "{path}" --camera {camera}{flags}')
    print()
    print('  crowd is a count, and can be read as one.')
    print('  fire and accident are margins between a positive and a negative')
    print('  prompt set -- a similarity, not a probability. Compare the number')
    print('  on footage that does contain the event against footage that does')
    print('  not, and put the threshold between them. Clips with no incident')
    print('  in them are the more useful half of that comparison.')
    return True


def events_thresholds(fire=None, accident=None, crowd_medium=None,
                      crowd_high=None):
    """Set the event thresholds the worker will use.

    Written to env.sh so the running worker picks them up on its next restart
    and they survive a reboot. The defaults in events.py are deliberately
    conservative; these cameras are the only thing that can say what the right
    numbers are.
    """
    pairs = [('SENTINEL_FIRE_THRESHOLD', fire),
             ('SENTINEL_ACCIDENT_THRESHOLD', accident),
             ('SENTINEL_CROWD_MEDIUM', crowd_medium),
             ('SENTINEL_CROWD_HIGH', crowd_high)]
    set_any = [(k, v) for k, v in pairs if v is not None]
    if not set_any:
        print('  nothing given. Current values:')
        sh(f'grep -E "SENTINEL_(FIRE|ACCIDENT|CROWD)" {HOME}/env.sh '
           f'|| echo "  (none set; events.py defaults apply)"')
        return False
    with open(f'{HOME}/env.sh', 'a') as f:
        for k, v in set_any:
            f.write(f'export {k}="{v}"\n')
    for k, v in set_any:
        print(f'  {k} = {v}')
    print('  Restart the worker for these to take effect: anpr_stop() then '
          'anpr_start(events=...)')
    return True


def events_live(cam='cam08', seconds=30, device=None, store='all'):
    """Run crowd, fire and accident against a live camera, once, right now.

    The difference from events_test() is the footage: this signs in to the
    grid, captures from the camera, and scores what is on it at this moment.
    It is the check that the whole chain works on the live estate rather than
    on a recording -- authentication, capture, decode, both models, and the
    write -- without waiting for the continuous worker to come round.

    store='all' by default so a quiet street still produces rows. On a live
    camera the normal result for fire and accident is nothing, and a run that
    stores nothing cannot be told apart from a run that failed.
    """
    if not os.path.isfile(f'{PIPELINE}/events.py'):
        print('!! events.py missing -- git pull in the repo first')
        return False

    missing = anpr_missing()
    if missing:
        print('!! cannot import: ' + ', '.join(m for m, _, _ in missing))
        print('   Run anpr_setup() first.')
        return False
    if not _cred('SUPABASE_SERVICE_KEY'):
        print('  no service key in creds.sh -- findings will be printed, '
              'not stored')

    url = f'https://cctv.corp8.cloud/{cam}/index.m3u8'
    flags = f' --device {device}' if device else ''
    print(f'=== live scene analysis: {cam}, {seconds}s ===')
    if _anpr_running():
        print('  note: the ANPR worker is running and holds a grid session.')
        print('  The grid allows one per address, so this sign-in may take it')
        print('  from the worker for a pass. anpr_stop() first to be certain.')
    sh(f'source {HOME}/env.sh && cd {PIPELINE} && '
       f'{PY} events.py "{url}" --camera {cam} --seconds {seconds}'
       f'{flags} --store {store}')
    print()
    print('  crowd reports a count. fire and accident reporting nothing is')
    print('  the expected result on an ordinary street -- what this proves is')
    print('  that the chain runs on live footage and the rows are written.')
    return True


_RESUME = r'''#!/usr/bin/env bash
# Put everything back that should be running. Safe to run at any time: each
# part is checked first, so this is a no-op when the host is healthy.
#
# Run from cron rather than from the notebook, because the notebook is the one
# thing guaranteed not to be there after a restart -- which is the case this
# exists for.
source "$SENTINEL_HOME/env.sh" 2>/dev/null || exit 0
[ -f "$VENV/bin/activate" ] && source "$VENV/bin/activate"
LOG="$SENTINEL_HOME/resume.log"

# Ollama: the language model the parser and verifier call.
if ! curl -sf -m 5 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "[resume $(date -Is)] ollama down, starting" >> "$LOG"
  nohup ollama serve >> "$SENTINEL_HOME/ollama.log" 2>&1 &
  sleep 8
fi

# The search service, through its own watchdog.
if ! curl -sf -m 5 -H "x-ask-token: $ASK_TOKEN" \
     "http://127.0.0.1:${ASK_PORT:-8077}/health" >/dev/null 2>&1; then
  if ! pgrep -f "guard.sh" >/dev/null 2>&1; then
    echo "[resume $(date -Is)] ask guard missing, starting" >> "$LOG"
    setsid nohup bash "$SENTINEL_HOME/guard.sh" >/dev/null 2>&1 < /dev/null &
  fi
fi

# The ANPR + scene worker, likewise.
if ! pgrep -f live_worker.py >/dev/null 2>&1; then
  if ! pgrep -f anpr_guard.sh >/dev/null 2>&1; then
    echo "[resume $(date -Is)] anpr guard missing, starting" >> "$LOG"
    setsid nohup bash "$SENTINEL_HOME/anpr_guard.sh" >/dev/null 2>&1 < /dev/null &
  fi
fi

# The public URL. Without it the deployed site cannot reach this host at all,
# so it is worth restarting even though nothing on this machine needs it.
# NGROK_FLAG is whatever tunnel() established this ngrok build accepts: --url
# wants a full URL and --domain a bare host, and which one exists depends on
# the version. Reusing its answer is the only way a restart comes back on the
# same hostname instead of a random one while appearing to have worked.
if [ -n "$NGROK_FLAG" ] && ! pgrep -f "ngrok http" >/dev/null 2>&1; then
  echo "[resume $(date -Is)] tunnel down, starting" >> "$LOG"
  setsid nohup "$SENTINEL_HOME/ngrok/ngrok" http "${ASK_PORT:-8077}" \
      $NGROK_FLAG --log stdout >> "$SENTINEL_HOME/ngrok.log" 2>&1 < /dev/null &
fi
'''


def keepalive_install(every_minutes=5):
    """Have cron put things back, so the notebook is not load-bearing.

    The watchdogs already restart a process that crashes, and setsid already
    means they outlive the kernel that started them. What neither survives is
    the host going away -- a reboot, or the session being reclaimed -- because
    nothing then starts them again.

    So the same checks run from cron: once at boot, and every few minutes in
    case a guard itself was killed. Each check is a no-op when the thing is
    already up, which is why running it this often is reasonable.

    Cron is absent from a good many notebook containers. That is reported
    rather than worked around: a fake success here would be worse than knowing
    the host needs the one cell re-run after a restart.
    """
    with open(f'{HOME}/resume.sh', 'w') as f:
        f.write(_RESUME)
    os.chmod(f'{HOME}/resume.sh', 0o755)

    rc, _ = sh('command -v crontab', quiet=True)
    if rc != 0:
        print('  no crontab on this host, so nothing can run at boot.')
        print(f'  {HOME}/resume.sh is written and works -- run start_all()')
        print('  again after a restart, or call it from whatever this host')
        print('  does provide.')
        return False

    line_boot = f'@reboot SENTINEL_HOME={HOME} bash {HOME}/resume.sh'
    line_tick = (f'*/{every_minutes} * * * * SENTINEL_HOME={HOME} '
                 f'bash {HOME}/resume.sh')
    # Replace rather than append: re-running this must not stack up copies.
    sh(f'(crontab -l 2>/dev/null | grep -v "{HOME}/resume.sh"; '
       f'echo "{line_boot}"; echo "{line_tick}") | crontab -', quiet=True)
    rc, out = sh('crontab -l 2>/dev/null | grep -c resume.sh', quiet=True)
    n = out.strip().splitlines()[-1].strip() if out.strip() else '0'
    print(f'  cron: {n} entries (boot + every {every_minutes} min)')
    return True


def start_all(events='crowd,fire,accident', domain=None, seconds=30,
              rebuild_index=False, authtoken=None, expose='auto'):
    """Bring the whole server up, in order, with one call.

    This is the only cell that needs running. Every step is idempotent and
    checks before acting, so it is also the right thing to run after a
    restart, after a crash, or when unsure what state the host is in -- it
    will skip what is already healthy and fix what is not.

    Order matters and is not arbitrary: packages before models, models before
    the index, the index before the service (it refuses to start without
    one), the service before the tunnel (which has nothing to publish
    otherwise), and the worker last because it is the only part that does not
    block anything else.
    """
    print('=' * 62)
    print(' SENTINEL — bringing everything up')
    print('=' * 62)

    print('\n[1/7] code and python')
    setup()

    print('\n[2/7] packages the plate and scene workers need')
    anpr_setup()

    print('\n[3/7] language model')
    if not _ollama_up():
        _start_ollama()
    print('  ollama: ' + ('up' if _ollama_up() else 'DOWN — ollama_debug()'))

    print('\n[4/7] search index')
    if rebuild_index or not os.path.isdir(INDEX):
        vids = [f for f in os.listdir(FOOTAGE)
                if f.lower().endswith('.mp4')] if os.path.isdir(FOOTAGE) else []
        if vids:
            build_index()
        else:
            print(f'  no .mp4 in {FOOTAGE} and no index, so prompt search')
            print('  cannot start. Everything else below still will.')
    else:
        print(f'  present at {INDEX}')

    print('\n[5/7] search service')
    if os.path.isdir(INDEX):
        start()
    else:
        print('  skipped — needs an index')

    print('\n[6/7] public URL')
    # 'auto' means: ngrok when there is a token for it, because a reserved
    # name is worth having; cloudflare otherwise, because it needs no account
    # at all; and 'none' for a host that only runs the worker, which needs no
    # inbound access whatsoever -- it writes to the database and the browser
    # reads from there.
    want = expose
    if want == 'auto':
        has_ngrok = bool(authtoken or os.environ.get('NGROK_AUTHTOKEN')
                         or os.path.isfile(NGROK))
        want = 'ngrok' if has_ngrok else 'cloudflare'
    if not _service_up():
        print('  skipped — nothing to publish until the service is up')
    elif want == 'none':
        print('  skipped — asked not to. The worker still writes to the')
        print('  database, which is all the control room needs it to do.')
    elif want == 'cloudflare':
        tunnel_cf()
    else:
        tunnel(domain, authtoken)

    print('\n[7/7] continuous plate + scene worker')
    anpr_start(seconds=seconds, events=events)

    print('\n[+] keep-alive')
    keepalive_install()

    print('\n' + '=' * 62)
    print(' where things stand')
    print('=' * 62)
    status()
    anpr_status()
    print('\nThe kernel can be stopped now: every part runs detached under')
    print('its own watchdog. Re-run start_all() any time to check and repair.')


def serve_forever(check_every=120, hours=11.5):
    """Hold the session open, checking and repairing as it goes.

    This is how a notebook host stays up, and it works the opposite way round
    from the dedicated server. There, start_all() returns and cron keeps
    things alive after the kernel is gone. On Kaggle there is no cron, no
    reboot to recover from, and an idle kernel is reclaimed within the hour --
    so the thing that must not stop is this cell. It blocks on purpose.

    Each pass re-checks Ollama, the search service and the worker, and puts
    back whatever has gone, which is the same set of checks cron runs on the
    other host. The printing matters as much as the checking: output is what
    marks the kernel as busy.

    `hours` stops it slightly before Kaggle's own 12-hour ceiling, so the loop
    ends on its own terms with a readable summary rather than the session
    being cut mid-sentence.
    """
    started = time.time()
    deadline = started + hours * 3600
    passes = 0
    repaired = 0

    print(f'==> holding the session open for up to {hours:g}h, '
          f'checking every {check_every}s')
    print('    Stop this cell and everything here stops with it.\n')
    try:
        while time.time() < deadline:
            passes += 1
            up = []
            fixed = []

            if _ollama_up():
                up.append('ollama')
            else:
                _start_ollama()
                fixed.append('ollama')

            if _service_up():
                up.append('search')
            elif os.path.isdir(INDEX):
                rc, _ = sh('pgrep -f guard.sh', quiet=True)
                if rc != 0:
                    sh(f'source {HOME}/env.sh && setsid nohup bash '
                       f'{HOME}/guard.sh > /dev/null 2>&1 < /dev/null &',
                       quiet=True)
                    fixed.append('search')

            if _anpr_running():
                up.append('worker')
            else:
                rc, _ = sh('pgrep -f anpr_guard.sh', quiet=True)
                if rc != 0 and os.path.isfile(f'{HOME}/anpr_guard.sh'):
                    sh(f'source {HOME}/env.sh && setsid nohup bash '
                       f'{HOME}/anpr_guard.sh > /dev/null 2>&1 < /dev/null &',
                       quiet=True)
                    fixed.append('worker')

            rc, _ = sh('pgrep -f "ngrok http"', quiet=True)
            rc2, _ = sh('pgrep -f "cloudflared tunnel"', quiet=True)
            if rc == 0 or rc2 == 0:
                up.append('tunnel')
            elif os.environ.get('CF_TUNNEL') == '1':
                # A quick tunnel that died comes back on a different name, so
                # the link has to be read off the log and pasted again. Said
                # here rather than silently restarted, because a restart the
                # operator does not know about is a link that silently stops
                # working.
                fixed.append('tunnel (NEW URL — see cloudflared.log)')
                tunnel_cf(wait=30)

            repaired += len(fixed)
            mins = (time.time() - started) / 60
            note = f'  restarted: {", ".join(fixed)}' if fixed else ''
            print(f'[{mins:6.1f} min] up: {", ".join(up) or "nothing"}{note}',
                  flush=True)
            time.sleep(check_every)
    except KeyboardInterrupt:
        print('\n==> stopped by hand')

    mins = (time.time() - started) / 60
    print(f'\n==> held for {mins:.0f} min over {passes} checks, '
          f'{repaired} restart(s)')
    print('    Everything here stops when the session does. Re-run the cell')
    print('    to bring it back on the same URL.')


CF = f'{HOME}/cloudflared/cloudflared'


def install_cloudflared():
    """Fetch cloudflared. No account, no token, nothing to sign up for."""
    if os.path.isfile(CF):
        return True
    print('==> fetching cloudflared')
    os.makedirs(f'{HOME}/cloudflared', exist_ok=True)
    url = ('https://github.com/cloudflare/cloudflared/releases/latest/'
           'download/cloudflared-linux-amd64')
    rc, _ = sh(f'curl -fsSL {url} -o {CF} && chmod +x {CF}')
    if rc != 0 or not os.path.isfile(CF):
        print('!! could not download cloudflared')
        return False
    return True


def tunnel_cf(wait=60):
    """Put the service on a public URL without an account.

    The alternative to ngrok, and the one that needs nothing set up: a quick
    tunnel is anonymous, so there is no token to store and nothing to lose
    when a host throws its home directory away.

    What it costs is the hostname. A quick tunnel gets a random
    trycloudflare.com name every time it starts, so it cannot be written into
    a build-time environment variable -- by the next session it points
    nowhere. That is why this prints a ready-made link with `?ask=` on it: the
    web application takes that parameter, remembers it in the browser, and
    tries it ahead of everything else. Pasting the link once per session is
    the whole configuration step.
    """
    if not install_cloudflared():
        return None
    if not _service_up():
        print('!! the service is not running — start() first')
        return None

    sh('pkill -f "cloudflared tunnel" 2>/dev/null; true', quiet=True)
    log = f'{HOME}/cloudflared.log'
    open(log, 'w').close()
    subprocess.Popen(
        f'exec setsid {CF} tunnel --no-autoupdate --url '
        f'http://localhost:{PORT} > {log} 2>&1 < /dev/null &',
        shell=True, executable='/bin/bash',
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True)

    print('==> opening the tunnel', end='', flush=True)
    url = ''
    for _ in range(wait):
        time.sleep(1)
        print('.', end='', flush=True)
        try:
            text = open(log, encoding='utf8', errors='replace').read()
        except OSError:
            continue
        m = re.search(r'https://[-a-z0-9]+\.trycloudflare\.com', text)
        if m:
            url = m.group(0)
            break
    print()

    if not url:
        print('!! no URL appeared. Last few lines:')
        sh(f'tail -n 12 {log}')
        return None

    # Recorded so a later check can tell a dead tunnel from no tunnel. Set in
    # this process too, not only in env.sh: serve_forever() runs here in the
    # notebook and would never see a variable that only exists in a file the
    # detached scripts source.
    os.environ['CF_TUNNEL'] = '1'
    with open(f'{HOME}/env.sh', 'a') as f:
        f.write('export CF_TUNNEL=1\n')

    token = _token()
    print(f'  {url}')
    print()
    print('  Open this link once and the browser will remember it:')
    print(f'    <your site>/?ask={url}&askToken={token}')
    print()
    print('  The name changes every time this starts, so it cannot go in a')
    print('  Vercel variable. Clearing it later is /?ask=off, which falls')
    print('  back to the GPU server.')
    return url


def anpr_setup():
    """Install what the plate pipeline imports.

    Kept separate from setup() because the two halves are independent: a host
    can answer prompt searches perfectly without a single one of these, and
    somebody who only wants search should not wait on PaddlePaddle.

    PaddlePaddle is installed CPU-only. The GPU build is pinned to particular
    CUDA minor versions and picking the wrong one fails at import rather than
    at install, which is a bad trade for a component that is not the
    bottleneck — the plate detector's ONNX session already falls back to CPU
    here, and the vehicle detector, which is the expensive part, runs on the
    card through torch regardless.
    """
    _ensure_python()
    missing = anpr_missing()
    if not missing:
        print('  all ANPR packages present')
        return True

    print('==> installing: ' + ', '.join(m for m, _, _ in missing))
    for mod, spec, why in missing:
        print(f'  {spec:28s} {why}')
        rc, _ = sh(f'{PY} -m pip install -q "{spec}"')
        if rc != 0:
            print(f'  !! {spec} failed to install')

    ff = ffmpeg_path()
    print(f'\n  ffmpeg: {ff or "NOT FOUND"}')
    if ff:
        _write_env()          # record the path for the worker

    still = anpr_missing()
    if still:
        print('\n!! still missing: ' + ', '.join(m for m, _, _ in still))
        print('   The worker imports these at start; it cannot run without them.')
        return False
    print('\n  done — anpr_start() will work now')
    return True


def anpr_start(seconds=30, source='hls', events='',
               event_store='measure'):
    """Read plates off every camera in the registry, continuously.

    This is what makes "has this vehicle been past that camera?" answerable. A
    department onboards a camera; the worker re-reads the registry each cycle,
    so the new camera joins the rotation without anyone restarting anything,
    and from then on its sightings accumulate in `detections` where the trace
    and the event search already look.

    `events` adds scene analysis to the same pass, as a comma list of
    crowd, fire and accident -- anpr_start(events='crowd,fire,accident'). It
    shares the clip the plate pass already captured rather than running a
    second worker, because the grid allows one session per address and a
    second sign-in would invalidate this one's. Left empty, nothing about the
    existing behaviour changes.

    Crowd counts are stored on every pass by default, the way plate sightings
    are, because a count is only meaningful as a series. Fire and accident
    will mostly report nothing on a live estate -- that is the expected
    result, not a fault -- so their rows are kept when they fire or come
    close, which is what gives the thresholds something to be tuned against.
    event_store='all' keeps everything; 'fired' keeps only threshold
    crossings.

    Detached and watchdogged for the same reasons the search service is: the
    card is shared, and a worker that a colleague's job can quietly end is not
    one a control room can rely on.
    """
    # Resolved before anything reads PY. Called on its own -- without setup()
    # earlier in the session -- PY is still the module-level guess at a venv
    # path, which on a host that uses its own interpreter does not exist, and
    # _write_env() would record it for the watchdog to fail on forever.
    _ensure_python()

    if not os.path.isfile(f'{PIPELINE}/live_worker.py'):
        print('!! live_worker.py missing — git pull in the repo first')
        return False

    # An import error inside the worker becomes a ten-second restart loop that
    # never does any work, so the packages are checked out here where the
    # remedy can be named.
    missing = anpr_missing()
    if missing:
        print('!! the worker cannot import: '
              + ', '.join(m for m, _, _ in missing))
        print('   Run anpr_setup() first — it installs them.')
        return False

    if not ffmpeg_path():
        print('!! no ffmpeg. Every capture would fail with "No such file or')
        print('   directory". Run anpr_setup() — it installs a static one.')
        return False
    if _anpr_running():
        print('==> already running')
        return anpr_status()

    _write_env()
    with open(f'{HOME}/env.sh', 'a') as f:
        f.write(f'export ANPR_SECONDS="{seconds}"\n')
        f.write(f'export ANPR_SOURCE="{source}"\n')
        f.write(f'export ANPR_EVENTS="{events}"\n')
        f.write(f'export ANPR_EVENT_STORE="{event_store}"\n')
        f.write(f'export SENTINEL_OUT="{HOME}/anpr-out"\n')
        f.write(f'export SENTINEL_TMP="{HOME}/anpr-tmp"\n')
    os.makedirs(f'{HOME}/anpr-out', exist_ok=True)
    os.makedirs(f'{HOME}/anpr-tmp', exist_ok=True)

    # Check the key BEFORE starting the watchdog.
    #
    # The worker validates it too, but by then it is inside a restart loop that
    # backs off to two minutes, repeating the same line and doing nothing. The
    # earlier version of this check read env.sh, which never contains the key —
    # so it warned every time, including when everything was correct, and the
    # warning stopped meaning anything.
    key = _cred('SUPABASE_SERVICE_KEY') or os.environ.get('SUPABASE_SERVICE_KEY', '')
    if not key:
        print(textwrap.dedent("""
            !! No SUPABASE_SERVICE_KEY, so sightings would be printed rather
               than stored and nothing would become searchable. Set it with:

                 set_credentials(SUPABASE_URL="...", SUPABASE_SERVICE_KEY="...",
                                 SENTINEL_ACCESS_EMAIL="...", SENTINEL_ACCESS_KEY="...")

               It is the service-role key: server-side only, never in a browser
               bundle or a committed file.
        """))
        return False
    if key.count('.') != 2 or len(key) < 100:
        print(textwrap.dedent(f"""
            !! SUPABASE_SERVICE_KEY is not a JWT: {len(key)} characters,
               {key.count('.')} dots. A real one is roughly 200 characters with
               exactly two dots.

               {'That is the placeholder from an example, not a key.'
                if set(key) <= set('eyJ.') else 'It looks truncated.'}

               Not starting — the worker would restart on this every ten
               seconds without doing any work. Run creds_check() to see the
               shape of what is stored, then set_credentials() with the whole
               value.
        """))
        return False

    with open(f'{HOME}/anpr_guard.sh', 'w') as f:
        f.write(_ANPR_GUARD)
    os.chmod(f'{HOME}/anpr_guard.sh', 0o755)
    open(f'{HOME}/anpr.log', 'w').close()

    subprocess.Popen(
        f'source {HOME}/env.sh && exec setsid bash {HOME}/anpr_guard.sh '
        f'> /dev/null 2>&1 < /dev/null &',
        shell=True, executable='/bin/bash',
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True)

    if events:
        print(f'==> scene analysis on: {events} (storing: {event_store})')
    print('==> ANPR worker starting; first camera takes a minute (models load)')
    time.sleep(6)
    return anpr_status()


def _anpr_running():
    rc, out = sh('pgrep -f live_worker.py', quiet=True)
    return rc == 0 and out.strip() != ''


def anpr_status():
    running = _anpr_running()
    print(f'  ANPR worker : {"running" if running else "stopped"}')
    if os.path.isfile(f'{HOME}/anpr.log'):
        sh(f'grep -c "stored" {HOME}/anpr.log 2>/dev/null '
           f'| xargs -I{{}} echo "  cameras read : {{}}"', quiet=False)
        print('  last lines:')
        sh(f'tail -n 6 {HOME}/anpr.log')
    return running


def anpr_stop():
    sh(f'[ -f {HOME}/anpr.pid ] && kill $(cat {HOME}/anpr.pid) 2>/dev/null; '
       f'pkill -f anpr_guard.sh; pkill -f live_worker.py; true', quiet=True)
    time.sleep(2)
    return anpr_status()


def anpr_logs(n=60):
    sh(f'tail -n {n} {HOME}/anpr.log 2>/dev/null || echo "(no log yet)"')








def _cred(key: str) -> str:
    """One credential as creds.sh actually holds it."""
    path = f'{HOME}/creds.sh'
    if not os.path.isfile(path):
        return ''
    for line in open(path):
        m = re.match(rf'export {key}="(.*)"\s*$', line.rstrip('\n'))
        if m:
            return m.group(1)
    return ''


def creds_check():
    """Show the SHAPE of each credential, never the value.

    "Not a JWT" says a key is wrong without saying how, and the usual causes —
    a paste that lost its tail, a value that never reached the file, a stale
    one still in the shell — are indistinguishable from the message. Length,
    dot count and the first and last few characters separate them, and none of
    that is the secret.

    A Supabase key is a JWT: three dot-separated parts, well over 100
    characters. Two dots and ~200 characters is right; anything shorter was
    truncated.
    """
    def shape(v):
        if not v:
            return 'EMPTY'
        return (f'{len(v):4d} chars, {v.count(".")} dots, '
                f'{v[:6]}…{v[-4:]}')

    print(f'=== {HOME}/creds.sh ===')
    path = f'{HOME}/creds.sh'
    if not os.path.isfile(path):
        print('  does not exist — run set_credentials(...)')
    else:
        found = {}
        for line in open(path):
            m = re.match(r'export ([A-Z_]+)="(.*)"\s*$', line.rstrip('\n'))
            if m:
                found[m.group(1)] = m.group(2)
            elif line.strip() and not line.startswith('#'):
                print(f'  UNPARSEABLE LINE: {line.strip()[:40]}…')
        for k in CRED_KEYS:
            print(f'  {k:24s} {shape(found.get(k, ""))}')
        bad = [k for k in ('SUPABASE_SERVICE_KEY',)
               if found.get(k) and found[k].count('.') != 2]
        if bad:
            print(f'\n  !! {", ".join(bad)} is not a JWT. Most likely the paste')
            print('     lost its tail. Re-run set_credentials() with the full value.')

    print('\n=== as the worker would see it ===')
    sh(f'source {HOME}/env.sh 2>/dev/null; '
       f'for k in {" ".join(CRED_KEYS)}; do '
       f'v=$(eval echo \\$$k); '
       f'if [ -z "$v" ]; then echo "  $k: EMPTY"; '
       f'else echo "  $k: ${{#v}} chars, $(echo "$v" | tr -cd . | wc -c) dots"; fi; done')

    print('\n  env.sh sources creds.sh, so a difference between the two blocks')
    print('  means env.sh is stale — any start() or anpr_start() rewrites it.')


def models():
    """Every model the system uses: where it is, and whether it is here yet.

    They arrive at different times and from different places, which is easy to
    lose track of. Two come down during setup(); the rest are fetched by
    whichever component first needs them — ultralytics downloads its weights on
    first use, so a model can be "configured" for days before it exists on
    disk. This reports what is actually present rather than what is referenced.
    """
    import glob

    def size(path):
        try:
            if os.path.isdir(path):
                n = sum(os.path.getsize(f) for f in glob.glob(f'{path}/**/*', recursive=True)
                        if os.path.isfile(f))
            else:
                n = os.path.getsize(path)
            return f'{n / 1e6:,.0f} MB'
        except OSError:
            return ''

    def row(name, role, path, present, extra=''):
        mark = 'yes' if present else ' no'
        print(f'  {mark}  {name:26s} {role:22s} {extra or (size(path) if present else "")}')

    print('=== retrieval and language ===')
    hub = os.path.expanduser('~/.cache/huggingface/hub')
    emb = os.environ.get('ASK_EMBED_MODEL', EMB)
    emb_dir = os.path.join(hub, 'models--' + emb.replace('/', '--'))
    row(emb.split('/')[-1], 'scene retrieval', emb_dir, os.path.isdir(emb_dir))

    tags = []
    try:
        with urllib.request.urlopen('http://127.0.0.1:11434/api/tags', timeout=8) as r:
            tags = [m['name'] for m in json.loads(r.read()).get('models', [])]
    except Exception:                                    # noqa: BLE001
        pass
    want_vlm = os.environ.get('ASK_VLM_MODEL', VLM)
    row(want_vlm, 'prompt + verify', '', want_vlm in tags,
        ', '.join(tags) if tags else 'ollama not answering')

    print('\n=== detection ===')
    # ultralytics puts weights wherever it was run from, so look in the places
    # this project runs things from rather than assuming one directory.
    def find(name):
        for d in (f'{PIPELINE}', f'{PIPELINE}/ask', HOME, os.getcwd(),
                  os.path.expanduser('~/.config/Ultralytics')):
            p = os.path.join(d, name)
            if os.path.isfile(p):
                return p
        return None

    for name, role in (
        ('yolo11n.pt', 'index: object counts'),
        ('yolo11m.pt', 'ANPR: balanced profile'),
        ('yolo11x.pt', 'ANPR: accurate profile'),
        ('yolov8s-worldv2.pt', 'open-vocab attributes'),
        ('FINAL_NIGHT_MODEL.pt', 'ANPR: night (optional)'),
    ):
        p = find(name)
        row(name, role, p or '', bool(p))

    print('\n  Plate detection and OCR (yolo-v9-t plate detector, PP-OCRv5)')
    print('  come down on first use into ~/.cache and ~/.paddlex — not listed')
    print('  here because neither keeps a single predictable path.')

    print('\n=== notes ===')
    print('  Anything marked "no" is not an error: ultralytics fetches weights')
    print('  the first time something asks for them. yolo11x arrives on the')
    print('  first ANPR pass under the accurate profile; yolov8s-worldv2 on the')
    print('  first prompt that names an attribute such as "a red truck".')


def doctor():
    """Check the whole chain and say which link is broken.

    Written because every failure so far has presented as a symptom several
    steps downstream of its cause — a refused connection on 8077 that is really
    a missing index, or a model that never finished pulling.
    """
    ok = True

    def line(label, good, detail=''):
        print(f'  {"ok  " if good else "FAIL"}  {label:22s} {detail}')
        return good

    print('=== chain ===')
    ok &= line('repo', os.path.isdir(f'{REPO}/.git'), REPO)
    have_py = _works(f'{VENV}/bin/python') or _works(sys.executable)
    ok &= line('python env', have_py, VENV)
    ok &= line('ollama binary', os.path.isfile(OLLAMA), OLLAMA)
    up = _ollama_up()
    ok &= line('ollama running', up, 'port 11434')

    models = ''
    if up:
        try:
            with urllib.request.urlopen('http://127.0.0.1:11434/api/tags',
                                        timeout=8) as r:
                tags = [m['name'] for m in json.loads(r.read()).get('models', [])]
            models = ', '.join(tags) or '(none pulled)'
            ok &= line('vlm pulled', any(VLM.split(':')[0] in t for t in tags),
                       models)
        except Exception as e:                               # noqa: BLE001
            ok &= line('vlm pulled', False, str(e)[:60])

    n_footage = len([f for f in os.listdir(FOOTAGE)
                     if f.lower().endswith('.mp4')]) if os.path.isdir(FOOTAGE) else 0
    ok &= line('footage', n_footage > 0, f'{n_footage} mp4 in {FOOTAGE}')
    stray = _stray_footage() if n_footage == 0 else []
    for d, files in stray:
        print(f'        {len(files)} mp4 found in {d} instead')

    has_index = os.path.isfile(f'{INDEX}/vectors.npy')
    ok &= line('index', has_index, INDEX)
    if has_index:
        try:
            meta = json.load(open(f'{INDEX}/meta.json'))
            print(f'        {meta.get("frames")} frames, {meta.get("model")}')
        except Exception:                                    # noqa: BLE001
            pass

    guard = os.path.isfile(f'{HOME}/guard.pid')
    running = False
    if guard:
        try:
            os.kill(int(open(f'{HOME}/guard.pid').read().strip()), 0)
            running = True
        except Exception:                                    # noqa: BLE001
            running = False
    line('watchdog', running, '' if running else 'not running')
    svc = _service_up()
    ok &= line('search service', svc, f'port {PORT}')

    print('\n=== next ===')
    if not os.path.isfile(OLLAMA):
        print('  setup()            — Ollama is not installed')
    elif not up:
        print('  ollama_restart()   — the daemon is not running')
    elif models and VLM.split(':')[0] not in models:
        print(f'  setup()            — {VLM} has not been pulled')
    elif n_footage == 0 and stray:
        print('  collect_footage()  — the uploads went to the wrong directory;')
        print('                       this moves them, then build_index()')
    elif n_footage == 0:
        print(f'  upload .mp4 files into {FOOTAGE}, then build_index()')
    elif not has_index:
        print('  build_index()      — there is footage but no index')
    elif not svc:
        print('  start()            — everything is ready, the service is down')
        if os.path.isfile(f'{HOME}/ask.log'):
            print(f'\n--- last of {HOME}/ask.log ---')
            sh(f'tail -n 20 {HOME}/ask.log')
    else:
        print('  nothing — the chain is complete. ask("a bus on the road")')
    return ok


def ask(prompt, k=5, verify=False):
    """Query the service directly, before involving any browser.

    Checks the service is there first. A connection error out of urllib is
    forty lines of traceback ending in "Connection refused", which says where
    it failed and nothing about what to do; the answer is almost always
    "start() was not run, or did not finish".
    """
    if not _service_up():
        print(f'!! nothing is listening on port {PORT}.\n')
        doctor()
        return None

    body = json.dumps({'prompt': prompt, 'k': k, 'verify': verify}).encode()
    req = urllib.request.Request(
        f'http://127.0.0.1:{PORT}/ask', data=body,
        headers={'content-type': 'application/json', 'x-ask-token': _token()})
    try:
        r = json.loads(urllib.request.urlopen(req, timeout=300).read())
    except urllib.error.HTTPError as e:
        print('HTTP', e.code, e.read()[:300].decode('utf8', 'replace'))
        return None
    if r.get('refused'):
        print('REFUSED —', r['refused'])
        return r
    print(f"> {prompt}")
    print(f"  parser {r['plan'].get('parser')} | "
          f"{r['n_candidates']} of {r['n_indexed']} frames | {r['timing']}")
    for x in r['results']:
        print(f"  {x['score']:+.4f}  {x['camera_id']:>12s}  t+{x['t_s']:6.1f}s  "
              f"{x['counts']}")
        if x.get('reason'):
            print(f"               {x['reason']}")
    return r


print(__doc__.split('WHAT THIS TOUCHES')[0].strip())
print('\nSTART:  start_all()  — everything, in order, idempotent')
print('\nsteps:  preflight()  setup()  build_index()  start()  ask("…")')
print('        status()  logs()  stop()')
print('creds:  set_credentials(...)   creds_check()  — shape, not secrets')
print('anpr :  anpr_setup()  anpr_start()  anpr_status()  anpr_logs()  anpr_stop()')
print('diag :  capture_check(cam)  -- why one capture produced no video')
print('        anpr_test()         -- plate accuracy on a recording')
print('hold :  serve_forever()     -- keep a notebook session alive')
print('        ffmpeg_check()      -- which ffmpeg capability is broken')
print('scene:  events_live()       -- all three on a LIVE camera, now')
print('        events_test()       -- the same on a recording')
print('        events_thresholds() -- set them from what you measured')
print('        anpr_start(events=\'crowd,fire,accident\')  -- run them live')
print('share:  tunnel()   — public URL via ngrok (reserved name)')
print('        tunnel_cf() — public URL, no account needed')
print('check:  doctor()   — what is broken and what to run next')
print('        models()   — which models are on this machine')
print('debug:  ollama_debug()  ollama_restart()')
