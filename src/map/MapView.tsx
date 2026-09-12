import { useCallback, useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { INTRO_KEY, introWillPlay } from './intro';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { BASE_STYLES, useStore } from '@/app/store';
import type { GisLayer } from '@/app/store';
import type { GeoJSONFeatureCollection } from '@/api/types';
import { loadBoundaries, loadGis, loadPois, buildGapAreas } from '@/geo/loaders';
import {
  GIS_LAYER_IDS,
  LYR,
  SRC,
  ensureBoundaryLayers,
  ensureCameraLayers,
  ensureGapLayers,
  ensureGisLayers,
  ensurePoiLayers,
  restack,
  ensureRouteLayers,
  ensureZoneLayers,
  setRouteProgress,
  setVisible,
} from './layers';
import { ensureDomainIcons, ensurePoiIcons } from './icons';
import { matchToRoads } from './roadMatch';

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
const GUJARAT: [number, number] = [71.9, 22.6];
const GUJARAT_BOUNDS: [[number, number], [number, number]] = [[68.1, 20.1], [74.5, 24.7]];
/** Where the descent starts: the whole globe, India towards the middle. */
const SPACE = { center: [76.5, 18] as [number, number], zoom: 1.25 };

/* A thin atmosphere and a starfield while the map is a globe — without them
   the Earth hangs in flat black and reads as a rendering fault. */
const ATMOSPHERE = {
  color: 'rgba(140, 170, 220, 0.45)',
  'high-color': 'rgba(30, 60, 120, 0.9)',
  'horizon-blend': 0.06,
  'space-color': '#03060c',
  'star-intensity': 0.35,
} as const;

/** Narrow a queried feature to its point coordinates. */
function coordsOf(f: mapboxgl.MapboxGeoJSONFeature): [number, number] {
  return (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
}

export function MapView() {
  const ref = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const draw = useRef<MapboxDraw | null>(null);
  const pulseMarker = useRef<mapboxgl.Marker | null>(null);
  const [ready, setReady] = useState(false);
  // mapbox-gl v3's isStyleLoaded() can stay false indefinitely while sources
  // stream in, so it is useless as a gate. The style.load EVENT is reliable.
  const styleReady = useRef(false);
  // The map is constructed with the initial style. Calling setStyle() with
  // that same URL tears down every custom layer AND does not re-fire
  // style.load, so the layers never come back. Only switch on real changes.
  const appliedStyle = useRef(useStore.getState().baseStyle);
  const [styleTick, setStyleTick] = useState(0);

  const s = useStore();

  const { data: geo } = useQuery({
    queryKey: ['cameras.geojson', s.domains, s.camTypes, s.statuses, s.anprOnly, s.query],
    queryFn: () =>
      api.camerasGeoJSON({
        domains: s.domains,
        camTypes: s.camTypes,
        status: s.statuses,
        anprOnly: s.anprOnly,
        q: s.query,
      }),
  });
  const { data: zones } = useQuery({ queryKey: ['zones'], queryFn: api.zonesGeoJSON });
  const { data: cameras } = useQuery({ queryKey: ['cameras.all'], queryFn: () => api.cameras() });

  const [boundaries, setBoundaries] = useState<Awaited<ReturnType<typeof loadBoundaries>> | null>(null);
  const [pois, setPois] = useState<Awaited<ReturnType<typeof loadPois>> | null>(null);

  useEffect(() => {
    loadBoundaries().then(setBoundaries);
  }, []);
  useEffect(() => {
    loadPois(s.pois).then(setPois);
  }, [s.pois]);

  /* GIS overlays are fetched only once switched on — the road layers are
     ~2.8 MB each and would otherwise stall the map on open. */
  const [gis, setGis] = useState<Record<string, GeoJSONFeatureCollection>>({});
  useEffect(() => {
    const missing = s.gis.filter((g) => !gis[g]);
    if (!missing.length) return;
    let live = true;
    void Promise.all(missing.map(async (g) => [g, await loadGis(g)] as const)).then(
      (pairs) => live && setGis((prev) => ({ ...prev, ...Object.fromEntries(pairs) })),
    );
    return () => {
      live = false;
    };
  }, [s.gis, gis]);

  /* ── Globe descent ─────────────────────────────────────────── */
  /* While it plays the map must stay a globe; the projection effect below
     would otherwise flatten it the moment the map is ready. */
  const descending = useRef(false);
  const runDescent = useCallback(
    (m: mapboxgl.Map, to: { bounds: [[number, number], [number, number]]; delay?: number }) => {
      descending.current = true;
      m.stop();
      m.setProjection('globe');
      m.setFog(ATMOSPHERE);
      m.jumpTo({ center: SPACE.center, zoom: SPACE.zoom, pitch: 0, bearing: 0 });
      const target = m.cameraForBounds(to.bounds, { padding: 60 });
      window.setTimeout(() => {
        if (!map.current) return;
        m.flyTo({
          center: target?.center ?? GUJARAT,
          zoom: target?.zoom ?? 6.4,
          pitch: 0,
          bearing: 0,
          duration: 5200,
          curve: 1.25,
          essential: true,
        });
        m.once('moveend', () => {
          descending.current = false;
          m.setFog(null);
          m.setProjection(useStore.getState().globe ? 'globe' : 'mercator');
        });
      }, to.delay ?? 400);
    },
    [],
  );

  /* ── Init ─────────────────────────────────────────────────── */
  useEffect(() => {
    if (!ref.current || map.current || !TOKEN) return;
    mapboxgl.accessToken = TOKEN;
    // Opening the console descends from the whole globe to the state, once a
    // session: it says where this is before saying what is in it.
    const descend = introWillPlay;
    const m = new mapboxgl.Map({
      container: ref.current,
      style: BASE_STYLES[s.baseStyle].url,
      center: descend ? SPACE.center : GUJARAT,
      zoom: descend ? SPACE.zoom : 6.4,
      projection: descend ? 'globe' : undefined,
      attributionControl: false,
      logoPosition: 'bottom-left',
    });
    map.current = m;
    // Dev-only handle for debugging layers from the console.
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__SENTINEL_MAP__ = m;
    }

    m.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    m.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    const d = new MapboxDraw({
      displayControlsDefault: false,
      controls: { polygon: true, trash: true },
      defaultMode: 'simple_select',
    });
    m.addControl(d as never, 'bottom-right');
    draw.current = d;

    // Drawing an area loads exactly those cameras into the wall.
    const onDraw = async () => {
      const fc = d.getAll();
      if (!fc.features.length) return;
      const coords: number[][] = [];
      for (const f of fc.features) {
        if (f.geometry.type === 'Polygon') {
          coords.push(...(f.geometry.coordinates[0] as number[][]));
        }
      }
      if (!coords.length) return;
      const lngs = coords.map((c) => c[0]);
      const lats = coords.map((c) => c[1]);
      const bbox: [number, number, number, number] = [
        Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats),
      ];
      const found = await api.camerasWithin({ bbox });
      useStore.getState().addToWall(found.map((c) => c.id));
      d.deleteAll();
    };
    m.on('draw.create', onDraw);

    m.on('style.load', () => {
      styleReady.current = true;
      setStyleTick((t) => t + 1);
    });
    m.on('load', () => {
      if (descend) {
        try { sessionStorage.setItem(INTRO_KEY, '1'); } catch { /* ignore */ }
        runDescent(m, { bounds: GUJARAT_BOUNDS, delay: 700 });
      }
      setReady(true);
    });

    return () => {
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Style switching. Mapbox drops custom layers, so re-add them. ── */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    if (appliedStyle.current === s.baseStyle) return;
    appliedStyle.current = s.baseStyle;
    styleReady.current = false;
    m.setStyle(BASE_STYLES[s.baseStyle].url);
  }, [s.baseStyle, ready]);

  /* ── (Re)build every custom layer. ───────────────────────────
     Race-proof on purpose. `style.load` fires BEFORE `load`, and it also
     fires again after every setStyle(). Gating on a one-shot tick meant the
     very first paint could fall between the two and never retry. Instead:
     apply immediately if the style is ready, otherwise subscribe to the next
     style.load — and keep the subscription so style switches re-apply too. */
  const applyLayers = useCallback(() => {
    const m = map.current;
    if (!m || !styleReady.current) return;
    // Icons must exist before the symbol layer references them.
    void ensureDomainIcons(m);
    void ensurePoiIcons(m);
    try {

    if (boundaries) ensureBoundaryLayers(m, boundaries);
    if (zones) ensureZoneLayers(m, zones);
    if (pois) ensurePoiLayers(m, pois);
    for (const [layer, data] of Object.entries(gis)) {
      ensureGisLayers(m, layer as GisLayer, data);
    }
    if (cameras) ensureGapLayers(m, buildGapAreas(cameras));
    if (geo) ensureCameraLayers(m, geo);
    ensureRouteLayers(m);
    restack(m);

    const st = useStore.getState();
    setVisible(m, LYR.boundaryLine, st.showBoundaries);
    setVisible(m, LYR.boundaryFill, st.showBoundaries);
    setVisible(m, LYR.heat, st.showHeat);
    setVisible(m, LYR.gapsFill, st.showGaps);
    setVisible(m, LYR.poiPoint, st.pois.length > 0);
    setVisible(m, LYR.poiIcon, st.pois.length > 0);
    for (const [layer, ids] of Object.entries(GIS_LAYER_IDS)) {
      for (const id of ids) setVisible(m, id, st.gis.includes(layer as GisLayer));
    }
      setRouteProgress(m, st.trace, st.traceProgress);
    } catch (err) {
      // A style swap can land mid-apply; the next style.load re-runs this.
      console.warn('[map] layer apply deferred:', err);
    }
  }, [boundaries, zones, pois, cameras, geo, gis]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    applyLayers();
    const onStyle = () => {
      styleReady.current = true;
      applyLayers();
    };
    m.on('style.load', onStyle);
    return () => {
      m.off('style.load', onStyle);
    };
  }, [applyLayers, ready, styleTick]);

  /* ── Cheap visibility flips (no rebuild) ──────────────────── */
  useEffect(() => {
    const m = map.current;
    if (!m || !styleReady.current) return;
    setVisible(m, LYR.boundaryLine, s.showBoundaries);
    setVisible(m, LYR.boundaryFill, s.showBoundaries);
    setVisible(m, LYR.heat, s.showHeat);
    setVisible(m, LYR.gapsFill, s.showGaps);
    setVisible(m, LYR.poiPoint, s.pois.length > 0);
    setVisible(m, LYR.poiIcon, s.pois.length > 0);
    for (const [layer, ids] of Object.entries(GIS_LAYER_IDS)) {
      for (const id of ids) setVisible(m, id, s.gis.includes(layer as GisLayer));
    }
  }, [s.showBoundaries, s.showHeat, s.showGaps, s.pois, s.gis, ready, styleTick]);

  /* ── Keep the canvas the size of its container ─────────────── */
  useEffect(() => {
    const host = ref.current;
    const m = map.current;
    if (!host || !m) return;
    // Mapbox sizes its canvas once and does not watch the element. When the
    // video-wall dock opens, resizes or closes, the container changes height
    // and the canvas keeps the old one — which shows as black bands below the
    // map. A window resize listener is not enough: the dock changes this
    // element without the window changing at all.
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(host);
    return () => ro.disconnect();
  }, [ready]);

  /* ── Globe + pitch ────────────────────────────────────────── */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || descending.current) return;
    m.setProjection(s.globe ? 'globe' : 'mercator');
  }, [s.globe, ready, styleTick]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    m.easeTo({ pitch: s.pitch, duration: 400 });
  }, [s.pitch, ready]);

  /* ── Terrain on the outdoors style only ───────────────────── */
  useEffect(() => {
    const m = map.current;
    if (!m || !styleReady.current) return;
    const want = s.baseStyle === 'outdoors';
    try {
      if (want && !m.getSource('mapbox-dem')) {
        m.addSource('mapbox-dem', {
          type: 'raster-dem',
          url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
          tileSize: 512,
          maxzoom: 14,
        });
        m.setTerrain({ source: 'mapbox-dem', exaggeration: 1.4 });
      } else if (!want) {
        m.setTerrain(null);
      }
    } catch {
      /* style may still be settling; the next style.load retries */
    }
  }, [s.baseStyle, ready, styleTick]);

  /* ── Interactions ─────────────────────────────────────────── */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;

    const popup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
    });

    const onPinEnter = (e: mapboxgl.MapLayerMouseEvent) => {
      m.getCanvas().style.cursor = 'pointer';
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string>;
      popup
        .setLngLat(coordsOf(f))
        .setHTML(
          `<div style="font-family:Inter,sans-serif">
             <div style="font-weight:600;margin-bottom:3px">${p.name}</div>
             <div style="color:#92A0B5;font-size:11px">${p.district} · ${p.domain}</div>
             <div style="margin-top:5px;font-size:11px;color:#92A0B5">
               <span style="font-family:'JetBrains Mono',monospace">${p.id}</span>
               · ${p.status}${String(p.anprCapable) === 'true' ? ' · ANPR' : ''}
             </div>
           </div>`,
        )
        .addTo(m);
    };
    const onPinLeave = () => {
      m.getCanvas().style.cursor = '';
      popup.remove();
    };
    const onPinClick = (e: mapboxgl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const id = (f.properties as { id: string }).id;
      useStore.getState().selectCamera(id);
      // Offer the choice (grid / solo / details) instead of assuming one.
      useStore.getState().setPinMenu({
        cameraId: id,
        x: e.point.x + (ref.current?.getBoundingClientRect().left ?? 0),
        y: e.point.y + (ref.current?.getBoundingClientRect().top ?? 0),
      });
    };
    const onClusterClick = (e: mapboxgl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const src = m.getSource(SRC.cameras) as mapboxgl.GeoJSONSource;
      src.getClusterExpansionZoom(
        (f.properties as { cluster_id: number }).cluster_id,
        (err, zoom) => {
          if (err) return;
          m.easeTo({
            center: coordsOf(f),
            zoom: zoom ?? m.getZoom() + 2,
          });
        },
      );
    };
    const onZoneClick = (e: mapboxgl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const district = (f.properties as { district: string }).district;
      useStore.getState().selectDistrict(district);
      api.camerasWithin({ district }).then((found) => {
        useStore.getState().addToWall(found.map((c) => c.id));
      });
    };

    m.on('mouseenter', LYR.point, onPinEnter);
    m.on('mouseleave', LYR.point, onPinLeave);
    m.on('click', LYR.point, onPinClick);
    m.on('click', LYR.clusters, onClusterClick);
    m.on('click', LYR.zonesFill, onZoneClick);

    return () => {
      m.off('mouseenter', LYR.point, onPinEnter);
      m.off('mouseleave', LYR.point, onPinLeave);
      m.off('click', LYR.point, onPinClick);
      m.off('click', LYR.clusters, onClusterClick);
      m.off('click', LYR.zonesFill, onZoneClick);
      popup.remove();
    };
  }, [ready, styleTick]);

  /* ── Route animation ──────────────────────────────────────── */

  /* Match the route to the road network once, when it arrives. Doing this per
     frame of the playback slider would fire a request on every tick. */
  const [snapped, setSnapped] = useState<[number, number][] | null>(null);
  useEffect(() => {
    let live = true;
    if (!s.trace) {
      setSnapped(null);
      return;
    }
    void matchToRoads(s.trace).then((m) => {
      if (live) setSnapped(m?.snapped ? m.coordinates : null);
    });
    return () => {
      live = false;
    };
  }, [s.trace]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    setRouteProgress(m, s.trace, s.traceProgress, snapped);
  }, [s.trace, s.traceProgress, snapped, ready, styleTick]);

  useEffect(() => {
    if (!s.trace || !map.current || !s.trace.stops.length) return;
    const b = new mapboxgl.LngLatBounds();
    s.trace.stops.forEach((st) => b.extend([st.lng, st.lat]));
    // The trace panel is open on the right when a route is drawn; frame the
    // route in the map left visible beside it, not under it.
    const mapRect = map.current.getContainer().getBoundingClientRect();
    const panel = document.querySelector('[data-tour="panel"]')?.getBoundingClientRect();
    const cover = panel ? Math.max(0, mapRect.right - panel.left) : 0;
    map.current.fitBounds(b, {
      padding: { top: 120, bottom: 120, left: 120, right: 120 + cover },
      duration: 1400,
      maxZoom: 11,
    });
  }, [s.trace]);

  /* ── Walkthrough camera ───────────────────────────────────── */
  /* The tour narrates places, so it has to be able to look at them. Without
     this every step describing a district or a route plays out on whatever
     view the operator happened to leave behind. */
  useEffect(() => {
    const m = map.current;
    const v = s.tourView;
    if (!m || !ready || !v) return;
    if (v.intro && v.bounds) {
      runDescent(m, { bounds: v.bounds });
      return;
    }
    // Centre the subject in the part of the map that is visible. Padding is
    // even on every side — an offset for the caption made the subject look
    // off-centre — except where an open side panel covers the map.
    const mapRect = m.getContainer().getBoundingClientRect();
    const panel = document.querySelector('[data-tour="panel"]')?.getBoundingClientRect();
    const panelCover = panel ? Math.max(0, mapRect.right - panel.left) : 0;
    const padding = { top: 60, bottom: 60, left: 60, right: 60 + panelCover };
    if (padding.left + padding.right > mapRect.width - 160) padding.right = Math.max(60, mapRect.width - 220);

    const target = v.bounds
      ? m.cameraForBounds(v.bounds, { padding })
      : v.lng != null && v.lat != null ? { center: [v.lng, v.lat] as [number, number], zoom: v.zoom } : null;
    if (!target) return;

    // flyTo rather than a straight ease: between distant places it pulls
    // back and swoops in, which is what makes a jump from Ahmedabad to Surat
    // read as travel rather than a cut. Speed, not a fixed duration, so a
    // short hop is quick and a long one takes the time it needs.
    m.flyTo({
      center: target.center,
      zoom: target.zoom ?? m.getZoom(),
      pitch: v.pitch ?? 0,
      bearing: v.bearing ?? 0,
      padding,
      speed: 0.85,
      curve: 1.55,
      maxDuration: 4200,
      essential: true,
    });

    // A held view turns slowly, so a city being described stays alive
    // instead of freezing under the caption.
    if (!v.orbit) return;
    const orbit = () => m.easeTo({
      bearing: m.getBearing() + 16,
      duration: 9000,
      easing: (t) => t,
      essential: true,
    });
    m.once('moveend', orbit);
    return () => { m.off('moveend', orbit); };
  }, [s.tourView, ready, runDescent]);

  /* ── Alert focus: fly in and pulse the pin ────────────────── */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !s.focusCameraId || !cameras) return;
    const cam = cameras.find((c) => c.id === s.focusCameraId);
    if (!cam) return;

    m.flyTo({ center: [cam.lng, cam.lat], zoom: Math.max(m.getZoom(), 11), duration: 1200 });

    pulseMarker.current?.remove();
    const el = document.createElement('div');
    el.className = 'alert-pulse';
    pulseMarker.current = new mapboxgl.Marker({ element: el })
      .setLngLat([cam.lng, cam.lat])
      .addTo(m);

    const t = setTimeout(() => {
      pulseMarker.current?.remove();
      pulseMarker.current = null;
      useStore.getState().setFocusCamera(null);
    }, 6000);
    return () => clearTimeout(t);
  }, [s.focusCameraId, cameras, ready]);

  if (!TOKEN) {
    return (
      <div
        className="flex h-full items-center justify-center p-8"
        style={{ paddingRight: "calc(2rem + var(--panel-inset, 0px))" }}
      >
        <div className="max-w-md text-center">
          <div className="display mb-2 text-[15px]" style={{ color: 'var(--text)' }}>
            Mapbox token missing
          </div>
          <p className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
            Add <code className="mono">VITE_MAPBOX_TOKEN</code> to{' '}
            <code className="mono">.env</code> and restart the dev server. Everything
            else runs on mock data without a backend.
          </p>
        </div>
      </div>
    );
  }

  return <div ref={ref} data-tour="map" className="h-full w-full" />;
}
