"""
How many people are on each two-wheeler.

"Three people on one motorcycle" was the worst query in the first evaluation,
and the reason is worth stating plainly: both mechanisms available to it answer
a different question than the one asked.

  - The embedding scores the whole frame. Three riders on one bike and three
    bikes with one rider each look almost identical to it.
  - The frame-level counts are no better: `person >= 3 and motorcycle >= 1` is
    true of any busy road, which is why the first run returned ten pictures of
    ordinary traffic.

Cardinality is a property of a *pairing*, not of a frame, so it has to be
computed from the boxes. A person is treated as riding a two-wheeler when their
box overlaps the motorcycle's box grown upward — riders sit above the machine
and only their legs overlap it, so the raw boxes often barely intersect.

No model runs here. The boxes were detected during indexing and are already in
the database; this is arithmetic over them, which is why it takes under a
second for the whole index and can be re-run whenever the rule is tuned.

    python -m ask.riders          # compute and store max_riders per frame
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))

# How far above the motorcycle box to look for a rider, as a multiple of the
# motorcycle's own height. A rider's torso and head sit above the machine and a
# pillion's above that, so a bare box intersection finds only the legs.
RIDER_LIFT = 1.6
# Fraction of the person's box that must fall inside that region to count.
RIDER_OVERLAP = 0.35
# A rider's horizontal centre must sit within the machine's own width. The
# first rule allowed a 15% margin and, on a crowded junction, that margin
# swept in pedestrians and the riders of the bike alongside — every dense frame
# scored three or more and the filter stopped discriminating.
CENTRE_MARGIN = 0.0
# A person far taller than the machine is standing beside it, not sitting on it.
MAX_PERSON_H = 2.2
# Below this width in frame pixels a two-wheeler is too far away for the rider
# count to mean anything, and too far away for an operator to confirm by eye.
MIN_BIKE_W = 38


def _inter(a: tuple, b: tuple) -> float:
    x1 = max(a[0], b[0]); y1 = max(a[1], b[1])
    x2 = min(a[2], b[2]); y2 = min(a[3], b[3])
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def riders_per_bike(boxes: list) -> list[tuple[int, float]]:
    """Given one frame's boxes, (rider count, width) for each two-wheeler.

    Three conditions, all of them there because of a failure the looser rule
    produced on this footage: the person's centre inside the machine's own
    width, the person not much taller than the machine, and the machine itself
    big enough in frame for any of it to be checkable.
    """
    bikes = [b for b in boxes if b[0] in ('motorcycle', 'bicycle')]
    people = [b for b in boxes if b[0] == 'person']
    out = []
    for bk in bikes:
        bx1, by1, bx2, by2 = bk[2], bk[3], bk[4], bk[5]
        w = max(1.0, bx2 - bx1)
        h = max(1.0, by2 - by1)
        if w < MIN_BIKE_W:
            continue
        m = CENTRE_MARGIN * w
        zone = (bx1 - m, by1 - RIDER_LIFT * h, bx2 + m, by2)
        n = 0
        for p in people:
            pb = (p[2], p[3], p[4], p[5])
            ph = max(1.0, pb[3] - pb[1])
            if ph > MAX_PERSON_H * h:
                continue
            cx = (pb[0] + pb[2]) / 2
            if not (bx1 - m <= cx <= bx2 + m):
                continue
            area = max(1.0, (pb[2] - pb[0]) * ph)
            if _inter(pb, zone) / area >= RIDER_OVERLAP:
                n += 1
        out.append((n, w))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--index', default=os.path.join(HERE, '_index'))
    args = ap.parse_args()

    db = sqlite3.connect(os.path.join(args.index, 'index.db'))
    cols = {r[1] for r in db.execute('pragma table_info(frames)')}
    if 'max_riders' not in cols:
        db.execute('alter table frames add column max_riders integer default 0')
        db.execute('create index if not exists frames_riders on frames (max_riders)')
    if 'rider_bike_w' not in cols:
        # How wide the machine carrying the most riders is. Ranking on it puts
        # the frames an operator can actually confirm at the top, which matters
        # more here than a hundredth of cosine similarity.
        db.execute('alter table frames add column rider_bike_w real default 0')

    rows = list(db.execute('select id, boxes from frames'))
    hist: dict[int, int] = {}
    for fid, raw in rows:
        per_bike = riders_per_bike(json.loads(raw or '[]'))
        n, w = max(per_bike, key=lambda x: (x[0], x[1])) if per_bike else (0, 0.0)
        hist[n] = hist.get(n, 0) + 1
        db.execute('update frames set max_riders = ?, rider_bike_w = ? where id = ?',
                   (n, float(w), fid))
    db.commit()

    print(f'{len(rows)} frames')
    for k in sorted(hist):
        print(f'  max riders on one two-wheeler = {k}: {hist[k]:5d} frames')
    db.close()


if __name__ == '__main__':
    main()
