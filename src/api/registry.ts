/**
 * Real camera registry, sourced from the live Sentinel host.
 *
 * The host serves technical metadata (resolution, fps, bitrate, bits/pixel)
 * and RTSP/WebRTC/HLS URLs, but no geography or department. Those come from
 * the table below — real junctions, keyed on the LOCATION PREFIX rather than
 * the numeric id, because the host has already re-numbered its cameras once
 * (inserting one camera shifted every later id by +1). The prefix travels with
 * the footage; the id does not.
 */

import type { Camera, CamType, Domain } from './types';

/**
 * Talk to live.corp8.cloud directly, NOT live.sentinelgujarat.in.
 *
 * sentinelgujarat.in 301-redirects here, but that redirect response carries no
 * CORS headers, so browsers abort it ("Failed to fetch"). The final host does
 * send `access-control-allow-origin: *`, so going straight there works.
 */
const DEFAULT_PROXY = import.meta.env.DEV ? '/sentinel' : '/api/sentinel';

export const SENTINEL_HOST =
  import.meta.env.VITE_SENTINEL_HOST || DEFAULT_PROXY;

/**
 * Streams go through the dev proxy, the API does not.
 *
 *  - /api/*  answers with a single `Access-Control-Allow-Origin: *`, so the
 *    browser can call it directly. Routing it through the proxy instead makes
 *    Cloudflare serve a bot-challenge HTML page.
 *  - /live/* answers with that header TWICE, which browsers reject outright
 *    ("contains multiple values '*, *'"), so those must be proxied.
 */
export const STREAM_BASE = import.meta.env.VITE_STREAM_BASE || DEFAULT_PROXY;

/** Raw shape returned by GET /api/cameras. */
export interface RawCamera {
  id: string;
  number: number;
  name: string;
  location: string;
  duration: number | null;
  codec: string;
  container: string;
  status: string;
  delivery: string;
  remote_transcode: boolean;
  detail: string;
  width: number;
  height: number;
  fps: number;
  bitrate_kbps: number;
  bits_per_pixel: number;
  rtsp_url: string;
  webrtc_url: string;
  hls_live_url: string;
}

export interface RegistryResponse {
  cameras: RawCamera[];
  catalog: { state: string; count: number; scanned_at: number; stale: boolean; error: string };
}

interface Place {
  district: string;
  domain: Domain;
  lat: number;
  lng: number;
  label: string;
  camType?: CamType;
}

/**
 * Location prefix -> real place. Coordinates are the actual junctions; several
 * were confirmed from the burned-in camera captions (e.g. "Majevadi Gate PTZ-2",
 * "Dethali Char Rasta_FIX1", "CSITMS-32_PTZ2").
 */
const PLACES: Record<string, Place> = {
  '01': { district: 'Ahmedabad', domain: 'traffic', lat: 23.0301, lng: 72.5100, label: 'Chiman Bhai Bridge', camType: 'ptz' },
  '02': { district: 'Ahmedabad', domain: 'traffic', lat: 23.0365, lng: 72.5580, label: 'Janpath', camType: 'ptz' },
  '03': { district: 'Ahmedabad', domain: 'public', lat: 23.0410, lng: 72.5450, label: 'O.N.G.C. Office' },
  '04': { district: 'Ahmedabad', domain: 'traffic', lat: 23.0100, lng: 72.5620, label: 'Paldi Circle', camType: 'ptz' },
  '05': { district: 'Ahmedabad', domain: 'traffic', lat: 23.0980, lng: 72.5820, label: 'Visat Teen Rasta', camType: 'ptz' },
  '06': { district: 'Junagadh', domain: 'traffic', lat: 21.5090, lng: 70.4720, label: 'Timbavadi Gate' },
  '07': { district: 'Gir Somnath', domain: 'traffic', lat: 20.9000, lng: 70.3670, label: 'Hero Showroom, Gir Somnath' },
  '08': { district: 'Junagadh', domain: 'traffic', lat: 21.5222, lng: 70.4579, label: 'Majevadi Gate', camType: 'ptz' },
  '09': { district: 'Junagadh', domain: 'traffic', lat: 21.5330, lng: 70.4400, label: 'New Bypass Circle' },
  '10': { district: 'Junagadh', domain: 'traffic', lat: 21.5185, lng: 70.4630, label: 'Char Chowk Road 2' },
  '11': { district: 'Junagadh', domain: 'traffic', lat: 21.4980, lng: 70.4410, label: 'Dolatpara' },
  '12': { district: 'Gandhinagar', domain: 'rto', lat: 23.1645, lng: 72.5810, label: 'Tri Mandir Adalaj Tollnaka' },
  '13': { district: 'Ahmedabad', domain: 'public', lat: 23.0380, lng: 72.5460, label: 'CN Vidhyalaya' },
  '14': { district: 'Ahmedabad', domain: 'traffic', lat: 23.0245, lng: 72.5700, label: 'Delight Circle' },
  '15': { district: 'Ahmedabad', domain: 'public', lat: 23.0155, lng: 72.5310, label: 'Suvidha Park' },
  '16': { district: 'Ahmedabad', domain: 'traffic', lat: 23.1020, lng: 72.5865, label: 'Visat P2' },
  '17': { district: 'Rajkot', domain: 'public', lat: 22.3039, lng: 70.8022, label: 'Rajkot Bus Port' },
  '18': { district: 'Rajkot', domain: 'public', lat: 22.3010, lng: 70.7960, label: 'Rajkot City CCTV' },
  '19': { district: 'Navsari', domain: 'public', lat: 20.9467, lng: 72.9520, label: 'Khaparia Gram Panchayat' },
  '20': { district: 'Valsad', domain: 'traffic', lat: 20.5992, lng: 72.9342, label: 'Mohanpura' },
  '23': { district: 'Patan', domain: 'traffic', lat: 23.8493, lng: 72.1266, label: 'Patan Dethali Char Rasta', camType: 'fixed' },
  '28': { district: 'Banaskantha', domain: 'traffic', lat: 24.1710, lng: 72.4380, label: 'BK Mervada Tran Rasta' },
  '30': { district: 'Valsad', domain: 'public', lat: 20.5700, lng: 72.9600, label: 'Kheram' },
  '33': { district: 'Gandhinagar', domain: 'rto', lat: 23.1667, lng: 72.8167, label: 'Dehgam Check Post' },
  '34': { district: 'Gandhinagar', domain: 'traffic', lat: 23.2100, lng: 72.7400, label: 'Dhanori' },
  '35': { district: 'Anand', domain: 'traffic', lat: 22.5645, lng: 72.9289, label: 'Tankal' },
  '36': { district: 'Navsari', domain: 'traffic', lat: 20.7690, lng: 72.9600, label: 'Bilimora — Station Road' },
  '37': { district: 'Navsari', domain: 'traffic', lat: 20.7720, lng: 72.9655, label: 'Bilimora — Market Yard' },
  '38': { district: 'Navsari', domain: 'traffic', lat: 20.7610, lng: 72.9480, label: 'Bilimora — Bypass' },
};

/** Cameras with no numeric prefix, matched on a keyword instead. */
const FALLBACK: Array<{ match: RegExp; place: Place }> = [
  {
    match: /gandhidham/i,
    place: { district: 'Kutch', domain: 'traffic', lat: 23.0800, lng: 70.1330, label: 'Gandhidham Rambaugh P2' },
  },
];

const DEPT_BY_DOMAIN: Record<Domain, string> = {
  traffic: 'Gujarat Police — Traffic',
  hospital: 'Health & Family Welfare',
  pds: 'Food, Civil Supplies & Consumer Affairs',
  rto: 'Ports & Transport (RTO)',
  public: 'Municipal / Panchayat',
};

function placeFor(location: string): Place | null {
  const prefix = location.trim().match(/^(\d{1,2})\b/)?.[1]?.padStart(2, '0');
  if (prefix && PLACES[prefix]) return PLACES[prefix];
  for (const f of FALLBACK) if (f.match.test(location)) return f.place;
  return null;
}

/**
 * ANPR suitability from the host's own bits-per-pixel figure.
 *
 * Measured against these feeds: compression quality alone does NOT predict
 * plate yield — camera geometry dominates. So this is a hint for the operator,
 * not a hard capability flag, and cameras the host has not probed yet
 * (width === 0) are reported as unknown rather than guessed.
 */
export type AnprGrade = 'good' | 'fair' | 'poor' | 'unknown';

export function anprGrade(raw: RawCamera): AnprGrade {
  if (!raw.width || !raw.bits_per_pixel) return 'unknown';
  if (raw.bits_per_pixel >= 0.09) return 'good';
  if (raw.bits_per_pixel >= 0.045) return 'fair';
  return 'poor';
}

/** Strip the numeric prefix the host uses for ordering. */
function cleanName(location: string, place: Place | null): string {
  if (place) return place.label;
  return location.replace(/^\d{1,2}\s+/, '').trim() || location;
}

export function toCamera(raw: RawCamera): Camera {
  const place = placeFor(raw.location);
  const grade = anprGrade(raw);
  const known = !!place;

  return {
    id: raw.id,
    name: cleanName(raw.location, place),
    department: place ? DEPT_BY_DOMAIN[place.domain] : 'Unassigned',
    domain: place?.domain ?? 'public',
    tags: [
      place?.district.toLowerCase() ?? 'unmapped',
      place?.domain ?? 'public',
      grade,
      raw.container,
      ...(raw.remote_transcode ? ['transcoded'] : []),
    ].filter(Boolean),
    camType: place?.camType ?? (/ptz/i.test(raw.location) ? 'ptz' : 'fixed'),
    // Grade is advisory; treat good/fair as worth pointing ANPR at.
    anprCapable: grade === 'good' || grade === 'fair',
    streamUrl: raw.hls_live_url
      ? `${STREAM_BASE}${raw.hls_live_url}`
      : `${STREAM_BASE}/stream/${raw.id}`,
    status: raw.status === 'live' ? 'online' : raw.status === 'processing' ? 'degraded' : 'offline',
    lat: place?.lat ?? 22.6,
    lng: place?.lng ?? 71.9,
    district: place?.district ?? 'Unmapped',
    zoneId: `Z-${(place?.district ?? 'UNMAP').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4)}`,
    // Real technical facts straight from the host.
    width: raw.width || null,
    height: raw.height || null,
    fps: raw.fps || null,
    bitrateKbps: raw.bitrate_kbps || null,
    bitsPerPixel: raw.bits_per_pixel || null,
    codec: raw.codec || null,
    container: raw.container,
    rtspUrl: raw.rtsp_url,
    webrtcUrl: raw.webrtc_url,
    anprGrade: grade,
    geoKnown: known,
  };
}

/**
 * The upstream sits behind Cloudflare and intermittently answers 525 (SSL
 * handshake failed) — measured at roughly 2 failures in 5 requests. A single
 * attempt would leave the console empty at random, so retry with backoff.
 */
async function getJson<T>(path: string, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${SENTINEL_HOST}${path}`, { cache: 'no-store' });
      if (res.ok) {
        const ct = res.headers.get('content-type') ?? '';
        if (!ct.includes('json')) throw new Error(`Expected JSON, got ${ct}`);
        return (await res.json()) as T;
      }
      // 5xx from the CDN is transient; 4xx is not worth retrying.
      if (res.status < 500) throw new Error(`${res.status} ${res.statusText}`);
      last = new Error(`${res.status} ${res.statusText}`);
    } catch (err) {
      last = err;
    }
    if (i < tries - 1) {
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw last instanceof Error ? last : new Error('Registry unreachable');
}

export async function fetchRegistry(): Promise<{ cameras: Camera[]; catalog: RegistryResponse['catalog'] }> {
  const json = await getJson<RegistryResponse>('/api/cameras');
  return { cameras: json.cameras.map(toCamera), catalog: json.catalog };
}

export const fetchCameraState = (id: string) => getJson(`/api/cameras/${id}/state`);
