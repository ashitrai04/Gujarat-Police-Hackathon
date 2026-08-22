import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { api } from '@/api/client';
import { Card, Empty, SectionHeader, StatusDot } from '@/components/ui';
import { DOMAIN_COLOR, DOMAIN_LABEL, STATUS_COLOR, type Domain } from '@/api/types';
import { useStore } from '@/app/store';

export function HealthPanel() {
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health });
  const { data: cams } = useQuery({ queryKey: ['cameras.all'], queryFn: () => api.cameras() });
  const setFocusCamera = useStore((s) => s.setFocusCamera);

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
    () => cams?.filter((c) => c.status !== 'online') ?? [],
    [cams],
  );

  if (!health) return <Empty>Loading camera health…</Empty>;

  const pct = (n: number) => Math.round((n / health.total) * 100);

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Online" value={health.online} colour={STATUS_COLOR.online} sub={`${pct(health.online)}%`} />
        <Stat label="Degraded" value={health.degraded} colour={STATUS_COLOR.degraded} sub={`${pct(health.degraded)}%`} />
        <Stat label="Offline" value={health.offline} colour={STATUS_COLOR.offline} sub={`${pct(health.offline)}%`} />
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
            {health.anprCapable} of {health.total} cameras are tagged ANPR-capable. The rest are
            wide overview views where a plate will not resolve — expected, and tagged
            deliberately in the registry.
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
          <Empty>Every camera is reporting healthy.</Empty>
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
                  <StatusDot status={c.status} label />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
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
