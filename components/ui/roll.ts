// How a count moves when it changes: like a counter's wheel, the old number leaves the way the new one is going.

export type RollWay = "up" | "down" | "none";

/** A count that grew rolls up; one that shrank rolls down. */
export function rollWay(from: number, to: number): RollWay {
  return to > from ? "up" : to < from ? "down" : "none";
}

/**
 * Where the old number ends and the new one starts, in points from the resting line. Each travels a little under
 * half a line, so the two never sit on top of each other at full strength.
 */
export function rollOffsets(way: RollWay, lineHeight: number): { leave: number; enter: number } {
  if (way === "none") return { leave: 0, enter: 0 };
  const distance = Math.round(lineHeight * 0.45);
  return way === "up" ? { leave: -distance, enter: distance } : { leave: distance, enter: -distance };
}
