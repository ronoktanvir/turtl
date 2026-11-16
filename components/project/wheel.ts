// Wheel events for the Fix and Features lists in a browser, where there is no finger to swipe with.

export type Wheel = { deltaX: number; deltaY: number; deltaMode: number };

const LINE = 16; // a wheel that reports lines (deltaMode 1) moves about this many points for each
const SWIPE = 80; // how far up a swipe travels before it opens the first card
const REST = 400; // ms without a wheel event before the next one starts a new swipe

/** How far to move the strip of cards sideways for a wheel that turns up and down. 0 leaves the event to the browser. */
export function sidewaysTravel(event: Wheel): number {
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return 0;
  return downwardTravel(event);
}

/** A wheel event's up-and-down travel in points, whichever unit the browser reported it in. */
export function downwardTravel(event: Wheel): number {
  return event.deltaMode === 1 ? event.deltaY * LINE : event.deltaY;
}

/**
 * Tells a swipe up from a nudge. Feed it each wheel event's downward travel and the time; it answers true once,
 * when one unbroken swipe has travelled far enough, and stays quiet while that swipe coasts to a stop.
 */
export function wheelSwipeUp(): (deltaY: number, now: number) => boolean {
  let travel = 0;
  let last = -Infinity;
  let opened = false;
  return (deltaY, now) => {
    if (now - last > REST) { travel = 0; opened = false; }
    last = now;
    if (opened) return false;
    travel = Math.max(0, travel + deltaY);
    if (travel < SWIPE) return false;
    opened = true;
    return true;
  };
}
