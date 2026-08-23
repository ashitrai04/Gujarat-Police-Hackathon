export const config = { runtime: 'edge' };

/**
 * The estate answers on two names. `live.sentinelgujarat.in` is not a second
 * backend — it 301s to `live.corp8.cloud` for every path (verified on
 * /api/cameras, /camera/N and /stream/N) — but the organisers have already
 * moved the canonical name once, so the alias is kept as a fallback rather
 * than hard-coding a single host.
 */
const HOSTS = ['https://live.corp8.cloud', 'https://live.sentinelgujarat.in'];
const UPSTREAM = HOSTS[0];

/**
 * Same-origin proxy for the feed host.
 *
 * A plain `vercel.json` rewrite cannot do this job. Three upstream behaviours
 * break it, and all three are fatal to video playback:
 *
 * 1. **Range requests are not forwarded.** The rewrite answered every request
 *    with `Content-Range: bytes 0-1` and a 2-byte body no matter what the
 *    browser asked for. The progressive files here are ~22 GB, so a `<video>`
 *    element that cannot range-request gets two bytes, fires `error`, and the
 *    tile reads "Stream unavailable" — on every camera.
 * 2. **The HLS playlist 302s to an absolute upstream URL** carrying
 *    `?cookieCheck=1`. Following it takes the browser cross-origin, where the
 *    response arrives with `Access-Control-Allow-Origin: *` **twice** and is
 *    rejected. The redirect has to be resolved server-side.
 * 3. **The session rides on `Secure; SameSite=None; Partitioned` cookies.**
 *    Without them the variant playlist answers 401 and every tile is black.
 *
 * So: forward the range, resolve the redirect here, keep the cookie jar for
 * the length of the handshake, and hand the browser one clean CORS header.
 *
 * Routing note: this is a single function, not `sentinel/[...path].js`. The
 * bracket catch-all is a Next.js filename convention — on a plain Vite project
 * it deployed without error and then 404'd every request, while /api/ping in
 * the same deployment answered fine. `vercel.json` therefore rewrites
 * `/sentinel/:path*` to `/api/sentinel?__p=:path*` and the path is read back
 * out of the query here.
 */

/** Headers that must not be relayed upstream — Cloudflare bot-challenges them. */
const STRIP = new Set([
  'host', 'origin', 'referer', 'cookie',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-vercel-id',
  'x-real-ip', 'forwarded',
]);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Collect `Set-Cookie` into a single `name=value; …` request header. */
function jar(res, existing = '') {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const pairs = new Map();
  for (const part of existing.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) pairs.set(k, v.join('='));
  }
  for (const line of raw) {
    const [k, ...v] = line.split(';')[0].split('=');
    if (k) pairs.set(k.trim(), v.join('='));
  }
  return [...pairs].map(([k, v]) => `${k}=${v}`).join('; ');
}

export default async function handler(req) {
  const url = new URL(req.url);

  // The rewrite parks the real path in `__p`; everything else in the query
  // belongs to the upstream request (e.g. ?cookieCheck=1).
  const params = new URLSearchParams(url.search);
  const routed = params.get('__p');
  params.delete('__p');
  const path = '/' + (routed ?? url.pathname.replace(/^\/api\/sentinel\/?/, '')).replace(/^\/+/, '');
  const query = params.toString() ? '?' + params.toString() : '';
  let target = UPSTREAM + path + query;

  const out = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIP.has(key.toLowerCase())) out.set(key, value);
  });
  out.set('user-agent', UA);
  // The browser's own cookies for this origin carry the upstream session.
  let cookies = req.headers.get('cookie') ?? '';
  if (cookies) out.set('cookie', cookies);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors(new Headers()) });
  }

  let res = null;
  let lastErr = '';
  for (const host of HOSTS) {
    try {
      res = await fetch(host + path + query, {
        method: req.method,
        headers: out,
        redirect: 'manual',
      });
      target = host + path + query;
      break;
    } catch (err) {
      lastErr = err.message;
    }
  }
  if (!res) {
    return new Response('Upstream unreachable: ' + lastErr, { status: 502 });
  }

  // Resolve the cookieCheck handshake here rather than sending the browser
  // cross-origin, where the duplicated CORS header would kill it.
  let hops = 0;
  while (res.status >= 300 && res.status < 400 && hops < 4) {
    const loc = res.headers.get('location');
    if (!loc) break;
    cookies = jar(res, cookies);
    target = new URL(loc, target).toString();
    // Following the alias's 301 back to the canonical host is expected and
    // must stay inside the proxy; anything else is off-estate.
    if (!HOSTS.some((h) => target.startsWith(h))) break;
    if (cookies) out.set('cookie', cookies);
    res = await fetch(target, { method: req.method, headers: out, redirect: 'manual' });
    hops += 1;
  }

  const headers = new Headers();
  res.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    // Rebuilt below; and never relay upstream's duplicated CORS header.
    if (k === 'set-cookie' || k === 'access-control-allow-origin' || k === 'content-encoding') return;
    headers.set(key, value);
  });

  // Re-issue the session cookie as first-party so the browser sends it back on
  // segment requests. `Partitioned`/`SameSite=None` only apply to third-party
  // contexts and would be dropped over this same-origin hop.
  const setCookies =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of setCookies) {
    headers.append(
      'set-cookie',
      line
        .replace(/;\s*Partitioned/gi, '')
        .replace(/;\s*SameSite=None/gi, '; SameSite=Lax')
        .replace(/;\s*Secure/gi, '; Secure'),
    );
  }

  return new Response(res.body, { status: res.status, headers: cors(headers) });
}

function cors(h) {
  h.set('access-control-allow-origin', '*');
  h.set('access-control-allow-headers', 'range, content-type');
  h.set('access-control-expose-headers', 'content-range, content-length, accept-ranges');
  h.set('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  return h;
}
