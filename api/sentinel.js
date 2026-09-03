export const config = { runtime: 'edge' };

/**
 * Same-origin proxy for the Sentinel camera grid.
 *
 * The grid moved to cctv.corp8.cloud and is now behind an access key. The key
 * lives ONLY here, in SENTINEL_ACCESS_KEY — the browser never sees it. This
 * function signs in once, keeps the `sentinel` session cookie in module scope,
 * and attaches it to every upstream request.
 *
 * What the upstream serves now:
 *   GET /cameras.json          catalogue — a flat array of { id, name }
 *   GET /<id>/index.m3u8       HLS, AES-128 encrypted, VOD, ~4300 x 10s segs
 *   GET /enc.key               the 16-byte AES key
 *   GET /<id>/segNNNNN.ts      media segments
 *
 * Two rewrites are required for playback to work at all:
 *
 * 1. The playlist declares its key as URI="/enc.key" — an absolute path. In
 *    the browser that resolves against OUR origin, not the upstream, so hls.js
 *    would fetch https://thisapp/enc.key and get the SPA's index.html instead
 *    of a key. Every m3u8 body is rewritten to point at the proxied path.
 * 2. Range headers must be forwarded. A rewrite that drops them returns two
 *    bytes and the <video> element fires `error` — the bug that had every tile
 *    reading "Stream unavailable" before.
 *
 * ONE SESSION PER IP. The grid evicts an address's previous session whenever
 * it signs in again, so only one client per machine can hold the feed at a
 * time. Two dev servers, or a dev server plus a browser tab logged into
 * cctv.corp8.cloud, will take turns 403ing each other.
 *
 * RTSP (:8554) and WHEP (:8889) are deliberately not proxied. They are TCP/UDP
 * media on a bare IP that a CDN cannot carry, and WHEP is plain HTTP — an
 * HTTPS page cannot load it without a mixed-content block. Browser playback
 * uses HLS; RTSP is for the inference pipeline, off the web tier.
 */

const UPSTREAM = 'https://cctv.corp8.cloud';
const ACCESS_KEY = process.env.SENTINEL_ACCESS_KEY || '';
const PREFIX = '/sentinel';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Headers never relayed upstream — they trip the edge or leak our origin. */
const STRIP = new Set([
  'host', 'origin', 'referer', 'cookie', 'connection',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-vercel-id',
  'x-real-ip', 'forwarded',
]);

/* The session is a year-long cookie, so one sign-in serves many requests.
   Cached per isolate; a cold start simply signs in again. */
let session = null;
let signingIn = null;
let lastSignIn = 0;

/**
 * The grid allows ONE SESSION PER IP. Signing in evicts whatever session that
 * address already held — confirmed by the upstream's own 403 body, which reads
 * "one session per IP".
 *
 * That makes a naive retry dangerous rather than merely wasteful: two clients
 * behind the same address, each re-authenticating when it sees a 403, will
 * evict each other forever and neither will ever play. So a re-login is rate
 * limited. Past the cooldown we try once; inside it we relay the 403 and let
 * the caller back off, which is the behaviour that lets the other client keep
 * its session instead of both starving.
 */
const RELOGIN_COOLDOWN_MS = 30_000;

async function signIn() {
  if (!ACCESS_KEY) throw new Error('SENTINEL_ACCESS_KEY is not set');
  const res = await fetch(`${UPSTREAM}/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA,
    },
    body: new URLSearchParams({ password: ACCESS_KEY }).toString(),
    redirect: 'manual',
  });

  const lines =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
  for (const line of lines) {
    const m = /(?:^|;\s*)sentinel=([^;]+)/.exec(line || '');
    if (m) return `sentinel=${m[1]}`;
  }
  // A wrong key re-renders the login form with 200 rather than erroring.
  throw new Error(`sign-in failed (${res.status}) — check SENTINEL_ACCESS_KEY`);
}

async function cookie(force = false) {
  if (session && !force) return session;
  if (force && Date.now() - lastSignIn < RELOGIN_COOLDOWN_MS) return session;

  if (!signingIn) {
    lastSignIn = Date.now();
    signingIn = signIn()
      .then((c) => {
        session = c;
        return c;
      })
      .finally(() => {
        signingIn = null;
      });
  }
  return signingIn;
}

function cors(h) {
  h.set('access-control-allow-origin', '*');
  h.set('access-control-allow-headers', 'range, content-type');
  h.set('access-control-expose-headers', 'content-range, content-length, accept-ranges');
  h.set('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  return h;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const params = new URLSearchParams(url.search);
  const routed = params.get('__p');
  params.delete('__p');
  const path =
    '/' + (routed ?? url.pathname.replace(/^\/api\/sentinel\/?/, '')).replace(/^\/+/, '');
  const query = params.toString() ? `?${params.toString()}` : '';

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors(new Headers()) });
  }

  const base = new Headers();
  req.headers.forEach((v, k) => {
    if (!STRIP.has(k.toLowerCase())) base.set(k, v);
  });
  base.set('user-agent', UA);

  const fetchUpstream = async (jar) => {
    const h = new Headers(base);
    h.set('cookie', jar);
    return fetch(UPSTREAM + path + query, {
      method: req.method,
      headers: h,
      redirect: 'manual',
    });
  };

  let res;
  try {
    res = await fetchUpstream(await cookie());

    // Two ways a session dies, and both need a fresh sign-in rather than being
    // relayed to the browser as a failure:
    //
    //   302 -> /auth/  the cookie expired
    //   403            the grid revoked the session for fetching too hard.
    //                  Measured: a burst of segment requests gets every path
    //                  403'd, including /cameras.json, while a fresh login
    //                  immediately works — so it is the session that is
    //                  blocked, not the address.
    const lapsed =
      (res.status >= 300 && res.status < 400 &&
        (res.headers.get('location') || '').includes('/auth/')) ||
      res.status === 403;
    if (lapsed) {
      const fresh = await cookie(true);
      // Inside the cooldown `cookie(true)` returns the session we already have,
      // so there is nothing to gain from repeating the request.
      if (fresh && fresh !== 'undefined') res = await fetchUpstream(fresh);
    }
  } catch (err) {
    return new Response(`Upstream unreachable: ${err.message}`, {
      status: 502,
      headers: cors(new Headers()),
    });
  }

  const headers = new Headers();
  res.headers.forEach((v, k) => {
    const key = k.toLowerCase();
    // Never relay the upstream session to the browser, and never relay a
    // content-length that the playlist rewrite below would invalidate.
    if (
      key === 'set-cookie' || key === 'access-control-allow-origin' ||
      key === 'content-encoding' || key === 'content-length'
    ) return;
    headers.set(k, v);
  });

  // Point the playlist's absolute key URI back through this proxy.
  if (path.endsWith('.m3u8')) {
    const body = (await res.text())
      .replace(/URI="\/(?!\/)/g, `URI="${PREFIX}/`)
      .replace(/^\/(?!\/)/gm, `${PREFIX}/`);
    headers.set('content-type', 'application/vnd.apple.mpegurl');
    return new Response(body, { status: res.status, headers: cors(headers) });
  }

  return new Response(res.body, { status: res.status, headers: cors(headers) });
}
