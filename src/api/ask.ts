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
function resolved(): { base: string; token: string } {
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
  };
}

const { base: BASE, token: TOKEN } = resolved();

/*
 * The shared token travels in the page, so it is not a secret from anyone
 * using the page — it keeps an open endpoint from being found by a scanner,
 * nothing more.
 */
function authHeaders(): Record<string, string> {
  return TOKEN ? { 'x-ask-token': TOKEN } : {};
}

export const ASK_CONNECTED = BASE.length > 0;

/** Where the client is pointed, for the panel to show. */
export const ASK_BASE = BASE;

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

export function thumbUrl(path: string): string {
  // An <img> cannot send a header, so the token rides in the query string for
  // this one route.
  return `${BASE}${path}${TOKEN ? `?t=${encodeURIComponent(TOKEN)}` : ''}`;
}

export async function askHealth(): Promise<AskHealth | null> {
  if (!ASK_CONNECTED) return null;
  try {
    const r = await fetch(`${BASE}/health`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(6000),
    });
    return r.ok ? ((await r.json()) as AskHealth) : null;
  } catch {
    return null;
  }
}

export async function ask(
  prompt: string,
  opts: { k?: number; verify?: boolean } = {},
): Promise<AskResponse> {
  if (!ASK_CONNECTED) throw new Error('Prompt search is not configured');
  const r = await fetch(`${BASE}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
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
