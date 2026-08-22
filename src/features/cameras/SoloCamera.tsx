import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Crosshair, Info, MonitorPlay } from 'lucide-react';
import { api } from '@/api/client';
import { useStore } from '@/app/store';
import { Button, Pill, StatusDot } from '@/components/ui';
import { CameraPlayer } from '@/components/CameraPlayer';
import { DOMAIN_COLOR, DOMAIN_LABEL } from '@/api/types';

/** One camera, full screen — the closest look available before ANPR runs. */
export function SoloCamera() {
  const id = useStore((s) => s.soloCameraId);
  const setSolo = useStore((s) => s.setSoloCamera);
  const addToWall = useStore((s) => s.addToWall);
  const setDockOpen = useStore((s) => s.setDockOpen);
  const openPanel = useStore((s) => s.openPanel);
  const setFocusCamera = useStore((s) => s.setFocusCamera);

  const { data: cams } = useQuery({ queryKey: ['cameras.all'], queryFn: () => api.cameras() });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSolo(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSolo]);

  if (!id) return null;
  const cam = cams?.find((c) => c.id === id);
  if (!cam) return null;

  return createPortal(
    <div
      className="fixed z-[95] flex flex-col"
      style={{ top: 0, left: 0, right: 0, bottom: 0, background: 'var(--ink)' }}
    >
      <div
        className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2"
        style={{ borderBottom: '1px solid var(--line)', background: 'var(--surface)' }}
      >
        <Button onClick={() => setSolo(null)}>
          <ArrowLeft size={13} /> Back
        </Button>
        <StatusDot status={cam.status} />
        <span className="display text-[14px] font-semibold" style={{ color: 'var(--text)' }}>
          {cam.name}
        </span>
        <Pill colour={DOMAIN_COLOR[cam.domain]}>{DOMAIN_LABEL[cam.domain]}</Pill>
        <span className="mono text-[10.5px]" style={{ color: 'var(--text-mute)' }}>
          {cam.id} · {cam.district}
          {cam.width ? ` · ${cam.width}×${cam.height} @ ${cam.fps}fps` : ''}
        </span>

        <div className="flex-1" />

        <Button
          onClick={() => {
            addToWall(cam.id);
            setDockOpen(true);
          }}
        >
          <MonitorPlay size={13} /> Add to grid
        </Button>
        <Button onClick={() => openPanel({ kind: 'camera', cameraId: cam.id })}>
          <Info size={13} /> Details
        </Button>
        <Button
          onClick={() => {
            setFocusCamera(cam.id);
            setSolo(null);
          }}
        >
          <Crosshair size={13} /> Locate
        </Button>
      </div>

      <div className="min-h-0 flex-1 p-2">
        <CameraPlayer camera={cam} className="h-full w-full" showHeader={false} />
      </div>
    </div>,
    document.body,
  );
}
