/**
 * Layer managers.
 *
 * Mapbox drops every custom source and layer on setStyle(). So all layer
 * creation lives here as idempotent `ensure*` functions, and MapView re-runs
 * the whole set on every `style.load`. Never add a layer inline in a component.
 */

import type * as mapboxgl from 'mapbox-gl';
import type { GeoJSONFeatureCollection, Route } from '@/api/types';

import { DOMAIN_ICON } from './icons';

export const SRC = {
  cameras: 'sentinel-cameras',
  zones: 'sentinel-zones',
  boundaries: 'sentinel-boundaries',
  poi: 'sentinel-poi',
  route: 'sentinel-route',
  routeStops: 'sentinel-route-stops',
  gaps: 'sentinel-gaps',
  gisState: 'sentinel-gis-state',
  gisDistricts: 'sentinel-gis-districts',
  gisHighways: 'sentinel-gis-highways',
  gisRoads: 'sentinel-gis-roads',
} as const;

export const LYR = {
  clusters: 'cam-clusters',
  clusterCount: 'cam-cluster-count',
  point: 'cam-point',
  pointRing: 'cam-point-ring',
  heat: 'cam-heat',
  zonesFill: 'zones-fill',
  zonesLine: 'zones-line',
  boundaryLine: 'boundary-line',
  boundaryFill: 'boundary-fill',
  poiPoint: 'poi-point',
  routeLine: 'route-line',
  routeGlow: 'route-glow',
  routeStops: 'route-stops',
  routeStopLabels: 'route-stop-labels',
  gapsFill: 'gaps-fill',
  gisStateGlow: 'gis-state-glow',
  gisStateLine: 'gis-state-line',
  gisDistrictLine: 'gis-district-line',
  gisDistrictFill: 'gis-district-fill',
  gisHighwayGlow: 'gis-highway-glow',
  gisHighwayLine: 'gis-highway-line',
  gisHighwayLabel: 'gis-highway-label',
  gisRoadLine: 'gis-road-line',
} as const;

const EMPTY: GeoJSONFeatureCollection = { type: 'FeatureCollection', features: [] };

function setData(map: mapboxgl.Map, id: string, data: unknown) {
  const src = map.getSource(id) as mapboxgl.GeoJSONSource | undefined;
  if (src && 'setData' in src) src.setData(data as never);
}

/* ── Cameras: clustered, domain-coloured, status-aware ───────────── */
export function ensureCameraLayers(map: mapboxgl.Map, data: GeoJSONFeatureCollection) {
  if (!map.getSource(SRC.cameras)) {
    map.addSource(SRC.cameras, {
      type: 'geojson',
      data: data as never,
      cluster: true,
      clusterRadius: 46,
      clusterMaxZoom: 11,
    });
  } else {
    setData(map, SRC.cameras, data);
  }

  if (!map.getLayer(LYR.heat)) {
    map.addLayer({
      id: LYR.heat,
      type: 'heatmap',
      source: SRC.cameras,
      layout: { visibility: 'none' },
      paint: {
        'heatmap-weight': ['coalesce', ['get', 'detectionWeight'], 0.6],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 12, 2.4],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 5, 18, 12, 48],
        'heatmap-opacity': 0.75,
        'heatmap-color': [
          'interpolate',
          ['linear'],
          ['heatmap-density'],
          0, 'rgba(11,18,32,0)',
          0.2, 'rgba(45,212,191,0.30)',
          0.45, 'rgba(56,189,248,0.55)',
          0.7, 'rgba(245,165,36,0.75)',
          1, 'rgba(239,68,68,0.92)',
        ],
      },
    });
  }

  if (!map.getLayer(LYR.clusters)) {
    map.addLayer({
      id: LYR.clusters,
      type: 'circle',
      source: SRC.cameras,
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#131C2B',
        'circle-stroke-color': '#2DD4BF',
        'circle-stroke-width': 1.5,
        'circle-opacity': 0.92,
        'circle-radius': [
          'step', ['get', 'point_count'], 15, 5, 19, 15, 24, 30, 30,
        ],
      },
    });
    map.addLayer({
      id: LYR.clusterCount,
      type: 'symbol',
      source: SRC.cameras,
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
        'text-size': 11,
      },
      paint: { 'text-color': '#E7ECF3' },
    });
  }

  if (!map.getLayer(LYR.pointRing)) {
    // The pin artwork carries the department; this dot sits at the pin's tip
    // and carries status. A ring would read as detached now that the symbol is
    // bottom-anchored — the coordinate is under the pin, not behind it.
    map.addLayer({
      id: LYR.pointRing,
      type: 'circle',
      source: SRC.cameras,
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3, 12, 4.5],
        'circle-color': [
          'match', ['get', 'status'],
          'online', '#22C55E',
          'degraded', '#F5A524',
          'offline', '#EF4444',
          '#64748B',
        ],
        'circle-stroke-width': 1.5,
        'circle-stroke-color': 'rgba(6,11,20,0.85)',
      },
    });
    // Distinct pin artwork per department — far quicker to read than
    // identically-shaped dots in different colours.
    map.addLayer({
      id: LYR.point,
      type: 'symbol',
      source: SRC.cameras,
      filter: ['!', ['has', 'point_count']],
      layout: {
        'icon-image': [
          'match', ['get', 'domain'],
          'traffic', DOMAIN_ICON.traffic,
          'hospital', DOMAIN_ICON.hospital,
          'pds', DOMAIN_ICON.pds,
          'rto', DOMAIN_ICON.rto,
          'public', DOMAIN_ICON.public,
          DOMAIN_ICON.public,
        ],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.42, 12, 0.72],
        // The artwork is a teardrop, so the tip — not the centre — is the
        // camera's actual position.
        'icon-anchor': 'bottom',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
  }
}

/* ── District zones ──────────────────────────────────────────────── */
export function ensureZoneLayers(map: mapboxgl.Map, data: GeoJSONFeatureCollection) {
  if (!map.getSource(SRC.zones)) {
    map.addSource(SRC.zones, { type: 'geojson', data: data as never });
  } else {
    setData(map, SRC.zones, data);
  }
  if (!map.getLayer(LYR.zonesFill)) {
    map.addLayer(
      {
        id: LYR.zonesFill,
        type: 'fill',
        source: SRC.zones,
        paint: { 'fill-color': '#2DD4BF', 'fill-opacity': 0.04 },
      },
      map.getLayer(LYR.heat) ? LYR.heat : undefined,
    );
    map.addLayer(
      {
        id: LYR.zonesLine,
        type: 'line',
        source: SRC.zones,
        paint: {
          'line-color': '#2A3A50',
          'line-width': 1,
          'line-dasharray': [2, 2],
        },
      },
      map.getLayer(LYR.heat) ? LYR.heat : undefined,
    );
  }
}

/* ── Administrative boundaries (real GeoJSON from public/geo) ────── */
export function ensureBoundaryLayers(map: mapboxgl.Map, data: GeoJSONFeatureCollection) {
  if (!map.getSource(SRC.boundaries)) {
    map.addSource(SRC.boundaries, { type: 'geojson', data: data as never });
  } else {
    setData(map, SRC.boundaries, data);
  }
  if (!map.getLayer(LYR.boundaryFill)) {
    map.addLayer({
      id: LYR.boundaryFill,
      type: 'fill',
      source: SRC.boundaries,
      paint: { 'fill-color': '#38BDF8', 'fill-opacity': 0.03 },
    });
    map.addLayer({
      id: LYR.boundaryLine,
      type: 'line',
      source: SRC.boundaries,
      paint: { 'line-color': '#38BDF8', 'line-width': 0.9, 'line-opacity': 0.42 },
    });
  }
}

/* ── OSM reference POIs ──────────────────────────────────────────── */
export function ensurePoiLayers(map: mapboxgl.Map, data: GeoJSONFeatureCollection) {
  if (!map.getSource(SRC.poi)) {
    map.addSource(SRC.poi, { type: 'geojson', data: data as never });
  } else {
    setData(map, SRC.poi, data);
  }
  if (!map.getLayer(LYR.poiPoint)) {
    map.addLayer({
      id: LYR.poiPoint,
      type: 'circle',
      source: SRC.poi,
      paint: {
        'circle-radius': 3.2,
        'circle-color': [
          'match', ['get', 'kind'],
          'hospital', '#F472B6',
          'police', '#38BDF8',
          'fuel', '#FBBF24',
          'bus_station', '#A78BFA',
          '#64748B',
        ],
        'circle-opacity': 0.55,
        'circle-stroke-width': 0.6,
        'circle-stroke-color': 'rgba(11,18,32,0.9)',
      },
    });
  }
}

/* ── Vehicle route ───────────────────────────────────────────────── */
export function ensureRouteLayers(map: mapboxgl.Map) {
  if (!map.getSource(SRC.route)) {
    map.addSource(SRC.route, { type: 'geojson', data: EMPTY as never });
  }
  if (!map.getSource(SRC.routeStops)) {
    map.addSource(SRC.routeStops, { type: 'geojson', data: EMPTY as never });
  }
  if (!map.getLayer(LYR.routeGlow)) {
    // The one deliberate aesthetic risk: the traced route glows.
    map.addLayer({
      id: LYR.routeGlow,
      type: 'line',
      source: SRC.route,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#2DD4BF',
        'line-width': 11,
        'line-opacity': 0.16,
        'line-blur': 9,
      },
    });
    map.addLayer({
      id: LYR.routeLine,
      type: 'line',
      source: SRC.route,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#2DD4BF', 'line-width': 2.4 },
    });
    map.addLayer({
      id: LYR.routeStops,
      type: 'circle',
      source: SRC.routeStops,
      paint: {
        'circle-radius': 6,
        'circle-color': '#0B1220',
        'circle-stroke-width': 2.2,
        'circle-stroke-color': '#2DD4BF',
      },
    });
    map.addLayer({
      id: LYR.routeStopLabels,
      type: 'symbol',
      source: SRC.routeStops,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
        'text-size': 10,
        'text-offset': [0, 1.4],
        'text-anchor': 'top',
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': '#E7ECF3',
        'text-halo-color': '#0B1220',
        'text-halo-width': 1.4,
      },
    });
  }
}

/** Draw the route up to `progress` (0..1) so it can animate. */
export function setRouteProgress(map: mapboxgl.Map, route: Route | null, progress: number) {
  if (!map.getSource(SRC.route)) return;
  if (!route || route.stops.length < 1) {
    setData(map, SRC.route, EMPTY);
    setData(map, SRC.routeStops, EMPTY);
    return;
  }
  const n = Math.max(1, Math.round(route.stops.length * Math.min(1, Math.max(0, progress))));
  const shown = route.stops.slice(0, n);
  setData(map, SRC.route, {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: shown.map((s) => [s.lng, s.lat]),
        },
      },
    ],
  });
  setData(map, SRC.routeStops, {
    type: 'FeatureCollection',
    features: shown.map((s, i: number) => ({
      type: 'Feature',
      properties: {
        label: `${i + 1}. ${new Date(s.timestamp).toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
        })}`,
        cameraId: s.cameraId,
        cameraName: s.cameraName,
        timestamp: s.timestamp,
      },
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
    })),
  });
}

/* ── Coverage gaps (bonus) ───────────────────────────────────────── */
export function ensureGapLayers(map: mapboxgl.Map, data: GeoJSONFeatureCollection) {
  if (!map.getSource(SRC.gaps)) {
    map.addSource(SRC.gaps, { type: 'geojson', data: data as never });
  } else {
    setData(map, SRC.gaps, data);
  }
  if (!map.getLayer(LYR.gapsFill)) {
    map.addLayer({
      id: LYR.gapsFill,
      type: 'fill',
      source: SRC.gaps,
      layout: { visibility: 'none' },
      paint: {
        'fill-color': '#EF4444',
        'fill-opacity': 0.10,
        'fill-outline-color': 'rgba(239,68,68,0.4)',
      },
    });
  }
}

export function setVisible(map: mapboxgl.Map, layerId: string, visible: boolean) {
  if (map.getLayer(layerId)) {
    map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
  }
}

/* ── Gujarat GIS overlays (supplied GeoPackage) ───────────────────── */

/**
 * Route-tracing reference layers. These sit *under* the camera pins and the
 * ANPR route line — they are the board a route is drawn on, not the subject —
 * so every one of them is inserted beneath the camera cluster layer.
 *
 * Colours are deliberately loud: this is an overlay an operator switches on to
 * read a vehicle's path across the state, and a muted line disappears against
 * satellite imagery.
 */
export function ensureGisLayers(
  map: mapboxgl.Map,
  layer: 'state' | 'districts' | 'highways' | 'roads',
  data: GeoJSONFeatureCollection,
) {
  const below = map.getLayer(LYR.clusters) ? LYR.clusters : undefined;

  if (layer === 'state') {
    if (!map.getSource(SRC.gisState)) {
      map.addSource(SRC.gisState, { type: 'geojson', data: data as never });
    } else {
      setData(map, SRC.gisState, data);
    }
    if (!map.getLayer(LYR.gisStateLine)) {
      // Electric lime, not red: the districts are neon magenta and a red state
      // line sat close enough in hue that the two edges read as one layer.
      map.addLayer({
        id: LYR.gisStateGlow,
        type: 'line',
        source: SRC.gisState,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#CCFF00',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 7, 10, 14],
          'line-opacity': 0.3,
          'line-blur': 6,
        },
      }, below);
      map.addLayer({
        id: LYR.gisStateLine,
        type: 'line',
        source: SRC.gisState,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#CCFF00',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.8, 10, 3.4],
          'line-opacity': 1,
        },
      }, below);
    }
    return;
  }

  if (layer === 'districts') {
    if (!map.getSource(SRC.gisDistricts)) {
      map.addSource(SRC.gisDistricts, { type: 'geojson', data: data as never });
    } else {
      setData(map, SRC.gisDistricts, data);
    }
    if (!map.getLayer(LYR.gisDistrictFill)) {
      map.addLayer({
        id: LYR.gisDistrictFill,
        type: 'fill',
        source: SRC.gisDistricts,
        // `active_feed` comes from the supplied data: districts that actually
        // have a camera on them are worth picking out from the rest.
        paint: {
          'fill-color': ['case', ['>', ['get', 'active_feed'], 0], '#FF4FD8', '#C026D3'],
          'fill-opacity': ['case', ['>', ['get', 'active_feed'], 0], 0.18, 0.06],
        },
      }, below);
      map.addLayer({
        id: LYR.gisDistrictLine,
        type: 'line',
        source: SRC.gisDistricts,
        paint: {
          'line-color': '#FF6FE0',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 10, 1.9],
          'line-opacity': 0.9,
        },
      }, below);
    }
    return;
  }

  if (layer === 'highways') {
    if (!map.getSource(SRC.gisHighways)) {
      map.addSource(SRC.gisHighways, { type: 'geojson', data: data as never });
    } else {
      setData(map, SRC.gisHighways, data);
    }
    if (!map.getLayer(LYR.gisHighwayLine)) {
      // Glow underneath keeps the line readable over bright terrain.
      map.addLayer({
        id: LYR.gisHighwayGlow,
        type: 'line',
        source: SRC.gisHighways,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#F97316',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3.5, 12, 9],
          'line-opacity': 0.22,
          'line-blur': 3,
        },
      }, below);
      map.addLayer({
        id: LYR.gisHighwayLine,
        type: 'line',
        source: SRC.gisHighways,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#FB923C',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.9, 12, 3.2],
          'line-opacity': 0.95,
        },
      }, below);
      map.addLayer({
        id: LYR.gisHighwayLabel,
        type: 'symbol',
        source: SRC.gisHighways,
        minzoom: 8,
        filter: ['has', 'ref'],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'ref'],
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
          'text-size': 10,
        },
        paint: {
          'text-color': '#FFEDD5',
          'text-halo-color': '#1A0F05',
          'text-halo-width': 1.4,
        },
      }, below);
    }
    return;
  }

  if (!map.getSource(SRC.gisRoads)) {
    map.addSource(SRC.gisRoads, { type: 'geojson', data: data as never });
  } else {
    setData(map, SRC.gisRoads, data);
  }
  if (!map.getLayer(LYR.gisRoadLine)) {
    map.addLayer({
      id: LYR.gisRoadLine,
      type: 'line',
      source: SRC.gisRoads,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#22D3EE',
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 12, 1.8],
        'line-opacity': 0.7,
      },
    }, below);
  }
}

/** Layer ids belonging to each GIS overlay, for visibility toggling. */
export const GIS_LAYER_IDS: Record<string, string[]> = {
  state: [LYR.gisStateGlow, LYR.gisStateLine],
  districts: [LYR.gisDistrictFill, LYR.gisDistrictLine],
  highways: [LYR.gisHighwayGlow, LYR.gisHighwayLine, LYR.gisHighwayLabel],
  roads: [LYR.gisRoadLine],
};
