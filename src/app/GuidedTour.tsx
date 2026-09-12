import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  Camera, ChevronRight, Compass, Database, Map as MapIcon, Pause, Play,
  Route as RouteIcon, ScanLine, Siren,
} from 'lucide-react';
import { useStore, type GisLayer, type PoiLayer } from './store';
import { deleteCamera } from '@/api/cameraStore';
import { refreshCameras } from '@/api/client';
import './GuidedTour.css';

/**
 * Guided walkthrough of the platform.
 *
 * It operates the real interface rather than showing pictures of one. The
 * cursor clicks the actual controls — a layer arrives because its row was
 * clicked, a search runs because its box was typed into and its button
 * pressed, a camera is onboarded through the real form and deleted again. A
 * scripted demo can claim anything; this can only claim what the running
 * software does, so it stays honest as the app changes.
 *
 * What a step demonstrates is lit, not dimmed. The clicked control carries a
 * pulsing ring, and the region it acts on — the map, a panel, the video wall —
 * is cut out of the shade alongside it. An earlier version spotlit only the
 * control, which left the panel it opened sitting in the dark, exactly where
 * the demonstration was happening.
 */

type StoreState = ReturnType<typeof useStore.getState>;

/** What a step can do to the interface, with the cursor visibly doing it. */
interface Ctx {
  set: StoreState;
  qc: QueryClient;
  /** Move the cursor to an element and click it. False if it is not there. */
  click(sel: string, opts?: { onlyIfOff?: boolean }): Promise<boolean>;
  /** Move the cursor to an element without clicking it. */
  point(sel: string): Promise<boolean>;
  /** Type into a text field, a character at a time, as React sees typing. */
  type(sel: string, text: string): Promise<boolean>;
  /** Pick an option in a select. */
  choose(sel: string, value: string): Promise<boolean>;
  /** Hand a file to a file input, as if it had been picked in the dialog. */
  upload(sel: string, file: File): Promise<boolean>;
  /** Light these regions; the first is the one the cursor is working on. */
  light(regions: string[]): Promise<void>;
  /** Replace the caption text, e.g. when an action could not be completed. */
  say(html: string): void;
  wait(ms: number): Promise<void>;
  live(): boolean;
}

interface Step {
  id: string;
  title: string;
  desc: string;
  /** Hold after the step's actions finish, in ms — reading time. */
  hold: number;
  /** Regions lit once the step's actions are done. */
  light?: string[];
  /** Show the caption before the actions, for steps that take a while. */
  early?: boolean;
  run?: (ctx: Ctx) => Promise<void> | void;
}

const SEEN_KEY = 'sentinel-tour-seen';
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A hook name (`data-tour`), or any CSS selector. */
function resolve(sel: string): HTMLElement | null {
  const css = /^[[.#]/.test(sel) || sel.includes(' ') ? sel : `[data-tour="${sel}"]`;
  return document.querySelector<HTMLElement>(css);
}

/* Places the tour looks at. Real places, chosen from the data itself: each
   reference layer flies to where that facility is densest, so the map is
   seen filling up rather than finding one icon in open country. */
const GUJARAT = { bounds: [[68.1, 20.1], [74.5, 24.7]] as [[number, number], [number, number]] };
const SAURASHTRA = { lng: 70.8, lat: 22.2, zoom: 8.3, pitch: 38, bearing: -12, orbit: true };
const JUNAGADH = { lng: 70.4579, lat: 21.5222, zoom: 15, pitch: 52, bearing: 24, orbit: true };
type Flight = { lng: number; lat: number; zoom: number; pitch: number; bearing: number; orbit: true };
/* City views are tilted and turn slowly while held; the heading differs from
   flight to flight so consecutive views do not look like the same shot. */
const FLIGHTS: Record<PoiLayer, Flight> = {
  police: { lng: 72.579, lat: 23.045, zoom: 12, pitch: 48, bearing: -18, orbit: true },       // Ahmedabad, 35 in view
  bus_station: { lng: 72.624, lat: 22.969, zoom: 11, pitch: 42, bearing: 22, orbit: true },   // Ahmedabad, 18
  toll: { lng: 72.934, lat: 22.674, zoom: 9.4, pitch: 36, bearing: -34, orbit: true },        // Ahmedabad–Vadodara corridor, 92
  fuel: { lng: 73.185, lat: 22.302, zoom: 11.6, pitch: 46, bearing: 26, orbit: true },        // Vadodara, 63
  railway: { lng: 72.925, lat: 21.204, zoom: 10.8, pitch: 40, bearing: -14, orbit: true },    // Surat, 105
  hospital: { lng: 72.825, lat: 21.187, zoom: 12.4, pitch: 54, bearing: 12, orbit: true },    // Surat, 272
};

/* The spreadsheet the bulk-import step hands to the importer: headers as a
   department actually writes them, none of them the registry's own names. */
const SAMPLE_SHEET = [
  'Device Identifier,Installed At,Owning Department,Taluka,GPS Lat,GPS Long,Live URL,Camera Kind,Make,Date of Installation',
  'RTO-GNR-101,Adalaj Toll Plaza North Lane,rto,Gandhinagar,23.1866,72.5601,,fixed,CP Plus,2024-03-14',
  'RTO-GNR-102,Dehgam Check Post Inbound,rto,Dehgam,23.1675,72.8161,,ptz,Hikvision,2023-11-02',
  'RTO-GNR-103,Chiloda Circle,rto,Gandhinagar,23.2946,72.7410,,fixed,Dahua,2024-07-21',
].join('\n');

/** A registration this estate has actually read, and that is on the watchlist. */
const DEMO_PLATE = 'GJ03PA8482';

/* The example camera onboarded and removed during the walkthrough. It
   borrows Majevadi Gate's stream so there is a real feed to show, and sits
   on the road beside it. */
const DEMO_CAM = {
  id: 'DEMO-TOUR',
  name: 'Demo · Junagadh Bus Station Road',
  department: 'traffic',
  district: 'Junagadh',
  type: 'ptz',
  status: 'online',
  lat: '21.5245',
  lng: '70.4585',
  hls: 'https://cctv.corp8.cloud/cam08/index.m3u8',
  tags: 'demo, junagadh',
};
let demoCreated = false;

/*
 * The operator's view before the walkthrough touched it. The tour switches
 * every overlay off, turns layers back on one by one, replaces the wall and
 * moves the map; without putting that back, anyone who watches it once is left
 * with a console configured for a demonstration rather than for their work.
 */
type Snapshot = {
  gis: GisLayer[];
  pois: PoiLayer[];
  showBoundaries: boolean;
  showHeat: boolean;
  showGaps: boolean;
  wall: string[];
  baseStyle: StoreState['baseStyle'];
  pitch: number;
};
let saved: Snapshot | null = null;

/** Everything off, so each layer can be shown arriving rather than found. */
function clearLayers(set: StoreState) {
  const now = useStore.getState();
  if (!saved) {
    saved = {
      gis: [...now.gis],
      pois: [...now.pois],
      showBoundaries: now.showBoundaries,
      showHeat: now.showHeat,
      showGaps: now.showGaps,
      wall: [...now.wallCameraIds],
      baseStyle: now.baseStyle,
      pitch: now.pitch,
    };
  }
  now.gis.forEach((g) => set.toggleGis(g));
  now.pois.forEach((p) => set.togglePoi(p));
  if (now.showBoundaries) set.toggleBoundaries();
  if (now.showHeat) set.toggleHeat();
  if (now.showGaps) set.toggleGaps();
}

/** The example camera must not outlive the tour, however it ends. */
async function removeDemoCamera(qc: QueryClient) {
  if (!demoCreated) return;
  try {
    await deleteCamera(DEMO_CAM.id);
    demoCreated = false;
  } catch {
    /* it will be listed in the registry, and can be deleted from there */
  }
  await refreshCameras(qc);
}

/** Put the operator's view back as it was. Safe to call when nothing was saved. */
function restoreView(qc: QueryClient) {
  void removeDemoCamera(qc);
  const s = useStore.getState();
  if (s.wallFullscreen) s.toggleWallFullscreen();
  if (!saved) return;
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
  if (now.baseStyle !== want.baseStyle) now.setBaseStyle(want.baseStyle);
  if (now.pitch !== want.pitch) now.setPitch(want.pitch);
  now.setTrace(null);
  now.setFocusCamera(null);
  now.closePanel();
  now.setDockOpen(false);
}

/** One step per reference layer: click its row, fly to where it is densest. */
function poiStep(layer: PoiLayer, title: string, desc: string): Step {
  return {
    id: `poi-${layer}`,
    title,
    desc,
    hold: 4600,
    light: [`poi-${layer}`, 'map'],
    run: async (c) => {
      await c.click(`poi-${layer}`, { onlyIfOff: true });
      c.set.setTourView(FLIGHTS[layer]);
    },
  };
}

const STEPS: Step[] = [
  {
    id: 'map',
    title: 'The map is the product',
    desc:
      'Twenty-six departments across Gujarat run their own cameras, and none of the '
      + 'systems talk to each other. Sentinel puts all of them on one surface. The '
      + 'walkthrough starts with every overlay off and turns them on one at a time, '
      + 'flying to where each one matters.',
    hold: 5200,
    light: ['map'],
    run: (c) => {
      c.set.closePanel();
      c.set.setDockOpen(false);
      c.set.setTrace(null);
      clearLayers(c.set);
      c.set.setTourView({ ...GUJARAT, intro: true });
    },
  },
  {
    id: 'views',
    title: 'Map views, and 3D',
    desc:
      'The base map changes to suit the job: <b>dark</b> for a night watch where the '
      + 'overlays must glow, <b>streets</b> for addresses, <b>satellite</b> for what is '
      + 'actually on the ground. <b>3D</b> tilts the map so a junction is read the way '
      + 'the camera sees it.',
    hold: 3600,
    early: true,
    light: ['style', 'style-menu', 'map'],
    run: async (c) => {
      const home = c.set.baseStyle;
      for (const next of ['dark', 'streets'] as const) {
        if (next === home) continue;
        await c.click('style');
        await c.wait(250);
        await c.click(`style-${next}`);
        await c.wait(1700);
      }
      await c.click('style');
      await c.wait(250);
      await c.click(`style-${home === 'dark' || home === 'streets' ? 'satellite' : home}`);
      await c.wait(900);
      await c.click('tilt');
      await c.wait(2600);
      await c.click('tilt');
    },
  },
  {
    id: 'layers',
    title: 'Cameras by owning department',
    desc:
      'A camera is a point with a category, the way a maps app treats fuel stations. '
      + 'Traffic, health, PDS, RTO and municipal estates toggle independently, and '
      + 'each has its own pin, so an operator can tell whose camera it is at a glance.',
    hold: 5000,
    light: ['layers', 'map'],
    run: async (c) => { await c.point('layers'); },
  },

  /* The geography, one layer at a time. */
  {
    id: 'gis-state',
    title: 'Layer one, the state boundary',
    desc:
      'The Gujarat boundary draws first: the frame every other layer is read '
      + 'against, and the line a vehicle crosses to leave the jurisdiction.',
    hold: 4600,
    light: ['gis-state', 'map'],
    run: async (c) => {
      await c.click('gis-state', { onlyIfOff: true });
      c.set.setTourView(GUJARAT);
    },
  },
  {
    id: 'gis-districts',
    title: 'Layer two, district boundaries',
    desc:
      'Thirty-three districts, each its own police jurisdiction. This is what turns '
      + '<b>a camera at Majevadi Gate</b> into <b>a camera Junagadh is answerable for</b>.',
    hold: 4600,
    light: ['gis-districts', 'map'],
    run: async (c) => { await c.click('gis-districts', { onlyIfOff: true }); },
  },
  {
    id: 'gis-highways',
    title: 'Layer three, national highways',
    desc:
      '<b>11,079</b> highway segments. They carry the traffic that leaves the state, '
      + 'so they are where interception is possible.',
    hold: 4600,
    light: ['gis-highways', 'map'],
    run: async (c) => { await c.click('gis-highways', { onlyIfOff: true }); },
  },
  {
    id: 'gis-roads',
    title: 'Layer four, major roads',
    desc:
      '<b>12,404</b> state and major roads, shown here across Saurashtra. A traced '
      + 'vehicle is matched onto this network rather than drawn as a straight line.',
    hold: 4600,
    light: ['gis-roads', 'map'],
    run: async (c) => {
      await c.click('gis-roads', { onlyIfOff: true });
      c.set.setTourView(SAURASHTRA);
    },
  },

  /* Reference facilities, each flown to where it is densest. */
  poiStep('police', 'Police stations',
    '<b>103</b> police stations across the state. The map flies to Ahmedabad, the '
    + 'densest cluster: the stations an intercept would be called from.'),
  poiStep('bus_station', 'Bus depots',
    'Bus depots, where a wanted person on foot is most likely to be picked up. '
    + 'Ahmedabad again, where they concentrate.'),
  poiStep('toll', 'Toll plazas',
    '<b>201</b> toll plazas. The flight follows the Ahmedabad–Vadodara corridor, '
    + 'where they string along the expressway: a vehicle leaving the state passes one, '
    + 'which makes them the natural interception points on a traced route.'),
  poiStep('fuel', 'Fuel stations',
    'Fuel stations, seen here in Vadodara. Forecourt cameras are the private '
    + 'estate a department can ask to join the registry.'),
  poiStep('railway', 'Railway stations',
    '<b>670</b> railway stations, with Surat and its suburban line the densest '
    + 'stretch.'),
  poiStep('hospital', 'Hospitals',
    'Hospitals, densest in Surat. Every facility keeps a dot; its icon appears '
    + 'where there is room, so zooming out never hides one without saying so.'),

  {
    id: 'camtype',
    title: 'Only the cameras that can read a plate',
    desc:
      'Ownership and capability are separate questions. An operator hunting a '
      + 'registration wants the cameras able to read one. Watch the count and the '
      + 'map as fixed cameras are switched off, then back on.',
    hold: 5000,
    light: ['camtype', 'count', 'map'],
    run: async (c) => {
      c.set.setTourView(GUJARAT);
      await c.point('camtype');
      c.set.toggleCamType('fixed');
      await c.wait(2400);
      c.set.toggleCamType('fixed');
    },
  },

  /* Viewing. */
  {
    id: 'wall',
    title: 'The camera grid',
    desc:
      'The wall opens as its own screen, one feed large, four up, or filling the space. '
      + 'Tiles stay uniform, playable cameras sort first, and a feed that cannot be '
      + 'reached falls back to recorded footage, labelled <b>RECORDED</b>.',
    hold: 4200,
    early: true,
    light: ['wall', 'dock'],
    run: async (c) => {
      c.set.closePanel();
      c.set.setWall(['cam08', 'cam10', 'cam01', 'cam05']);
      await c.click('wall');
      await c.wait(900);
      // The layouts: one feed large, a 2×2 grid, then back to filling the space.
      for (const n of [1, 4, 0]) {
        await c.click(`layout-${n}`);
        await c.wait(1300);
      }
    },
  },
  {
    id: 'camera',
    title: 'One camera, with live detection',
    desc:
      '<b>Detail</b> on a tile opens the camera by itself. Detection runs in the browser '
      + 'on the frames shown: every vehicle boxed with its type, and a plate spelled out '
      + 'once its reads agree. Shown on the 1080p recording, where plates are readable.',
    hold: 9000,
    early: true,
    light: ['panel', 'map'],
    run: async (c) => {
      await c.point('tile-cam08');
      await c.click('[data-tour="tile-cam08"] button[title="Open camera details"]');
      await c.wait(700);
      c.set.setDockOpen(false);
      c.set.setFocusCamera('cam08');
      // Focusing a camera starts its own flight; ours must start after it to
      // win, or the map settles at the focus zoom instead of this one.
      await c.wait(300);
      c.set.setTourView(JUNAGADH);
      await c.wait(900);
      await c.click('source-archive');
    },
  },

  /* The tools, each actually used. */
  {
    id: 'events',
    title: 'Tool 1, event search with the evidence',
    desc:
      'A partial plate, <b>GJ03</b>, typed the way an operator does with three characters '
      + 'from a witness, over the last 30 days. Every match carries the <b>plate crop</b> '
      + 'it was read from and the <b>full frame</b> with the vehicle boxed.',
    hold: 6400,
    early: true,
    light: ['events', 'panel'],
    run: async (c) => {
      c.set.setFocusCamera(null);
      await c.click('events');
      await c.wait(600);
      await c.type('events-plate', 'GJ03');
      await c.click('range-720');
    },
  },
  {
    id: 'trace',
    title: 'Tool 2, following a vehicle',
    desc:
      'A real registration, <b>GJ03PA8482</b>, read at Majevadi Gate. The search returns '
      + 'every camera that saw it in time order, and the map fits to the route.',
    hold: 6400,
    early: true,
    light: ['trace', 'panel', 'map'],
    run: async (c) => {
      await c.click('trace');
      await c.wait(600);
      await c.type('trace-plate', DEMO_PLATE);
      await c.click('trace-go');
    },
  },
  {
    id: 'watchlist',
    title: 'Tool 3, watchlist and live alerts',
    desc:
      'That same registration is on the watchlist as <b>stolen</b>, which is what makes '
      + 'a sighting an alert rather than a log line. When live detection reads a '
      + 'watchlisted plate, its box turns red and the plate is flagged.',
    hold: 5600,
    light: ['watchlist', 'panel'],
    run: async (c) => {
      c.set.setTrace(null);
      await c.click('watchlist');
    },
  },
  {
    id: 'health',
    title: 'Tool 4, knowing what is actually up',
    desc:
      'The grid reports every camera as live, including the dead ones, so its word is '
      + 'not shown as health. Cameras are <b>available</b> or <b>unavailable</b> only once '
      + 'probed; the rest are <b>unverified</b>, and the panel says so.',
    hold: 5600,
    light: ['health', 'panel'],
    run: async (c) => { await c.click('health'); },
  },

  /* Onboarding: three routes in, the last one end to end and then undone. */
  {
    id: 'onboard-bulk',
    title: 'Tool 5, onboarding by spreadsheet',
    desc:
      'Departments already keep their camera lists in spreadsheets, and none of them '
      + 'name the columns alike. Handed an RTO sheet headed <b>Device Identifier</b>, '
      + '<b>Installed At</b>, <b>GPS Lat</b>, <b>Live URL</b>, the importer matches every '
      + 'column to the registry itself and shows the mapping before anything is saved.',
    hold: 5200,
    early: true,
    light: ['panel'],
    run: async (c) => {
      await c.click('registry');
      await c.wait(600);
      await c.click('tab-bulk');
      await c.wait(400);
      await c.point('bulk-choose');
      await c.upload('bulk-file', new File([SAMPLE_SHEET], 'rto-gandhinagar-cameras.csv', { type: 'text/csv' }));
      await c.wait(900);
    },
  },
  {
    id: 'onboard-api',
    title: 'Onboarding over the API',
    desc:
      'A department\'s own system can push cameras straight into the registry. It is '
      + 'the same table the map and the wall read, so a camera sent this way is on the '
      + 'map at once, with no import step between.',
    hold: 5000,
    light: ['panel'],
    run: async (c) => { await c.click('tab-api'); },
  },
  {
    id: 'onboard',
    title: 'Onboarding by hand',
    desc:
      'Manual entry, filled in as a department would: an ID, a name, where it is, and '
      + 'the stream it serves. The example borrows Majevadi Gate\'s stream so it has a '
      + 'real feed, and is removed again at the end.',
    hold: 3000,
    early: true,
    light: ['panel'],
    run: async (c) => {
      await c.click('tab-manual');
      await c.wait(400);
      const f = (n: string) => `[data-tour="panel"] [name="${n}"]`;
      await c.type(f('id'), DEMO_CAM.id);
      await c.type(f('name'), DEMO_CAM.name);
      await c.choose(f('department_id'), DEMO_CAM.department);
      await c.type(f('district'), DEMO_CAM.district);
      await c.choose(f('cam_type'), DEMO_CAM.type);
      await c.choose(f('status'), DEMO_CAM.status);
      await c.type(f('lat'), DEMO_CAM.lat);
      await c.type(f('lng'), DEMO_CAM.lng);
      await c.type(f('hls_url'), DEMO_CAM.hls);
      await c.type(f('tags'), DEMO_CAM.tags);
      await c.click(f('anpr_capable'));
      await c.click('add-camera');
      // Wait for the form's own verdict rather than assuming success.
      for (let t = 0; t < 30 && c.live(); t++) {
        const panel = resolve('panel')?.innerText ?? '';
        if (panel.includes('saved to the registry')) {
          demoCreated = true;
          c.say('<b>DEMO-TOUR</b> is saved to the registry. The form confirms it, and '
            + 'the next step finds it on the map with its feed playing.');
          return;
        }
        if (/permission|denied|policy|violates|required/i.test(panel)) break;
        await c.wait(250);
      }
      c.say('The registry refused the new camera — adding cameras needs an admin '
        + 'session. Signed in as an administrator, this step saves it.');
    },
  },
  {
    id: 'onboarded',
    title: 'Onboarded, on the map, with its feed',
    desc:
      'The new camera is in the registry, pinned on the road where it was placed, and '
      + 'its detail view is already playing the stream it was given. Nothing else had '
      + 'to be configured.',
    hold: 7000,
    light: ['panel', 'map'],
    run: async (c) => {
      if (!demoCreated) {
        c.say('With no camera saved in the previous step, there is nothing new to show '
          + 'here. The registry panel lists every onboarded camera.');
        return;
      }
      await refreshCameras(c.qc);
      c.set.openPanel({ kind: 'camera', cameraId: DEMO_CAM.id });
      c.set.setFocusCamera(DEMO_CAM.id);
      await c.wait(300);
      c.set.setTourView({ lng: Number(DEMO_CAM.lng), lat: Number(DEMO_CAM.lat), zoom: 15.6, pitch: 50, bearing: -20, orbit: true });
    },
  },
  {
    id: 'removed',
    title: 'Removed again, back to thirty',
    desc:
      'Deleting it takes it off the map and out of the registry at once, and the audit '
      + 'log keeps the record of both changes. The estate is back to its thirty cameras.',
    hold: 5600,
    light: ['count', 'map'],
    run: async (c) => {
      c.set.closePanel();
      c.set.setFocusCamera(null);
      await removeDemoCamera(c.qc);
      c.set.setTourView(GUJARAT);
      await c.point('count');
    },
  },
  {
    id: 'end',
    title: 'That is the platform',
    desc:
      'Registry and GIS, unified viewing, live detection, ANPR with evidence, vehicle '
      + 'tracing, alerting and onboarding. Press <b>Guide</b> in the top bar to watch '
      + 'this again.',
    hold: 5600,
    light: ['map'],
    run: (c) => {
      c.set.closePanel();
      c.set.setDockOpen(false);
      c.set.setTrace(null);
      c.set.setTourView(GUJARAT);
    },
  },
];

const HIGHLIGHTS = [
  { icon: MapIcon, label: 'GIS map & layers' },
  { icon: Database, label: 'Onboarding' },
  { icon: Camera, label: 'Live detection' },
  { icon: ScanLine, label: 'ANPR evidence' },
  { icon: RouteIcon, label: 'Vehicle tracing' },
  { icon: Siren, label: 'Watchlist alerts' },
];

type Phase = 'welcome' | 'running';
interface Region { key: string; rect: DOMRect }

export function GuidedTour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>('welcome');
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [regions, setRegions] = useState<Region[]>([]);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [pressing, setPressing] = useState(false);
  const [ripple, setRipple] = useState<{ x: number; y: number; k: number } | null>(null);
  const [captionShown, setCaptionShown] = useState(false);
  const [desc, setDesc] = useState('');
  // Captions differ in length, so the card differs in height. Measuring it
  // beats assuming a number that is wrong for most steps.
  const [captionH, setCaptionH] = useState(216);
  const captionEl = useRef<HTMLDivElement | null>(null);
  // What is lit, as selectors, so the rectangles can follow layout changes —
  // a panel sliding in, the dock opening — without the step re-measuring.
  const litKeys = useRef<string[]>([]);
  // The control the cursor is on (drawn with the pulsing ring), and the
  // step's first control, which the caption stays beside for the whole step
  // rather than chasing the cursor from field to field.
  const focusKey = useRef<string | null>(null);
  const anchorKey = useRef<string | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const advance = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One clock for the whole tour. Both the step sequence and the pause toggle
  // used to write this timer independently, so the later one silently replaced
  // the earlier and every step ran for half the hold it declared.
  const deadline = useRef(0);
  // Time set aside by a pause, and only by a pause. It used to be a value the
  // clock also wrote, so a step that showed its caption early found the
  // previous step's leftover and started a clock mid-action — onboarding
  // advanced while the form was still being typed.
  const banked = useRef<number | null>(null);
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
    litKeys.current = [];
    restoreView(qc);
    onClose();
  }, [onClose, qc]);

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
    advance.current = setTimeout(() => nextRef.current(), ms);
  }, []);

  /* Keep the lit rectangles on their elements while layout moves. */
  useEffect(() => {
    if (!open || phase !== 'running') return;
    const t = setInterval(() => {
      const next = measure(litKeys.current);
      setRegions((prev) => (sameRegions(prev, next) ? prev : next));
      const a = anchorKey.current ? resolve(anchorKey.current)?.getBoundingClientRect() ?? null : null;
      setAnchorRect((prev) => (sameRect(prev, a) ? prev : a));
    }, 400);
    return () => clearInterval(t);
  }, [open, phase]);

  /* Run one step as an ordered sequence. */
  useEffect(() => {
    if (!open || phase !== 'running' || !step) return;
    let live = true;
    setCaptionShown(false);
    setDesc(step.desc);
    banked.current = null;
    // Nothing carries over from the last step. What this step demonstrates is
    // lit from the start — a panel is lit as it opens and while it is being
    // worked, not only once the work is done.
    const base = step.light ?? [];
    focusKey.current = null;
    anchorKey.current = null;
    setAnchorRect(null);
    litKeys.current = [...base];
    setRegions(measure(base));

    const showCaption = () => {
      setCaptionShown(true);
      requestAnimationFrame(() => {
        const h = captionEl.current?.offsetHeight;
        if (h) setCaptionH(h);
      });
    };

    /** Ring a control, keeping the step's regions lit around it. */
    const focus = (sel: string) => {
      focusKey.current = sel;
      if (!anchorKey.current) {
        anchorKey.current = sel;
        setAnchorRect(resolve(sel)?.getBoundingClientRect() ?? null);
      }
      litKeys.current = [sel, ...base.filter((k) => k !== sel)];
      setRegions(measure(litKeys.current));
    };

    const reveal = async (sel: string) => {
      const el = resolve(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await wait(650);
      }
      return el;
    };

    const moveTo = async (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      setCursor({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      await wait(620);
    };

    const ctx: Ctx = {
      set: useStore.getState(),
      qc,
      live: () => live,
      wait: async (ms) => { if (live) await wait(ms); },
      say: (html) => { if (live) setDesc(html); },
      light: async (keys) => {
        if (!live) return;
        litKeys.current = focusKey.current ? [focusKey.current, ...keys] : [...keys];
        setRegions(measure(litKeys.current));
      },
      point: async (sel) => {
        if (!live) return false;
        const el = await reveal(sel);
        if (!el || !live) return false;
        focus(sel);
        await moveTo(el);
        return true;
      },
      click: async (sel, opts) => {
        if (!live) return false;
        const el = await reveal(sel);
        if (!el || !live) return false;
        // The ring follows what the cursor is working on.
        focus(sel);
        await moveTo(el);
        if (!live) return false;
        setPressing(true);
        const r = el.getBoundingClientRect();
        setRipple({ x: r.left + r.width / 2, y: r.top + r.height / 2, k: Date.now() });
        await wait(160);
        setPressing(false);
        // A toggle already on is left on: clicking it would switch it off.
        if (!(opts?.onlyIfOff && el.getAttribute('aria-pressed') === 'true')) el.click();
        await wait(220);
        return true;
      },
      type: async (sel, text) => {
        if (!live) return false;
        const el = (await reveal(sel)) as HTMLInputElement | null;
        if (!el || !live) return false;
        focus(sel);
        await moveTo(el);
        el.focus();
        // React owns this input's value; set it through the native setter and
        // announce it, which is how React learns that the user typed.
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        for (let n = 1; n <= text.length && live; n++) {
          setter?.call(el, text.slice(0, n));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(text.length > 24 ? 18 : 55);
        }
        el.blur();
        return true;
      },
      upload: async (sel, file) => {
        if (!live) return false;
        const el = resolve(sel) as HTMLInputElement | null;
        if (!el || el.type !== 'file') return false;
        const dt = new DataTransfer();
        dt.items.add(file);
        el.files = dt.files;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
      choose: async (sel, value) => {
        if (!live) return false;
        const el = (await reveal(sel)) as HTMLSelectElement | null;
        if (!el || !live) return false;
        focus(sel);
        await moveTo(el);
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        setter?.call(el, value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(260);
        return true;
      },
    };

    (async () => {
      if (step.early) showCaption();

      // A failing action must not stop the walkthrough. It used to: one step's
      // fetch threw, and the rejection ended the sequence before the caption
      // or the clock — the tour froze with no way forward but Skip.
      try {
        await step.run?.(ctx);
      } catch (err) {
        console.warn(`[tour] step "${step.id}" action failed`, err);
      }
      if (!live) return;

      // Let the interface settle, then light what the step demonstrates.
      await wait(450);
      if (!live) return;
      if (focusKey.current && !resolve(focusKey.current)) focusKey.current = null;
      litKeys.current = focusKey.current
        ? [focusKey.current, ...base.filter((k) => k !== focusKey.current)]
        : [...base];
      setRegions(measure(litKeys.current));

      if (!step.early) showCaption();

      // The hold is reading time, so it starts when the caption can actually
      // be read — after the browser has painted it, not when React was asked to.
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      if (!live) return;

      if (pausedRef.current) banked.current = step.hold;
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

  /* Pausing banks the time left; resuming hands exactly that back. A pause
     during a step's actions banks nothing — no clock is running yet — and the
     step itself banks its hold when it finishes (see above). */
  useEffect(() => {
    if (!open || phase !== 'running') return;
    if (paused) {
      if (advance.current) {
        clearTimeout(advance.current);
        advance.current = null;
        banked.current = Math.max(0, deadline.current - Date.now());
      }
    } else if (banked.current !== null) {
      const ms = banked.current;
      banked.current = null;
      startClock(ms);
    }
    // Only the pause toggle drives this; the step sequence owns the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      if (e.key === ' ' && phase === 'running') {
        e.preventDefault();
        setPaused((p) => !p);
      }
      if (e.key === 'ArrowRight' && phase === 'running') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, phase, finish, next]);

  useEffect(() => {
    if (open) {
      setPhase('welcome');
      setI(0);
      setPaused(false);
      setRegions([]);
      litKeys.current = [];
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
            About three minutes over the working system: the map and its layers, the
            camera grid, live detection on a single camera, every tool, and a camera
            onboarded and removed. It drives the real interface, so everything you see
            it claim, it does.
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

  const W = window.innerWidth;
  const H = window.innerHeight;
  const primary = regions.find((r) => r.key === focusKey.current) ?? null;
  // The caption stays beside the step's first control, and never sits on a
  // lit panel or dock it is describing. Only regions that fill most of the
  // screen — the map, the full-screen grid — are allowed under it.
  // The control being worked is always kept clear too — a caption over the
  // very button the cursor is pressing hides the demonstration.
  const avoid = regions
    .filter((r) => r.rect.width * r.rect.height < W * H * 0.5)
    .map((r) => r.rect);
  const pos = captionPosition(anchorRect, captionH, avoid);

  return createPortal(
    <div className="tour-root">
      {/* The shade, with a hole for every lit region. One static layer: it
          repaints only when what is lit changes, never per frame. */}
      <svg className="tour-shade" width={W} height={H} aria-hidden>
        <defs>
          <mask id="tour-mask" maskUnits="userSpaceOnUse" x="0" y="0" width={W} height={H}>
            <rect x="0" y="0" width={W} height={H} fill="white" />
            {regions.map((r) => {
              const b = ringBox(r.rect);
              return (
                <rect
                  key={r.key}
                  className="tour-hole"
                  x={b.left} y={b.top} width={b.width} height={b.height}
                  rx="10" fill="black"
                />
              );
            })}
          </mask>
        </defs>
        <rect
          x="0" y="0" width={W} height={H}
          fill={regions.length ? 'rgba(4, 8, 15, 0.58)' : 'rgba(4, 8, 15, 0.34)'}
          mask="url(#tour-mask)"
        />
      </svg>

      {regions.map((r) => (
        <div
          key={r.key}
          className={r === primary ? 'tour-ring' : 'tour-ring tour-ring-area'}
          style={ringBox(r.rect)}
        />
      ))}

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
            dangerouslySetInnerHTML={{ __html: desc }}
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

/** Current rectangles for the lit selectors; missing or hidden ones are skipped. */
function measure(keys: string[]): Region[] {
  const out: Region[] = [];
  for (const key of keys) {
    const el = resolve(key);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    out.push({ key, rect });
  }
  return out;
}

function sameRect(a: DOMRect | null, b: DOMRect | null) {
  if (!a || !b) return a === b;
  return Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1
    && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
}

function sameRegions(a: Region[], b: Region[]) {
  if (a.length !== b.length) return false;
  return a.every((r, n) => {
    const o = b[n];
    return r.key === o.key
      && Math.abs(r.rect.left - o.rect.left) < 1 && Math.abs(r.rect.top - o.rect.top) < 1
      && Math.abs(r.rect.width - o.rect.width) < 1 && Math.abs(r.rect.height - o.rect.height) < 1;
  });
}

/**
 * The ring around a region, padded but kept on screen. A control flush with
 * the viewport edge — everything in the left rail — would otherwise have its
 * ring drawn half off the page, which reads as the highlight missing. Large
 * regions (the map, a panel) take almost no padding: they already fill space.
 */
function ringBox(r: DOMRect) {
  const PAD = r.width > 600 || r.height > 400 ? 2 : 8;
  const EDGE = 3;
  const left = Math.max(EDGE, r.left - PAD);
  const top = Math.max(EDGE, r.top - PAD);
  const right = Math.min(window.innerWidth - EDGE, r.right + PAD);
  const bottom = Math.min(window.innerHeight - EDGE, r.bottom + PAD);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
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

/**
 * Beside the step's control, never off-screen, never covering the control or
 * a lit panel it is describing.
 */
function captionPosition(rect: DOMRect | null, height: number, avoid: DOMRect[] = []) {
  const W = 384;
  const H = height || 216;
  const M = 14;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampY = (v: number) => Math.max(M, Math.min(v, vh - H - M));
  const hits = (x: number, y: number) =>
    avoid.some((r) => x < r.right && x + W > r.left && y < r.bottom && y + H > r.top);

  let x: number;
  let y: number;
  if (!rect) {
    // No control in focus: the step is about the map, so the card sits in the
    // map's bottom-left corner and the map frames its subject to the right.
    const mapLeft = document.querySelector('[data-tour="map"]')?.getBoundingClientRect().left ?? 0;
    x = Math.max(M, mapLeft + M);
    y = Math.max(M, vh - H - 36);
  } else if (rect.width < 320 && rect.right < 320) {
    // A control in the left rail gets the caption alongside it, level with
    // its middle, out over the map.
    y = clampY(rect.top + rect.height / 2 - H / 2);
    x = rect.right + M;
  } else {
    // Anything else — the top bar, a panel — keeps the caption under it,
    // flipping above when there is no room below. Beside a top-bar button
    // it would sit across its neighbours, which the tour clicks next.
    y = rect.bottom + M;
    if (y + H > vh - M) y = rect.top - H - M;
    y = clampY(y);
    x = Math.min(Math.max(M, rect.left), vw - W - M);
  }

  // Still on a lit panel? Move off it sideways, towards the open side.
  for (const r of avoid) {
    if (!hits(x, y)) break;
    const leftOf = r.left - W - M;
    const rightOf = r.right + M;
    if (leftOf >= M && !hits(leftOf, y)) x = leftOf;
    else if (rightOf + W <= vw - M && !hits(rightOf, y)) x = rightOf;
  }
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
