import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileText, Search } from 'lucide-react';
import { api } from '@/api/client';
import { Button, Card, Empty, SectionHeader, Spinner } from '@/components/ui';
import { exportCsv, exportPdf } from './export';

const RANGES = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '12h', hours: 12 },
  { label: '24h', hours: 24 },
];

export function EventsPanel() {
  const [plate, setPlate] = useState('');
  const [hours, setHours] = useState(12);
  const [cameraId, setCameraId] = useState('');

  const from = useMemo(
    () => new Date(Date.now() - hours * 3600_000).toISOString(),
    [hours],
  );

  const { data: cams } = useQuery({ queryKey: ['cameras.all'], queryFn: () => api.cameras() });
  const { data, isFetching } = useQuery({
    queryKey: ['events', plate, cameraId, from],
    queryFn: () => api.detections({ plate: plate || undefined, cameraId: cameraId || undefined, from, limit: 400 }),
  });

  const camName = (id: string) => cams?.find((c) => c.id === id)?.name ?? id;

  const rows = useMemo(
    () =>
      (data ?? []).map((d) => ({
        plate: d.plate,
        camera: camName(d.cameraId),
        cameraId: d.cameraId,
        vehicle: d.vehicleType,
        colour: d.colour,
        confidence: `${Math.round(d.confidence * 100)}%`,
        timestamp: new Date(d.timestamp).toLocaleString('en-GB'),
      })),
    [data, cams],
  );

  return (
    <div className="flex flex-col gap-3 p-3">
      <Card>
        <SectionHeader>Search</SectionHeader>
        <div className="flex flex-col gap-2 px-3 pb-3">
          <input
            value={plate}
            onChange={(e) => setPlate(e.target.value.toUpperCase())}
            placeholder="Plate (partial matches allowed)"
            className="mono rounded-[6px] px-2.5 py-[7px] text-[12px] outline-none"
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--line)',
              color: 'var(--text)',
            }}
          />
          <select
            value={cameraId}
            onChange={(e) => setCameraId(e.target.value)}
            className="rounded-[6px] px-2 py-[7px] text-[12px] outline-none"
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--line)',
              color: 'var(--text)',
            }}
          >
            <option value="">All cameras</option>
            {cams
              ?.filter((c) => c.anprCapable)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <button
                key={r.label}
                onClick={() => setHours(r.hours)}
                className="flex-1 rounded-[5px] py-[5px] text-[11px] transition-colors"
                style={{
                  background: hours === r.hours ? 'var(--signal-dim)' : 'var(--surface-2)',
                  border: `1px solid ${hours === r.hours ? 'var(--signal)' : 'var(--line)'}`,
                  color: hours === r.hours ? 'var(--signal)' : 'var(--text-dim)',
                }}
              >
                Last {r.label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <SectionHeader
          right={
            <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
              {isFetching ? '…' : `${rows.length} rows`}
            </span>
          }
        >
          Results
        </SectionHeader>

        <div className="flex gap-1.5 px-3 pb-2">
          <Button onClick={() => exportCsv(rows)} disabled={!rows.length}>
            <Download size={12} /> CSV
          </Button>
          <Button onClick={() => exportPdf(rows, { plate, hours })} disabled={!rows.length}>
            <FileText size={12} /> PDF
          </Button>
        </div>

        {isFetching && !rows.length ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : !rows.length ? (
          <Empty>
            No detections match this search. Clear the plate filter or widen the time range.
          </Empty>
        ) : (
          <div className="max-h-[46vh] overflow-auto px-3 pb-3">
            <table className="w-full border-collapse text-[11px]">
              <thead className="sticky top-0" style={{ background: 'var(--surface)' }}>
                <tr style={{ color: 'var(--text-mute)' }}>
                  <Th>Plate</Th>
                  <Th>Camera</Th>
                  <Th>Time</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t" style={{ borderColor: 'var(--line-soft)' }}>
                    <td className="mono py-1.5 pr-2" style={{ color: 'var(--signal)' }}>
                      {r.plate}
                    </td>
                    <td className="py-1.5 pr-2" style={{ color: 'var(--text)' }}>
                      {r.camera}
                    </td>
                    <td className="mono py-1.5 whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                      {r.timestamp.split(', ')[1] ?? r.timestamp}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="flex items-start gap-1.5 px-1 text-[10px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
        <Search size={10} className="mt-[2px] shrink-0" />
        Exports contain the full result set shown here, including vehicle type, colour and
        confidence — this is the output report for the evaluation.
      </p>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="pb-1.5 text-left text-[10px] font-medium uppercase tracking-wider">
      {children}
    </th>
  );
}
