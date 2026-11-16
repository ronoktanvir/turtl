import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createLoader } from "./fixtures/convex-memory.mjs";

// A practice app has no customers and no code. What turtl shows on one must not read as if it had either; the
// words shared with real projects say "booking", not "customer", where they cannot tell the two apart.

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("a practice app's empty Fix and Features lists talk about breaking it, not about customers", () => {
  const empty = read("components/project/NothingOpen.tsx");
  assert.match(empty, /fix: "When you break your practice app, turtl's check notices and opens an issue here\."/);
  assert.match(empty, /feature: "Your practice app has no customers, so no feature requests come here\. Your own projects' requests do\."/);
  assert.match(empty, /\.\.\.\(practice && \{ note: practiceNotes\[type\] \}\)/);
});

test("a practice app's Settings has no customer report form to set up", () => {
  assert.match(read("components/project/SettingsSheet.tsx"), /\{visible && !practice && <CustomerReportsSettings projectId=\{projectId\} \/>\}/);
});

test("the booking app's evidence and fixes do not claim customers", () => {
  const collectors = read("convex/evidence/collectors.ts");
  assert.match(collectors, /"No bookings were attempted in the observed window\."/);
  assert.doesNotMatch(collectors, /customer booking/);
  const { SWITCHES } = createLoader()("convex/protectedApp/switches.ts");
  for (const known of Object.values(SWITCHES)) {
    for (const words of [known.reason, known.whatChanges, known.whatMightBeLost, known.factsSay ?? ""]) assert.doesNotMatch(words, /customer/i, words);
  }
});
