/**
 * ANPR / analytics service adapter.
 *
 * Detections, routes, watchlist matching and alerts all come from the separate
 * model pipeline (hosted on Hugging Face). Nothing here invents data: when the
 * service is not configured, every call returns empty and the UI says so
 * plainly. A control room that shows fabricated plates is worse than one that
 * shows none.
 *
 * Point VITE_ANPR_API_URL at the pipeline to switch it on.
 */

import type {
  Alert,
  Detection,
  DetectionQuery,
  Route,
  WatchlistItem,
} from './types';

export const ANPR_BASE = (import.meta.env.VITE_ANPR_API_URL || '').replace(/\/$/, '');
export const ANPR_CONNECTED = ANPR_BASE.length > 0;

export class AnprNotConnected extends Error {
  constructor() {
    super('Detection service not connected');
    this.name = 'AnprNotConnected';
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  if (!ANPR_CONNECTED) throw new AnprNotConnected();
  const res = await fetch(`${ANPR_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return res.json() as Promise<T>;
}

function qs(params: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Empty results rather than throwing, so panels can render a clean state. */
const emptyIfOffline = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
  if (!ANPR_CONNECTED) return fallback;
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AnprNotConnected) return fallback;
    throw err;
  }
};

export const anpr = {
  connected: ANPR_CONNECTED,
  baseUrl: ANPR_BASE,

  health: (): Promise<{ status: string; model?: string; uptime?: number }> =>
    req('/health'),

  detections: (q: DetectionQuery = {}): Promise<Detection[]> =>
    emptyIfOffline(() => req<Detection[]>(`/detections${qs({ ...q })}`), []),

  route: (plate: string): Promise<Route> =>
    emptyIfOffline(
      () => req<Route>(`/route${qs({ plate })}`),
      { plate, stops: [] },
    ),

  watchlist: (): Promise<WatchlistItem[]> =>
    emptyIfOffline(() => req<WatchlistItem[]>('/watchlist'), []),

  addWatchlist: (item: Omit<WatchlistItem, 'id'>): Promise<WatchlistItem> =>
    req('/watchlist', { method: 'POST', body: JSON.stringify(item) }),

  toggleWatchlist: (id: string, active: boolean): Promise<WatchlistItem> =>
    req(`/watchlist/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) }),

  removeWatchlist: (id: string): Promise<void> =>
    req(`/watchlist/${id}`, { method: 'DELETE' }),

  alerts: (): Promise<Alert[]> =>
    emptyIfOffline(() => req<Alert[]>('/alerts'), []),

  ackAlert: (id: string): Promise<void> =>
    req(`/alerts/${id}/ack`, { method: 'POST' }),

  /** Ask the pipeline to start/stop analysing a camera. */
  attach: (cameraId: string, streamUrl: string): Promise<{ ok: boolean }> =>
    req('/analyze', { method: 'POST', body: JSON.stringify({ cameraId, streamUrl }) }),

  detach: (cameraId: string): Promise<{ ok: boolean }> =>
    req(`/analyze/${cameraId}`, { method: 'DELETE' }),
};

/**
 * Live alert feed. Uses the pipeline's WebSocket when configured; otherwise a
 * no-op, so the console simply reports no detection service.
 */
export function subscribeAlerts(onAlert: (a: Alert) => void): () => void {
  if (!ANPR_CONNECTED) return () => {};

  const url = ANPR_BASE.replace(/^http/, 'ws') + '/alerts/stream';
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    try {
      ws = new WebSocket(url);
    } catch {
      retry = setTimeout(connect, 4000);
      return;
    }
    ws.onmessage = (e) => {
      try {
        onAlert(JSON.parse(e.data) as Alert);
      } catch {
        /* ignore malformed frames rather than kill the socket */
      }
    };
    ws.onclose = () => {
      if (!closed) retry = setTimeout(connect, 4000);
    };
    ws.onerror = () => ws?.close();
  };
  connect();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}
