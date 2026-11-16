import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { agent, fixture, HEAD, MERGE, json } from "./external-app-test-harness.mjs";

const originalFetch = globalThis.fetch;
const originalCapyKey = process.env.CAPY_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCapyKey === undefined) delete process.env.CAPY_API_KEY;
  else process.env.CAPY_API_KEY = originalCapyKey;
  delete process.env.EXTERNAL_APP_TEST_GITHUB_TOKEN;
});

test("protected paths include configured test/probe trees and wildcard rules", () => {
  for (const path of ["tests/acceptance.spec.ts", "scripts/probe.ts", ".github/workflows/turtl-probe.yml", "deep/game.test.ts"]) {
    assert.equal(agent.isProtectedPath(path, ["tests/", "scripts/probe.ts", ".github/workflows/**", "**/*.test.ts"]), true, path);
  }
  assert.equal(agent.isProtectedPath("lib/game.ts", ["tests/", "scripts/probe.ts"]), false);
  assert.equal(agent.isProtectedPath("tests-other/game.ts", ["tests/"]), false);
});

test("GitHub changed files are read at a stable head and renamed protected files stay flagged", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return url.includes("/files?") ? json([{ filename: "lib/acceptance.ts", previous_filename: "tests/acceptance.ts", status: "renamed",
      additions: 1, deletions: 0, patch: "actual GitHub diff" }]) : json({ head: { sha: HEAD } });
  };
  const result = await agent.readChangedFiles("mock-only", "example/game", 42, ["tests/"]);
  assert.equal(result.ok, true);
  assert.equal(result.body.headSha, HEAD);
  assert.equal(result.body.files[0].patch, "actual GitHub diff");
  assert.equal(result.body.files[0].protectedPath, true);
  assert.equal(result.body.truncated, false);
  assert.equal(calls.length, 3);
});

test("a PR push during file retrieval discards the ambiguously attributed diff", async () => {
  let heads = 0;
  globalThis.fetch = async (url) => url.includes("/files?") ? json([]) : json({ head: { sha: ++heads === 1 ? HEAD : MERGE } });
  const result = await agent.readChangedFiles("mock-only", "example/game", 42, []);
  assert.equal(result.ok, false);
  assert.match(result.message, /head changed/);
});

test("file and patch caps are visible instead of claiming the whole PR was shown", async () => {
  globalThis.fetch = async (url) => {
    if (!url.includes("/files?")) return json({ head: { sha: HEAD } });
    const page = Number(new URL(url).searchParams.get("page"));
    return json(Array.from({ length: page === 4 ? 1 : 100 }, (_, index) => ({ filename: `lib/${page}-${index}.ts`,
      status: "modified", additions: 1, deletions: 1, patch: "x".repeat(20_000) })));
  };
  const result = await agent.readChangedFiles("mock-only", "example/game", 42, []);
  assert.equal(result.ok, true);
  assert.equal(result.body.files.length, 300);
  assert.equal(result.body.truncated, true);
  assert.equal(result.body.files[0].patchTruncated, true);
  assert.ok(result.body.files.reduce((count, file) => count + (file.patch?.length ?? 0), 0) <= 240_000);
});

test("real API transcript pages preserve user/assistant/tool provenance without turtl rewriting", async () => {
  const f = fixture();
  f.rows.get("pull1").snapshot.state = "open";
  process.env.CAPY_API_KEY = "mock-only";
  process.env.EXTERNAL_APP_TEST_GITHUB_TOKEN = "mock-only";
  const cursor = "0".repeat(26);
  const texts = ["Please repair the actual answer path.", "I found the blocking rank scan.", "Reading lib/game.ts"];
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, auth: init.headers.Authorization });
    if (url.endsWith("/threads/thread1")) return json({ status: "working" });
    if (url.includes("/messages?")) {
      const second = new URL(url).searchParams.has("after");
      return json({ items: (second ? [2] : [0, 1]).map((index) => ({ id: `message${index}`, source: ["user", "assistant", "tool"][index],
        text: texts[index], ...(index === 2 && { tool: "read" }), createdAt: "2026-11-15T23:00:00Z" })), cursor: second ? null : cursor });
    }
    if (url.includes("/files?")) return json([{ filename: "lib/game.ts", status: "modified", additions: 2, deletions: 20, patch: "- await rankAll()" }]);
    return json({ head: { sha: HEAD } });
  };
  await agent.syncAgentEvidence(f.ctx, "pull1");
  assert.deepEqual(f.tableRows("agentMessages").map((message) => message.text), texts);
  assert.deepEqual(f.tableRows("agentMessages").map((message) => message.source), ["user", "assistant", "tool"]);
  assert.ok(f.tableRows("agentMessages").every((message) => message.caseId === "case1" && message.pullRequestId === "pull1" && message.threadId === "thread1"));
  assert.equal(f.tableRows("agentThreads")[0].cursor, cursor);
  assert.equal(f.tableRows("agentThreads")[0].done, false);
  assert.equal(f.tableRows("pullRequestChanges")[0].headSha, HEAD);
  assert.ok(requests.some((request) => request.url.includes(`after=${cursor}`)));
  await agent.syncAgentEvidence(f.ctx, "pull1");
  assert.equal(f.tableRows("agentMessages").length, 3);
  assert.equal(f.tableRows("pullRequestChanges").length, 1);
});

test("long original agent text is cut only with an explicit truncation flag", async () => {
  const f = fixture();
  process.env.CAPY_API_KEY = "mock-only";
  process.env.EXTERNAL_APP_TEST_GITHUB_TOKEN = "mock-only";
  globalThis.fetch = async (url) => {
    if (url.endsWith("/threads/thread1")) return json({ status: "idle" });
    if (url.includes("/messages?")) return json({ items: [{ id: "long1", source: "assistant", text: "x".repeat(20_000), createdAt: "2026-11-15T23:00:00Z" }], cursor: null });
    return url.includes("/files?") ? json([]) : json({ head: { sha: HEAD } });
  };
  await agent.syncAgentEvidence(f.ctx, "pull1");
  assert.equal(f.tableRows("agentMessages")[0].text, "x".repeat(16_000));
  assert.equal(f.tableRows("agentMessages")[0].truncated, true);
  assert.equal(f.tableRows("agentThreads")[0].done, true);
});

test("unavailable agent updates remain unavailable, without synthetic progress or leaked headers", async () => {
  const f = fixture();
  process.env.CAPY_API_KEY = "mock-only";
  delete process.env.EXTERNAL_APP_TEST_GITHUB_TOKEN;
  globalThis.fetch = async () => json({ message: "unauthorized" }, 403);
  await agent.syncAgentEvidence(f.ctx, "pull1");
  assert.equal(f.tableRows("agentMessages").length, 0);
  assert.match(f.tableRows("agentThreads")[0].syncError, /403/);
  assert.equal(JSON.stringify(f.tableRows("agentThreads")).includes("mock-only"), false);
});

test("transcript writes reject a different thread or case and cannot rewind a concurrent cursor", async () => {
  const f = fixture();
  const args = { pullRequestId: "pull1", threadId: "thread1", status: "working", done: false, cursor: "first",
    messages: [{ caseId: "case1", pullRequestId: "pull1", threadId: "thread1", messageId: "m1", source: "assistant", text: "Actual reply", createdAt: 1 }] };
  await assert.rejects(agent.saveTranscript._handler(f.ctx, { ...args, threadId: "other-thread" }), /not from/);
  await assert.rejects(agent.saveTranscript._handler(f.ctx, { ...args, messages: [{ ...args.messages[0], caseId: "other-case" }] }), /provenance/);
  assert.equal(await agent.saveTranscript._handler(f.ctx, args), true);
  assert.equal(await agent.saveTranscript._handler(f.ctx, { ...args, cursor: "stale" }), false);
  assert.equal(f.tableRows("agentThreads")[0].cursor, "first");
  assert.equal(f.tableRows("agentMessages").length, 1);
});

test("file evidence never attaches to a different PR or an outdated PR head", async () => {
  const f = fixture();
  const row = { pullRequestId: "pull1", caseId: "case1", repo: "example/game", number: 42, headSha: HEAD, files: [], truncated: false, readAt: 1 };
  await assert.rejects(agent.saveChanges._handler(f.ctx, { row: { ...row, number: 43 } }), /real PR/);
  assert.equal(await agent.saveChanges._handler(f.ctx, { row: { ...row, headSha: MERGE } }), false);
  assert.equal(f.tableRows("pullRequestChanges").length, 0);
});
