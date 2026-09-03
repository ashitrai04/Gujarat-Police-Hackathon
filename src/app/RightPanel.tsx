import { useQuery } from '@tanstack/react-query';
import { X, MonitorPlay, MapPin, Crosshair, Radio } from 'lucide-react';
import { api } from '@/api/client';
import { useStore } from './store';
import { Button, Card, Empty, Pill, SectionHeader } from '@/components/ui';
import { CameraPlayer } from '@/components/CameraPlayer';
import { CATEGORY_COLOR, DOMAIN_COLOR, DOMAIN_LABEL } from '@/api/types';
import { TracePanel } from '@/features/tracking/TracePanel';
import { WatchlistPanel } from '@/features/alerts/WatchlistPanel';
import { EventsPanel } from '@/features/events/EventsPanel';
import { OnboardingPanel } from '@/features/onboarding/OnboardingPanel';
import { HealthPanel } from '@/features/health/HealthPanel';
import { formatDistanceToNow } from 'date-fns';

export function RightPanel() {
  const panel = useStore((s) => s.panel);
  const closePanel = useStore((s) => s.closePanel);

  const title =
    panel.kind === 'camera' ? 'Camera'
    : panel.kind === 'alert' ? 'Alerts'
    : panel.kind === 'trace' ? 'Vehicle trace'
    : panel.kind === 'watchlist' ? 'Watchlist'
    : panel.kind === 'events' ? 'Event search'
    : panel.kind === 'health' ? 'Camera health'
    : panel.kind === 'registry' ? 'Camera registry & onboarding'
    : '';

  return (
    <aside
      className="anim-slide-in z-20 flex h-full shrink-0 flex-col"
      style={{
        width: 'min(var(--panel-w), 100vw)',
        background: 'var(--surface)',
        borderLeft: '1px solid var(--line)',
      }}
    >
      <div
        className="flex shrink-0 items-center justify-between px-3"
        style={{ height: 'var(--bar-h)', borderBottom: '1px solid var(--line)' }}
      >
        <span className="panel-title">{title}</span>
        <button
          onClick={closePanel}
          className="rounded-[5px] p-1 hover:bg-[var(--surface-2)]"
          style={{ color: 'var(--text-dim)' }}
          aria-label="Close panel"
        >
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {panel.kind === 'camera' && <CameraDetail cameraId={panel.cameraId} />}
        {panel.kind === 'alert' && <AlertsFeed />}
        {panel.kind === 'trace' && <TracePanel />}
        {panel.kind === 'watchlist' && <WatchlistPanel />}
        {panel.kind === 'events' && <EventsPanel />}
        {panel.kind === 'health' && <HealthPanel />}
        {panel.kind === 'registry' && <OnboardingPanel />}
      </div>
    </aside>
  );
}

/* ── Camera detail ───────────────────────────────────────────── */
function CameraDetail({ cameraId }: { cameraId: string }) {
  const { data: cams } = useQuery({ queryKey: ['cameras.all'], queryFn: () => api.cameras() });
  const { data: dets } = useQuery({
    queryKey: ['detections', cameraId],
    queryFn: () => api.detections({ cameraId, limit: 8 }),
  });
  const addToWall = useStore((s) => s.addToWall);
  const cam = cams?.find((c) => c.id === cameraId);

  if (!cam) return <Empty>Select a camera pin on the map to see its detail.</Empty>;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div>
        <div className="display text-[15px] font-semibold" style={{ color: 'var(--text)' }}>
          {cam.name}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Pill mono>{cam.id}</Pill>
          <Pill colour={DOMAIN_COLOR[cam.domain]}>{DOMAIN_LABEL[cam.domain]}</Pill>
          {cam.anprCapable ? (
            <Pill colour="var(--signal)">ANPR</Pill>
          ) : (
            <Pill>Overview only</Pill>
          )}
        </div>
      </div>

      {/* Live preview — the actual stream, not a placeholder */}
      <CameraPlayer camera={cam} className="aspect-video w-full" />

      <Button variant="primary" onClick={() => addToWall(cam.id)} className="w-full">
        <MonitorPlay size={13} /> Add to video wall
      </Button>

      <Card>
        <SectionHeader>Metadata</SectionHeader>
        <dl className="px-3 pb-3 text-[12px]">
          <Row k="Department" v={cam.department} />
          <Row k="District" v={cam.district} />
          <Row k="Zone" v={cam.zoneId} mono />
          <Row k="Type" v={cam.camType.toUpperCase()} />
          <Row k="Coordinates" v={`${cam.lat.toFixed(4)}, ${cam.lng.toFixed(4)}`} mono />
          <Row k="Stream" v={cam.streamUrl.replace(/^https?:\/\//, '')} mono />
        </dl>
      </Card>

      <Card>
        <SectionHeader>Recent reads</SectionHeader>
        {!dets?.length ? (
          <Empty>No plate reads yet from this camera.</Empty>
        ) : (
          <ul className="px-3 pb-3">
            {dets.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between border-b py-1.5 last:border-0"
                style={{ borderColor: 'var(--line-soft)' }}
              >
                <span className="mono text-[12px]" style={{ color: 'var(--signal)' }}>
                  {d.plate}
                </span>
                <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
                  {new Date(d.timestamp).toLocaleTimeString('en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <dt style={{ color: 'var(--text-mute)' }}>{k}</dt>
      <dd className={`text-right ${mono ? 'mono text-[11px]' : ''}`} style={{ color: 'var(--text)' }}>
        {v}
      </dd>
    </div>
  );
}

/* ── Alerts feed ─────────────────────────────────────────────── */
function AlertsFeed() {
  const alerts = useStore((s) => s.alerts);
  const acknowledge = useStore((s) => s.acknowledge);
  const setFocusCamera = useStore((s) => s.setFocusCamera);
  const setTrace = useStore((s) => s.setTrace);
  const openPanel = useStore((s) => s.openPanel);

  if (!alerts.length) {
    return <Empty>No alerts yet. Matches against the active watchlist will appear here.</Empty>;
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      {alerts.map((a) => {
        const colour = CATEGORY_COLOR[a.category];
        const isNew = a.status === 'new';
        return (
          <Card
            key={a.id}
            className="anim-slide-in overflow-hidden"
            style={{ borderColor: isNew ? colour : 'var(--line)' }}
          >
            <div
              className="flex items-center justify-between px-3 py-1.5"
              style={{ background: isNew ? `${colour}18` : 'transparent' }}
            >
              <span
                className="text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: colour }}
              >
                {a.category} match
              </span>
              <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
                {formatDistanceToNow(new Date(a.timestamp), { addSuffix: true })}
              </span>
            </div>

            <div className="px-3 pb-3 pt-1">
              <div className="mono text-[17px] font-semibold" style={{ color: 'var(--text)' }}>
                {a.plate}
              </div>
              <div className="mt-0.5 flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-dim)' }}>
                <MapPin size={10} /> {a.cameraName}
              </div>

              <div className="mt-2.5 flex gap-1.5">
                <Button onClick={() => setFocusCamera(a.cameraId)}>
                  <Crosshair size={12} /> Locate
                </Button>
                <Button
                  onClick={async () => {
                    const r = await api.route(a.plate);
                    setTrace(r);
                    openPanel({ kind: 'trace' });
                  }}
                >
                  <Radio size={12} /> Trace
                </Button>
                {isNew && (
                  <Button
                    variant="primary"
                    className="ml-auto"
                    onClick={() => {
                      acknowledge(a.id);
                      api.ackAlert(a.id);
                    }}
                  >
                    Acknowledge
                  </Button>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
