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
 * WHERE THE SERVICE IS — a list, not an address.
 *
 * The models live on one machine, and that machine is not always up: a shared
 * GPU box gets rebooted, a tunnel restarts with a new hostname, a laptop is
 * closed. Pointing the client at a single address makes every one of those a
 * total outage, and the symptom an operator sees is identical in each case —
 * "Failed to fetch" — which tells them nothing and suggests nothing to do.
 *
 * So the client holds candidates in preference order and uses the first that
 * answers:
 *
 *   1. whatever `?ask=` last remembered        — set by hand, so trusted first
 *   2. VITE_ASK_API_URL                        — the GPU server
 *   3. VITE_ASK_FALLBACK_URL                   — a second service, if there is one
 *   4. http://localhost:8077                   — the operator's own machine
 *
 * The last one needs no configuration and costs one request. Browsers treat
 * http://localhost as a trustworthy origin, so an HTTPS page may call it
 * without the mixed-content block that would stop any other plain-HTTP
 * address — which is what makes "run it on your own laptop" a real fallback
 * for a deployed page rather than a theoretical one.
 *
 * Failover is not one-way. The active endpoint is re-checked against the
 * higher-priority ones periodically, so when the server comes back the client
 * returns to it rather than staying on a laptop for the rest of the day.
 */
const STORE_KEY = 'sentinel-ask-url';
const TOKEN_KEY = 'sentinel-ask-token';

/** Last-resort fallback: a service on the machine the browser is running on. */
const LOCAL_FALLBACK = 'http://localhost:8077';

export interface Endpoint {
  base: string;
  token: string;
  /** Shown to the operator, so "which one am I on?" is answerable. */
  label: string;
}

const clean = (u: string) => u.trim().replace(/\/+$/, '');

/** Read `?ask=` / `?askToken=` and remember them. */
function readOverride(): { base: string; token: string } {
  try {
    const q = new URLSearchParams(location.search);
    const a = q.get('ask');
    if (a !== null) {
      const v = a.trim();
      if (!v || v === 'off') {
        localStorage.removeItem(STORE_KEY);
        localStorage.removeItem(TOKEN_KEY);
      } else if (/^https?:\/\//i.test(v)) {
        // Only http(s). A javascript: or data: URL here would be handed
        // straight to fetch and to an <img src>.
        localStorage.setItem(STORE_KEY, v);
      }
    }
    const t = q.get('askToken');
    if (t !== null) {
      const v = t.trim();
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
    }
    return {
      base: clean(localStorage.getItem(STORE_KEY) ?? ''),
      token: (localStorage.getItem(TOKEN_KEY) ?? '').trim(),
    };
  } catch {
    /* private mode, blocked storage — the build-time values still apply */
    return { base: '', token: '' };
  }
}

const override = readOverride();
const envBase = clean(import.meta.env.VITE_ASK_API_URL ?? '');
const envToken = (import.meta.env.VITE_ASK_TOKEN ?? '').trim();
const altBase = clean(import.meta.env.VITE_ASK_FALLBACK_URL ?? '');
const altToken = (import.meta.env.VITE_ASK_FALLBACK_TOKEN ?? '').trim();

/** Candidates, best first, with duplicates and blanks removed. */
function candidates(): Endpoint[] {
  const out: Endpoint[] = [];
  const add = (base: string, token: string, label: string) => {
    if (!base || out.some((e) => e.base === base)) return;
    out.push({ base, token, label });
  };
  // A remembered address carries its own token: the two belong together and a
  // stored base must never borrow the build's key for a different service.
  add(override.base, override.token, 'saved address');
  add(envBase, envToken, 'server');
  add(altBase, altToken || envToken, 'fallback service');
  // The local token is unknown, so the build's is offered. If that is wrong
  // the probe gets a 401 and the endpoint is simply skipped.
  add(LOCAL_FALLBACK, override.token || envToken, 'this machine');
  return out;
}

const POOL = candidates();
let active: Endpoint | null = POOL[0] ?? null;
/** When a higher-priority endpoint was last re-tried, so recovery is cheap. */
let lastUpgradeCheck = 0;
const UPGRADE_EVERY_MS = 120_000;

export const ASK_CONNECTED = POOL.length > 0;

/** Which endpoint is in use, and what else is available. */
export function askTarget(): {
  base: string; label: string; remembered: boolean; fellBack: boolean; pool: Endpoint[];
} {
  return {
    base: active?.base ?? '',
    label: active?.label ?? '',
    remembered: !!override.base && active?.base === override.base,
    // True whenever the client is not on its first choice — the panel says so,
    // because an operator reading results off a laptop index should know it is
    // not the server's.
    fellBack: !!active && POOL.length > 1 && active.base !== POOL[0].base,
    pool: POOL,
  };
}

/** Forget a remembered address and reload onto the configured ones. */
export function forgetRemembered(): void {
  try {
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch { /* nothing to forget */ }
  location.reload();
}

function headersFor(token: string): Record<string, string> {
  return {
    ...(token ? { 'x-ask-token': token } : {}),
    // Suppresses ngrok's free-tier interstitial. Its value is irrelevant; its
    // presence is the signal. Without it a request is answered with an HTML
    // warning page and a 200 — harmless for JSON, which fails to parse and is
    // reported, and silently wrong for an image, which renders as nothing.
    'ngrok-skip-browser-warning': 'true',
  };
}

/** Headers for the endpoint currently in use. */
export function askHeaders(): Record<string, string> {
  return headersFor(active?.token ?? '');
}

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
  return `${active?.base ?? ''}${path}`;
}

async function probe(e: Endpoint): Promise<AskHealth | null> {
  if (!e.base) return null;
  try {
    const r = await fetch(`${e.base}/health`, {
      headers: headersFor(e.token),
      // The service may be loading a gigabyte of models on a cold start, and
      // a laptop fallback that is simply not running should fail fast rather
      // than hold the whole chain up.
      signal: AbortSignal.timeout(e.base === LOCAL_FALLBACK ? 2500 : 8000),
    });
    return r.ok ? ((await r.json()) as AskHealth) : null;
  } catch {
    return null;
  }
}

/**
 * Find a service that answers, preferring the ones earlier in the list.
 *
 * Probed in order rather than in parallel: the first candidate is nearly
 * always the right one, and racing four requests to wake a sleeping laptop
 * every time the panel opens is a lot of noise for a rare case.
 */
async function pick(): Promise<AskHealth | null> {
  for (const e of POOL) {
    const h = await probe(e);
    if (h) {
      if (active?.base !== e.base) {
        // Worth saying: an operator reading results off a laptop index should
        // know they are not the server's.
        console.info(`[ask] using ${e.label} — ${e.base}`);
      }
      active = e;
      lastUpgradeCheck = Date.now();
      return h;
    }
  }
  return null;
}

export async function askHealth(): Promise<AskHealth | null> {
  if (!ASK_CONNECTED) return null;

  // Already on the best one: just confirm it is still there.
  if (active && POOL.length && active.base === POOL[0].base) {
    return probe(active);
  }

  // On a fallback. Re-try the better ones, but not on every single call —
  // a failing primary should not cost a request a second while somebody
  // types.
  if (active && Date.now() - lastUpgradeCheck > UPGRADE_EVERY_MS) {
    for (const e of POOL) {
      if (e.base === active.base) break;      // reached the current one
      const better = await probe(e);
      if (better) {
        console.info(`[ask] back on ${e.label} — ${e.base}`);
        active = e;
        lastUpgradeCheck = Date.now();
        return better;
      }
    }
    lastUpgradeCheck = Date.now();
  }

  const still = active ? await probe(active) : null;
  return still ?? pick();
}

export async function ask(
  prompt: string,
  opts: { k?: number; verify?: boolean } = {},
): Promise<AskResponse> {
  if (!ASK_CONNECTED) throw new Error('Prompt search is not configured');

  const send = async (e: Endpoint) => {
    const r = await fetch(`${e.base}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headersFor(e.token) },
      body: JSON.stringify({ prompt, k: opts.k ?? 12, verify: opts.verify ?? false }),
      // Verification runs a model over every shortlisted frame, so this is
      // slow by design. A short timeout would abort exactly the queries doing
      // the most work.
      signal: AbortSignal.timeout(opts.verify ? 180_000 : 45_000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Search failed (${r.status}) ${body.slice(0, 160)}`);
    }
    return (await r.json()) as AskResponse;
  };

  if (!active) {
    if (!(await pick())) throw new Error('No search service is reachable');
  }

  try {
    return await send(active!);
  } catch (err) {
    // A service that went down between the health check and the question
    // should cost one retry elsewhere, not the answer. Only worth doing when
    // there is somewhere else to go.
    const dead = active;
    if (POOL.length < 2) throw err;
    active = null;
    if (!(await pick())) {
      active = dead;
      throw err;
    }
    return send(active!);
  }
}
