/**
 * Frontend data contract. Mocks and the live API must both satisfy these
 * exactly — that is what makes VITE_USE_MOCKS a single-flag switch.
 */

export type Domain = 'traffic' | 'hospital' | 'pds' | 'rto' | 'public';
export type CameraStatus = 'online' | 'offline' | 'degraded';
export type CamType = 'ptz' | 'fixed' | 'dome' | 'bullet';

export interface Camera {
  id: string;
  name: string;
  department: string;
  domain: Domain;
  tags: string[];
  camType: CamType;
  anprCapable: boolean;
  /** Browser-playable HLS manifest. */
  streamUrl: string;
  status: CameraStatus;
  lat: number;
  lng: number;
  district: string;
  zoneId: string;

  /* ── Real technical metadata from the host (null until it has probed) ── */
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  bitsPerPixel: number | null;
  codec: string | null;
  container: string;
  rtspUrl: string;
  webrtcUrl: string;
  anprGrade: 'good' | 'fair' | 'poor' | 'unknown';
  /** False when the host reports a location we have no coordinates for. */
  geoKnown: boolean;
}

export type VehicleType = 'car' | 'bike' | 'auto' | 'truck' | 'bus';

export interface Detection {
  id: string;
  cameraId: string;
  plate: string;
  vehicleType: VehicleType;
  colour: string;
  /** 0..1 */
  confidence: number;
  /** ISO 8601 */
  timestamp: string;
  snapshotUrl: string;
}

export type WatchlistCategory = 'stolen' | 'wanted' | 'missing' | 'suspect';

export interface WatchlistItem {
  id: string;
  category: WatchlistCategory;
  plate: string;
  personName: string | null;
  active: boolean;
  notes?: string;
}

export type AlertStatus = 'new' | 'ack';

export interface Alert {
  id: string;
  detectionId: string;
  watchlistId: string;
  cameraId: string;
  timestamp: string;
  category: WatchlistCategory;
  status: AlertStatus;
  snapshotUrl: string;
  /** Denormalised for display so the alert card needs no extra fetch. */
  plate: string;
  cameraName: string;
}

export interface RouteStop {
  cameraId: string;
  cameraName: string;
  lat: number;
  lng: number;
  timestamp: string;
  snapshotUrl: string;
  district: string;
}

export interface Route {
  plate: string;
  stops: RouteStop[];
}

export type Role = 'state-admin' | 'district-officer' | 'department-viewer';

export interface User {
  id: string;
  name: string;
  role: Role;
  /** Empty = unrestricted. Otherwise scopes visible cameras. */
  zoneIds: string[];
  departments: Domain[];
}

export interface HealthSummary {
  online: number;
  offline: number;
  degraded: number;
  total: number;
  anprCapable: number;
}

export interface CameraQuery {
  domains?: Domain[];
  status?: CameraStatus[];
  q?: string;
  anprOnly?: boolean;
}

export interface DetectionQuery {
  plate?: string;
  cameraId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/** GeoJSON aliases — kept loose so any boundary/POI source drops straight in. */
export type GeoJSONFeatureCollection = {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
};

export type GeoJSONFeature = {
  type: 'Feature';
  id?: string | number;
  properties: Record<string, unknown>;
  geometry: {
    type: string;
    coordinates: unknown;
  };
};

export const DOMAIN_LABEL: Record<Domain, string> = {
  traffic: 'Traffic',
  hospital: 'Health',
  pds: 'PDS / Supply',
  rto: 'RTO',
  public: 'Public safety',
};

export const DOMAIN_COLOR: Record<Domain, string> = {
  traffic: '#38BDF8',
  hospital: '#F472B6',
  pds: '#A78BFA',
  rto: '#FBBF24',
  public: '#34D399',
};

export const STATUS_COLOR: Record<CameraStatus, string> = {
  online: '#22C55E',
  degraded: '#F5A524',
  offline: '#EF4444',
};

export const CATEGORY_COLOR: Record<WatchlistCategory, string> = {
  stolen: '#EF4444',
  wanted: '#EF4444',
  missing: '#F5A524',
  suspect: '#F5A524',
};
