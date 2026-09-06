import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera as CameraIcon, Clock, Maximize2, ScanLine, X } from 'lucide-react';
import { Pill } from '@/components/ui';
import type { Detection } from '@/api/types';

/**
 * One sighting, with the evidence that supports it.
 *
 * OCR on this footage is right most of the time, not all of the time, so a
 * plate is presented as a claim an operator can check rather than a fact they
 * must accept. Two images do that job:
 *
 *   the plate crop, enlarged — what the read was made from, so the characters
 *   can be confirmed or corrected by eye;
 *   the full frame, vehicle boxed — which vehicle, which lane, what else was
 *   there. This is also the accountability record: it shows the moment, not
 *   just the system's conclusion about it.
 *
 * Where the read was voted across several frames the count is shown, because
 * a plate resolved from twenty frames deserves more confidence than one seen
 * once, and nothing else on the card conveys that.
 */
export function DetectionCard({
  detection,
  cameraName,
  onTrace,
}: {
  detection: Detection;
  cameraName?: string;
  onTrace?: (plate: string) => void;
}) {
  const [zoom, setZoom] = useState<string | null>(null);
  const d = detection;
  const seen = new Date(d.timestamp);

  // `confidence` carries the vote count scaled to 0..1 when per-read
  // confidence was not reported; 0 means neither was recorded.
  const votes = d.confidence > 0 ? Math.round(d.confidence * 10) : null;

  return (
    <>
      <div
        className="overflow-hidden rounded-[6px]"
        style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}
      >
        {/* Evidence first. The plate is a claim; these are what back it. */}
        <div className="grid grid-cols-[1fr_1.4fr] gap-px" style={{ background: 'var(--line)' }}>
          <EvidenceImage
            src={d.plateCropUrl}
            label="Plate"
            icon={ScanLine}
            onZoom={setZoom}
            hint="No plate crop stored"
          />
          <EvidenceImage
            src={d.snapshotUrl}
            label="Frame"
            icon={CameraIcon}
            onZoom={setZoom}
            hint="No frame stored"
          />
        </div>

        <div className="space-y-1.5 p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => onTrace?.(d.plate)}
              disabled={!onTrace}
              className="mono text-[15px] font-bold tracking-wide"
              style={{ color: 'var(--signal)', cursor: onTrace ? 'pointer' : 'default' }}
              title={onTrace ? 'Trace this vehicle' : undefined}
            >
              {d.plate || '—'}
            </button>
            {d.vehicleType && <Pill>{d.vehicleType}</Pill>}
            {d.colour && <Pill>{d.colour}</Pill>}
            {votes !== null && (
              <Pill
                colour={votes >= 5 ? 'var(--signal)' : 'var(--alert)'}
                mono
              >
                {votes >= 10 ? '10+' : votes} frame{votes === 1 ? '' : 's'}
              </Pill>
            )}
          </div>

          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]"
            style={{ color: 'var(--text-mute)' }}
          >
            <span className="flex items-center gap-1">
              <CameraIcon size={11} /> {cameraName ?? d.cameraId}
            </span>
            <span className="mono flex items-center gap-1">
              <Clock size={11} />
              {seen.toLocaleString('en-GB', {
                day: '2-digit', month: 'short',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
              })}
            </span>
          </div>

          {votes !== null && votes < 3 && (
            <p className="text-[10.5px]" style={{ color: 'var(--alert)' }}>
              Read from few frames — check the crop before acting on it.
            </p>
          )}
        </div>
      </div>

      {zoom && <Lightbox src={zoom} plate={d.plate} onClose={() => setZoom(null)} />}
    </>
  );
}

function EvidenceImage({
  src, label, icon: Icon, onZoom, hint,
}: {
  src: string;
  label: string;
  icon: typeof CameraIcon;
  onZoom: (src: string) => void;
  hint: string;
}) {
  if (!src) {
    return (
      <div
        className="flex aspect-[16/10] flex-col items-center justify-center gap-1"
        style={{ background: 'var(--surface-2)' }}
      >
        <Icon size={14} style={{ color: 'var(--text-mute)' }} />
        <span className="text-[10px]" style={{ color: 'var(--text-mute)' }}>{hint}</span>
      </div>
    );
  }
  return (
    <button
      onClick={() => onZoom(src)}
      className="group relative block aspect-[16/10] w-full overflow-hidden"
      style={{ background: '#05090F' }}
      title={`${label} — click to enlarge`}
    >
      <img src={src} alt={label} className="h-full w-full object-cover" loading="lazy" />
      <span
        className="mono absolute left-1 top-1 rounded-[3px] px-1 text-[9px] font-bold uppercase"
        style={{ background: 'rgba(6,11,20,.78)', color: '#E7ECF3' }}
      >
        {label}
      </span>
      <span
        className="absolute right-1 top-1 rounded-[3px] p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
        style={{ background: 'rgba(6,11,20,.78)', color: '#E7ECF3' }}
      >
        <Maximize2 size={11} />
      </span>
    </button>
  );
}

/** Full-size view — the plate crop is small, and small is what hides errors. */
function Lightbox({ src, plate, onClose }: { src: string; plate: string; onClose: () => void }) {
  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-6"
      style={{ background: 'rgba(4,8,15,.9)' }}
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
        <img
          src={src}
          alt={plate}
          className="max-h-[82vh] max-w-full object-contain"
          style={{ imageRendering: 'crisp-edges' }}
        />
        <figcaption
          className="mono mt-2 text-center text-[13px]"
          style={{ color: 'var(--signal)' }}
        >
          {plate}
        </figcaption>
      </figure>
    </div>,
    document.body,
  );
}
