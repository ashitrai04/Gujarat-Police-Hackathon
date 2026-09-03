/**
 * Automatic column mapping for bulk camera import.
 *
 * Departments hand over spreadsheets they already keep, and every one of them
 * names its columns differently — "Cam ID", "camera_no", "Device Identifier"
 * all mean the same field. Forcing one rigid template is what makes bulk
 * import fail in practice, so instead the importer reads whatever headers it
 * is given and matches them to the internal schema itself, then shows the
 * operator what it decided before anything is written.
 *
 * Matching runs in three passes, strongest first:
 *   1. exact match on a known alias
 *   2. normalised match, ignoring case, spaces, and punctuation
 *   3. token overlap, so "Camera Latitude (deg)" still finds `lat`
 *
 * A field is only auto-assigned once. Two columns cannot both claim `id`.
 */

export type FieldKey =
  | 'id' | 'name' | 'department_id' | 'district' | 'zone_id'
  | 'cam_type' | 'anpr_capable' | 'lat' | 'lng'
  | 'hls_url' | 'rtsp_url' | 'onvif_url' | 'vendor'
  | 'status' | 'commissioned_on' | 'last_serviced_on' | 'tags';

export interface FieldSpec {
  key: FieldKey;
  label: string;
  required: boolean;
  aliases: string[];
  hint?: string;
}

export const FIELDS: FieldSpec[] = [
  {
    key: 'id', label: 'Camera ID', required: true,
    aliases: ['id', 'camid', 'cam id', 'camera id', 'camera_id', 'camera no',
              'camera_no', 'cameranumber', 'device id', 'device identifier',
              'deviceid', 'sr no', 'srno', 'code', 'camera code'],
  },
  {
    key: 'name', label: 'Name / location', required: true,
    aliases: ['name', 'camera name', 'location', 'site', 'place', 'junction',
              'description', 'camera location', 'installed at', 'address'],
  },
  {
    key: 'department_id', label: 'Department', required: false,
    aliases: ['department', 'dept', 'owner', 'owning department', 'agency',
              'org', 'organisation', 'organization'],
  },
  {
    key: 'district', label: 'District', required: false,
    aliases: ['district', 'dist', 'city', 'taluka', 'region'],
  },
  {
    key: 'zone_id', label: 'Zone', required: false,
    aliases: ['zone', 'zone id', 'jurisdiction', 'ps', 'police station', 'ward'],
  },
  {
    key: 'cam_type', label: 'Camera type', required: false,
    aliases: ['type', 'camera type', 'cam type', 'model type', 'category',
              'kind', 'ptz'],
    hint: 'fixed | ptz | anpr | overview',
  },
  {
    key: 'anpr_capable', label: 'ANPR capable', required: false,
    aliases: ['anpr', 'anpr capable', 'anpr_capable', 'plate reading', 'lpr',
              'number plate'],
    hint: 'yes/no, true/false, 1/0',
  },
  {
    key: 'lat', label: 'Latitude', required: false,
    aliases: ['lat', 'latitude', 'y', 'lat deg', 'gps lat', 'camera latitude'],
  },
  {
    key: 'lng', label: 'Longitude', required: false,
    aliases: ['lng', 'lon', 'long', 'longitude', 'x', 'gps long',
              'camera longitude'],
  },
  {
    key: 'hls_url', label: 'HLS / stream URL', required: false,
    aliases: ['stream url', 'streamurl', 'url', 'hls', 'hls url', 'feed url',
              'live url', 'link', 'stream'],
  },
  {
    key: 'rtsp_url', label: 'RTSP URL', required: false,
    aliases: ['rtsp', 'rtsp url', 'rtsp_url', 'rtsp link', 'ip stream'],
  },
  {
    key: 'onvif_url', label: 'ONVIF URL', required: false,
    aliases: ['onvif', 'onvif url', 'onvif endpoint', 'device service'],
  },
  {
    key: 'vendor', label: 'Vendor / make', required: false,
    aliases: ['vendor', 'make', 'brand', 'manufacturer', 'oem', 'model'],
  },
  {
    key: 'status', label: 'Status', required: false,
    aliases: ['status', 'health', 'state', 'working', 'condition', 'active'],
    hint: 'online | offline | degraded | maintenance',
  },
  {
    key: 'commissioned_on', label: 'Commissioned on', required: false,
    aliases: ['commissioned', 'commissioned on', 'install date', 'installed on',
              'installation date', 'date of installation', 'since'],
  },
  {
    key: 'last_serviced_on', label: 'Last serviced', required: false,
    aliases: ['last serviced', 'serviced on', 'last maintenance',
              'maintenance date', 'last service'],
  },
  {
    key: 'tags', label: 'Tags', required: false,
    aliases: ['tags', 'labels', 'keywords', 'remarks', 'notes'],
    hint: 'comma-separated',
  },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const tokens = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);

export interface Mapping {
  /** header from the file → internal field, or null for "ignore this column" */
  [header: string]: FieldKey | null;
}

/** Score how well one header matches one field. 0 means no match at all. */
function score(header: string, spec: FieldSpec): number {
  const h = header.trim();
  const hn = norm(h);
  if (!hn) return 0;

  for (const a of spec.aliases) {
    if (h.toLowerCase() === a) return 100;      // exact alias
    if (hn === norm(a)) return 90;              // same once normalised
  }
  for (const a of spec.aliases) {
    const an = norm(a);
    // A short header inside a long alias matches far too eagerly ("id" would
    // claim "device identifier"), so require the header to be the longer side.
    if (hn.length >= 3 && an.length >= 3 && (hn.includes(an) || an.includes(hn))) {
      return 70;
    }
  }
  const ht = new Set(tokens(h));
  let best = 0;
  for (const a of spec.aliases) {
    const at = tokens(a);
    if (!at.length) continue;
    const hit = at.filter((t) => ht.has(t)).length;
    if (hit) best = Math.max(best, 40 + (hit / at.length) * 20);
  }
  return best;
}

/**
 * Best-effort mapping from a file's headers to the internal schema.
 * Every header appears in the result, mapped or explicitly null, so the
 * preview can show the operator exactly what will and will not be imported.
 */
export function autoMap(headers: string[]): Mapping {
  const pairs: { header: string; key: FieldKey; s: number }[] = [];
  for (const header of headers) {
    for (const spec of FIELDS) {
      const s = score(header, spec);
      if (s >= 40) pairs.push({ header, key: spec.key, s });
    }
  }
  pairs.sort((a, b) => b.s - a.s);

  const out: Mapping = Object.fromEntries(headers.map((h) => [h, null]));
  const takenField = new Set<FieldKey>();
  const takenHeader = new Set<string>();
  for (const p of pairs) {
    if (takenField.has(p.key) || takenHeader.has(p.header)) continue;
    out[p.header] = p.key;
    takenField.add(p.key);
    takenHeader.add(p.header);
  }
  return out;
}

/* ── Value coercion ─────────────────────────────────────────────────── */

// Anything not explicitly affirmative is false. Sheets use blanks, dashes and
// "N/A" interchangeably for "no", so an allow-list is safer than a deny-list.
const TRUE = new Set(['y', 'yes', 'true', '1', 'anpr', 'enabled', 'active']);

export function toBool(v: unknown): boolean {
  return TRUE.has(String(v ?? '').trim().toLowerCase());
}

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Accepts dd/mm/yyyy and dd-mm-yyyy alongside ISO — Indian sheets use both. */
export function toDate(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

const TYPES = new Set(['fixed', 'ptz', 'anpr', 'overview']);
const STATUSES = new Set(['online', 'offline', 'degraded', 'maintenance', 'unknown']);

export interface ParsedRow {
  row: number;
  data: Record<string, unknown>;
  errors: string[];
}

/**
 * Apply the mapping, coerce values, and validate. Rows are returned whether
 * they pass or fail so the preview can show both — an import that silently
 * drops bad rows is how a department loses cameras without noticing.
 */
export function buildRows(
  raw: Record<string, unknown>[],
  mapping: Mapping,
): ParsedRow[] {
  const seen = new Set<string>();

  return raw.map((r, i) => {
    const data: Record<string, unknown> = {};
    for (const [header, key] of Object.entries(mapping)) {
      if (!key) continue;
      data[key] = r[header];
    }

    const errors: string[] = [];
    const id = String(data.id ?? '').trim();
    const name = String(data.name ?? '').trim();

    if (!id) errors.push('missing camera ID');
    else if (seen.has(id)) errors.push(`duplicate ID "${id}" in this file`);
    else seen.add(id);
    if (!name) errors.push('missing name');

    const lat = toNum(data.lat);
    const lng = toNum(data.lng);
    // Bounds are Gujarat's, generously drawn. A row outside them is nearly
    // always swapped lat/lng or a typo, and plotting it silently puts a camera
    // in the sea.
    if (lat !== null && (lat < 19.5 || lat > 25.5)) errors.push(`latitude ${lat} outside Gujarat`);
    if (lng !== null && (lng < 67.5 || lng > 75.5)) errors.push(`longitude ${lng} outside Gujarat`);
    if ((lat === null) !== (lng === null)) errors.push('needs both latitude and longitude');

    const camType = String(data.cam_type ?? '').trim().toLowerCase();
    const status = String(data.status ?? '').trim().toLowerCase();

    return {
      row: i + 2, // +2: one for the header row, one for 1-based counting
      errors,
      data: {
        id,
        name,
        department_id: String(data.department_id ?? '').trim().toLowerCase() || null,
        district: String(data.district ?? '').trim() || null,
        zone_id: String(data.zone_id ?? '').trim() || null,
        cam_type: TYPES.has(camType) ? camType : 'fixed',
        anpr_capable: toBool(data.anpr_capable) || camType === 'anpr',
        lat, lng,
        hls_url: String(data.hls_url ?? '').trim() || null,
        rtsp_url: String(data.rtsp_url ?? '').trim() || null,
        onvif_url: String(data.onvif_url ?? '').trim() || null,
        vendor: String(data.vendor ?? '').trim() || null,
        status: STATUSES.has(status) ? status : 'unknown',
        commissioned_on: toDate(data.commissioned_on),
        last_serviced_on: toDate(data.last_serviced_on),
        tags: String(data.tags ?? '')
          .split(/[,;|]/)
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      },
    };
  });
}
