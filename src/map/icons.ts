/**
 * Per-domain map icons from Maki (Mapbox's open-source set, CC0).
 *
 * Distinct glyphs read far faster than same-shaped dots in different colours —
 * an operator can tell a traffic camera from a hospital one at a glance, even
 * on satellite imagery where hue contrast is poor.
 *
 * Loaded from the installed package at build time and registered with the map
 * as tinted images, so they survive a base-style switch like any other layer.
 */

import type * as mapboxgl from 'mapbox-gl';
import type { Domain } from '@/api/types';
import { DOMAIN_COLOR } from '@/api/types';

// Vite inlines these as raw SVG strings.
import trafficSvg from '@mapbox/maki/icons/roadblock.svg?raw';
import hospitalSvg from '@mapbox/maki/icons/hospital.svg?raw';
import pdsSvg from '@mapbox/maki/icons/warehouse.svg?raw';
import rtoSvg from '@mapbox/maki/icons/car.svg?raw';
import publicSvg from '@mapbox/maki/icons/police.svg?raw';

export const DOMAIN_ICON: Record<Domain, string> = {
  traffic: 'sent-traffic',
  hospital: 'sent-hospital',
  pds: 'sent-pds',
  rto: 'sent-rto',
  public: 'sent-public',
};

const SVG: Record<Domain, string> = {
  traffic: trafficSvg,
  hospital: hospitalSvg,
  pds: pdsSvg,
  rto: rtoSvg,
  public: publicSvg,
};

const SIZE = 48; // rendered at 3x for crisp retina pins

/** Draw one Maki glyph on a dark disc so it stays legible over satellite. */
function render(svg: string, colour: string): Promise<HTMLCanvasElement> {
  // Maki ships monochrome paths; recolour via a fill on the root <svg>.
  const tinted = svg
    .replace('<svg', `<svg fill="${colour}"`)
    .replace(/width="\d+"/, `width="${SIZE}"`)
    .replace(/height="\d+"/, `height="${SIZE}"`);

  const blob = new Blob([tinted], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = SIZE;
      c.height = SIZE;
      const ctx = c.getContext('2d')!;

      // Disc backing + coloured ring, then the glyph on top.
      const r = SIZE / 2;
      ctx.beginPath();
      ctx.arc(r, r, r - 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(11,18,32,0.92)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = colour;
      ctx.stroke();

      const inset = SIZE * 0.26;
      ctx.drawImage(img, inset, inset, SIZE - inset * 2, SIZE - inset * 2);

      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

/** Register every domain icon. Safe to call again after a style change. */
export async function ensureDomainIcons(map: mapboxgl.Map): Promise<void> {
  await Promise.all(
    (Object.keys(SVG) as Domain[]).map(async (domain) => {
      const id = DOMAIN_ICON[domain];
      if (map.hasImage(id)) return;
      try {
        const canvas = await render(SVG[domain], DOMAIN_COLOR[domain]);
        if (map.hasImage(id)) return;
        map.addImage(id, canvas.getContext('2d')!.getImageData(0, 0, SIZE, SIZE), {
          pixelRatio: 3,
        });
      } catch {
        /* a missing glyph must not stop the rest of the map loading */
      }
    }),
  );
}
