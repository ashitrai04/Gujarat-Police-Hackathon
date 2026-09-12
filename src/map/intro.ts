/**
 * The opening descent from the globe to the state, played once a session.
 *
 * Shared because other parts of the console must wait for it: seeding the
 * video wall opens the dock across half the screen, and the walkthrough's
 * welcome card sits in the middle of it — either one, arriving mid-descent,
 * buries the thing the descent is there to show.
 */
export const INTRO_KEY = 'sentinel-intro-played';

/** From map load: a short pause, then the flight (see MapView). */
export const INTRO_MS = 700 + 5200 + 400;

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function introSeen(): boolean {
  try {
    return !!sessionStorage.getItem(INTRO_KEY);
  } catch {
    return true;
  }
}

/** Decided once, at start-up, before the map marks the intro as played. */
export const introWillPlay = !prefersReducedMotion() && !introSeen();
