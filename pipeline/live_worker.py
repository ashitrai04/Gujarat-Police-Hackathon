"""
Continuous ANPR over the live estate.

    python live_worker.py                     # every camera in the registry, forever
    python live_worker.py --seconds 45        # longer capture per camera
    python live_worker.py --cameras cam08,cam12

WHAT THIS IS FOR
----------------
A department hands over a camera, it is onboarded through the registry, and
from then on anyone can ask "has this vehicle been past it?". That only works
if something is reading plates off that camera continuously and writing them
down. This is that something.

It differs from run_batch.py in the way that matters for the question above:
run_batch takes a list of cameras and makes one pass. This re-reads the
registry every cycle, so a camera added five minutes ago is picked up without
anyone restarting anything — which is exactly the moment a department will
want to search it.

WHY IT CAPTURES RATHER THAN STREAMS
-----------------------------------
Each pass pulls a short clip with ffmpeg and runs the pipeline over the file.
Holding thirty live sockets open and decoding them all continuously would need
far more of the card than a shared host can promise, and the clip boundary is
where a pass can be interrupted, retried or skipped without losing a track
halfway through. Recall over a day is set by how often each camera comes round,
not by whether the reading is continuous.

ORDERING
--------
Cameras are visited in order of how long it has been since each was last read,
so adding a camera does not leave it at the back of a fixed queue, and a camera
whose capture keeps failing does not starve the rest.
"""
from __future__ import annotations

import argparse
import os
import random
import signal
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from run_batch import GRID_HLS, GRID_RTSP, capture, grid_session, registry_cameras  # noqa: E402
from sentinel_worker import Registry, analyse, default_profile  # noqa: E402

_stop = False


def _handle(_sig, _frm):
    global _stop
    _stop = True
    print('\n[live] finishing the current camera, then stopping', flush=True)


def source_url(cam_id: str, source: str, hls_host: str) -> str:
    return (GRID_RTSP.format(id=cam_id) if source == 'rtsp'
            else GRID_HLS.format(host=hls_host.rstrip('/'), id=cam_id))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--cameras', default='',
                    help='comma-separated ids; default is every camera in the registry')
    ap.add_argument('--seconds', type=int, default=30,
                    help='how much footage to take from each camera per visit')
    ap.add_argument('--source', default='hls', choices=['hls', 'rtsp'])
    ap.add_argument('--hls-host', default='https://cctv.corp8.cloud')
    ap.add_argument('--profile', default=None,
                    help='accuracy profile; default is chosen from free VRAM')
    ap.add_argument('--rest', type=float, default=2.0,
                    help='seconds between cameras, to leave the card some air')
    ap.add_argument('--refresh', type=int, default=300,
                    help='how often to re-read the registry, in seconds')
    ap.add_argument('--tmp', default=os.environ.get('SENTINEL_TMP', '/tmp/sentinel-live'))
    ap.add_argument('--once', action='store_true', help='one pass, then exit')
    args = ap.parse_args()

    signal.signal(signal.SIGINT, _handle)
    signal.signal(signal.SIGTERM, _handle)
    os.makedirs(args.tmp, exist_ok=True)

    reg = Registry()
    profile = args.profile or default_profile()
    print(f'[live] profile {profile}, {args.seconds}s per camera over {args.source}',
          flush=True)
    if not reg.enabled:
        print('[live] SUPABASE_SERVICE_KEY is not set — detections will be '
              'printed, not stored', flush=True)

    # The grid allows one session per address, so it is acquired once and
    # reused for every capture rather than per clip.
    session = None if args.source == 'hls' and args.hls_host.startswith(
        ('http://localhost', 'http://127.0.0.1')) else grid_session(args.hls_host)

    wanted = [c.strip() for c in args.cameras.split(',') if c.strip()]
    last_seen: dict[str, float] = {}
    cams: list[dict] = []
    refreshed = 0.0
    passes = 0

    while not _stop:
        # Re-read the registry so an onboarded camera joins the rotation
        # without a restart.
        if time.time() - refreshed > args.refresh or not cams:
            try:
                rows = registry_cameras()
                if wanted:
                    rows = [c for c in rows if c['id'] in wanted]
                if rows:
                    known = {c['id'] for c in cams}
                    added = [c['id'] for c in rows if c['id'] not in known]
                    if added and cams:
                        print(f'[live] new in the registry: {", ".join(added)}',
                              flush=True)
                    cams = rows
                refreshed = time.time()
            except Exception as e:                       # noqa: BLE001
                print(f'[live] could not read the registry ({e}); keeping the '
                      f'{len(cams)} already known', flush=True)
                refreshed = time.time()

        if not cams:
            print('[live] no cameras; retrying in 60s', flush=True)
            time.sleep(60)
            continue

        # Longest-unread first, so a newly added camera is read soon and a
        # failing one does not hold the queue.
        order = sorted(cams, key=lambda c: last_seen.get(c['id'], 0.0))

        for cam in order:
            if _stop:
                break
            cid = cam['id']
            url = source_url(cid, args.source, args.hls_host)
            dest = os.path.join(args.tmp, f'{cid}.mp4')
            t0 = time.time()
            stamp = datetime.now(timezone.utc).strftime('%H:%M:%S')

            try:
                ok = capture(url, args.seconds, dest, session)
            except Exception as e:                       # noqa: BLE001
                print(f'[live {stamp}] {cid}: capture error {e}', flush=True)
                ok = False

            if not ok:
                last_seen[cid] = time.time()
                print(f'[live {stamp}] {cid}: no footage', flush=True)
                continue

            try:
                started = datetime.now(timezone.utc)
                result = analyse(dest, cid, profile=profile)
                v = result['vehicles']
                # out_dir is passed so each sighting carries its evidence
                # images. run_batch omits it and the rows go in bare; an
                # operator acting on a plate needs the crop to check it by
                # eye, which is the whole argument for storing them.
                stored = reg.write(cid, v['plate_list'], cam.get('lat'),
                                   cam.get('lng'), started_at=started,
                                   out_dir=os.environ.get('SENTINEL_OUT', 'output'))
                print(f'[live {stamp}] {cid}: {v["total_tracked"]} vehicles, '
                      f'{v["plates_read"]} plates, {stored} stored, '
                      f'{time.time() - t0:.0f}s', flush=True)
            except Exception as e:                       # noqa: BLE001
                print(f'[live {stamp}] {cid}: analysis failed — {e}', flush=True)
            finally:
                last_seen[cid] = time.time()
                try:
                    os.remove(dest)
                except OSError:
                    pass
                # A moment between cameras: on a shared card, going straight
                # into the next allocation is how a pass collides with
                # somebody else's job.
                time.sleep(args.rest + random.random())

        passes += 1
        if args.once:
            break

    print(f'[live] stopped after {passes} pass(es)', flush=True)


if __name__ == '__main__':
    main()
