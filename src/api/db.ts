import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase client for the camera registry.
 *
 * The app has to run with or without a database. Before Supabase is
 * configured, the registry falls back to the live grid catalogue, which is
 * read-only — you can look at the 30 grid cameras but not onboard your own.
 * Once the URL and anon key are set, the database becomes the source of truth
 * and onboarding, audit and role-based access come alive.
 *
 * `DB_READY` is what every caller checks. Nothing here throws when the
 * database is absent, and nothing invents rows to cover for it.
 */
const URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

export const DB_READY = URL.length > 0 && ANON.length > 0;

export const db: SupabaseClient | null = DB_READY
  ? createClient(URL, ANON, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;

/** Row shape of `public.cameras`. Mirrors supabase/migrations/0001_registry.sql. */
export interface CameraRow {
  id: string;
  name: string;
  department_id: string | null;
  domain: string;
  zone_id: string | null;
  district: string | null;
  cam_type: 'fixed' | 'ptz' | 'anpr' | 'overview';
  anpr_capable: boolean;
  hls_url: string | null;
  rtsp_url: string | null;
  onvif_url: string | null;
  vendor: string | null;
  status: 'online' | 'offline' | 'degraded' | 'maintenance' | 'unknown';
  commissioned_on: string | null;
  last_serviced_on: string | null;
  maintenance_note: string | null;
  lat: number | null;
  lng: number | null;
  tags: string[];
  source: 'manual' | 'csv' | 'api' | 'grid';
  created_at?: string;
  updated_at?: string;
}

export interface AuditRow {
  id: number;
  actor_email: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  detail: string | null;
  at: string;
}

/**
 * PostGIS stores a point; the UI wants two numbers.
 *
 * `lat` and `lng` are generated columns maintained by Postgres from `geom`
 * (migration 0003), not function calls in this select. PostgREST does not
 * evaluate functions in a select list — it reads `st_y(geom)` as an embedded
 * relationship, looks for a foreign key to a table named `st_y`, and fails
 * with PGRST200. `geom` remains authoritative for spatial queries.
 */
export const CAMERA_SELECT =
  'id,name,department_id,domain,zone_id,district,cam_type,anpr_capable,' +
  'hls_url,rtsp_url,onvif_url,vendor,status,commissioned_on,last_serviced_on,' +
  'maintenance_note,tags,source,created_at,updated_at,lat,lng';

/** Point literal for a PostGIS insert, or null when a camera has no location. */
export function toGeom(lat: number | null, lng: number | null): string | null {
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return `SRID=4326;POINT(${lng} ${lat})`;
}
