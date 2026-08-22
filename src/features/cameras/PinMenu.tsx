import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, Crosshair, Info, Maximize2, MonitorPlay, Trash2 } from 'lucide-react';
import { api } from '@/api/client';
import { useStore } from '@/app/store';
import { Pill, StatusDot } from '@/components/ui';
import { DOMAIN_COLOR, DOMAIN_LABEL } from '@/api/types';

/**
 * Actions for a camera picked on the map. Anchored to the click point and
 * clamped inside the viewport so it can never open off-screen.
 */
export function PinMenu() {
  const menu = useStore((s) => s.pinMenu);
  const setPinMenu = useStore((s) => s.setPinMenu);
  const wall = useStore((s) => s.wallCameraIds);
  const addToWall = useStore((s) => s.addToWall);
  const removeFromWall = useStore((s) => s.removeFromWall);
  const setSoloCamera = useStore((s) => s.setSoloCamera);
  const openPanel = useStore((s) => s.openPanel);
  const setFocusCamera = useStore((s) => s.setFocusCamera);
  const setDockOpen = useStore((s) => s.setDockOpen);

  const { data: cams } = useQuery({ queryKey: ['cameras.all'], queryFn: () => api.cameras() });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPinMenu(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPinMenu]);

  if (!menu) return null;
  const cam = cams?.find((c) => c.id === menu.cameraId);
  if (!cam) return null;

  const onWall = wall.includes(cam.id);
  const W = 236;
  const H = 210;
  const left = Math.min(Math.max(8, menu.x - W / 2), window.innerWidth - W - 8);
  const top = Math.min(Math.max(8, menu.y + 14), window.innerHeight - H - 8);

  const close = () => setPinMenu(null);

  const Item = ({
    icon: Icon,
    label,
    onClick,
    tone,
  }: {
    icon: typeof Crosshair;
    label: string;
    onClick: () => void;
    tone?: string;
  }) => (
    <button
      onClick={() => {
        onClick();
        close();
      }}
      className="flex w-full items-center gap-2 px-3 py-[7px] text-left text-[12px] transition-colors hover:bg-[var(--surface-2)]"
      style={{ color: tone ?? 'var(--text)' }}
    >
      <Icon size={13} style={{ color: tone ?? 'var(--text-dim)' }} />
      {label}
    </button>
  );

  return createPortal(
    <>
      <div className="fixed inset-0 z-[90]" onClick={close} />
      <div
        className="anim-fade-up fixed z-[91] overflow-hidden rounded-[8px] py-1"
        style={{
          left,
          top,
          width: W,
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          boxShadow: 'var(--sh-lg)',
        }}
      >
        <div className="px-3 pb-1.5 pt-2">
          <div className="flex items-center gap-1.5">
            <StatusDot status={cam.status} />
            <span className="truncate text-[12.5px] font-medium" style={{ color: 'var(--text)' }}>
              {cam.name}
            </span>
          </div>
          <div className="mono mt-0.5 text-[10px]" style={{ color: 'var(--text-mute)' }}>
            {cam.id} · {cam.district}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <Pill colour={DOMAIN_COLOR[cam.domain]}>{DOMAIN_LABEL[cam.domain]}</Pill>
            {cam.width && <Pill mono>{cam.width}×{cam.height}</Pill>}
          </div>
        </div>

        <div className="my-1 h-px" style={{ background: 'var(--line)' }} />

        {onWall ? (
          <Item
            icon={Trash2}
            label="Remove from grid"
            tone="var(--critical)"
            onClick={() => removeFromWall(cam.id)}
          />
        ) : (
          <Item
            icon={MonitorPlay}
            label="Add to grid"
            onClick={() => {
              addToWall(cam.id);
              setDockOpen(true);
            }}
          />
        )}
        <Item
          icon={Maximize2}
          label="View this camera only"
          onClick={() => setSoloCamera(cam.id)}
        />
        <Item
          icon={Info}
          label="Camera details"
          onClick={() => openPanel({ kind: 'camera', cameraId: cam.id })}
        />
        <Item icon={Crosshair} label="Centre on map" onClick={() => setFocusCamera(cam.id)} />
        {onWall && (
          <div className="flex items-center gap-1.5 px-3 pb-2 pt-1 text-[10px]" style={{ color: 'var(--signal)' }}>
            <Check size={11} /> On the grid
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}
