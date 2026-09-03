import { CAMERA_SELECT, DB_READY, db, toGeom, type AuditRow, type CameraRow } from './db';
import { isSignedIn } from './auth';
import { fetchRegistry } from './registry';
import type { Camera, Domain } from './types';

/** Fallback department label when a row carries no department of its own. */
const DEPT_LABEL: Record<Domain, string> = {
  traffic: 'Traffic Police',
  hospital: 'Health & Family Welfare',
  pds: 'Food, Civil Supplies & Consumer Affairs',
  rto: 'Ports & Transport (RTO)',
  public: 'Municipal / Panchayat',
};

/**
 * The camera registry, backed by Postgres when it is configured.
 *
 * Two sources, one shape. With Supabase set up, the database is authoritative
 * and cameras can be onboarded, edited and audited. Without it, the app falls
 * back to the live grid catalogue, which is real but read-only — there is
 * nowhere to put a camera an operator adds by hand.
 *
 * The fallback is never silent: `registrySource()` says which one is live so
 * the UI can tell the operator rather than leaving them guessing why an import
 * button does nothing.
 */

export type RegistrySource = 'database' | 'grid';

export function registrySource(): RegistrySource {
  return DB_READY ? 'database' : 'grid';
}

const DOMAINS: Domain[] = ['traffic', 'hospital', 'pds', 'rto', 'public'];

function rowToCamera(r: CameraRow): Camera {
  const domain = (DOMAINS.includes(r.domain as Domain) ? r.domain : 'public') as Domain;
  return {
    id: r.id,
    name: r.name,
    department: r.department_id ?? DEPT_LABEL[domain],
    domain,
    tags: r.tags ?? [],
    camType: r.cam_type === 'anpr' || r.cam_type === 'overview' ? 'fixed' : r.cam_type,
    anprCapable: r.anpr_capable,
    // A camera onboarded by a department may have no browser-playable URL at
    // all — an RTSP-only camera is normal. The player shows "no feed" rather
    // than inventing one.
    streamUrl: r.hls_url ?? '',
    status:
      r.status === 'online' ? 'online'
      : r.status === 'degraded' || r.status === 'maintenance' ? 'degraded'
      : r.status === 'offline' ? 'offline'
      : 'online',
    lat: r.lat ?? 22.6,
    lng: r.lng ?? 71.9,
    district: r.district ?? 'Unmapped',
    zoneId: r.zone_id ?? 'Z-UNMAP',
    width: null,
    height: null,
    fps: null,
    bitrateKbps: null,
    bitsPerPixel: null,
    codec: null,
    container: 'hls',
    rtspUrl: r.rtsp_url ?? '',
    webrtcUrl: '',
    anprGrade: 'unknown',
    geoKnown: r.lat != null && r.lng != null,
  };
}

/**
 * Every camera the current user is allowed to see. RLS does the scoping.
 *
 * Three cases, and the app must not go blank in any of them:
 *   no database        -> the live grid catalogue, read-only
 *   signed out         -> the grid too; RLS grants nothing to the anon role,
 *                         so querying would return an empty map and look broken
 *   signed in, empty   -> the grid, until someone runs the grid import
 */
export async function listCameras(): Promise<Camera[]> {
  if (!db || !(await isSignedIn())) return (await fetchRegistry()).cameras;

  const { data, error } = await db
    .from('cameras')
    .select(CAMERA_SELECT)
    .order('id');
  if (error) throw new Error(error.message);

  const rows = data as unknown as CameraRow[];
  if (!rows.length) return (await fetchRegistry()).cameras;
  return rows.map(rowToCamera);
}

/** Where the cameras on screen actually came from, for the UI to report. */
export async function activeSource(): Promise<RegistrySource> {
  if (!db || !(await isSignedIn())) return 'grid';
  const { count } = await db.from('cameras').select('id', { count: 'exact', head: true });
  return (count ?? 0) > 0 ? 'database' : 'grid';
}

export interface CameraInput {
  id: string;
  name: string;
  department_id?: string | null;
  domain?: string;
  district?: string | null;
  zone_id?: string | null;
  cam_type?: string;
  anpr_capable?: boolean;
  lat?: number | null;
  lng?: number | null;
  hls_url?: string | null;
  rtsp_url?: string | null;
  onvif_url?: string | null;
  vendor?: string | null;
  status?: string;
  commissioned_on?: string | null;
  last_serviced_on?: string | null;
  tags?: string[];
  source?: 'manual' | 'csv' | 'api' | 'grid';
}

function toRow(c: CameraInput) {
  const { lat, lng, ...rest } = c;
  return { ...rest, geom: toGeom(lat ?? null, lng ?? null) };
}

/**
 * Insert or update cameras.
 *
 * Upsert rather than insert: re-importing a corrected spreadsheet should fix
 * the rows it covers, not fail on every id that already exists. The audit
 * trigger records the before and after either way, so a correction is
 * traceable rather than silent.
 */
export async function upsertCameras(rows: CameraInput[]): Promise<number> {
  if (!db) throw new Error('No database configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
  if (!rows.length) return 0;

  // Chunked: a department's first import can be thousands of rows, and one
  // oversized request fails as a whole.
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK).map(toRow);
    const { error, count } = await db
      .from('cameras')
      .upsert(slice, { onConflict: 'id', count: 'exact' });
    if (error) throw new Error(error.message);
    written += count ?? slice.length;
  }
  return written;
}

export async function deleteCamera(id: string): Promise<void> {
  if (!db) throw new Error('No database configured');
  const { error } = await db.from('cameras').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/**
 * Pull the 30 live grid cameras into the registry.
 *
 * This is how the demo starts with real data instead of an empty table. The
 * grid supplies id, name and an HLS URL; geography comes from the same
 * location-prefix table the map already uses, so an imported camera lands on
 * the right junction rather than in the middle of Gujarat.
 */
export async function importFromGrid(): Promise<number> {
  const { cameras } = await fetchRegistry();
  return upsertCameras(
    cameras.map((c) => ({
      id: c.id,
      name: c.name,
      domain: c.domain,
      district: c.district,
      zone_id: c.zoneId,
      cam_type: c.camType,
      anpr_capable: c.anprCapable,
      lat: c.geoKnown ? c.lat : null,
      lng: c.geoKnown ? c.lng : null,
      hls_url: c.streamUrl,
      rtsp_url: c.rtspUrl,
      status: 'online',
      tags: c.tags,
      source: 'grid' as const,
    })),
  );
}

/** Most recent registry changes, newest first. Supervisors and admins only. */
export async function listAudit(limit = 100): Promise<AuditRow[]> {
  if (!db) return [];
  const { data, error } = await db
    .from('audit_log')
    .select('id,actor_email,action,entity,entity_id,detail,at')
    .order('at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data as AuditRow[];
}

/** Append a health sample. Called by the health poller, not by the UI. */
export async function recordHealth(
  cameraId: string,
  status: string,
  latencyMs?: number,
  detail?: string,
): Promise<void> {
  if (!db) return;
  await db.from('camera_health').insert({
    camera_id: cameraId,
    status,
    latency_ms: latencyMs ?? null,
    detail: detail ?? null,
  });
  await db.from('cameras').update({ status }).eq('id', cameraId);
}
