export const config = { runtime: 'edge' };

/**
 * Signs a visitor in as the shared demonstration account.
 *
 * The console is shared by link with people who should not have to register
 * and wait for approval before they can see it work. The account's password
 * lives ONLY here, in SENTINEL_DEMO_PASSWORD — never in the browser bundle,
 * where anyone opening the site could read it. This function signs in on the
 * visitor's behalf and hands back the resulting session; the browser gets a
 * token that expires, not the password.
 *
 * Unconfigured (either variable missing), it answers 501 and the site behaves
 * exactly as before: a normal sign-in form.
 *
 *   SENTINEL_DEMO_EMAIL      the account visitors are signed into
 *   SENTINEL_DEMO_PASSWORD   its password
 *   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY   already set for the build
 */

const EMAIL = process.env.SENTINEL_DEMO_EMAIL || '';
const PASSWORD = process.env.SENTINEL_DEMO_PASSWORD || '';
const SUPABASE_URL = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  if (!EMAIL || !PASSWORD || !SUPABASE_URL || !ANON_KEY) {
    return json(501, { error: 'Demo sign-in is not configured on this deployment' });
  }

  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // Say why without echoing anything secret back.
    return json(502, { error: body.error_description || body.msg || `Sign-in refused (${res.status})` });
  }
  return json(200, { access_token: body.access_token, refresh_token: body.refresh_token });
}
