# Prompt for bringing Sentinel up on a new machine

Paste the block below into a fresh Claude Code session **in the folder where
the archive was unzipped** (or a clone of the repository). It carries the
context a new session does not have: where things are, what is expected to
fail, and what must never be done.

It deliberately contains **no credentials**. The agent is told to ask.

---

```
You are setting up the server half of Sentinel, a GIS CCTV command centre, on
this machine. The web application is already deployed and is not your concern
— nothing here gets deployed. Work in the current folder.

WHAT "EVERYTHING" MEANS
Four things must end up running or proven:
  1. the continuous worker — reads plates (ANPR) off the camera grid and
     scores each clip for crowd, fire and accident, writing rows and
     snapshots into Supabase
  2. prompt search — natural-language search over camera frames (SigLIP 2 +
     a local Qwen2.5-VL through Ollama)
  3. the Supabase schema, migrations applied
  4. a check that proves the chain works, not an assumption that it does

START HERE
Read LAPTOP_SETUP.md in this folder first; it is the written-down version of
all of this. Then:
  - Windows: run SETUP.ps1, then RUN-SERVER.ps1. SETUP.ps1 is idempotent —
    re-run it rather than unpicking a half-finished install.
  - Linux: load pipeline/ask/server/bootstrap.py with exec() and call
    start_all(events='crowd,fire,accident'). Everything is a function in
    there: status(), anpr_status(), anpr_logs(), doctor(), events_live().
  - Do NOT try to run bootstrap.py on Windows. It is built on bash and
    setsid and will not work there.

CREDENTIALS — ASK, NEVER INVENT
Four are needed, and none are in the archive:
  SUPABASE_URL, SUPABASE_SERVICE_KEY, SENTINEL_ACCESS_EMAIL,
  SENTINEL_ACCESS_KEY
Ask me for them. They go in pipeline/.env.worker (gitignored) and nowhere
else. SUPABASE_SERVICE_KEY is a service_role key: it bypasses row-level
security, so it must never reach a browser bundle, a VITE_ variable, a
committed file or a screenshot. If a step seems to need it client-side, stop
and tell me — that is a design error, not a configuration one.

THE SCHEMA
Apply supabase/migrations/ in order if they are not already applied. 0007 is
the one that creates `events`, which crowd/fire/accident write to; without it
those writes fail and the Scene tab in the web app stays empty. I will run the
SQL — give me the file to paste.

PROVE IT, THEN TRUST IT
Before declaring anything done, run one camera end to end and show me the
output:
  Windows: .\RUN-SERVER.ps1 -TestOnly
  Linux:   events_live('cam08')
That exercises sign-in, capture, decode, both models and the database write.
"N vehicles, M plates" is the plate accuracy figure.

WHAT IS EXPECTED TO REPORT NOTHING
Crowd counting is a real detector and should return a number. Fire and
accident are zero-shot screeners — an image/text model scoring frames against
positive and negative descriptions. Their `score` is a margin, not a
probability. On an ordinary street the correct result is nothing found. Do not
"fix" that, do not lower thresholds to make them fire, and do not describe
their output as a confirmed detection anywhere.

KNOWN FAILURES — DO NOT RE-DIAGNOSE THESE
  - "capture failed: ... exit -11" is ffmpeg segfaulting. Handled: the code
    falls back to fetching HLS segments over HTTP. Not a bug to fix.
  - "capture failed: no stderr; exit 0, N bytes" means the stream is up but
    publishing almost nothing. The camera, not the code.
  - "playlist HTTP 403" means the grid is already signed in from somewhere
    else. It allows one session per address. Stop the other worker first.
  - An import of `easyocr` is deliberate and handled by a stub; PaddleOCR
    does the reading. Do not install easyocr.
  - If a GPU is present but torch reports CPU, torch was installed as a
    dependency of something else and resolved the CPU build. Reinstall torch
    on its own from the CUDA index. This is the single most expensive thing
    to get wrong — everything still runs, roughly thirty times slower, with
    nothing in the output to say why.

HOW I WANT YOU TO WORK
Run the commands yourself rather than handing me a list. Show real output,
not a summary of it. If something fails, say so with the error — do not
report success you have not seen. If a download is large, say how large
before starting it. Ask before anything that writes to the database beyond
the one test above.

Begin by reading LAPTOP_SETUP.md and telling me what this machine already has
(Python, GPU, Ollama) and what it still needs.
```

---

## Variants

**Kaggle, not a laptop.** Replace the START HERE section with: *"Read
pipeline/ask/server/KAGGLE_CELL.py and run it as a single cell. Credentials
come from Kaggle Secrets, not a file. The last line blocks on purpose — it is
what keeps the session alive. Note the 12-hour session ceiling and weekly GPU
cap in anything you tell me about uptime."*

**The GPU server, once it is back.** Replace it with: *"Read
pipeline/ask/server/ONE_CELL.py and run it in one Jupyter cell. It calls
start_all(), which is idempotent — use it to check and repair, not just to
start."*

**Pointing the web app at this host.** Only prompt search is called by the
browser; the worker needs no inbound access at all, because it writes to
Supabase and the site reads from there. If the assistant is wanted:
`cloudflared tunnel --url http://localhost:8077`, then open
`<site>/?ask=<printed URL>&askToken=<token>` once. `?ask=off` clears it.
