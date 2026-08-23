/**
 * GeoJSON loaders for boundary + reference layers.
 *
 * Files live in public/geo and are fetched once, then cached in-module. If a
 * file is missing the app degrades quietly to an empty layer rather than
 * throwing — a missing POI overlay must never take the console down.
 */

import type { Camera, GeoJSONFeatureCollection } from '@/api/types';
import type { GisLayer, PoiLayer } from '@/app/store';

const EMPTY: GeoJSONFeatureCollection = { type: 'FeatureCollection', features: [] };
const cache = new Map<string, GeoJSONFeatureCollection>();

async function loadOnce(path: string): Promise<GeoJSONFeatureCollection> {
  const hit = cache.get(path);
  if (hit) return hit;
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(String(res.status));
    const json = (await res.json()) as GeoJSONFeatureCollection;
    cache.set(path, json);
    return json;
  } catch {
    console.warn(`[geo] ${path} unavailable — layer will render empty.`);
    cache.set(path, EMPTY);
    return EMPTY;
  }
}

/** Gujarat district boundaries (2011 census districts, via udit-001/india-maps-data). */
export const loadBoundaries = () => loadOnce('/geo/gujarat-districts.geojson');

/**
 * Gujarat GIS layers, converted from the supplied GeoPackage.
 *
 * Loaded on demand rather than up front: the road layers are ~2.8 MB each, and
 * fetching them before anyone asks would stall the map on open for a layer most
 * sessions never turn on.
 */
export const loadGis = (layer: GisLayer) => loadOnce(`/geo/gj-${layer}.geojson`);

/** Merge the selected OSM POI kinds into one collection. */
export async function loadPois(kinds: PoiLayer[]): Promise<GeoJSONFeatureCollection> {
  if (!kinds.length) return EMPTY;
  const parts = await Promise.all(kinds.map((k) => loadOnce(`/geo/poi-${k}.geojson`)));
  return {
    type: 'FeatureCollection',
    features: parts.flatMap((p) => p.features),
  };
}

/**
 * Coverage gaps, derived rather than authored: grid Gujarat and shade any cell
 * with no camera within ~35km. Crude, but it is honest about what it measures
 * and needs no extra data source.
 */
export function buildGapAreas(cameras: Camera[]): GeoJSONFeatureCollection {
  const W = 68.2, E = 74.5, S = 20.1, N = 24.8;
  const step = 0.55;
  const R = 0.42; // ~45km in degrees, generous
  const features: GeoJSONFeatureCollection['features'] = [];

  for (let lng = W; lng < E; lng += step) {
    for (let lat = S; lat < N; lat += step) {
      const cx = lng + step / 2;
      const cy = lat + step / 2;
      const covered = cameras.some(
        (c) => Math.abs(c.lng - cx) < R && Math.abs(c.lat - cy) < R,
      );
      if (covered) continue;
      features.push({
        type: 'Feature',
        properties: { kind: 'gap' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [lng, lat],
              [lng + step, lat],
              [lng + step, lat + step],
              [lng, lat + step],
              [lng, lat],
            ],
          ],
        },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
