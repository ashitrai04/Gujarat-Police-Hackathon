import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Flame, Users } from 'lucide-react';
import { api } from '@/api/client';
import type { SceneEvent, SceneKind } from '@/api/scene';

/**
 * Crowd, fire and accident for one camera.
 *
 * The thing this screen has to get right is that its two kinds of row are not
 * equally trustworthy, and an operator must be able to see which is which
 * without reading documentation.
 *
 * A crowd row is a measurement: people were detected and counted, so it is
 * shown as a number with a severity. A fire or accident row is a screener's
 * score — the margin between positive and negative descriptions from an
 * image/text model, not a probability — so it is shown as "worth a look" with
 * the frame attached, and never with a confidence percentage, which would
 * invite the reading that the model is sure.
 *
 * The crowd strip is the part worth looking at longest. One count means very
 * little; the shape over a few hours is what says whether a place is filling
 * up, and that is the whole reason the worker records every pass rather than
 * only the passes that crossed a threshold.
 */

const KINDS: { id: SceneKind; label: string; icon: typeof Users }[] = [
  { id: 'crowd', label: 'Crowd', icon: Users },
  { id: 'fire', label: 'Fire', icon: Flame },
  { id: 'accident', label: 'Accident', icon: AlertTriangle },
];

const SEVERITY_COLOUR: Record<string, string> = {
  high: 'var(--danger, #F4506A)',
  medium: 'var(--warn, #E0A33E)',
  low: 'var(--ok, #3FB98C)',
  review: 'var(--text-mute)',
};

function when(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** A bar per pass, tall for busy. Deliberately not a line chart: the samples
 *  are irregular (a camera is visited when its turn comes round), and a line
 *  would imply the worker knows what happened between two visits. */
function CrowdStrip({ cameraId }: { cameraId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['scene.crowd', cameraId],
    queryFn: () => api.crowdSeries(cameraId, 6),
    refetchInterval: 60_000,
  });

  const series = data ?? [];
  const peak = useMemo(
    () => series.reduce((m, p) => Math.max(m, p.people), 0),
    [series],
  );

  if (isLoading) {
    return <div className="h-[46px] animate-pulse rounded-[5px]"
      style={{ background: 'var(--surface-2)' }} />;
  }
  if (!series.length) {
    return (
      <div
        className="flex h-[46px] items-center justify-center rounded-[5px] text-[10px]"
        style={{ background: 'var(--surface-2)', color: 'var(--text-mute)' }}
      >
        No counts recorded in the last 6 hours
      </div>
    );
  }

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wide"
          style={{ color: 'var(--text-mute)' }}>
          People · last 6h
        </span>
        <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
          peak {peak}
        </span>
      </div>
      <div className="flex h-[46px] items-end gap-[2px] rounded-[5px] p-1"
        style={{ background: 'var(--surface-2)' }}>
        {series.slice(-60).map((p) => (
          <div
            key={p.at}
            title={`${p.people} people · ${new Date(p.at).toLocaleTimeString()}`}
            className="min-w-[2px] flex-1 rounded-[1px]"
            style={{
              // Against the window's own peak, so a quiet camera still shows
              // its shape instead of a flat line of one-pixel bars.
              height: `${peak ? Math.max(6, (p.people / peak) * 100) : 6}%`,
              background: p.people >= 60 ? SEVERITY_COLOUR.high
                : p.people >= 25 ? SEVERITY_COLOUR.medium
                  : 'var(--accent, #3FB98C)',
              opacity: p.people ? 1 : 0.25,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function Row({ e, onZoom }: { e: SceneEvent; onZoom: (url: string) => void }) {
  const icon = KINDS.find((k) => k.id === e.kind)?.icon ?? Users;
  const Icon = icon;
  const screened = e.method === 'zero-shot';

  return (
    <div
      className="flex gap-2 rounded-[5px] p-1.5"
      style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}
    >
      {e.snapshotUrl ? (
        <button
          type="button"
          onClick={() => onZoom(e.snapshotUrl!)}
          className="h-[44px] w-[62px] shrink-0 overflow-hidden rounded-[3px]"
          style={{ background: '#05090F' }}
          title="Open the frame full size"
        >
          <img src={e.snapshotUrl} alt={`${e.kind} at ${e.seenAt}`}
            className="h-full w-full object-cover" />
        </button>
      ) : (
        <div
          className="flex h-[44px] w-[62px] shrink-0 items-center justify-center rounded-[3px]"
          style={{ background: '#05090F', color: 'var(--text-mute)' }}
          title="No frame stored for this pass"
        >
          <Icon size={13} />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Icon size={11} style={{ color: SEVERITY_COLOUR[e.severity] }} />
          <span className="text-[11px] font-medium capitalize">{e.kind}</span>

          {/* The distinction that matters, stated on every row rather than
              explained once somewhere else. */}
          <span
            className="rounded-[3px] px-1 text-[9px] uppercase tracking-wide"
            style={{
              background: screened ? 'transparent' : 'var(--surface-3, #1b2430)',
              border: screened ? '1px dashed var(--line)' : '1px solid var(--line)',
              color: 'var(--text-mute)',
            }}
            title={screened
              ? 'Screened by an image/text model. A lead to check, not a finding.'
              : 'Detected and counted.'}
          >
            {screened ? 'screened' : 'measured'}
          </span>

          <span className="ml-auto text-[10px] tabular-nums"
            style={{ color: 'var(--text-mute)' }}>
            {when(e.seenAt)}
          </span>
        </div>

        <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-mute)' }}>
          {e.kind === 'crowd' && e.peoplePeak !== null
            ? <>peak <span className="tabular-nums"
              style={{ color: 'var(--text)' }}>{e.peoplePeak}</span>
              {e.peopleMean !== null ? <> · mean <span className="tabular-nums">
                {e.peopleMean.toFixed(1)}</span></> : null}</>
            // A margin, shown as a margin. No percentage: this is not a
            // probability and formatting it as one would misrepresent it.
            : <>margin <span className="tabular-nums" style={{ color: 'var(--text)' }}>
              {e.score !== null ? e.score.toFixed(3) : '—'}</span>
              {' · '}{e.framesHit}/{e.framesSeen} frames</>}
        </div>
      </div>
    </div>
  );
}

export function SceneView({ cameraId }: { cameraId: string }) {
  const [kind, setKind] = useState<SceneKind | 'all'>('all');
  const [zoom, setZoom] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['scene.events', cameraId],
    queryFn: () => api.sceneEvents({ cameraId, limit: 60 }),
    refetchInterval: 60_000,
  });

  const events = useMemo(
    () => (data ?? []).filter((e) => kind === 'all' || e.kind === kind),
    [data, kind],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of data ?? []) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [data]);

  return (
    <div className="flex flex-col gap-2">
      <CrowdStrip cameraId={cameraId} />

      <div className="flex items-center gap-1">
        <Chip active={kind === 'all'} onClick={() => setKind('all')}>
          All{data?.length ? ` (${data.length})` : ''}
        </Chip>
        {KINDS.map((k) => (
          <Chip key={k.id} active={kind === k.id} onClick={() => setKind(k.id)}>
            {k.label}{counts[k.id] ? ` (${counts[k.id]})` : ''}
          </Chip>
        ))}
      </div>

      {error ? (
        <Note>
          Could not read scene events — {(error as Error).message}
        </Note>
      ) : isLoading ? (
        <Note>Loading…</Note>
      ) : !events.length ? (
        <Note>
          Nothing recorded for this camera yet. The scene worker writes a crowd
          count on every pass; fire and accident only when something scores
          close to their thresholds.
        </Note>
      ) : (
        <div className="flex flex-col gap-1">
          {events.map((e) => <Row key={e.id} e={e} onZoom={setZoom} />)}
        </div>
      )}

      {zoom ? (
        <button
          type="button"
          onClick={() => setZoom(null)}
          className="fixed inset-0 z-[200] flex items-center justify-center p-6"
          style={{ background: 'rgba(3,6,11,.88)' }}
        >
          <img src={zoom} alt="Scene frame, full size"
            className="max-h-full max-w-full rounded-[6px] object-contain" />
        </button>
      ) : null}
    </div>
  );
}

function Chip({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[4px] px-1.5 py-[3px] text-[10px]"
      style={{
        background: active ? 'var(--surface-3, #1b2430)' : 'transparent',
        border: '1px solid var(--line)',
        color: active ? 'var(--text)' : 'var(--text-mute)',
      }}
    >
      {children}
    </button>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[5px] p-2 text-[10px] leading-relaxed"
      style={{ background: 'var(--surface-2)', color: 'var(--text-mute)' }}>
      {children}
    </div>
  );
}
