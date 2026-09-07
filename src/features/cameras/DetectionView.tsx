import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Boxes, ChevronLeft, ChevronRight, Maximize2, Radio, ScanLine, X,
} from 'lucide-react';
import { Pill } from '@/components/ui';
import { CameraPlayer } from '@/components/CameraPlayer';
import type { Camera, Detection } from '@/api/types';

/**
 * The camera preview, with the detector's output available beside the feed.
 *
 * Why this is a toggle and not an overlay on the live video: a sighting is a
 * past event with a timestamp, and the live stream is at whatever position it
 * is at now. Drawing yesterday's box over today's frame would put a box around
 * a vehicle that is not there — a plausible-looking picture of something that
 * never happened, which is the one thing an evidence system must not produce.
 *
 * So the boxes are shown on the frame they were actually drawn on. Those
 * frames come from the pipeline with the vehicle already boxed and labelled,
 * which is exactly the model plot; what is added here is the reading chrome —
 * plate, vehicle class, time, how many frames voted — and the plate crop
 * inset, because the number in a full frame is too small to check by eye.
 */
export function DetectionView({
  camera,
  detections,
}: {
  camera: Camera;
  detections: Detection[] | undefined;
}) {
  const [mode, setMode] = useState<'live' | 'detections'>('live');
  const [i, setI] = useState(0);
  const [zoom, setZoom] = useState<string | null>(null);

  // Only frames carry boxes. A sighting with no stored frame has nothing to
  // show here, so it is not offered as one of the steps.
  const plotted = (detections ?? []).filter((d) => d.snapshotUrl);
  const shown = plotted[Math.min(i, plotted.length - 1)];

  // A different camera is a different set of sightings; step back to the top
  // rather than landing mid-way through a list the operator has not seen.
  useEffect(() => { setI(0); }, [camera.id]);

  const step = (n: number) =>
    setI((v) => (v + n + plotted.length) % plotted.length);

  useEffect(() => {
    if (mode !== 'detections' || plotted.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, plotted.length]);

  const votes = shown && shown.confidence > 0
    ? Math.round(shown.confidence * 10)
    : null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <Tab active={mode === 'live'} onClick={() => setMode('live')} icon={Radio}>
          Live
        </Tab>
        <Tab
          active={mode === 'detections'}
          onClick={() => setMode('detections')}
          icon={Boxes}
          disabled={!plotted.length}
        >
          Detections{plotted.length ? ` (${plotted.length})` : ''}
        </Tab>
      </div>

      {mode === 'live' ? (
        <CameraPlayer camera={camera} className="aspect-video w-full" />
      ) : !shown ? (
        <div
          className="flex aspect-video w-full flex-col items-center justify-center gap-1.5 rounded-[6px]"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}
        >
          <Boxes size={16} style={{ color: 'var(--text-mute)' }} />
          <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
            No boxed frames from this camera yet
          </span>
        </div>
      ) : (
        <div
          className="relative aspect-video w-full overflow-hidden rounded-[6px]"
          style={{ background: '#05090F', border: '1px solid var(--line)' }}
        >
          {/* contain, not cover: the boxes run to the edge of the frame and
              cropping to fill would cut the detection off the picture. */}
          <img
            src={shown.snapshotUrl}
            alt={`${shown.plate} — detector output`}
            className="h-full w-full object-contain"
          />

          {/* The plate as read, at a size it can be checked at. */}
          {shown.plateCropUrl && (
            <button
              onClick={() => setZoom(shown.plateCropUrl)}
              className="absolute bottom-9 right-1.5 overflow-hidden rounded-[4px]"
              style={{
                width: '38%', maxWidth: 150,
                border: '1.5px solid var(--signal)',
                boxShadow: '0 2px 10px rgba(0,0,0,.6)',
              }}
              title="Plate crop — click to enlarge"
            >
              <img src={shown.plateCropUrl} alt={shown.plate} className="block w-full" />
            </button>
          )}

          {plotted.length > 1 && (
            <>
              <Arrow side="left" onClick={() => step(-1)} />
              <Arrow side="right" onClick={() => step(1)} />
            </>
          )}

          <button
            onClick={() => setZoom(shown.snapshotUrl)}
            className="absolute right-1.5 top-1.5 rounded-[4px] p-1"
            style={{ background: 'rgba(6,11,20,.8)', color: '#E7ECF3' }}
            title="Enlarge frame"
          >
            <Maximize2 size={12} />
          </button>

          <span
            className="mono absolute left-1.5 top-1.5 rounded-[3px] px-1.5 py-[2px] text-[9px] font-bold"
            style={{ background: 'rgba(6,11,20,.8)', color: 'var(--text-dim)' }}
          >
            {Math.min(i + 1, plotted.length)} / {plotted.length}
          </span>

          {/* Reading bar: what the model concluded, under the frame it
              concluded it from. */}
          <div
            className="absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1.5"
            style={{ background: 'linear-gradient(to top, rgba(4,8,15,.94), transparent)' }}
          >
            <span
              className="mono text-[14px] font-bold tracking-wide"
              style={{ color: 'var(--signal)' }}
            >
              {shown.plate || '—'}
            </span>
            {shown.vehicleType && <Pill>{shown.vehicleType}</Pill>}
            {shown.colour && <Pill>{shown.colour}</Pill>}
            {votes !== null && (
              <Pill colour={votes >= 5 ? 'var(--signal)' : 'var(--alert)'} mono>
                {votes >= 10 ? '10+' : votes}f
              </Pill>
            )}
            <span
              className="mono ml-auto text-[9.5px]"
              style={{ color: 'var(--text-mute)' }}
            >
              {new Date(shown.timestamp).toLocaleString('en-GB', {
                day: '2-digit', month: 'short',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
              })}
            </span>
          </div>
        </div>
      )}

      {mode === 'detections' && shown && (
        <p className="px-0.5 text-[10px]" style={{ color: 'var(--text-mute)' }}>
          <ScanLine size={10} className="mr-1 inline" />
          Boxes as drawn by the detector on the recorded frame — not the live view.
        </p>
      )}

      {zoom && (
        <Zoom src={zoom} caption={shown?.plate ?? ''} onClose={() => setZoom(null)} />
      )}
    </div>
  );
}

function Tab({
  active, onClick, icon: Icon, disabled, children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Radio;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 rounded-[5px] px-2 py-[5px] text-[11px] font-medium transition-colors"
      style={{
        background: active ? 'var(--signal-dim)' : 'transparent',
        border: `1px solid ${active ? 'var(--signal)' : 'var(--line)'}`,
        color: active ? 'var(--signal)' : 'var(--text-dim)',
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      title={disabled ? 'No boxed frames stored for this camera' : undefined}
    >
      <Icon size={11} /> {children}
    </button>
  );
}

function Arrow({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      onClick={onClick}
      className="absolute top-1/2 -translate-y-1/2 rounded-full p-1"
      style={{
        [side]: 4, background: 'rgba(6,11,20,.72)', color: '#E7ECF3',
      } as React.CSSProperties}
      aria-label={side === 'left' ? 'Previous detection' : 'Next detection'}
    >
      <Icon size={15} />
    </button>
  );
}

function Zoom({
  src, caption, onClose,
}: { src: string; caption: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center p-6"
      style={{ background: 'rgba(4,8,15,.92)' }}
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute right-4 top-4 rounded-[5px] p-1.5"
        style={{ background: 'var(--surface)', color: 'var(--text)' }}
        aria-label="Close"
      >
        <X size={16} />
      </button>
      <figure className="max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={caption} className="max-h-[84vh] max-w-full object-contain" />
        <figcaption
          className="mono mt-2 text-center text-[13px]"
          style={{ color: 'var(--signal)' }}
        >
          {caption}
        </figcaption>
      </figure>
    </div>,
    document.body,
  );
}
