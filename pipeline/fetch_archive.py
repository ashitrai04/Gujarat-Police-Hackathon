"""
Download the recorded archive from the public bucket.

    python fetch_archive.py                      # every camera, into ./footage
    python fetch_archive.py --cameras cam08      # just one
    python fetch_archive.py --out ~/sentinel/footage

WHY THIS EXISTS
---------------
Two jobs need recorded footage and neither can use the live feeds for it.

Prompt search has to build an index, and an index built from a live capture is
a few minutes of whatever happened to be on screen. And plate accuracy cannot
be measured at night: the live estate at 3 a.m. is headlight glare and motion
blur, the night model is a separate download that is usually absent, and the
honest result is zero plates -- which says nothing about the pipeline.

The archive is 1080p daylight, which is what the pipeline was measured
against in the first place.

NO CREDENTIALS
--------------
The bucket is served from a public Cloudflare R2 URL -- the same one the web
application's video wall falls back to when a live feed drops. It needs no
account, no key and no signing. Anything here that asks for an R2 secret is
asking for something this does not use.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# The public bucket behind the video wall's archive fallback. Overridable so a
# department serving its own archive can point this elsewhere.
BASE = os.environ.get(
    'SENTINEL_FALLBACK_BASE',
    'https://pub-89366064122041608d2451385a27189a.r2.dev').rstrip('/')
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')


def get(url: str, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def discover(limit: int = 40) -> list[str]:
    """Ask the bucket which cameras it actually has.

    The camera list normally comes from the web application's index file, but
    a machine running only the server half does not necessarily have the web
    application's files beside it. Rather than fail there, the bucket is asked
    directly: a playlist either answers or it does not, and that is a better
    source of truth than any list anyway.
    """
    print(f'  no local index; asking the bucket which cameras it has')
    found = []
    for i in range(1, limit + 1):
        cam = f'cam{i:02d}'
        req = urllib.request.Request(f'{BASE}/{cam}/index.m3u8',
                                     headers={'User-Agent': UA}, method='HEAD')
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                if r.status == 200:
                    found.append(cam)
        except Exception:                                     # noqa: BLE001
            continue
    print(f'  {len(found)} found')
    return found


def camera_ids(repo_root: str, wanted: list[str]) -> list[str]:
    """Which cameras the archive holds, from the index the web app also reads."""
    if wanted:
        return wanted
    path = os.path.join(repo_root, 'public', 'fallback-index.json')
    if os.path.isfile(path):
        with open(path, encoding='utf-8') as f:
            return sorted(json.load(f))
    return discover()


def fetch(cam: str, out_dir: str) -> tuple[bool, float]:
    """Pull one camera's clip as a single file. Returns (ok, megabytes).

    The archive is HLS, so the segments are concatenated. Concatenated MPEG-TS
    is a valid stream on its own -- that is what the container is for, and why
    HLS can be played by appending.
    """
    playlist = f'{BASE}/{cam}/index.m3u8'
    try:
        body = get(playlist, timeout=60).decode('utf8', 'replace')
    except urllib.error.HTTPError as e:
        print(f'  {cam:8s} playlist HTTP {e.code}')
        return False, 0.0
    except Exception as e:                                    # noqa: BLE001
        print(f'  {cam:8s} {type(e).__name__}: {e}')
        return False, 0.0

    segs = [ln.strip() for ln in body.splitlines()
            if ln.strip() and not ln.startswith('#')]
    if segs and segs[0].endswith('.m3u8'):
        playlist = urllib.parse.urljoin(playlist, segs[0])
        body = get(playlist, timeout=60).decode('utf8', 'replace')
        segs = [ln.strip() for ln in body.splitlines()
                if ln.strip() and not ln.startswith('#')]
    if not segs:
        print(f'  {cam:8s} playlist lists no segments')
        return False, 0.0

    dest = os.path.join(out_dir, f'{cam}.ts')
    written = 0
    try:
        with open(dest, 'wb') as f:
            for i, uri in enumerate(segs, 1):
                f.write(get(urllib.parse.urljoin(playlist, uri)))
                written = f.tell()
                print(f'\r  {cam:8s} {i}/{len(segs)} segments, '
                      f'{written/1e6:.1f} MB', end='', flush=True)
    except Exception as e:                                    # noqa: BLE001
        print(f'\n  {cam:8s} stopped after {written/1e6:.1f} MB: '
              f'{type(e).__name__}: {e}')
        return written > 50_000, written / 1e6

    print(f'\r  {cam:8s} {len(segs)} segments, {written/1e6:.1f} MB      ')
    return True, written / 1e6


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(here)

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--cameras', default='',
                    help='comma-separated ids; default is everything in the archive')
    ap.add_argument('--out', default=os.path.join(here, 'footage'),
                    help='where to write (default: pipeline/footage)')
    args = ap.parse_args()

    wanted = [c.strip() for c in args.cameras.split(',') if c.strip()]
    cams = camera_ids(repo_root, wanted)
    if not cams:
        raise SystemExit(1)

    os.makedirs(args.out, exist_ok=True)
    print(f'==> {len(cams)} camera(s) from {BASE}')
    print(f'    into {args.out}\n')

    ok, total = 0, 0.0
    for cam in cams:
        good, mb = fetch(cam, args.out)
        ok += good
        total += mb

    print(f'\n==> {ok}/{len(cams)} downloaded, {total:.0f} MB')
    if ok:
        print('\nNext:')
        print(f'  plate accuracy on daylight footage:')
        print(f'    python sentinel_worker.py "{args.out}/cam08.ts" --camera cam08')
        print(f'  scene events on the same clip:')
        print(f'    python events.py "{args.out}/cam08.ts" --camera cam08 --store-all')
        print(f'  build the prompt-search index:')
        print(f'    python -m ask.index --footage "{args.out}"')


if __name__ == '__main__':
    main()
