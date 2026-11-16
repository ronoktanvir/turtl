// The size of a project's name on its Projects card. A name wraps between words; a single long word ("Superprediction")
// has nowhere to wrap, so on a narrow phone the browser broke it mid-word. The name shrinks just enough for its longest
// word to fit the column instead, never below 14.

/** Average width of a Righteous character, as a share of the font size, with room to spare. */
const CHARACTER = 0.6;
const LARGEST = 18;
const SMALLEST = 14;

export function nameSize(name: string, column: number): number {
  const longest = Math.max(1, ...name.split(/\s+/).map((word) => word.length));
  return Math.max(SMALLEST, Math.min(LARGEST, Math.floor(column / (longest * CHARACTER))));
}
