// How a sheet answers a finger on its handle. Pulled down it follows the finger exactly; pulled up, where it has
// nowhere to go, it gives a little and resists more the further it is pulled. Let go, it closes if it was pulled a
// good part of its height or flicked downward, and settles back otherwise.

/** The most a sheet lifts when pulled up past its resting place, in points. */
export const LIFT_LIMIT = 18;

/** Where the sheet sits for a finger that has moved `dy` points (down is positive). */
export function sheetDrag(dy: number): number {
  if (dy >= 0) return dy;
  return -LIFT_LIMIT * (1 - 1 / (1 + -dy / 60));
}

/** Whether letting go at `dy` points down, moving at `vy` points a millisecond, closes a sheet `height` points tall. */
export function sheetLetsGo(dy: number, vy: number, height: number): boolean {
  if (dy <= 8) return false; // a tap or an upward pull never closes it
  if (vy > 0.4) return true; // a flick
  if (vy < -0.2) return false; // changed their mind and pushed it back up
  return dy > Math.max(60, height * 0.25);
}
