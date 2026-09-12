import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  Alert,
  Camera,
  CameraStatus,
  CamType,
  Domain,
  Role,
  Route,
} from '@/api/types';

export type BaseStyle = 'dark' | 'satellite' | 'streets' | 'light' | 'outdoors';

export const BASE_STYLES: Record<BaseStyle, { label: string; url: string }> = {
  dark: { label: 'Dark', url: 'mapbox://styles/mapbox/dark-v11' },
  satellite: { label: 'Satellite', url: 'mapbox://styles/mapbox/satellite-streets-v12' },
  streets: { label: 'Streets', url: 'mapbox://styles/mapbox/streets-v12' },
  light: { label: 'Light', url: 'mapbox://styles/mapbox/light-v11' },
  outdoors: { label: 'Terrain', url: 'mapbox://styles/mapbox/outdoors-v12' },
};

/**
 * Reference points an operator reasons about while following a vehicle.
 * Toll plazas and railway stations are here for a specific reason: a vehicle
 * leaving the state passes a toll, and those are the natural interception
 * points on a traced route.
 */
export type PoiLayer =
  | 'hospital' | 'police' | 'fuel' | 'bus_station' | 'toll' | 'railway';

/**
 * Gujarat GIS overlays from the supplied GeoPackage. The file's `cameras`
 * layer is deliberately absent — camera geography comes from the live
 * registry, not a static snapshot.
 */
/**
 * Where the walkthrough wants the map looking: a point and zoom, or an area
 * to frame. An area is better whenever the subject has a shape — a state
 * framed by its bounds fits any screen, where a fixed zoom that fits one
 * monitor shows half a neighbouring state on a wider one.
 */
export type TourView = {
  k: number;
  pitch?: number;
  /** Compass heading in degrees; 0 is north up. */
  bearing?: number;
  /** South-west and north-east corners, [lng, lat]. Wins over a point. */
  bounds?: [[number, number], [number, number]];
  lng?: number;
  lat?: number;
  zoom?: number;
  /** Turn slowly after arriving, so a held view stays alive. */
  orbit?: boolean;
  /** Start from the whole globe and descend to the target. */
  intro?: boolean;
};

export type GisLayer = 'state' | 'districts' | 'highways' | 'roads';

export type RightPanel =
  | { kind: 'none' }
  | { kind: 'camera'; cameraId: string }
  | { kind: 'alert'; alertId: string }
  | { kind: 'trace' }
  | { kind: 'watchlist' }
  | { kind: 'events' }
  | { kind: 'health' }
  | { kind: 'registry' };

export const ALL_CAM_TYPES: CamType[] = ['fixed', 'ptz'];

export const ALL_DOMAINS: Domain[] = ['traffic', 'hospital', 'pds', 'rto', 'public'];

interface State {
  /* Map */
  baseStyle: BaseStyle;
  globe: boolean;
  pitch: number;
  setBaseStyle: (s: BaseStyle) => void;
  toggleGlobe: () => void;
  setPitch: (p: number) => void;

  /* Layers */
  domains: Domain[];
  statuses: CameraStatus[];
  anprOnly: boolean;
  query: string;
  showBoundaries: boolean;
  showHeat: boolean;
  showGaps: boolean;
  pois: PoiLayer[];
  gis: GisLayer[];
  toggleDomain: (d: Domain) => void;
  camTypes: CamType[];
  toggleCamType: (t: CamType) => void;
  toggleStatus: (s: CameraStatus) => void;
  setAnprOnly: (v: boolean) => void;
  setQuery: (q: string) => void;
  toggleBoundaries: () => void;
  toggleHeat: () => void;
  toggleGaps: () => void;
  togglePoi: (p: PoiLayer) => void;
  toggleGis: (g: GisLayer) => void;
  clearFilters: () => void;

  /* Selection */
  selectedCameraId: string | null;
  selectCamera: (id: string | null) => void;
  selectedDistrict: string | null;
  selectDistrict: (d: string | null) => void;

  /* Video wall */
  wallCameraIds: string[];
  wallLayout: 0 | 1 | 4 | 9 | 16;   // 0 = auto-fill
  dockOpen: boolean;
  addToWall: (ids: string | string[]) => void;
  removeFromWall: (id: string) => void;
  clearWall: () => void;
  /** Replace the wall wholesale — used to prune ids no camera answers to. */
  setWall: (ids: string[]) => void;
  setWallLayout: (n: 0 | 1 | 4 | 9 | 16) => void;
  setDockOpen: (v: boolean) => void;

  /* Chrome */
  railCollapsed: boolean;
  setRailCollapsed: (v: boolean) => void;
  toggleRail: () => void;
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
  /** Camera shown alone, full screen (from a map pin or a tile). */
  soloCameraId: string | null;
  setSoloCamera: (id: string | null) => void;
  /** Pin action menu anchored at a screen position. */
  pinMenu: { cameraId: string; x: number; y: number } | null;
  setPinMenu: (m: { cameraId: string; x: number; y: number } | null) => void;
  dockH: number;
  setDockH: (n: number) => void;
  wallFullscreen: boolean;
  toggleWallFullscreen: () => void;

  /* Right panel */
  panel: RightPanel;
  openPanel: (p: RightPanel) => void;
  closePanel: () => void;

  /* Alerts */
  alerts: Alert[];
  unread: number;
  pushAlert: (a: Alert) => void;
  setAlerts: (a: Alert[]) => void;
  acknowledge: (id: string) => void;
  clearUnread: () => void;
  /** Camera the map should fly to and pulse; cleared once consumed. */
  focusCameraId: string | null;
  setFocusCamera: (id: string | null) => void;

  /* Where the walkthrough wants the map looking. `k` makes each request
     distinct, so asking for the same view twice still moves the map. */
  tourView: TourView | null;
  setTourView: (v: Omit<TourView, 'k'>) => void;

  /* A search to open the event panel on. Lets something other than the panel
     — the walkthrough, a link from an alert — ask for a specific query rather
     than the empty default. */
  eventsPreset: { plate?: string; hours?: number; k: number } | null;
  presetEvents: (p: { plate?: string; hours?: number }) => void;

  /* Tracking */
  trace: Route | null;
  traceProgress: number;
  tracePlaying: boolean;
  setTrace: (r: Route | null) => void;
  setTraceProgress: (n: number) => void;
  setTracePlaying: (v: boolean) => void;

  /* Access */
  role: Role;
  setRole: (r: Role) => void;
  visibleCameras: (all: Camera[]) => Camera[];
}

export const useStore = create<State>()(
  persist(
    (set, get) => ({
  baseStyle: 'satellite',
  globe: false,
  pitch: 0,
  setBaseStyle: (baseStyle) => set({ baseStyle }),
  toggleGlobe: () => set((s) => ({ globe: !s.globe })),
  setPitch: (pitch) => set({ pitch }),

  domains: [...ALL_DOMAINS],
  // Camera capability, separate from department. An operator hunting a plate
  // wants only the cameras that can read one, regardless of who owns them.
  camTypes: [...ALL_CAM_TYPES],
  toggleCamType: (t) =>
    set((x) => ({
      camTypes: x.camTypes.includes(t)
        ? x.camTypes.filter((y) => y !== t)
        : [...x.camTypes, t],
    })),
  statuses: ['online', 'offline', 'degraded'],
  anprOnly: false,
  query: '',
  showBoundaries: true,
  showHeat: false,
  showGaps: false,
  pois: [],
  gis: [],
  toggleDomain: (d) =>
    set((s) => ({
      domains: s.domains.includes(d)
        ? s.domains.filter((x) => x !== d)
        : [...s.domains, d],
    })),
  toggleStatus: (v) =>
    set((s) => ({
      statuses: s.statuses.includes(v)
        ? s.statuses.filter((x) => x !== v)
        : [...s.statuses, v],
    })),
  setAnprOnly: (anprOnly) => set({ anprOnly }),
  setQuery: (query) => set({ query }),
  toggleBoundaries: () => set((s) => ({ showBoundaries: !s.showBoundaries })),
  toggleHeat: () => set((s) => ({ showHeat: !s.showHeat })),
  toggleGaps: () => set((s) => ({ showGaps: !s.showGaps })),
  togglePoi: (p) =>
    set((s) => ({
      pois: s.pois.includes(p) ? s.pois.filter((x) => x !== p) : [...s.pois, p],
    })),
  toggleGis: (g) =>
    set((s) => ({
      gis: s.gis.includes(g) ? s.gis.filter((x) => x !== g) : [...s.gis, g],
    })),
  clearFilters: () =>
    set({
      domains: [...ALL_DOMAINS],
  // Camera capability, separate from department. An operator hunting a plate
  // wants only the cameras that can read one, regardless of who owns them.
  camTypes: [...ALL_CAM_TYPES],
  toggleCamType: (t) =>
    set((x) => ({
      camTypes: x.camTypes.includes(t)
        ? x.camTypes.filter((y) => y !== t)
        : [...x.camTypes, t],
    })),
      statuses: ['online', 'offline', 'degraded'],
      anprOnly: false,
      query: '',
    }),

  selectedCameraId: null,
  selectCamera: (selectedCameraId) => set({ selectedCameraId }),
  selectedDistrict: null,
  selectDistrict: (selectedDistrict) => set({ selectedDistrict }),

  wallCameraIds: [],
  wallLayout: 0,
  dockOpen: false,
  addToWall: (ids) =>
    set((s) => {
      const add = Array.isArray(ids) ? ids : [ids];
      const next = [...new Set([...s.wallCameraIds, ...add])].slice(0, 16);
      // Grow the layout to fit rather than silently hiding tiles.
      const layout: 0 | 1 | 4 | 9 | 16 =
        next.length <= 1 ? 1 : next.length <= 4 ? 4 : next.length <= 9 ? 9 : 16;
      return {
        wallCameraIds: next,
        dockOpen: next.length > 0,
        // Auto (0) adapts by itself, so never override it.
        wallLayout: s.wallLayout === 0 ? 0 : (Math.max(layout, s.wallLayout) as 0 | 1 | 4 | 9 | 16),
      };
    }),
  removeFromWall: (id) =>
    set((s) => ({ wallCameraIds: s.wallCameraIds.filter((x) => x !== id) })),
  clearWall: () => set({ wallCameraIds: [], dockOpen: false }),
  setWall: (wallCameraIds) => set({ wallCameraIds }),
  setWallLayout: (wallLayout) => set({ wallLayout }),
  setDockOpen: (dockOpen) => set({ dockOpen }),

  railCollapsed: false,
  setRailCollapsed: (railCollapsed) => set({ railCollapsed }),
  toggleRail: () => set((s) => ({ railCollapsed: !s.railCollapsed })),
  pickerOpen: false,
  setPickerOpen: (pickerOpen) => set({ pickerOpen }),
  soloCameraId: null,
  setSoloCamera: (soloCameraId) => set({ soloCameraId }),
  pinMenu: null,
  setPinMenu: (pinMenu) => set({ pinMenu }),
  dockH: 300,
  setDockH: (dockH) => set({ dockH: Math.max(150, Math.min(900, dockH)) }),
  wallFullscreen: false,
  toggleWallFullscreen: () => set((s) => ({ wallFullscreen: !s.wallFullscreen })),

  panel: { kind: 'none' },
  openPanel: (panel) => set({ panel }),
  closePanel: () => set({ panel: { kind: 'none' } }),

  alerts: [],
  unread: 0,
  pushAlert: (a) =>
    set((s) => ({
      alerts: [a, ...s.alerts].slice(0, 200),
      unread: s.unread + 1,
      // Don't fly the map away while a route is being played back.
      focusCameraId: s.tracePlaying ? s.focusCameraId : a.cameraId,
    })),
  setAlerts: (alerts) => set({ alerts }),
  acknowledge: (id) =>
    set((s) => ({
      alerts: s.alerts.map((a) => (a.id === id ? { ...a, status: 'ack' } : a)),
    })),
  clearUnread: () => set({ unread: 0 }),
  focusCameraId: null,
  setFocusCamera: (focusCameraId) => set({ focusCameraId }),

  tourView: null,
  setTourView: (v) => set({ tourView: { ...v, k: Date.now() } }),

  eventsPreset: null,
  presetEvents: (p) => set({ eventsPreset: { ...p, k: Date.now() } }),

  trace: null,
  traceProgress: 1,
  tracePlaying: false,
  setTrace: (trace) => set({ trace, traceProgress: trace ? 0 : 1 }),
  setTraceProgress: (traceProgress) => set({ traceProgress }),
  setTracePlaying: (tracePlaying) => set({ tracePlaying }),

  role: 'state-admin',
  setRole: (role) => set({ role }),
  visibleCameras: (all) => {
    const { role } = get();
    if (role === 'state-admin') return all;
    if (role === 'district-officer')
      return all.filter((c) => c.district === 'Junagadh');
    return all.filter((c) => c.domain === 'hospital');
  },
}),
    {
      name: 'sentinel-ui',
      storage: createJSONStorage(() => localStorage),
      /**
       * The grid renumbered its cameras from `1..30` to `cam01..cam30`. A
       * persisted wall still holding the old identifiers matches nothing, so
       * the header counted sixteen cameras while the wall rendered none — the
       * saved state was not corrupt, it was addressing cameras that no longer
       * exist under those names.
       *
       * Bumping the version drops that wall once. It is the honest trade:
       * losing a saved layout is a small cost, and a wall that silently shows
       * nothing is a large one.
       */
      version: 2,
      migrate: (persisted, from) => {
        const state = persisted as Record<string, unknown>;
        if (from < 2) state.wallCameraIds = [];
        return state;
      },
      // Restore the operator's workspace, not transient data. Alerts and
      // traces come back from the API; filters reset intentionally so a
      // fresh session always starts from the full picture.
      partialize: (s) => ({
        baseStyle: s.baseStyle,
        wallCameraIds: s.wallCameraIds,
        wallLayout: s.wallLayout,
        dockOpen: s.dockOpen,
        railCollapsed: s.railCollapsed,
        pois: s.pois,
        gis: s.gis,
        showBoundaries: s.showBoundaries,
        dockH: s.dockH,
      }),
    },
  ),
);

// Dev-only handle so the console (and automated checks) can drive state.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__SENTINEL_STORE__ = useStore;
}
