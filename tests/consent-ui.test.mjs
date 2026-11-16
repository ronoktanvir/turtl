import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createLoader, root } from "./fixtures/convex-memory.mjs";

// The app's side of the AI permission: the words the gear sheet shows, the example build that never asks, and the
// live calls the screen makes. The screen itself is rendered and photographed by hand (see the slice report).

const practices = JSON.parse(readFileSync(join(root, "store/data-practices.json"), "utf8"));
const words = createLoader()("components/consent/words.ts");

const service = (id, name, allowed) => ({ id, name, does: "Does things", receives: [], policy: "", allowed });
const status = (answer, allowed, extra = {}) => ({
  enforced: true, signedIn: true, answer, needsAnswer: false, listVersion: "v", alsoUsed: [],
  services: [service("openai", "OpenAI", allowed), service("supermemory", "Supermemory", allowed), service("capy", "Capy", allowed), service("keiki", "Keiki", allowed)],
  ...extra,
});

test("after Not now, a reload at the start returns to \"turtl will work without AI\", not the whole list", () => {
  assert.equal(words.showsDeclined(true, false, status("none", false, { needsAnswer: true })), true);
  assert.equal(words.showsDeclined(false, true, status("declined", false)), true);
  assert.equal(words.showsDeclined(false, false, status("declined", false)), false, "from the gear sheet or a notice: the list, to allow");
  assert.equal(words.showsDeclined(false, true, status("declined", false, { needsAnswer: true })), false, "a changed list is asked again");
  assert.equal(words.showsDeclined(false, true, status("none", false, { needsAnswer: true })), false);
  const screen = readFileSync(join(root, "app/ai-permission.tsx"), "utf8");
  assert.match(screen, /if \(showsDeclined\(declined, atStart, status\)\)/);
});

test("the gear sheet says where the permission and the spend stand, in one sentence each", () => {
  assert.equal(words.listNames(["OpenAI"]), "OpenAI");
  assert.equal(words.listNames(["OpenAI", "Capy"]), "OpenAI and Capy");
  assert.equal(words.listNames(["OpenAI", "Supermemory", "Capy", "Keiki"]), "OpenAI, Supermemory, Capy and Keiki");
  const nov15 = Date.parse("2026-11-15T12:00:00Z");
  assert.equal(words.standingLine(status("allowed", true, { answeredAt: nov15 })), "turtl may use OpenAI, Supermemory, Capy and Keiki, as you allowed on 15 November.");
  assert.equal(words.standingLine(status("declined", false)), "You chose Not now, so turtl sends nothing to AI services and uses its own rules.");
  assert.equal(words.standingLine(status("withdrawn", false, { withdrawnAt: nov15 })), "You took permission back on 15 November, so turtl sends nothing to AI services and uses its own rules.");
  assert.equal(words.standingLine(status("none", false)), "You have not answered yet, so turtl sends nothing to AI services and uses its own rules.");
  const changed = status("allowed", true);
  changed.services[3].allowed = false;
  assert.equal(words.standingLine(changed), "turtl's list changed after you agreed. Read it again to let turtl use Keiki.");
  assert.equal(
    words.spendLine({ enforced: true, signedIn: true, month: "November 2026", spentUsd: 3.254, limitUsd: 20, threadsToday: 1, threadsPerDay: 5 }),
    "AI use in November: $3.25 of $20.00. Code changes today: 1 of 5.",
  );
  assert.equal(words.whatItDoes({ name: "Capy", does: "Writes an approved code change and opens a pull request" }), "Capy, which writes an approved code change and opens a pull request");
});

test("the example build never asks or blocks, and still lists the real services", async () => {
  const { example } = createLoader({ react: { useSyncExternalStore: (_subscribe, read) => read() } })("data/consent/example.ts");
  const shown = example.useAiPermission();
  assert.equal(shown.enforced, false);
  assert.equal(shown.needsAnswer, false);
  assert.deepEqual(shown.services.map((s) => s.name), practices.services.filter((s) => s.needsPermission).map((s) => s.name));
  assert.deepEqual(shown.services[0].receives, practices.services.find((s) => s.id === "openai").receives);
  assert.equal(example.useAiSpend().enforced, false);
  await example.allowAi(shown.listVersion);
  assert.ok(example.useAiPermission().services.every((s) => s.allowed));
  await example.withdrawAi();
  assert.equal(example.useAiPermission().answer, "withdrawn");
});

test("the live build sends the list version it showed, and turns backend errors into plain words", async () => {
  const calls = [];
  let fail = null;
  const client = { mutation: async (fn, args) => { calls.push([fn.path, args]); if (fail) throw fail; return null; } };
  const { live } = createLoader({
    "data/live/client": { liveClient: client, requireLiveClient: () => client, errorMessage: (error) => error.data ?? error.message },
    react: { useEffect: () => {}, useState: (value) => [value, () => {}] },
  })("data/consent/live.ts");
  await live.allowAi("abc12345");
  await live.declineAi("abc12345");
  await live.withdrawAi();
  assert.deepEqual(calls, [
    ["api.consent.permission.allow", { listVersion: "abc12345" }],
    ["api.consent.permission.decline", { listVersion: "abc12345" }],
    ["api.consent.permission.withdraw", {}],
  ]);
  fail = Object.assign(new Error("[CONVEX] Server Error"), { data: "Sign in to continue." });
  await assert.rejects(live.allowAi("abc12345"), { message: "Sign in to continue." });
});

test("the shared screens each gained one self-contained line, and the gate is one line in the root layout", () => {
  const count = (file, pattern) => (readFileSync(join(root, file), "utf8").match(pattern) ?? []).length;
  assert.equal(count("app/_layout.tsx", /<ConsentGate \/>/g), 1);
  assert.equal(count("components/project/SettingsSheet.tsx", /<AiSettings onClose=\{onClose\} \/>/g), 1);
  for (const file of ["app/project/[projectId]/index.tsx", "app/project/[projectId]/investigate.tsx", "app/review/[caseId]/index.tsx", "app/review/[caseId]/chat.tsx"]) {
    assert.equal(count(file, /<AiNotice /g), 1, file);
  }
  const gate = readFileSync(join(root, "components/consent/ConsentGate.tsx"), "utf8");
  assert.match(gate, /return isLiveData \? <LiveGate \/> : null;/, "the example build never mounts the gate");
  assert.match(gate, /status\?\.enforced && status\.signedIn && status\.needsAnswer/);
});
