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

    void db.auth.getSession().then(({ data }) => apply(data.session));
    const { data: sub } = db.auth.onAuthStateChange((_e, session) => {
      void apply(session);
    });

    return () => {
      live = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}

export async function signIn(email: string, password: string): Promise<void> {
  if (!db) throw new Error('No database configured');
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
  await db?.auth.signOut();
}

/** True when a database is configured AND someone is signed into it. */
export async function isSignedIn(): Promise<boolean> {
  if (!db) return false;
  const { data } = await db.auth.getSession();
  return !!data.session;
}
