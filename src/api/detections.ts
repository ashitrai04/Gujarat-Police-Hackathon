import { db } from './db';
import type {
  Alert, Detection, DetectionQuery, Route, RouteStop,
  VehicleType, WatchlistCategory, WatchlistItem,
} from './types';

/**
 * Detections, watchlist and alerts, read straight from Postgres.
 *
 * These used to go through a separate ANPR HTTP service. That service was
 * never going to exist: the inference worker already writes into the same
 * database the application reads, so an API in between would only have
 * restated one query per endpoint and given the deployment another thing to
 * keep alive.
 *
 * Reading directly also means row-level security applies to analytics exactly
 * as it does to the registry — an officer scoped to one zone sees that zone's
 * sightings, enforced in the database rather than by whichever client asked.
 *
 * With no database configured every call returns empty. Nothing here invents a
 * detection: a fabricated plate on a police map is worse than a blank panel.
 */

const VEHICLE_TYPES: VehicleType[] = ['car', 'bike', 'auto', 'truck', 'bus'];

/** The worker records what YOLO reported; the UI has a narrower vocabulary. */
function toVehicleType(raw: string | null): VehicleType {
  const v = (raw ?? '').toLowerCase();
  if (v.includes('motor') || v.includes('bike') || v.includes('cycle')) return 'bike';
  if (v.includes('auto') || v.includes('rickshaw') || v.includes('tempo')) return 'auto';
  if (v.includes('bus') || v.includes('traveller')) return 'bus';
  if (v.includes('truck') || v.includes('tractor') || v.includes('van')) return 'truck';
  return VEHICLE_TYPES.includes(v as VehicleType) ? (v as VehicleType) : 'car';
}

interface DetectionRow {
  id: string;
  camera_id: string;
  plate: string | null;
  plate_confidence: number | null;
  vehicle_type: string | null;
  colour: string | null;
  frames_voted: number | null;
  snapshot_url: string | null;
  seen_at: string;
}

function toDetection(r: DetectionRow): Detection {
  return {
    id: r.id,
    cameraId: r.camera_id,
    plate: r.plate ?? '',
    vehicleType: toVehicleType(r.vehicle_type),
    colour: r.colour ?? '',
    // A plate voted across many frames is far more trustworthy than a single
    // read, so where per-read confidence is absent the vote count stands in
    // for it — saturating at ten frames, past which more adds little.
    confidence: r.plate_confidence
      ?? (r.frames_voted ? Math.min(1, r.frames_voted / 10) : 0),
    timestamp: r.seen_at,
    snapshotUrl: r.snapshot_url ?? '',
  };
}

const SELECT =
  'id,camera_id,plate,plate_confidence,vehicle_type,colour,frames_voted,snapshot_url,seen_at';

/** Sightings, newest first. Every filter is applied in the database. */
export async function listDetections(q: DetectionQuery = {}): Promise<Detection[]> {
  if (!db) return [];
  let query = db.from('detections').select(SELECT).order('seen_at', { ascending: false });

  // Partial plates matter: an operator often has three characters from a
  // witness, not the whole registration.
  if (q.plate) query = query.ilike('plate', `%${q.plate.toUpperCase()}%`);
  if (q.cameraId) query = query.eq('camera_id', q.cameraId);
  if (q.from) query = query.gte('seen_at', q.from);
  if (q.to) query = query.lte('seen_at', q.to);

  const { data, error } = await query.limit(q.limit ?? 200);
  if (error) throw new Error(error.message);
  return (data as unknown as DetectionRow[]).map(toDetection);
}

/**
 * Every sighting of one plate, oldest first — the vehicle's journey.
 *
 * This is the query the whole tracking feature rests on, and it is why
 * `detections` carries a composite index on (plate, seen_at): without it a
 * statewide search degrades into a full scan as the table grows.
 */
export async function plateRoute(
  plate: string,
  cameras: { id: string; name: string; lat: number; lng: number; district: string }[],
): Promise<Route> {
  if (!db) return { plate, stops: [] };

  const { data, error } = await db
    .from('detections')
    .select(SELECT)
    .eq('plate', plate.toUpperCase())
    .order('seen_at', { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);

  const byId = new Map(cameras.map((c) => [c.id, c]));
  const stops: RouteStop[] = [];
  for (const r of data as unknown as DetectionRow[]) {
    const cam = byId.get(r.camera_id);
    // A sighting from a camera the registry does not know cannot be placed on
    // the map, and guessing its position would draw a false route.
    if (!cam) continue;
    stops.push({
      cameraId: cam.id,
      cameraName: cam.name,
      lat: cam.lat,
      lng: cam.lng,
      timestamp: r.seen_at,
      snapshotUrl: r.snapshot_url ?? '',
      district: cam.district,
    });
  }
  return { plate: plate.toUpperCase(), stops };
}

/** Distinct plates seen, most recent first — the movement-search result list. */
export async function searchPlates(
  term: string,
  limit = 50,
): Promise<{ plate: string; sightings: number; last: string; cameras: number }[]> {
  if (!db) return [];
  const { data, error } = await db
    .from('detections')
    .select('plate,camera_id,seen_at')
    .ilike('plate', `%${term.toUpperCase()}%`)
    .not('plate', 'is', null)
    .order('seen_at', { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);

  const agg = new Map<string, { sightings: number; last: string; cams: Set<string> }>();
  for (const r of data as { plate: string; camera_id: string; seen_at: string }[]) {
    const e = agg.get(r.plate) ?? { sightings: 0, last: r.seen_at, cams: new Set<string>() };
    e.sightings += 1;
    e.cams.add(r.camera_id);
    if (r.seen_at > e.last) e.last = r.seen_at;
    agg.set(r.plate, e);
  }
  return [...agg.entries()]
    .map(([plate, e]) => ({
      plate, sightings: e.sightings, last: e.last, cameras: e.cams.size,
    }))
    .sort((a, b) => b.last.localeCompare(a.last))
    .slice(0, limit);
}

/* ── Watchlist ──────────────────────────────────────────────────── */

interface WatchRow {
  id: string;
  category: string;
  plate: string | null;
  person_ref: string | null;
  note: string | null;
  active: boolean;
}

const toWatch = (r: WatchRow): WatchlistItem => ({
  id: r.id,
  category: (r.category as WatchlistCategory) ?? 'wanted',
  plate: r.plate ?? '',
  personName: r.person_ref,
  active: r.active,
  notes: r.note ?? undefined,
});

export async function listWatchlist(): Promise<WatchlistItem[]> {
  if (!db) return [];
  const { data, error } = await db
    .from('watchlist')
    .select('id,category,plate,person_ref,note,active')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data as WatchRow[]).map(toWatch);
}

export async function addWatchlist(item: Omit<WatchlistItem, 'id'>): Promise<WatchlistItem> {
  if (!db) throw new Error('No database configured');
  const { data, error } = await db
    .from('watchlist')
    .insert({
      category: item.category,
      plate: item.plate.toUpperCase(),
      person_ref: item.personName,
      note: item.notes ?? null,
      active: item.active,
    })
    .select('id,category,plate,person_ref,note,active')
    .single();
  if (error) throw new Error(error.message);
  return toWatch(data as WatchRow);
}

export async function toggleWatchlist(id: string, active: boolean): Promise<void> {
  if (!db) return;
  const { error } = await db.from('watchlist').update({ active }).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function removeWatchlist(id: string): Promise<void> {
  if (!db) return;
  const { error } = await db.from('watchlist').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/* ── Alerts ─────────────────────────────────────────────────────── */

interface AlertRow {
  id: string;
  detection_id: string | null;
  watchlist_id: string | null;
  camera_id: string | null;
  status: string;
  created_at: string;
  detections: { plate: string | null; snapshot_url: string | null } | null;
  watchlist: { category: string } | null;
  cameras: { name: string } | null;
}

/**
 * Open alerts, newest first.
 *
 * Plate, category and camera name are joined here rather than fetched per card,
 * because an alert panel that issues a request per row is unusable exactly when
 * it matters most — during a burst.
 */
export async function listAlerts(limit = 100): Promise<Alert[]> {
  if (!db) return [];
  const { data, error } = await db
    .from('alerts')
    .select(
      'id,detection_id,watchlist_id,camera_id,status,created_at,' +
      'detections(plate,snapshot_url),watchlist(category),cameras(name)',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  return (data as unknown as AlertRow[]).map((r) => ({
    id: r.id,
    detectionId: r.detection_id ?? '',
    watchlistId: r.watchlist_id ?? '',
    cameraId: r.camera_id ?? '',
    timestamp: r.created_at,
    category: (r.watchlist?.category as WatchlistCategory) ?? 'wanted',
    status: r.status === 'open' ? 'new' : 'ack',
    snapshotUrl: r.detections?.snapshot_url ?? '',
    plate: r.detections?.plate ?? '',
    cameraName: r.cameras?.name ?? r.camera_id ?? '',
  }));
}

export async function ackAlert(id: string): Promise<void> {
  if (!db) return;
  const { data: session } = await db.auth.getSession();
  const { error } = await db
    .from('alerts')
    .update({
      status: 'acknowledged',
      acknowledged_by: session.session?.user.id ?? null,
      acknowledged_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

/**
 * Live alerts over Postgres change streams.
 *
 * Supabase Realtime carries the insert, so no polling and no websocket service
 * of our own. The row arrives without its joins, so the panel refetches — one
 * request per alert rather than one per second.
 */
export function subscribeAlerts(onInsert: () => void): () => void {
  const client = db;
  if (!client) return () => {};
  const channel = client
    .channel('alerts-stream')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts' },
        () => onInsert())
    .subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}
