import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import { probeAll, type StreamHealth } from './health';

/**
 * Estate-wide stream availability, refreshed on a timer.
 *
 * The refresh is what makes a tile come back on its own: when a camera that
 * was down starts serving again, the next poll flips it to `available` and the
 * player remounts against the working route without anyone touching the UI.
 */
export function useStreamHealth(pollMs = 60_000) {
  const { data: cams } = useQuery({ queryKey: ['cameras.all'], queryFn: () => api.cameras() });

  return useQuery<Record<string, StreamHealth>>({
    queryKey: ['stream.health', cams?.length ?? 0],
    queryFn: () => probeAll(cams ?? []),
    enabled: !!cams?.length,
    refetchInterval: pollMs,
    refetchOnWindowFocus: true,
    staleTime: pollMs / 2,
  });
}
