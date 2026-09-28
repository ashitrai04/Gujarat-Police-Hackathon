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
import shutil
import subprocess
import sys
import textwrap
import time
import urllib.error
import urllib.request

# ── Where things live ──────────────────────────────────────────────────
HOME = os.path.expanduser(os.environ.get('SENTINEL_HOME', '~/sentinel'))
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
    if not os.path.isfile(OLLAMA):
        print('==> fetching Ollama')
        os.makedirs(OLLAMA_DIR, exist_ok=True)
        sh(f'curl -fsSL https://ollama.com/download/ollama-linux-amd64.tgz '
           f'-o {OLLAMA_DIR}/o.tgz && tar -xzf {OLLAMA_DIR}/o.tgz -C {OLLAMA_DIR} '
           f'&& rm -f {OLLAMA_DIR}/o.tgz', check=True)

    _write_env()
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


def _write_env():
    gpu = best_gpu()
    token = _token()
    with open(f'{HOME}/env.sh', 'w') as f:
        f.write(textwrap.dedent(f"""\
            export SENTINEL_HOME="{HOME}"
            export PIPELINE_DIR="{PIPELINE}"
            export VENV="{VENV}"
            export ASK_PYTHON="{PY}"
            export PATH="{OLLAMA_DIR}/bin:$PATH"
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


def _start_ollama():
    if _ollama_up():
        print('    Ollama already up')
        return
    print('==> starting Ollama')
    sh(f'source {HOME}/env.sh && setsid nohup {OLLAMA} serve '
       f'> {HOME}/ollama.log 2>&1 < /dev/null &', quiet=True)
    for _ in range(60):
        if _ollama_up():
            print('    Ollama up')
            return
        time.sleep(1)
    print(f'!! Ollama did not start — see {HOME}/ollama.log')


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


def status():
    up = _service_up()
    print(f'  service : {"up" if up else "down"}   (port {PORT})')
    print(f'  ollama  : {"up" if _ollama_up() else "down"}')
    if up:
        req = urllib.request.Request(f'http://127.0.0.1:{PORT}/health',
                                     headers={'x-ask-token': _token()})
        print('  health  :', urllib.request.urlopen(req, timeout=8).read().decode())
    _, ip = sh("hostname -I 2>/dev/null | awk '{print $1}'", quiet=True)
    print()
    print('  Point the web app at it (Vercel env vars, then redeploy once):')
    print(f'    VITE_ASK_API_URL=http://{ip.strip() or _hostname()}:{PORT}')
    print(f'    VITE_ASK_TOKEN={_token()}')
    print()
    print('  If the browser cannot reach that address, see the "Reaching it"')
    print('  section of pipeline/ask/server/README.md — jupyter-server-proxy is')
    print('  usually the answer, and its authentication is real.')


def logs(n=60, follow=False):
    sh(f'tail -n {n} {"-f " if follow else ""}{HOME}/ask.log')


# ── 5. Try it ──────────────────────────────────────────────────────────
def ask(prompt, k=5, verify=False):
    """Query the service directly, before involving any browser."""
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
print('\nsteps:  preflight()  setup()  build_index()  start()  ask("…")')
print('        status()  logs()  stop()')
