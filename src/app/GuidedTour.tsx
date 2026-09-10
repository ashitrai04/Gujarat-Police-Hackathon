import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Camera, ChevronRight, Compass, Database, Map as MapIcon, Pause, Play,
  Route as RouteIcon, ScanLine, Siren,
} from 'lucide-react';
import { useStore, type GisLayer, type PoiLayer } from './store';
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

/* Views the tour looks at. Real places, so a step about districts is not
   narrated over an empty corner of the map. */
const GUJARAT = { bounds: [[68.1, 20.1], [74.5, 24.7]] as [[number, number], [number, number]] };
const JUNAGADH = { lng: 70.4579, lat: 21.5222, zoom: 12.4 };
const AHMEDABAD = { lng: 72.556, lat: 23.034, zoom: 10.8 };

/** A registration this estate has actually read, and that is on the watchlist. */
const DEMO_PLATE = 'GJ03PA8482';

/*
 * The operator's view before the walkthrough touched it. The tour switches
 * every overlay off, turns seven back on, replaces the wall and moves the map;
 * without putting that back, anyone who watches it once is left with a
 * console configured for a demonstration rather than for their work.
 */
type Snapshot = {
  gis: GisLayer[];
  pois: PoiLayer[];
  showBoundaries: boolean;
  showHeat: boolean;
  showGaps: boolean;
  wall: string[];
};
let saved: Snapshot | null = null;

/** Everything off, so each layer can be shown arriving rather than found. */
function clearLayers(set: Ctx['set']) {
  const now = useStore.getState();
  if (!saved) {
    saved = {
      gis: [...now.gis],
      pois: [...now.pois],
      showBoundaries: now.showBoundaries,
      showHeat: now.showHeat,
      showGaps: now.showGaps,
      wall: [...now.wallCameraIds],
    };
  }
  now.gis.forEach((g) => set.toggleGis(g));
  now.pois.forEach((p) => set.togglePoi(p));
  if (now.showBoundaries) set.toggleBoundaries();
  if (now.showHeat) set.toggleHeat();
  if (now.showGaps) set.toggleGaps();
}

/** Put the operator's view back as it was. Safe to call when nothing was saved. */
function restoreView() {
  if (!saved) return;
  const s = useStore.getState();
  const want = saved;
  saved = null;
  // Toggle only the differences: switching an already-correct layer would
  // flip it the wrong way.
  s.gis.filter((g) => !want.gis.includes(g)).forEach((g) => s.toggleGis(g));
  want.gis.filter((g) => !s.gis.includes(g)).forEach((g) => s.toggleGis(g));
  s.pois.filter((p) => !want.pois.includes(p)).forEach((p) => s.togglePoi(p));
  want.pois.filter((p) => !s.pois.includes(p)).forEach((p) => s.togglePoi(p));
  const now = useStore.getState();
  if (now.showBoundaries !== want.showBoundaries) now.toggleBoundaries();
  if (now.showHeat !== want.showHeat) now.toggleHeat();
  if (now.showGaps !== want.showGaps) now.toggleGaps();
  now.setWall(want.wall);
  now.setTrace(null);
  now.closePanel();
  now.setDockOpen(false);
}

const STEPS: Step[] = [
  {
    id: 'map',
    target: null,
    title: 'The map is the product',
    desc:
      'Twenty-six departments across Gujarat run their own cameras, and none of the '
      + 'systems talk to each other. Sentinel puts all of them on one surface. The '
      + 'walkthrough starts with every overlay switched off and turns them on one at '
      + 'a time, so you can see what each one contributes.',
    hold: 5200,
    run: ({ set }) => {
      set.closePanel();
      set.setDockOpen(false);
      set.setTrace(null);
      clearLayers(set);
      set.setTourView(GUJARAT);
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
    hold: 5000,
  },

  /* The geography, one layer at a time. */
  {
    id: 'gis-state',
    target: 'gis',
    title: 'Layer one, the state boundary',
    desc:
      'Watch the map rather than the panel. The Gujarat boundary draws first: it is '
      + 'the frame every other layer is read against, and the line a vehicle crosses '
      + 'to leave the jurisdiction.',
    hold: 5000,
    run: ({ set }) => {
      set.setTourView(GUJARAT);
      set.toggleGis('state');
    },
  },
  {
    id: 'gis-districts',
    target: 'gis',
    title: 'Layer two, district boundaries',
    desc:
      'Thirty-three districts, each its own police jurisdiction. This is what turns '
      + '<b>a camera at Majevadi Gate</b> into <b>a camera Junagadh is answerable '
      + 'for</b>, and it is how the estate divides for reporting.',
    hold: 5000,
    run: ({ set }) => set.toggleGis('districts'),
  },
  {
    id: 'gis-highways',
    target: 'gis',
    title: 'Layer three, national highways',
    desc:
      '<b>11,079</b> highway segments. These carry the traffic that leaves the state, '
      + 'so they are where interception is possible and where camera coverage is '
      + 'worth arguing about.',
    hold: 5000,
    run: ({ set }) => {
      set.toggleGis('highways');
    },
  },
  {
    id: 'gis-roads',
    target: 'gis',
    title: 'Layer four, major roads',
    desc:
      '<b>12,404</b> state and major roads. A traced vehicle is matched onto this '
      + 'network rather than drawn as a straight line, because a route that obviously '
      + 'did not happen undermines every number shown beside it.',
    hold: 5200,
    run: ({ set }) => set.toggleGis('roads'),
  },

  /* Reference points. */
  {
    id: 'poi',
    target: 'poi',
    title: 'Where a vehicle can be intercepted',
    desc:
      '<b>126</b> police stations, then <b>232</b> toll plazas, then <b>741</b> '
      + 'railway stations, each arriving as it is named. Toll plazas earn their place '
      + 'specifically: a vehicle leaving the state passes one, which makes them the '
      + 'natural interception points on a traced route.',
    hold: 6800,
    run: async ({ set }) => {
      set.togglePoi('police');
      await wait(1700);
      set.togglePoi('toll');
      await wait(1700);
      set.togglePoi('railway');
    },
  },
  {
    id: 'camtype',
    target: 'camtype',
    title: 'Only the cameras that can read a plate',
    desc:
      'Ownership and capability are separate questions. An operator hunting a '
      + 'registration wants the cameras <b>able to read one</b>, whoever owns them. '
      + 'Watch the counts as fixed cameras are switched off, then back on.',
    hold: 5600,
    run: async ({ set }) => {
      set.toggleCamType('fixed');
      await wait(2400);
      set.toggleCamType('fixed');
    },
  },
  {
    id: 'wall',
    target: 'wall',
    title: 'The video wall',
    desc:
      'Cameras are added from map pins or by selecting an area: the map chooses, the '
      + 'wall shows. Tiles stay uniform rather than stretching, playable cameras sort '
      + 'first, and a feed that cannot be reached in twelve seconds falls back to '
      + 'recorded footage, labelled <b>RECORDED</b> and never passed off as live.',
    hold: 6400,
    settle: 900,
    run: async ({ set }) => {
      set.closePanel();
      set.setTourView(JUNAGADH);
      const cams = await api.cameras();
      set.setWall(cams.slice(0, 4).map((c) => c.id));
      set.setDockOpen(true);
    },
  },

  /* The tools, each actually used rather than pointed at. */
  {
    id: 'events',
    target: 'events',
    title: 'Tool 1, event search with the evidence',
    desc:
      'Searching a partial plate, <b>GJ03</b>, the way an operator does with three '
      + 'characters from a witness. Every match comes back with the <b>plate crop</b> '
      + 'it was read from and the <b>full frame</b> with the vehicle boxed, because '
      + 'OCR is right most of the time, not all of it, and an operator confirms '
      + 'the characters by eye before acting.',
    hold: 7000,
    settle: 800,
    run: ({ set }) => {
      set.setDockOpen(false);
      set.setTourView(JUNAGADH);
      set.presetEvents({ plate: 'GJ03', hours: 24 * 30 });
      set.openPanel({ kind: 'events' });
    },
  },
  {
    id: 'trace',
    target: 'trace',
    title: 'Tool 2, following a vehicle',
    desc:
      'Running a real registration: <b>GJ03PA8482</b>, read at Majevadi Gate. The '
      + 'search returns every camera that saw it in time order and the map fits to '
      + 'the result. Sightings are timestamped, so map matching can reject a link a '
      + 'vehicle could not physically have made.',
    hold: 7600,
    settle: 800,
    run: async ({ set }) => {
      set.openPanel({ kind: 'trace' });
      await wait(1100);
      try {
        const route = await api.route(DEMO_PLATE);
        set.setTrace(route);
        set.setTraceProgress(0);
        if (route.stops.length > 1) set.setTracePlaying(true);
      } catch {
        /* Analytics unreachable, and the panel already says so itself. */
      }
    },
  },
  {
    id: 'watchlist',
    target: 'watchlist',
    title: 'Tool 3, watchlist and live alerts',
    desc:
      'That same registration is on the watchlist as <b>stolen</b>, which is what '
      + 'makes the previous step an alert rather than a log line. Matching happens at '
      + 'the moment a plate is read: the pin flashes, the map moves to it, and the '
      + 'alert carries the snapshot and the reason. Acknowledgement records who acted.',
    hold: 6400,
    settle: 800,
    run: ({ set }) => {
      set.setTrace(null);
      set.openPanel({ kind: 'watchlist' });
    },
  },
  {
    id: 'health',
    target: 'health',
    title: 'Tool 4, knowing what is actually up',
    desc:
      'The grid reports every camera as live, including the dead ones, so its word '
      + 'is not shown as health. Cameras are <b>available</b> or <b>unavailable</b> '
      + 'only once probed; the rest are <b>unverified</b>, and the panel says so. '
      + 'Wall cameras are probed continuously and the estate on request, slowly, '
      + 'because this grid revokes sessions that probe in bursts.',
    hold: 6000,
    settle: 800,
    run: ({ set }) => set.openPanel({ kind: 'health' }),
  },
  {
    id: 'registry',
    target: 'registry',
    title: 'Tool 5, onboarding a new department',
    desc:
      'Departments hand over the spreadsheets they already keep, and no two name '
      + 'their columns alike. The importer reads whatever headers it is given and '
      + 'maps them itself: <b>9/9, 9/9 and 10/10</b> columns across three '
      + 'deliberately different formats, with every decision shown for confirmation '
      + 'before anything is saved.',
    hold: 6600,
    settle: 800,
    run: ({ set }) => {
      set.setTourView(AHMEDABAD);
      set.openPanel({ kind: 'registry' });
    },
  },
  {
    id: 'end',
    target: null,
    title: 'That is the platform',
    desc:
      'Registry and GIS, unified viewing, ANPR with evidence, vehicle tracing and '
      + 'alerting, running against thirty live cameras with a recorded fallback '
      + 'behind them. Press <b>Guide</b> in the top bar to watch this again.',
    hold: 5600,
    run: ({ set }) => {
      set.closePanel();
      set.setDockOpen(false);
      set.setTrace(null);
      set.setTourView(GUJARAT);
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
  // Captions differ in length, so the card differs in height. Measuring it
  // beats assuming a number that is wrong for most steps.
  const [captionH, setCaptionH] = useState(216);
  const captionEl = useRef<HTMLDivElement | null>(null);

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
    restoreView();
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
      // A failing action must not stop the walkthrough. It used to: the wall
      // step fetched the camera list, the fetch threw, and the rejection ended
      // this sequence before the caption or the clock — the tour froze with a
      // spotlight on the previous control and no way forward but Skip. The
      // step is still shown; it just demonstrates less.
      try {
        await step.run?.({ set: useStore.getState() });
      } catch (err) {
        console.warn(`[tour] step "${step.id}" action failed`, err);
      }
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
          await wait(700);
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
      // Measure on the next frame, once this step's text has been laid out.
      requestAnimationFrame(() => {
        const h = captionEl.current?.offsetHeight;
        if (h) setCaptionH(h);
      });

      // The hold is reading time, so it starts when the caption can actually
      // be read — after the browser has painted it, not when React was asked
      // to. Two frames: the first commits the change, the second is drawn with
      // it. On a busy machine these can be far apart, and starting the clock
      // early is how a caption ends up on screen for a fraction of its hold.
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      if (!live) return;

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

  const pos = captionPosition(spot, captionH);

  return createPortal(
    <div className="tour-root">
      {spot ? (
        <div
          className="tour-spotlight"
          style={ringBox(spot)}
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
        ref={captionEl}
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

/**
 * The ring around a target, padded but kept on screen. A control flush with
 * the viewport edge — everything in the left rail — would otherwise have its
 * ring drawn half off the page, which reads as the highlight missing.
 */
function ringBox(r: DOMRect) {
  const PAD = 10;
  const EDGE = 3;
  const left = Math.max(EDGE, r.left - PAD);
  const top = Math.max(EDGE, r.top - PAD);
  const right = Math.min(window.innerWidth - EDGE, r.right + PAD);
  const bottom = Math.min(window.innerHeight - EDGE, r.bottom + PAD);
  return { left, top, width: right - left, height: bottom - top };
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
function captionPosition(rect: DOMRect | null, height: number) {
  const W = 384;
  const H = height || 216;
  const M = 14;
  const clampY = (v: number) => Math.max(M, Math.min(v, window.innerHeight - H - M));

  if (!rect) {
    // A step with no target is talking about the map itself, so the card must
    // not sit in the middle of it. Bottom-left of the map area — the same
    // column the rail captions use — and the map frames its subject to the
    // right of it (see CAPTION_CLEARANCE).
    const mapLeft = document.querySelector('.mapboxgl-map')?.getBoundingClientRect().left ?? 0;
    return { x: Math.max(M, mapLeft + M), y: Math.max(M, window.innerHeight - H - 36) };
  }

  // A narrow target — anything in the left rail — gets the caption alongside
  // it, level with its middle. Anchoring to the bottom edge instead leaves the
  // card floating out in the map with nothing visually joining the two.
  if (rect.width < 320) {
    const x = rect.right + M;
    const y = clampY(rect.top + rect.height / 2 - H / 2);
    if (x + W <= window.innerWidth - M) return { x, y };
    return { x: Math.max(M, rect.left - W - M), y };
  }

  // A wide target keeps the caption directly under it, flipping above when
  // there is no room below.
  let y = rect.bottom + M;
  if (y + H > window.innerHeight - M) y = rect.top - H - M;
  y = clampY(y);
  let x = rect.left;
  if (x + W > window.innerWidth - M) x = Math.max(M, window.innerWidth - W - M);
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
