/**
 * The vehicle itself, moving along the route it was traced on.
 *
 * A route that draws itself as a growing line tells an operator where a
 * vehicle went. A marker travelling that line tells them how it went — which
 * way it turned, where it slowed, how long the gap between two junctions was.
 * That is the difference between a map of a journey and a replay of one, and
 * it is the form every delivery app has trained people to read.
 *
 * Two things make the motion look right rather than merely animated:
 *
 *   - Position is interpolated by DISTANCE along the polyline, not by vertex
 *     index. Map-matched geometry has vertices bunched at junctions and spread
 *     along straights, so stepping per vertex makes the marker crawl through
 *     corners and leap down open road.
 *   - The marker is rotated to its direction of travel, from the segment it is
 *     currently on. An arrow that does not turn reads as a dot being dragged.
 */

import type * as mapboxgl from 'mapbox-gl';

export const VEHICLE_ICON = 'sentinel-vehicle';
export const SRC_VEHICLE = 'sentinel-vehicle';
export const LYR_VEHICLE_HALO = 'vehicle-halo';
export const LYR_VEHICLE = 'vehicle-mark';

type LngLat = [number, number];

export interface Along {
  at: LngLat;
  /** Degrees clockwise from north, for `icon-rotate`. */
  bearing: number;
  /** The polyline up to `at`, for drawing the travelled part. */
  travelled: LngLat[];
}

/** Metres-ish between two coordinates. Flat-earth, which at city scale it is. */
function span(a: LngLat, b: LngLat): number {
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const dx = (b[0] - a[0]) * k;
  const dy = b[1] - a[1];
  return Math.hypot(dx, dy);
}

/**
 * The point a given fraction of the way along a polyline, by distance.
 *
 * Returns the travelled prefix too, so the line and the marker are guaranteed
 * to agree: computing them separately is how a marker ends up floating a few
 * pixels off the end of its own trail.
 */
export function pointAlong(line: LngLat[], fraction: number): Along | null {
  if (!line || line.length === 0) return null;
  if (line.length === 1) return { at: line[0], bearing: 0, travelled: [line[0]] };

  const f = Math.min(1, Math.max(0, fraction));
  const legs: number[] = [];
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const d = span(line[i - 1], line[i]);
    legs.push(d);
    total += d;
  }
  if (total === 0) return { at: line[0], bearing: 0, travelled: [line[0]] };

  let want = total * f;
  for (let i = 0; i < legs.length; i++) {
    if (want > legs[i] && i < legs.length - 1) {
      want -= legs[i];
      continue;
    }
    const a = line[i];
    const b = line[i + 1];
    const t = legs[i] > 0 ? Math.min(1, want / legs[i]) : 1;
    const at: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const k = Math.cos((a[1] * Math.PI) / 180);
    const bearing = (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI;
    return { at, bearing, travelled: [...line.slice(0, i + 1), at] };
  }
  const last = line[line.length - 1];
  return { at: last, bearing: 0, travelled: [...line] };
}

/**
 * A chevron in a disc, drawn once into a canvas.
 *
 * Generated rather than shipped as artwork because it has to be rotated by
 * `icon-rotate` and read against dark tarmac, satellite imagery and a pale
 * street style alike — so it carries its own dark outline instead of relying
 * on the map underneath for contrast.
 */
export function ensureVehicleIcon(map: mapboxgl.Map): void {
  if (map.hasImage(VEHICLE_ICON)) return;
  const S = 64;
  const dpr = 2;
  const c = document.createElement('canvas');
  c.width = S * dpr;
  c.height = S * dpr;
  const g = c.getContext('2d');
  if (!g) return;
  g.scale(dpr, dpr);
  const mid = S / 2;

  g.beginPath();
  g.arc(mid, mid, 15, 0, Math.PI * 2);
  g.fillStyle = 'rgba(11,18,32,0.92)';
  g.fill();
  g.lineWidth = 2.5;
  g.strokeStyle = '#2DD4BF';
  g.stroke();

  // Chevron pointing to the top of the image; icon-rotate turns it to bearing.
  g.beginPath();
  g.moveTo(mid, mid - 8.5);
  g.lineTo(mid + 6.5, mid + 7);
  g.lineTo(mid, mid + 3.2);
  g.lineTo(mid - 6.5, mid + 7);
  g.closePath();
  g.fillStyle = '#2DD4BF';
  g.fill();

  map.addImage(VEHICLE_ICON, {
    width: S * dpr,
    height: S * dpr,
    data: g.getImageData(0, 0, S * dpr, S * dpr).data,
  } as never, { pixelRatio: dpr });
}

export function ensureVehicleLayer(map: mapboxgl.Map): void {
  ensureVehicleIcon(map);
  if (!map.getSource(SRC_VEHICLE)) {
    map.addSource(SRC_VEHICLE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] } as never,
    });
  }
  if (!map.getLayer(LYR_VEHICLE_HALO)) {
    map.addLayer({
      id: LYR_VEHICLE_HALO,
      type: 'circle',
      source: SRC_VEHICLE,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 10, 14, 22],
        'circle-color': '#2DD4BF',
        'circle-opacity': 0.16,
        'circle-blur': 0.6,
      },
    });
  }
  if (!map.getLayer(LYR_VEHICLE)) {
    map.addLayer({
      id: LYR_VEHICLE,
      type: 'symbol',
      source: SRC_VEHICLE,
      layout: {
        'icon-image': VEHICLE_ICON,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.42, 14, 0.62],
        'icon-rotate': ['get', 'bearing'],
        // The marker is the thing being followed: it must never be dropped
        // for want of space, and it must not collide anything else away.
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-rotation-alignment': 'map',
      },
    });
  }
}

export function setVehicle(map: mapboxgl.Map, at: LngLat | null, bearing = 0): void {
  const src = map.getSource(SRC_VEHICLE) as mapboxgl.GeoJSONSource | undefined;
  if (!src || !('setData' in src)) return;
  src.setData({
    type: 'FeatureCollection',
    features: at
      ? [{
          type: 'Feature',
          properties: { bearing },
          geometry: { type: 'Point', coordinates: at },
        }]
      : [],
  } as never);
}
