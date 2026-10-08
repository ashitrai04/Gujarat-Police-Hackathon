"""
THE ONLY CELL YOU NEED
======================

Paste this whole file into one Jupyter cell and run it. It fetches the code,
loads the bootstrap, and brings everything up: packages, Ollama and the
language model, the search index, the prompt-search service, the public URL,
and the continuous worker doing plates plus crowd, fire and accident.

Run it again whenever you are unsure what is running. Every step checks before
acting, so a healthy host is left alone and a broken one is repaired. That is
also what to do after the server has been restarted.

FIRST TIME ONLY
---------------
Credentials are not in this file and must never be. Run this once, in its own
cell, before the first start_all():

    set_credentials(
        SUPABASE_URL="https://<project>.supabase.co",
        SUPABASE_SERVICE_KEY="<service_role key>",
        SENTINEL_ACCESS_EMAIL="<grid email>",
        SENTINEL_ACCESS_KEY="<grid key>",
    )

They are written to ~/sentinel/creds.sh with mode 600 and are read from there
on every later run, so this cell never needs them again. The service-role key
is server-side only: it must never appear in a browser bundle or a commit.

AFTER IT FINISHES
-----------------
The kernel can be stopped. Every part runs detached under its own watchdog,
and cron puts things back after a reboot where cron exists. Nothing here needs
the notebook to stay open.

    status()        the search service
    anpr_status()   the plate and scene worker
    anpr_logs()     what it has been doing
    events_live()   prove crowd/fire/accident on a live camera, now
"""
import os
import subprocess

REPO = os.path.expanduser(os.environ.get('SENTINEL_REPO', '~/sentinel-command-center'))
GIT_URL = os.environ.get(
    'SENTINEL_GIT', 'https://github.com/ashitrai04/Gujarat-Police-Hackathon')

if os.path.isdir(f'{REPO}/.git'):
    print('==> updating the checkout')
    subprocess.run(['git', '-C', REPO, 'pull', '--ff-only'], check=False)
else:
    print(f'==> cloning into {REPO}')
    subprocess.run(['git', 'clone', '--depth', '1', GIT_URL, REPO], check=False)

BOOTSTRAP = f'{REPO}/pipeline/ask/server/bootstrap.py'
if not os.path.isfile(BOOTSTRAP):
    raise SystemExit(
        f'{BOOTSTRAP} is missing. If the repository is private, clone it by '
        f'hand with a token and set SENTINEL_REPO to where it landed.')

# exec rather than import: the bootstrap is written to define its helpers in
# the notebook's own namespace, so status(), anpr_logs() and the rest are
# callable from later cells without a module prefix.
exec(compile(open(BOOTSTRAP).read(), BOOTSTRAP, 'exec'))

# Everything, in order, idempotent.
start_all(events='crowd,fire,accident')          # noqa: F821 - from the exec
