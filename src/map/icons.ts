/**
 * Per-domain map markers.
 *
 * These are supplied pin artwork — a teardrop with the department's glyph
 * inside — rather than a glyph on a generated disc. Because the artwork is
 * already pin-shaped, the symbol layer anchors it at the bottom so the point
 * of the pin sits on the camera's coordinate instead of the image centre.
 *
 * Distinct shapes read far faster than same-shaped dots in different colours:
 * an operator can tell a traffic camera from a hospital one at a glance, even
 * over satellite imagery where hue contrast is poor.
 */

import type * as mapboxgl from 'mapbox-gl';
import type { Domain } from '@/api/types';
import type { PoiLayer } from '@/app/store';

// Vite resolves these to hashed URLs at build time.
import trafficPng from '@/assets/markers/traffic-lights.png';
import hospitalPng from '@/assets/markers/hospital.png';
import pdsPng from '@/assets/markers/PDS.png';
import rtoPng from '@/assets/markers/rto.png';
import publicPng from '@/assets/markers/safety.png';
import poiHospitalPng from '@/assets/pois/hospital.png';
import poiPolicePng from '@/assets/pois/police.png';
import poiFuelPng from '@/assets/pois/fuel.png';
import poiBusPng from '@/assets/pois/bus_station.png';
import poiTollPng from '@/assets/pois/toll.png';
import poiRailwayPng from '@/assets/pois/railway.png';

export const DOMAIN_ICON: Record<Domain, string> = {
  traffic: 'sent-traffic',
  hospital: 'sent-hospital',
  pds: 'sent-pds',
  rto: 'sent-rto',
  public: 'sent-public',
};

/**
 * The same artwork the map uses, exported so the legend can show the exact
 * pin an operator will be looking for rather than an approximation of it.
 */
export const DOMAIN_MARKER_SRC: Record<Domain, string> = {
  traffic: trafficPng,
  hospital: hospitalPng,
  pds: pdsPng,
  rto: rtoPng,
  public: publicPng,
};

const SRC = DOMAIN_MARKER_SRC;

/*
 * Reference facilities — hospitals, police, fuel, bus, toll, rail. Square
 * artwork rather than pins, since these are context rather than assets the
 * operator controls, and the difference in shape keeps a camera from being
 * mistaken for a police station at a glance.
 */
export const POI_ICON: Record<PoiLayer, string> = {
  hospital: 'poi-hospital',
  police: 'poi-police',
  fuel: 'poi-fuel',
  bus_station: 'poi-bus',
  toll: 'poi-toll',
  railway: 'poi-railway',
};

/** The same artwork, for the legend beside each reference-layer toggle. */
export const POI_MARKER_SRC: Record<PoiLayer, string> = {
  hospital: poiHospitalPng,
  police: poiPolicePng,
  fuel: poiFuelPng,
  bus_station: poiBusPng,
  toll: poiTollPng,
  railway: poiRailwayPng,
};

/**
 * The layer a point belongs to, from the `kind` its source file gives it.
 * The files carry OpenStreetMap's own terms — a railway point is a
 * "station", a toll point a "toll_booth" — which is why styling keyed on the
 * layer names alone drew those two as anonymous grey dots.
 */
export const POI_KIND_TO_LAYER: Record<string, PoiLayer> = {
  hospital: 'hospital',
  police: 'police',
  fuel: 'fuel',
  bus_station: 'bus_station',
  toll_booth: 'toll',
  toll: 'toll',
  station: 'railway',
  railway: 'railway',
};

/**
 * Artwork is 512px square. Registering it at that size would burn texture
 * memory for no gain, so it is drawn down to 128px and registered at
 * pixelRatio 2 — a 64px logical marker that still has retina detail.
 */
const TEX = 128;
const PIXEL_RATIO = 2;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

async function render(url: string): Promise<ImageData> {
  const img = await loadImage(url);
  const c = document.createElement('canvas');
  c.width = TEX;
  c.height = TEX;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';

  // A soft drop shadow keeps the pin readable against bright satellite tiles.
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  ctx.drawImage(img, 4, 2, TEX - 8, TEX - 8);

  return ctx.getImageData(0, 0, TEX, TEX);
}

/** Register every domain marker. Safe to call again after a style change. */
export async function ensureDomainIcons(map: mapboxgl.Map): Promise<void> {
  await Promise.all(
    (Object.keys(SRC) as Domain[]).map(async (domain) => {
      const id = DOMAIN_ICON[domain];
      if (map.hasImage(id)) return;
      try {
        const data = await render(SRC[domain]);
        // The style may have swapped while the PNG was decoding.
        if (map.hasImage(id)) return;
        map.addImage(id, data, { pixelRatio: PIXEL_RATIO });
      } catch {
        /* a missing marker must not stop the rest of the map loading */
      }
    }),
  );
}

/** Register every reference-facility icon. Safe to call again after a style change. */
export async function ensurePoiIcons(map: mapboxgl.Map): Promise<void> {
  await Promise.all(
    (Object.keys(POI_MARKER_SRC) as PoiLayer[]).map(async (layer) => {
      const id = POI_ICON[layer];
      if (map.hasImage(id)) return;
      try {
        const data = await render(POI_MARKER_SRC[layer]);
        if (map.hasImage(id)) return;
        map.addImage(id, data, { pixelRatio: PIXEL_RATIO });
      } catch {
        /* the dot beneath still marks the facility */
      }
    }),
  );
}
