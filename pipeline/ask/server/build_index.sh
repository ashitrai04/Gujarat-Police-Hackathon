#!/usr/bin/env bash
#
# Build the searchable index from footage on this host.
#
#   bash build_index.sh                    # everything in $SENTINEL_HOME/footage
#   bash build_index.sh /data/cctv --every 0.5
#
# Indexing is decode-bound rather than GPU-bound — every frame is decoded and
# one in N kept — so on a 256-core host it is worth running several videos at
# once. That is what --jobs does, and why the default is not 1.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${SENTINEL_HOME:-$HOME/sentinel}"
# shellcheck disable=SC1091
source "$ROOT/env.sh"
# shellcheck disable=SC1091
source "$VENV/bin/activate"

FOOTAGE="${1:-$ROOT/footage}"
shift || true

if [ ! -d "$FOOTAGE" ]; then
  echo "!! no footage at $FOOTAGE"
  echo "   copy your .mp4 files there, or pass a directory as the first argument"
  exit 1
fi

COUNT=$(find "$FOOTAGE" -maxdepth 1 -name '*.mp4' | wc -l)
if [ "$COUNT" -eq 0 ]; then echo "!! no .mp4 files in $FOOTAGE"; exit 1; fi
echo "==> $COUNT videos in $FOOTAGE"

cd "$PIPELINE_DIR"
python -m ask.index "$FOOTAGE" --out "$ROOT/index" "$@"

# Rider counts are arithmetic over boxes already stored, so this is seconds
# even on a large index — but it must run after every rebuild, or the
# "three on one motorcycle" filter silently matches nothing.
python -m ask.riders --index "$ROOT/index"

echo
echo "==> index at $ROOT/index"
du -sh "$ROOT/index"
