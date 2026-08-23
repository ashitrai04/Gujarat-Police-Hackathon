import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, Bus, Crosshair, Flame, Fuel, Hospital, Map as MapIcon,
  PanelLeftClose, PanelLeftOpen, Radio, Shield, ListFilter,
  Route as RouteIcon, Search, Siren,
} from 'lucide-react';
import { api } from '@/api/client';
import { ALL_DOMAINS, useStore, type PoiLayer } from './store';
import { useBreakpoint } from './useBreakpoint';
import { DOMAIN_COLOR, DOMAIN_LABEL, type CameraStatus, type Domain } from '@/api/types';
import { Button, Empty, SectionHeader, StatusDot, ToggleRow } from '@/components/ui';
import { DOMAIN_MARKER_SRC } from '@/map/icons';
import type { GisLayer } from '@/app/store';

/**
 * Legend for the supplied GeoPackage layers. The swatch mirrors what the map
 * draws — a bar for line layers, a block for the district fill — so the rail
 * reads as a key rather than a list of checkboxes.
 */
const GIS_META: { key: GisLayer; label: string; colour: string; shape: 'line' | 'area' }[] = [
  { key: 'state', label: 'State boundary', colour: '#FF1744', shape: 'line' },
  { key: 'districts', label: 'Districts', colour: '#FF4FD8', shape: 'area' },
  { key: 'highways', label: 'National highways', colour: '#FB923C', shape: 'line' },
  { key: 'roads', label: 'Major roads', colour: '#22D3EE', shape: 'line' },
];

const POI_META: Record<PoiLayer, { label: string; icon: typeof Hospital; colour: string }> = {
  hospital: { label: 'Hospitals', icon: Hospital, colour: '#F472B6' },
  police: { label: 'Police stations', icon: Shield, colour: '#38BDF8' },
  fuel: { label: 'Fuel stations', icon: Fuel, colour: '#FBBF24' },
  bus_station: { label: 'Bus depots', icon: Bus, colour: '#A78BFA' },
};

const STATUSES: CameraStatus[] = ['online', 'degraded', 'offline'];

export function LeftRail() {
  const s = useStore();
  const bp = useBreakpoint();
  const setRailCollapsed = useStore((x) => x.setRailCollapsed);

  // Below 'mid' there isn't room for a 264px rail AND a usable map.
  useEffect(() => {
    setRailCollapsed(bp === 'narrow');
  }, [bp, setRailCollapsed]);
  const { data: all } = useQuery({ queryKey: ['cameras.all'], queryFn: () => api.cameras() });

  const scoped = useMemo(() => (all ? s.visibleCameras(all) : []), [all, s.role]);

  const perDomain = useMemo(() => {
    const m = {} as Record<Domain, number>;
    for (const d of ALL_DOMAINS) m[d] = 0;
    for (const c of scoped) m[c.domain]++;
    return m;
  }, [scoped]);

  const visibleCount = useMemo(
    () =>
      scoped.filter((c) => {
        if (!s.domains.includes(c.domain)) return false;
        if (!s.statuses.includes(c.status)) return false;
        if (s.anprOnly && !c.anprCapable) return false;
        if (s.query) {
          const hay = [c.name, c.district, c.department, c.id, ...c.tags].join(' ').toLowerCase();
          if (!hay.includes(s.query.toLowerCase())) return false;
        }
        return true;
      }).length,
    [scoped, s.domains, s.statuses, s.anprOnly, s.query],
  );

  const filtersActive =
    s.domains.length !== ALL_DOMAINS.length ||
    s.statuses.length !== 3 ||
    s.anprOnly ||
    !!s.query;

  if (s.railCollapsed) {
    return (
      <aside
        className="z-20 flex w-[46px] shrink-0 flex-col items-center gap-1 py-2"
        style={{ background: 'var(--surface)', borderRight: '1px solid var(--line)' }}
      >
        <button
          onClick={s.toggleRail}
          className="rounded-[6px] p-2 hover:bg-[var(--surface-2)]"
          style={{ color: 'var(--text-dim)' }}
          title="Show filters"
          aria-label="Show filters"
        >
          <PanelLeftOpen size={15} />
        </button>
        <div className="my-1 h-px w-6" style={{ background: 'var(--line)' }} />
        <span className="mono text-[12px] font-semibold" style={{ color: 'var(--signal)' }}>
          {visibleCount}
        </span>
        <div className="my-1 h-px w-6" style={{ background: 'var(--line)' }} />
        {[
          { icon: RouteIcon, label: 'Trace a vehicle', p: { kind: 'trace' as const } },
          { icon: Siren, label: 'Watchlist', p: { kind: 'watchlist' as const } },
          { icon: Search, label: 'Event search', p: { kind: 'events' as const } },
          { icon: Radio, label: 'Camera health', p: { kind: 'health' as const } },
        ].map(({ icon: Icon, label, p }) => (
          <button
            key={label}
            onClick={() => s.openPanel(p)}
            title={label}
            aria-label={label}
            className="rounded-[6px] p-2 hover:bg-[var(--surface-2)]"
            style={{ color: 'var(--text-dim)' }}
          >
            <Icon size={15} />
          </button>
        ))}
      </aside>
    );
  }

  return (
    <aside
      className="z-20 flex shrink-0 flex-col overflow-y-auto"
      style={{
        width: 'var(--rail-w)',
        background: 'var(--surface)',
        borderRight: '1px solid var(--line)',
      }}
    >
      {/* Visible count — the headline number */}
      <div className="px-3 pb-2 pt-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="panel-title">Filters</span>
          <button
            onClick={s.toggleRail}
            className="rounded-[5px] p-1 hover:bg-[var(--surface-2)]"
            style={{ color: 'var(--text-mute)' }}
            title="Collapse"
            aria-label="Collapse filters"
          >
            <PanelLeftClose size={13} />
          </button>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="mono text-[22px] font-semibold leading-none" style={{ color: 'var(--signal)' }}>
            {visibleCount}
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            of {scoped.length} cameras shown
          </span>
        </div>
        {filtersActive && (
          <button
            onClick={s.clearFilters}
            className="mt-1.5 text-[11px] underline underline-offset-2"
            style={{ color: 'var(--text-mute)' }}
          >
            Clear all filters
          </button>
        )}
      </div>

      <Divider />

      {/* Camera domains */}
      <SectionHeader>Camera layers</SectionHeader>
      <div className="px-1.5 pb-1">
        {ALL_DOMAINS.map((d) => (
          <ToggleRow
            key={d}
            on={s.domains.includes(d)}
            onClick={() => s.toggleDomain(d)}
            colour={DOMAIN_COLOR[d]}
            label={DOMAIN_LABEL[d]}
            count={perDomain[d]}
            icon={
              <img
                src={DOMAIN_MARKER_SRC[d]}
                alt=""
                aria-hidden
                className="h-[18px] w-[18px] shrink-0 object-contain"
              />
            }
          />
        ))}
      </div>

      <div className="px-3 pb-2.5 pt-1">
        <button
          onClick={() => s.setAnprOnly(!s.anprOnly)}
          aria-pressed={s.anprOnly}
          className="flex w-full items-center justify-between rounded-[6px] px-2.5 py-2 text-left transition-colors"
          style={{
            background: s.anprOnly ? 'var(--signal-dim)' : 'var(--surface-2)',
            border: `1px solid ${s.anprOnly ? 'var(--signal)' : 'var(--line)'}`,
          }}
        >
          <span className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--text)' }}>
            <Crosshair size={12} style={{ color: s.anprOnly ? 'var(--signal)' : 'var(--text-mute)' }} />
            ANPR-capable only
          </span>
          <span
            className="h-[14px] w-[24px] rounded-full p-[2px] transition-colors"
            style={{ background: s.anprOnly ? 'var(--signal)' : 'var(--line)' }}
          >
            <span
              className="block h-[10px] w-[10px] rounded-full bg-white transition-transform"
              style={{ transform: s.anprOnly ? 'translateX(10px)' : 'none' }}
            />
          </span>
        </button>
      </div>

      <Divider />

      {/* Status */}
      <SectionHeader>Status</SectionHeader>
      <div className="px-1.5 pb-1">
        {STATUSES.map((st) => (
          <ToggleRow
            key={st}
            on={s.statuses.includes(st)}
            onClick={() => s.toggleStatus(st)}
            label={st[0].toUpperCase() + st.slice(1)}
            icon={<StatusDot status={st} />}
            count={scoped.filter((c) => c.status === st).length}
          />
        ))}
      </div>

      <Divider />

      {/* Map layers */}
      <SectionHeader>Map layers</SectionHeader>
      <div className="px-1.5 pb-1">
        <ToggleRow
          on={s.showBoundaries}
          onClick={s.toggleBoundaries}
          label="District boundaries"
          icon={<MapIcon size={12} style={{ color: '#38BDF8' }} />}
        />
        <ToggleRow
          on={s.showHeat}
          onClick={s.toggleHeat}
          label="Detection heatmap"
          icon={<Flame size={12} style={{ color: '#F5A524' }} />}
        />
        <ToggleRow
          on={s.showGaps}
          onClick={s.toggleGaps}
          label="Coverage gaps"
          icon={<Activity size={12} style={{ color: '#EF4444' }} />}
        />
      </div>

      <Divider />

      {/* Gujarat GIS — the reference geography a vehicle route is read against */}
      <SectionHeader>Gujarat GIS</SectionHeader>
      <div className="px-1.5 pb-1">
        {GIS_META.map((g) => (
          <ToggleRow
            key={g.key}
            on={s.gis.includes(g.key)}
            onClick={() => s.toggleGis(g.key)}
            colour={g.colour}
            label={g.label}
            icon={
              <span
                className="inline-block shrink-0 rounded-full"
                style={{
                  width: 13,
                  height: g.shape === 'line' ? 3 : 11,
                  borderRadius: g.shape === 'line' ? 2 : 3,
                  background: g.colour,
                  boxShadow: `0 0 6px ${g.colour}`,
                }}
              />
            }
          />
        ))}
      </div>

      <Divider />

      {/* Reference POIs */}
      <SectionHeader>Reference layers</SectionHeader>
      <div className="px-1.5 pb-1">
        {(Object.keys(POI_META) as PoiLayer[]).map((k) => {
          const M = POI_META[k];
          return (
            <ToggleRow
              key={k}
              on={s.pois.includes(k)}
              onClick={() => s.togglePoi(k)}
              colour={M.colour}
              label={M.label}
              icon={<M.icon size={12} style={{ color: M.colour }} />}
            />
          );
        })}
      </div>
      <p className="px-3 pb-2 text-[10px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
        Reference facilities from OpenStreetMap — context only, not camera sites.
      </p>

      <Divider />

      {/* Tools */}
      <SectionHeader>Tools</SectionHeader>
      <div className="flex flex-col gap-1 px-2.5 pb-3">
        <RailButton icon={RouteIcon} label="Trace a vehicle" onClick={() => s.openPanel({ kind: 'trace' })} />
        <RailButton icon={Siren} label="Watchlist" onClick={() => s.openPanel({ kind: 'watchlist' })} />
        <RailButton icon={Search} label="Event search & report" onClick={() => s.openPanel({ kind: 'events' })} />
        <RailButton icon={Radio} label="Camera health" onClick={() => s.openPanel({ kind: 'health' })} />
      </div>

      <div className="px-3 pb-3">
        <p className="text-[10px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
          <ListFilter size={9} className="mr-1 inline" />
          Draw a box on the map, or click a district, to load those feeds into the video wall.
        </p>
      </div>
    </aside>
  );
}

function RailButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Search;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button onClick={onClick} className="w-full !justify-start">
      <Icon size={13} />
      {label}
    </Button>
  );
}

function Divider() {
  return <div className="mx-3 my-1 h-px" style={{ background: 'var(--line)' }} />;
}

export { Empty };
