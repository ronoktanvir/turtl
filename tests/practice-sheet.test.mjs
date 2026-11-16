import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createLoader } from "./fixtures/convex-memory.mjs";

// The practice sheet says where turtl truly is with the issue it opened, leads to a waiting fix, and at the day's
// limit leads with the limit and when it resets, offering no choice that cannot be used.

const sheet = createLoader({
  "expo-router": {}, react: {}, "react-native": {}, "react/jsx-runtime": { jsx: () => null, jsxs: () => null, Fragment: "Fragment" },
  "data/practice": {}, "data/practice/index": {}, theme: {}, "components/ui": {},
})("components/practice/PracticeSheet.tsx");
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("an open issue's stage is told apart from the case's status", () => {
  const { stageOf, nextDay } = createLoader()("convex/practice/projects.ts");
  for (const status of ["open", "investigating"]) assert.equal(stageOf(status), "working", status);
  assert.equal(stageOf("waiting_for_owner"), "waiting");
  for (const status of ["executing", "waiting_for_deploy", "verifying"]) assert.equal(stageOf(status), "carrying_out", status);
  assert.equal(nextDay(Date.UTC(2026, 10, 16, 15, 30)), Date.UTC(2026, 10, 17), "the allowance day is a UTC day");
  assert.equal(nextDay(Date.UTC(2026, 11, 31, 23, 59)), Date.UTC(2027, 0, 1));
});

test("each stage says what is true, and a waiting fix leads to it", () => {
  const { STAGE_WORDS } = sheet;
  assert.equal(STAGE_WORDS.working.title, "turtl is working it out");
  assert.equal(STAGE_WORDS.waiting.title, "A fix is waiting for you");
  assert.equal(STAGE_WORDS.waiting.button, "Look at the fix");
  assert.equal(STAGE_WORDS.carrying_out.enacting, true, "carrying out leads to the running fix");
  assert.doesNotMatch(JSON.stringify(STAGE_WORDS), /working out what to do/);
  const source = read("components/practice/PracticeSheet.tsx");
  assert.match(source, /const stage = STAGE_WORDS\[project\.caseStage \?\? "working"\];/);
});

test("at the day's limit the sheet leads with it and when it resets, and offers no choices", () => {
  const { resetWords } = sheet;
  const now = new Date(2026, 10, 16, 9, 0).getTime();
  assert.match(resetWords(new Date(2026, 10, 16, 16, 0).getTime(), now), /^at 4:00\sPM$/);
  assert.match(resetWords(new Date(2026, 10, 17, 1, 0).getTime(), now), /^tomorrow at 1:00\sAM$/);
  const source = read("components/practice/PracticeSheet.tsx");
  const limit = source.slice(source.indexOf("if (out) {"), source.indexOf("  return (", source.indexOf("if (out) {") + 20));
  assert.match(limit, /title="That's all for today"/);
  assert.match(limit, /You have broken your practice app as often as one day allows\. You can break it again \$\{/);
  assert.doesNotMatch(limit, /<Choice|practice-break-confirm/, "no choice and no Break button at the limit");
});
