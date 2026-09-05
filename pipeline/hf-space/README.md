---
title: Sentinel ANPR Worker
emoji: 🛰️
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---

# Sentinel ANPR worker

Vehicle detection and number-plate reading for the Gujarat Police Sentinel
platform. Consumes a camera feed, writes sightings into the Sentinel registry,
and exposes a small HTTP API so the control room can trigger and monitor runs.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness, model load state, queue depth |
| `POST` | `/analyze` | Queue a camera for analysis |
| `GET` | `/jobs` | Recent job status |
| `GET` | `/jobs/{id}` | One job's result |

```bash
curl -X POST $SPACE/analyze \
  -H 'content-type: application/json' \
  -d '{"camera_id":"cam08","url":"rtsp://103.250.160.189:8554/stream/cam08","seconds":60}'
```

## Secrets to set on the Space

| Name | Why |
|---|---|
| `SUPABASE_URL` | Where detections are written |
| `SUPABASE_SERVICE_KEY` | Service role — row-level security would refuse the anon key. Server-side only. |
| `SENTINEL_ACCESS_KEY` | Grid access key, for pulling HLS from the camera host |

Without the Supabase secrets the worker still runs and returns results over the
API, but stores nothing — it reports that plainly in `/health` rather than
failing silently.

## A note on the free tier

The free CPU Space has no GPU. This pipeline was measured at 40 s for 16 s of
1080p video **on an RTX 3050**; on CPU expect several times that, so treat the
free tier as suitable for on-demand analysis of a few cameras rather than
continuous processing of the estate. Upgrade to a GPU Space, or run the worker
on a GPU host, before pointing it at many cameras at once.
