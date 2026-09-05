"""Run the ANPR worker across cameras and write sightings into the registry.

WHY THIS EXISTS RATHER THAN A HOSTED SERVICE
--------------------------------------------
The worker is a writer, not an API. The browser never calls it: the control
room reads `detections` from Postgres, and the worker's only job is to put rows
there. So it does not need a public URL, a container platform, or an uptime
guarantee — it needs a machine with a GPU and a network path to the feeds.

That machine can be a laptop. On an RTX 3050 this pipeline runs 16 s of 1080p
video in 40 s; a free CPU host is several times slower, so hosting it would be
paying for a downgrade.

    python run_batch.py --cameras cam08,cam04 --seconds 60
    python run_batch.py --all --seconds 30 --loop 900

Reads camera geography from the registry, so each sighting is written with the
position it was seen at rather than being joined back later.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sentinel_worker import Registry, analyse  # noqa: E402

GRID_RTSP = 'rtsp://103.250.160.189:8554/stream/{id}'
GRID_HLS = '{host}/{id}/index.m3u8'


def registry_cameras() -> list[dict]:
    """Cameras with their positions, from the database or the live catalogue."""
    url = os.environ.get('SUPABASE_URL', '')
    key = os.environ.get('SUPABASE_SERVICE_KEY', '')
    if url and key:
        from supabase import create_client
        db = create_client(url, key)
        rows = db.table('cameras').select(
            'id,name,lat:st_y(geom::geometry),lng:st_x(geom::geometry)'
        ).execute().data
        if rows:
            return rows

    # No registry yet — fall back to the grid catalogue so a first run still
    # works, with positions left null rather than invented.
    print('[batch] registry empty or unset; using the grid catalogue')
    req = urllib.request.Request(
        'https://cctv.corp8.cloud/cameras.json',
        headers={'User-Agent': 'sentinel-batch/1.0'})
    import json
    with urllib.request.urlopen(req, timeout=45) as r:
        cams = json.loads(r.read())
    return [{'id': c['id'], 'name': c['name'], 'lat': None, 'lng': None}
            for c in cams]


def capture(url: str, seconds: int, dest: str) -> bool:
    import subprocess
    ff = os.environ.get('FFMPEG', 'ffmpeg')
    cmd = [ff, '-hide_banner', '-loglevel', 'error']
    if url.startswith('rtsp://'):
        # UDP drops packets across NAT and yields corrupt frames that look like
        # model faults. The grid's own guidance is to force TCP.
        cmd += ['-rtsp_transport', 'tcp']
    cmd += ['-i', url, '-t', str(seconds), '-c', 'copy', '-y', dest]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=seconds * 5 + 120)
    except subprocess.TimeoutExpired:
        print('    capture timed out')
        return False
    if r.returncode != 0 or not os.path.exists(dest) or os.path.getsize(dest) < 50_000:
        tail = (r.stderr or '').strip().splitlines()
        print(f"    capture failed: {tail[-1][:110] if tail else 'no video'}")
        return False
    return True


def run_once(cams: list[dict], seconds: int, tiled: bool, source: str,
             hls_host: str) -> None:
    registry = Registry()
    tmp_dir = os.environ.get('SENTINEL_TMP', os.path.join(os.getcwd(), '_capture'))
    os.makedirs(tmp_dir, exist_ok=True)

    for cam in cams:
        cid = cam['id']
        url = (GRID_RTSP.format(id=cid) if source == 'rtsp'
               else GRID_HLS.format(host=hls_host.rstrip('/'), id=cid))
        dest = os.path.join(tmp_dir, f'{cid}.mp4')
        print(f"[{cid}] {cam.get('name', '')}", flush=True)

        started = datetime.now(timezone.utc)
        if not capture(url, seconds, dest):
            continue
        try:
            result = analyse(dest, cid, tiled=tiled)
        except Exception as exc:  # noqa: BLE001
            print(f'    analysis failed: {type(exc).__name__}: {exc}')
            continue
        finally:
            if os.path.exists(dest):
                os.remove(dest)

        v = result['vehicles']
        stored = registry.write(cid, v['plate_list'], cam.get('lat'),
                                cam.get('lng'), started_at=started)
        print(f"    {v['total_tracked']} vehicles, {v['plates_read']} plates, "
              f"{stored} stored, {result['elapsed_s']}s", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--cameras', help='comma-separated camera ids')
    g.add_argument('--all', action='store_true', help='every camera in the registry')
    ap.add_argument('--seconds', type=int, default=60, help='capture length per camera')
    ap.add_argument('--tiled', action='store_true',
                    help='tile plate detection — wide cameras with small plates')
    ap.add_argument('--source', default='rtsp', choices=['rtsp', 'hls'])
    ap.add_argument('--hls-host', default='https://cctv.corp8.cloud')
    ap.add_argument('--loop', type=int, default=0,
                    help='seconds between passes; 0 runs once')
    args = ap.parse_args()

    cams = registry_cameras()
    if args.cameras:
        wanted = {c.strip() for c in args.cameras.split(',')}
        cams = [c for c in cams if c['id'] in wanted]
    if not cams:
        sys.exit('no matching cameras')

    print(f'{len(cams)} cameras · {args.seconds}s each · source={args.source}\n')
    while True:
        run_once(cams, args.seconds, args.tiled, args.source, args.hls_host)
        if not args.loop:
            break
        # The grid permits one session per address, so passes are spaced rather
        # than run back to back.
        print(f'\n[batch] sleeping {args.loop}s\n', flush=True)
        time.sleep(args.loop)


if __name__ == '__main__':
    main()
