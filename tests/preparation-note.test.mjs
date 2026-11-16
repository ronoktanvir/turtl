import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";

function load(path, imports) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: path,
  });
  const module = { exports: {} };
  runInThisContext("(function(require, exports, module) { " + outputText + "\n})", { filename: path })(
    (name) => { assert.ok(name in imports, "Unexpected import: " + name); return imports[name]; }, module.exports, module,
  );
  return module.exports;
}

const { rulesNote } = load("../components/onboarding/stage.ts", {});

// convex/onboarding/inspect.ts words its fallback reasons "No model answered: ..." and "No model answered (...)".
// The Preparation screen leads with its own "No model answered" sentence, so the owner read it twice.

test("a rules-judged report says 'No model answered' once", () => {
  const note = rulesNote("No model answered: OPENAI_API_KEY is not set on turtl's deployment. These results are text-search leads only.");
  assert.equal(note.match(/No model answered/g).length, 1);
  assert.equal(note, "No model answered, so turtl judged this with its built-in rules. OPENAI_API_KEY is not set on turtl's deployment. These results are text-search leads only.");
  const failed = rulesNote("No model answered (the request timed out). These results are text-search leads only.");
  assert.equal(failed.match(/No model answered/g).length, 1);
  assert.ok(failed.endsWith("(the request timed out). These results are text-search leads only."));
});

test("a reason worded otherwise is kept whole, and no reason leaves the plain note", () => {
  assert.equal(rulesNote(undefined), "No model answered, so turtl judged this with its built-in rules.");
  assert.equal(rulesNote("  "), "No model answered, so turtl judged this with its built-in rules.");
  assert.equal(rulesNote("the model's answer could not be read."), "No model answered, so turtl judged this with its built-in rules. The model's answer could not be read.");
});

test("Preparation builds its rules note through rulesNote", () => {
  const prepare = readFileSync(new URL("../app/project/[projectId]/prepare.tsx", import.meta.url), "utf8");
  assert.ok(prepare.includes('inspection?.judgedBy === "rules" ? rulesNote(inspection.fallbackReason)'));
});
