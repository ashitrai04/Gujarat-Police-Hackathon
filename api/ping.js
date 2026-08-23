export const config = { runtime: 'edge' };

/** Deployment probe: proves Edge functions are being built for this project. */
export default function handler() {
  return new Response(JSON.stringify({ ok: true, at: new Date().toISOString() }), {
    headers: { 'content-type': 'application/json' },
  });
}
