// Which way a screen comes in, judged from the address it was reached from. Going deeper into the app (Projects to
// a project, a project to its fixes, anything to an opened issue) arrives from the right; coming back out arrives
// from the left; a move between two screens at the same depth only fades.

export type Arrival = "first" | "forward" | "back" | "across";

/** How deep an address is: its number of parts, with an opened issue and its pages counted below every list. */
export function depthOf(path: string): number {
  const parts = path.split(/[?#]/)[0].split("/").filter(Boolean);
  return parts.length + (parts[0] === "review" ? 2 : 0);
}

/** How the screen at `to` arrives when the last screen shown was at `from` (null when it is the first of the visit). */
export function arrival(from: string | null, to: string): Arrival {
  if (from === null) return "first";
  const change = depthOf(to) - depthOf(from);
  return change > 0 ? "forward" : change < 0 ? "back" : "across";
}

/** How far, in points, a screen travels sideways as it arrives: from the right going forward, from the left coming back. */
export function arrivalOffset(way: Arrival, distance = 22): number {
  return way === "forward" ? distance : way === "back" ? -distance : 0;
}

// --- A list arriving ---

/** The most an entrance waits for the ones before it, so a long list is all on screen in a quarter of a second. */
export const STAGGER_CAP = 240;

/**
 * How long the item at `index` of a list waits before it arrives. The gaps shrink as the list goes on (0, 50, 90,
 * 120, then 25 more each), so the first few read as one after another and the rest follow close behind.
 */
export function stagger(index: number): number {
  const first = [0, 50, 90, 120];
  const wait = index < first.length ? first[Math.max(0, index)] : 120 + (index - 3) * 25;
  return Math.min(wait, STAGGER_CAP);
}
