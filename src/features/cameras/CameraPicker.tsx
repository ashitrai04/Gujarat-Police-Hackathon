import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, MonitorPlay, Search, X } from 'lucide-react';
import { api } from '@/api/client';
import { useStore } from '@/app/store';
import { Button, Empty, Pill, Spinner, StatusDot } from '@/components/ui';
import { useStreamHealth } from '@/api/useStreamHealth';
import { byAvailability } from '@/api/health';
import { DOMAIN_COLOR, DOMAIN_LABEL, type Camera } from '@/api/types';

const GRADE_COLOR: Record<Camera['anprGrade'], string> = {
  good: '#22C55E',
  fair: '#F5A524',
  poor: '#EF4444',
  unknown: '#64748B',
};

/**
 * Pick cameras and push them onto the video wall. This is the primary way an
 * operator builds a grid — the map is for geography, this is for "show me
 * these six feeds".
 */
export function CameraPicker({ onClose }: { onClose: () => void }) {
  const { data: cams, isLoading, error } = useQuery({
    queryKey: ['cameras.all'],
    queryFn: () => api.cameras(),
  });
  const wall = useStore((s) => s.wallCameraIds);
  const addToWall = useStore((s) => s.addToWall);
  const removeFromWall = useStore((s) => s.removeFromWall);

  const [q, setQ] = useState('');
  const [district, setDistrict] = useState<string>('');

  const districts = useMemo(
    () => [...new Set((cams ?? []).map((c) => c.district))].sort(),
    [cams],
  );

  const { data: health } = useStreamHealth();

  const list = useMemo(() => {
    let out = cams ?? [];
    if (district) out = out.filter((c) => c.district === district);
    if (q) {
      const n = q.toLowerCase();
      out = out.filter((c) =>
        [c.name, c.district, c.id, ...c.tags].join(' ').toLowerCase().includes(n),
      );
    }
    // Streaming cameras first — the host reports every camera as "live",
    // including ones whose stream is dead, so only the probe can order these.
    return [...out].sort(byAvailability(health));
  }, [cams, q, district, health]);

  const selected = new Set(wall);

  // Esc closes; portal to <body> so no ancestor overflow or stacking context
  // can clip or offset the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-auto p-4 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0" style={{ background: 'rgba(4,8,16,0.72)' }} onClick={onClose} />

      <div
        className="anim-fade-up relative flex max-h-[86dvh] w-full min-w-0 flex-col overflow-hidden rounded-[10px]"
        style={{
          maxWidth: 720,
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          boxShadow: 'var(--sh-lg)',
        }}
      >
        {/* Header */}
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2.5"
          style={{ borderBottom: '1px solid var(--line)' }}
        >
          <span className="panel-title">Select cameras</span>
          <Pill mono colour="var(--signal)">{wall.length} on wall</Pill>
          <div className="flex-1" />
          <Button onClick={() => addToWall(list.map((c) => c.id))} disabled={!list.length}>
            Add all shown
          </Button>
          <button
            onClick={onClose}
            className="rounded-[5px] p-1 hover:bg-[var(--surface-2)]"
            style={{ color: 'var(--text-dim)' }}
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        {/* Filters */}
        <div className="flex shrink-0 flex-wrap gap-2 px-4 py-2.5" style={{ borderBottom: '1px solid var(--line)' }}>
          <div className="relative min-w-[180px] flex-1">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-mute)' }} />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, district or tag…"
              className="w-full rounded-[6px] py-[7px] pl-8 pr-2 text-[12px] outline-none"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
            />
          </div>
          <select
            value={district}
            onChange={(e) => setDistrict(e.target.value)}
            className="rounded-[6px] px-2 py-[7px] text-[12px] outline-none"
            style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
          >
            <option value="">All districts</option>
            {districts.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>

        {/* List */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex justify-center py-10"><Spinner size={18} /></div>
          ) : error ? (
            <Empty>
              Could not reach the camera registry at live.sentinelgujarat.in. Check the
              network and reload.
            </Empty>
          ) : !list.length ? (
            <Empty>No cameras match this search — clear the keyword or pick another district.</Empty>
          ) : (
            <ul className="p-2">
              {list.map((c) => {
                const on = selected.has(c.id);
                return (
                  <li key={c.id}>
                    <button
                      onClick={() => (on ? removeFromWall(c.id) : addToWall(c.id))}
                      className="flex w-full items-start gap-2.5 rounded-[6px] px-2.5 py-2 text-left transition-colors hover:bg-[var(--surface-2)]"
                      style={{ background: on ? 'var(--signal-dim)' : 'transparent' }}
                    >
                      <span
                        className="mt-[2px] flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px] border"
                        style={{
                          borderColor: on ? 'var(--signal)' : 'var(--line)',
                          background: on ? 'var(--signal)' : 'transparent',
                        }}
                      >
                        {on && <Check size={11} strokeWidth={3} color="#04201C" />}
                      </span>

                      <span className="mt-[3px] shrink-0"><StatusDot status={c.status} /></span>

                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px]" style={{ color: 'var(--text)' }}>
                          {c.name}
                        </span>
                        <span className="mono block truncate text-[10px]" style={{ color: 'var(--text-mute)' }}>
                          {c.id} · {c.district}
                          {c.width ? ` · ${c.width}×${c.height} @ ${c.fps}fps` : ' · not yet probed'}
                        </span>
                        {/* Badges live under the name and WRAP, so they can
                            never be pushed off the right edge on a narrow
                            dialog — this is what was getting clipped. */}
                        <span className="mt-1 flex flex-wrap items-center gap-1">
                          <Pill colour={DOMAIN_COLOR[c.domain]}>{DOMAIN_LABEL[c.domain]}</Pill>
                          <Pill colour={GRADE_COLOR[c.anprGrade]}>
                            {c.anprGrade === 'unknown' ? 'ANPR ?' : `ANPR ${c.anprGrade}`}
                          </Pill>
                          {health?.[c.id] && (
                            <Pill
                              colour={
                                health[c.id].state === 'available'
                                  ? 'var(--signal)'
                                  : 'var(--critical)'
                              }
                            >
                              {health[c.id].state === 'available' ? 'Streaming' : 'No stream'}
                            </Pill>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2.5"
          style={{ borderTop: '1px solid var(--line)' }}
        >
          <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
            {list.length} shown · ANPR grade is from the host's bits-per-pixel figure and is
            advisory — camera angle matters more than compression.
          </span>
          <div className="flex-1" />
          <Button variant="primary" onClick={onClose}>
            <MonitorPlay size={13} /> Done
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}