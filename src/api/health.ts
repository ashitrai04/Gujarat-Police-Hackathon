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
export type StreamState = 'available' | 'live-only' | 'unavailable';

export interface StreamHealth {
  state: StreamState;
  /** Which route works, so the player can go straight to it. */
  route: 'progressive' | 'hls' | null;
  checkedAt: number;
}

const TIMEOUT_MS = 15000;
/**
 * Gap between probes on one worker. Measured on the deployed site: 30 probes
 * fired back to back had cameras 7, 9, 10, 11 and 12 answer 502, and the same
 * five returned 206 when spaced 3s apart. The host throttles bursts, so the
 * sweep is deliberately unhurried — it only has to finish inside the poll.
 */
const PACE_MS = 500;

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
 * Only a **206** counts as a working stored file. Measured across all 30
 * cameras, the endpoint answers 206 with a real `Content-Range` total when the
 * file exists (22 cameras) and a bare 200 with no length when it does not
 * (8 cameras) — a 200 here is an empty transcode that never yields a frame, so
 * treating it as success is exactly what puts a permanently black tile on the
 * wall. The split matches the recording run one-for-one.
 *
 * The HLS manifest is then checked to catch the live-only cameras, which have
 * no stored file but do have a running muxer.
 */
export async function probeCamera(cam: Camera): Promise<StreamHealth> {
  const checkedAt = Date.now();

  // Two passes. A single miss is not proof a camera is down: this host sits
  // behind Cloudflare and answers 5xx to bursts, which once had a whole run
  // reporting 21 healthy cameras as broken. Only a repeated miss counts.
  for (let attempt = 0; attempt < 2; attempt++) {
    const prog = await head(`${STREAM_BASE}/stream/${cam.id}`, { Range: 'bytes=0-1' });
    if (prog?.status === 206) {
      return { state: 'available', route: 'progressive', checkedAt };
    }

    const hls = await head(`${STREAM_BASE}/live/stream/${cam.id}/index.m3u8`);
    if (hls?.ok) {
      const body = await hls.text().catch(() => '');
      if (body.startsWith('#EXTM3U')) {
        return { state: 'live-only', route: 'hls', checkedAt };
      }
    }
    // Upstream's own 500 is a real answer — "muxer instance not available" —
    // and needs no second look. A 502/503/429 or a timeout is the throttle
    // talking, not the camera, so that is the only case worth retrying.
    if (!transient(prog) && !transient(hls)) break;
    if (attempt === 0) await sleep(1500);
  }

  return { state: 'unavailable', route: null, checkedAt };
}

/** Probe the estate a few at a time — the host throttles request bursts. */
export async function probeAll(
  cams: Camera[],
  concurrency = 2,
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

const RANK: Record<StreamState, number> = { available: 0, 'live-only': 1, unavailable: 2 };

/** Playable cameras first, then live-only, then dead — stable within each tier. */
export function byAvailability(health: Record<string, StreamHealth> | undefined) {
  return (a: Camera, b: Camera) => {
    const ra = RANK[health?.[a.id]?.state ?? 'available'];
    const rb = RANK[health?.[b.id]?.state ?? 'available'];
    if (ra !== rb) return ra - rb;
    return Number(a.id) - Number(b.id);
  };
}

export function isPlayable(health: Record<string, StreamHealth> | undefined, id: string) {
  return (health?.[id]?.state ?? 'available') !== 'unavailable';
}
