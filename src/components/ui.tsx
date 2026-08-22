import type { ReactNode, ButtonHTMLAttributes } from 'react';
import type { CameraStatus } from '@/api/types';
import { STATUS_COLOR } from '@/api/types';

/* ── Status dot ─────────────────────────────────────────────── */
export function StatusDot({
  status,
  label,
}: {
  status: CameraStatus;
  label?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-[7px] w-[7px] rounded-full shrink-0"
        style={{
          background: STATUS_COLOR[status],
          boxShadow: `0 0 6px ${STATUS_COLOR[status]}66`,
        }}
      />
      {label && (
        <span className="text-[11px] capitalize" style={{ color: 'var(--text-dim)' }}>
          {status}
        </span>
      )}
    </span>
  );
}

/* ── Button ─────────────────────────────────────────────────── */
type Variant = 'primary' | 'ghost' | 'danger' | 'subtle';

export function Button({
  variant = 'ghost',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-[6px] px-2.5 py-1.5 ' +
    'text-[12px] font-medium transition-colors duration-150 disabled:opacity-40 ' +
    'disabled:cursor-not-allowed whitespace-nowrap';
  const styles: Record<Variant, string> = {
    primary: 'text-[#04201C] hover:brightness-110',
    ghost: 'hover:bg-[var(--surface-2)]',
    danger: 'hover:brightness-110',
    subtle: 'hover:bg-[var(--surface-2)]',
  };
  const inline: Record<Variant, React.CSSProperties> = {
    primary: { background: 'var(--signal)' },
    ghost: { color: 'var(--text-dim)', border: '1px solid var(--line)' },
    danger: { background: 'var(--critical)', color: '#fff' },
    subtle: { color: 'var(--text-dim)' },
  };
  return (
    <button
      className={`${base} ${styles[variant]} ${className}`}
      style={inline[variant]}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ── Panel card ─────────────────────────────────────────────── */
export function Card({
  children,
  className = '',
  ...rest
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-[8px] ${className}`}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        boxShadow: 'var(--sh-sm)',
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

/* ── Section header inside rails/panels ─────────────────────── */
export function SectionHeader({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className="panel-title">{children}</span>
      {right}
    </div>
  );
}

/* ── Toggle row ─────────────────────────────────────────────── */
export function ToggleRow({
  on,
  onClick,
  colour,
  label,
  count,
  icon,
}: {
  on: boolean;
  onClick: () => void;
  colour?: string;
  label: string;
  count?: number;
  icon?: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className="group flex w-full items-center gap-2 rounded-[6px] px-2 py-[7px] text-left transition-colors duration-150 hover:bg-[var(--surface-2)]"
      style={{ opacity: on ? 1 : 0.42 }}
    >
      <span
        className="flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[4px] border transition-colors"
        style={{
          borderColor: on ? colour ?? 'var(--signal)' : 'var(--line)',
          background: on ? colour ?? 'var(--signal)' : 'transparent',
        }}
      >
        {on && (
          <svg viewBox="0 0 10 8" className="h-[7px] w-[7px]" fill="none">
            <path
              d="M1 4L3.5 6.5L9 1"
              stroke="#0B1220"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      {icon}
      <span className="flex-1 text-[12px]" style={{ color: 'var(--text)' }}>
        {label}
      </span>
      {count !== undefined && (
        <span className="mono text-[11px]" style={{ color: 'var(--text-mute)' }}>
          {count}
        </span>
      )}
    </button>
  );
}

/* ── Empty state — written as direction, not mood ───────────── */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      className="px-3 py-6 text-center text-[12px] leading-relaxed"
      style={{ color: 'var(--text-mute)' }}
    >
      {children}
    </div>
  );
}

/* ── Small pill ─────────────────────────────────────────────── */
export function Pill({
  children,
  colour,
  mono,
}: {
  children: ReactNode;
  colour?: string;
  mono?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-[4px] px-1.5 py-[2px] text-[10px] font-medium ${mono ? 'mono' : ''}`}
      style={{
        background: colour ? `${colour}1F` : 'var(--surface-2)',
        color: colour ?? 'var(--text-dim)',
        border: `1px solid ${colour ? `${colour}44` : 'var(--line)'}`,
      }}
    >
      {children}
    </span>
  );
}

/* ── Spinner ────────────────────────────────────────────────── */
export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="animate-spin"
      style={{ color: 'var(--signal)' }}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="3"
        fill="none"
        opacity="0.2"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
