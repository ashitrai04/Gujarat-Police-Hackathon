# Sentinel inference worker

Runs the team's vehicle-detection + ANPR pipeline
([sentinel-gujarat-pipeline](https://github.com/ayushtriapty88-hue/sentinel-gujarat-pipeline))
and writes its output into the `detections` table this application reads, so
vehicle tracing, movement search and watchlist alerts have real data.

## Measured against known plates

A 16-second Majevadi Gate clip whose plates were verified by hand first —
`GJ04EP2038`, `GJ03PA8482`, `GJ07A4509` — so these are recall figures against a
known answer, not a count of whatever the pipeline emitted.

| Variant | Recall | Precision | Runtime |
|---|---|---|---|
| Pipeline as written (EasyOCR) | 0.33 | 0.25 | 184 s |
| + tiled plate detection | 0.00 | 0.00 | 103 s |
| **+ PaddleOCR (what this ships)** | **1.00** | **0.60** | **40 s** |

Every EasyOCR miss was one or two characters out — `GJ04EP2008` for
`GJ04EP2038`, `GJ02A4509` for `GJ07A4509` — so detection and tracking were
already working and recognition was the whole bottleneck.

The two remaining "false positives" (`GJ11CO9040`, `GJ05JO7509`) are plates from
vehicles that were not in the hand-verified set, so real precision is likely
higher than 0.60. They were not counted as correct because they were not
verified.

## Run it

```bash
pip install -r requirements.txt
git clone https://github.com/ayushtriapty88-hue/sentinel-gujarat-pipeline

export SENTINEL_PIPELINE_DIR=./sentinel-gujarat-pipeline
export SUPABASE_URL=https://<project>.supabase.co
export SUPABASE_SERVICE_KEY=<service_role key>   # server-side only, never in a browser

python sentinel_worker.py "rtsp://103.250.160.189:8554/stream/cam08" --camera cam08
python sentinel_worker.py clip.mp4 --camera cam04 --tiled   # wide camera, small plates
```

Without the Supabase variables the worker prints the rows it would write
instead of storing them, so the pipeline can be exercised without a database.

## Flags worth knowing

- `--tiled` — tile plate detection at native resolution. Off by default: it
  improved nothing once PaddleOCR was in place and cost 2.8× the runtime. It
  earns its cost only where plates are small. Measured across this estate, a
  camera presenting plates at 70–88 px reads fine full-frame; one presenting
  42–50 px returns nothing either way.
- `--mode day|night|auto` — `auto` picks from frame brightness. Night uses the
  team's custom Indian-vehicle model (`--night-model FINAL_NIGHT_MODEL.pt`).
- `--frame-skip N` — process every Nth frame. 2 is the default.

## Where to host it

**Not on Cloudflare.** Workers run JavaScript and WebAssembly under tight CPU
limits with no CUDA, and Workers AI serves a fixed model catalogue that does not
include this pipeline. R2 is the right Cloudflare product for the video; there
is no Cloudflare product that will run this inference.

Use a GPU host: a Hugging Face Space, a cloud VM with a GPU, or a local machine
for the demo. On an RTX 3050 this clip took 40 s for 16 s of video at
`frame-skip 2` — roughly 2.5× real time for one camera, so plan one GPU per
handful of cameras rather than per estate.
