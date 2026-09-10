import { useEffect, useRef } from 'react';
import type { FrameResult, VehicleClass } from './protocol';

const CLASS_COLOUR: Record<VehicleClass, string> = {
  car: '#2DD4BF',
  motorcycle: '#FBBF24',
  bus: '#E879F9',
  truck: '#FB923C',
};
const WATCH = '#F87171';
const SETTLING = '#FBBF24';
const STABLE = '#2DD4BF';

/** Boxes older than this are cleared rather than left over a moved-on picture. */
const STALE_MS = 2500;

/**
 * The detector's output drawn over the playing video, model-plot style.
 *
 * The video element uses object-fit: cover, so the picture is scaled to fill
 * and cropped at the edges. The boxes go through the same transform — a box
 * placed in frame pixels without it lands beside its vehicle rather than on it.
 */
export function DetectionCanvas({
  result,
  watch,
}: {
  result: FrameResult | null;
  /** Plate → watchlist category, for vehicles that must stand out. */
  watch: Map<string, string>;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawnAt = useRef(0);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.max(1, Math.round(rect.width));
      const ch = Math.max(1, Math.round(rect.height));
      if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
        canvas.width = cw * dpr;
        canvas.height = ch * dpr;
      }
      const g = canvas.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, cw, ch);
      if (!result) return;
      drawnAt.current = performance.now();

      const { w, h } = result.frame;
      const s = Math.max(cw / w, ch / h);
      const ox = (cw - w * s) / 2;
      const oy = (ch - h * s) / 2;
      const X = (x: number) => ox + x * s;
      const Y = (y: number) => oy + y * s;
      const small = cw < 520;

      for (const t of result.tracks) {
        const hit = t.plate?.stable && t.plate.text ? watch.get(t.plate.text) : undefined;
        const colour = hit ? WATCH : CLASS_COLOUR[t.cls];
        const x1 = X(t.box[0]), y1 = Y(t.box[1]), x2 = X(t.box[2]), y2 = Y(t.box[3]);

        g.lineWidth = hit ? 3 : 2;
        g.strokeStyle = colour;
        g.strokeRect(x1, y1, x2 - x1, y2 - y1);

        chip(g, `${t.cls} ${Math.round(t.score * 100)}%`, x1, y1, colour, '#04201C', small ? 9 : 10.5, cw, 'above');

        if (t.plate && !t.plate.text) {
          // A plate is there, but nothing is claimed about what it says.
          const p = t.plate;
          g.lineWidth = 1;
          g.strokeStyle = 'rgba(231,236,243,0.7)';
          g.setLineDash([3, 3]);
          g.strokeRect(X(p.box[0]), Y(p.box[1]), X(p.box[2]) - X(p.box[0]), Y(p.box[3]) - Y(p.box[1]));
          g.setLineDash([]);
          chip(g, p.note === 'too small' ? 'plate · too small to read' : 'plate · reading…',
            x1, y2, 'rgba(6,11,20,0.85)', '#92A0B5', small ? 9 : 10, cw, 'below');
        } else if (t.plate && t.plate.text) {
          const p = t.plate;
          const px1 = X(p.box[0]), py1 = Y(p.box[1]), px2 = X(p.box[2]), py2 = Y(p.box[3]);
          const tone = hit ? WATCH : p.stable ? STABLE : SETTLING;
          g.lineWidth = 1.5;
          g.strokeStyle = tone;
          g.setLineDash(p.stable ? [] : [4, 3]);
          g.strokeRect(px1, py1, px2 - px1, py2 - py1);
          g.setLineDash([]);

          const label = hit
            ? `${hit.toUpperCase()} · ${p.text}`
            : `${p.text}${p.stable ? '' : ' ?'}  ×${p.reads}`;
          chip(g, label, x1, y2, 'rgba(6,11,20,0.9)', tone, small ? 10.5 : 12.5, cw, 'below', true);
        }
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    // Clear boxes that are no longer describing the picture.
    const t = setInterval(() => {
      if (result && performance.now() - drawnAt.current > STALE_MS) {
        const g = canvas.getContext('2d');
        g?.clearRect(0, 0, canvas.width, canvas.height);
      }
    }, 500);
    return () => { ro.disconnect(); clearInterval(t); };
  }, [result, watch]);

  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />;
}

/** A filled label at a box corner, kept inside the canvas. */
function chip(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  bg: string,
  fg: string,
  size: number,
  maxW: number,
  where: 'above' | 'below',
  mono = false,
) {
  g.font = `${mono ? 700 : 600} ${size}px ${mono ? '"JetBrains Mono", ui-monospace, monospace' : 'Inter, system-ui, sans-serif'}`;
  const padX = 5;
  const hgt = size + 6;
  const wid = g.measureText(text).width + padX * 2;
  const cx = Math.min(Math.max(0, x), maxW - wid);
  const cy = where === 'above' ? Math.max(0, y - hgt) : y;
  g.fillStyle = bg;
  g.fillRect(cx, cy, wid, hgt);
  if (mono) {
    g.strokeStyle = fg;
    g.lineWidth = 1;
    g.strokeRect(cx + 0.5, cy + 0.5, wid - 1, hgt - 1);
  }
  g.fillStyle = fg;
  g.textBaseline = 'middle';
  g.fillText(text, cx + padX, cy + hgt / 2 + 0.5);
}
