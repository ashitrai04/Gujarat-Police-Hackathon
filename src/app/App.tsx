import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, subscribeAlerts } from '@/api/client';
import { MapView } from '@/map/MapView';
import { CommandBar } from './CommandBar';
import { LeftRail } from './LeftRail';
import { RightPanel } from './RightPanel';
import { VideoWall } from '@/features/videowall/VideoWall';
import { CameraPicker } from '@/features/cameras/CameraPicker';
import { PinMenu } from '@/features/cameras/PinMenu';
import { SoloCamera } from '@/features/cameras/SoloCamera';
import { useStore } from './store';

export function App() {
  const dockOpen = useStore((s) => s.dockOpen);
  const pickerOpen = useStore((s) => s.pickerOpen);
  const setPickerOpen = useStore((s) => s.setPickerOpen);
  const panel = useStore((s) => s.panel);
  const setAlerts = useStore((s) => s.setAlerts);
  const pushAlert = useStore((s) => s.pushAlert);
  const openPanel = useStore((s) => s.openPanel);

  const { data: seeded } = useQuery({ queryKey: ['alerts'], queryFn: api.alerts });
  const { data: allCams } = useQuery({ queryKey: ['cameras.all'], queryFn: () => api.cameras() });

  // A control room never boots to a blank wall. If nothing is loaded, bring
  // up the ANPR-capable online cameras so there is always a live grid.
  const addToWall = useStore((s) => s.addToWall);
  const didSeedWall = useRef(false);
  useEffect(() => {
    if (!allCams || didSeedWall.current) return;
    didSeedWall.current = true;
    if (useStore.getState().wallCameraIds.length > 0) return;
    const defaults = allCams
      .filter((c) => c.status === 'online' && c.geoKnown)
      .sort((a, b) => (b.bitsPerPixel ?? 0) - (a.bitsPerPixel ?? 0))
      .slice(0, 6)
      .map((c) => c.id);
    if (defaults.length) addToWall(defaults);
  }, [allCams, addToWall]);

  useEffect(() => {
    if (seeded) setAlerts(seeded);
  }, [seeded, setAlerts]);

  useEffect(() => {
    // Realtime delivers the bare row without its joins, so the panel refetches
    // rather than rendering a half-populated card.
    return subscribeAlerts(() => {
      void api.alerts().then((rows) => {
        const latest = rows[0];
        if (!latest) return;
        pushAlert(latest);
        // Only surface the alert panel if the operator is not already working
        // in another one. Stealing focus mid-trace loses their place; the
        // bell's unread badge and the map pulse are enough to signal a match.
        if (useStore.getState().panel.kind === 'none') {
          openPanel({ kind: 'alert', alertId: latest.id });
        }
      });
    });
  }, [pushAlert, openPanel]);

  // The panel is ALWAYS an overlay anchored to the map's right edge. Giving it
  // its own flex column could make the row exceed the viewport at certain
  // width/zoom combinations, pushing it off-screen entirely.
  const panelFloating = panel.kind !== 'none';

  return (
    <div
      className="relative flex h-full w-full flex-col overflow-hidden"
      style={{ background: 'var(--ink)' }}
    >
      <CommandBar />

      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <LeftRail />

        {/* The map leads. It keeps its width; panels dock over it. */}
        <main
          className="relative min-w-0 flex-1"
          /* Content centred inside the map must avoid the floating panel. */
          style={{ ["--panel-inset" as string]: panelFloating ? "var(--panel-w)" : "0px" }}
        >
          <MapView />
          <MapFooter />

          {panelFloating && (
            <div
              className="absolute inset-y-0 right-0 z-30 max-w-full"
              style={{ boxShadow: 'var(--sh-lg)' }}
            >
              <RightPanel />
            </div>
          )}
        </main>
      </div>

      <VideoWall />
      {!dockOpen && <DockHandle />}
      {pickerOpen && <CameraPicker onClose={() => setPickerOpen(false)} />}
      <PinMenu />
      <SoloCamera />
    </div>
  );
}

function DockHandle() {
  const wall = useStore((s) => s.wallCameraIds);
  const setDockOpen = useStore((s) => s.setDockOpen);
  if (!wall.length) return null;
  return (
    <button
      onClick={() => setDockOpen(true)}
      className="absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-[6px] px-3 py-1.5 text-[11px]"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        color: 'var(--text-dim)',
        boxShadow: 'var(--sh-md)',
      }}
    >
      Show video wall ({wall.length})
    </button>
  );
}

function MapFooter() {
  return (
    <div
      className="pointer-events-none absolute bottom-0 left-0 z-10 max-w-[60%] truncate px-2.5 py-1 text-[9.5px]"
      style={{ color: 'var(--text-mute)' }}
    >
      © Mapbox · © OpenStreetMap contributors · Boundaries: udit-001/india-maps-data
    </div>
  );
}
