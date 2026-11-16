import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import ts from "typescript";

// Ronok's rule for type: text that is not a full sentence (titles, names, headings, button and tab labels, status
// words, chips, counts, dates, short phrases) is set in Righteous. Full sentences and paragraphs (descriptions,
// summaries, explanations, error messages) are set in Capriola. The T component decides from the words it draws,
// through components/ui/typeface.ts. These tests hold the rule so new screens cannot drift from it.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const files = (dir) =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [],
  );
const screens = [...files("app"), ...files("components")].map((file) => relative(root, join(root, file)));

const { outputText } = ts.transpileModule(read("components/ui/typeface.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const typeface = { exports: {} };
runInThisContext(`(function(exports, module) { ${outputText}\n})`, { filename: "typeface.ts" })(typeface.exports, typeface);
const { faceFor, isSentence, textOf } = typeface.exports;

const RIGHTEOUS = [
  // Titles, names, labels, status words, counts and dates.
  "All clear",
  "4 bugs",
  "Explore features",
  "Login",
  "Needs review",
  "Nov 15, 12:00 AM",
  "1 of 4",
  "Swipe up to review",
  "Typecheck",
  "Listener Ladder",
  "turtl",
  "Approve",
  "Sign in with Apple",
  "Waiting for you",
  "3 min ago",
  "yesterday",
  "gpt-6.1-sol (medium reasoning)",
  "lib/game.ts",
  "v1.2.0",
  "—",
  "",
  "   ",
  // Issue, fix and step titles read like clauses, but they are names: no closing full stop.
  "Answers time out before the next round",
  "Check saved scores after simultaneous retries",
  "Review database work after the answer deadline",
  "Log how long each part of an answer takes",
  "1. Answers time out before the next round",
  // A label ending in a colon, and a question a button or heading asks.
  "Sends to Claude Code:",
  "Approve: Generate the daily ladder from a seed?",
  "Ready to ship?",
  "What should turtl look at?",
  // A status with an ellipsis, and a single word with a full stop.
  "Checking the code…",
  "Loading...",
  "Approving…",
  "Done.",
  // An abbreviation or an initial inside a title is not the end of a sentence.
  "Retries vs. timeouts",
  "Shared by J. Smith",
];

const CAPRIOLA = [
  "You decide which fix goes ahead.",
  "No open bugs.",
  "turtl has not mapped this project's code yet.",
  "A Higher or Lower music game. Guess which artist has more listeners, build a streak…",
  "A Higher or Lower music game. Guess which artist has more listeners, build a streak, and save your score.",
  "Try again!",
  "Something went wrong. Pull down to retry",
  "(The fix is waiting for your approval.)",
  "“Answers are slow.”",
  // A long run of prose with no full stop at the end: a model's summary or a cut-off description.
  "Players can open the game but answering a round takes too long to continue and the score is never saved",
  "The reviewers agree that each answer reads the whole score history before it can rank the player, which outlasts",
  // A question in a paragraph is prose.
  "turtl found two causes. Which one should it fix first?",
];

test("text that is not a full sentence is set in Righteous", () => {
  const wrong = RIGHTEOUS.filter((text) => faceFor(text) !== "title");
  assert.deepEqual(wrong, [], "these are titles, labels or short phrases");
});

test("full sentences and paragraphs are set in Capriola", () => {
  const wrong = CAPRIOLA.filter((text) => faceFor(text) !== "text");
  assert.deepEqual(wrong, [], "these are sentences or prose");
  assert.equal(isSentence("No open bugs."), true);
  assert.equal(isSentence("All clear"), false);
});

test("the words are gathered from strings and numbers, through arrays and nested elements", () => {
  const element = (children) => ({ $$typeof: Symbol.for("react.element"), type: "Text", props: { children } });
  assert.equal(textOf(["4", " bugs"]), "4 bugs");
  assert.equal(textOf([4, " ", "bugs"]), "4 bugs");
  assert.equal(textOf(["No open ", element("bugs"), "."]), "No open bugs.");
  assert.equal(textOf([null, false, undefined, true, element([element("All"), " clear"])]), "All clear");
  assert.equal(textOf(element(undefined)), "");
  assert.equal(faceFor(textOf(["You decide ", element("which fix"), " goes ahead."])), "text");
  assert.equal(faceFor(textOf([1, " of ", 4])), "title");
});

test("T decides the face from its words; an explicit font wins, a nested T follows its paragraph, mono stays monospace", () => {
  const ui = read("components/ui/index.tsx");
  assert.match(ui, /const fonts: Record<Face, string> = \{ title: "Righteous_400Regular", text: "Capriola_400Regular" \};/);
  assert.match(ui, /import \{ faceFor, textOf, type Face \} from "\.\/typeface";/);
  assert.match(ui, /const face: Face = font \?\? parent \?\? faceFor\(textOf\(props\.children\)\);/);
  assert.match(ui, /font \|\| variant !== "mono" \? \{ fontFamily: fonts\[face\]/);
  assert.doesNotMatch(ui, /font = variant ===/, "the face no longer follows the variant");
});

// The first screens ever built: the developer's case feed, never in a store build (app/live.tsx redirects there).
const DEVELOPER_ONLY = (file) => file === "app/live.tsx" || file === "app/case/[id].tsx" || file.startsWith("components/feed/") || file.startsWith("components/dev/");

// A Text nested inside a T paragraph takes that paragraph's font, so it needs none of its own.
const INHERITS = { "components/fix/Evidence.tsx": "an inline citation link inside a T paragraph" };

test("text never bypasses the text component into the system font, and what the owner types stays in Capriola", () => {
  const problems = [];
  for (const file of screens) {
    if (DEVELOPER_ONLY(file) || file in INHERITS || file === "components/ui/index.tsx") continue;
    const source = read(file);
    source.split("\n").forEach((line, index) => {
      if (/<Text\b/.test(line) && !/fontFamily/.test(line) && !/styles\.missingText/.test(line)) problems.push(`${file}:${index + 1} draws text outside the T component with no font. Use T.`);
    });
    // A text field holds the owner's own words, which are prose: Capriola, whatever its placeholder says.
    if (/<TextInput\b/.test(source) && !source.includes('"Capriola_400Regular"')) problems.push(`${file} has a text field that does not set Capriola_400Regular, so what is typed shows in the system font.`);
    if (/<TextInput\b/.test(source) && source.includes('"Righteous_400Regular"')) problems.push(`${file} sets Righteous by name; only T chooses Righteous.`);
  }
  assert.deepEqual(problems, []);
});
