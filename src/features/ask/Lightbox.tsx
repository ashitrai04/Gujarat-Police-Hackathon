import { useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, MapPin, MonitorPlay, X } from 'lucide-react';
import { thumbUrl, type AskResult } from '@/api/ask';
import './Lightbox.css';

/**
 * A returned frame, full size.
 *
 * The grid thumbnails are 110px wide, which is enough to rank a result and not
 * nearly enough to act on one. An operator deciding whether a frame really
 * shows what they asked for is doing the same job the plate crops exist for
 * elsewhere in this console: looking closely, at the evidence, before
 * believing the system. So the picture opens at the size it was stored.
 *
 * Arrow keys step through the rest of the answer without closing, because the
 * question being asked is almost always "which of these is it?" rather than
 * "is this one it?".
 */
export function Lightbox({
  results,
  index,
  onIndex,
  onClose,
  onShowOnMap,
  onOpenCamera,
}: {
  results: AskResult[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onShowOnMap: (r: AskResult) => void;
  onOpenCamera: (r: AskResult) => void;
}) {
  const r = results[index];

  const step = useCallback(
    (d: number) => {
      if (results.length < 2) return;
      onIndex((index + d + results.length) % results.length);
    },
    [index, results.length, onIndex],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, step]);

  // The map keeps moving underneath; scrolling the console behind a full-screen
  // image is disorienting when it is dismissed.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  if (!r) return null;

  const counts = Object.entries(r.counts);

  return createPortal(
    <div className="lb" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="lb-shell" onClick={(e) => e.stopPropagation()}>
        <header className="lb-head">
          <div className="min-w-0">
            <h2 className="lb-cam">{r.camera_id}</h2>
            <p className="lb-src">{r.source} · t+{r.t_s.toFixed(2)}s</p>
          </div>
          <span className="lb-count">{index + 1} / {results.length}</span>
          <button className="lb-x" onClick={onClose} aria-label="Close (Esc)"><X size={17} /></button>
        </header>

        <div className="lb-stage">
          {results.length > 1 && (
            <button className="lb-nav left" onClick={() => step(-1)} aria-label="Previous">
              <ChevronLeft size={22} />
            </button>
          )}
          <img src={thumbUrl(r.thumb_url)} alt="" className="lb-img" />
          {results.length > 1 && (
            <button className="lb-nav right" onClick={() => step(1)} aria-label="Next">
              <ChevronRight size={22} />
            </button>
          )}
        </div>

        <footer className="lb-foot">
          <div className="lb-facts">
            <span className="lb-score">match {r.score.toFixed(3)}</span>
            {r.verified === true && <span className="lb-flag ok">confirmed</span>}
            {r.verified === false && <span className="lb-flag no">rejected</span>}
            {counts.length > 0 && (
              <span className="lb-counts">
                {counts.map(([k, v]) => `${k} ×${v}`).join('  ')}
              </span>
            )}
          </div>
          {r.reason && <p className="lb-reason">{r.reason}</p>}
          {r.grounding && <p className="lb-ground">{r.grounding}</p>}
          <div className="lb-acts">
            <button className="lb-btn" onClick={() => { onShowOnMap(r); onClose(); }}>
              <MapPin size={13} /> Point to it on the map
            </button>
            <button className="lb-btn" onClick={() => { onOpenCamera(r); onClose(); }}>
              <MonitorPlay size={13} /> Open the camera
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
