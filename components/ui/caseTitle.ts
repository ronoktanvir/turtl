// The name an opened issue goes by at the top of its screens: the issue's own title, never the project's name and
// never a number in its place. Only a case recorded without a title falls back to its number.

export type Titled = { title?: string | null; number: number; type: "fix" | "feature" };

export function caseTitle(item: Titled): string {
  const title = item.title?.replace(/\s+/g, " ").trim();
  if (title) return title;
  const feature = item.type === "feature";
  return item.number > 0 ? (feature ? "Request #" : "Error #") + item.number : feature ? "Request" : "Case";
}
