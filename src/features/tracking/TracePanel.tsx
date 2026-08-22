import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Search, RotateCcw } from 'lucide-react';
import { api } from '@/api/client';
import { useStore } from '@/app/store';
import { Button, Card, Empty, Pill, SectionHeader, Spinner } from '@/components/ui';
import { ANPR_CONNECTED } from '@/api/client';

export function TracePanel() {
  const { trace, setTrace, traceProgress, setTraceProgress, tracePlaying, setTracePlaying } =
    useStore();
  const setFocusCamera = useStore((s) => s.setFocusCamera);
  const [plate, setPlate] = useState(trace?.plate ?? '');
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const raf = useRef<number | null>(null);

  async function run(p: string) {
    const clean = p.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) return;
    setLoading(true);
    setSearched(true);
    try {
      const r = await api.route(clean);
      setTrace(r);
      setTraceProgress(r.stops.length ? 0 : 1);
      setTracePlaying(r.stops.length > 1);
    } finally {
      setLoading(false);
    }
  }

  /* Progressive draw of the route. */
  useEffect(() => {
    if (!tracePlaying || !trace) return;
    const stops = trace.stops.length;
    if (stops < 2) {
      setTracePlaying(false);
      return;
    }
    const durationMs = Math.min(6000, stops * 700);
    const t0 = performance.now();
    const startAt = traceProgress >= 1 ? 0 : traceProgress;

    const tick = (now: number) => {
      const p = Math.min(1, startAt + (now - t0) / durationMs);
      setTraceProgress(p);
      if (p < 1) {
        raf.current = requestAnimationFrame(tick);
      } else {
        setTracePlaying(false);
      }
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracePlaying, trace]);

  const shownCount = trace ? Math.max(1, Math.round(trace.stops.length * traceProgress)) : 0;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div>
        <label className="mb-1.5 block text-[11px]" style={{ color: 'var(--text-dim)' }}>
          Registration number
        </label>
        <div className="flex gap-1.5">
          <input
            value={plate}
            onChange={(e) => setPlate(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && run(plate)}
            placeholder="GJ18EG1466"
            className="mono w-full rounded-[6px] px-2.5 py-[7px] text-[13px] tracking-wide outline-none"
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--line)',
              color: 'var(--text)',
            }}
          />
          <Button variant="primary" onClick={() => run(plate)} disabled={loading}>
            {loading ? <Spinner /> : <Search size={13} />}
          </Button>
        </div>
      </div>

      {!ANPR_CONNECTED && (
        <Empty>
          Detection service not connected. Set <span className="mono">VITE_ANPR_API_URL</span>{' '}
          to the Hugging Face pipeline to enable plate search and route reconstruction.
        </Empty>
      )}

      {ANPR_CONNECTED && !trace && !searched && (
        <Empty>
          Enter a registration number to reconstruct its route across the camera network.
        </Empty>
      )}

      {trace && !trace.stops.length && (
        <Empty>
          No sightings for <span className="mono">{trace.plate}</span> in the retained window.
          Try a different plate or widen the time range in event search.
        </Empty>
      )}

      {trace && trace.stops.length > 0 && (
        <>
          <Card>
            <SectionHeader
              right={
                <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
                  {shownCount}/{trace.stops.length}
                </span>
              }
            >
              Playback
            </SectionHeader>
            <div className="px-3 pb-3">
              <div className="mb-2 flex items-center gap-1.5">
                <Button
                  variant="primary"
                  onClick={() => {
                    if (traceProgress >= 1) setTraceProgress(0);
                    setTracePlaying(!tracePlaying);
                  }}
                >
                  {tracePlaying ? <Pause size={12} /> : <Play size={12} />}
                  {tracePlaying ? 'Pause' : 'Play route'}
                </Button>
                <Button
                  onClick={() => {
                    setTracePlaying(false);
                    setTraceProgress(0);
                  }}
                >
                  <RotateCcw size={12} />
                </Button>
                <span className="mono ml-auto text-[10px]" style={{ color: 'var(--text-mute)' }}>
                  {Math.round(traceProgress * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={traceProgress}
                onChange={(e) => {
                  setTracePlaying(false);
                  setTraceProgress(Number(e.target.value));
                }}
                className="w-full accent-[var(--signal)]"
                aria-label="Scrub route"
              />
              <div className="mt-1 flex justify-between text-[10px]" style={{ color: 'var(--text-mute)' }}>
                <span className="mono">
                  {new Date(trace.stops[0].timestamp).toLocaleTimeString('en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span className="mono">
                  {new Date(trace.stops[trace.stops.length - 1].timestamp).toLocaleTimeString(
                    'en-GB',
                    { hour: '2-digit', minute: '2-digit' },
                  )}
                </span>
              </div>
            </div>
          </Card>

          <Card>
            <SectionHeader
              right={<Pill mono colour="var(--signal)">{trace.plate}</Pill>}
            >
              Sightings
            </SectionHeader>
            <ol className="px-3 pb-3">
              {trace.stops.map((st, i) => {
                const active = i < shownCount;
                const prev = i > 0 ? trace.stops[i - 1] : null;
                const gapMin = prev
                  ? Math.round(
                      (+new Date(st.timestamp) - +new Date(prev.timestamp)) / 60000,
                    )
                  : null;
                return (
                  <li key={`${st.cameraId}-${st.timestamp}`} className="relative pl-5">
                    {i < trace.stops.length - 1 && (
                      <span
                        className="absolute left-[6px] top-[16px] h-full w-px"
                        style={{ background: active ? 'var(--signal)' : 'var(--line)' }}
                      />
                    )}
                    <span
                      className="absolute left-0 top-[7px] h-[11px] w-[11px] rounded-full border-2"
                      style={{
                        borderColor: active ? 'var(--signal)' : 'var(--line)',
                        background: 'var(--surface)',
                      }}
                    />
                    <button
                      onClick={() => setFocusCamera(st.cameraId)}
                      className="w-full py-1.5 text-left"
                      style={{ opacity: active ? 1 : 0.4 }}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[12px]" style={{ color: 'var(--text)' }}>
                          {st.cameraName}
                        </span>
                        <span className="mono shrink-0 text-[10px]" style={{ color: 'var(--signal)' }}>
                          {new Date(st.timestamp).toLocaleTimeString('en-GB', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                      <div className="text-[10px]" style={{ color: 'var(--text-mute)' }}>
                        {st.district}
                        {gapMin !== null && ` · +${gapMin} min`}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ol>
          </Card>
        </>
      )}
    </div>
  );
}
