/**
 * Production proxy to the Sentinel feed host (Vercel serverless).
 *
 * The Vite proxy in vite.config.ts only exists during `npm run dev`, so a
 * deployed build would hit the origin directly and fail. It cannot be called
 * directly from a browser because of three upstream defects:
 *
 *   1. /live/* sends `Access-Control-Allow-Origin: *` TWICE. Browsers reject
 *      the duplicate ("contains multiple values '*, *'").
 *   2. live.sentinelgujarat.in 301s to live.corp8.cloud and that redirect
 *      carries no CORS headers at all.
 *   3. The stream session rides on a cookie flagged `Secure; SameSite=None;
 *      Partitioned`, which will not stick over a proxied plain-HTTP hop.
 *
 * This function normalises all three, exactly like the dev proxy.
 */

const ORIGIN = process.env.SENTINEL_ORIGIN ?? 'https://live.corp8.cloud';

// Headers that make Cloudflare serve a bot-challenge page when forwarded.
const STRIP_REQUEST = new Set([
  'host',
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'accept-language',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-vercel-id',
]);

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const upstreamPath = url.pathname.replace(/^\/api\/sentinel/, '') || '/';
  const target = `${ORIGIN}${upstreamPath}${url.search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIP_REQUEST.has(key.toLowerCase())) headers.set(key, value);
  });
  // Cookies must pass through — the stream session depends on them.
  headers.set('user-agent', 'curl/8.4.0');
  headers.set('accept', req.headers.get('accept') ?? '*/*');

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
      redirect: 'follow', // keep the ?cookieCheck=1 hop server-side
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'upstream unreachable', detail: String(err) }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    // Rebuild CORS ourselves so the duplicate can't come through.
    if (k === 'access-control-allow-origin' || k === 'access-control-allow-credentials') return;
    if (k === 'set-cookie') {
      out.append(
        'set-cookie',
        value
          .replace(/;\s*Secure/gi, '')
          .replace(/;\s*Partitioned/gi, '')
          .replace(/;\s*SameSite=None/gi, '; SameSite=Lax'),
      );
      return;
    }
    if (k === 'location') {
      out.set('location', value.replace(ORIGIN, '/api/sentinel'));
      return;
    }
    out.set(key, value);
  });
  out.set('access-control-allow-origin', '*');
  out.set('access-control-allow-headers', '*');
  out.set('access-control-expose-headers', '*');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}
