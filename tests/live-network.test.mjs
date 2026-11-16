import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";

function load(path, imports) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInThisContext(`(function(require, exports, module) { ${outputText}\n})`, { filename: path })(
    (name) => {
      assert.ok(name in imports, `Unexpected import: ${name}`);
      return imports[name];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const refs = {
  screens: { network: { resolve: "screens/network:resolve" } },
  fixes: { messages: "fixes:messages", investigate: "fixes:investigate" },
  codeNetwork: {
    network: { get: "codeNetwork/network:get", messages: "codeNetwork/network:messages" },
    ask: { ask: "codeNetwork/ask:ask" },
  },
};

function hooks() {
  const states = [];
  let cursor = 0;
  const queryCalls = [];
  const actionCalls = [];
  const queryValues = new Map();
  let action = async () => ({ outcome: "answered" });
  const client = {
    liveClient: { action: async (...args) => { actionCalls.push(args); return action(...args); } },
    errorMessage: (error) => error.message.includes("Could not find public function")
      ? "This backend has not been updated for this control yet. No example data was substituted."
      : error.message,
    useLiveQuery: (ref, args) => {
      queryCalls.push([ref, args]);
      return args === "skip" ? undefined : queryValues.get(JSON.stringify([ref, args]));
    },
  };
  const exports = load("../data/live/network.ts", {
    react: {
      useState: (initial) => {
        const index = cursor++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
      },
    },
    "../../convex/_generated/api": { api: refs },
    "./client": client,
  });
  return {
    client,
    queryCalls,
    actionCalls,
    value: (ref, args, value) => queryValues.set(JSON.stringify([ref, args]), value),
    resolve: (id, value) => queryValues.set(JSON.stringify(["screens/network:resolve", { projectId: id }]), value),
    action: (handler) => { action = handler; },
    chat: (scope) => { cursor = 0; return exports.useChat(scope); },
    network: (projectId) => { cursor = 0; return exports.useCodeNetwork(projectId); },
  };
}

const { resolve } = load("../convex/screens/network.ts", {
  "convex/values": { v: { string: () => ({}) } },
  "../_generated/server": { query: (definition) => definition },
  // The public builder, without its demo check (convex/functions.ts), which tests/access-rules.test.mjs covers.
  "../functions": { query: (definition) => definition },
  // The real access rule. With AUTH_REQUIRED unset, as here, its checks do nothing.
  "../access": load("../convex/access.ts", {
    "convex/values": await import("convex/values"),
    "./_generated/api": { internal: {} },
    "./_generated/server": { internalQuery: (definition) => definition },
    "./auth/confirmed": load("../convex/auth/confirmed.ts", {}),
  }),
});

function resolveFor(app, networks = [], projectId = "app-1") {
  const db = {
    normalizeId: (_table, id) => id.startsWith("app-") ? id : null,
    get: async (id) => id === app?._id ? app : null,
    query: (table) => {
      assert.equal(table, "codeNetworks");
      let rows = [...networks].reverse();
      const query = {
        withIndex: (_index, range) => {
          range({ eq: (field, value) => { rows = rows.filter((row) => row[field] === value); } });
          return query;
        },
        order: () => query,
        first: async () => rows[0] ?? null,
        collect: async () => rows,
      };
      return query;
    },
  };
  return resolve.handler({ db }, { projectId });
}

const app = { _id: "app-1", repoUrl: "https://github.com/owner/booking" };
const network = { projectId: "owner/booking", repo: "owner/booking", source: "built" };

test("the resolver prefers a verified direct app id over repository aliases", async () => {
  const direct = { ...network, projectId: "app-1" };
  assert.deepEqual(await resolveFor(app, [direct, network]), direct);
});

test("repository matching is canonical and exact, not an app-name or substring guess", async () => {
  const canonical = { ...app, repoUrl: "https://github.com/Owner/Booking.git/" };
  assert.deepEqual(await resolveFor(canonical, [network]), network);
  assert.deepEqual(await resolveFor({ ...app, repoUrl: "git@github.com:Owner/Booking.git" }, [network]), network);
  for (const repoUrl of ["https://github.com/owner/booking-extra", "https://github.com/other/booking", "https://github.com.evil.test/owner/booking", "https://example.com/owner/booking"]) {
    assert.equal(await resolveFor({ ...app, repoUrl }, [network]), null, repoUrl);
  }
});

test("mismatched direct-id seeds never mix Listener Ladder into another app", async () => {
  const listenerSeed = { projectId: "app-1", repo: "other/listener-ladder", source: "seed" };
  assert.equal(await resolveFor(app, [listenerSeed]), null);
  assert.equal(await resolveFor({ _id: "app-1", name: "Still booking demo" }, [listenerSeed]), null);
  assert.deepEqual(await resolveFor(app, [listenerSeed, network]), network);
  const matchingSeed = { ...network, source: "seed" };
  assert.deepEqual(await resolveFor(app, [matchingSeed]), matchingSeed);
});

test("unknown apps, samples, and stale rows cannot provide a network", async () => {
  assert.equal(await resolveFor(app, [network], "not-an-app"), null);
  assert.equal(await resolveFor(app, [network], "app-2"), null);
  assert.equal(await resolveFor({ ...app, isSample: true }, [network]), null);
  assert.equal(await resolveFor(app, [network, { ...network, repo: "other/listener-ladder" }]), null);
});

test("network hooks distinguish loading, absent maps, and real data with seed metadata", () => {
  const h = hooks();
  assert.equal(h.network("app-1"), undefined);
  h.resolve("app-1", null);
  assert.equal(h.network("app-1"), null);
  h.resolve("app-1", { ...network, source: "seed" });
  assert.equal(h.network("app-1"), undefined);
  const graph = { projectId: network.projectId, generatedAt: 42, clusters: [], nodes: [], edges: [] };
  h.value(refs.codeNetwork.network.get, { projectId: network.projectId }, graph);
  assert.deepEqual(h.network("app-1"), { ...graph, projectId: "app-1", repo: network.repo, source: "seed" });
  h.value(refs.codeNetwork.network.get, { projectId: network.projectId }, null);
  assert.equal(h.network("app-1"), null);
  assert.equal(h.network(""), null);
});

test("project, cluster, and node messages and actions use the resolved storage key", async () => {
  for (const scope of [
    { kind: "project", projectId: "app-1" },
    { kind: "cluster", projectId: "app-1", clusterId: "booking" },
    { kind: "node", projectId: "app-1", nodeId: "booking.ts" },
  ]) {
    const h = hooks();
    h.resolve("app-1", network);
    const storedScope = { ...scope, projectId: network.projectId };
    const messages = [{ id: "message-1", role: "turtl", text: "A real answer", at: 10 }];
    h.value(refs.codeNetwork.network.messages, { scope: storedScope }, messages);
    const chat = h.chat(scope);
    assert.deepEqual(chat.messages, messages);
    assert.equal(chat.requestNewFix, undefined);
    await chat.send("  What does this do?  ");
    assert.deepEqual(h.actionCalls, [[refs.codeNetwork.ask.ask, { scope: storedScope, message: "What does this do?" }]]);
    assert.ok(h.queryCalls.some(([ref, args]) => ref === refs.fixes.messages && args === "skip"));
  }
});

test("case chat preserves proposed fixes and New fix uses the real investigate action", async () => {
  const h = hooks();
  const scope = { kind: "case", caseId: "case-1" };
  const messages = [{ id: "message-2", role: "turtl", text: "Another option", at: 20, proposedFix: { key: "repair" } }];
  h.value(refs.fixes.messages, { caseId: "case-1" }, messages);
  const chat = h.chat(scope);
  assert.deepEqual(chat.messages, messages);
  await chat.send("Why?");
  await chat.requestNewFix();
  assert.deepEqual(h.actionCalls, [
    [refs.fixes.investigate, { caseId: "case-1", message: "Why?" }],
    [refs.fixes.investigate, { caseId: "case-1", message: "New fix", newFix: true }],
  ]);
  assert.ok(h.queryCalls.filter(([ref]) => ref !== refs.fixes.messages).every(([, args]) => args === "skip"));
});

test("busy stays true until every request in its scope settles", async () => {
  const h = hooks();
  const scope = { kind: "case", caseId: "case-1" };
  const releases = [];
  h.action(() => new Promise((release) => releases.push(release)));
  const first = h.chat(scope).send("First question");
  const second = h.chat(scope).requestNewFix();
  assert.equal(h.chat({ caseId: "case-1", kind: "case" }).busy, true);
  assert.equal(h.chat({ kind: "case", caseId: "case-2" }).busy, false);
  releases[0]();
  await first;
  assert.equal(h.chat(scope).busy, true);
  releases[1]();
  await second;
  assert.equal(h.chat(scope).busy, false);
});

test("missing functions reject readably and clear busy without fabricating messages", async () => {
  for (const scope of [{ kind: "case", caseId: "case-1" }, { kind: "project", projectId: "app-1" }]) {
    const h = hooks();
    h.resolve("app-1", network);
    h.action(async (ref) => { throw new Error(`Could not find public function ${ref}`); });
    await assert.rejects(h.chat(scope).send("Why?"), /backend has not been updated/);
    assert.equal(h.chat(scope).busy, false);
    assert.deepEqual(h.chat(scope).messages, []);
  }
});

test("not-configured code chat is a rejected request, not a successful empty answer", async () => {
  const h = hooks();
  const scope = { kind: "project", projectId: "app-1" };
  h.resolve("app-1", network);
  h.action(async () => ({ outcome: "not_configured", missing: ["OPENAI_API_KEY"] }));
  await assert.rejects(h.chat(scope).send("Why?"), /not enabled on this backend/);
  assert.equal(h.chat(scope).busy, false);
  assert.deepEqual(h.chat(scope).messages, []);
});

test("invalid or unconfigured requests never call an action", async () => {
  const h = hooks();
  const scope = { kind: "project", projectId: "app-1" };
  await assert.rejects(h.chat(scope).send("Why?"), /still loading/);
  h.resolve("app-1", null);
  await assert.rejects(h.chat(scope).send("Why?"), /No matching code network/);
  const caseScope = { kind: "case", caseId: "case-1" };
  h.value(refs.fixes.messages, { caseId: "case-1" }, null);
  await assert.rejects(h.chat(caseScope).requestNewFix(), /case was not found/);
  await assert.rejects(h.chat(caseScope).send("   "), /Enter a message/);
  await assert.rejects(h.chat(caseScope).send("x".repeat(2001)), /too long/);
  h.client.liveClient = null;
  await assert.rejects(h.chat(scope).send("Why?"), /backend URL is not configured/);
  assert.equal(h.network("app-1"), null);
  assert.deepEqual(h.actionCalls, []);
});
