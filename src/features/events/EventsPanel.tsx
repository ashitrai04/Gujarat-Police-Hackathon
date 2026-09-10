import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileText, Search } from 'lucide-react';
import { api } from '@/api/client';
import { Button, Card, Empty, SectionHeader, Spinner } from '@/components/ui';
import { exportCsv, exportPdf } from './export';
import { DetectionCard } from './DetectionCard';
import { useStore } from '@/app/store';

/*
 * Investigations look back further than a shift. A plate reported stolen on
 * Monday is searched for on Thursday, and with a 24-hour ceiling the sighting
 * that answers the question was simply unreachable — the empty state told the
 * operator to widen a range that could not be widened.
 */
const RANGES = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
  { label: '30d', hours: 24 * 30 },
];

function ago(iso: string): string {
  const h = (Date.now() - new Date(iso).getTime()) / 3600_000;
  if (h < 1) return 'under an hour ago';
  if (h < 48) return `${Math.round(h)} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function EventsPanel() {
  const setTrace = useStore((x) => x.setTrace);
  const openPanel = useStore((x) => x.openPanel);
  const preset = useStore((x) => x.eventsPreset);
  const [plate, setPlate] = useState(preset?.plate ?? '');
  const [hours, setHours] = useState(preset?.hours ?? 24);
  const [cameraId, setCameraId] = useState('');

  // A preset asked for after the panel is already open still applies.
  useEffect(() => {
    if (!preset) return;
    if (preset.plate !== undefined) setPlate(preset.plate.toUpperCase());
    if (preset.hours !== undefined) setHours(preset.hours);
  }, [preset?.k]); // eslint-disable-line react-hooks/exhaustive-deps

  const from = useMemo(
    () => new Date(Date.now() - hours * 3600_000).toISOString(),
    [hours],
  );

  const { data: cams } = useQuery({ queryKey: ['cameras.all'], queryFn: () => api.cameras() });
  const { data, isFetching } = useQuery({
    queryKey: ['events', plate, cameraId, from],
    queryFn: () => api.detections({ plate: plate || undefined, cameraId: cameraId || undefined, from, limit: 400 }),
  });

  // When the window is empty, find out whether anything older matches before
  // declaring there is nothing — "no results" and "no results this recently"
  // send an investigator in opposite directions.
  const empty = !isFetching && data !== undefined && data.length === 0;
  const { data: latest } = useQuery({
    queryKey: ['events.latest', plate, cameraId],
    queryFn: () => api.detections({ plate: plate || undefined, cameraId: cameraId || undefined, limit: 1 }),
    enabled: empty,
  });
  const newest = latest?.[0];
  const widenTo = newest
    ? RANGES.find((r) => Date.now() - new Date(newest.timestamp).getTime() <= r.hours * 3600_000)
    : undefined;

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
          newest ? (
            <div className="flex flex-col items-center gap-2 px-3 pb-4 pt-2 text-center">
              <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                Nothing in this window. The most recent matching sighting was{' '}
                <b style={{ color: 'var(--text)' }}>{ago(newest.timestamp)}</b>
                {' '}at {camName(newest.cameraId)}.
              </p>
              {widenTo && (
                <Button variant="primary" onClick={() => setHours(widenTo.hours)}>
                  Show the last {widenTo.label}
                </Button>
              )}
            </div>
          ) : (
            <Empty>
              {plate
                ? 'No camera has read a plate matching this, at any time.'
                : 'No detections recorded yet.'}
            </Empty>
          )
        ) : (
          <div className="max-h-[52vh] space-y-2 overflow-auto px-3 pb-3">
            {/* Cards, not a table. A row of text asserts a plate; a card shows
                the crop the read came from, which is what lets an operator
                catch the character OCR got wrong. */}
            {(data ?? []).map((d) => (
              <DetectionCard
                key={d.id}
                detection={d}
                cameraName={camName(d.cameraId)}
                onTrace={(pl: string) => {
                  // Jump straight from a sighting to the vehicle's journey:
                  // the plate an operator just verified by eye is the one they
                  // want to follow.
                  void api.route(pl).then(setTrace);
                  openPanel({ kind: 'trace' });
                }}
              />
            ))}
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

