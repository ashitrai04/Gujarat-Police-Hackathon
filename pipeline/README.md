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

## Crowd, fire and accident

`events.py` scores a clip for three scene events and writes them to `events`
(migration `0007_events.sql`). It is a separate entry point from the plate
worker because it answers a different question, but in the live worker the two
share one captured clip — see below.

```bash
python events.py clip.mp4 --camera cam08                     # all three
python events.py clip.mp4 --camera cam08 --kinds crowd        # just one
python events.py clip.mp4 --camera cam08 --device cpu --store-all
```

**The three are not equally trustworthy, and the schema records which is
which.**

- **Crowd** is a detector, stored as `method='detector'`. YOLO finds people and
  they are counted; `people_peak` is a measurement. Severity comes from
  thresholds (`SENTINEL_CROWD_MEDIUM`, default 25; `SENTINEL_CROWD_HIGH`,
  default 60), because forty people is nothing at a railway station and a
  serious problem on a flyover.
- **Fire** and **accident** are zero-shot screeners, stored as
  `method='zero-shot'`. There is no trained fire model in this project and none
  in the asset list, so rather than claim one, the same SigLIP 2 tower that
  answers prompt search scores each frame against a set of positive
  descriptions and a set of negative ones. `score` is the margin between the
  best of each — a similarity, **not** a probability. These rows mean "worth a
  look", never "there is a fire", and they are capped at severity `medium` for
  that reason.

The negatives matter as much as the positives. A night traffic scene scores a
respectable cosine against "fire" on colour alone — sodium lighting, brake
lights, wet tarmac — so an absolute threshold fires on every evening clip.
Scoring the best positive against the best negative cancels most of that.

Two frames must agree for fire and three for accident; a single frame over
threshold is usually a reflection. If fewer frames are sampled than the rule
demands, the kind **cannot** fire at all, and the note says so rather than
reporting a quiet scene.

### Calibrating it

The default thresholds (fire 0.08, accident 0.05) are starting points, not
measurements. Score footage that does contain the event and footage that does
not, then put the threshold between them — clips with no incident are the more
useful half of that comparison. `--store-all` keeps findings that did not fire,
so a threshold can be retuned later against footage already scored.

Overridable per host: `SENTINEL_FIRE_THRESHOLD`,
`SENTINEL_ACCIDENT_THRESHOLD`, `SENTINEL_FIRE_MIN_HITS`,
`SENTINEL_ACCIDENT_MIN_HITS`, and the two crowd thresholds. A value that will
not parse falls back to the default rather than stopping the worker.

### GPU and CPU

Device choice follows what is **free**, not what is installed, because a shared
host regularly has most of its memory taken by someone else's job:
`SENTINEL_EVENT_DEVICE` forces `gpu` or `cpu`, otherwise ≥3 GB free selects the
GPU plan. The GPU plan samples a frame per second with `yolo11m`; the CPU plan
samples every three seconds with `yolo11s`. The difference is throughput, not
capability — the same events are found either way, a CPU pass is just coarser
in time. Nothing here needs weights beyond what vehicle detection and prompt
search already download.

### In the live worker

`live_worker.py --events crowd,fire,accident` adds scene analysis to the
continuous pass, and the server bootstrap exposes it as
`anpr_start(events='crowd,fire,accident')`. It shares the clip the plate pass
already captured rather than running as a second worker, for three reasons: the
grid allows one session per address, so a second sign-in would invalidate the
first one's cookie; capturing each camera twice doubles the bandwidth for no
new information; and decoding is a real cost better paid once. The two analyses
are wrapped separately, so a missing retrieval model costs the events and not
the plates.

Left off, nothing about the existing plate behaviour changes.

### What is not implemented

The upstream pipeline README describes crowd analytics "via CrowdLens" and
lists it under external assets that must be provided. It is not in this
repository, in the same way `FINAL_NIGHT_MODEL.pt` is not. Waiting for it would
mean no crowd counting at all, so this counts people with the detector already
present. Density heatmaps and line crossings, the rest of CrowdLens's remit,
are **not** reimplemented.

## Where to host it

**Not on Cloudflare.** Workers run JavaScript and WebAssembly under tight CPU
limits with no CUDA, and Workers AI serves a fixed model catalogue that does not
include this pipeline. R2 is the right Cloudflare product for the video; there
is no Cloudflare product that will run this inference.

Use a GPU host: a Hugging Face Space, a cloud VM with a GPU, or a local machine
for the demo. On an RTX 3050 this clip took 40 s for 16 s of video at
`frame-skip 2` — roughly 2.5× real time for one camera, so plan one GPU per
handful of cameras rather than per estate.
