import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import {
  AlertTriangle, Check, Database, Download, FileSpreadsheet,
  Plus, RefreshCw, Terminal, Upload,
} from 'lucide-react';
import { Button, Empty, Pill, SectionHeader, Spinner } from '@/components/ui';
import { DB_READY } from '@/api/db';
import { importFromGrid, upsertCameras, type CameraInput } from '@/api/cameraStore';
import {
  FIELDS, autoMap, buildRows,
  type FieldKey, type Mapping, type ParsedRow,
} from './columnMap';

type Tab = 'bulk' | 'manual' | 'api';

/**
 * Camera onboarding — the three ways into the registry.
 *
 * Bulk import is the path that matters: departments already keep their camera
 * lists in spreadsheets, and no two of them use the same column names. The
 * importer reads whatever headers the file has, maps them to the internal
 * schema itself, and shows the operator that decision before a single row is
 * written. Every mapping stays editable, and rows that fail validation are
 * displayed rather than quietly dropped.
 */
export function OnboardingPanel() {
  const [tab, setTab] = useState<Tab>('bulk');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-1 px-3 pt-3">
        {([
          ['bulk', 'Bulk import', FileSpreadsheet],
          ['manual', 'Manual entry', Plus],
          ['api', 'Onboarding API', Terminal],
        ] as const).map(([k, label, Icon]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className="flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-[12px] transition-colors"
            style={{
              background: tab === k ? 'var(--signal-dim)' : 'transparent',
              color: tab === k ? 'var(--signal)' : 'var(--text-dim)',
              border: `1px solid ${tab === k ? 'var(--signal)' : 'var(--line)'}`,
            }}
          >
            <Icon size={12} /> {label}
          </button>
        ))}
      </div>

      {!DB_READY && <NoDatabase />}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3">
        {tab === 'bulk' && <BulkImport />}
        {tab === 'manual' && <ManualEntry />}
        {tab === 'api' && <ApiDocs />}
      </div>
    </div>
  );
}

/** The registry is read-only until Supabase is configured. Say so plainly. */
function NoDatabase() {
  return (
    <div
      className="mx-3 mt-3 flex items-start gap-2 rounded-[6px] px-3 py-2.5"
      style={{ background: 'var(--alert-dim)', border: '1px solid var(--alert)' }}
    >
      <AlertTriangle size={14} style={{ color: 'var(--alert)', flexShrink: 0, marginTop: 1 }} />
      <div className="text-[11.5px]" style={{ color: 'var(--text)' }}>
        <strong>No database connected.</strong> The map is showing the live grid
        catalogue, which is read-only — onboarding needs somewhere to write.
        Set <code className="mono">VITE_SUPABASE_URL</code> and{' '}
        <code className="mono">VITE_SUPABASE_ANON_KEY</code>, then run{' '}
        <code className="mono">supabase/migrations/0001_registry.sql</code>.
      </div>
    </div>
  );
}

/* ── Bulk import ─────────────────────────────────────────────────────── */

function BulkImport() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [raw, setRaw] = useState<Record<string, unknown>[]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(
    () => (raw.length ? buildRows(raw, mapping) : []),
    [raw, mapping],
  );
  const good = rows.filter((r) => !r.errors.length);
  const bad = rows.filter((r) => r.errors.length);

  const missingRequired = FIELDS.filter(
    (f) => f.required && !Object.values(mapping).includes(f.key),
  );

  const onFile = useCallback((file: File) => {
    setError(null);
    setResult(null);
    setFileName(file.name);

    const finish = (rowsIn: Record<string, unknown>[], hdrs: string[]) => {
      setRaw(rowsIn);
      setHeaders(hdrs);
      setMapping(autoMap(hdrs));
    };

    if (/\.(xlsx|xls)$/i.test(file.name)) {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const wb = XLSX.read(reader.result, { type: 'array' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
            defval: '',
            raw: false,
          });
          finish(json, Object.keys(json[0] ?? {}));
        } catch (e) {
          setError(`Could not read the workbook: ${(e as Error).message}`);
        }
      };
      reader.readAsArrayBuffer(file);
      return;
    }

    Papa.parse<Record<string, unknown>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      complete: (res) => finish(res.data, res.meta.fields ?? []),
      error: (e) => setError(`Could not read the file: ${e.message}`),
    });
  }, []);

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const n = await upsertCameras(
        good.map((r) => ({ ...r.data, source: 'csv' } as CameraInput)),
      );
      setResult(`${n} camera${n === 1 ? '' : 's'} written to the registry.`);
      await qc.invalidateQueries({ queryKey: ['cameras.all'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const seedFromGrid = async () => {
    setBusy(true);
    setError(null);
    try {
      const n = await importFromGrid();
      setResult(`${n} cameras imported from the live grid.`);
      await qc.invalidateQueries({ queryKey: ['cameras.all'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,.txt,.xlsx,.xls"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        />
        <Button onClick={() => fileRef.current?.click()}>
          <Upload size={13} /> Choose CSV or Excel
        </Button>
        <Button onClick={seedFromGrid} disabled={!DB_READY || busy}>
          <RefreshCw size={13} /> Import the 30 live grid cameras
        </Button>
        <Button onClick={downloadTemplate}>
          <Download size={13} /> Template
        </Button>
        {fileName && (
          <span className="mono text-[11px]" style={{ color: 'var(--text-mute)' }}>
            {fileName} · {raw.length} rows
          </span>
        )}
      </div>

      {error && <Notice tone="critical">{error}</Notice>}
      {result && <Notice tone="signal"><Check size={12} /> {result}</Notice>}

      {!headers.length && !result && (
        <Empty>
          Pick a department&rsquo;s spreadsheet. Columns are matched to the
          registry automatically — you confirm the mapping before anything is
          saved.
        </Empty>
      )}

      {headers.length > 0 && (
        <>
          <SectionHeader>Detected column mapping</SectionHeader>
          <div className="space-y-1">
            {headers.map((h) => (
              <div key={h} className="flex items-center gap-2">
                <span
                  className="mono flex-1 truncate text-[11.5px]"
                  style={{ color: 'var(--text)' }}
                  title={h}
                >
                  {h}
                </span>
                <span style={{ color: 'var(--text-mute)' }}>&rarr;</span>
                <select
                  value={mapping[h] ?? ''}
                  onChange={(e) =>
                    setMapping((m) => ({
                      ...m,
                      [h]: (e.target.value || null) as FieldKey | null,
                    }))
                  }
                  className="w-[190px] rounded-[5px] px-2 py-1 text-[11.5px]"
                  style={{
                    background: 'var(--surface-2)',
                    color: mapping[h] ? 'var(--text)' : 'var(--text-mute)',
                    border: `1px solid ${mapping[h] ? 'var(--signal)' : 'var(--line)'}`,
                  }}
                >
                  <option value="">(ignore this column)</option>
                  {FIELDS.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}{f.required ? ' *' : ''}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {missingRequired.length > 0 && (
            <Notice tone="alert">
              <AlertTriangle size={12} /> Unmapped required field
              {missingRequired.length > 1 ? 's' : ''}:{' '}
              {missingRequired.map((f) => f.label).join(', ')}
            </Notice>
          )}

          <SectionHeader>
            Preview — {good.length} ready, {bad.length} with problems
          </SectionHeader>

          <div className="overflow-x-auto">
            <table className="w-full text-[11px]" style={{ color: 'var(--text)' }}>
              <thead>
                <tr style={{ color: 'var(--text-mute)' }}>
                  <th className="p-1 text-left">Row</th>
                  <th className="p-1 text-left">ID</th>
                  <th className="p-1 text-left">Name</th>
                  <th className="p-1 text-left">Lat / Lng</th>
                  <th className="p-1 text-left">Problem</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 60).map((r) => (
                  <PreviewRow key={r.row} r={r} />
                ))}
              </tbody>
            </table>
            {rows.length > 60 && (
              <div className="mono p-1 text-[10.5px]" style={{ color: 'var(--text-mute)' }}>
                …and {rows.length - 60} more rows
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              onClick={commit}
              disabled={!DB_READY || busy || !good.length || missingRequired.length > 0}
            >
              {busy ? <Spinner size={12} /> : <Database size={13} />}
              Import {good.length} camera{good.length === 1 ? '' : 's'}
            </Button>
            {bad.length > 0 && (
              <span className="text-[11px]" style={{ color: 'var(--alert)' }}>
                {bad.length} row{bad.length === 1 ? '' : 's'} will be skipped
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function PreviewRow({ r }: { r: ParsedRow }) {
  const ok = !r.errors.length;
  const d = r.data as Record<string, unknown>;
  return (
    <tr style={{ borderTop: '1px solid var(--line)' }}>
      <td className="mono p-1" style={{ color: 'var(--text-mute)' }}>{r.row}</td>
      <td className="mono p-1">{String(d.id || '—')}</td>
      <td className="p-1">{String(d.name || '—')}</td>
      <td className="mono p-1" style={{ color: 'var(--text-dim)' }}>
        {d.lat != null && d.lng != null
          ? `${Number(d.lat).toFixed(4)}, ${Number(d.lng).toFixed(4)}`
          : '—'}
      </td>
      <td className="p-1" style={{ color: ok ? 'var(--signal)' : 'var(--critical)' }}>
        {ok ? 'ready' : r.errors.join('; ')}
      </td>
    </tr>
  );
}

/** A blank file in the exact shape the importer expects. */
function downloadTemplate() {
  const header = FIELDS.map((f) => f.label).join(',');
  const example = [
    'GJ-AH-001', 'Paldi Circle', 'traffic', 'Ahmedabad', 'Z-AHMD',
    'anpr', 'yes', '23.0107', '72.5619',
    'https://example/stream/index.m3u8', 'rtsp://10.0.0.5:554/stream', '', 'Hikvision',
    'online', '2024-01-15', '2026-02-01', 'junction;highway',
  ].join(',');
  const blob = new Blob([`${header}\n${example}\n`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'sentinel-camera-template.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── Manual entry ────────────────────────────────────────────────────── */

const BLANK: CameraInput = {
  id: '', name: '', department_id: 'police', district: '', zone_id: '',
  cam_type: 'fixed', anpr_capable: false, lat: null, lng: null,
  hls_url: '', rtsp_url: '', vendor: '', status: 'unknown', tags: [],
};

function ManualEntry() {
  const qc = useQueryClient();
  const [form, setForm] = useState<CameraInput>(BLANK);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const set = <K extends keyof CameraInput>(k: K, v: CameraInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      if (!form.id.trim() || !form.name.trim()) throw new Error('ID and name are required');
      await upsertCameras([{ ...form, source: 'manual' }]);
      setMsg(`${form.id} saved to the registry.`);
      setForm(BLANK);
      await qc.invalidateQueries({ queryKey: ['cameras.all'] });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2.5">
      {err && <Notice tone="critical">{err}</Notice>}
      {msg && <Notice tone="signal"><Check size={12} /> {msg}</Notice>}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Camera ID *" value={form.id} onChange={(v) => set('id', v)} mono />
        <Field label="Name / location *" value={form.name} onChange={(v) => set('name', v)} />
        <Select
          label="Department"
          value={form.department_id ?? ''}
          onChange={(v) => set('department_id', v)}
          options={['police', 'traffic', 'health', 'pds', 'rto', 'municipal']}
        />
        <Field label="District" value={form.district ?? ''} onChange={(v) => set('district', v)} />
        <Select
          label="Camera type"
          value={form.cam_type ?? 'fixed'}
          onChange={(v) => set('cam_type', v)}
          options={['fixed', 'ptz', 'anpr', 'overview']}
        />
        <Select
          label="Status"
          value={form.status ?? 'unknown'}
          onChange={(v) => set('status', v)}
          options={['unknown', 'online', 'offline', 'degraded', 'maintenance']}
        />
        <Field
          label="Latitude" mono value={form.lat == null ? '' : String(form.lat)}
          onChange={(v) => set('lat', v === '' ? null : Number(v))}
        />
        <Field
          label="Longitude" mono value={form.lng == null ? '' : String(form.lng)}
          onChange={(v) => set('lng', v === '' ? null : Number(v))}
        />
      </div>

      <Field label="HLS / stream URL" mono value={form.hls_url ?? ''} onChange={(v) => set('hls_url', v)} />
      <Field label="RTSP URL" mono value={form.rtsp_url ?? ''} onChange={(v) => set('rtsp_url', v)} />
      <Field label="Vendor / make" value={form.vendor ?? ''} onChange={(v) => set('vendor', v)} />
      <Field
        label="Tags (comma separated)"
        value={(form.tags ?? []).join(', ')}
        onChange={(v) => set('tags', v.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))}
      />

      <div className="flex items-center gap-2 pt-1">
        <Button onClick={save} disabled={!DB_READY || busy}>
          {busy ? <Spinner size={12} /> : <Plus size={13} />} Add camera
        </Button>
        <label className="flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--text)' }}>
          <input
            type="checkbox"
            checked={!!form.anpr_capable}
            onChange={(e) => set('anpr_capable', e.target.checked)}
          />
          ANPR capable
        </label>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, mono,
}: { label: string; value: string; onChange: (v: string) => void; mono?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--text-mute)' }}>
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded-[5px] px-2 py-1.5 text-[12px] ${mono ? 'mono' : ''}`}
        style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--line)' }}
      />
    </label>
  );
}

function Select({
  label, value, onChange, options,
}: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--text-mute)' }}>
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-[5px] px-2 py-1.5 text-[12px]"
        style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--line)' }}
      >
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

/* ── API docs ────────────────────────────────────────────────────────── */

function ApiDocs() {
  const url = import.meta.env.VITE_SUPABASE_URL || 'https://<your-project>.supabase.co';
  return (
    <div className="space-y-3 text-[12px]" style={{ color: 'var(--text)' }}>
      <p style={{ color: 'var(--text-dim)' }}>
        Cameras can be pushed straight into the registry by a departmental
        system. This is the same table the map and the video wall read, so a
        camera onboarded over the API appears on the map immediately — there is
        no separate import step.
      </p>

      <SectionHeader>Create or update cameras</SectionHeader>
      <Code>{`POST ${url}/rest/v1/cameras?on_conflict=id
apikey: <anon or service key>
Authorization: Bearer <access token>
Content-Type: application/json
Prefer: resolution=merge-duplicates

[
  {
    "id": "GJ-AH-001",
    "name": "Paldi Circle",
    "department_id": "traffic",
    "district": "Ahmedabad",
    "cam_type": "anpr",
    "anpr_capable": true,
    "hls_url": "https://.../index.m3u8",
    "rtsp_url": "rtsp://10.0.0.5:554/stream",
    "status": "online",
    "geom": "SRID=4326;POINT(72.5619 23.0107)",
    "tags": ["junction", "highway"],
    "source": "api"
  }
]`}</Code>

      <SectionHeader>Read the registry</SectionHeader>
      <Code>{`GET ${url}/rest/v1/cameras?select=*&status=eq.online
GET ${url}/rest/v1/cameras?select=*&department_id=eq.traffic&anpr_capable=is.true`}</Code>

      <SectionHeader>Audit trail</SectionHeader>
      <Code>{`GET ${url}/rest/v1/audit_log?entity=eq.cameras&order=at.desc&limit=50`}</Code>

      <div
        className="rounded-[6px] px-3 py-2 text-[11.5px]"
        style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text-dim)' }}
      >
        <strong style={{ color: 'var(--text)' }}>Notes.</strong> Writes require a
        signed-in user whose role is <code className="mono">admin</code> or{' '}
        <code className="mono">supervisor</code> — row-level security enforces
        that in the database, not in this app, so the rule holds for any client.
        Every insert, update and delete is written to{' '}
        <code className="mono">audit_log</code> by a trigger, so a caller cannot
        skip the audit trail by talking to the API directly.{' '}
        <code className="mono">geom</code> takes EWKT; latitude and longitude
        come back as <code className="mono">lat</code> /{' '}
        <code className="mono">lng</code> via the select in{' '}
        <code className="mono">src/api/db.ts</code>.
      </div>
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre
      className="mono overflow-x-auto rounded-[6px] p-2.5 text-[10.5px] leading-relaxed"
      style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
    >
      {children}
    </pre>
  );
}

function Notice({ tone, children }: { tone: 'signal' | 'alert' | 'critical'; children: React.ReactNode }) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-[6px] px-2.5 py-2 text-[11.5px]"
      style={{
        background: `var(--${tone}-dim)`,
        border: `1px solid var(--${tone})`,
        color: 'var(--text)',
      }}
    >
      {children}
    </div>
  );
}

export { Pill };
