import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { LogIn, LogOut, ShieldCheck, X } from 'lucide-react';
import { Button, Spinner } from '@/components/ui';
import { DB_READY } from '@/api/db';
import { signIn, signOut, signUp, useAuth, type Role } from '@/api/auth';

const ROLE_COLOUR: Record<Role, string> = {
  admin: 'var(--critical)',
  supervisor: 'var(--alert)',
  operator: 'var(--signal)',
  viewer: 'var(--text-mute)',
};

/**
 * Sign-in control for the command bar.
 *
 * The app deliberately still works signed out — it falls back to the live grid
 * catalogue, read-only — so this is not a gate in front of the map. Signing in
 * is what switches the registry to the database and unlocks onboarding, the
 * audit trail and anything else row-level security protects.
 */
export function AuthBar() {
  const { ready, session, profile } = useAuth();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  if (!DB_READY) {
    return (
      <span
        className="mono hidden text-[10.5px] sm:inline"
        style={{ color: 'var(--text-mute)' }}
        title="No Supabase project configured — the registry is the read-only live grid catalogue"
      >
        REGISTRY OFFLINE
      </span>
    );
  }

  if (!ready) return <Spinner size={12} />;

  if (session && profile) {
    return (
      <div className="flex items-center gap-1.5">
        <ShieldCheck size={12} style={{ color: ROLE_COLOUR[profile.role] }} />
        <span className="hidden text-[11px] sm:inline" style={{ color: 'var(--text-dim)' }}>
          {profile.email}
        </span>
        <span
          className="mono rounded-[3px] px-1 text-[9.5px] font-bold uppercase"
          style={{ background: ROLE_COLOUR[profile.role], color: '#0B1220' }}
        >
          {profile.role}
        </span>
        <button
          onClick={async () => {
            await signOut();
            await qc.invalidateQueries({ queryKey: ['cameras.all'] });
          }}
          title="Sign out"
          className="ml-0.5 rounded-[4px] p-1 transition-colors hover:bg-[var(--surface-2)]"
          style={{ color: 'var(--text-mute)' }}
        >
          <LogOut size={12} />
        </button>
      </div>
    );
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <LogIn size={13} /> Sign in
      </Button>
      {open && <AuthDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function AuthDialog({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const qc = useQueryClient();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      if (mode === 'in') {
        await signIn(email, password);
        await qc.invalidateQueries({ queryKey: ['cameras.all'] });
        onClose();
      } else {
        await signUp(email, password, name);
        // Supabase may require an email confirmation depending on project
        // settings, so do not claim the account is usable yet.
        setMsg('Account created. If your project has email confirmation on, confirm it before signing in.');
        setMode('in');
      }
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <>
      <div className="fixed inset-0 z-[100]" style={{ background: 'rgba(4,8,15,0.72)' }} onClick={onClose} />
      <div
        className="anim-fade-up fixed left-1/2 top-1/2 z-[101] w-[92vw] max-w-[380px] -translate-x-1/2 -translate-y-1/2 rounded-[10px] p-4"
        style={{ background: 'var(--surface)', border: '1px solid var(--line)', boxShadow: 'var(--sh-lg)' }}
      >
        <div className="mb-3 flex items-center">
          <span className="display text-[14px] font-semibold" style={{ color: 'var(--text)' }}>
            {mode === 'in' ? 'Sign in to Sentinel' : 'Create an account'}
          </span>
          <button onClick={onClose} className="ml-auto rounded-[4px] p-1" style={{ color: 'var(--text-mute)' }}>
            <X size={14} />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-2">
          {mode === 'up' && (
            <Input label="Full name" value={name} onChange={setName} autoComplete="name" />
          )}
          <Input label="Email" value={email} onChange={setEmail} type="email" autoComplete="email" />
          <Input
            label="Password" value={password} onChange={setPassword} type="password"
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
          />

          {err && (
            <div className="rounded-[5px] px-2 py-1.5 text-[11.5px]"
                 style={{ background: 'var(--critical-dim)', border: '1px solid var(--critical)', color: 'var(--text)' }}>
              {err}
            </div>
          )}
          {msg && (
            <div className="rounded-[5px] px-2 py-1.5 text-[11.5px]"
                 style={{ background: 'var(--signal-dim)', border: '1px solid var(--signal)', color: 'var(--text)' }}>
              {msg}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-1.5 rounded-[6px] py-2 text-[12.5px] font-medium"
            style={{ background: 'var(--signal)', color: '#04201C', opacity: busy ? 0.6 : 1 }}
          >
            {busy ? <Spinner size={12} /> : <LogIn size={13} />}
            {mode === 'in' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <button
          onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr(null); }}
          className="mt-2 w-full text-[11.5px]"
          style={{ color: 'var(--text-mute)' }}
        >
          {mode === 'in' ? 'No account yet? Create one' : 'Already have an account? Sign in'}
        </button>

        <p className="mt-3 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
          New accounts start as <strong>viewer</strong>, which is read-only.
          Onboarding and edits need <strong>supervisor</strong> or{' '}
          <strong>admin</strong> — a role is granted in the database, not here,
          so it cannot be raised from the browser.
        </p>
      </div>
    </>,
    document.body,
  );
}

function Input({
  label, value, onChange, type = 'text', autoComplete,
}: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--text-mute)' }}>
        {label}
      </span>
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        required
        className="w-full rounded-[5px] px-2 py-1.5 text-[12.5px]"
        style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--line)' }}
      />
    </label>
  );
}
