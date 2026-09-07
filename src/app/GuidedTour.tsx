import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Camera, ChevronRight, Compass, Database, Map as MapIcon, Pause, Play,
  Route as RouteIcon, ScanLine, Siren,
} from 'lucide-react';
import { useStore } from './store';
import { api } from '@/api/client';
import './GuidedTour.css';

/**
 * Guided walkthrough of the platform.
 *
 * It operates the real interface rather than showing pictures of one. A step
 * that says a filter narrows the estate applies that filter, and the count on
 * screen changes because it did. A scripted demo can claim anything; this can
 * only claim what the running software does, so it stays honest as the app
 * changes and breaks visibly when it does not.
 *
 * Each step runs as a sequence rather than all at once, because the parts
 * depend on each other: the action fires first, the interface is given time to
 * settle, only then is the target measured and spotlit, and the caption fades
 * in last. Measuring a panel before it has opened finds nothing, or worse,
 * finds where it used to be.
 */

interface Ctx {
  set: ReturnType<typeof useStore.getState>;
}

interface Step {
  id: string;
  /** `data-tour` hook, or a CSS selector. Null centres with no spotlight. */
  target: string | null;
  title: string;
  desc: string;
  /** Hold after the caption appears, in ms. */
  hold: number;
  /** Extra settle time when this step opens a panel or dock. */
  settle?: number;
  run?: (ctx: Ctx) => void | Promise<void>;
}

const SEEN_KEY = 'sentinel-tour-seen';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STEPS: Step[] = [
  {
    id: 'map',
    target: null,
    title: 'The map is the product',
    desc:
      'Twenty-six departments across Gujarat run their own cameras, and none of the '
      + 'systems talk to each other. Sentinel puts all of them on one surface. Every '
      + 'feature that follows is worked from this map — filtering, opening feeds, '
      + 'following a vehicle.',
    hold: 4800,
    run: ({ set }) => {
      set.closePanel();
      set.setDockOpen(false);
    },
  },
  {
    id: 'layers',
    target: 'layers',
    title: 'Cameras by owning department',
    desc:
      'A camera is treated as a point of interest with a category, the way a maps app '
      + 'treats fuel stations. Traffic, health, PDS, RTO and municipal estates each '
      + 'toggle independently, so an operator sees the cameras they are responsible '
      + 'for rather than all thirty at once.',
    hold: 4600,
  },
  {
    id: 'camtype',
    target: 'camtype',
    title: 'Only the cameras that can read a plate',
    desc:
      'Ownership and capability are separate questions. An operator hunting a '
      + 'registration wants the cameras <b>able to read one</b>, whoever owns them. '
      + 'Watch the counts as fixed cameras are switched off — the estate drops from '
      + '<b>30 to 5</b>.',
    hold: 5400,
    run: async ({ set }) => {
      set.toggleCamType('fixed');
      await wait(2600);
      set.toggleCamType('fixed');
    },
  },
  {
    id: 'gis',
    target: 'gis',
    title: 'The geography a route is read against',
    desc:
      'State boundary, districts, <b>11,079</b> national-highway segments and '
      + '<b>12,404</b> major roads. A traced vehicle follows these roads rather than a '
      + 'straight line — a route that obviously did not happen undermines every number '
      + 'shown beside it.',
    hold: 5200,
    run: async ({ set }) => {
      set.toggleGis('highways');
      await wait(1500);
      set.toggleGis('state');
    },
  },
  {
    id: 'poi',
    target: 'poi',
    title: 'Where a vehicle can be intercepted',
    desc:
      '<b>126</b> police stations, <b>232</b> toll plazas and <b>741</b> railway '
      + 'stations from OpenStreetMap. Toll plazas earn their place specifically: a '
      + 'vehicle leaving the state passes one, which makes them the natural '
      + 'interception points on a traced route.',
    hold: 4800,
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
    desc:
      'Departments hand over the spreadsheets they already keep, and no two name their '
      + 'columns alike. The importer reads whatever headers it is given and maps them '
      + 'itself — <b>9/9, 9/9 and 10/10</b> columns across three deliberately different '
      + 'formats, with every decision shown for confirmation before anything is saved.',
    hold: 6200,
    settle: 700,
    run: ({ set }) => set.openPanel({ kind: 'registry' }),
  },
  {
    id: 'wall',
    target: 'wall',
    title: 'The video wall',
    desc:
      'Cameras are added from map pins or by selecting an area: the map chooses, the '
      + 'wall shows. Tiles stay uniform rather than stretching, playable cameras sort '
      + 'first, and a feed that cannot be reached in twelve seconds falls back to '
      + 'recorded footage — labelled <b>RECORDED</b>, never passed off as live.',
    hold: 6400,
    settle: 900,
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
    title: 'Every sighting, with its evidence',
    desc:
      'OCR on this footage is right most of the time, not all of the time. So each '
      + 'reading carries the <b>plate crop</b> it was made from and the <b>full frame</b> '
      + 'with the vehicle boxed. An operator confirms the characters by eye before '
      + 'acting, and the frame is the accountability record.',
    hold: 6400,
    settle: 700,
    run: ({ set }) => {
      set.setDockOpen(false);
      set.openPanel({ kind: 'events' });
    },
  },
  {
    id: 'trace',
    target: 'trace',
    title: 'Following a vehicle across cameras',
    desc:
      'A plate returns every camera that saw it, in time order, drawn as a route with '
      + 'a playback slider. Because sightings are timestamped, map matching can reject '
      + 'links a vehicle could not physically have made — and where a gap cannot be '
      + 'bridged the straight line is kept rather than a plausible path invented.',
    hold: 6000,
    settle: 700,
    run: ({ set }) => set.openPanel({ kind: 'trace' }),
  },
  {
    id: 'watchlist',
    target: 'watchlist',
    title: 'Watchlist and live alerts',
    desc:
      'Stolen and wanted vehicles are matched at the moment a plate is read. On a hit '
      + 'the camera pin flashes, the map moves to it, and an alert card carries the '
      + 'snapshot and the reason. Acknowledgement records who acted and when.',
    hold: 5400,
    settle: 700,
    run: ({ set }) => set.openPanel({ kind: 'watchlist' }),
  },
  {
    id: 'health',
    target: 'health',
    title: 'Knowing what is actually up',
    desc:
      'The grid reports every camera as live, including the ones that are not, so '
      + 'availability is measured rather than trusted. Probing follows the wall rather '
      + 'than sweeping the estate — this grid permits one session per address and '
      + 'refuses bursts.',
    hold: 5200,
    settle: 700,
    run: ({ set }) => set.openPanel({ kind: 'health' }),
  },
  {
    id: 'end',
    target: null,
    title: 'That is the platform',
    desc:
      'Registry and GIS, unified viewing, ANPR with evidence, vehicle tracing and '
      + 'alerting — running against thirty live cameras with a recorded fallback '
      + 'behind them. Press <b>Guide</b> in the top bar to watch this again.',
    hold: 5600,
    run: ({ set }) => {
      set.closePanel();
      set.setDockOpen(false);
    },
  },
];

const HIGHLIGHTS = [
  { icon: MapIcon, label: 'GIS map & layers' },
  { icon: Database, label: 'Camera registry' },
  { icon: Camera, label: 'Video wall' },
  { icon: ScanLine, label: 'ANPR evidence' },
  { icon: RouteIcon, label: 'Vehicle tracing' },
  { icon: Siren, label: 'Watchlist alerts' },
];

type Phase = 'welcome' | 'running';

export function GuidedTour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('welcome');
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [spot, setSpot] = useState<DOMRect | null>(null);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [pressing, setPressing] = useState(false);
  const [ripple, setRipple] = useState<{ x: number; y: number; k: number } | null>(null);
  const [captionShown, setCaptionShown] = useState(false);

  const advance = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One clock for the whole tour. Both the step sequence and the pause toggle
  // used to write this timer independently, so the later one silently replaced
  // the earlier and every step ran for half the hold it declared.
  const deadline = useRef(0);
  const remaining = useRef(0);
  const iRef = useRef(i);
  iRef.current = i;
  const step = STEPS[i];

  const finish = useCallback(() => {
    if (advance.current) clearTimeout(advance.current);
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* private browsing — the tour simply offers itself again */
    }
    onClose();
  }, [onClose]);

  const next = useCallback(() => {
    if (advance.current) clearTimeout(advance.current);
    if (iRef.current < STEPS.length - 1) setI((n) => n + 1);
    else finish();
  }, [finish]);

  /* The step sequence must not depend on `next`, and `next` cannot help
     changing: it chains to the `onClose` prop, which is a fresh closure on
     every parent render. Reading it through a ref breaks that chain — without
     this the effect re-runs whenever the parent renders, the step's action
     mutates the store, the parent renders again, and the tour spins until
     React tears the tree down. */
  const nextRef = useRef(next);
  nextRef.current = next;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const startClock = useCallback((ms: number) => {
    if (advance.current) clearTimeout(advance.current);
    deadline.current = Date.now() + ms;
    remaining.current = ms;
    advance.current = setTimeout(() => nextRef.current(), ms);
  }, []);

  /* Run one step as an ordered sequence. */
  useEffect(() => {
    if (!open || phase !== 'running' || !step) return;
    let live = true;
    setCaptionShown(false);

    const centre = () => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

    (async () => {
      // 1. Perform the action first, so the interface is in the state the
      //    caption is about to describe.
      await step.run?.({ set: useStore.getState() });
      if (!live) return;

      // 2. Let it settle. A panel measured while opening reports the wrong box.
      await wait(step.settle ?? 260);
      if (!live) return;

      // 3. Find and measure the target.
      const el = step.target
        ? document.querySelector<HTMLElement>(
            /^[.#]/.test(step.target) ? step.target : `[data-tour="${step.target}"]`,
          )
        : null;

      if (el) {
        const r = el.getBoundingClientRect();
        if (r.top < 0 || r.bottom > window.innerHeight) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await wait(420);
          if (!live) return;
        }
        const box = el.getBoundingClientRect();
        setSpot(box);
        setCursor({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
      } else {
        setSpot(null);
        setCursor(centre());
      }

      // 4. Let the cursor travel, then click. The press lands after the move,
      //    so the highlight reads as caused by it.
      await wait(640);
      if (!live) return;
      setPressing(true);
      setRipple({ ...(el ? { x: cursorXOf(el), y: cursorYOf(el) } : centre()), k: Date.now() });
      await wait(200);
      if (!live) return;
      setPressing(false);

      // 5. Caption last.
      setCaptionShown(true);

      // The full hold, every time. If the operator paused mid-sequence, the
      // clock waits for them to resume rather than starting behind.
      if (pausedRef.current) remaining.current = step.hold;
      else startClock(step.hold);
    })();

    return () => {
      live = false;
      if (advance.current) clearTimeout(advance.current);
    };
    // Deliberately keyed on the step index alone. `step` is derived from `i`,
    // and `next`/`paused` are read through refs — see nextRef above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase, i]);

  /* Pausing banks the time left; resuming hands exactly that back. */
  useEffect(() => {
    if (!open || phase !== 'running' || !captionShown) return;
    if (paused) {
      if (advance.current) {
        clearTimeout(advance.current);
        advance.current = null;
      }
      remaining.current = Math.max(0, deadline.current - Date.now());
    } else if (remaining.current > 0) {
      startClock(remaining.current);
    }
    // Only the pause toggle drives this; the step sequence owns the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, captionShown]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      if (e.key === ' ') {
        e.preventDefault();
        setPaused((p) => !p);
      }
      if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, finish, next]);

  useEffect(() => {
    if (open) {
      setPhase('welcome');
      setI(0);
      setPaused(false);
      setSpot(null);
    }
  }, [open]);

  if (!open) return null;

  if (phase === 'welcome') {
    return createPortal(
      <div className="tour-welcome">
        <div className="tour-welcome-card">
          <div className="tour-welcome-icon"><Compass size={26} /></div>
          <div className="tour-welcome-title">Platform walkthrough</div>
          <p className="tour-welcome-sub">
            A guided pass over the working system — camera registry, GIS layers,
            the video wall, plate reading with evidence, and vehicle tracing.
            It drives the real interface, so everything you see it claim, it does.
          </p>
          <div className="tour-welcome-grid">
            {HIGHLIGHTS.map(({ icon: Icon, label }) => (
              <div key={label} className="tour-welcome-item">
                <Icon size={13} /> {label}
              </div>
            ))}
          </div>
          <div className="tour-welcome-actions">
            <button className="tour-btn tour-btn-skip" onClick={finish}>Skip</button>
            <button className="tour-btn tour-btn-start" onClick={() => setPhase('running')}>
              <Play size={14} /> Start walkthrough
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  const pos = captionPosition(spot);

  return createPortal(
    <div className="tour-root">
      {spot ? (
        <div
          className="tour-spotlight"
          style={{
            top: spot.top - 7, left: spot.left - 7,
            width: spot.width + 14, height: spot.height + 14,
          }}
        />
      ) : (
        <div className="tour-backdrop" />
      )}

      {ripple && (
        <span
          key={ripple.k}
          className="tour-ripple"
          style={{ left: ripple.x, top: ripple.y }}
          onAnimationEnd={() => setRipple(null)}
        />
      )}

      <div
        className={`tour-cursor${pressing ? ' pressing' : ''}`}
        style={{ left: cursor.x, top: cursor.y }}
      >
        <Pointer />
      </div>

      <div
        className={`tour-caption${captionShown ? ' enter' : ''}`}
        style={{ left: pos.x, top: pos.y, opacity: captionShown ? 1 : 0 }}
      >
        <div className="tour-progress">
          <div
            className="tour-progress-fill"
            style={{ width: `${((i + 1) / STEPS.length) * 100}%` }}
          />
        </div>

        <div className="tour-caption-body">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span className="tour-step-badge">{i + 1}</span>
            <span className="tour-caption-title">{step.title}</span>
          </div>
          <p
            className="tour-caption-desc"
            dangerouslySetInnerHTML={{ __html: step.desc }}
          />

          <div className="tour-caption-footer">
            <button className="tour-mini" onClick={() => setPaused((p) => !p)}>
              {paused ? <Play size={11} /> : <Pause size={11} />}
              {paused ? 'Resume' : 'Pause'}
            </button>
            <span
              className="mono"
              style={{ fontSize: 10.5, color: 'var(--text-mute)' }}
            >
              {i + 1} / {STEPS.length}
            </span>
            <div style={{ flex: 1 }} />
            <button className="tour-mini" onClick={finish}>Skip</button>
            <button className="tour-mini tour-mini-primary" onClick={next}>
              {i === STEPS.length - 1 ? 'Finish' : 'Next'} <ChevronRight size={11} />
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** An arrow, not a dot — it reads as a pointer being moved by someone. */
function Pointer() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden>
      <path
        d="M5.65 2.92L19.08 12.03c.48.32.28 1.07-.29 1.1l-6.31.33-2.68 5.77c-.24.52-1 .44-1.12-.11L5.05 3.61c-.11-.49.23-.94.6-.69Z"
        fill="var(--signal)"
        stroke="#04201C"
        strokeWidth="0.9"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const cursorXOf = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return r.left + r.width / 2;
};
const cursorYOf = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return r.top + r.height / 2;
};

/** Beside the highlight, never off-screen, never covering what it describes. */
function captionPosition(rect: DOMRect | null) {
  const W = 384;
  const H = 216;
  const M = 16;
  if (!rect) {
    return { x: (window.innerWidth - W) / 2, y: window.innerHeight / 2 + 30 };
  }
  let y = rect.bottom + M;
  if (y + H > window.innerHeight - M) y = rect.top - H - M;
  if (y < M) y = Math.max(M, (window.innerHeight - H) / 2);

  // Prefer sitting to the right of a narrow target such as the left rail,
  // rather than on top of it.
  let x = rect.width < 320 ? rect.right + M : rect.left;
  if (x + W > window.innerWidth - M) x = Math.max(M, rect.left - W - M);
  if (x < M) x = M;
  return { x, y };
}

/** True the first time this browser opens the app. */
export function tourUnseen(): boolean {
  try {
    return !localStorage.getItem(SEEN_KEY);
  } catch {
    return false;
  }
}
