"""Attach evidence images to detections written before they were stored.

The evidence feature arrived after the first detections did, so those rows
carry a plate and a time but nothing an operator can check them against — which
is precisely the situation the images exist to prevent.

The pipeline keeps its labelled frames on disk under
<out>/<camera>/thumbs/<PLATE>_<track>.jpg, so the images exist; they were just
never uploaded. This walks the detections that are missing them, finds the
matching frame, and fills them in.

    python backfill_evidence.py                 # every camera found on disk
    python backfill_evidence.py --dry-run       # report, change nothing
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sentinel_worker import Registry, upload_evidence  # noqa: E402

# Runs land in different output directories over time; the frames are the same.
SEARCH_ROOTS = [
    os.environ.get('SENTINEL_OUT', 'output'),
    r'D:/React folder/anpr_video_test/archive_out',
    r'D:/React folder/anpr_video_test/live_out',
    r'D:/React folder/anpr_video_test/batch_out',
]


def find_root(camera_id: str, plate: str) -> str | None:
    """The first output directory holding a frame for this plate."""
    for root in SEARCH_ROOTS:
        thumbs = os.path.join(root, camera_id, 'thumbs')
        if not os.path.isdir(thumbs):
            continue
        if any(f.startswith(plate + '_') for f in os.listdir(thumbs)):
            return root
    return None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    registry = Registry()
    if not registry.client:
        sys.exit('No database configured — set credentials in .env.worker')

    rows = (registry.client.table('detections')
            .select('id,camera_id,plate,snapshot_url')
            .is_('snapshot_url', 'null')
            .execute().data)
    print(f'{len(rows)} detections without evidence\n')

    filled = missing = 0
    for r in rows:
        plate, cam = r['plate'], r['camera_id']
        if not plate:
            continue
        root = find_root(cam, plate)
        if not root:
            # The frame was never kept — say so rather than leaving the row
            # looking like an upload failure.
            print(f'  {cam} {plate:<12} no frame on disk')
            missing += 1
            continue
        if args.dry_run:
            print(f'  {cam} {plate:<12} would fill from {os.path.basename(root)}')
            filled += 1
            continue

        urls = upload_evidence(registry.client, cam, plate, root)
        if not urls['snapshot_url']:
            print(f'  {cam} {plate:<12} upload failed')
            missing += 1
            continue
        registry.client.table('detections').update(urls).eq('id', r['id']).execute()
        print(f"  {cam} {plate:<12} filled"
              f"{' (frame only)' if not urls['plate_crop_url'] else ''}")
        filled += 1

    print(f'\n{filled} filled, {missing} without a stored frame')


if __name__ == '__main__':
    main()
