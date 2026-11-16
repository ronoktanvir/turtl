// Counts on a case, in words that agree with the number.

/** Under a case's summary: people who asked for a feature, or messages customers sent about a bug. */
export function reportLine(count: number, feature: boolean): string {
  if (feature) return count === 1 ? "1 person asked" : count + " people asked";
  return count === 1 ? "1 customer report" : count + " customer reports";
}

/** The deeper-cause card's heading. */
export function deeperCauseTitle(connectedCases: number): string {
  return connectedCases > 1 ? "A deeper cause across " + connectedCases + " cases" : "A deeper cause behind this case";
}
