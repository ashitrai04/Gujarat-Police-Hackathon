"""
Does the verifier actually verify, or does it agree?

A model asked "does this frame show X?" can score well on a shortlist simply
by answering yes every time — the shortlist is, after all, made of frames that
already looked like X. That would make verification appear to work while
adding nothing, and it would do it silently.

So the check is adversarial and symmetric. Frames known to be busy junctions
are put to the model as "an empty road with no vehicles", and frames known to
be empty are put as "a busy junction full of traffic". Both answers must be
no. Anything above chance on the matched pairs and near zero on the mismatched
pairs is a verifier; anything that says yes to both is a rubber stamp.

Ground truth comes from the detector's own counts, not from the model being
tested: busy means at least six vehicles in the frame, empty means none at all.

    python -m ask.bias_test
    python -m ask.bias_test --model minicpm-v:latest
"""
from __future__ import annotations

import argparse
import os
import sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--index', default=os.path.join(HERE, '_index'))
    ap.add_argument('--model', default=None, help='override the verifier model')
    ap.add_argument('-n', type=int, default=8, help='frames per group')
    args = ap.parse_args()

    from . import verify as V
    if args.model:
        V.MODEL = args.model

    db = sqlite3.connect(os.path.join(args.index, 'index.db'))
    db.row_factory = sqlite3.Row
    thumbs = os.path.join(args.index, 'thumbs')

    busy = list(db.execute(
        'select thumb, n_vehicle, n_person from frames where n_vehicle >= 6 '
        'order by n_vehicle desc limit ?', (args.n,)))
    empty = list(db.execute(
        'select thumb, n_vehicle, n_person from frames where n_vehicle = 0 '
        'and n_person = 0 order by id limit ?', (args.n,)))

    BUSY_Q = 'a busy junction full of traffic with many vehicles'
    EMPTY_Q = 'a completely empty road with no vehicles at all'

    cases = [
        ('busy frames  asked BUSY ', busy, BUSY_Q, True),
        ('busy frames  asked EMPTY', busy, EMPTY_Q, False),
        ('empty frames asked EMPTY', empty, EMPTY_Q, True),
        ('empty frames asked BUSY ', empty, BUSY_Q, False),
    ]

    print(f'verifier: {V.MODEL}')
    print(f'{args.n} busy frames (>=6 vehicles), {len(empty)} empty frames (0 vehicles, 0 people)\n')
    print(f'{"case":26s} {"yes":>4s} {"no":>4s} {"err":>4s}  {"correct":>8s}')
    print('-' * 56)
    totals = [0, 0]
    for name, rows, question, want in cases:
        yes = no = err = 0
        for r in rows:
            v = V.check(os.path.join(thumbs, r['thumb']), question)
            if not v['ok']:
                err += 1
            elif v['match']:
                yes += 1
            else:
                no += 1
        right = yes if want else no
        n = len(rows)
        totals[0] += right
        totals[1] += n
        print(f'{name:26s} {yes:4d} {no:4d} {err:4d}  {right}/{n}')
    print('-' * 56)
    acc = totals[0] / max(1, totals[1])
    print(f'{"overall":26s} {"":14s} {totals[0]}/{totals[1]} = {acc:.0%}')
    print('\n50% is what answering "yes" to everything scores on this test.')
    db.close()


if __name__ == '__main__':
    main()
