"""
Read plates across the whole recorded archive, and report what each camera
is actually capable of.

    python anpr_archive.py                  # every clip in ./footage
    python anpr_archive.py --cameras cam08,cam09

WHY THIS EXISTS
---------------
Two questions could not be answered from live captures, and both are
answerable from the archive.

The first is which cameras can read a plate at all. That flag was set by
judgement when the registry was built, and judgement was wrong: of thirty
cameras two were marked ANPR-capable, while cameras nobody had marked were
producing plates. A flag set from a guess is worse than no flag, because the
interface promises on it. This measures instead.

The second is whether one vehicle can be followed between cameras. That needs
the same plate on two of them, and it can only happen where two cameras see
the same road -- four of these are in Junagadh and three in Bilimora, which is
why those are done first. If a plate repeats there, vehicle tracing has a real
example. If it does not, the honest answer is that tracing needs the live
worker running for hours, not a recording.

The archive is 1080p daylight, which is the footage plate reading was measured
against in the first place. Night live feeds yield almost nothing whatever the
code does.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sentinel_worker import Registry, analyse  # noqa: E402

# Co-located first: a trace needs two cameras on the same road, and these are
# the only groups in the archive that qualify.
CLUSTERS = [
    ['cam08', 'cam09', 'cam10', 'cam11'],      # Junagadh
    ['cam27', 'cam28', 'cam29'],               # Bilimora
]


def registry_positions() -> dict:
    """camera id -> (lat, lng), so each sighting is written where it happened."""
    try:
        from run_batch import registry_cameras
        return {c['id']: (c.get('lat'), c.get('lng')) for c in registry_cameras()}
    except Exception as e:                                    # noqa: BLE001
        print(f'[archive] could not read positions ({e}); writing without them')
        return {}


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--footage', default=os.path.join(here, 'footage'))
    ap.add_argument('--cameras', default='')
    ap.add_argument('--profile', default=None)
    ap.add_argument('--tiled', action='store_true',
                    help='tile plate detection - slower, for small plates')
    args = ap.parse_args()

    have = {}
    for f in sorted(os.listdir(args.footage)):
        stem = os.path.splitext(f)[0]
        if stem.startswith('cam'):
            have[stem] = os.path.join(args.footage, f)
    if not have:
        raise SystemExit(f'no clips in {args.footage} - run fetch_archive.py first')

    wanted = [c.strip() for c in args.cameras.split(',') if c.strip()]
    if wanted:
        order = [c for c in wanted if c in have]
    else:
        order = [c for grp in CLUSTERS for c in grp if c in have]
        order += [c for c in have if c not in order]

    pos = registry_positions()
    reg = Registry()
    print(f'[archive] {len(order)} clip(s), clustered cameras first\n')

    per_camera: dict[str, int] = {}
    vehicles: dict[str, int] = {}
    plates_by_camera: dict[str, set] = defaultdict(set)
    t_all = time.time()

    for n, cam in enumerate(order, 1):
        path = have[cam]
        lat, lng = pos.get(cam, (None, None))
        size = os.path.getsize(path) / 1e6
        print(f'[{n}/{len(order)}] {cam}  {size:.0f} MB', flush=True)
        t0 = time.time()
        try:
            result = analyse(path, cam, tiled=args.tiled, profile=args.profile)
        except Exception as e:                                # noqa: BLE001
            print(f'    FAILED: {type(e).__name__}: {e}', flush=True)
            continue

        v = result['vehicles']
        plate_list = v['plate_list']
        stored = reg.write(cam, plate_list, lat, lng,
                           out_dir=os.environ.get('SENTINEL_OUT', 'output'))
        per_camera[cam] = v['plates_read']
        vehicles[cam] = v['total_tracked']
        for r in plate_list:
            if r.get('plate'):
                plates_by_camera[cam].add(r['plate'])
        print(f"    {v['total_tracked']} vehicles, {v['plates_read']} plates, "
              f"{stored} stored, {time.time() - t0:.0f}s", flush=True)

    # ---- what this run actually established -------------------------------
    print(f'\n{"=" * 66}')
    print(f' {len(order)} cameras in {(time.time() - t_all) / 60:.0f} min')
    print(f'{"=" * 66}')
    print('\nPlates read per camera (this is what ANPR-capable should mean):')
    for cam in sorted(per_camera, key=lambda c: -per_camera[c]):
        mark = 'YES' if per_camera[cam] > 0 else ' - '
        print(f'  {mark}  {cam:8s} {per_camera[cam]:3d} plates '
              f'from {vehicles[cam]:3d} vehicles')

    yes = [c for c, n in per_camera.items() if n > 0]
    print(f'\n{len(yes)} of {len(per_camera)} cameras produced at least one plate.')

    # A plate on two cameras is the only thing that makes tracing real.
    seen = Counter()
    for cam, plates in plates_by_camera.items():
        for p in plates:
            seen[p] += 1
    shared = {p: sorted(c for c, s in plates_by_camera.items() if p in s)
              for p, n in seen.items() if n > 1}
    print(f'\nPlates seen on more than one camera: {len(shared)}')
    for p, cams in list(shared.items())[:10]:
        print(f'  {p}  ->  {", ".join(cams)}')
    if not shared:
        print('  None. These clips are short and mostly from different towns,')
        print('  so a vehicle appearing on two of them would be luck. A real')
        print('  trace needs the live worker running across hours.')


if __name__ == '__main__':
    main()
