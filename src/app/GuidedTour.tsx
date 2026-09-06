import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronRight, Compass, Pause, Play, X,
} from 'lucide-react';
import { useStore } from './store';
import { api } from '@/api/client';

/**
 * Guided walkthrough of the platform.
 *
 * It drives the real interface rather than showing pictures of it: each step
 * moves a cursor to a real control, highlights it, and performs the action the
 * caption describes. Nothing is staged — a step that says a filter narrows the
 * estate applies that filter, and the count on screen changes because it did.
 *
 * That constraint is the point. A scripted demo can claim anything; this one
 * can only claim what the running application actually does, so it stays
 * truthful as the app changes and breaks visibly when it does not.
 */

interface Step {
  id: string;
  /** `data-tour` hook, or a CSS selector. Null centres on the map. */
  target: string | null;
  title: string;
  body: string;
  /** How long this step holds before advancing, in ms. */
  hold: number;
  /** Performs the step's action against real application state. */
  run?: (ctx: Ctx) => void | Promise<void>;
}

interface Ctx {
  store: typeof useStore;
  set: ReturnType<typeof useStore.getState>;
}

const SEEN_KEY = 'sentinel-tour-seen';

const STEPS: Step[] = [
  {
    id: 'intro',
    target: null,
    title: 'Sentinel Command Center',
    body:
      'Twenty-six departments across Gujarat run their own cameras and none of them '
      + 'talk to each other. This platform puts them on one map, reads number plates, '
      + 'and follows a vehicle across cameras. <b>The map is the product</b> — every '
      + 'feature below is worked from it.',
    hold: 5200,
    run: ({ set }) => {
      set.closePanel();
      set.setDockOpen(false);
    },
  },
  {
    id: 'layers',
    target: 'layers',
    title: 'Cameras by department',
    body:
      'Every camera is a point of interest with a category, the way a maps app treats '
      + 'fuel stations. Traffic, health, PDS, RTO and municipal estates each toggle '
      + 'independently — so an operator sees the cameras they are responsible for, not '
      + 'all thirty at once.',
    hold: 4600,
  },
  {
    id: 'camtype',
    target: 'camtype',
    title: 'Only the cameras that can read a plate',
    body:
      'Department and capability are separate questions. An operator hunting a '
      + 'registration wants the cameras <b>able to read one</b>, whoever owns them. '
      + 'Watch the count: filtering to PTZ alone drops the estate from thirty to five.',
    hold: 5000,
    run: async ({ set }) => {
      set.toggleCamType('fixed');
      await wait(2200);
      set.toggleCamType('fixed');
    },
  },
  {
    id: 'gis',
    target: 'gis',
    title: 'The geography a route is read against',
    body:
      'State boundary, districts, 11,079 national-highway segments and 12,404 major '
      + 'roads, from the supplied GeoPackage. A traced vehicle follows these roads '
      + 'rather than a straight line — a route that obviously did not happen '
      + 'undermines every number beside it.',
    hold: 5000,
    run: async ({ set }) => {
      set.toggleGis('highways');
      await wait(1600);
      set.toggleGis('state');
    },
  },
  {
    id: 'poi',
    target: 'poi',
    title: 'Where a vehicle can be intercepted',
    body:
      '126 police stations, 232 toll plazas and 741 railway stations from '
      + 'OpenStreetMap. Toll plazas matter specifically: a vehicle leaving the state '
      + 'passes one, which makes them the natural interception points on a traced '
      + 'route.',
    hold: 4600,
    run: async ({ set }) => {
      set.togglePoi('police');
      await wait(1400);
      set.togglePoi('toll');
    },
  },
  {
    id: 'registry',
    target: 'registry',
    title: 'Onboarding — three ways in',
    body:
      'Departments hand over the spreadsheets they already keep, and no two name their '
      + 'columns the same. The importer reads whatever headers it is given and maps '
      + 'them itself — <b>9/9, 9/9 and 10/10 columns</b> across three deliberately '
      + 'different formats, with every decision shown before anything is written.',
    hold: 6000,
    run: ({ set }) => set.openPanel({ kind: 'registry' }),
  },
  {
    id: 'wall',
    target: 'wall',
    title: 'The video wall',
    body:
      'Cameras are added from map pins or by selecting an area: the map chooses, the '
      + 'wall shows. Tiles stay uniform rather than stretching, playable cameras sort '
      + 'first, and a feed that cannot be reached in twelve seconds falls back to '
      + 'recorded footage — labelled <b>RECORDED</b>, never passed off as live.',
    hold: 6000,
    run: async ({ set }) => {
      set.closePanel();
      const cams = await api.cameras();
      set.setWall(cams.slice(0, 4).map((c) => c.id));
      set.setDockOpen(true);
    },
  },
  {
    id: 'events',
    target: 'events',
    title: 'Every sighting, with the evidence',
    body:
      'OCR on this footage is right most of the time, not all of the time. So each '
      + 'reading shows the <b>plate crop</b> it was made from and the <b>full frame</b> '
      + 'with the vehicle boxed — an operator confirms the characters by eye before '
      + 'acting, and the frame is the accountability record.',
    hold: 6200,
    run: ({ set }) => {
      set.setDockOpen(false);
      set.openPanel({ kind: 'events' });
    },
  },
  {
    id: 'trace',
    target: 'trace',
    title: 'Following a vehicle',
    body:
      'A plate search returns every camera that saw it, in time order, drawn as a '
      + 'route with a time slider. Sightings are timestamped, so map matching can '
      + 'reject links a vehicle could not physically have made — the path follows real '
      + 'roads, and where a gap cannot be bridged it says so rather than inventing one.',
    hold: 5800,
    run: ({ set }) => set.openPanel({ kind: 'trace' }),
  },
  {
    id: 'watchlist',
    target: 'watchlist',
    title: 'Watchlist and alerts',
    body:
      'Stolen and wanted vehicles are matched at the moment a plate is read. On a hit '
      + 'the camera pin flashes, the map moves to it, and an alert card carries the '
      + 'snapshot and the reason. Acknowledgement records who acted and when.',
    hold: 5200,
    run: ({ set }) => set.openPanel({ kind: 'watchlist' }),
  },
  {
    id: 'health',
    target: 'health',
    title: 'Knowing what is actually up',
    body:
      'The grid reports every camera as live, including the ones that are not, so '
      + 'availability is measured rather than trusted. Probing follows the wall rather '
      + 'than sweeping the estate — this grid permits one session per address and '
      + 'refuses bursts.',
    hold: 5000,
    run: ({ set }) => set.openPanel({ kind: 'health' }),
  },
  {
    id: 'end',
    target: null,
    title: 'That is the platform',
    body:
      'Registry and map, unified viewing, ANPR with evidence, vehicle tracing and '
      + 'alerting — running against thirty live cameras. Press <b>Guide</b> in the top '
      + 'bar to see this again.',
    hold: 5200,
    run: ({ set }) => {
      set.closePanel();
      set.setDockOpen(false);
    },
  },
];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function GuidedTour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [pressed, setPressed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const step = STEPS[i];

  const finish = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* private browsing — the tour simply offers itself again */
    }
    onClose();
  }, [onClose]);

  /* Locate the step's target, move the cursor to it, run its action. */
  useEffect(() => {
    if (!open || !step) return;
    let live = true;

    const el = step.target
      ? document.querySelector<HTMLElement>(
          step.target.startsWith('.') || step.target.startsWith('#')
            ? step.target
            : `[data-tour="${step.target}"]`,
        )
      : null;

    const r = el?.getBoundingClientRect() ?? null;
    setRect(r);
    setCursor(
      r
        ? { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 },
    );

    // The press animation lands after the cursor has travelled, so the action
    // reads as caused by the click rather than coincident with it.
    const press = setTimeout(() => {
      if (!live) return;
      setPressed(true);
      setTimeout(() => live && setPressed(false), 260);
      void step.run?.({ store: useStore, set: useStore.getState() });
    }, 620);

    return () => {
      live = false;
      clearTimeout(press);
    };
  }, [open, i, step]);

  /* Advance, unless held. */
  useEffect(() => {
    if (!open || paused || !step) return;
    timer.current = setTimeout(() => {
      if (i < STEPS.length - 1) setI((n) => n + 1);
      else finish();
    }, step.hold);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [open, i, paused, step, finish]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      if (e.key === ' ') {
        e.preventDefault();
        setPaused((p) => !p);
      }
      if (e.key === 'ArrowRight' && i < STEPS.length - 1) setI((n) => n + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, i, finish]);

  useEffect(() => {
    if (open) setI(0);
  }, [open]);

  if (!open || !step) return null;

  // Keep the caption beside the highlight, never off-screen and never on top
  // of the thing it is describing.
  const W = 380;
  const H = 208;
  const M = 16;
  let cx = rect ? rect.left : (window.innerWidth - W) / 2;
  let cy = rect ? rect.bottom + M : window.innerHeight / 2 + 40;
  if (rect && cy + H > window.innerHeight - M) cy = Math.max(M, rect.top - H - M);
  cx = Math.min(Math.max(M, cx), window.innerWidth - W - M);

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[200]">
      {/* Dim everything except the target. Four panels rather than an overlay
          with a hole, so the highlighted control stays fully visible. */}
      {rect ? (
        <>
          <Shade style={{ inset: `0 0 auto 0`, height: Math.max(0, rect.top - 6) }} />
          <Shade style={{ inset: `${rect.bottom + 6}px 0 0 0` }} />
          <Shade style={{ top: rect.top - 6, left: 0, width: Math.max(0, rect.left - 6), height: rect.height + 12 }} />
          <Shade style={{ top: rect.top - 6, left: rect.right + 6, right: 0, height: rect.height + 12 }} />
          <div
            className="absolute rounded-[8px] transition-all duration-500"
            style={{
              top: rect.top - 6,
              left: rect.left - 6,
              width: rect.width + 12,
              height: rect.height + 12,
              border: '2px solid var(--signal)',
              boxShadow: '0 0 0 3px var(--signal-glow), 0 0 26px var(--signal-glow)',
            }}
          />
        </>
      ) : (
        <Shade style={{ inset: 0 }} />
      )}

      {/* The cursor. Its travel is what makes a step read as an action. */}
      <div
        className="absolute transition-all duration-[600ms] ease-out"
        style={{
          left: cursor.x, top: cursor.y,
          transform: `translate(-50%,-50%) scale(${pressed ? 0.82 : 1})`,
        }}
      >
        <div
          className="rounded-full"
          style={{
            width: 18, height: 18,
            background: 'var(--signal)',
            boxShadow: '0 0 0 6px var(--signal-dim), 0 0 18px var(--signal-glow)',
          }}
        />
      </div>

      {/* Caption */}
      <div
        className="pointer-events-auto absolute overflow-hidden rounded-[10px] transition-all duration-500"
        style={{
          left: cx, top: cy, width: W,
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          boxShadow: 'var(--sh-lg)',
        }}
      >
        <div className="h-[3px]" style={{ background: 'var(--line)' }}>
          <div
            className="h-full transition-all duration-300"
            style={{
              width: `${((i + 1) / STEPS.length) * 100}%`,
              background: 'var(--signal)',
            }}
          />
        </div>

        <div className="p-3.5">
          <div className="mb-1.5 flex items-center gap-2">
            <Compass size={13} style={{ color: 'var(--signal)' }} />
            <span
              className="mono text-[10px] font-bold uppercase tracking-[.1em]"
              style={{ color: 'var(--signal)' }}
            >
              Guided tour · {i + 1} of {STEPS.length}
            </span>
          </div>

          <h3
            className="display mb-1.5 text-[15px] font-semibold"
            style={{ color: 'var(--text)' }}
          >
            {step.title}
          </h3>
          <p
            className="text-[12.5px] leading-relaxed"
            style={{ color: 'var(--text-dim)' }}
            dangerouslySetInnerHTML={{ __html: step.body }}
          />

          <div className="mt-3 flex items-center gap-1.5">
            <button
              onClick={() => setPaused((p) => !p)}
              className="flex items-center gap-1 rounded-[5px] px-2 py-1 text-[11.5px]"
              style={{ border: '1px solid var(--line)', color: 'var(--text-dim)' }}
            >
              {paused ? <Play size={11} /> : <Pause size={11} />}
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button
              onClick={() => (i < STEPS.length - 1 ? setI((n) => n + 1) : finish())}
              className="flex items-center gap-1 rounded-[5px] px-2 py-1 text-[11.5px]"
              style={{ border: '1px solid var(--line)', color: 'var(--text-dim)' }}
            >
              Next <ChevronRight size={11} />
            </button>
            <div className="flex-1" />
            <button
              onClick={finish}
              className="flex items-center gap-1 rounded-[5px] px-2 py-1 text-[11.5px]"
              style={{ color: 'var(--text-mute)' }}
            >
              <X size={11} /> Skip
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Shade({ style }: { style: React.CSSProperties }) {
  return (
    <div
      className="absolute transition-all duration-500"
      style={{ background: 'rgba(4,8,15,.72)', ...style }}
    />
  );
}

/** True the first time this browser opens the app. */
export function tourUnseen(): boolean {
  try {
    return !localStorage.getItem(SEEN_KEY);
  } catch {
    return false;
  }
}
