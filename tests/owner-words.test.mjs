import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createLoader } from "./fixtures/convex-memory.mjs";

// Step summaries, reasons and notes under convex/ reach a case's Plan and Logs. An owner who cannot read a stack
// trace read "OPENAI_API_KEY is not set on this deployment, so no model was asked" and raw error messages there.
// The setting's name and the error's detail stay with the operator, in the backend's log.

const { NO_MODEL_REASON, NO_SUPERMEMORY, UNEXPECTED_STOP } = createLoader()("convex/constants.ts");
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const SETTING = /\b(OPENAI|SUPERMEMORY)_API_KEY\b/;

test("the words for a missing service name no setting", () => {
  for (const words of [NO_MODEL_REASON, NO_SUPERMEMORY, UNEXPECTED_STOP]) assert.doesNotMatch(words, /[A-Z]{2,}_[A-Z_]+/);
});

test("no summary, reason or note a screen can show names the model or Supermemory key", () => {
  const files = [
    "convex/fixOptions.ts", "convex/voice/openai.ts", "convex/structural/examine.ts", "convex/memory/service.ts",
    "convex/learning/preferences.ts", "convex/intake/records.ts", "convex/account/vendors.ts", "convex/codeNetwork/openai.ts",
    "convex/supermemory.ts",
  ];
  for (const file of files) {
    for (const [i, line] of read(file).split("\n").entries()) {
      const code = line.replace(/\/\/.*$/, "");
      if (!SETTING.test(code) || /process\.env\./.test(code) || /credentialRef/.test(code)) continue;
      assert.fail(`${file}:${i + 1} shows a setting's name: ${line.trim()}`);
    }
  }
});

test("a thrown error's message is logged, not written into what the owner reads", () => {
  const passes = /\$\{[^}]*error\.message[^}]*\}|error: error instanceof Error \? error\.message/;
  for (const file of ["convex/runner/run.ts", "convex/runner/handlers/gather_context.ts", "convex/structural/examine.ts"]) {
    assert.doesNotMatch(read(file), passes, file);
  }
  assert.match(read("convex/runner/run.ts"), /result = \{ status: "failed", error: UNEXPECTED_STOP \}/);
});

test("a remembered recovery is named in words, not by its id", () => {
  const gather = read("convex/runner/handlers/gather_context.ts");
  assert.doesNotMatch(gather, /Recovery memory \$\{/);
  assert.match(gather, /A recovery turtl remembers applies/);
});
