import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { DB_READY, db } from './db';

/**
 * Identity and role.
 *
 * Row-level security in Postgres is what actually enforces access — this
 * module only reports who is signed in so the UI can show the right controls.
 * A role read here is a hint for rendering, never a security decision: hiding
 * a button does not stop a request, and the database refuses it either way.
 */

export type Role = 'admin' | 'supervisor' | 'operator' | 'viewer';

export interface Profile {
  id: string;
  email: string | null;
  full_name: string | null;
  role: Role;
  department_id: string | null;
  zone_id: string | null;
}

export interface AuthState {
  ready: boolean;
  session: Session | null;
  profile: Profile | null;
}

/** Can this role write to the registry? Mirrors the `write_cameras` policy. */
export function canWrite(role: Role | undefined): boolean {
  return role === 'admin' || role === 'supervisor';
}

export function canAcknowledge(role: Role | undefined): boolean {
  return role === 'admin' || role === 'supervisor' || role === 'operator';
}

async function loadProfile(userId: string): Promise<Profile | null> {
  if (!db) return null;
  const { data } = await db
    .from('profiles')
    .select('id,email,full_name,role,department_id,zone_id')
    .eq('id', userId)
    .maybeSingle();
  return (data as Profile) ?? null;
}

/*
 * Signed in without a sign-in form, for people the console is shared with.
 *
 * The deployment can hold a shared account's credentials server-side
 * (api/demo-session.js); a visitor with no session is signed into it
 * automatically, so a link can be opened and used without registering and
 * waiting for approval. The password never reaches the browser — only a
 * session token that expires and is refreshed the normal way.
 *
 * Where the deployment has no such account configured, or during local
 * development, the endpoint declines and the ordinary sign-in form stays.
 * Someone who signs out on purpose stays signed out for the rest of the visit.
 */
const OPTED_OUT = 'sentinel-signed-out';
let demoAttempt: Promise<void> | null = null;

export function ensureDemoSession(): Promise<void> {
  if (demoAttempt) return demoAttempt;
  demoAttempt = (async () => {
    if (!db) return;
    const { data } = await db.auth.getSession();
    if (data.session) return;
    try {
      if (sessionStorage.getItem(OPTED_OUT)) return;
    } catch {
      /* storage blocked: fall through and sign in */
    }
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/demo-session`, { method: 'POST' });
      if (!res.ok || !(res.headers.get('content-type') || '').includes('application/json')) return;
      const { access_token, refresh_token } = await res.json();
      if (access_token && refresh_token) await db.auth.setSession({ access_token, refresh_token });
    } catch {
      /* no demo account here — the sign-in form remains */
    }
  })();
  return demoAttempt;
}

/**
 * Current session and profile, kept in step with Supabase's own auth events so
 * a sign-in in another tab is reflected here too.
 */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    // With no database there is nothing to sign in to, so the app is
    // immediately "ready" in its read-only grid mode.
    ready: !DB_READY,
    session: null,
    profile: null,
  });

  useEffect(() => {
    if (!db) return;
    let live = true;

    const apply = async (session: Session | null) => {
      const profile = session?.user ? await loadProfile(session.user.id) : null;
      if (live) setState({ ready: true, session, profile });
    };

    const { data: sub } = db.auth.onAuthStateChange((_e, session) => {
      void apply(session);
    });
    // A visitor with no session is signed into the shared account, if the
    // deployment offers one; the auth event above then reports it.
    void ensureDemoSession().then(() => db!.auth.getSession()).then(({ data }) => apply(data.session));

    return () => {
      live = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}

export async function signIn(email: string, password: string): Promise<void> {
  if (!db) throw new Error('No database configured');
  try { sessionStorage.removeItem(OPTED_OUT); } catch { /* ignore */ }
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

export async function signUp(email: string, password: string, fullName: string): Promise<void> {
  if (!db) throw new Error('No database configured');
  const { error } = await db.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } },
  });
  if (error) throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  // Deliberate: do not sign this visitor straight back into the shared account.
  try { sessionStorage.setItem(OPTED_OUT, '1'); } catch { /* ignore */ }
  await db?.auth.signOut();
}

/** True when a database is configured AND someone is signed into it. */
export async function isSignedIn(): Promise<boolean> {
  if (!db) return false;
  const { data } = await db.auth.getSession();
  return !!data.session;
}
