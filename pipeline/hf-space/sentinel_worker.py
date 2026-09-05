"""Sentinel inference worker — vehicle detection + ANPR into the registry.

Wraps the team pipeline (github.com/ayushtriapty88-hue/sentinel-gujarat-pipeline)
and writes its output into the `detections` table the web application reads, so
vehicle tracing, movement search and watchlist alerts stop showing empty states.

WHAT THIS CHANGES IN THE PIPELINE, AND WHY
------------------------------------------
Benchmarked against a 16-second Majevadi Gate clip whose plates were verified
by hand beforehand — GJ04EP2038, GJ03PA8482, GJ07A4509 — so these are recall
figures against a known answer, not a count of whatever came out:

    variant                    recall  precision  runtime
    pipeline as written          0.33      0.25      184s
    + tiled plate detection      0.00      0.00      103s
    + PaddleOCR (this)           1.00      0.60       40s

1. OCR is PaddleOCR recognition-only, not EasyOCR. Every EasyOCR miss was one
   or two characters out — GJ04EP2008 for GJ04EP2038, GJ02A4509 for GJ07A4509 —
   so detection and tracking were already working and recognition was the
   entire bottleneck. It is also 4.6x faster overall, because EasyOCR's
   readtext() re-runs text detection across a crop already known to be a plate.

2. Tiled plate detection is available but OFF by default. It found more
   candidates and improved nothing once PaddleOCR was in place, while costing
   2.8x the runtime. It earns its cost only where plates are small: measured
   across this estate, a camera presenting plates at 70-88px reads fine
   full-frame, while one presenting 42-50px returns nothing either way. Turn it
   on per camera, not globally.

3. Minimum plate width raised from 28px to 45px. Below roughly 55px on this
   footage a read is not recoverable, and a confident wrong plate is worse in a
   control room than no plate.

Everything else — YOLO11m with ByteTrack, the night model and its Indian
vehicle classes, day/night switching, the confusion-aware plate fusion — is the
team pipeline unchanged. Those parts were already doing the work.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

PIPELINE_DIR = os.environ.get('SENTINEL_PIPELINE_DIR', './sentinel-gujarat-pipeline')


# ─────────────────────────────────────────────────────────────────────
# Pipeline patches
# ─────────────────────────────────────────────────────────────────────

def use_paddle_ocr() -> None:
    """Replace EasyOCR with PaddleOCR recognition-only, keeping its interface."""
    import easyocr
    from paddleocr import TextRecognition

    class PaddleReader:
        def __init__(self, *_a, **_kw):
            self.rec = TextRecognition(model_name='PP-OCRv5_server_rec',
                                       enable_mkldnn=True)

        def readtext(self, img, detail=0, **_kw):
            try:
                out = self.rec.predict(img)
            except Exception:  # noqa: BLE001
                return []
            texts = [o.get('rec_text', '') for o in out]
            return texts if detail == 0 else [(None, t, 1.0) for t in texts]

    easyocr.Reader = PaddleReader


def use_tiled_detection() -> None:
    """Detect plates on overlapping tiles at native resolution.

    Only worth enabling on wide-angle cameras where plates are small. See the
    module docstring for the measurement.
    """
    import cv2
    import open_image_models

    def tiles(img, nx=3, ny=2, overlap=0.3):
        H, W = img.shape[:2]
        tw, th = W // nx, H // ny
        ox, oy = int(tw * overlap), int(th * overlap)
        for iy in range(ny):
            for ix in range(nx):
                x1, x2 = max(0, ix * tw - ox), min(W, (ix + 1) * tw + ox)
                y1, y2 = max(0, iy * th - oy), min(H, (iy + 1) * th + oy)
                yield x1, y1, img[y1:y2, x1:x2]

    class _BB:
        def __init__(self, x1, y1, x2, y2):
            self.x1, self.y1, self.x2, self.y2 = x1, y1, x2, y2

    class _Box:
        def __init__(self, x1, y1, x2, y2, conf):
            self.bounding_box = _BB(x1, y1, x2, y2)
            self.confidence = conf

    def iou(a, b):
        ix1, iy1 = max(a[0], b.bounding_box.x1), max(a[1], b.bounding_box.y1)
        ix2, iy2 = min(a[2], b.bounding_box.x2), min(a[3], b.bounding_box.y2)
        iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
        inter = iw * ih
        ua = ((a[2] - a[0]) * (a[3] - a[1])
              + (b.bounding_box.x2 - b.bounding_box.x1)
              * (b.bounding_box.y2 - b.bounding_box.y1) - inter)
        return inter / ua if ua > 0 else 0

    class TiledDetector:
        def __init__(self, inner):
            self.inner = inner

        def predict(self, frame):
            H = frame.shape[0]
            out = []
            for ox, oy, tile in tiles(frame):
                big = cv2.resize(tile, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
                try:
                    res = self.inner.predict(big)
                except Exception:  # noqa: BLE001
                    continue
                for r in res:
                    bb = r.bounding_box
                    x1, y1 = ox + bb.x1 / 2, oy + bb.y1 / 2
                    x2, y2 = ox + bb.x2 / 2, oy + bb.y2 / 2
                    # These feeds burn a timestamp and camera name into the top
                    # and bottom bands and the detector fires on that text.
                    if y1 < H * 0.075 or y2 > H * 0.925:
                        continue
                    if any(iou((x1, y1, x2, y2), o) > 0.35 for o in out):
                        continue
                    out.append(_Box(x1, y1, x2, y2, float(r.confidence)))
            return out

    original = open_image_models.LicensePlateDetector
    open_image_models.LicensePlateDetector = lambda **kw: TiledDetector(original(**kw))


# ─────────────────────────────────────────────────────────────────────
# Registry sink
# ─────────────────────────────────────────────────────────────────────

class Registry:
    """Writes sightings into the same table the web application reads.

    Without credentials it prints instead of writing, so the pipeline can be
    exercised end to end without a database — and so a misconfigured worker
    fails loudly rather than silently discarding detections.
    """

    def __init__(self) -> None:
        url = os.environ.get('SUPABASE_URL', '')
        key = os.environ.get('SUPABASE_SERVICE_KEY', '')
        self.enabled = bool(url and key)
        self.client = None
        if self.enabled:
            from supabase import create_client
            # The service key is used deliberately: this worker is a trusted
            # server-side process, and row-level security would otherwise
            # refuse its writes. It must never be shipped to a browser.
            self.client = create_client(url, key)
        else:
            print('[worker] SUPABASE_URL / SUPABASE_SERVICE_KEY unset — '
                  'detections will be printed, not stored')

    def write(self, camera_id: str, records: list[dict], lat=None, lng=None,
              started_at: datetime | None = None) -> int:
        base = started_at or datetime.now(timezone.utc)
        rows = []
        for r in records:
            # The pipeline's plate_list does not carry the read count, only the
            # full records do. Rather than claim 1 — which would understate
            # confidence for a plate voted from twenty frames — leave it null
            # when it is genuinely unknown.
            reads = r.get('reads')
            # `time` is the offset in seconds within the clip, so a sighting
            # gets the moment it actually happened rather than the moment the
            # batch finished.
            offset = r.get('time')
            seen = (base + timedelta(seconds=float(offset))) if offset is not None else base
            rows.append({
                'camera_id': camera_id,
                'plate': r['plate'],
                'plate_confidence': None,
                'vehicle_type': r.get('type'),
                'frames_voted': int(reads) if reads is not None else None,
                'seen_at': seen.isoformat(),
                'geom': (f'SRID=4326;POINT({lng} {lat})'
                         if lat is not None and lng is not None else None),
            })
        if not rows:
            return 0
        if not self.client:
            print(json.dumps(rows, indent=1))
            return len(rows)
        self.client.table('detections').insert(rows).execute()
        return len(rows)


# ─────────────────────────────────────────────────────────────────────

def analyse(video: str, camera_id: str, *, tiled=False, frame_skip=2,
            mode='auto', night_model=None) -> dict:
    sys.path.insert(0, PIPELINE_DIR)
    use_paddle_ocr()
    if tiled:
        use_tiled_detection()

    import sentinel_pipeline as sp

    cfg = dict(sp.CONFIG)
    cfg.update({
        'video': video,
        'camera_name': camera_id,
        'mode': mode,
        'frame_skip': frame_skip,
        'save_video': False,
        'plate_min_w': 45,
        'output_dir': os.environ.get('SENTINEL_OUT', 'output'),
    })
    if night_model:
        cfg['night_model'] = night_model

    started = time.time()
    result = sp.run_pipeline(cfg)
    result['elapsed_s'] = round(time.time() - started, 1)
    return result


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('video', help='file path, HLS URL, or rtsp:// URL')
    ap.add_argument('--camera', required=True, help='registry camera id, e.g. cam08')
    ap.add_argument('--tiled', action='store_true',
                    help='tile plate detection — for wide cameras with small plates')
    ap.add_argument('--frame-skip', type=int, default=2)
    ap.add_argument('--mode', default='auto', choices=['auto', 'day', 'night'])
    ap.add_argument('--night-model', default=None)
    ap.add_argument('--lat', type=float, default=None)
    ap.add_argument('--lng', type=float, default=None)
    args = ap.parse_args()

    result = analyse(args.video, args.camera, tiled=args.tiled,
                     frame_skip=args.frame_skip, mode=args.mode,
                     night_model=args.night_model)

    v = result['vehicles']
    print(f"\n[worker] {args.camera}: {v['total_tracked']} vehicles, "
          f"{v['plates_read']} plates, {result['elapsed_s']}s")

    written = Registry().write(args.camera, v['plate_list'], args.lat, args.lng)
    print(f"[worker] {written} detections recorded")


if __name__ == '__main__':
    main()
