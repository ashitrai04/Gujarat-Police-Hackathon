/**
 * Real camera registry, sourced from the live Sentinel grid.
 *
 * The grid now serves only `{ id, name }` per camera — the resolution, fps,
 * bitrate and bits-per-pixel it used to publish are gone, so every technical
 * field here is null rather than invented. Geography and department come from
 * the table below, keyed on the LOCATION PREFIX in the name rather than the
 * id, because the ids have now changed twice (numeric 1..30, then cam01..cam30
 * after the move to cctv.corp8.cloud). The prefix travels with the footage.
 */

import type { Camera, CamType, Domain } from './types';

/**
 * RTSP and WHEP are served from the bare public IP, not the CDN host: they
 * carry TCP/UDP media a CDN cannot proxy. Exposed for the inference pipeline;
 * the browser cannot use either.
 */
export const GRID_IP = '103.250.160.189';

/**
 * Talk to live.corp8.cloud directly, NOT live.sentinelgujarat.in.
 *
 * sentinelgujarat.in 301-redirects here, but that redirect response carries no
 * CORS headers, so browsers abort it ("Failed to fetch"). The final host does
 * send `access-control-allow-origin: *`, so going straight there works.
 */
/**
 * Same path in both environments: a Vite proxy locally (vite.config.ts) and a
 * Vercel rewrite in production (vercel.json). Because the rewrite is
 * same-origin from the browser's point of view, CORS never applies — which
 * sidesteps the host's duplicated Access-Control-Allow-Origin header entirely.
 * Vercel serves over HTTPS, so the `Secure` session cookie also works.
 */
const DEFAULT_PROXY = '/sentinel';

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

/** Raw shape returned by GET /cameras.json — a flat array, nothing more. */
export interface RawCamera {
  id: string;
  name: string;
}

/** `GET /cameras.json` returns the array directly — there is no envelope. */
export type RegistryResponse = RawCamera[];

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
 * ANPR suitability.
 *
 * This used to be derived from the host's bits-per-pixel figure. The grid no
 * longer publishes resolution or bitrate, so there is nothing to derive it
 * from and every camera reports `unknown` rather than a fabricated grade.
 *
 * That loses little: measured against these feeds, compression quality never
 * predicted plate yield anyway — camera geometry dominated. One camera graded
 * "good" returned zero plates; a "poor" one returned thirteen. Real grading
 * belongs to the ANPR pipeline, which can measure plate pixel width directly.
 */
export type AnprGrade = 'good' | 'fair' | 'poor' | 'unknown';

export function anprGrade(_raw: RawCamera): AnprGrade {
  return 'unknown';
}

/** Strip the numeric prefix the grid uses for ordering. */
function cleanName(location: string, place: Place | null): string {
  if (place) return place.label;
  return location.replace(/^\d{1,2}\s+/, '').trim() || location;
}

export function toCamera(raw: RawCamera): Camera {
  const place = placeFor(raw.name);
  const known = !!place;

  return {
    id: raw.id,
    name: cleanName(raw.name, place),
    department: place ? DEPT_BY_DOMAIN[place.domain] : 'Unassigned',
    domain: place?.domain ?? 'public',
    tags: [
      place?.district.toLowerCase() ?? 'unmapped',
      place?.domain ?? 'public',
      'hls',
    ].filter(Boolean),
    camType: place?.camType ?? (/ptz/i.test(raw.name) ? 'ptz' : 'fixed'),
    // Nothing in the catalogue speaks to ANPR suitability any more, so this is
    // left to the pipeline rather than guessed here.
    anprCapable: false,
    // HLS is the only browser-playable route: RTSP and WHEP are raw media on a
    // bare IP that no CDN can proxy, and WHEP is plain HTTP, which an HTTPS
    // page cannot load at all.
    streamUrl: `${STREAM_BASE}/${raw.id}/index.m3u8`,
    // The catalogue publishes no status field; the health probe decides.
    status: 'online',
    lat: place?.lat ?? 22.6,
    lng: place?.lng ?? 71.9,
    district: place?.district ?? 'Unmapped',
    zoneId: `Z-${(place?.district ?? 'UNMAP').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4)}`,
    // The grid stopped publishing these. Null, not invented.
    width: null,
    height: null,
    fps: null,
    bitrateKbps: null,
    bitsPerPixel: null,
    codec: null,
    container: 'hls',
    // Direct-IP routes, for the inference pipeline rather than the browser.
    rtspUrl: `rtsp://${GRID_IP}:8554/stream/${raw.id}`,
    webrtcUrl: `http://${GRID_IP}:8889/stream/${raw.id}/whep`,
    anprGrade: 'unknown',
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

export async function fetchRegistry(): Promise<{ cameras: Camera[] }> {
  const json = await getJson<RegistryResponse>('/cameras.json');
  return { cameras: json.map(toCamera) };
}

/**
 * The old host exposed /api/cameras/<id>/state with a `slot_offset` saying
 * where "now" sat inside the 12-hour loop. The new grid has no such endpoint,
 * so the position is computed from the playlist instead — see CameraPlayer.
 */
