"""
Measuring whether the search actually works.

The rule this project has held to elsewhere is that a number only counts if it
was measured against an answer fixed in advance. The ANPR recall figures mean
something because the plates in the clip were read by hand first; a retrieval
feature deserves the same treatment, and "the results look plausible" is not a
measurement.

So: a fixed query set, top-k pulled for each, and a contact sheet written per
query so a person can mark each returned frame relevant or not by eye. The
labels live in labels.json and are keyed by query and frame id, so re-running
after a change re-scores against the same judgements instead of new opinions.

Precision@k is reported honestly and recall is not, except where a query's
relevant set can be enumerated exhaustively. Recall over 3,634 frames would
need every frame judged for every query; claiming it from a pooled sample would
be the kind of number this project has refused to print elsewhere.

    python -m ask.evaluate --sheets          # run queries, write contact sheets
    python -m ask.evaluate --score           # score against labels.json
    python -m ask.evaluate --score --verify  # ... and measure the VLM's effect
"""
from __future__ import annotations

import argparse
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# Chosen to cover the four routes the router can take, and to include queries
# that are expected to fail — a query set with no failures in it is a query set
# chosen after seeing the results.
QUERIES = [
    # scene semantics — the embedding's job
    {'q': 'a busy road junction full of traffic', 'kind': 'scene'},
    {'q': 'an empty road with no vehicles', 'kind': 'scene'},
    {'q': 'a road at night', 'kind': 'scene'},
    {'q': 'people walking on the road', 'kind': 'scene'},
    {'q': 'a bus on the road', 'kind': 'scene'},
    {'q': 'a toll plaza with booths', 'kind': 'scene'},
    {'q': 'an autorickshaw', 'kind': 'scene'},
    {'q': 'a motorcycle with a rider', 'kind': 'scene'},
    # counting — the detector's job, which the embedding cannot do
    {'q': 'three people on one motorcycle', 'kind': 'count'},
    {'q': 'at least four vehicles in the frame', 'kind': 'count'},
    # place resolution — fuzzy match against the estate's own spellings
    {'q': 'traffic at Majevadi Gate', 'kind': 'place'},
    {'q': 'vehicles at Adalaj toll naka', 'kind': 'place'},
    # attribute — expected to be weak until a specialist detector lands
    {'q': 'a white car', 'kind': 'attribute'},
    {'q': 'a rider without a helmet', 'kind': 'attribute'},
    # the boundary
    {'q': 'muslim men standing near the road', 'kind': 'refusal'},
]


def contact_sheet(results: list[dict], out_path: str, title: str,
                  cols: int = 5, cell_w: int = 320) -> None:
    """A labelled grid of the returned frames, for judging by eye."""
    import cv2
    import numpy as np

    if not results:
        return
    cell_h = int(cell_w * 9 / 16)
    rows = (len(results) + cols - 1) // cols
    pad, bar, head = 6, 26, 34
    W = cols * (cell_w + pad) + pad
    H = head + rows * (cell_h + bar + pad) + pad
    sheet = np.full((H, W, 3), 24, np.uint8)
    cv2.putText(sheet, title[:110], (pad, 23), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                (235, 235, 235), 1, cv2.LINE_AA)

    for i, r in enumerate(results):
        img = cv2.imread(r['thumb'])
        if img is None:
            continue
        img = cv2.resize(img, (cell_w, cell_h), interpolation=cv2.INTER_AREA)
        cx = pad + (i % cols) * (cell_w + pad)
        cy = head + (i // cols) * (cell_h + bar + pad)
        sheet[cy:cy + cell_h, cx:cx + cell_w] = img
        counts = ' '.join(f'{k[:3]}{v}' for k, v in r['counts'].items()) or '-'
        label = f'#{i+1} id={r["id"]} {r["camera_id"]} {r["score"]:+.3f} {counts}'
        cv2.putText(sheet, label[:46], (cx + 2, cy + cell_h + 17),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.42, (200, 220, 255), 1, cv2.LINE_AA)
    cv2.imwrite(out_path, sheet, [cv2.IMWRITE_JPEG_QUALITY, 88])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--index', default=os.path.join(HERE, '_index'))
    ap.add_argument('--out', default=os.path.join(HERE, '_eval'))
    ap.add_argument('-k', type=int, default=10)
    ap.add_argument('--sheets', action='store_true', help='run queries and write contact sheets')
    ap.add_argument('--score', action='store_true', help='score against labels.json')
    ap.add_argument('--verify', action='store_true', help='also run the VLM verifier')
    ap.add_argument('--no-model', action='store_true')
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    runs_path = os.path.join(args.out, 'runs.json')
    labels_path = os.path.join(args.out, 'labels.json')

    if args.sheets or not os.path.exists(runs_path):
        # Load the retrieval model BEFORE the first prompt is parsed.
        #
        # Both models want host memory while they load, and on a 15 GB laptop
        # with a 6 GB card the order decides whether it works: if Ollama is
        # already resident with 3 GB, mapping SigLIP's 1.5 GB checkpoint fails
        # with a Windows commit-charge error ("the paging file is too small"),
        # which reads like a corrupt download rather than a scheduling problem.
        from . import embed
        embed.load()
        from .ask import run
        runs = {}
        for spec in QUERIES:
            q = spec['q']
            r = run(q, args.index, args.k, args.verify, args.k, args.no_model)
            runs[q] = {'kind': spec['kind'], **r}
            title = f'{spec["kind"]}: {q}'
            if r.get('refused'):
                print(f'{spec["kind"]:9s} REFUSED  {q}')
                continue
            contact_sheet(r['results'], os.path.join(args.out, f'{_slug(q)}.jpg'), title)
            vv = r.get('verification')
            vtxt = f'  verified {vv["confirmed"]}/{vv["checked"]}' if vv else ''
            deg = ' DEGRADED-PARSE' if r['plan'].get('parser') == 'rules' else ''
            print(f'{spec["kind"]:9s} {len(r["results"]):2d} hits  '
                  f'cand={r["n_candidates"]:5d}  {r["timing"]["search_s"]:.3f}s{vtxt}'
                  f'{deg}  {q}')
        with open(runs_path, 'w') as f:
            json.dump(runs, f, indent=2)
        print(f'\ncontact sheets in {args.out}')
        print(f'runs written to {runs_path}')

    if args.score:
        if not os.path.exists(labels_path):
            print(f'\nno labels at {labels_path}.')
            print('Judge each contact sheet and write, per query, the frame ids '
                  'that genuinely match:')
            print('  {"a busy road junction full of traffic": [12, 40, 355], ...}')
            return
        with open(runs_path) as f:
            runs = json.load(f)
        with open(labels_path) as f:
            labels = json.load(f)
        score(runs, labels, args.k)


def score(runs: dict, labels: dict, k: int) -> None:
    print(f'\n{"query":48s} {"kind":10s} {"P@" + str(k):>6s} {"rel":>4s}'
          f' {"vP@k":>6s} {"vconf":>6s}')
    print('-' * 88)
    agg: dict[str, list[float]] = {}
    v_before, v_after = [], []
    for q, r in runs.items():
        if r.get('refused'):
            continue
        rel = set(labels.get(q, []))
        if not rel and q not in labels:
            continue
        res = r['results'][:k]
        hits = [x for x in res if x['id'] in rel]
        p = len(hits) / max(1, len(res))
        agg.setdefault(r['kind'], []).append(p)

        # What the verifier did: precision over the frames it confirmed.
        conf = [x for x in res if x.get('verified') is True]
        vp = (len([x for x in conf if x['id'] in rel]) / len(conf)) if conf else float('nan')
        if conf:
            v_before.append(p)
            v_after.append(vp)
        vtxt = f'{vp:6.2f}' if conf else '     -'
        print(f'{q[:48]:48s} {r["kind"]:10s} {p:6.2f} {len(rel):4d} {vtxt} '
              f'{len(conf):6d}')

    print('-' * 88)
    for kind, ps in sorted(agg.items()):
        print(f'  {kind:10s} mean P@{k} = {sum(ps)/len(ps):.2f}  over {len(ps)} queries')
    allp = [p for ps in agg.values() for p in ps]
    if allp:
        print(f'  {"OVERALL":10s} mean P@{k} = {sum(allp)/len(allp):.2f}  over {len(allp)} queries')
    if v_after:
        print(f'\n  verifier: P@k {sum(v_before)/len(v_before):.2f} -> '
              f'{sum(v_after)/len(v_after):.2f} on the frames it confirmed '
              f'({len(v_after)} queries)')


def _slug(q: str) -> str:
    return ''.join(c if c.isalnum() else '_' for c in q.lower())[:60]


if __name__ == '__main__':
    main()
