import type { Route } from '@/api/types';

/**
 * Snap a traced route onto the real road network.
 *
 * Sightings are camera positions, so joining them directly draws a straight
 * line across whatever lies between — fields, the Gulf of Khambhat, a district
 * boundary. A vehicle did not travel that way, and a route that obviously did
 * not happen undermines every number shown beside it.
 *
 * Mapbox Map Matching snaps the sequence onto roads it could actually have
 * used. Two properties of this problem make matching the right tool rather
 * than plain directions:
 *
 *   - Sightings are ordered and timestamped, so the API can use the elapsed
 *     time between them to reject impossible links.
 *   - Cameras sit beside the carriageway, not on its centreline, so each point
 *     needs a search radius rather than an exact snap.
 *
 * Failure is expected and handled: cameras can be hundreds of kilometres
 * apart, and Map Matching legitimately refuses a gap it cannot bridge. The
 * caller falls back to the straight line, which is honest — it just is not
 * pretty.
 */

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN ?? '';

/** Map Matching accepts at most 100 coordinates per request. */
const MAX_POINTS = 100;

/** How far from a sighting the road may be, in metres. */
const RADIUS = 50;

export interface MatchedRoute {
  /** [lng, lat] along the road network. */
  coordinates: [number, number][];
  /** Metres, as driven — not as the crow flies. */
  distance: number;
  /** True when the road network was used; false for the straight-line fallback. */
  snapped: boolean;
}

function straightLine(route: Route): MatchedRoute {
  return {
    coordinates: route.stops.map((s) => [s.lng, s.lat] as [number, number]),
    distance: 0,
    snapped: false,
  };
}

/**
 * Consecutive sightings at the same camera add nothing to the geometry and
 * eat into the 100-coordinate budget, so collapse them.
 */
function dedupe(route: Route) {
  return route.stops.filter(
    (s, i, a) => i === 0 || s.lng !== a[i - 1].lng || s.lat !== a[i - 1].lat,
  );
}

export async function matchToRoads(route: Route | null): Promise<MatchedRoute | null> {
  if (!route || route.stops.length < 2) return null;
  if (!TOKEN) return straightLine(route);

  const stops = dedupe(route).slice(0, MAX_POINTS);
  if (stops.length < 2) return straightLine(route);

  const coords = stops.map((s) => `${s.lng},${s.lat}`).join(';');
  const radiuses = stops.map(() => RADIUS).join(';');
  // Seconds since epoch, which is what the API expects. Timestamps must be
  // strictly increasing or the request is rejected outright.
  let last = 0;
  const timestamps = stops
    .map((s) => {
      const t = Math.floor(new Date(s.timestamp).getTime() / 1000);
      last = t > last ? t : last + 1;
      return last;
    })
    .join(';');

  const url =
    `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}` +
    `?geometries=geojson&overview=full&tidy=true` +
    `&radiuses=${radiuses}&timestamps=${timestamps}&access_token=${TOKEN}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return straightLine(route);
    const json = (await res.json()) as {
      code?: string;
      matchings?: { geometry: { coordinates: [number, number][] }; distance: number }[];
    };
    const best = json.matchings?.[0];
    if (json.code !== 'Ok' || !best?.geometry?.coordinates?.length) {
      // NoMatch / NoSegment are normal when two sightings are far apart or a
      // camera sits off the routable network.
      return straightLine(route);
    }
    return {
      coordinates: best.geometry.coordinates,
      distance: best.distance,
      snapped: true,
    };
  } catch {
    return straightLine(route);
  }
}

/** Kilometres between two points, for the straight-line distance readout. */
export function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la = (a[1] * Math.PI) / 180;
  const lb = (b[1] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(la) * Math.cos(lb);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Total straight-line length of a route, in km. */
export function routeLengthKm(route: Route): number {
  let km = 0;
  for (let i = 1; i < route.stops.length; i++) {
    km += haversineKm(
      [route.stops[i - 1].lng, route.stops[i - 1].lat],
      [route.stops[i].lng, route.stops[i].lat],
    );
  }
  return km;
}
