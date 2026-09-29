import { useEffect, useState } from 'react';
import { askHeaders, thumbUrl } from './ask';

/**
 * Result thumbnails, fetched rather than pointed at.
 *
 * `<img src="…">` is the obvious way and cannot carry a header, which breaks
 * as soon as the service is behind anything that wants one. ngrok's free tier
 * is exactly that: a browser request without `ngrok-skip-browser-warning` is
 * answered with an HTML interstitial, so every tile rendered an HTML page as
 * though it were a JPEG and showed blank. The search itself kept working,
 * because `fetch` can set the header and an `<img>` cannot — which is a
 * confusing failure to look at, results arriving with no pictures.
 *
 * So the bytes come through `fetch`, with the same headers as every other
 * call, and become an object URL. That also keeps the token out of the address
 * bar, where a query parameter would otherwise put it.
 */

/* One entry per thumbnail for the life of the tab. They are ~60 KB and a
   query returns eight, so the ceiling is small; without this, re-rendering a
   result list would refetch every picture in it. */
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

async function load(path: string): Promise<string | null> {
  const hit = cache.get(path);
  if (hit) return hit;

  const pending = inflight.get(path);
  if (pending) return pending;

  const p = (async () => {
    try {
      const r = await fetch(thumbUrl(path), {
        headers: askHeaders(),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) return null;
      const blob = await r.blob();
      // An interstitial comes back as HTML with a 200, so the status is not
      // enough to tell a picture from a warning page.
      if (!blob.type.startsWith('image/')) return null;
      const url = URL.createObjectURL(blob);
      cache.set(path, url);
      return url;
    } catch {
      return null;
    } finally {
      inflight.delete(path);
    }
  })();

  inflight.set(path, p);
  return p;
}

/** The object URL for a thumbnail, or null while it loads or if it failed. */
export function useThumb(path: string): string | null {
  // State carries the path it belongs to. Without that, paging through results
  // shows the previous frame's picture under the next frame's caption until
  // the new one arrives — briefly, and wrongly.
  const [got, setGot] = useState<{ path: string; url: string | null }>(
    () => ({ path, url: cache.get(path) ?? null }),
  );

  useEffect(() => {
    if (cache.has(path)) return;      // resolved during render, below
    let alive = true;
    void load(path).then((url) => { if (alive) setGot({ path, url }); });
    return () => { alive = false; };
  }, [path]);

  const cached = cache.get(path);
  if (cached) return cached;
  return got.path === path ? got.url : null;
}
