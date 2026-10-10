# Running the Sentinel server half on another laptop

This is everything the GPU box was doing, moved to a laptop: prompt search,
the language model, plate reading, and crowd / fire / accident. The web
application stays where it is — nothing here is deployed, and nothing here
needs a public IP.

**There are no credentials in this archive.** They are listed at the end and
have to be entered once on the new machine.

---

## What is in the archive

```
sentinel-server/
  pipeline/                    the worker and the search service
    ask/                       prompt search, and the server bootstrap
    ask/server/bootstrap.py    every command below lives in here
    sentinel-gujarat-pipeline/ the detection pipeline  ← not on GitHub
    weights/                   SigLIP and CLIP, if the archive includes them
  supabase/migrations/         the schema, including events (0007)
  start.ps1                    Windows launcher
  LAPTOP_SETUP.md              this file
```

`sentinel-gujarat-pipeline/` matters: it is excluded from the Git repository,
so cloning from GitHub does **not** produce it. Plate reading fails without
it. It is in this archive precisely because it cannot be fetched.

---

## What still has to download

Only one thing is genuinely unavoidable:

| | Size | Why |
|---|---|---|
| Ollama + a vision-language model | ~3 GB (`qwen2.5vl:3b`) or ~6 GB (`:7b`) | Could not be copied — these were on the server that is down |
| SigLIP / CLIP weights | ~1.1 GB | Included in the archive if it was built with weights; otherwise downloaded |
| YOLO detector | ~20–110 MB | Downloaded on first use |

Pick `3b` on a laptop. `7b` parses and verifies noticeably better and wants a
card with room for it.

---

## Linux laptop

The bootstrap was written for this and does the whole thing itself.

```bash
unzip sentinel-server.zip -d ~/
cd ~/sentinel-server

python3 - <<'EOF'
import os
os.environ['SENTINEL_REPO'] = os.path.expanduser('~/sentinel-server')
exec(open(os.path.expanduser('~/sentinel-server/pipeline/ask/server/bootstrap.py')).read())
set_credentials(
    SUPABASE_URL="https://<project>.supabase.co",
    SUPABASE_SERVICE_KEY="<service_role key>",
    SENTINEL_ACCESS_EMAIL="<grid email>",
    SENTINEL_ACCESS_KEY="<grid key>",
)
start_all(events='crowd,fire,accident')
EOF
```

`start_all()` is idempotent: run it again any time to check and repair. Every
part detaches under its own watchdog, so the shell can be closed afterwards.

Useful afterwards, in the same kind of block:

```
status()        the search service
anpr_status()   the plate and scene worker
anpr_logs()     what it has been doing
events_live()   crowd / fire / accident on one live camera, right now
doctor()        what is broken and what to run next
```

---

## Windows laptop

`bootstrap.py` is written around bash, `setsid` and POSIX paths, so it does
**not** run on Windows. Use `start.ps1`, which is the Windows launcher, and
run the pieces directly.

### 1. Prerequisites

- **Python 3.10–3.12** from python.org, "Add to PATH" ticked.
- **Ollama** from <https://ollama.com/download> — installs as a service.
- **NVIDIA driver**, if the laptop has a card. Nothing else; the CUDA runtime
  comes with PyTorch.
- **ffmpeg** — optional. `pip install imageio-ffmpeg` provides one, which is
  what the pipeline falls back to.

### 2. Install

```powershell
cd $HOME\sentinel-server
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# Torch first, so pip does not pull a CPU build underneath it.
# CPU-only laptop: drop the index-url line.
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
pip install -r pipeline\requirements.txt
pip install supabase paddleocr paddlepaddle "open-image-models[onnx]" `
            opencv-python-headless imageio-ffmpeg

ollama pull qwen2.5vl:3b
```

### 3. Credentials

Create `pipeline\.env.worker`. **It is gitignored and must never be
committed, shared or pasted into a chat.**

```ini
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_KEY=<service_role key>
SENTINEL_ACCESS_EMAIL=<grid email>
SENTINEL_ACCESS_KEY=<grid key>
SENTINEL_PIPELINE_DIR=./pipeline/sentinel-gujarat-pipeline
```

The service-role key bypasses row-level security. It belongs on a server and
in nothing that reaches a browser.

### 4. Check it before relying on it

```powershell
# One recording, end to end: detection, OCR, database write, evidence images.
python pipeline\sentinel_worker.py "C:\path\to\clip.mp4" --camera cam08

# Crowd, fire and accident on the same clip.
python pipeline\events.py "C:\path\to\clip.mp4" --camera cam08 --store-all

# A live camera, signing in to the grid first.
python pipeline\events.py "https://cctv.corp8.cloud/cam08/index.m3u8" `
    --camera cam08 --seconds 30 --store-all
```

`N vehicles, M plates` is the accuracy figure. For the scene events, read the
margins rather than the verdict: fire and accident are screeners, and on an
ordinary street reporting nothing is the correct answer.

### 5. Run it continuously

```powershell
# Plates plus crowd/fire/accident over every camera in the registry, forever.
python pipeline\live_worker.py --seconds 30 --events crowd,fire,accident

# Prompt search, if the index has been built.
python -m ask.serve --index .\_index --host 127.0.0.1 --port 8077
```

Windows has no `setsid`, so these hold their window open. Leave them running,
or wrap them with NSSM or Task Scheduler to survive a logout.

---

## Connecting the web application

Only prompt search is called by the browser. The worker needs no inbound
access at all: it writes to Supabase and the site reads from there, so
detections, crowd counts, the Scene tab and the map all work with nothing
exposed.

If the assistant is wanted too, the laptop needs a tunnel — it has no public
address. Cloudflare needs no account:

```bash
cloudflared tunnel --url http://localhost:8077
```

Then open the printed link once, with the address attached:

```
https://<your site>/?ask=https://xxx.trycloudflare.com&askToken=<token>
```

The browser remembers it and prefers it over the built-in settings.
`/?ask=off` clears it. The token is printed by `status()`, or is `ASK_TOKEN`
in `~/sentinel/env.sh`.

---

## Database

If this laptop is writing to a Supabase project that has not had them
applied, run the migrations in `supabase/migrations/` in order. `0007_events.sql`
is the one that creates the table crowd, fire and accident write to; without
it those writes fail and the Scene tab stays empty.

---

## Credentials needed, and where to get them

| Name | What it is |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_KEY` | the same page, **service_role**, not anon |
| `SENTINEL_ACCESS_EMAIL` | the registered email for the camera grid |
| `SENTINEL_ACCESS_KEY` | the grid access key |

None of them are in this archive, deliberately.

**Rotate the Supabase service-role key and the ngrok authtoken if they have
ever been pasted into a chat, a screenshot or a notebook output.** Anything
that has been shown once should be treated as public.

---

## If something does not work

| Symptom | Cause |
|---|---|
| `capture failed: ... exit -11` | the ffmpeg build segfaults; the HTTP fetch takes over automatically |
| `capture failed: no stderr; exit 0, N bytes` | the stream is up but publishing almost nothing |
| `playlist HTTP 403` | the grid allows one session per address; something else is signed in |
| `relation "public.events" does not exist` | migration `0007` has not been applied |
| `SUPABASE_SERVICE_KEY is not a JWT` | the key is truncated, or still a placeholder |
| Scene tab empty | the worker is not running with `--events`, or the migration is missing |
| plate reading imports `easyocr` | handled — a stub is registered; PaddleOCR does the reading |

On Linux, `doctor()` reports most of these and names the next command.
