"""
Retrieval: a query plan against the index.

The order matters. Structured constraints run first, in SQL, because they are
exact and they shrink the candidate set for free — "frames with at least three
people" is an integer comparison, and no embedding needs to be touched to
answer it. Whatever survives is then ranked by cosine similarity against the
caption.

This is the opposite of the obvious design, which searches the vectors first
and filters afterwards. Filtering afterwards means the top-k is chosen before
the constraints are known, so a query for three-person frames can return ten
frames with one person each and then have nothing left to show.

Similarity is a plain matrix multiply over float16 vectors. At this scale that
is faster than an approximate index and it has no recall loss, so an ANN
structure would be complexity spent on a problem that does not exist until the
index is orders of magnitude larger.
"""
from __future__ import annotations

import difflib
import json
import os
import re
import sqlite3

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_INDEX = os.path.join(HERE, '_index')


class Index:
    def __init__(self, path: str = DEFAULT_INDEX, dim: int | None = None):
        """`dim` narrows every comparison to that many dimensions.

        The index is stored at full width; this is how a narrower production
        width is evaluated without rebuilding it.
        """
        self.path = path
        self.db = sqlite3.connect(os.path.join(path, 'index.db'),
                                  check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        V = np.load(os.path.join(path, 'vectors.npy')).astype(np.float32)
        self.stored_dim = int(V.shape[1])
        self.dim = min(dim, self.stored_dim) if dim else self.stored_dim
        if self.dim < self.stored_dim:
            from . import embed
            V = embed.narrow(V, self.dim)
        self.V = V
        with open(os.path.join(path, 'meta.json')) as f:
            self.meta = json.load(f)
        # An index built by one tower and queried by another returns confident
        # nonsense rather than an error, so the mismatch is named here.
        from . import embed
        built = self.meta.get('model')
        if built and built != embed.MODEL_ID:
            raise RuntimeError(
                f'index was built with {built} but ASK_EMBED_MODEL is '
                f'{embed.MODEL_ID}; rebuild the index or set them to match')
        self.thumbs = os.path.join(path, 'thumbs')

    def __len__(self) -> int:
        return int(self.V.shape[0])

    # ── place names → cameras ────────────────────────────────────────
    def _sources(self) -> list[tuple[str, str]]:
        cur = self.db.execute('select distinct camera_id, source from frames')
        return [(r['camera_id'], r['source']) for r in cur]

    def cameras_for_place(self, place: str) -> list[str]:
        """Resolve "Majevadi Gate" to a camera id.

        Fuzzy, per token, because the estate's own spellings disagree with the
        way anyone types them: the recording is named "majewadi" and every
        operator writes "Majevadi". An exact match here would silently return
        nothing, which is the worst failure mode a search box has.
        """
        want = [t for t in re.split(r'[^a-z0-9]+', place.lower()) if len(t) > 2]
        if not want:
            return []
        hits = []
        for cam, source in self._sources():
            have = [t for t in re.split(r'[^a-z0-9]+', source.lower()) if len(t) > 2]
            score = 0.0
            for w in want:
                best = max((difflib.SequenceMatcher(None, w, h).ratio() for h in have),
                           default=0.0)
                if best >= 0.8:
                    score += best
            if score:
                hits.append((score, cam))
        hits.sort(reverse=True)
        # Only the strongest match, unless several tie — a loose place name
        # should not quietly widen the search to half the estate.
        if not hits:
            return []
        top = hits[0][0]
        return [c for s, c in hits if s >= top - 1e-6]

    # ── structured filter ────────────────────────────────────────────
    def candidates(self, q: dict) -> tuple[list[sqlite3.Row], dict]:
        where, args = [], []
        applied: dict = {}

        cams: list[str] = list(q.get('cameras') or [])
        for place in (q.get('places') or []):
            cams += self.cameras_for_place(place)
        cams = sorted(set(cams))
        if cams:
            where.append(f'camera_id in ({",".join("?" * len(cams))})')
            args += cams
            applied['cameras'] = cams

        # Classes are a DISJUNCTION: at least one of them in the frame.
        #
        # Conjunction was the first implementation and it was wrong in a way
        # that looked like a retrieval failure. "vehicles at Adalaj toll naka"
        # expands to car, bus and truck, and requiring all three at once left
        # 0 of 151 frames at a camera that plainly shows vehicles — a toll plaza
        # simply never has a car, a bus and a truck in one second of footage.
        # A count is specific and stays conjunctive; a class list is the
        # parser's guess at what "vehicles" means and must not narrow.
        cls_cols = [f'n_{c}' for c in (q.get('classes') or []) if f'n_{c}' in COLS]
        if cls_cols:
            where.append('(' + ' or '.join(f'{c} >= 1' for c in cls_cols) + ')')
            applied['classes_any'] = [c[2:] for c in cls_cols]

        # Riders on ONE two-wheeler, precomputed by ask.riders from the stored
        # boxes. Frame-level counts cannot express this: "person >= 3 and
        # motorcycle >= 1" is true of any busy road, which is exactly what the
        # first evaluation returned for "three people on one motorcycle".
        rd = q.get('riders')
        if isinstance(rd, dict) and 'min' in rd:
            where.append('max_riders >= ?')
            args.append(int(rd['min']))
            applied['riders_min'] = int(rd['min'])

        for cls, spec in (q.get('counts') or {}).items():
            col = f'n_{cls}'
            if col in COLS and isinstance(spec, dict) and 'min' in spec:
                where.append(f'{col} >= ?')
                args.append(int(spec['min']))
                applied.setdefault('counts', {})[cls] = spec['min']

        sql = 'select * from frames'
        if where:
            sql += ' where ' + ' and '.join(where)
        rows = list(self.db.execute(sql, args))
        return rows, applied

    # ── ranking ──────────────────────────────────────────────────────
    def search(self, q: dict, k: int = 20, pool: int = 200,
               per_camera: int = 3) -> dict:
        """Run a query plan. Returns results plus what was actually applied.

        `per_camera` caps how many frames one camera may contribute. Without it
        the top ten are ten consecutive seconds of the single busiest junction,
        which is the correct answer to the cosine question and useless as an
        answer to the operator's: they are looking for where something happened,
        and one camera's worth of near-duplicate frames hides every other place
        it also happened.
        """
        rows, applied = self.candidates(q)
        note = []

        if q.get('hours'):
            # The offline corpus is a set of clips with no capture time, so an
            # hour window has nothing to filter on. Said out loud rather than
            # silently ignored; against live `detections.seen_at` this is a
            # plain BETWEEN. Day and night are still reachable through the
            # caption, which the embedding does see.
            note.append('hour window not applied: this index has clip offsets, '
                        'not wall-clock capture times')

        if q.get('plate'):
            note.append('plate lookup is served by the detections table, not '
                        'this scene index')

        if not rows:
            return {'results': [], 'applied': applied, 'notes': note,
                    'n_candidates': 0, 'ranked_by': 'none'}

        ft = q.get('free_text')
        # Ranking rider queries by the size of the machine was tried and is
        # worse: the biggest two-wheelers in frame are the parked ones in
        # crowded markets, which is precisely where the box rule mistakes
        # bystanders for pillions. The caption still carries "riding together",
        # and cosine puts isolated moving bikes above market scenes, so it stays
        # the ranking even though the filter has already done the counting.
        if q.get('riders') and not ft:
            ranked = sorted(((float(r['rider_bike_w']), r) for r in rows),
                            key=lambda x: (-x[0], x[1]['camera_id'], x[1]['t_s']))
            out = self._rows_out(ranked, k, per_camera)
            return {'results': out, 'applied': applied, 'notes': note,
                    'n_candidates': len(rows),
                    'ranked_by': 'size of the two-wheeler carrying the riders',
                    'dim': self.dim}

        if ft:
            from . import embed
            tv = embed.embed_texts([ft], dim=self.dim)[0].astype(np.float32)
            ids = np.array([r['id'] for r in rows])
            sims = self.V[ids] @ tv
            order = np.argsort(-sims)[:max(k, min(pool, len(ids)))]
            ranked = [(float(sims[i]), rows[i]) for i in order]
            by = 'cosine similarity to the caption'
        else:
            # No caption: a purely structured query. Rank by how much of the
            # thing asked for is in the frame, which is the only signal there
            # is, then by time for stability.
            if q.get('riders'):
                col = 'max_riders'
            else:
                key = next(iter(q.get('counts') or {}), None) or \
                    next(iter(q.get('classes') or []), None)
                col = f'n_{key}' if key and f'n_{key}' in COLS else 'n_vehicle'
            ranked = sorted(((float(r[col]), r) for r in rows),
                            key=lambda x: (-x[0], x[1]['camera_id'], x[1]['t_s']))
            by = f'{col} descending'

        out = self._rows_out(ranked, k, per_camera)
        return {'results': out, 'applied': applied, 'notes': note,
                'n_candidates': len(rows), 'ranked_by': by, 'dim': self.dim}

    def _rows_out(self, ranked, k: int, per_camera: int) -> list[dict]:
        # Diversify before truncating, not after.
        if per_camera > 0:
            seen: dict[str, int] = {}
            spread, overflow = [], []
            for score, r in ranked:
                cam = r['camera_id']
                if seen.get(cam, 0) < per_camera:
                    seen[cam] = seen.get(cam, 0) + 1
                    spread.append((score, r))
                else:
                    overflow.append((score, r))
            # If the cap leaves fewer than asked for, fill from what it dropped
            # rather than returning a short list.
            ranked = spread + overflow

        out = []
        for score, r in ranked[:k]:
            out.append({
                'id': r['id'], 'camera_id': r['camera_id'], 'source': r['source'],
                't_s': round(r['t_s'], 2), 'thumb': os.path.join(self.thumbs, r['thumb']),
                'score': round(score, 4),
                'counts': {c: r[f'n_{c}'] for c in
                           ('person', 'car', 'motorcycle', 'bus', 'truck')
                           if r[f'n_{c}']},
                'boxes': json.loads(r['boxes'] or '[]'),
            })
        return out


COLS = {'n_person', 'n_car', 'n_motorcycle', 'n_bus', 'n_truck', 'n_vehicle',
        'max_riders'}
