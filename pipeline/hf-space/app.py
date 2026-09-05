"""Sentinel ANPR worker — HTTP front end for the Hugging Face Space.

Analysis is queued rather than run inside the request. A single camera-minute
takes tens of seconds even on a GPU, so an endpoint that blocked until the
pipeline finished would time out and give the caller nothing to poll.

Feeds are captured to a temporary file before analysis rather than decoded
from the network. Two reasons, both learned from this grid: it enforces one
short-lived connection per job on a host that permits one session per address,
and it removes the network from the inference loop, so a stall in the feed
cannot be mistaken for a slow model.
"""
from __future__ import annotations

import os
import queue
import subprocess
import sys
import tempfile
import threading
import traceback
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PIPELINE_DIR = os.environ.get('SENTINEL_PIPELINE_DIR', '/app/sentinel-gujarat-pipeline')
MAX_SECONDS = int(os.environ.get('MAX_CAPTURE_SECONDS', '180'))

app = FastAPI(title='Sentinel ANPR worker')
app.add_middleware(
    CORSMiddleware,
    # The control room is a browser application on another origin; it only ever
    # reads results, and the Space holds no secrets a caller could exfiltrate.
    allow_origins=['*'],
    allow_methods=['GET', 'POST', 'OPTIONS'],
    allow_headers=['*'],
)


@dataclass
class Job:
    id: str
    camera_id: str
    url: str
    seconds: int
    tiled: bool
    # Camera position, denormalised onto the sighting so a detection can be
    # placed on the map without a join back to the registry.
    lat: float | None = None
    lng: float | None = None
    status: str = 'queued'          # queued | capturing | analysing | done | failed
    queued_at: str = field(default_factory=lambda: _now())
    finished_at: str | None = None
    vehicles: int | None = None
    plates: list[dict[str, Any]] = field(default_factory=list)
    stored: int | None = None
    error: str | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


JOBS: dict[str, Job] = {}
QUEUE: "queue.Queue[str]" = queue.Queue()
STATE = {'models_loaded': False, 'busy': None}


class AnalyzeRequest(BaseModel):
    camera_id: str
    url: str
    seconds: int = 60
    tiled: bool = False
    lat: float | None = None
    lng: float | None = None


def capture(url: str, seconds: int, dest: str) -> None:
    """Pull a bounded clip from the feed.

    `-t` bounds the capture so a job cannot run forever on a live stream, and
    `-c copy` avoids a re-encode that would cost more than the inference.
    """
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error']
    if url.startswith('rtsp://'):
        # UDP loses packets across NAT and produces corrupt frames that look
        # like model faults; the grid's own guidance is to force TCP.
        cmd += ['-rtsp_transport', 'tcp']
    cmd += ['-i', url, '-t', str(seconds), '-c', 'copy', '-y', dest]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=seconds * 4 + 120)
    if r.returncode != 0 or not os.path.exists(dest) or os.path.getsize(dest) < 50_000:
        tail = (r.stderr or 'capture failed').strip().splitlines()
        raise RuntimeError(tail[-1] if tail else 'capture produced no video')


def worker_loop() -> None:
    from sentinel_worker import Registry, analyse

    registry = Registry()
    while True:
        job_id = QUEUE.get()
        job = JOBS[job_id]
        STATE['busy'] = job_id
        tmp = os.path.join(tempfile.gettempdir(), f'{job_id}.mp4')
        try:
            job.status = 'capturing'
            capture(job.url, job.seconds, tmp)

            job.status = 'analysing'
            result = analyse(tmp, job.camera_id, tiled=job.tiled)
            STATE['models_loaded'] = True

            v = result['vehicles']
            job.vehicles = v['total_tracked']
            job.plates = v['plate_list']
            job.stored = registry.write(job.camera_id, v['plate_list'],
                                        job.lat, job.lng)
            job.status = 'done'
        except Exception as exc:  # noqa: BLE001
            job.status = 'failed'
            job.error = f'{type(exc).__name__}: {exc}'
            traceback.print_exc()
        finally:
            job.finished_at = _now()
            STATE['busy'] = None
            if os.path.exists(tmp):
                os.remove(tmp)
            QUEUE.task_done()


@app.on_event('startup')
def start_worker() -> None:
    # One worker thread on purpose. The models do not fit twice in the free
    # tier's memory, and two concurrent captures would fight over the grid's
    # one-session-per-address limit.
    threading.Thread(target=worker_loop, daemon=True).start()


@app.get('/health')
def health() -> dict[str, Any]:
    return {
        'ok': True,
        'models_loaded': STATE['models_loaded'],
        'busy': STATE['busy'],
        'queued': QUEUE.qsize(),
        'storage': 'supabase' if os.environ.get('SUPABASE_SERVICE_KEY') else 'none',
        'pipeline_present': os.path.isdir(PIPELINE_DIR),
    }


@app.post('/analyze')
def analyze(req: AnalyzeRequest) -> dict[str, str]:
    if req.seconds > MAX_SECONDS:
        raise HTTPException(400,
                            f'seconds must be <= {MAX_SECONDS}; longer runs '
                            'should be split into several jobs')
    job = Job(id=uuid.uuid4().hex[:12], camera_id=req.camera_id, url=req.url,
              seconds=req.seconds, tiled=req.tiled, lat=req.lat, lng=req.lng)
    JOBS[job.id] = job
    QUEUE.put(job.id)
    return {'job_id': job.id, 'status': job.status}


@app.get('/jobs')
def jobs(limit: int = 20) -> list[dict[str, Any]]:
    recent = sorted(JOBS.values(), key=lambda j: j.queued_at, reverse=True)[:limit]
    return [asdict(j) for j in recent]


@app.get('/jobs/{job_id}')
def job(job_id: str) -> dict[str, Any]:
    if job_id not in JOBS:
        raise HTTPException(404, 'no such job')
    return asdict(JOBS[job_id])
