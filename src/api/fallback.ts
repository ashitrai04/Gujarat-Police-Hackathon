/**
 * Recorded-feed fallback.
 *
 * Every camera on the grid is a live stream, and the grid is not always
 * reachable — it permits one session per address, it refuses bursts, and its
 * heavier cameras deliver below real time on a constrained link. A control
 * room that shows a black tile in those moments is telling an operator
 * nothing; a control room that shows recorded footage *without saying so* is
 * telling them something false, which is worse.
 *
 * So the fallback is deliberate on both counts: it plays, and it is labelled.
 * Any tile running from the archive is marked RECORDED with the capture date,
 * and it is never presented as live.
 *
 * The archive is packaged as HLS with the same segment length as the grid, so
 * the player takes the same code path — a different URL, not a different
 * branch.
 */

/** Base URL of the object store holding the packaged recordings. */
const BASE = (import.meta.env.VITE_FALLBACK_BASE ?? '').replace(/\/+$/, '');

export const FALLBACK_CONFIGURED = BASE.length > 0;

export interface FallbackClip {
  id: string;
  segments: number;
  size_mb: number;
  location: string;
  width: string;
  height: string;
  fps: string;
  seconds: string;
  source_file: string;
  note?: string;
}

let index: Record<string, FallbackClip> | null = null;
let loading: Promise<Record<string, FallbackClip>> | null = null;

/**
 * Which cameras have an archived clip. Served from the app itself rather than
 * the object store, so a tile can decide whether a fallback exists without a
 * cross-origin request that might itself be what is failing.
 */
export function loadFallbackIndex(): Promise<Record<string, FallbackClip>> {
  if (index) return Promise.resolve(index);
  if (!loading) {
    loading = fetch('/fallback-index.json')
      .then((r) => (r.ok ? r.json() : {}))
      .then((json: Record<string, FallbackClip>) => {
        index = json;
        return json;
      })
      .catch(() => {
        // A missing index is not an error worth surfacing — it simply means no
        // camera has a fallback.
        index = {};
        return index;
      });
  }
  return loading;
}

/** Playlist URL for a camera's archived clip, or null if there is none. */
export function fallbackUrl(cameraId: string): string | null {
  if (!FALLBACK_CONFIGURED) return null;
  if (index && !index[cameraId]) return null;
  return `${BASE}/${cameraId}/index.m3u8`;
}

export function fallbackClip(cameraId: string): FallbackClip | null {
  return index?.[cameraId] ?? null;
}

/**
 * The date the archive was captured, for the tile label.
 *
 * Every clip in the current archive came from the same day of grid footage,
 * which is burned into the picture as an on-screen timestamp. Showing it in
 * the label means the two agree rather than appearing to contradict each other.
 */
export const ARCHIVE_DATE = import.meta.env.VITE_FALLBACK_DATE ?? '14 Jun 2026';
