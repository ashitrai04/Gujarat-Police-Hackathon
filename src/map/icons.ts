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

// Vite resolves these to hashed URLs at build time.
import trafficPng from '@/assets/markers/traffic-lights.png';
import hospitalPng from '@/assets/markers/hospital.png';
import pdsPng from '@/assets/markers/PDS.png';
import rtoPng from '@/assets/markers/rto.png';
import publicPng from '@/assets/markers/safety.png';

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
