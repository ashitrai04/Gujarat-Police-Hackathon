/**
 * Client for the prompt-search service.
 *
 * The models this feature needs — a vision-language model for parsing and
 * verification, an image-text encoder for retrieval — want a GPU and several
 * gigabytes of resident memory. An edge function has neither, so the service
 * runs beside the inference worker and the app talks to it over HTTP.
 *
 * Unset means the feature is off, and the panel says so, the same way the ANPR
 * adapter reports "ANPR offline" rather than showing empty results that look
 * like an answer.
 */
/*
 * Where the service is, resolved at RUNTIME rather than baked into the build.
 *
 * `VITE_ASK_API_URL` is inlined by Vite when the bundle is built, so on a
 * hosted deployment every change of address means a rebuild and a redeploy.
 * The address changes often in practice — a tunnel to the machine holding the
 * models gets a new hostname each time it restarts — and a demo that needs a
 * three-minute redeploy to come back is a demo that stays broken.
 *
 * So `?ask=<url>` sets it, and it is remembered. The build-time variable
 * still works and is the right answer for a fixed deployment; this is what
 * makes a moving one usable. `?ask=off` clears it.
 */
const STORE_KEY = 'sentinel-ask-url';
const TOKEN_KEY = 'sentinel-ask-token';

/** Read `?ask=` / `?askToken=`, remember them, and return what is stored. */
function resolved(): {
  base: string; token: string; stored: string; envBase: string; envToken: string;
} {
  const envBase = (import.meta.env.VITE_ASK_API_URL ?? '').trim();
  const envToken = (import.meta.env.VITE_ASK_TOKEN ?? '').trim();
  let base = '';
  let token = '';
  try {
    const q = new URLSearchParams(location.search);
    const a = q.get('ask');
    if (a !== null) {
      const v = a.trim();
      if (!v || v === 'off') {
        localStorage.removeItem(STORE_KEY);
        localStorage.removeItem(TOKEN_KEY);
      // Only http(s). A javascript: or data: URL here would be handed
      // straight to fetch and to an <img src>.
      } else if (/^https?:\/\//i.test(v)) {
        localStorage.setItem(STORE_KEY, v);
      }
    }
    const t = q.get('askToken');
    if (t !== null) {
      const v = t.trim();
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
    }
    base = localStorage.getItem(STORE_KEY) ?? '';
    token = localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    /* private mode, blocked storage — fall back to the build-time values */
  }
  return {
    base: (base || envBase).replace(/\/+$/, ''),
    // A stored base with no stored token must not silently borrow the build's
    // token: they belong to different services.
    token: base ? token : (token || envToken),
    stored: base.replace(/\/+$/, ''),
    envBase: envBase.replace(/\/+$/, ''),
    envToken,
  };
}

const initial = resolved();

/*
 * The address in use, which can change after a health check.
 *
 * A remembered address is a convenience until it stops answering, and then it
 * is a trap: a tunnel hostname saved once keeps overriding a perfectly good
 * local service, and the panel reports "Failed to fetch" forever with no hint
 * that it is calling somewhere that no longer exists. So the stored address is
 * a preference, not a commitment — if it fails its health check and a
 * build-time address exists, the client falls back to that and says it did.
 */
let BASE = initial.base;
let TOKEN = initial.token;

/** Where the client ended up pointing, and whether that was the remembered one. */
export function askTarget(): { base: string; remembered: boolean; fellBack: boolean } {
  return {
    base: BASE,
    remembered: !!initial.stored && BASE === initial.stored,
    fellBack: !!initial.stored && BASE !== initial.stored,
  };
}

/** Forget a remembered address and reload onto the built-in one. */
export function forgetRemembered(): void {
  try {
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch { /* nothing to forget */ }
  location.reload();
}

/*
 * The shared token travels in the page, so it is not a secret from anyone
 * using the page — it keeps an open endpoint from being found by a scanner,
 * nothing more.
 */
function authHeaders(): Record<string, string> {
  return TOKEN ? { 'x-ask-token': TOKEN } : {};
}

/**
 * Headers every call to the service carries.
 *
 * `ngrok-skip-browser-warning` suppresses the interstitial that ngrok's free
 * tier serves to anything that looks like a browser. Its value is irrelevant;
 * its presence is the signal. Without it a request is answered with an HTML
 * warning page and a 200, which is harmless for JSON — it fails to parse and
 * is reported — and silently wrong for an image, which renders as nothing.
 */
export function askHeaders(): Record<string, string> {
  return { ...authHeaders(), 'ngrok-skip-browser-warning': 'true' };
}

export const ASK_CONNECTED = initial.base.length > 0 || initial.envBase.length > 0;

export interface AskResult {
  id: number;
  camera_id: string;
  source: string;
  t_s: number;
  /** Path on the service, not this origin. Resolve with `thumbUrl`. */
  thumb_url: string;
  score: number;
  counts: Record<string, number>;
  /** Present once the vision-language model has checked this frame. */
  verified?: boolean | null;
  reason?: string;
  /** Present when an attribute phrase sent it through the open-vocab detector. */
  grounded?: boolean;
  grounding?: string;
}

export interface AskPlan {
  free_text: string | null;
  cameras: string[] | null;
  places: string[] | null;
  hours: [number, number] | null;
  classes: string[] | null;
  counts: Record<string, { min: number }> | null;
  /** People sharing ONE two-wheeler — a different question from `counts`. */
  riders: { min: number } | null;
  plate: string | null;
  attributes: string[] | null;
  event: string | null;
  parser?: string;
  refused?: string;
}

export interface AskResponse {
  prompt: string;
  plan: AskPlan;
  /** Set when the query asked for something the system will not search by. */
  refused?: string;
  applied?: Record<string, unknown>;
  notes?: string[];
  n_indexed?: number;
  n_candidates?: number;
  ranked_by?: string;
  dim?: number;
  grounding?: { ran: boolean; classes?: string[]; checked?: number; passed?: number; error?: string };
  verification?: { checked: number; confirmed: number; failures: number };
  results: AskResult[];
  timing: { parse_s: number; search_s: number; ground_s?: number; verify_s?: number };
}

export interface AskHealth {
  ok: boolean;
  frames: number;
  model: string | null;
  dim: number | null;
  parser_up: boolean;
}

/**
 * Absolute URL of a thumbnail on the service.
 *
 * Fetched through `useThumb`, not handed to an `<img src>`: the request needs
 * headers, and an `<img>` cannot send any. The token is therefore no longer
 * appended as a query parameter — it travels as a header like every other
 * call, and stays out of anything that logs URLs.
 */
export function thumbUrl(path: string): string {
  return `${BASE}${path}`;
}

async function probe(base: string, token: string): Promise<AskHealth | null> {
  if (!base) return null;
  try {
    const r = await fetch(`${base}/health`, {
      headers: {
        ...(token ? { 'x-ask-token': token } : {}),
        'ngrok-skip-browser-warning': 'true',
      },
      // The service may be loading a gigabyte of models on a cold start.
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? ((await r.json()) as AskHealth) : null;
  } catch {
    return null;
  }
}

export async function askHealth(): Promise<AskHealth | null> {
  if (!ASK_CONNECTED) return null;
  const first = await probe(BASE, TOKEN);
  if (first) return first;

  // The remembered address is not answering. If the build carries one, try it
  // before giving up — a dead tunnel should not disable a working local
  // service just because someone once pasted a link.
  if (initial.stored && initial.envBase && initial.envBase !== BASE) {
    const second = await probe(initial.envBase, initial.envToken);
    if (second) {
      BASE = initial.envBase;
      TOKEN = initial.envToken;
      return second;
    }
  }
  return null;
}

export async function ask(
  prompt: string,
  opts: { k?: number; verify?: boolean } = {},
): Promise<AskResponse> {
  if (!ASK_CONNECTED) throw new Error('Prompt search is not configured');
  const r = await fetch(`${BASE}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...askHeaders() },
    body: JSON.stringify({ prompt, k: opts.k ?? 12, verify: opts.verify ?? false }),
    // Verification runs a model over every shortlisted frame, so this is slow
    // by design. A short timeout would abort exactly the queries that are
    // doing the most work.
    signal: AbortSignal.timeout(opts.verify ? 180_000 : 45_000),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Search failed (${r.status}) ${body.slice(0, 160)}`);
  }
  return (await r.json()) as AskResponse;
}
