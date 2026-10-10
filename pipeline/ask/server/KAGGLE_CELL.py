"""
RUNNING SENTINEL ON KAGGLE
==========================

A stand-in for the GPU server, not a replacement. Everything the dedicated
host runs will run here -- prompt search, the language model, plate reading,
crowd, fire and accident -- but the host is a different shape and it is worth
knowing how before relying on it.

WHAT KAGGLE WILL AND WILL NOT DO
--------------------------------
A session ends after about 12 hours, and an idle kernel is reclaimed sooner
than that. GPU time is also capped per week. So this cannot be left running
the way the dedicated server could: it is a thing you start when you need it
and which stops on its own afterwards.

That is why the last line of this file blocks. serve_forever() holds the
session open and keeps checking, and output is what marks the kernel busy.
Stop that cell and everything here stops with it. There is no cron on Kaggle
and nothing to restart anything, so the cell is the keep-alive.

Nothing in /root survives the session. /kaggle/working does, and is saved as
the notebook's output, so the bootstrap puts the models, the index and the
credentials there. To avoid downloading several GB again next time, attach
this notebook's output as a dataset to the next session and set
SENTINEL_HOME to point at it.

BEFORE THE FIRST RUN
--------------------
1. Settings -> Accelerator -> GPU (T4 or P100).
2. Settings -> Internet -> On. Without it nothing can be downloaded. It needs
   a phone-verified account.
3. Add-ons -> Secrets, and add these four, so credentials are never in the
   notebook source and survive between sessions:
       SUPABASE_URL
       SUPABASE_SERVICE_KEY
       SENTINEL_ACCESS_EMAIL
       SENTINEL_ACCESS_KEY
   NGROK_AUTHTOKEN and NGROK_DOMAIN are optional. With them the tunnel comes
   up on the reserved hostname the web app already points at; without them a
   Cloudflare quick tunnel is used instead, which needs no account.

HOW MUCH OF THIS NEEDS A TUNNEL
-------------------------------
Less than it looks. The plate and scene worker is a writer, not an API: it
reads the feeds, writes rows and snapshots into Supabase, and the browser
reads them from there. Detections, crowd counts, the Scene tab and the map
all work with no inbound access to this notebook at all.

Only the assistant -- prompt search -- is called by the browser directly, and
that is the one thing a tunnel is for. Kaggle has no inbound ports, so if you
want the assistant you need one; if you do not, pass expose='none' below and
skip it entirely.

THE GPU SERVER IS STILL THE PREFERRED HOST
------------------------------------------
Nothing here changes it. The web application probes its endpoints in order --
the GPU server first, then the fallback -- and re-checks the better ones
every couple of minutes, so it moves back on its own when that host returns.
See the note at the bottom of this file for which URL to put where.
"""
import os
import subprocess
import sys

# ── Credentials, from Kaggle's own secret store ────────────────────────────
# Read before the bootstrap loads so set_credentials() can write them to
# creds.sh, which is what the detached workers read. Missing secrets are
# reported rather than guessed at: the worker refuses to start without the
# service key anyway, and saying so here is clearer than a watchdog loop.
SECRETS = ('SUPABASE_URL', 'SUPABASE_SERVICE_KEY',
           'SENTINEL_ACCESS_EMAIL', 'SENTINEL_ACCESS_KEY',
           'NGROK_AUTHTOKEN', 'NGROK_DOMAIN')
creds = {}
try:
    from kaggle_secrets import UserSecretsClient
    _sec = UserSecretsClient()
    for name in SECRETS:
        try:
            value = _sec.get_secret(name)
            if value:
                creds[name] = value.strip()
        except Exception:                                 # noqa: BLE001
            pass
    print(f'==> secrets found: {", ".join(creds) or "none"}')
except ImportError:
    print('==> not a Kaggle kernel; falling back to the environment')
    creds = {k: os.environ[k] for k in SECRETS if os.environ.get(k)}

missing = [k for k in SECRETS[:4] if k not in creds]
if missing:
    print(f'!! missing secrets: {", ".join(missing)}')
    print('   Add-ons -> Secrets. Plate reading and scene events cannot be')
    print('   stored without them; prompt search will still work.')

# ── Where things live, and which interpreter to use ────────────────────────
# /kaggle/working is the volume that is kept. The bootstrap defaults to it on
# its own when it sees Kaggle, but it is set here too so this file is explicit
# about where several GB are about to land.
os.environ.setdefault('SENTINEL_HOME', '/kaggle/working/sentinel')
os.environ.setdefault('SENTINEL_REPO', '/kaggle/working/sentinel-command-center')
# Kaggle's image already has torch built for its CUDA, plus transformers,
# ultralytics and opencv. Using it instead of a fresh venv saves several GB
# and a slice of a capped weekly GPU allowance.
os.environ.setdefault('ASK_PYTHON', sys.executable)
# The 3B vision-language model rather than the 7B the dedicated server runs.
# 7B parses and verifies better and is the right choice where there is room;
# here the download, the disk and the session clock all argue for the smaller
# one. Change this line if the quality matters more than the start-up time.
os.environ.setdefault('ASK_VLM_MODEL', 'qwen2.5vl:3b')

REPO = os.environ['SENTINEL_REPO']
GIT_URL = 'https://github.com/ashitrai04/Gujarat-Police-Hackathon'
if os.path.isdir(f'{REPO}/.git'):
    subprocess.run(['git', '-C', REPO, 'pull', '--ff-only'], check=False)
else:
    subprocess.run(['git', 'clone', '--depth', '1', GIT_URL, REPO], check=False)

BOOTSTRAP = f'{REPO}/pipeline/ask/server/bootstrap.py'
if not os.path.isfile(BOOTSTRAP):
    raise SystemExit(f'{BOOTSTRAP} missing — did the clone fail? '
                     f'Internet must be On in Settings.')
exec(compile(open(BOOTSTRAP).read(), BOOTSTRAP, 'exec'))

# ── Store the credentials where the detached workers read them ─────────────
if creds:
    set_credentials(**{k: v for k, v in creds.items()      # noqa: F821
                       if k.startswith(('SUPABASE', 'SENTINEL'))})

# ── Everything up ──────────────────────────────────────────────────────────
# keepalive_install() will report that there is no crontab here. That is
# correct and expected: on Kaggle the keep-alive is the blocking cell below,
# not cron.
# expose='auto' uses ngrok when there is a token for it, because a reserved
# hostname can go in a Vercel variable and be forgotten about. With no token
# it uses a Cloudflare quick tunnel instead, which needs no account and no
# sign-up -- the trade is a hostname that changes every run, so the link has
# to be pasted into the site once per session (it prints one, ready to click).
#
# expose='none' is also a reasonable answer here. The plate and scene worker
# does not need inbound access at all: it writes to Supabase and the browser
# reads from Supabase, so crowd counts, detections and their snapshots all
# arrive with no tunnel of any kind. Only the assistant talks to this host
# directly.
start_all(                                                  # noqa: F821
    events='crowd,fire,accident',
    expose='auto',
    domain=creds.get('NGROK_DOMAIN') or None,
    # Passed every run, because ngrok stores it in the home directory and
    # Kaggle throws that away with the session.
    authtoken=creds.get('NGROK_AUTHTOKEN') or None,
)

# ── Hold the session open ──────────────────────────────────────────────────
# Blocks on purpose. This is the only thing keeping the kernel from being
# reclaimed, and it re-checks and restarts the parts as it goes.
serve_forever()                                             # noqa: F821

# ── Pointing the web app at this host ──────────────────────────────────────
#
# Two arrangements, depending on whether a second reserved hostname exists.
#
# One hostname (the usual case). While the GPU server is down it is not using
# its domain, so this takes it over: put NGROK_DOMAIN in the secrets as the
# same reserved hostname, and nothing in Vercel changes at all. When the GPU
# server comes back, stop this session and it reclaims the name.
#
# Two hostnames. Leave VITE_ASK_API_URL as the GPU server and set
# VITE_ASK_FALLBACK_URL to this one. The browser probes them in that order and
# re-checks the better one every two minutes, so it uses Kaggle while the GPU
# server is down and moves back by itself when it answers again -- no redeploy
# and nothing to remember.
#
# Neither of those, in a hurry: open the assistant in the web app and paste
# this session's URL as the saved address. It is tried ahead of both
# environment variables and lives only in that browser, so clearing it falls
# straight back to the GPU server.
