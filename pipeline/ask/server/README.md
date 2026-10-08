# Running prompt search on a GPU host

The service that answers "ask the estate" holds several gigabytes of models and
wants a GPU. On a laptop that means it is up only while the laptop is, and a
hosted page pointed at it breaks every time the machine sleeps. Moving it to a
server fixes that properly: one address, always answering, no tunnel to expire.

Written for a shared multi-GPU box reached through Jupyter, with no root.

## Layout

| | |
|---|---|
| `setup.sh` | virtualenv, Python packages, Ollama, models. Once. |
| `build_index.sh` | footage → searchable index. After every change of footage. |
| `run.sh` | start / stop / status / logs, with a watchdog. |
| `Sentinel_Ask_Server.ipynb` | the same steps as notebook cells. |

Everything installs under `$SENTINEL_HOME` (default `~/sentinel`). Nothing is
written outside your home directory and nothing needs sudo — Ollama comes from
its release tarball rather than the install script, which wants `/usr/local`
and a systemd unit.

## Quick start — one cell

On a Jupyter host, paste [`ONE_CELL.py`](ONE_CELL.py) into a single cell and
run it. It clones or updates the repository, loads the bootstrap, and calls
`start_all()`, which brings up everything in order: packages, Ollama and the
language model, the search index, the prompt-search service, the public URL,
and the continuous worker doing plates plus crowd, fire and accident.

Credentials go in once, in their own cell, before the first run:

```python
set_credentials(
    SUPABASE_URL="https://<project>.supabase.co",
    SUPABASE_SERVICE_KEY="<service_role key>",
    SENTINEL_ACCESS_EMAIL="<grid email>",
    SENTINEL_ACCESS_KEY="<grid key>",
)
```

They are stored in `~/sentinel/creds.sh` at mode 600 and read on every later
run. The service-role key is server-side only and must never reach a browser
bundle or a commit.

`start_all()` is also the right thing to run when you do not know what state
the host is in. Every step checks before acting, so it skips what is healthy
and repairs what is not — after a crash, after a restart, or on a fresh host.

Once it finishes the kernel can be stopped. Each part runs detached under its
own watchdog, and `keepalive_install()` adds a cron entry at boot and every
five minutes to put back anything that disappeared. Where the host has no
cron — common in notebook containers — it says so rather than pretending, and
the one cell has to be re-run after a restart.

## Quick start — step by step

The individual steps, for when something needs doing by hand:

```bash
git clone https://github.com/ashitrai04/Gujarat-Police-Hackathon.git ~/sentinel-command-center
cd ~/sentinel-command-center/pipeline/ask/server

bash setup.sh                       # once, ~15 min, mostly download
mkdir -p ~/sentinel/footage         # put .mp4 recordings here
bash build_index.sh
bash run.sh                         # detached, watchdogged
bash run.sh --status
```

Then point the web app at it — see **Reaching it** below.

## Choosing models

Both are environment variables, so the same code runs on a 6 GB laptop and a
40 GB card without edits.

| | laptop default | server default |
|---|---|---|
| `ASK_VLM_MODEL` | `qwen2.5vl:3b` | `qwen2.5vl:7b` |
| `ASK_EMBED_MODEL` | `google/siglip2-base-patch16-384` | same |

The vision-language model can be swapped freely — it parses prompts and verifies
frames, and nothing stored depends on it. **The embedding model cannot.**
Embeddings from two towers are not comparable, so changing it means rebuilding
the index; the service refuses to start on a mismatch rather than returning
confident nonsense.

`setup.sh` picks the GPU with the most free memory rather than device 0. The
card is shared: assuming device 0 is how a job dies on an allocation somebody
else already owns.

## Reaching it from the browser

In order of preference.

**A hostname the browser can resolve.** Same network, VPN, or a campus DNS name.
Nothing to expire, no third party, no tunnel. `run.sh` prints the host's address.

**Jupyter's proxy.** If the only route in is the Jupyter URL:

```bash
pip install jupyter-server-proxy    # then restart the Jupyter server
```

The service then answers at `<jupyter-url>/proxy/8077/`, inheriting Jupyter's
own authentication — which is better than the shared token, because it is real.

**ngrok**, if neither works. Reserve a free domain first, or the address changes
on every restart:

```bash
export NGROK_DOMAIN=your-name.ngrok-free.app
bash run.sh --tunnel
```

Then in Vercel, once:

```
VITE_ASK_API_URL=https://<the address>
VITE_ASK_TOKEN=<contents of ~/sentinel/token>
```

The web app polls while the panel is open, so once this is configured it
reconnects on its own whenever the service comes back. No reload, no repointing.

## Keeping it up

`run.sh` starts the service with `setsid`, in its own session, so it survives the
Jupyter kernel restarting or the notebook being culled. Do not run the server
inside a cell and leave the cell running — that is exactly the arrangement that
dies quietly.

A watchdog restarts the service if it exits and restarts Ollama if Ollama exits,
backing off to a minute so a broken configuration does not spin. On a shared host
another job can take the memory this one wanted and kill it mid-afternoon with
nobody watching.

It does **not** survive a reboot. If the host restarts, run `run.sh` again — or
ask whoever administers it for a systemd unit, which is the proper answer and
needs root.

## Security

The token is generated on first run and kept in `~/sentinel/token`, mode 600.
Every request must carry it, as a header or as `?t=` on thumbnails, since an
`<img>` cannot send a header.

Be clear about what it buys. The browser is the client, so the token travels in
the page and is visible to anyone using it. It stops an open endpoint being
found by a scanner. It does not stop someone who has the link. If that matters,
use the Jupyter proxy, where the authentication is real.

The service is read-only — it answers questions about an index — but it will
answer as many as it is asked, on your GPU allocation.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `index was built with … but ASK_EMBED_MODEL is …` | the embedding model changed; rebuild the index |
| first query takes ~20 s, later ones are fast | Ollama loading the model. `OLLAMA_KEEP_ALIVE=24h` is set to avoid repeating it |
| service restarts in a loop | `bash run.sh --logs`; usually CUDA out of memory because the card filled up |
| 401 on every request | the token in the web app does not match `~/sentinel/token` |
| health fine locally, web app cannot reach it | the port is not exposed — see **Reaching it** |
