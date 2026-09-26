"""
Build the searchable index from recorded footage.

Three things are written per keyframe, because a prompt asks three different
kinds of question and no single representation answers all of them:

  1. a SigLIP 2 embedding      — "crowd blocking the carriageway"
  2. object counts from YOLO   — "three people on one motorcycle"
  3. a thumbnail on disk       — what the verifier looks at, and what the
                                 operator sees in the result list

The counts exist because embedding models cannot count. Asking SigLIP for
"three people on a motorcycle" returns pictures of motorcycles with people on
them, in no particular number, and no amount of prompt wording fixes it — the
representation does not carry cardinality. A detector does, so cardinality is
indexed as a number and filtered in SQL.

Storage is SQLite plus one float16 .npy of vectors. At the scale this runs
(tens of thousands of frames) a brute-force matrix multiply searches the whole
index in a few milliseconds, so an approximate index would add a dependency
and a recall loss to solve a problem that does not exist yet. pgvector with
HNSW is the right shape in Postgres, where the data has to live next to the
rest of the registry; it is not needed to find out whether the retrieval works.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, '_index')

# COCO ids the traffic domain cares about, named as the prompt parser names them.
COCO = {0: 'person', 1: 'bicycle', 2: 'car', 3: 'motorcycle', 5: 'bus',
        6: 'train', 7: 'truck'}


def camera_id_from_filename(path: str) -> str:
    """'21_23-Patan-Dethali-Char-Rasta.mp4' -> 'cam23'.

    The recordings carry two numbers: a file index and the grid's own camera
    number. The second is the one that matches the registry, which keys on the
    location rather than the file — the grid has renumbered its estate twice
    and the file order did not follow.

    When a recording has no camera number ('30_Gandhidham-Rambaugh-p2.mp4'),
    the id comes from the LOCATION, never from the file index. Falling back to
    the index is what silently merged that clip into cam30 on the first build:
    two different places, one id, 150 frames of Kheram and 70 of Gandhidham
    sharing a bucket, and one thumbnail overwritten by the other. A wrong id
    here does not look like a bug — it looks like a camera that sees two
    junctions.
    """
    base = os.path.splitext(os.path.basename(path))[0]
    after = base.split('_', 1)[1] if '_' in base else base
    m = re.match(r'(\d+)', after)
    if m:
        return f'cam{int(m.group(1)):02d}'
    slug = re.sub(r'[^a-z0-9]+', '-', after.lower()).strip('-')
    return f'cam-{slug}' if slug else f'cam-{re.sub(r"[^a-z0-9]+", "-", base.lower())}'


def schema(db: sqlite3.Connection) -> None:
    db.executescript("""
    create table if not exists frames (
      id          integer primary key,
      camera_id   text not null,
      source      text not null,
      t_s         real not null,          -- offset into the clip, for seeking
      thumb       text not null,
      n_person    integer default 0,
      n_car       integer default 0,
      n_motorcycle integer default 0,
      n_bus       integer default 0,
      n_truck     integer default 0,
      n_vehicle   integer default 0,      -- car+motorcycle+bus+truck, the usual filter
      boxes       text                    -- json, for grounding and rider counting
    );
    create index if not exists frames_cam on frames (camera_id, t_s);
    create index if not exists frames_veh on frames (n_vehicle);
    create index if not exists frames_per on frames (n_person);
    """)


def keyframes(path: str, every_s: float):
    """Yield (t_seconds, BGR frame) at a fixed interval.

    Fixed interval rather than scene-change detection: on a fixed traffic
    camera the scene never changes, only its contents do, so a scene-change
    selector fires almost never. Activity-based selection (emit when a new
    track appears) is the right rule for continuous capture and is what the
    production worker should use; for a 150-second clip, a fixed rate gives
    an evenly sampled index that is easier to evaluate against.
    """
    import cv2

    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    step = max(1, int(round(fps * every_s)))
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i % step == 0:
            yield i / fps, frame
        i += 1
    cap.release()


def main() -> None:
    ap = argparse.ArgumentParser(description='Index recorded footage for prompt search.')
    ap.add_argument('videos', nargs='+', help='video files or a directory of them')
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--every', type=float, default=1.0, help='seconds between keyframes')
    ap.add_argument('--thumb-w', type=int, default=640, help='thumbnail width')
    ap.add_argument('--no-detect', action='store_true', help='skip the YOLO count pass')
    ap.add_argument('--batch', type=int, default=16)
    args = ap.parse_args()

    import cv2
    from PIL import Image
    from . import embed

    files: list[str] = []
    for v in args.videos:
        if os.path.isdir(v):
            files += [os.path.join(v, f) for f in sorted(os.listdir(v)) if f.endswith('.mp4')]
        else:
            files.append(v)
    if not files:
        raise SystemExit('no videos found')

    os.makedirs(args.out, exist_ok=True)
    thumbs = os.path.join(args.out, 'thumbs')
    os.makedirs(thumbs, exist_ok=True)

    db = sqlite3.connect(os.path.join(args.out, 'index.db'))
    schema(db)
    db.execute('delete from frames')

    detector = None
    if not args.no_detect:
        from ultralytics import YOLO
        weights = os.path.join(os.path.dirname(HERE), 'yolo11m.pt')
        detector = YOLO(weights if os.path.exists(weights) else 'yolo11n.pt')

    print(f'{len(files)} videos, a keyframe every {args.every}s')
    embed.load()

    vectors: list[np.ndarray] = []
    rows = 0
    t0 = time.time()

    for path in files:
        cam = camera_id_from_filename(path)
        pend_imgs, pend_meta = [], []
        n_here = 0

        def flush():
            nonlocal rows
            if not pend_imgs:
                return
            vecs = embed.embed_images(pend_imgs, batch=args.batch)
            for (meta, vec) in zip(pend_meta, vecs):
                db.execute(
                    'insert into frames (id,camera_id,source,t_s,thumb,n_person,n_car,'
                    'n_motorcycle,n_bus,n_truck,n_vehicle,boxes) '
                    'values (?,?,?,?,?,?,?,?,?,?,?,?)',
                    (rows, cam, os.path.basename(path), meta['t'], meta['thumb'],
                     meta['c'].get('person', 0), meta['c'].get('car', 0),
                     meta['c'].get('motorcycle', 0), meta['c'].get('bus', 0),
                     meta['c'].get('truck', 0),
                     sum(meta['c'].get(k, 0) for k in ('car', 'motorcycle', 'bus', 'truck')),
                     json.dumps(meta['boxes'])),
                )
                vectors.append(vec)
                rows += 1
            pend_imgs.clear()
            pend_meta.clear()

        for t_s, frame in keyframes(path, args.every):
            counts: dict[str, int] = {}
            boxes: list[list] = []
            if detector is not None:
                # Detection runs on the full frame at native resolution. The
                # embedding sees a 384px square; the detector must not, or the
                # small distant objects that make counts useful are lost.
                r = detector.predict(frame, verbose=False, conf=0.35, classes=list(COCO))[0]
                for b in r.boxes:
                    cls = COCO.get(int(b.cls.item()))
                    if not cls:
                        continue
                    counts[cls] = counts.get(cls, 0) + 1
                    x1, y1, x2, y2 = (float(x) for x in b.xyxy[0].tolist())
                    boxes.append([cls, round(float(b.conf.item()), 3),
                                  round(x1), round(y1), round(x2), round(y2)])

            name = f'{cam}_{t_s:07.2f}.jpg'
            h, w = frame.shape[:2]
            tw = args.thumb_w
            th = int(h * tw / w)
            cv2.imwrite(os.path.join(thumbs, name),
                        cv2.resize(frame, (tw, th), interpolation=cv2.INTER_AREA),
                        [cv2.IMWRITE_JPEG_QUALITY, 82])

            pend_imgs.append(Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)))
            pend_meta.append({'t': t_s, 'thumb': name, 'c': counts, 'boxes': boxes})
            n_here += 1
            if len(pend_imgs) >= args.batch:
                flush()

        flush()
        db.commit()
        print(f'  {cam:7s} {os.path.basename(path)[:44]:46s} {n_here:5d} frames')

    V = np.stack(vectors).astype(np.float16)
    np.save(os.path.join(args.out, 'vectors.npy'), V)
    with open(os.path.join(args.out, 'meta.json'), 'w') as f:
        json.dump({'model': embed.MODEL_ID, 'dim': embed.DIM,
                   'every_s': args.every, 'frames': int(V.shape[0]),
                   'videos': [os.path.basename(p) for p in files]}, f, indent=2)
    db.close()

    dt = time.time() - t0
    mb = V.nbytes / 1e6
    print(f'\n{V.shape[0]} frames indexed in {dt:.0f}s ({V.shape[0]/dt:.1f} frames/s)')
    print(f'vectors {V.shape} float16 = {mb:.1f} MB '
          f'({V.nbytes/max(1,V.shape[0]):.0f} bytes/frame)')


if __name__ == '__main__':
    main()
