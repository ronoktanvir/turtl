// How a pull decides between carrying on and falling back. One rule for every pull in the app: the swipe up from
// the issues list into the first issue, and the move between an issue and its fixes. Touch drags, mouse drags and
// wheel or trackpad scrolls all come down to a distance in the pull's direction and, for a finger, a speed.

/** Past this share of the travel, letting go completes the pull. */
export const COMPLETE_AT = 0.5;
/** A quick flick toward the target completes from this little progress... */
export const FLICK_FROM = 0.12;
/** ...when it is at least this fast, in px per ms (PanResponder's vy). */
export const FLICK_SPEED = 0.6;
/** How far a finger moves before a vertical pull counts as one rather than a tap or a sideways swipe. */
export const DEAD_ZONE = 8;

/** The distance a finger travels for a full pull: two fifths of the height it pulls across, held between 180 and 280 px. */
export function swipeTravel(height: number): number {
  if (!(height > 0)) return 180;
  return Math.round(Math.min(280, Math.max(180, height * 0.4)));
}

/** How far through the pull a distance is, from 0 to 1. Distance against the pull counts as none. */
export function swipeProgress(distance: number, travel: number): number {
  if (!(travel > 0) || !Number.isFinite(distance)) return 0;
  return Math.min(1, Math.max(0, distance / travel));
}

/** Whether letting go at this progress, moving at this speed toward the target, completes the pull. */
export function shouldComplete(progress: number, speed = 0): boolean {
  return progress >= COMPLETE_AT || (progress >= FLICK_FROM && speed >= FLICK_SPEED);
}

/** Whether a drag is a vertical pull in the given direction: clearly vertical, and past the dead zone. */
export function isVerticalPull(dx: number, dy: number, direction: "up" | "down"): boolean {
  const toward = direction === "up" ? -dy : dy;
  return toward > DEAD_ZONE && Math.abs(dy) > Math.abs(dx) * 1.5;
}

// --- Wheel and trackpad ---

/** Quiet between wheel events that ends one scroll gesture and starts the next. */
export const WHEEL_GAP = 180;
/** Quiet after which a wheel pull that is still short falls back, or completes if it is past half. */
export const WHEEL_SETTLE = 260;
/**
 * Wheel distance, in px, for a full pull. Past half of it (80 px) a pull completes when the scrolling stops, so one
 * notch of an ordinary mouse wheel (about 100 px) completes it, as does any deliberate trackpad swipe; a nudge does not.
 */
export const WHEEL_TRAVEL = 160;

/** A wheel delta in pixels, whatever unit the browser reported it in (pixels, lines or pages). */
export function wheelPixels(delta: number, mode: number, pageHeight: number): number {
  if (mode === 1) return delta * 16;
  if (mode === 2) return delta * (pageHeight > 0 ? pageHeight : 800);
  return delta;
}

/** Where a wheel pull stands: when the last wheel event came, and how far the pull has gone (0 when none is under way). */
export type WheelPull = { lastAt: number; distance: number };
export const restingWheel: WheelPull = { lastAt: Number.NEGATIVE_INFINITY, distance: 0 };

/**
 * One wheel event. `toward` is the scroll in the pull's direction (positive pulls), `atEdge` whether the page is at
 * the end the pull leaves from. A scroll gesture that begins with the page already at that edge drives the pull; one
 * that reaches the edge part way stops there, as ordinary scrolling does, so a long read never spills into the next
 * page and momentum never carries a reader past the end. Scrolling back the other way undoes the pull and, once it
 * is undone, scrolls the page as usual for the rest of that gesture.
 */
export function wheelStep(state: WheelPull, at: number, toward: number, atEdge: boolean): WheelPull {
  const fresh = at - state.lastAt > WHEEL_GAP;
  const pulling = state.distance > 0 || (fresh && atEdge && toward > 0);
  return { lastAt: at, distance: pulling ? Math.max(0, state.distance + toward) : 0 };
}

/** The pull's progress for a wheel state, from 0 to 1. */
export function wheelProgress(state: WheelPull): number {
  return swipeProgress(state.distance, WHEEL_TRAVEL);
}
