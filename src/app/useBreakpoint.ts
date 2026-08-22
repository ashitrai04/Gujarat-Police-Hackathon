import { useEffect, useState } from 'react';

/**
 * Viewport width buckets. The console is dense, so the rail and panel have to
 * stop competing with the map once there isn't room for all three.
 *
 *   wide    >= 1500  rail pinned, panel docked inline
 *   mid     >= 1150  rail pinned, panel overlays the map
 *   narrow  <  1150  rail collapses to icons, panel overlays
 */
export type Breakpoint = 'narrow' | 'mid' | 'wide';

export function useBreakpoint(): Breakpoint {
  const calc = (): Breakpoint => {
    const w = window.innerWidth;
    if (w >= 1500) return 'wide';
    if (w >= 1150) return 'mid';
    return 'narrow';
  };
  const [bp, setBp] = useState<Breakpoint>(calc);

  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setBp(calc()));
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return bp;
}
