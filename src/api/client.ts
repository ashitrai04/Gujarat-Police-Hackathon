/**
 * Single API surface.
 *
 *   Cameras      -> the live Sentinel host (real registry + real HLS)
 *   Detections   -> the ANPR pipeline on Hugging Face (empty until configured)
 *   Boundaries   -> local GeoJSON in public/geo
 *
 * There is no mock layer. If a source is unavailable the UI says so.
 */

import type {
  Alert,
  Camera,
  CameraQuery,
  Detection,
  DetectionQuery,
  GeoJSONFeatureCollection,
  HealthSummary,
  Route,
  WatchlistItem,
} from './types';
import { listCameras } from './cameraStore';
import {
  ackAlert, addWatchlist, listAlerts, listDetections, listWatchlist,
  plateRoute, removeWatchlist, searchPlates, subscribeAlerts, toggleWatchlist,
} from './detections';
import { DB_READY } from './db';

/**
 * Analytics are live when a database is configured — that is where detections
 * land and where the UI reads them. There is no separate ANPR service to be
 * connected to any more.
 */
export const ANPR_CONNECTED = DB_READY;
export { subscribeAlerts };

let cache: { at: number; cameras: Camera[] } | null = null;
const TTL = 60_000;

async function allCameras(): Promise<Camera[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.cameras;
  // The registry is authoritative once a database is configured; the live
  // grid catalogue is the read-only fallback until then.
  const cameras = await listCameras();
  cache = { at: Date.now(), cameras };
  return cameras;
}

function matches(c: Camera, q: CameraQuery): boolean {
  if (q.domains?.length && !q.domains.includes(c.domain)) return false;
  if (q.camTypes?.length && !q.camTypes.includes(c.camType)) return false;
  if (q.status?.length && !q.status.includes(c.status)) return false;
  if (q.anprOnly && !c.anprCapable) return false;
  if (q.q) {
    const needle = q.q.toLowerCase();
    const hay = [c.name, c.district, c.department, c.id, ...c.tags].join(' ').toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export const api = {
  cameras: async (q: CameraQuery = {}): Promise<Camera[]> =>
    (await allCameras()).filter((c) => matches(c, q)),

  camerasGeoJSON: async (q: CameraQuery = {}): Promise<GeoJSONFeatureCollection> => {
    const cams = (await allCameras()).filter((c) => matches(c, q) && c.geoKnown);
    return {
      type: 'FeatureCollection',
      features: cams.map((c) => ({
        type: 'Feature' as const,
        id: c.id,
        properties: { ...c, tags: c.tags.join(',') },
        geometry: { type: 'Point' as const, coordinates: [c.lng, c.lat] },
      })),
    };
  },

  camerasWithin: async (a: {
    bbox?: [number, number, number, number];
    district?: string;
  }): Promise<Camera[]> => {
    let out = (await allCameras()).filter((c) => c.geoKnown);
    if (a.district) {
      out = out.filter((c) => c.district.toLowerCase() === a.district!.toLowerCase());
    }
    if (a.bbox) {
      const [w, s, e, n] = a.bbox;
      out = out.filter((c) => c.lng >= w && c.lng <= e && c.lat >= s && c.lat <= n);
    }
    return out;
  },

  health: async (): Promise<HealthSummary> => {
    const cams = await allCameras();
    const s = { online: 0, offline: 0, degraded: 0 };
    for (const c of cams) s[c.status]++;
    return {
      ...s,
      total: cams.length,
      anprCapable: cams.filter((c) => c.anprCapable).length,
    };
  },

  zonesGeoJSON: async (): Promise<GeoJSONFeatureCollection> => {
    const cams = (await allCameras()).filter((c) => c.geoKnown);
    const byDistrict = new Map<string, Camera[]>();
    for (const c of cams) {
      const list = byDistrict.get(c.district) ?? [];
      list.push(c);
      byDistrict.set(c.district, list);
    }
    return {
      type: 'FeatureCollection',
      features: [...byDistrict.entries()].map(([district, list]) => {
        const pad = 0.09;
        const lats = list.map((c) => c.lat);
        const lngs = list.map((c) => c.lng);
        const w = Math.min(...lngs) - pad;
        const e = Math.max(...lngs) + pad;
        const s = Math.min(...lats) - pad;
        const n = Math.max(...lats) + pad;
        return {
          type: 'Feature' as const,
          id: district,
          properties: { district, cameras: list.length, zoneId: list[0].zoneId },
          geometry: {
            type: 'Polygon' as const,
            coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
          },
        };
      }),
    };
  },

  /* ── Analytics, read from the same database the worker writes to ──
     There is no ANPR HTTP service in between: it would have restated one
     query per endpoint and given the deployment another process to keep
     alive, while losing row-level security on analytics data. ── */
  detections: (q: DetectionQuery = {}): Promise<Detection[]> => listDetections(q),

  route: async (plate: string): Promise<Route> => {
    // Camera geography lives in the registry, sightings in `detections`.
    // Joining here keeps the route query itself a single indexed lookup.
    const cams = await allCameras();
    return plateRoute(plate, cams.map((c) => ({
      id: c.id, name: c.name, lat: c.lat, lng: c.lng, district: c.district,
    })));
  },

  searchPlates: (term: string, limit?: number) => searchPlates(term, limit),

  watchlist: (): Promise<WatchlistItem[]> => listWatchlist(),
  addWatchlist: (i: Omit<WatchlistItem, 'id'>): Promise<WatchlistItem> => addWatchlist(i),
  toggleWatchlist: async (id: string, active: boolean): Promise<WatchlistItem> => {
    await toggleWatchlist(id, active);
    const all = await listWatchlist();
    return all.find((w) => w.id === id)!;
  },
  removeWatchlist: (id: string): Promise<void> => removeWatchlist(id),

  alerts: (): Promise<Alert[]> => listAlerts(),
  ackAlert: (id: string): Promise<void> => ackAlert(id),
};
