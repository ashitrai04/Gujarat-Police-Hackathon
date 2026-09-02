import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Grid2x2, Grid3x3,
  LayoutGrid, LayoutTemplate, ListPlus, Maximize2, Minimize2, Plus, Square, X,
} from 'lucide-react';
import { api } from '@/api/client';
import { useStore } from '@/app/store';
import { Button, Empty, Pill } from '@/components/ui';
import { CameraPlayer } from '@/components/CameraPlayer';
import { useStreamHealth } from '@/api/useStreamHealth';
import { byAvailability } from '@/api/health';
import type { Camera } from '@/api/types';

const LAYOUTS = [
  { n: 0 as const, icon: LayoutTemplate, cols: 0, rows: 0, label: 'Auto — fill' },
  { n: 1 as const, icon: Square, cols: 1, rows: 1, label: '1 up' },
  { n: 4 as const, icon: Grid2x2, cols: 2, rows: 2, label: '4 up' },
  { n: 9 as const, icon: Grid3x3, cols: 3, rows: 3, label: '9 up' },
  { n: 16 as const, icon: LayoutGrid, cols: 4, rows: 4, label: '16 up' },
];

/**
 * Best column count for `count` tiles in a box of `aspect` (w/h), judged by the
 * resulting tile area — so the grid fills the space instead of leaving a band
 * of empty cells at the bottom.
 */
function autoGrid(count: number, boxW: number, boxH: number) {
  if (count <= 0) return { cols: 1, rows: 1 };
  let best = { cols: 1, rows: count, score: -1 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const tw = (boxW - (cols - 1) * GAP) / cols;
    const th = (boxH - (rows - 1) * GAP) / rows;
    if (tw <= 0 || th <= 0) continue;
    // Prefer tiles near 16:9 and grids that waste few cells.
    const fit = Math.min(tw / th / (16 / 9), th / tw * (16 / 9));
    const waste = cols * rows - count;
    const score = tw * th * fit * (1 - waste * 0.06);
    if (score > best.score) best = { cols, rows, score };
  }
  return { cols: best.cols, rows: best.rows };
}



const GAP = 6;
const PAD = 12;
const TOOLBAR = 40;

export function VideoWall() {
  const {
    wallCameraIds, wallLayout, dockOpen, dockH, wallFullscreen,
    setWallLayout, setDockOpen, setDockH, clearWall, toggleWallFullscreen,
    setPickerOpen,
  } = useStore();
  const { data: cams } = useQuery({ queryKey: ['cameras.all'], queryFn: () => api.cameras() });
  const [page, setPage] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setBox({ w: e.contentRect.width, h: e.contentRect.height }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [dockOpen, wallFullscreen]);

  const { data: health } = useStreamHealth();

  // Cameras that are actually serving come first, so page 1 of the wall is
  // never a screen of dead tiles.
  const tiles = useMemo(
    () =>
      wallCameraIds
        .map((id) => cams?.find((c) => c.id === id))
        .filter((c): c is Camera => !!c)
        .sort(byAvailability(health)),
    [wallCameraIds, cams, health],
  );

  /* ── Drag the top edge to resize ────────────────────────────── */
  const dragging = useRef(false);
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return;
      // Height measured from the pointer to the bottom of the window.
      setDockH(window.innerHeight - e.clientY);
    };
    const up = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [setDockH]);

  // Size the dock so a full page of tiles lands near 16:9.
  useEffect(() => {
    if (!dockOpen || wallFullscreen) return;   // fullscreen uses the viewport
    const l = LAYOUTS.find((x) => x.n === wallLayout);
    if (!l) return;
    const railW = document.querySelector('aside')?.getBoundingClientRect().width ?? 264;
    const usableW = window.innerWidth - railW - PAD;
    const tileW = (usableW - (l.cols - 1) * GAP) / l.cols;
    const wanted = Math.round(
      TOOLBAR + PAD + (l.rows * tileW * 9) / 16 + (l.rows - 1) * GAP,
    );
    setDockH(Math.min(wanted, Math.round(window.innerHeight * 0.7)));
  }, [wallLayout, dockOpen, wallFullscreen, setDockH]);

  if (!dockOpen) return null;

  const layout = LAYOUTS.find((l) => l.n === wallLayout) ?? LAYOUTS[0];
  const isAuto = layout.n === 0;

  // Auto: every feed on one page, grid shaped to fill the box exactly.
  const auto = isAuto ? autoGrid(tiles.length, box.w || 1, box.h || 1) : null;
  const cols = auto ? auto.cols : layout.cols;
  const rows = auto ? auto.rows : layout.rows;
  const perPage = isAuto ? Math.max(1, tiles.length) : layout.n;
  const pageCount = Math.max(1, Math.ceil(tiles.length / perPage));
  const safePage = Math.min(page, pageCount - 1);
  const pageTiles = tiles.slice(safePage * perPage, safePage * perPage + perPage);
  // Every cell is the same size. A short final row is padded with empty
  // "add camera" slots rather than stretching a tile across the gap.
  const emptySlots = Math.max(0, cols * rows - pageTiles.length);
  // Each row takes an equal share of the grid's (definite) height, so the
  // chosen layout fills the dock exactly and any extra feeds scroll below.


  return (
    <section
      className={
        wallFullscreen
          ? 'fixed z-[70] flex flex-col overflow-hidden'
          : 'relative z-20 flex shrink-0 flex-col'
      }
      style={
        wallFullscreen
          ? {
              // inset on all four sides sizes to the initial containing block,
              // which EXCLUDES the scrollbar. `width: 100vw` INCLUDES it, so it
              // made the section wider than the visible area and pushed the
              // toolbar's right-hand controls off screen.
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              width: 'auto',
              height: 'auto',
              background: 'var(--surface)',
            }
          : {
              height: `${dockH}px`,
              background: 'var(--surface)',
              borderTop: '1px solid var(--line)',
            }
      }
    >
      {/* Resize handle */}
      {!wallFullscreen && (
        <div
          onMouseDown={onDragStart}
          title="Drag to resize"
          className="group absolute inset-x-0 -top-[3px] z-10 flex h-[7px] cursor-ns-resize items-center justify-center"
        >
          <span
            className="h-[3px] w-[46px] rounded-full transition-colors group-hover:brightness-150"
            style={{ background: 'var(--line)' }}
          />
        </div>
      )}

      {/* Toolbar — doubles as the nav bar in full-screen wall mode */}
      <div
        className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1"
        style={{
          minHeight: wallFullscreen ? 'var(--bar-h)' : '40px',
          borderBottom: '1px solid var(--line)',
          background: wallFullscreen ? 'var(--surface)' : 'transparent',
        }}
      >
        {wallFullscreen && (
          <>
            <button
              onClick={toggleWallFullscreen}
              className="flex items-center gap-1.5 rounded-[6px] px-2 py-1.5 text-[12px] hover:bg-[var(--surface-2)]"
              style={{ color: 'var(--text-dim)', border: '1px solid var(--line)' }}
            >
              <ArrowLeft size={13} /> Back to map
            </button>
            <img src="/yi.png" alt="" className="ml-1 h-[22px] w-[22px] rounded-[5px]" />
          </>
        )}
        <span className="panel-title">{wallFullscreen ? 'Camera grid' : 'Video wall'}</span>
        <Pill mono colour="var(--signal)">{tiles.length}</Pill>

        <div className="ml-1 flex gap-0.5">
          {LAYOUTS.map((l) => (
            <button
              key={l.n}
              onClick={() => setWallLayout(l.n)}
              title={l.label}
              className="rounded-[5px] p-1.5 transition-colors"
              style={{
                background: wallLayout === l.n ? 'var(--signal-dim)' : 'transparent',
                color: wallLayout === l.n ? 'var(--signal)' : 'var(--text-mute)',
              }}
            >
              <l.icon size={13} />
            </button>
          ))}
        </div>

        <div className="flex-1" />

        <Button onClick={() => setPickerOpen(true)}>
          <ListPlus size={12} /> Add cameras
        </Button>
        {pageCount > 1 && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              className="rounded-[5px] p-1.5 disabled:opacity-30 hover:bg-[var(--surface-2)]"
              style={{ color: 'var(--text-dim)' }}
              aria-label="Previous page"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="mono text-[11px] tabular-nums" style={{ color: 'var(--text-dim)' }}>
              {safePage + 1}/{pageCount}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={safePage >= pageCount - 1}
              className="rounded-[5px] p-1.5 disabled:opacity-30 hover:bg-[var(--surface-2)]"
              style={{ color: 'var(--text-dim)' }}
              aria-label="Next page"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        )}
        {tiles.length > 0 && <Button onClick={clearWall}>Clear</Button>}
        <button
          onClick={toggleWallFullscreen}
          title={wallFullscreen ? 'Exit full screen' : 'Full screen wall'}
          className="rounded-[5px] p-1.5 hover:bg-[var(--surface-2)]"
          style={{ color: wallFullscreen ? 'var(--signal)' : 'var(--text-dim)' }}
        >
          {wallFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        {!wallFullscreen && (
          <button
            onClick={() => setDockOpen(false)}
            className="rounded-[5px] p-1 hover:bg-[var(--surface-2)]"
            style={{ color: 'var(--text-dim)' }}
            aria-label="Hide video wall"
          >
            <ChevronDown size={15} />
          </button>
        )}
      </div>

      {!tiles.length ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <Empty>No feeds on the wall yet.</Empty>
          <Button variant="primary" onClick={() => setPickerOpen(true)}>
            <ListPlus size={13} /> Select cameras
          </Button>
        </div>
      ) : (
        <div
          ref={gridRef}
          className="grid min-h-0 w-full flex-1 overflow-hidden"
          style={{
            // Explicit rows AND columns, both 1fr: every tile is exactly the
            // same size. Extra feeds go to the next page rather than deforming
            // the grid or scrolling out of sight.
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
            gap: `${GAP}px`,
            padding: `${PAD / 2}px`,
          }}
        >
          {pageTiles.map((c, i) => (
            // Stagger starts: the host drops sessions when many HLS players
            // connect at once, which showed up as permanently black tiles.
            <Tile key={c.id} camera={c} startDelayMs={i * 700} route={health?.[c.id]?.route} />
          ))}
          {Array.from({ length: emptySlots }, (_, i) => (
            <EmptySlot key={`slot-${i}`} onAdd={() => setPickerOpen(true)} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Placeholder for an unused grid position — keeps every cell the same size. */
function EmptySlot({ onAdd }: { onAdd: () => void }) {
  return (
    <button
      onClick={onAdd}
      className="group flex h-full w-full min-h-0 flex-col items-center justify-center gap-1.5 rounded-[6px] transition-colors"
      style={{ background: 'rgba(255,255,255,0.015)', border: '1px dashed var(--line)' }}
    >
      <Plus size={18} style={{ color: 'var(--text-mute)' }} className="transition-colors group-hover:text-[var(--signal)]" />
      <span className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>Add camera</span>
    </button>
  );
}

function Tile({
  camera,
  startDelayMs = 0,
  route,
}: {
  camera: Camera;
  startDelayMs?: number;
  route?: 'hls' | null;
}) {
  const removeFromWall = useStore((s) => s.removeFromWall);
  const selectCamera = useStore((s) => s.selectCamera);
  const openPanel = useStore((s) => s.openPanel);
  const setFocusCamera = useStore((s) => s.setFocusCamera);
  const toggleFullscreen = useStore((s) => s.toggleWallFullscreen);

  const { data: latest } = useQuery({
    queryKey: ['detections', camera.id, 'latest'],
    queryFn: () => api.detections({ cameraId: camera.id, limit: 1 }),
    refetchInterval: 10000,
    enabled: camera.anprCapable,
  });
  const plate = latest?.[0]?.plate;

  return (
    <div className="group relative h-full w-full min-h-0">
      <CameraPlayer
        camera={camera}
        className="h-full w-full"
        startDelayMs={startDelayMs}
        route={route}
      />

      {camera.anprCapable && (
        <span
          className="mono pointer-events-none absolute right-1.5 top-1.5 rounded-[3px] px-1 text-[8.5px] font-bold"
          style={{ background: 'var(--signal)', color: '#04201C' }}
        >
          ANPR
        </span>
      )}

      {plate && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2 py-1.5">
          <span className="mono text-[12px] font-semibold" style={{ color: 'var(--signal)' }}>
            {plate}
          </span>
        </div>
      )}

      <div className="absolute bottom-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={() => {
            // The map is behind the full-screen grid, so drop out of it first —
            // otherwise "Locate" looked like it did nothing.
            if (useStore.getState().wallFullscreen) toggleFullscreen();
            setFocusCamera(camera.id);
          }}
          title="Show this camera on the map"
          className="rounded-[4px] px-1.5 py-0.5 text-[9px]"
          style={{ background: 'rgba(11,18,32,0.88)', color: 'var(--text-dim)' }}
        >
          Locate
        </button>
        <button
          onClick={() => {
            if (useStore.getState().wallFullscreen) toggleFullscreen();
            selectCamera(camera.id);
            openPanel({ kind: 'camera', cameraId: camera.id });
          }}
          title="Open camera details"
          className="rounded-[4px] px-1.5 py-0.5 text-[9px]"
          style={{ background: 'rgba(11,18,32,0.88)', color: 'var(--text-dim)' }}
        >
          Detail
        </button>
        <button
          onClick={() => removeFromWall(camera.id)}
          className="rounded-[4px] p-1"
          style={{ background: 'rgba(11,18,32,0.88)', color: 'var(--text-dim)' }}
          aria-label={`Remove ${camera.name}`}
        >
          <X size={11} />
        </button>
      </div>
    </div>
  );
}
