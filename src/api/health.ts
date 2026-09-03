import { STREAM_BASE } from './registry';
import type { Camera } from './types';

/**
 * Whether a camera can actually be played right now.
 *
 * The host's `status` field says "live" for every camera including the dead
 * ones, so it cannot be used for this. Measured against the estate: some
 * cameras have a stored progressive file, some are live-only with an HLS
 * muxer, and some answer 500 `muxer instance not available` on both — which is
 * what produces "Stream unavailable" tiles. Only a probe tells them apart.
 */
export type StreamState = 'available' | 'unavailable';

export interface StreamHealth {
  state: StreamState;
  /** Which route works, so the player can go straight to it. HLS only now. */
  route: 'hls' | null;
  checkedAt: number;
}

const TIMEOUT_MS = 15000;
/**
 * Gap between probes on one worker.
 *
 * The grid revokes a session that fetches too hard — measured directly: a burst
 * of requests got every path 403'd, /cameras.json included, while a fresh login
 * worked immediately. Its own integration guide says "open only the cameras you
 * are actively processing", and a 30-camera sweep every minute is the opposite
 * of that. The sweep is now slow on purpose; it only has to finish inside the
 * poll interval.
 */
const PACE_MS = 2000;

/** A response that says nothing about the camera, only about the moment. */
function transient(res: Response | null): boolean {
  if (!res) return true; // network error or timeout
  return res.status === 429 || (res.status >= 500 && res.status !== 500);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function head(url: string, headers?: HeadersInit): Promise<Response | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: ctl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask for the camera's HLS manifest and see whether one comes back.
 *
 * This used to distinguish a stored progressive file from a live-only muxer by
 * whether a byte-range request answered 206. Both of those are gone: the grid
 * publishes HLS only, so there is exactly one thing to check and one way to
 * fail. A manifest that starts `#EXTM3U` is a camera that will play.
 */
export async function probeCamera(cam: Camera): Promise<StreamHealth> {
  const checkedAt = Date.now();

  // Two passes. A single miss is not proof a camera is down — this grid sits
  // behind a CDN that answers 5xx to bursts, which once had a run report 21
  // healthy cameras as broken. Only a repeated miss counts.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await head(`${STREAM_BASE}/${cam.id}/index.m3u8`);
    if (res?.ok) {
      const body = await res.text().catch(() => '');
      if (body.startsWith('#EXTM3U')) {
        return { state: 'available', route: 'hls', checkedAt };
      }
    }
    // A 404 is the grid's own answer: that camera is not publishing. A
    // 502/503/429 or a timeout is throttling, not the camera, and is the only
    // case worth a second look.
    if (!transient(res)) break;
    if (attempt === 0) await sleep(1500);
  }

  return { state: 'unavailable', route: null, checkedAt };
}

/** Probe the estate a few at a time — the host throttles request bursts. */
/**
 * Probe a set of cameras.
 *
 * Callers pass only the cameras that matter — the ones on the wall — rather
 * than the whole estate. Probing all 30 costs 30 upstream requests per poll
 * for cameras nobody is watching, which is exactly what gets the session
 * revoked.
 */
export async function probeAll(
  cams: Camera[],
  concurrency = 1,
): Promise<Record<string, StreamHealth>> {
  const out: Record<string, StreamHealth> = {};
  let cursor = 0;

  async function worker() {
    while (cursor < cams.length) {
      const cam = cams[cursor++];
      out[cam.id] = await probeCamera(cam);
      await sleep(PACE_MS);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, cams.length) }, worker));
  return out;
}

const RANK: Record<StreamState, number> = { available: 0, unavailable: 1 };

/** Playable cameras first, then dead — stable within each tier. */
export function byAvailability(health: Record<string, StreamHealth> | undefined) {
  return (a: Camera, b: Camera) => {
    const ra = RANK[health?.[a.id]?.state ?? 'available'];
    const rb = RANK[health?.[b.id]?.state ?? 'available'];
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  };
}

export function isPlayable(health: Record<string, StreamHealth> | undefined, id: string) {
  return (health?.[id]?.state ?? 'available') !== 'unavailable';
}
