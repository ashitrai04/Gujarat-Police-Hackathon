# Prompt search — "ask the estate"

Describe an incident in plain language; get back ranked moments from the camera
estate with a thumbnail, camera, offset, the object counts a detector actually
found, and — when asked — a sentence from a vision-language model saying what it
saw.

Everything runs locally. Nothing about a query leaves the machine.

## Why four models and not one

A sentence an operator types mixes constraints that want different machinery.
Sending the whole sentence to any single model wastes the parts it cannot use.

| What the prompt says | Handled by |
|---|---|
| "at Majevadi Gate", "three people" | SQLite filters over indexed counts |
| "GJ03PA8482" | the existing `detections` table, not this index |
| "crowd blocking the carriageway" | SigLIP 2 image–text retrieval |
| "without a helmet", "a white car" | YOLO-World, open-vocabulary |
| deciding which of the above applies | Qwen2.5-VL 3B, locally |
| "is this frame actually it?" | Qwen2.5-VL 3B, on the shortlist only |

| Model | Role | Size | Stage |
|---|---|---|---|
| `google/siglip2-base-patch16-384` | scene retrieval | 1.5 GB fp32 / ~0.9 GB VRAM fp16 | index + query |
| `qwen2.5vl:3b` (Ollama) | prompt → query plan, and frame verification | 3.2 GB | query |
| `yolo11m.pt` | object counts per keyframe | 40 MB | index |
| `yolov8s-worldv2.pt` | open-vocabulary attribute boxes | 25 MB | query, only if needed |

Peak VRAM measured at 962 MB for the retrieval path on a 6 GB RTX 3050; the
Ollama model is loaded and unloaded by Ollama itself, so the two never contend.

## Build an index

```bash
cd sentinel-command-center/pipeline
python -m ask.index /path/to/recordings --every 1.0
```

Writes `ask/_index/`: `index.db` (frames and counts), `vectors.npy`
(float16, full 768-d), `thumbs/`, `meta.json`.

`--every` is the keyframe interval in seconds. Indexing is **decode-bound**, not
GPU-bound — every frame is decoded and one in 25 is kept — so a smaller
`--every` costs almost nothing extra. For continuous capture the production rule
should be activity-based (emit when a new track appears) rather than a fixed
rate; a fixed rate is used here because an evenly sampled index is easier to
evaluate against.

## Ask

```bash
python -m ask.ask "a busy road junction full of traffic"
python -m ask.ask "three people on one motorcycle" -k 5
python -m ask.ask "a rider without a helmet" --verify
python -m ask.ask "traffic at Majevadi Gate" --dim 256   # narrower embedding
```

The CLI prints what each stage did, because a search that returns nothing should
say which stage emptied it. `filter → 0 of 3634 frames` is actionable; "no
results" is not.

## Serve it to the web app

```bash
python -m ask.serve --port 8077
```

Then set `VITE_ASK_API_URL=http://localhost:8077` and the **Ask the estate**
panel in the left rail comes alive.

This process must never be exposed to the internet: it answers any question put
to it and has no auth of its own. It is reached over the LAN, or through the
same pattern the rest of the app uses — the browser talks to its own origin and
the origin talks to the worker.

## Measure it

```bash
python -m ask.evaluate --sheets          # run the query set, write contact sheets
# judge each sheet by eye, write _eval/labels.json
python -m ask.evaluate --score
```

The contact sheets exist so relevance is judged by a person looking at frames,
not by a model grading its own retrieval. Labels are keyed by query and frame
id, so a later change is re-scored against the same judgements rather than
fresh opinions.

## What this does not do

- **No wall-clock time.** The offline corpus is a set of clips with frame
  offsets, so an hour window has nothing to filter on; the CLI says so rather
  than ignoring it. Against live `detections.seen_at` it is a plain `BETWEEN`.
- **No plate search.** That is already served, better, by the `(plate, seen_at)`
  index on `detections`. The parser extracts the plate and says where it goes.
- **No search by personal or group identity.** The parser refuses these
  outright, in the parser rather than the UI so it cannot be bypassed by calling
  the API directly. Searchable attributes are clothing colour, vehicle type and
  colour, behaviour, and registration.
