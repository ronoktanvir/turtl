// Ronok's rule for type: text that is not a full sentence (a title, a name, a heading, a button or tab label, a
// status word, a chip, a count, a date, a short phrase) is set in Righteous. Full sentences and paragraphs (a
// description, a summary, an explanation, an error message) are set in Capriola. Most text on these screens comes
// from data and from models, so T decides from the words it is about to draw, using the rules below.

export type Face = "title" | "text";

// Words that end in a full stop without ending a sentence, so "e.g. the retry" is not read as two sentences.
const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "approx", "mr", "mrs", "ms", "dr", "st", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"]);

// A title can read like a clause ("Answers time out before the next round"), so a run of words without a closing
// full stop counts as prose only when it is longer than any title in the app. The longest issue, fix and step
// titles are about ten words; a model's summary or a cut-off description runs well past fourteen.
const PROSE_WORDS = 14;

const CLOSERS = /["'’”)\]»]+$/;

/** The words a T will draw: every string and number in its children, through arrays and nested elements. */
export function textOf(children: unknown): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string") return children;
  if (typeof children === "number" || typeof children === "bigint") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (typeof children === "object" && "props" in children) {
    const props = (children as { props?: { children?: unknown } }).props;
    return props ? textOf(props.children) : "";
  }
  return "";
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
}

/** True when a sentence ends somewhere inside the text and another begins after it. */
function endsASentenceInside(text: string): boolean {
  const boundary = /([\p{L}\p{N}_.'’-]*)([.!?…]|\.\.\.)["'’”)\]»]*\s+["'‘“(]?[\p{L}\p{N}]/gu;
  for (const match of text.matchAll(boundary)) {
    const before = match[1].toLowerCase();
    if (match[2] === "." && ABBREVIATIONS.has(before.replace(/\.$/, ""))) continue;
    if (match[2] === "." && /^\d+$/.test(before)) continue; // "1. Answers time out", a numbered title
    if (match[2] === "." && /^\p{L}$/u.test(before)) continue; // an initial, "J. Smith"
    return true;
  }
  return false;
}

/**
 * Whether the text is a full sentence or a paragraph (Capriola) rather than a title, label or short phrase
 * (Righteous).
 *
 * - Ends in a full stop or an exclamation mark, with at least two words: a sentence ("No open bugs.").
 * - A sentence ends inside it and more follows: a paragraph, however it ends ("Guess which artist…, build a streak…").
 * - Fourteen words or more with no closing full stop: prose, such as a model's summary or a cut-off description.
 * - Anything else is a title: no closing punctuation ("Answers time out before the next round"), a label ending in
 *   a colon, a question a button or heading asks ("Approve: Generate the daily ladder from a seed?"), a status
 *   with an ellipsis ("Checking the code…"), a single word with a full stop ("Done."), a count or a date.
 */
export function isSentence(raw: string): boolean {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return false;
  const count = words(text).length;
  if (count === 0) return false;
  const end = text.replace(CLOSERS, "");
  if (endsASentenceInside(end)) return true;
  if (count >= PROSE_WORDS) return true;
  if (/(\.\.\.|…)$/.test(end)) return false;
  if (/[.!]$/.test(end)) return count >= 2;
  return false;
}

/** The face for a run of text: Capriola for a sentence, Righteous for anything else. */
export function faceFor(text: string): Face {
  return isSentence(text) ? "text" : "title";
}
