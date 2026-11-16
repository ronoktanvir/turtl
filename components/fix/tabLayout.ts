// Where the Overview, Logs and Code tabs sit. The selected tab stands apart and the others gather on the side they
// come from: tabs before it at the left, tabs after it at the right. The first tab selected sits at the left, the
// last at the right, and one in between in the middle of the bar.

export type TabSide = "start" | "center" | "end";

export function tabSides(count: number, selected: number): TabSide[] {
  return Array.from({ length: count }, (_, i) =>
    i < selected ? "start" : i > selected ? "end" : selected === 0 ? "start" : selected === count - 1 ? "end" : "center",
  );
}

/**
 * The left edge of each tab, given each tab's width, the bar's width, the padding at either end and the gap within a
 * group. A centred tab keeps at least `gap` from its neighbours, moving off centre on a narrow bar if it must. Until
 * every tab has been measured (a width of 0 or less), there is nothing to place and it returns null.
 */
export function tabPositions(widths: number[], selected: number, width: number, padding: number, gap: number): number[] | null {
  if (width <= 0 || widths.length === 0 || widths.some((w) => !(w > 0))) return null;
  const sides = tabSides(widths.length, selected);
  const xs = new Array<number>(widths.length).fill(0);
  let left = padding;
  sides.forEach((side, i) => {
    if (side !== "start") return;
    xs[i] = left;
    left += widths[i] + gap;
  });
  let right = width - padding;
  for (let i = widths.length - 1; i >= 0; i--) {
    if (sides[i] !== "end") continue;
    right -= widths[i];
    xs[i] = right;
    right -= gap;
  }
  const middle = sides.indexOf("center");
  if (middle >= 0) {
    const lowest = left; // one gap past the last tab on the left
    const highest = right - widths[middle]; // ending one gap before the first tab on the right
    const centred = (width - widths[middle]) / 2;
    xs[middle] = highest < lowest ? (lowest + highest) / 2 : Math.min(highest, Math.max(lowest, centred));
  }
  return xs.map((x) => Math.round(x));
}
