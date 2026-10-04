"""Crowd, fire and accident detection over a clip.

WHAT EACH OF THE THREE ACTUALLY IS
----------------------------------
These are not three of the same thing, and the difference is the most
important thing in this file.

Crowd is a detector. YOLO finds people, they are counted, and the count is a
measurement -- the same model and the same weights already used for vehicles,
pointed at class 0. A number it produces can be put in front of an officer.

Fire and accident are zero-shot screeners. There is no trained fire model in
this project and none in the pipeline README's asset list, so rather than
claim one, the image/text model that already answers prompt search scores each
frame against a set of positive descriptions and a set of negative ones. The
margin between them is a similarity, not a probability, and it says "this
frame is worth a look", never "there is a fire". Every row they write is
stored with method='zero-shot' so the control room can show it as a lead
rather than a finding.

Stating that plainly is the point. A screener presented as a detector is worse
than no screener, because an operator who trusts it stops looking.

WHY NOT CROWDLENS
-----------------
The pipeline README describes crowd analytics "via CrowdLens" and lists it
under external assets that must be provided. It is not in this repository and
not on the server, in the same way FINAL_NIGHT_MODEL.pt is not. Waiting for it
would mean no crowd counting at all, so this counts people with the detector
that is already here. Density heatmaps and line crossings, which were the rest
of CrowdLens's remit, are not reimplemented.

GPU AND CPU
-----------
Device choice follows what is free, not what is installed, because this host
is shared and both cards regularly have most of their memory taken. The GPU
plan samples more frames and uses the larger detector; the CPU plan samples
fewer and uses the small one. The difference is throughput, not capability:
the same events are found on either, a CPU pass is just coarser in time.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PIPELINE_DIR = os.path.dirname(os.path.abspath(__file__))

# Sampling and model size per device. Fire and smoke persist for seconds and a
# crowd for minutes, so neither needs every frame -- unlike plate reading,
# where a plate is legible for a handful of frames and frame_skip is the
# difference between a read and a miss.
PLANS = {
    'gpu': {'weights': 'yolo11m.pt', 'imgsz': 1280, 'every_s': 1.0,
            'person_conf': 0.30, 'max_frames': 48},
    'cpu': {'weights': 'yolo11s.pt', 'imgsz': 960, 'every_s': 3.0,
            'person_conf': 0.35, 'max_frames': 16},
}

# Positive and negative descriptions per kind.
#
# The negatives are not padding. A night traffic scene scores a respectable
# cosine against "fire" on colour alone -- sodium lighting, brake lights, wet
# tarmac reflecting both -- so an absolute similarity threshold fires on every
# evening clip. Scoring the best positive against the best negative cancels
# most of that, because the negatives describe the things that actually get
# confused with the event rather than generic unrelated scenes.
PROMPTS = {
    'fire': {
        'positive': [
            'a building on fire with orange flames',
            'thick smoke rising from a fire',
            'a vehicle on fire on the road',
            'flames and smoke in a street',
        ],
        'negative': [
            'a normal street at night with orange street lights',
            'car tail lights and brake lights in traffic',
            'a bright sunset over a road',
            'an ordinary daytime street scene',
            'headlight glare and wet road reflections',
        ],
        # Deliberately high. A false fire alert costs a dispatch; a missed one
        # on a traffic camera is usually also visible to somebody else.
        'threshold': 0.08,
        'min_hits': 2,
    },
    'accident': {
        'positive': [
            'a road accident with damaged vehicles',
            'a collision between two vehicles on the road',
            'an overturned vehicle on the carriageway',
            'a crashed motorcycle lying on the road',
            'people gathered around a crashed vehicle',
        ],
        'negative': [
            'normal traffic flowing on a road',
            'vehicles stopped at a red light',
            'parked vehicles at the side of the road',
            'a traffic jam with queued vehicles',
            'a police checkpoint stopping vehicles',
        ],
        # Lower than fire: the positives and negatives are both "vehicles on a
        # road", so the achievable margin is smaller. Stopped traffic is the
        # hard negative and the one worth watching in the test output.
        'threshold': 0.05,
        'min_hits': 3,
    },
}

# Every threshold above is a guess until it has been measured against footage
# from these cameras, so all four are overridable from the environment and the
# overrides are applied here rather than at each use. events_thresholds() in
# the server bootstrap writes them into env.sh.
def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


PROMPTS['fire']['threshold'] = _env_float(
    'SENTINEL_FIRE_THRESHOLD', PROMPTS['fire']['threshold'])
PROMPTS['accident']['threshold'] = _env_float(
    'SENTINEL_ACCIDENT_THRESHOLD', PROMPTS['accident']['threshold'])
PROMPTS['fire']['min_hits'] = int(_env_float(
    'SENTINEL_FIRE_MIN_HITS', PROMPTS['fire']['min_hits']))
PROMPTS['accident']['min_hits'] = int(_env_float(
    'SENTINEL_ACCIDENT_MIN_HITS', PROMPTS['accident']['min_hits']))

# A crowd is a judgement about a place, not a number that means the same thing
# everywhere: forty people is nothing at a railway station and a serious
# problem on a flyover. These are starting points, overridable per camera
# through SENTINEL_CROWD_MEDIUM / _HIGH.
CROWD_MEDIUM = int(_env_float('SENTINEL_CROWD_MEDIUM', 25))
CROWD_HIGH = int(_env_float('SENTINEL_CROWD_HIGH', 60))

# Kinds that are stored on every pass whether or not they crossed a threshold.
#
# Crowd is a measurement, and the useful thing about a measurement is the
# series, not the exceedance. "Eighty people at 19:40" only means something
# beside "six people at 15:00" from the same camera, and a table that records
# only the exceedances cannot answer when it started building or whether this
# is normal for a Friday. Plate detections are stored the same way: every
# sighting, not only the ones on a watchlist.
ALWAYS_STORE = ('crowd',)

# How close to its threshold a screener has to get to be worth a row. A fire
# that never happens produces a long run of comfortably negative margins, and
# storing all of them is noise; storing the ones that came close is how the
# threshold gets evidence to be tuned against.
NEAR_MISS = _env_float('SENTINEL_EVENT_NEAR_MISS', 0.02)

# Rows are cheap and images are not. A row is a couple of hundred bytes; a
# JPEG is tens of kilobytes, and thirty cameras on a few-minute cycle would
# put thousands of them a day into a storage bucket with a free-tier limit.
# So every stored finding gets a row and only some get a picture: anything
# that fired always does, and an ordinary pass does at most once per camera
# per kind in this interval, which keeps a visual record without the volume.
SNAP_EVERY_S = _env_float('SENTINEL_EVENT_SNAP_EVERY', 900)


def device_plan() -> tuple[str, dict]:
    """'gpu' or 'cpu', and the sampling plan for it.

    Reuses the worker's free-memory check rather than torch.cuda.is_available()
    so a card that exists but is fully occupied by somebody else's job counts
    as absent -- which, for the purpose of starting a pass that must not fail
    several minutes in, it is.
    """
    name = os.environ.get('SENTINEL_EVENT_DEVICE', '').strip().lower()
    if name in PLANS:
        return name, dict(PLANS[name])
    try:
        from sentinel_worker import free_vram_gb
        free = free_vram_gb()
    except Exception:                                    # noqa: BLE001
        free = 0.0
    # The detector and the image/text model share the card; ~3 GB covers both
    # at these sizes with room for another process to breathe.
    kind = 'gpu' if free >= 3.0 else 'cpu'
    return kind, dict(PLANS[kind])


def sample_frames(video: str, every_s: float, max_frames: int) -> list[tuple]:
    """(offset_seconds, BGR frame) pairs, evenly spaced through the clip."""
    import cv2

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        return []
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    if not fps or fps != fps or fps <= 0:     # 0, or NaN on a stream copy
        fps = 25.0
    step = max(1, int(round(fps * every_s)))

    # A concatenated HLS clip often reports no frame count. Walking it with
    # grab() costs nothing and is the only reliable way through such a file,
    # since seeking by index on a stream without an index lands anywhere.
    out = []
    idx = 0
    while len(out) < max_frames:
        if not cap.grab():
            break
        if idx % step == 0:
            ok, frame = cap.retrieve()
            if ok and frame is not None:
                out.append((idx / fps, frame))
        idx += 1
    cap.release()
    return out


def _pil(frames: list) -> list:
    """BGR arrays -> PIL images, which is what the image/text model wants."""
    import cv2
    from PIL import Image
    return [Image.fromarray(cv2.cvtColor(f, cv2.COLOR_BGR2RGB))
            for _, f in frames]


def count_people(frames: list, plan: dict) -> dict:
    """Count people per sampled frame with the detector already in use.

    classes=[0] restricts YOLO to the person class, so this costs one forward
    pass per sampled frame and no extra weights beyond what vehicle detection
    already downloads.
    """
    from ultralytics import YOLO

    weights = os.path.join(PIPELINE_DIR, 'weights', plan['weights'])
    model = YOLO(weights if os.path.isfile(weights) else plan['weights'])
    counts, peak_at = [], 0.0
    best = -1
    for offset, frame in frames:
        res = model.predict(frame, imgsz=plan['imgsz'], classes=[0],
                            conf=plan['person_conf'], verbose=False)
        n = int(len(res[0].boxes)) if res and res[0].boxes is not None else 0
        counts.append(n)
        if n > best:
            best, peak_at = n, offset
    if not counts:
        return {'peak': 0, 'mean': 0.0, 'peak_at': 0.0, 'counts': []}
    return {
        'peak': max(counts),
        'mean': sum(counts) / len(counts),
        'peak_at': peak_at,
        'counts': counts,
    }


def score_zero_shot(frames: list, kind: str) -> dict:
    """Margin between the positive and negative prompt sets, per frame.

    SigLIP was trained with a sigmoid objective, so there is no softmax over a
    fixed label set to take -- and an absolute cosine is not comparable between
    prompts anyway. The difference of the two best similarities is, because
    both are measured against the same frame with the same tower.
    """
    import numpy as np

    sys.path.insert(0, PIPELINE_DIR)
    from ask import embed

    spec = PROMPTS[kind]
    images = embed.embed_images(_pil(frames))
    pos = embed.embed_texts(spec['positive'])
    neg = embed.embed_texts(spec['negative'])

    img = np.asarray(images, dtype=np.float32)
    best_pos = (img @ np.asarray(pos, dtype=np.float32).T).max(axis=1)
    best_neg = (img @ np.asarray(neg, dtype=np.float32).T).max(axis=1)
    margins = (best_pos - best_neg).tolist()

    hits = [i for i, m in enumerate(margins) if m >= spec['threshold']]
    top = int(max(range(len(margins)), key=lambda i: margins[i])) if margins else 0
    return {
        'margins': margins,
        'hits': hits,
        'frames_seen': len(margins),
        'top_index': top,
        'top_margin': margins[top] if margins else 0.0,
        'top_at': frames[top][0] if frames else 0.0,
        'fired': len(hits) >= spec['min_hits'],
        'threshold': spec['threshold'],
        'min_hits': spec['min_hits'],
        # Fewer sampled frames than the persistence rule demands means this
        # kind cannot fire at all, whatever is in the footage. A short clip on
        # the CPU plan -- which samples every 3s -- reaches this easily, and
        # the symptom is silence rather than an error, so it is reported.
        'unreachable': len(margins) < spec['min_hits'],
    }


def analyse_events(video: str, camera_id: str,
                   kinds=('crowd', 'fire', 'accident'),
                   device: str | None = None) -> dict:
    """Run the requested analyses over one clip and return what was found.

    Frames are sampled once and shared: decoding is a real cost on a CPU host
    and all three analyses want the same evenly-spaced frames.
    """
    if device:
        os.environ['SENTINEL_EVENT_DEVICE'] = device
    dev, plan = device_plan()

    frames = sample_frames(video, plan['every_s'], plan['max_frames'])
    result = {'camera_id': camera_id, 'device': dev, 'plan': plan,
              'frames_sampled': len(frames), 'findings': {}}
    if not frames:
        result['error'] = 'no frames could be decoded'
        return result

    if 'crowd' in kinds:
        crowd = count_people(frames, plan)
        peak = crowd['peak']
        severity = ('high' if peak >= CROWD_HIGH else
                    'medium' if peak >= CROWD_MEDIUM else 'low')
        result['findings']['crowd'] = {
            'method': 'detector',
            'fired': peak >= CROWD_MEDIUM,
            'severity': severity,
            'people_peak': peak,
            'people_mean': round(crowd['mean'], 1),
            'at': crowd['peak_at'],
            'frame_index': (crowd['counts'].index(peak)
                            if crowd['counts'] else 0),
            'frames_hit': sum(1 for c in crowd['counts'] if c >= CROWD_MEDIUM),
            'frames_seen': len(crowd['counts']),
            'note': f'peak {peak} people, mean {crowd["mean"]:.1f} '
                    f'(medium at {CROWD_MEDIUM}, high at {CROWD_HIGH})',
        }

    for kind in ('fire', 'accident'):
        if kind not in kinds:
            continue
        z = score_zero_shot(frames, kind)
        result['findings'][kind] = {
            'method': 'zero-shot',
            'fired': z['fired'],
            # A screener never reports better than 'medium' on its own. It has
            # not confirmed anything; it has asked for a human to look.
            'severity': 'medium' if z['fired'] else 'review',
            'score': round(z['top_margin'], 4),
            'at': z['top_at'],
            'frame_index': z['top_index'],
            'frames_hit': len(z['hits']),
            'frames_seen': z['frames_seen'],
            'margins': [round(m, 4) for m in z['margins']],
            'unreachable': z['unreachable'],
            'note': f'best margin {z["top_margin"]:.3f} at {z["top_at"]:.0f}s; '
                    f'{len(z["hits"])}/{z["frames_seen"]} frames over '
                    f'{z["threshold"]} (needs {z["min_hits"]})'
                    + (f' -- only {z["frames_seen"]} frame(s) sampled, so this '
                       f'kind CANNOT fire; capture a longer clip or lower '
                       f'every_s' if z['unreachable'] else ''),
        }

    result['frames'] = frames
    return result


def ensure_local(video: str, seconds: int = 30, tmp: str | None = None) -> str:
    """A local file for `video`, capturing it first if it is a live camera.

    OpenCV can open an HLS URL, but it cannot sign in: the grid requires a
    session cookie and refuses an anonymous request, so handing the URL
    straight to VideoCapture decodes nothing and reports an empty clip rather
    than an authentication failure. The capture path in run_batch already
    holds the credentials and the ffmpeg-segfault fallback, so live footage is
    fetched the same way the plate worker fetches it.

    Returns the local path, which is the input unchanged when it was already
    a file. Raises RuntimeError if a live capture produced nothing, because
    the caller cannot tell an empty clip from an absent one.
    """
    if not video.startswith(('http://', 'https://', 'rtsp://')):
        return video

    sys.path.insert(0, PIPELINE_DIR)
    from run_batch import capture, grid_session

    host = 'https://' + video.split('/')[2] if video.startswith('http') else ''
    session = grid_session(host) if host else None
    tmp = tmp or os.environ.get('SENTINEL_TMP', '/tmp')
    os.makedirs(tmp, exist_ok=True)
    # Named for the camera segment of the URL so two cameras cannot collide.
    tag = video.rstrip('/').split('/')[-2] if '/' in video else 'live'
    dest = os.path.join(tmp, f'events-{tag}.mp4')

    print(f'[events] capturing {seconds}s from {video}')
    if not capture(video, seconds, dest, session):
        raise RuntimeError(f'no footage captured from {video}')
    return dest


class EventRegistry:
    """Writes scene events, in the same shape as the detections writer.

    Without credentials it prints rather than writes, so a pass can be
    exercised end to end without a database.
    """

    def __init__(self) -> None:
        url = os.environ.get('SUPABASE_URL', '')
        key = os.environ.get('SUPABASE_SERVICE_KEY', '')
        self.enabled = bool(url and key)
        self.client = None
        if self.enabled:
            if key.count('.') != 2:
                raise SystemExit(
                    'SUPABASE_SERVICE_KEY is not a JWT - it looks truncated '
                    'or is still a placeholder.')
            from supabase import create_client
            self.client = create_client(url, key)
        else:
            print('[events] SUPABASE_URL / SUPABASE_SERVICE_KEY unset - '
                  'events will be printed, not stored')
        # When each (camera, kind) last had a picture taken. Held in memory
        # rather than on disk: the worker is long-running, and the cost of the
        # watchdog restarting it is one extra snapshot, which is not worth a
        # file to avoid.
        self._last_snap: dict[tuple, float] = {}

    def _snapshot(self, camera_id: str, kind: str, frame) -> str | None:
        """Put the frame that triggered the event in the evidence bucket.

        An event without the frame behind it cannot be reviewed, and review is
        the entire purpose of a zero-shot row.
        """
        if not self.client:
            return None
        try:
            import cv2
            ok, buf = cv2.imencode('.jpg', frame,
                                   [int(cv2.IMWRITE_JPEG_QUALITY), 85])
            if not ok:
                return None
            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')
            key = f'events/{camera_id}/{kind}-{stamp}.jpg'
            self.client.storage.from_('evidence').upload(
                key, buf.tobytes(),
                {'content-type': 'image/jpeg', 'upsert': 'true'})
            return self.client.storage.from_('evidence').get_public_url(key)
        except Exception as exc:                          # noqa: BLE001
            print(f'    snapshot upload failed: {str(exc)[:80]}')
            return None

    def _keep(self, kind: str, f: dict, store: str) -> bool:
        """Whether this finding earns a row under the given policy."""
        if store == 'all' or f['fired']:
            return True
        if store == 'fired':
            return False
        # 'measure': the series is the point for a measurement, and a screener
        # is worth recording when it came close enough to inform a threshold.
        if kind in ALWAYS_STORE:
            return True
        score, spec = f.get('score'), PROMPTS.get(kind)
        if score is None or not spec:
            return False
        return score >= spec['threshold'] - NEAR_MISS

    def _snap_due(self, cam: str, kind: str, fired: bool, now: float) -> bool:
        """Whether to spend a stored image on this one.

        Anything that fired is evidence and always gets one. An ordinary pass
        gets one at most once per interval, so there is a visual record of a
        normal street without a picture for every pass of every camera.
        """
        if fired:
            return True
        last = self._last_snap.get((cam, kind), 0.0)
        return (now - last) >= SNAP_EVERY_S

    def write(self, result: dict, lat=None, lng=None,
              started_at: datetime | None = None, store='measure') -> int:
        """Store the findings. Returns how many rows were written.

        store='measure' (the default) keeps every crowd count, because a count
        is only meaningful as a series, plus any screener that fired or came
        within NEAR_MISS of firing. 'fired' keeps only what crossed a
        threshold; 'all' keeps everything, which is what the calibration test
        wants and a continuous worker does not.
        """
        import time as _time

        base = started_at or datetime.now(timezone.utc)
        now = _time.time()
        cam = result['camera_id']
        frames = result.get('frames') or []
        rows = []

        for kind, f in result.get('findings', {}).items():
            if not self._keep(kind, f, store):
                continue
            frame = None
            fi = f.get('frame_index')
            if (frames and fi is not None and fi < len(frames)
                    and self._snap_due(cam, kind, f['fired'], now)):
                frame = frames[fi][1]
            row = {
                'camera_id': cam,
                'kind': kind,
                'method': f['method'],
                'score': f.get('score'),
                'severity': f['severity'],
                'people_peak': f.get('people_peak'),
                'people_mean': f.get('people_mean'),
                'frames_hit': f.get('frames_hit', 1),
                'frames_seen': f.get('frames_seen', 1),
                'note': f.get('note'),
                # The offset within the clip, so the event carries the moment
                # it happened rather than the moment the pass finished.
                'seen_at': (base + timedelta(seconds=float(f.get('at') or 0))
                            ).isoformat(),
            }
            if lat is not None and lng is not None:
                row['geom'] = f'SRID=4326;POINT({lng} {lat})'
            if frame is not None:
                url = self._snapshot(cam, kind, frame)
                row['snapshot_url'] = url
                # Only count it as spent when one was actually stored, so a
                # failed upload is retried on the next pass rather than
                # starting the interval over with nothing to show.
                if url:
                    self._last_snap[(cam, kind)] = now
            rows.append(row)

        if not rows:
            return 0
        if not self.client:
            for r in rows:
                print(f"    [would store] {r['kind']} {r['severity']} "
                      f"{r['note']}")
            return 0
        try:
            self.client.table('events').insert(rows).execute()
            return len(rows)
        except Exception as exc:                          # noqa: BLE001
            print(f'    event write failed: {str(exc)[:160]}')
            return 0


def main() -> None:
    import argparse
    import json

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('video', help='file path, HLS URL, or rtsp:// URL')
    ap.add_argument('--camera', required=True, help='registry camera id')
    ap.add_argument('--kinds', default='crowd,fire,accident')
    ap.add_argument('--seconds', type=int, default=30,
                    help='how much footage to take, when given a live camera')
    ap.add_argument('--device', default=None, choices=['gpu', 'cpu'],
                    help='override; the default follows free VRAM')
    ap.add_argument('--lat', type=float, default=None)
    ap.add_argument('--lng', type=float, default=None)
    ap.add_argument('--store', default='measure',
                    choices=['measure', 'fired', 'all'],
                    help="what to record: 'measure' keeps every crowd count "
                         "plus near-miss screeners (default), 'fired' only "
                         "what crossed a threshold, 'all' everything")
    ap.add_argument('--store-all', action='store_true',
                    help="shorthand for --store all; what calibration wants")
    ap.add_argument('--json', action='store_true',
                    help='print the findings as JSON (frames omitted)')
    args = ap.parse_args()

    kinds = tuple(k.strip() for k in args.kinds.split(',') if k.strip())

    # A live camera is captured first; a file is used as given. Cleaned up
    # afterwards only when it was captured here, so a recording passed in by
    # hand is never deleted.
    try:
        local = ensure_local(args.video, args.seconds)
    except RuntimeError as e:
        print(f'[events] {args.camera}: {e}')
        raise SystemExit(1)
    captured = local != args.video

    try:
        result = analyse_events(local, args.camera, kinds, args.device)
    finally:
        if captured and os.path.exists(local):
            os.remove(local)

    if result.get('error'):
        print(f"[events] {args.camera}: {result['error']}")
        raise SystemExit(1)

    print(f"[events] {args.camera}: {result['frames_sampled']} frames on "
          f"{result['device']} ({result['plan']['weights']})")
    for kind, f in result['findings'].items():
        mark = 'FIRED' if f['fired'] else '  -  '
        print(f"  {mark} {kind:9s} {f['method']:9s} {f['note']}")

    written = EventRegistry().write(
        result, args.lat, args.lng,
        store='all' if args.store_all else args.store)
    print(f'[events] {written} events recorded')

    if args.json:
        slim = {k: v for k, v in result.items() if k != 'frames'}
        print(json.dumps(slim, indent=2, default=str))


if __name__ == '__main__':
    main()
