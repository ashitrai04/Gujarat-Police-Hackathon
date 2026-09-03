import { useEffect, useState } from 'react';
import {
  Bell, Box, Globe, Layers, ListPlus, MonitorPlay, Mountain, Search, ShieldCheck, X,
} from 'lucide-react';
import { BASE_STYLES, useStore, type BaseStyle } from './store';
import { useBreakpoint } from './useBreakpoint';
import type { Role } from '@/api/types';
import { Button, Pill } from '@/components/ui';
import { AuthBar } from './AuthBar';
import { ANPR_CONNECTED } from '@/api/client';

const ROLE_LABEL: Record<Role, string> = {
  'state-admin': 'State control room',
  'district-officer': 'District officer — Junagadh',
  'department-viewer': 'Health department',
};

export function CommandBar() {
  const s = useStore();
  const bp = useBreakpoint();
  const tight = bp === 'narrow';
  const [clock, setClock] = useState(() => new Date());
  const [styleOpen, setStyleOpen] = useState(false);
  const [roleOpen, setRoleOpen] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <header
      className="relative z-40 flex shrink-0 items-center gap-2 px-3"
      style={{
        height: 'var(--bar-h)',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--line)',
      }}
    >
      {/* Wordmark */}
      <div className="flex items-center gap-2.5 pr-1">
        <img src="/yi.png" alt="" className="h-[26px] w-[26px] rounded-[6px]" />
        <div className="leading-none">
          <div className="display text-[14px] font-bold tracking-tight" style={{ color: 'var(--text)' }}>
            Sentinel
          </div>
          {!tight && (
            <div className="text-[9px] tracking-[0.14em] uppercase" style={{ color: 'var(--text-mute)' }}>
              Command center
            </div>
          )}
        </div>
      </div>

      <div className="h-5 w-px" style={{ background: 'var(--line)' }} />

      {/* Search */}
      <div className="relative min-w-0 flex-1" style={{ maxWidth: tight ? 220 : 300 }}>
        <Search
          size={13}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
          style={{ color: 'var(--text-mute)' }}
        />
        <input
          value={s.query}
          onChange={(e) => s.setQuery(e.target.value)}
          placeholder="Search cameras — name, district, tag…"
          className="w-full rounded-[6px] py-[6px] pl-8 pr-7 text-[12px] outline-none"
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--line)',
            color: 'var(--text)',
          }}
        />
        {s.query && (
          <button
            onClick={() => s.setQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--text-mute)' }}
            aria-label="Clear search"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* Map view switcher */}
      <div className="relative">
        <Button onClick={() => setStyleOpen((v) => !v)} aria-expanded={styleOpen}>
          <Layers size={13} />
          {!tight && BASE_STYLES[s.baseStyle].label}
        </Button>
        {styleOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setStyleOpen(false)} />
            <div
              className="anim-fade-up absolute left-0 top-full z-50 mt-1 w-[168px] overflow-hidden rounded-[8px] py-1"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--line)',
                boxShadow: 'var(--sh-lg)',
              }}
            >
              {(Object.keys(BASE_STYLES) as BaseStyle[]).map((k) => (
                <button
                  key={k}
                  onClick={() => {
                    s.setBaseStyle(k);
                    setStyleOpen(false);
                  }}
                  className="flex w-full items-center justify-between px-3 py-[7px] text-left text-[12px] hover:bg-[var(--surface-2)]"
                  style={{ color: s.baseStyle === k ? 'var(--signal)' : 'var(--text)' }}
                >
                  {BASE_STYLES[k].label}
                  {s.baseStyle === k && <span className="text-[10px]">●</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 3D controls */}
      <Button
        onClick={s.toggleGlobe}
        title="Globe projection"
        style={{
          color: s.globe ? 'var(--signal)' : 'var(--text-dim)',
          border: `1px solid ${s.globe ? 'var(--signal)' : 'var(--line)'}`,
        }}
      >
        <Globe size={13} />
      </Button>
      <Button
        onClick={() => s.setPitch(s.pitch > 0 ? 0 : 55)}
        title="Tilt to 3D view"
        style={{
          color: s.pitch > 0 ? 'var(--signal)' : 'var(--text-dim)',
          border: `1px solid ${s.pitch > 0 ? 'var(--signal)' : 'var(--line)'}`,
        }}
      >
        {s.pitch > 0 ? <Box size={13} /> : <Mountain size={13} />}
        {!tight && '3D'}
      </Button>


      {/* Camera picker — build the grid by selection */}
      <Button onClick={() => s.setPickerOpen(true)} title="Select cameras">
        <ListPlus size={13} />
        {!tight && 'Cameras'}
      </Button>

      {/* Video wall toggle — the grid must always be one click away */}
      {/* Opens the camera grid as its own full screen. The small bottom dock
          stays available via the chevron inside that screen. */}
      <Button
        onClick={() => {
          s.setDockOpen(true);
          s.toggleWallFullscreen();
        }}
        title="Open camera grid"
        style={{
          color: s.wallFullscreen ? 'var(--signal)' : 'var(--text-dim)',
          border: `1px solid ${s.wallFullscreen ? 'var(--signal)' : 'var(--line)'}`,
        }}
      >
        <MonitorPlay size={13} />
        {!tight && `Wall (${s.wallCameraIds.length})`}
      </Button>

      {!tight && (
        <Pill colour={ANPR_CONNECTED ? 'var(--ok)' : 'var(--text-mute)'}>
          {ANPR_CONNECTED ? 'ANPR live' : 'ANPR offline'}
        </Pill>
      )}

      {/* Real identity, from Supabase. The role switcher below it is a demo
          convenience for showing different operator views; this is the one
          that actually decides what the database will let you do. */}
      <AuthBar />

      {/* Role switcher */}
      <div className="relative">
        <Button onClick={() => setRoleOpen((v) => !v)}>
          <ShieldCheck size={13} />
          {!tight && ROLE_LABEL[s.role]}
        </Button>
        {roleOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setRoleOpen(false)} />
            <div
              className="anim-fade-up absolute right-0 top-full z-50 mt-1 w-[230px] overflow-hidden rounded-[8px] py-1"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--line)',
                boxShadow: 'var(--sh-lg)',
              }}
            >
              {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                <button
                  key={r}
                  onClick={() => {
                    s.setRole(r);
                    setRoleOpen(false);
                  }}
                  className="block w-full px-3 py-[7px] text-left text-[12px] hover:bg-[var(--surface-2)]"
                  style={{ color: s.role === r ? 'var(--signal)' : 'var(--text)' }}
                >
                  {ROLE_LABEL[r]}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Clock */}
      {!tight && (
        <div className="mono px-1 text-[12px] tabular-nums" style={{ color: 'var(--text-dim)' }}>
          {clock.toLocaleTimeString('en-GB', { hour12: false })}
        </div>
      )}

      {/* Alert bell */}
      <button
        onClick={() => {
          s.clearUnread();
          s.openPanel({ kind: 'alert', alertId: s.alerts[0]?.id ?? '' });
        }}
        className="relative rounded-[6px] p-1.5 transition-colors hover:bg-[var(--surface-2)]"
        style={{ color: s.unread ? 'var(--alert)' : 'var(--text-dim)' }}
        aria-label={`Alerts (${s.unread} unread)`}
      >
        <Bell size={16} className={s.unread ? 'anim-blink' : ''} />
        {s.unread > 0 && (
          <span
            className="mono absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 text-[9px] font-bold"
            style={{ background: 'var(--alert)', color: '#231502' }}
          >
            {s.unread > 99 ? '99+' : s.unread}
          </span>
        )}
      </button>
    </header>
  );
}
