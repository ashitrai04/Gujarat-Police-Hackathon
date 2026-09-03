import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import { useStore } from '@/app/store';
import { probeAll, type StreamHealth } from './health';

/**
 * Stream availability for the cameras that are actually being watched.
 *
 * This used to sweep all 30 cameras every 60 seconds, which was wrong in a way
 * that only shows up against the real grid: the upstream revokes a session
 * that fetches too hard. Measured directly — a burst of requests had every
 * path answer 403, /cameras.json included, while a fresh login worked at once.
 * The grid's own integration guide is explicit about it: "open only the
 * cameras you are actively processing".
 *
 * So the probe now follows the wall. Cameras on the video wall are checked;
 * everything else is left `undefined`, which the sorting and the player both
 * already treat as "assume fine" rather than "known bad". A camera the
 * operator has not opened costs nothing.
 *
 * The refresh is what makes a tile come back on its own: when a camera that
 * was down starts serving again, the next poll flips it to `available` and the
 * player remounts against the working route.
 */
export function useStreamHealth(pollMs = 300_000) {
  const wall = useStore((s) => s.wallCameraIds);
  const { data: cams } = useQuery({ queryKey: ['cameras.all'], queryFn: () => api.cameras() });

  const watched = useMemo(
    () => (cams ?? []).filter((c) => wall.includes(c.id)),
    [cams, wall],
  );

  // Keyed on the ids themselves, so adding a camera to the wall probes it
  // rather than waiting out the poll interval.
  const key = watched.map((c) => c.id).join(',');

  return useQuery<Record<string, StreamHealth>>({
    queryKey: ['stream.health', key],
    queryFn: () => probeAll(watched),
    enabled: watched.length > 0,
    refetchInterval: pollMs,
    // A window regaining focus is not a reason to spend upstream requests.
    refetchOnWindowFocus: false,
    staleTime: pollMs / 2,
  });
}
