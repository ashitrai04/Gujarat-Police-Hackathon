#!/bin/bash
# Populate detections from the recorded archive rather than the live grid.
# The live feed is currently night footage at 854x480 — plates are not
# readable there. The archive is 1080p daylight, which is what the pipeline
# was measured against.
export SUPABASE_URL="https://rexxfkbgcvlzgyhwnsrp.supabase.co"
export SUPABASE_SERVICE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJleHhma2JnY3Zsemd5aHduc3JwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODYwODQ0OCwiZXhwIjoyMTA0MTg0NDQ4fQ.xNOiI-N33JojVh8CXcvdQ6Hrc4qPM0DbiZU0n0Z8wuc"
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
