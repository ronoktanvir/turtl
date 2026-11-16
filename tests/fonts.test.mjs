import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Ronok's rule for type: titles and important titles are set in Righteous; everything else, the ordinary text
// under and around them, is set in Capriola. These tests hold the rule so new screens cannot drift from it.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const files = (dir) =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [],
  );
const screens = [...files("app"), ...files("components")].map((file) => relative(root, join(root, file)));

// The first screens ever built: the developer's case feed, never in a store build (app/live.tsx redirects there).
const DEVELOPER_ONLY = (file) => file === "app/live.tsx" || file === "app/case/[id].tsx" || file.startsWith("components/feed/") || file.startsWith("components/dev/");

test("the text component sets titles in Righteous and everything else in Capriola", () => {
  const ui = read("components/ui/index.tsx");
  assert.match(ui, /const fonts = \{ title: "Righteous_400Regular", text: "Capriola_400Regular" \};/);
  assert.match(ui, /font = variant === "display" \|\| variant === "title" \|\| variant === "heading" \? "title" : "text",/);
});

// A Text nested inside a T paragraph takes that paragraph's font, so it needs none of its own.
const INHERITS = { "components/fix/Evidence.tsx": "an inline citation link inside a T paragraph" };

test("ordinary text never bypasses the text component into the system font", () => {
  const problems = [];
  for (const file of screens) {
    if (DEVELOPER_ONLY(file) || file in INHERITS || file === "components/ui/index.tsx") continue;
    const source = read(file);
    source.split("\n").forEach((line, index) => {
      if (/<Text\b/.test(line) && !/fontFamily/.test(line) && !/styles\.missingText/.test(line)) problems.push(`${file}:${index + 1} draws text outside the T component with no font. Use T, or set fontFamily to Capriola_400Regular.`);
    });
    if (/<TextInput\b/.test(source) && !source.includes('"Capriola_400Regular"')) problems.push(`${file} has a text field that does not set Capriola_400Regular, so what is typed shows in the system font.`);
  }
  assert.deepEqual(problems, []);
});

test("the title font is used below heading size only for the titles of cards, steps and panels", () => {
  // A name at body size takes the title font only where it heads something: a fix, a plan step or its check tile,
  // a prevention check, the pull request, the selected part of the code map, and turtl's name on its messages.
  const allowed = new Set([
    "app/project/[projectId]/investigate.tsx",
    "app/review/[caseId]/chat.tsx",
    "app/review/[caseId]/enacting.tsx",
    "components/execution/PlanGraph.tsx",
    "components/execution/WorkflowGraph.tsx",
    "components/fix/FixCard.tsx",
    "components/fix/StructuralFinding.tsx",
  ]);
  const optIns = screens.filter((file) => /font="title"/.test(read(file)));
  assert.deepEqual(optIns.filter((file) => !allowed.has(file)), [], "a new file sets body-size text in the title font; ordinary text stays in Capriola");
  // Hints and small lists are ordinary text.
  assert.match(read("components/project/BeginScreen.tsx"), /<T variant="heading" font="text">Swipe up to review<\/T>/);
  assert.match(read("app/review/[caseId]/enacting.tsx"), /<T variant="small" style=\{\{ flex: 1 \}\}>\{run\.name\}<\/T>/);
  assert.doesNotMatch(read("app/review/[caseId]/enacting.tsx"), /variant="small" font="title"/);
});
