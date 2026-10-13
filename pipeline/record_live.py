"""
Pull the same wall-clock window from several cameras at once, at source
quality.

    python record_live.py --cameras cam08,cam09,cam10,cam11 --minutes 10
    python record_live.py --at 240 --minutes 15      # from 4h into the day

WHAT THE GRID ACTUALLY SERVES
-----------------------------
Not a live stream. Every playlist says EXT-X-PLAYLIST-TYPE:VOD and starts at
seg00000 -- about twelve hours of recorded footage, replayed. The site's LIVE
badge sits over a recording.

That is worth knowing because it changes what is possible. A true live stream
could only be captured at the speed it plays; a recording can be taken from
any point in it, and the same minute can be taken from several cameras.

TIME, NOT SEGMENT NUMBER
------------------------
Cameras use different segment lengths -- six seconds on one, ten on another --
so segment 100 is a different moment on each. Taking the same index from both
would record two unrelated minutes and then look for a vehicle in both, which
is how a tracing feature appears broken when nothing is wrong with it. The
window is resolved through each playlist's own EXTINF durations instead, so
every camera returns the same minutes.

WHY A WINDOW AND NOT EVERYTHING
-------------------------------
The grid serves about 0.02 MB/s on one connection and 0.04 MB/s across eight,
so the limit is the grid, not the number of connections. Thirty minutes from
thirty cameras is several hours of downloading. A shorter window from cameras
that share a road is worth more than a long one from cameras that do not: a
vehicle can only be traced where two cameras saw it.

WHY
---
Everything the archive cannot answer needs this. The recorded clips are about
two and a half minutes each and mostly from different towns, so no vehicle
appears on two of them -- which makes tracing a vehicle between cameras
impossible rather than merely empty. Thirty minutes across the whole estate,
recorded at the same wall-clock time, is what gives a vehicle the chance to
pass two cameras and be found on both.

It is also the only way to know which cameras can really read a plate. That
flag was set by judgement when the registry was built; half an hour of real
footage per camera settles it with evidence.

QUALITY
-------
Segments are copied byte for byte and concatenated. There is no re-encode, so
what lands on disk is exactly what the camera published -- a transcode could
only lose plate detail, which is the one thing being preserved. Where the grid
offers several renditions the highest bitrate is taken.

ONE SIGN-IN
-----------
The grid allows one session per address, so it is signed into once and the
cookie shared by every recorder. A thread that is refused asks for the session
to be renewed rather than signing in again on its own, because thirty
simultaneous sign-ins is precisely what the limit exists to stop.
"""
from __future__ import annotations

import argparse
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from run_batch import GRID_HLS, UA, grid_session  # noqa: E402

HOST = 'https://cctv.corp8.cloud'

_session = ''
_session_lock = threading.Lock()
_session_at = 0.0


def session(force: bool = False) -> str:
    """The shared grid cookie, renewed at most once every half minute.

    Without the lock, a camera failing at the same moment as its neighbours
    starts thirty sign-ins, and the grid's one-session rule turns that into
    thirty mutual evictions.
    """
    global _session, _session_at
    with _session_lock:
        if force and time.time() - _session_at > 30:
            _session = grid_session(HOST) or ''
            _session_at = time.time()
        elif not _session:
            _session = grid_session(HOST) or ''
            _session_at = time.time()
        return _session


def get(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Cookie': 'sentinel=' + session()})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def best_variant(playlist_url: str, body: str) -> str:
    """Follow a master playlist to its highest-bitrate rendition.

    A master lists renditions; taking the first would quietly record the
    lowest quality the camera offers, and plate detail is the first thing
    that goes.
    """
    lines = body.splitlines()
    best, best_bw = None, -1
    for i, line in enumerate(lines):
        if line.startswith('#EXT-X-STREAM-INF'):
            bw = 0
            for part in line.split(':', 1)[-1].split(','):
                if part.strip().upper().startswith('BANDWIDTH='):
                    try:
                        bw = int(part.split('=', 1)[1])
                    except ValueError:
                        bw = 0
            for nxt in lines[i + 1:]:
                if nxt.strip() and not nxt.startswith('#'):
                    if bw > best_bw:
                        best, best_bw = nxt.strip(), bw
                    break
    return urllib.parse.urljoin(playlist_url, best) if best else playlist_url


def window(body: str, at_s: float, span_s: float) -> list[str]:
    """The segment URIs covering [at_s, at_s + span_s] of this recording.

    Resolved from the playlist's own EXTINF durations, so a camera on six
    second segments and one on ten both return the same minutes. Index
    arithmetic would not: segment 100 is 10 minutes into one and 16 into the
    other, and the two clips would share no moment to find a vehicle in.
    """
    out, t = [], 0.0
    dur = 0.0
    for line in body.splitlines():
        line = line.strip()
        if line.startswith('#EXTINF:'):
            try:
                dur = float(line[8:].split(',')[0])
            except ValueError:
                dur = 0.0
        elif line and not line.startswith('#'):
            if t + (dur or 6.0) > at_s and t < at_s + span_s:
                out.append(line)
            t += dur or 6.0
            if t >= at_s + span_s:
                break
    return out


def record(cam: str, at_s: float, span_s: float, out_dir: str,
           status: dict) -> None:
    url = GRID_HLS.format(host=HOST, id=cam)
    dest = os.path.join(out_dir, f'{cam}.ts')
    written = segments = errors = 0

    try:
        body = get(url, timeout=40).decode('utf8', 'replace')
    except Exception as e:                                    # noqa: BLE001
        status[cam] = f'playlist failed: {type(e).__name__}'
        return
    if '#EXT-X-STREAM-INF' in body:
        url = best_variant(url, body)
        try:
            body = get(url, timeout=40).decode('utf8', 'replace')
        except Exception as e:                                # noqa: BLE001
            status[cam] = f'variant failed: {type(e).__name__}'
            return

    uris = window(body, at_s, span_s)
    if not uris:
        status[cam] = 'no segments in that window'
        return
    status[cam] = f'0.0 MB 0/{len(uris)} seg'

    with open(dest, 'wb') as f:
        for n, u in enumerate(uris, 1):
            for attempt in range(3):
                try:
                    f.write(get(urllib.parse.urljoin(url, u), timeout=90))
                    written = f.tell()
                    segments += 1
                    break
                except urllib.error.HTTPError as e:
                    errors += 1
                    if e.code in (401, 403):
                        session(force=True)   # the cookie went stale
                    time.sleep(2)
                except Exception:                             # noqa: BLE001
                    errors += 1
                    time.sleep(2)
            f.flush()
            status[cam] = f'{written / 1e6:6.1f} MB {n}/{len(uris)} seg'

    status[cam] = (f'{written / 1e6:6.1f} MB {segments}/{len(uris)} seg'
                   + (f'  ({errors} retries)' if errors else ''))


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--minutes', type=float, default=10,
                    help='how much footage to take from each camera')
    ap.add_argument('--at', type=float, default=240,
                    help='where to start, in minutes into the recording')
    ap.add_argument('--cameras', default='')
    ap.add_argument('--out', default=os.path.join(here, 'live'))
    ap.add_argument('--workers', type=int, default=0,
                    help='parallel recorders; default is one per camera')
    args = ap.parse_args()

    if args.cameras.strip():
        cams = [c.strip() for c in args.cameras.split(',') if c.strip()]
    else:
        from run_batch import registry_cameras
        cams = [c['id'] for c in registry_cameras()]

    os.makedirs(args.out, exist_ok=True)
    if not session():
        raise SystemExit('grid sign-in refused - check SENTINEL_ACCESS_* and '
                         'that nothing else on this network holds the session')

    at_s, span_s = args.at * 60, args.minutes * 60
    # More connections do not buy more throughput here -- eight gave twice
    # one, not eight times -- and each extra one makes every other slower, so
    # a camera finishes late with nothing to show for it.
    workers = args.workers or min(6, len(cams))
    status: dict = {c: 'starting' for c in cams}
    print(f'[record] {len(cams)} cameras, {args.minutes:g} min each from '
          f'{args.at:g} min in, {workers} at a time')
    print(f'[record] into {args.out}\n')

    t0 = time.time()
    stop = threading.Event()

    def ticker() -> None:
        while not stop.wait(30):
            done = sum(1 for v in status.values() if 'MB' in str(v))
            total = sum(float(str(v).split('MB')[0]) for v in status.values()
                        if 'MB' in str(v))
            el = (time.time() - t0) / 60
            print(f'  [{el:5.1f} min] {done}/{len(cams)} started, '
                  f'{total:.0f} MB at {total / max(el * 60, 1):.3f} MB/s',
                  flush=True)

    threading.Thread(target=ticker, daemon=True).start()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for cam in cams:
            pool.submit(record, cam, at_s, span_s, args.out, status)
    stop.set()

    print(f'\n{"=" * 60}')
    print(f' {len(cams)} cameras, {(time.time() - t0) / 60:.1f} min')
    print(f'{"=" * 60}')
    ok = 0
    for cam in sorted(status):
        line = str(status[cam])
        got = 'MB' in line and float(line.split('MB')[0]) > 1
        ok += got
        print(f'  {"ok " if got else "   "} {cam:8s} {line}')
    print(f'\n{ok}/{len(cams)} cameras recorded something usable.')
    print(f'\nNext: python anpr_archive.py --footage "{args.out}"')


if __name__ == '__main__':
    main()
