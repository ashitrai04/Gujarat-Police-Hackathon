"""
Score the ANPR pipeline against plates that were read by hand first.

    python bench_anpr.py clip.mp4 --truth GJ04EP2038,GJ03PA8482,GJ07A4509
    python bench_anpr.py clip.mp4 --truth ... --profiles balanced,accurate

Recall is the number that matters and the only one worth trusting here. A count
of whatever the pipeline emitted says nothing: a run that invents twenty plates
looks productive and is worse than useless. So the answer is fixed in advance
and the run is scored against it.

Precision is reported with a caveat that is easy to forget. A "false positive"
here is a plate that was not in the hand-verified set, and the set covers only
the vehicles somebody checked — a correct reading of a fourth vehicle counts
against the score. Treat it as a floor, not a measurement.

Comparing profiles on one clip tells you which to run, not how good the system
is. Twenty-four seconds of one junction is a sanity check; a claim about the
estate needs the whole estate.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sentinel_worker import PROFILES, analyse, default_profile, free_vram_gb  # noqa: E402


def score(read: list[str], truth: list[str]) -> dict:
    got = {p.upper().replace(' ', '') for p in read if p}
    want = {p.upper().replace(' ', '') for p in truth}
    correct = sorted(got & want)
    missed = sorted(want - got)
    extra = sorted(got - want)
    return {
        'read': len(got),
        'correct': len(correct),
        'recall': round(len(correct) / len(want), 3) if want else 0.0,
        'precision': round(len(correct) / len(got), 3) if got else 0.0,
        'correct_plates': correct,
        'missed': missed,
        'unverified': extra,
    }


def run(video: str, truth: list[str], profile: str, tiled: bool) -> dict:
    print(f'\n=== {profile} ===', flush=True)
    p = PROFILES[profile]
    print(f"    {p['weights']} at imgsz {p['imgsz']}, conf {p['det_conf']}, "
          f"frame_skip {p['frame_skip']}", flush=True)
    t0 = time.time()
    try:
        result = analyse(video, 'bench', tiled=tiled, profile=profile)
    except Exception as e:                                   # noqa: BLE001
        msg = str(e)
        oom = 'out of memory' in msg.lower() or 'CUDA' in msg
        print(f'    FAILED{" (out of memory)" if oom else ""}: {msg[:160]}')
        return {'profile': profile, 'error': msg[:200], 'oom': oom}

    v = result['vehicles']
    plates = [r.get('plate') for r in v.get('plate_list', [])]
    s = score(plates, truth)
    s.update({
        'profile': profile,
        'seconds': round(time.time() - t0, 1),
        'vehicles': v.get('total_tracked', 0),
        'plates_read': v.get('plates_read', len(plates)),
    })
    print(f"    {s['vehicles']} vehicles, {s['read']} distinct plates, "
          f"{s['seconds']}s", flush=True)
    print(f"    recall {s['recall']:.2f}  precision {s['precision']:.2f}")
    print(f"    correct    : {', '.join(s['correct_plates']) or '-'}")
    if s['missed']:
        print(f"    MISSED     : {', '.join(s['missed'])}")
    if s['unverified']:
        print(f"    unverified : {', '.join(s['unverified'][:8])}")
    return s


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('video')
    ap.add_argument('--truth', required=True,
                    help='comma-separated plates verified by eye beforehand')
    ap.add_argument('--profiles', default='',
                    help='comma-separated; default is whatever this host would pick')
    ap.add_argument('--tiled', action='store_true')
    ap.add_argument('--out', default='')
    args = ap.parse_args()

    truth = [t.strip().upper() for t in args.truth.split(',') if t.strip()]
    names = [p.strip() for p in args.profiles.split(',') if p.strip()] \
        or [default_profile()]
    bad = [n for n in names if n not in PROFILES]
    if bad:
        sys.exit(f'unknown profile(s): {", ".join(bad)}')

    print(f'clip   : {args.video}')
    print(f'truth  : {", ".join(truth)}  ({len(truth)} plates)')
    print(f'free   : {free_vram_gb():.1f} GB VRAM')

    rows = [run(args.video, truth, n, args.tiled) for n in names]

    print('\n' + '=' * 74)
    print(f"{'profile':10s} {'recall':>7s} {'precis':>7s} {'read':>5s} "
          f"{'vehicles':>9s} {'seconds':>8s}")
    print('-' * 74)
    for r in rows:
        if r.get('error'):
            print(f"{r['profile']:10s} {'—':>7s} {'—':>7s} "
                  f"{'(out of memory)' if r.get('oom') else '(failed)':>31s}")
            continue
        print(f"{r['profile']:10s} {r['recall']:7.2f} {r['precision']:7.2f} "
              f"{r['read']:5d} {r['vehicles']:9d} {r['seconds']:8.1f}")
    print('=' * 74)
    print('precision is a floor: plates outside the verified set count against it')

    if args.out:
        with open(args.out, 'w') as f:
            json.dump({'video': args.video, 'truth': truth, 'runs': rows}, f, indent=2)
        print(f'\nwritten to {args.out}')


if __name__ == '__main__':
    main()
