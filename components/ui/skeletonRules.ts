// The rules a loading placeholder follows that are plain arithmetic.

/** How long a screen waits before it shows a placeholder, so data that is already on its way never flashes one. */
export const SKELETON_WAIT = 200;

const BODY = [100, 92, 96, 88];

/** Widths, in percent, for the lines of a placeholder paragraph: uneven like real text, and the last one short. */
export function lineWidths(lines: number): number[] {
  return Array.from({ length: lines }, (_, index) => (lines > 1 && index === lines - 1 ? 62 : lines === 1 ? 72 : BODY[index % BODY.length]));
}
