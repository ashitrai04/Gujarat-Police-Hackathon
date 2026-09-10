import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { api } from '@/api/client';
import { Button, Card, Empty, SectionHeader } from '@/components/ui';
import { probeAll, type StreamHealth } from '@/api/health';
import { useStreamHealth } from '@/api/useStreamHealth';
import { DOMAIN_COLOR, DOMAIN_LABEL, STATUS_COLOR, type Domain } from '@/api/types';
import { useStore } from '@/app/store';

const SWEEP_KEY = ['stream.health.sweep'];

/**
 * What is actually playable, as measured — not what the grid says.
 *
 * The grid reports every camera as live, the dead ones included, so its status
 * field cannot be shown as health. Only a probe tells a working stream from a
 * dead one, and the grid limits how much probing it tolerates: it revokes a
 * session that fetches too hard, and its own guidance is to open only what is
 * being watched. So cameras fall into three groups, and the panel says which:
 *
 *   available    probed, and serving a playable stream
 *   unavailable  probed, and not
 *   unverified   not probed — the grid claims it is live; nobody has checked
 *
 * Wall cameras are probed continuously. Everything else is probed when an
 * operator asks, by a sweep paced slowly enough that the grid does not treat
 * it as abuse. Presenting the unverified cameras as "online" — which this panel
 * used to — reported exactly the claim it exists to check.
 */
export function HealthPanel() {
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health });
  const { data: cams } = useQuery({ queryKey: ['cameras.all'], queryFn: () => api.cameras() });
  const setFocusCamera = useStore((s) => s.setFocusCamera);
  const qc = useQueryClient();

  const { data: wallHealth } = useStreamHealth();
  const { data: sweep } = useQuery<Record<string, StreamHealth>>({
    queryKey: SWEEP_KEY,
    queryFn: () => Promise.resolve({}),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const runSweep = async () => {
    if (!cams?.length || progress) return;
    setProgress({ done: 0, total: cams.length });
    try {
      const result = await probeAll(cams, 1, (done, total) => setProgress({ done, total }));
      qc.setQueryData(SWEEP_KEY, result);
    } finally {
      setProgress(null);
    }
  };

  // The newest check of each camera wins, whichever route produced it.
  const measured = useMemo(() => {
    const out: Record<string, StreamHealth> = { ...(sweep ?? {}) };
    for (const [id, h] of Object.entries(wallHealth ?? {})) {
      if (!out[id] || out[id].checkedAt < h.checkedAt) out[id] = h;
    }
    return out;
  }, [sweep, wallHealth]);

  const counts = useMemo(() => {
    const c = { available: 0, unavailable: 0, unverified: 0 };
    for (const cam of cams ?? []) {
      const st = measured[cam.id]?.state;
      if (st === 'available') c.available++;
      else if (st === 'unavailable') c.unavailable++;
      else c.unverified++;
    }
    return c;
  }, [cams, measured]);

  const byDomain = useMemo(() => {
    if (!cams) return [];
    const m = new Map<Domain, number>();
    for (const c of cams) m.set(c.domain, (m.get(c.domain) ?? 0) + 1);
    return [...m.entries()].map(([d, count]) => ({
      domain: DOMAIN_LABEL[d],
      count,
      fill: DOMAIN_COLOR[d],
    }));
  }, [cams]);

  const down = useMemo(
    () => (cams ?? []).filter((c) => measured[c.id]?.state === 'unavailable'),
    [cams, measured],
  );

  if (!health || !cams) return <Empty>Loading camera health…</Empty>;

  const pct = (n: number) => Math.round((n / health.total) * 100);

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Available" value={counts.available} colour={STATUS_COLOR.online} sub="measured" />
        <Stat label="Unavailable" value={counts.unavailable} colour={STATUS_COLOR.offline} sub="measured" />
        <Stat label="Unverified" value={counts.unverified} colour="var(--text-dim)" sub="grid says live" />
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={runSweep} disabled={!!progress}>
          <RefreshCw size={12} className={progress ? 'animate-spin' : ''} />
          {progress ? `Checked ${progress.done} of ${progress.total}` : 'Check all cameras'}
        </Button>
        <span className="text-[10px] leading-snug" style={{ color: 'var(--text-mute)' }}>
          {progress
            ? 'Paced one at a time — the grid revokes sessions that probe in bursts.'
            : 'Wall cameras are checked continuously; the rest on request.'}
        </span>
      </div>

      <Card>
        <SectionHeader
          right={
            <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
              {health.anprCapable}/{health.total}
            </span>
          }
        >
          ANPR coverage
        </SectionHeader>
        <div className="px-3 pb-3">
          <div className="h-[6px] w-full overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
            <div
              className="h-full rounded-full"
              style={{
                width: `${pct(health.anprCapable)}%`,
                background: 'var(--signal)',
              }}
            />
          </div>
          <p className="mt-2 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            {health.anprCapable} of {health.total} cameras have produced plate reads. Capability
            is taken from that evidence rather than assumed: most of this estate is wide overview
            views where a plate never resolves to readable pixels, which camera geometry decides,
            not bitrate.
          </p>
        </div>
      </Card>

      <Card>
        <SectionHeader>Cameras by department</SectionHeader>
        <div className="h-[132px] px-1 pb-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byDomain} margin={{ top: 6, right: 6, bottom: 0, left: 6 }}>
              <XAxis
                dataKey="domain"
                tick={{ fontSize: 9, fill: '#92A0B5' }}
                axisLine={false}
                tickLine={false}
                interval={0}
              />
              <Tooltip
                cursor={{ fill: 'rgba(45,212,191,0.06)' }}
                contentStyle={{
                  background: '#131C2B',
                  border: '1px solid #2A3A50',
                  borderRadius: 6,
                  fontSize: 11,
                }}
                labelStyle={{ color: '#E7ECF3' }}
              />
              <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                {byDomain.map((d, i) => (
                  <Cell key={i} fill={d.fill} fillOpacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card>
        <SectionHeader
          right={
            <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
              {down.length}
            </span>
          }
        >
          Needs attention
        </SectionHeader>
        {!down.length ? (
          <Empty>
            {counts.unverified
              ? `No measured failures. ${counts.unverified} camera${counts.unverified === 1 ? ' has' : 's have'} not been checked yet.`
              : 'Every camera answered with a playable stream.'}
          </Empty>
        ) : (
          <ul className="px-3 pb-3">
            {down.map((c) => (
              <li key={c.id} className="border-b last:border-0" style={{ borderColor: 'var(--line-soft)' }}>
                <button
                  onClick={() => setFocusCamera(c.id)}
                  className="flex w-full items-center justify-between py-2 text-left"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[12px]" style={{ color: 'var(--text)' }}>
                      {c.name}
                    </span>
                    <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
                      {c.id} · {c.district}
                    </span>
                  </span>
                  <span className="mono text-right text-[10px]" style={{ color: 'var(--alert)' }}>
                    no stream
                    <span className="block" style={{ color: 'var(--text-mute)' }}>
                      {checkedAgo(measured[c.id]?.checkedAt)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function checkedAgo(at: number | undefined): string {
  if (!at) return '';
  const min = Math.round((Date.now() - at) / 60_000);
  return min < 1 ? 'just now' : `${min} min ago`;
}

function Stat({
  label,
  value,
  colour,
  sub,
}: {
  label: string;
  value: number;
  colour: string;
  sub: string;
}) {
  return (
    <Card className="px-2.5 py-2">
      <div className="mono text-[20px] font-semibold leading-none" style={{ color: colour }}>
        {value}
      </div>
      <div className="mt-1 text-[10px]" style={{ color: 'var(--text-dim)' }}>
        {label}
      </div>
      <div className="mono text-[9px]" style={{ color: 'var(--text-mute)' }}>
        {sub}
      </div>
    </Card>
  );
}
