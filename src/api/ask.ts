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
const BASE = (import.meta.env.VITE_ASK_API_URL ?? '').replace(/\/$/, '');

export const ASK_CONNECTED = BASE.length > 0;

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
  return `${BASE}${path}`;
}

export async function askHealth(): Promise<AskHealth | null> {
  if (!ASK_CONNECTED) return null;
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000) });
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
    headers: { 'content-type': 'application/json' },
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
