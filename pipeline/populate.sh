#!/bin/bash
# Populate detections from the recorded archive rather than the live grid.
# The live feed is currently night footage at 854x480 — plates are not
# readable there. The archive is 1080p daylight, which is what the pipeline
# was measured against.
#
# Credentials are NOT in this file. A service-role key bypasses row-level
# security entirely, and this script is committed -- anything written here is
# published the moment it is pushed, and stays in the history afterwards even
# if it is deleted later.
#
# They come from pipeline/.env.worker, which is gitignored, or from the
# environment. Create it from .env.worker.example and fill it in.
if [ -f "$(dirname "$0")/.env.worker" ]; then
  set -a; . "$(dirname "$0")/.env.worker"; set +a
fi
: "${SUPABASE_URL:?set SUPABASE_URL in pipeline/.env.worker or the environment}"
: "${SUPABASE_SERVICE_KEY:?set SUPABASE_SERVICE_KEY in pipeline/.env.worker or the environment}"
export SUPABASE_URL SUPABASE_SERVICE_KEY
export SENTINEL_PIPELINE_DIR="$(pwd)/sentinel-gujarat-pipeline"
export SENTINEL_OUT="D:/React folder/anpr_video_test/archive_out"
PY="D:/React folder/.venv/Scripts/python.exe"
REC="D:/React folder/feed_recordings"

run() {  # camera-id  file  lat  lng
  echo "=== $1"
  "$PY" -u sentinel_worker.py "$REC/$2" --camera "$1" --mode day --lat "$3" --lng "$4" 2>&1 \
    | grep -aE "^\[worker\]"
}

run cam19 "19_19-KHAPARIA-GRAM-PANCHAYAT-TALUKA-GANDEVI-DI.mp4" 20.8100 73.0100
run cam20 "20_20-Mohanpura.mp4"                                  21.1700 72.8300
run cam23 "23_30-kheram.mp4"                                     22.3000 73.2000
run cam10 "10_10-char-chowk-road-2-junagadh.mp4"                 21.5200 70.4600
run cam11 "11_11-dolatpara-junagadh.mp4"                         21.4900 70.4400
