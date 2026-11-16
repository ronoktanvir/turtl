import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import ts from "typescript";

// These tests run turtl's real public functions against an in-memory copy of every table in convex/schema.ts and a
// fake caller identity, once with accounts on (AUTH_REQUIRED=true) and once as the single-owner demo. A function
// may only read a table by an index the schema defines, and only write fields the schema names. Nothing here talks
// to Convex or a vendor: the runner, the decision log, the case chat's model, and Supermemory are stand-ins.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
// convex/schema.ts spreads Convex Auth's tables. That package publishes only an ES module build, which require()
// cannot reach, so it is loaded up front and handed out by the loader below.
const esModules = { "@convex-dev/auth/server": await import("@convex-dev/auth/server") };
const VARIABLES = [
  "AUTH_REQUIRED", "DEV_TOOLS_ENABLED", "PROTECTED_APP_CONTROL_SECRET_SHA256", "PROTECTED_APP_URL", "CODE_NETWORK_CHAT_ENABLED", "OPENAI_API_KEY", "SUPERMEMORY_API_KEY",
  // Demo-only and stand-in variables (finding 8), what they need beside them, and the deployment's own address.
  "GITHUB_TOKEN", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_SLUG", "GITHUB_APP_WEBHOOK_SECRET", "AUTH_STAND_IN_URL", "AUTH_RESEND_KEY", "AUTH_EMAIL_FROM",
  "KEIKI_API_KEY", "KEIKI_AGENT_ID", "KEIKI_OWNER_CONTACT", "EXPO_PUSH_API_URL", "REVYL_API_KEY", "REVYL_BOOKING_WORKFLOW_ID", "CONVEX_CLOUD_URL",
  // Limits (findings 5 and 7).
  "INTAKE_CASES_PER_DAY", "INTAKE_SPEND_PER_DAY_USD", "PROJECTS_PER_ACCOUNT", "INTAKE_KEYS_PER_PROJECT",
];
const PASSCODE = "local-fixture-passcode";
const SIGN_IN = "Sign in to continue.";
const NOT_AVAILABLE = "That project is not available on this account.";

const ref = (path) => new Proxy({ path }, { get: (target, key) => (key === "path" ? target.path : ref(path + "." + String(key))) });
const registered = (kind) => (definition) => ({ kind, ...definition });
const generated = {
  "convex/_generated/api": { api: ref("api"), internal: ref("internal"), components: ref("components") },
  "convex/_generated/server": {
    query: registered("query"),
    mutation: registered("mutation"),
    action: registered("action"),
    internalQuery: registered("query"),
    internalMutation: registered("mutation"),
    internalAction: registered("action"),
    httpAction: (handler) => handler,
  },
};

// Stand-ins for what is not under test. Each records its calls on `calls`.
function standIns(calls) {
  const note = (name) => async (...args) => { calls.push([name, ...args.slice(1)]); return null; };
  return {
    "convex/runner/run": {
      approveCase: note("approveCase"),
      declineCase: note("declineCase"),
      // Files the case as the runner would, without running it.
      startCaseRun: async (ctx, fields) => (calls.push(["startCaseRun", fields]), await ctx.db.insert("cases", { ...fields, status: "open" })),
    },
    "convex/learning/feedback": { recordDecision: note("recordDecision") },
    "convex/learning/model": { cleanStatement: (text) => text, preferenceFromNote: async () => ({ ok: false, reason: "stand-in" }) },
    "convex/supermemory": { searchChunks: async () => [], putDocument: async () => "doc", deleteDocuments: async () => {}, searchWithMetadata: async () => [] },
    "convex/codeNetwork/openai": { respond: async () => { throw new Error("No model is called in these tests."); } },
    "convex/onboarding/prepare": { syncPreparation: async () => null },
    "convex/bookingDemo/journeyCore": { completeBooking: async () => ({ ok: true }) },
  };
}

function createLoader(mocks) {
  const loaded = new Map();
  const load = (file) => {
    if (loaded.has(file)) return loaded.get(file).exports;
    const module = { exports: {} };
    loaded.set(file, module);
    const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    const require = (name) => {
      if (!name.startsWith(".")) return name in esModules ? esModules[name] : nodeRequire(name);
      const key = resolve(dirname(file), name).slice(root.length + 1);
      if (key in mocks) return mocks[key];
      if (key in generated) return generated[key];
      // A JSON import (store/data-practices.json, which convex/consent/services.ts reads) is data, not a module to compile.
      if (key.endsWith(".json")) {
        const data = JSON.parse(readFileSync(resolve(root, key), "utf8"));
        return { ...data, default: data };
      }
      return load(resolve(root, key + ".ts"));
    };
    runInThisContext("(function(require, exports, module) { " + outputText + "\n})", { filename: file })(require, module.exports, module);
    return module.exports;
  };
  return (path) => load(resolve(root, path));
}

// Convex's ordering, enough for these tables: undefined first, then by type, then by value.
function compare(a, b) {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  if (typeof a !== typeof b) return typeof a < typeof b ? -1 : 1;
  return a < b ? -1 : 1;
}
const operators = { eq: (a, b) => a === b, gt: (a, b) => compare(a, b) > 0, gte: (a, b) => compare(a, b) >= 0, lt: (a, b) => compare(a, b) < 0, lte: (a, b) => compare(a, b) <= 0 };

function createBackend(load) {
  const schema = load("convex/schema.ts").default.tables;
  const tables = new Map(Object.keys(schema).map((name) => [name, []]));
  const scheduled = [];
  let counter = 0;
  const rowsOf = (table) => {
    assert.ok(tables.has(table), "Unknown table " + table);
    return tables.get(table);
  };
  const locate = (id) => {
    const table = String(id).split(":")[0];
    const rows = tables.get(table) ?? [];
    const index = rows.findIndex((row) => row._id === id);
    return index === -1 ? null : { table, rows, index };
  };
  const checked = (table, fields) => {
    const known = schema[table].validator.fields;
    for (const name of Object.keys(fields)) if (known) assert.ok(name in known, table + " has no field " + name);
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  };
  const indexFields = (table, name) => {
    const fields = schema[table].export().indexes.find((index) => index.indexDescriptor === name)?.fields;
    assert.ok(fields, table + " has no index " + name);
    return fields;
  };
  const builder = (table, index, conditions, order) => {
    const run = () => {
      const fields = index ? indexFields(table, index) : [];
      const rows = rowsOf(table)
        .filter((row) => conditions.every(([operator, field, value]) => operators[operator](row[field], value)))
        .sort((a, b) => fields.reduce((found, field) => found || compare(a[field], b[field]), 0) || a._creationTime - b._creationTime);
      return structuredClone(order === "desc" ? rows.reverse() : rows);
    };
    return {
      withIndex: (name, build) => {
        const fields = indexFields(table, name);
        const found = [];
        const range = Object.fromEntries(Object.keys(operators).map((operator) => [operator, (field, value) => (found.push([operator, field, value]), range)]));
        build?.(range);
        found.forEach(([, field], position) => assert.equal(field, fields[position], table + "." + name + " cannot be read by " + field + " here"));
        return builder(table, name, found, order);
      },
      order: (direction) => builder(table, index, conditions, direction),
      collect: async () => run(),
      take: async (count) => run().slice(0, count),
      first: async () => run()[0] ?? null,
      unique: async () => {
        const rows = run();
        assert.ok(rows.length <= 1, table + ": unique() matched " + rows.length + " rows");
        return rows[0] ?? null;
      },
    };
  };
  const db = {
    normalizeId: (table, id) => (typeof id === "string" && id.startsWith(table + ":") ? id : null),
    get: async (id) => {
      const found = locate(id);
      return found ? structuredClone(found.rows[found.index]) : null;
    },
    insert: async (table, fields) => {
      const row = { _id: table + ":" + ++counter, _creationTime: 1_800_000_000_000 + counter, ...checked(table, structuredClone(fields)) };
      rowsOf(table).push(row);
      return row._id;
    },
    patch: async (id, fields) => {
      const found = locate(id);
      assert.ok(found, "No document " + id);
      const next = { ...found.rows[found.index], ...structuredClone(fields) };
      for (const [key, value] of Object.entries(fields)) if (value === undefined) delete next[key];
      found.rows[found.index] = { ...next, ...checked(found.table, {}) };
    },
    delete: async (id) => {
      const found = locate(id);
      assert.ok(found, "No document " + id);
      found.rows.splice(found.index, 1);
    },
    query: (table) => builder(table, null, [], "asc"),
    // The scheduled jobs, readable one at a time by id; a read of the whole table is recorded, so a test can say none happened.
    system: {
      get: async (id) => structuredClone(scheduled.find((job) => job.id === id)?.job ?? null),
      query: (table) => (systemReads.push(table), { collect: async () => [] }),
    },
  };
  const systemReads = [];
  const scheduler = {
    runAfter: async (_delay, fn, args) => {
      const id = "_scheduled_functions:" + ++counter;
      scheduled.push({ id, path: fn.path, args, job: { _id: id, name: fn.path, args: [args], state: { kind: "pending" } } });
      return id;
    },
    cancel: async (id) => {
      const found = scheduled.find((job) => job.id === id);
      if (found) found.job.state = { kind: "canceled" };
    },
  };
  const runs = [];
  const contextFor = (identity) => {
    const auth = { getUserIdentity: async () => identity };
    const call = async (fn, args, kind) => {
      runs.push(fn.path);
      const segments = fn.path.split(".").slice(1);
      const name = segments.pop();
      const definition = load("convex/" + segments.join("/") + ".ts")[name];
      assert.ok(definition?.handler, "No function " + fn.path);
      assert.equal(definition.kind, kind, fn.path + " is not a " + kind);
      return await definition.handler(kind === "action" ? actionCtx : { db, auth, scheduler }, structuredClone(args));
    };
    const actionCtx = {
      auth,
      scheduler,
      runQuery: (fn, args) => call(fn, args, "query"),
      runMutation: (fn, args) => call(fn, args, "mutation"),
      runAction: (fn, args) => call(fn, args, "action"),
    };
    return { db, auth, scheduler, actionCtx };
  };
  return { db, rows: (table) => structuredClone(rowsOf(table)), scheduled, systemReads, runs, contextFor };
}

// One isolated world per test: fresh modules, empty tables, and only the variables the test sets.
function world(t, env = {}) {
  const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of VARIABLES) delete process.env[name];
  Object.assign(process.env, env);
  t.after(() => {
    for (const name of VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  const calls = [];
  const load = createLoader(standIns(calls));
  const backend = createBackend(load);
  const identity = (account) => (account ? { subject: account + "|session-1", tokenIdentifier: "https://auth.test|" + account } : null);
  // Calls a public function by module and name, as the given account (or signed out with null).
  const as = (account) => async (module, name, args = {}) => {
    const definition = load("convex/" + module + ".ts")[name];
    assert.ok(definition?.handler, "No function " + module + ":" + name);
    assert.ok(["query", "mutation", "action"].includes(definition.kind));
    const ctx = backend.contextFor(identity(account));
    return await definition.handler(definition.kind === "action" ? ctx.actionCtx : ctx, structuredClone(args));
  };
  return { load, backend, calls, as, access: load("convex/access.ts"), ctxFor: (account) => backend.contextFor(identity(account)) };
}

const digest = (text) => createHash("sha256").update(text).digest("hex");

// Two accounts, each with one project and one case waiting on a proposal, and a customer report on each case.
async function seed({ backend }) {
  const { db } = backend;
  const project = async (owner, name) => {
    const appId = await db.insert("apps", { name, ownerId: owner, repoUrl: `https://github.com/${owner}/${name}`, productionUrl: `https://${owner}.test` });
    const caseId = await db.insert("cases", { appId, title: `${name} is down`, impact: "Nobody can book.", kind: "outage", raisedBy: "monitor", status: "waiting_for_owner" });
    const stepId = await db.insert("steps", { caseId, key: "plan", title: "Plan", dependsOn: [], kind: "agent", purpose: "plan", status: "done" });
    const actionCatalogId = await db.insert("actionCatalog", {
      appId, type: "set_feature_flag", name: "Turn off recommendations", description: "Sets a flag.", reversible: true,
      config: { kind: "http", url: `https://${owner}.test/flags`, method: "POST" }, parameterConstraints: [],
    });
    const proposalId = await db.insert("proposals", {
      caseId, stepId, version: 1, decisionStatus: "pending", doneMeans: [],
      options: [{ key: "recover", title: "Turn off recommendations", kind: "recovery", actionType: "set_feature_flag", actionCatalogId, target: { environment: "production", resourceRef: "flags#recommendationsEnabled" }, parameters: [], acceptanceCriteria: [], checkRefs: [], recommended: true }],
    });
    await db.insert("reports", { appId, caseId, channel: "form", fromRef: `form:device:${owner}-customer`, text: `${owner}'s customer: I can't book.`, provider: "turtl-form", providerEventId: `${owner}-1`, receivedAt: 1 });
    await db.insert("reportTriage", { reportId: (await db.query("reports").withIndex("by_case_and_requester", (q) => q.eq("caseId", caseId)).first())._id, appId, fingerprint: "f", status: "done", outcome: "attached", caseId });
    const preferenceId = await db.insert("ownerPreferences", { appId, statement: "Never restart checkout.", source: "settings" });
    return { appId, caseId, proposalId, preferenceId };
  };
  const alice = await project("alice", "shop");
  const bob = await project("bob", "salon");
  await db.insert("ownerPasscodeConfig", { passcodeDigest: digest(PASSCODE) });
  return { alice, bob };
}

const message = (error) => error?.data ?? error?.message;
const refuses = async (promise, sentence) => {
  await assert.rejects(promise, (error) => {
    assert.equal(message(error), sentence);
    return true;
  });
};

test("the helpers: the demo is the one owner and checks nothing; accounts need a signed-in owner", async (t) => {
  {
    const w = world(t);
    const { alice, bob } = await seed(w);
    const { access } = w;
    const signedOut = w.ctxFor(null);
    assert.equal(access.accessEnforced(), false);
    assert.equal(await access.requireAccount(signedOut), access.SOLO_ACCOUNT);
    assert.equal(await access.currentAccount(signedOut), "solo-owner");
    assert.deepEqual(access.ownerActor(await access.requireAccount(signedOut)), { kind: "owner", identity: "solo-owner" });
    // The guards neither read nor refuse, even for an id that is not there.
    assert.equal(await access.guardApp(signedOut, "apps:999", "missing"), "solo-owner");
    assert.equal(await access.guardCase(signedOut, bob.caseId), "solo-owner");
    assert.equal(await access.guardRow(signedOut, "proposals", "proposals:999"), "solo-owner");
    assert.equal(await access.canSeeApp(signedOut, alice.appId), true);
    assert.equal(await access.canSeeCase(signedOut, "cases:999"), true);
    const asked = [];
    assert.equal(await access.guardAppInAction({ runQuery: async (...args) => asked.push(args) }, alice.appId), "solo-owner");
    assert.deepEqual(asked, [], "the demo's actions make no extra query");
    assert.equal((await access.visibleApps(signedOut)).length, 2);
  }
  {
    const w = world(t, { AUTH_REQUIRED: "true" });
    const { alice, bob } = await seed(w);
    const { access } = w;
    const signedOut = w.ctxFor(null);
    const asAlice = w.ctxFor("alice");
    assert.equal(access.accessEnforced(), true);
    await refuses(access.requireAccount(signedOut), SIGN_IN);
    assert.equal(await access.currentAccount(signedOut), null);
    assert.equal(await access.requireAccount(asAlice), "alice", "the account is the subject before the session");
    assert.equal(await access.guardApp(asAlice, alice.appId), "alice");
    assert.equal(await access.guardCase(asAlice, alice.caseId), "alice");
    assert.equal(await access.guardRow(asAlice, "proposals", alice.proposalId), "alice");
    assert.equal(await access.guardRow(asAlice, "ownerPreferences", alice.preferenceId), "alice");
    // Someone else's and missing read the same, in the function's own words.
    for (const id of [bob.appId, "apps:999", "not an id", undefined]) await refuses(access.guardApp(asAlice, id, "This project was not found."), "This project was not found.");
    for (const id of [bob.caseId, "cases:999"]) await refuses(access.guardCase(asAlice, id), NOT_AVAILABLE);
    for (const id of [bob.proposalId, "proposals:999"]) await refuses(access.guardRow(asAlice, "proposals", id, "Proposal not found."), "Proposal not found.");
    await refuses(access.guardApp(signedOut, alice.appId), SIGN_IN);
    assert.equal(await access.canSeeApp(asAlice, alice.appId), true);
    assert.equal(await access.canSeeApp(asAlice, bob.appId), false);
    assert.equal(await access.canSeeCase(asAlice, bob.caseId), false);
    assert.equal(await access.canSeeCase(signedOut, alice.caseId), false);
    assert.deepEqual((await access.visibleApps(asAlice)).map((app) => app._id), [alice.appId]);
    assert.deepEqual((await access.visibleCases(asAlice)).map((row) => row._id), [alice.caseId]);
    assert.deepEqual(await access.visibleApps(signedOut), []);
    // An action asks through internal.access.appGuard, which sees the same caller.
    await refuses(access.guardAppInAction(asAlice.actionCtx, bob.appId), NOT_AVAILABLE);
    assert.equal(await access.guardAppInAction(asAlice.actionCtx, alice.appId), "alice");
    assert.deepEqual(w.backend.runs, ["internal.access.appGuard", "internal.access.appGuard"]);
  }
});

test("lists return only the caller's projects and cases with accounts on, and everything in the demo", async (t) => {
  {
    const w = world(t, { AUTH_REQUIRED: "true" });
    const { alice } = await seed(w);
    const projects = await w.as("alice")("screens/projects", "list");
    assert.deepEqual(projects.map((p) => p.app._id), [alice.appId]);
    assert.deepEqual(projects[0].cases.map((row) => row._id), [alice.caseId]);
    assert.deepEqual((await w.as("alice")("cases", "list")).map((row) => row._id), [alice.caseId]);
    assert.deepEqual((await w.as("alice")("cases", "listWithSteps")).map((row) => row._id), [alice.caseId]);
    assert.deepEqual(await w.as("carol")("screens/projects", "list"), [], "an account with no projects sees none");
    assert.deepEqual(await w.as(null)("screens/projects", "list"), []);
    assert.deepEqual(await w.as(null)("cases", "list"), []);
  }
  {
    const w = world(t);
    const { alice, bob } = await seed(w);
    const projects = await w.as(null)("screens/projects", "list");
    assert.deepEqual(projects.map((p) => p.app._id), [alice.appId, bob.appId]);
    assert.deepEqual((await w.as(null)("cases", "list")).map((row) => row._id), [bob.caseId, alice.caseId]);
  }
});

test("another account's case, its customer reports and its fixes read as not found, and writes to it refuse", async (t) => {
  const w = world(t, { AUTH_REQUIRED: "true" });
  const { alice, bob } = await seed(w);
  const asAlice = w.as("alice");
  // Reads.
  assert.equal((await asAlice("cases", "get", { id: alice.caseId }))._id, alice.caseId);
  assert.equal(await asAlice("cases", "get", { id: bob.caseId }), null);
  assert.equal(await asAlice("cases", "cards", { id: bob.caseId }), null);
  assert.deepEqual((await asAlice("intake/records", "forCase", { caseId: alice.caseId })).reports.map((r) => r.text), ["alice's customer: I can't book."]);
  assert.equal(await asAlice("intake/records", "forCase", { caseId: bob.caseId }), null, "RC-32: a customer's report reaches only the app's owner");
  assert.deepEqual(await asAlice("intake/records", "forApp", { appId: bob.appId }), []);
  assert.equal((await asAlice("intake/records", "forApp", { appId: alice.appId })).length, 1);
  assert.equal(await asAlice("learning/preferences", "list", { projectId: bob.appId }), null);
  assert.deepEqual(await asAlice("notices", "forCase", { caseId: bob.caseId }), []);
  assert.deepEqual(await asAlice("voice/turn", "status", { caseId: bob.caseId }), { available: false, reason: "This case was not found.", maxClipMs: w.load("convex/voice/rules.ts").MAX_CLIP_MS });
  // Writes: the same refusal as for a case or row that does not exist.
  for (const proposalId of [bob.proposalId, "proposals:999"]) {
    await refuses(asAlice("decisions", "approve", { proposalId, version: 1, optionKey: "recover" }), "Proposal not found.");
    await refuses(asAlice("decisions", "decline", { proposalId, version: 1 }), "Proposal not found.");
  }
  for (const caseId of [bob.caseId, "cases:999"]) {
    assert.deepEqual(await asAlice("decisions", "stop", { caseId }), { stopped: false, reason: "This case no longer exists." });
  }
  for (const projectId of [bob.appId, "apps:999"]) {
    await refuses(asAlice("learning/preferences", "add", { projectId, statement: "Keep it up." }), "This project was not found.");
  }
  await refuses(asAlice("learning/preferences", "remove", { preferenceId: bob.preferenceId }), "This preference was already removed.");
  await refuses(asAlice("intake/keys", "issue", { appId: bob.appId }), "This app does not exist.");
  await refuses(asAlice("codeNetwork/ask", "ask", { scope: { kind: "project", projectId: bob.appId }, message: "What is this?" }), NOT_AVAILABLE);
  // Nothing of Bob's changed.
  assert.equal(w.backend.rows("proposals").find((p) => p._id === bob.proposalId).decisionStatus, "pending");
  assert.equal(w.backend.rows("ownerPreferences").length, 2);
  assert.equal(w.backend.rows("intakeKeys").length, 0);
  // Signed out: writes ask for sign-in, reads come back empty.
  await refuses(w.as(null)("decisions", "approve", { proposalId: alice.proposalId, version: 1, optionKey: "recover" }), SIGN_IN);
  await refuses(w.as(null)("onboarding/projects", "add", { repoUrl: "https://github.com/alice/next" }), SIGN_IN);
  assert.equal(await w.as(null)("cases", "get", { id: alice.caseId }), null);
});

test("with accounts on, an owner decision needs no passcode and records the account", async (t) => {
  const w = world(t, { AUTH_REQUIRED: "true" });
  const { alice } = await seed(w);
  const asAlice = w.as("alice");
  assert.deepEqual(await asAlice("ownerPasscode", "status"), { configured: false, accounts: true });
  await refuses(asAlice("ownerPasscode", "set", { passcode: "a-new-passcode" }), "This deployment protects owner decisions with your account, so there is no owner passcode to set.");
  // A passcode is configured from the demo days; it is neither asked for nor checked.
  const { actionId } = await asAlice("decisions", "approve", { proposalId: alice.proposalId, version: 1, optionKey: "recover" });
  const action = w.backend.rows("actions").find((row) => row._id === actionId);
  assert.deepEqual(action.actor, { kind: "owner", identity: "alice" });
  assert.equal(action.requestedBy, "owner");
  assert.deepEqual(w.backend.rows("proposals").find((p) => p._id === alice.proposalId).chosenBy, { kind: "owner", identity: "alice" });
  assert.deepEqual(w.calls.map(([name]) => name), ["recordDecision", "approveCase"]);
  // A new project is stamped with the account, and "already a project" means only among the caller's own.
  const { projectId } = await asAlice("onboarding/projects", "add", { repoUrl: "https://github.com/acme/web" });
  assert.equal(w.backend.rows("apps").find((app) => app._id === projectId).ownerId, "alice");
  await refuses(asAlice("onboarding/projects", "add", { repoUrl: "https://github.com/acme/web" }), "acme/web is already a project.");
  const { projectId: bobs } = await w.as("bob")("onboarding/projects", "add", { repoUrl: "https://github.com/acme/web" });
  assert.equal(w.backend.rows("apps").find((app) => app._id === bobs).ownerId, "bob");
  assert.equal(await asAlice("onboarding/projects", "forProject", { projectId: bobs }), null);
});

test("the demo is unchanged: one owner, every project, and the owner passcode as before", async (t) => {
  const w = world(t);
  const { alice, bob } = await seed(w);
  const anyone = w.as(null);
  assert.deepEqual(await anyone("ownerPasscode", "status"), { configured: true });
  await refuses(anyone("decisions", "approve", { proposalId: bob.proposalId, version: 1, optionKey: "recover" }), "That owner passcode is incorrect. Try again.");
  await refuses(anyone("decisions", "approve", { proposalId: bob.proposalId, version: 1, optionKey: "recover", passcode: "wrong-passcode" }), "That owner passcode is incorrect. Try again.");
  const { actionId } = await anyone("decisions", "approve", { proposalId: bob.proposalId, version: 1, optionKey: "recover", passcode: PASSCODE });
  assert.deepEqual(w.backend.rows("actions").find((row) => row._id === actionId).actor, { kind: "owner", identity: "solo-owner" });
  await anyone("decisions", "decline", { proposalId: alice.proposalId, version: 1, passcode: PASSCODE });
  assert.deepEqual(w.backend.rows("proposals").find((p) => p._id === alice.proposalId).chosenBy, { kind: "owner", identity: "solo-owner" });
  // The demo's own sentences for missing rows.
  await refuses(anyone("decisions", "approve", { proposalId: "proposals:999", version: 1, optionKey: "recover", passcode: PASSCODE }), "Proposal not found.");
  assert.deepEqual(await anyone("decisions", "stop", { caseId: "cases:999", passcode: PASSCODE }), { stopped: false, reason: "This case no longer exists." });
  // Every case and every customer report is the one owner's.
  assert.equal((await anyone("cases", "get", { id: bob.caseId }))._id, bob.caseId);
  assert.equal((await anyone("intake/records", "forCase", { caseId: bob.caseId })).people, 1);
  const { projectId } = await anyone("onboarding/projects", "add", { repoUrl: "https://github.com/acme/web", passcode: PASSCODE });
  assert.equal(w.backend.rows("apps").find((app) => app._id === projectId).ownerId, "solo-owner");
  // The demo's actions ask nothing extra, and still answer as before.
  assert.deepEqual(await anyone("codeNetwork/ask", "ask", { scope: { kind: "project", projectId: alice.appId }, message: "What is this?" }), { outcome: "not_configured", missing: ["CODE_NETWORK_CHAT_ENABLED", "SUPERMEMORY_API_KEY", "OPENAI_API_KEY"] });
  assert.deepEqual(w.backend.runs, []);
});

test("dev tools refuse with accounts on whatever DEV_TOOLS_ENABLED says, and open in the demo", async (t) => {
  {
    const w = world(t, { AUTH_REQUIRED: "true", DEV_TOOLS_ENABLED: "true" });
    await seed(w);
    await refuses(w.as("alice")("dev", "createSampleCases"), "Dev tools are disabled on this deployment.");
    await refuses(w.as("alice")("structural/dev", "clear", { appId: "apps:1" }), "Dev tools are disabled on this deployment.");
    await refuses(w.as("alice")("memory/dev", "prove"), "Development tools are disabled.");
    assert.deepEqual(await w.as("alice")("dev", "status"), { enabled: false, cases: [], live: [], booking: null });
    assert.equal(w.backend.rows("apps").length, 2);
  }
  {
    const w = world(t, { DEV_TOOLS_ENABLED: "true" });
    const ids = await w.as(null)("dev", "createSampleCases");
    assert.equal(ids.length, 3);
    const status = await w.as(null)("dev", "status");
    assert.equal(status.enabled, true);
    assert.deepEqual(status.cases.map((entry) => entry.case._id), ids);
  }
  {
    const w = world(t);
    await refuses(w.as(null)("dev", "createSampleCases"), "Dev tools are disabled on this deployment.");
  }
});

test("the booking demo's customer API: open in the demo, closed with accounts on unless the deployment hosts it", async (t) => {
  {
    const w = world(t);
    assert.ok((await w.as(null)("bookingDemo/booking", "getCatalog")).services.length > 0);
    assert.deepEqual(await w.as(null)("bookingDemo/booking", "getFlags"), { recommendationsEnabled: true });
  }
  {
    const w = world(t, { AUTH_REQUIRED: "true" });
    for (const name of ["getCatalog", "getFlags", "recommendations"]) await refuses(w.as("alice")("bookingDemo/booking", name), "The booking demo does not run on this deployment.");
    await refuses(w.as(null)("bookingDemo/booking", "submit", { serviceId: "s", date: "2026-11-16", time: "10:00" }), "The booking demo does not run on this deployment.");
  }
  {
    const w = world(t, { AUTH_REQUIRED: "true", PROTECTED_APP_CONTROL_SECRET_SHA256: digest("control-fixture") });
    assert.ok((await w.as(null)("bookingDemo/booking", "getCatalog")).services.length > 0);
  }
});

// Finding 8: variables that belong to the single-owner demo or to tests do damage if set on a production deployment
// by mistake. With accounts on, each reads as not set; the two stand-in addresses are honoured only on a local
// backend. One world per variable, with accounts on and that variable set, asserting nothing uses it.
const HOSTED = { AUTH_REQUIRED: "true", CONVEX_CLOUD_URL: "https://patient-otter-123.convex.cloud" };
const LOCAL = { AUTH_REQUIRED: "true", CONVEX_CLOUD_URL: "http://127.0.0.1:3210" };
const recordingFetch = (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (input) => (sent.push(String(input)), new Response(JSON.stringify({ data: [{ status: "ok", id: "r1" }] }), { status: 200 })));
  return sent;
};

test("GITHUB_TOKEN: with accounts on, no project reaches GitHub through the deployment's one token", async (t) => {
  {
    const w = world(t, { ...HOSTED, GITHUB_TOKEN: "ghp_the_demo_token" });
    const { alice } = await seed(w);
    const { repositoryAccess } = w.load("convex/github/access.ts");
    assert.equal(w.load("convex/prTracking/github.ts").githubToken(), undefined);
    assert.deepEqual(await repositoryAccess(w.ctxFor("alice").actionCtx, "alice/shop", { appId: alice.appId }), { ok: true, source: "deployment", token: undefined });
  }
  {
    const w = world(t, { GITHUB_TOKEN: "ghp_the_demo_token" });
    const { repositoryAccess } = w.load("convex/github/access.ts");
    assert.deepEqual(await repositoryAccess(w.ctxFor(null).actionCtx, "alice/shop", { account: "solo-owner" }), { ok: true, source: "deployment", token: "ghp_the_demo_token" }, "the demo keeps it");
  }
});

test("KEIKI_OWNER_CONTACT: with accounts on, no account's notice is texted to the deployment's one number", async (t) => {
  const keikiEnv = { KEIKI_API_KEY: "keiki-stand-in", KEIKI_AGENT_ID: "agent-1", KEIKI_OWNER_CONTACT: "+15550000000" };
  const sent = recordingFetch(t);
  const gate = { open: async () => ({ ok: true, fetch: async (input, init) => (sent.push(String(input) + " " + init.body), new Response(JSON.stringify({ results: [{ outcome: "ran" }] }))) }) };
  {
    const w = world(t, { ...HOSTED, ...keikiEnv });
    assert.deepEqual(await w.load("convex/keiki.ts").sendOwnerNotice(gate, "Alice's shop needs a decision."), { outcome: "not_configured" });
    assert.deepEqual(sent, [], "nothing was sent");
  }
  {
    const w = world(t, keikiEnv);
    assert.equal((await w.load("convex/keiki.ts").sendOwnerNotice(gate, "The shop needs a decision.")).outcome, "ran", "the demo keeps it");
    assert.equal(sent.length, 1);
  }
});

test("REVYL_BOOKING_WORKFLOW_ID: with accounts on, no account's verify step runs the demo's device workflow", async (t) => {
  const sent = recordingFetch(t);
  {
    const w = world(t, { ...HOSTED, REVYL_API_KEY: "revyl-stand-in", REVYL_BOOKING_WORKFLOW_ID: "wf-booking-demo" });
    const { alice } = await seed(w);
    assert.deepEqual(w.load("convex/revyl/api.ts").revylConfig(), { ok: false, missing: ["REVYL_BOOKING_WORKFLOW_ID"] });
    const stepId = w.backend.rows("steps").find((row) => row.caseId === alice.caseId)._id;
    const stepAttemptId = await w.backend.db.insert("stepAttempts", { stepId, caseId: alice.caseId, attempt: 1, status: "running" });
    const device = await w.load("convex/revyl/device.ts").checkBookingScreen(w.ctxFor(null).actionCtx, { caseId: alice.caseId, stepAttemptId });
    assert.equal(device.status, "uncovered");
    assert.deepEqual(sent, [], "Revyl was not asked");
    assert.deepEqual(w.backend.rows("revylRuns"), []);
  }
  {
    const w = world(t, { REVYL_API_KEY: "revyl-stand-in", REVYL_BOOKING_WORKFLOW_ID: "wf-booking-demo" });
    assert.equal(w.load("convex/revyl/api.ts").revylConfig().config.workflowId, "wf-booking-demo", "the demo keeps it");
  }
});

test("EXPO_PUSH_API_URL: with accounts on, phones' tokens go to Expo unless this backend is a local one", async (t) => {
  const sent = recordingFetch(t);
  const message = [{ to: "ExponentPushToken[a]", title: "Shop", body: "A case needs your decision.", data: { caseId: "cases:1" }, sound: "default", priority: "high" }];
  {
    const w = world(t, { ...HOSTED, EXPO_PUSH_API_URL: "https://stand-in.example/push" });
    await w.load("convex/push/expo.ts").sendToExpo(message);
    assert.deepEqual(sent.map((url) => new URL(url).host), ["exp.host"], "the stand-in address is ignored on a hosted backend");
  }
  for (const env of [{ ...LOCAL }, {}]) {
    const w = world(t, { ...env, EXPO_PUSH_API_URL: "http://127.0.0.1:8213/push" });
    assert.equal(w.load("convex/push/expo.ts").expoPushApiUrl(), "http://127.0.0.1:8213/push", "a local backend and the demo keep it");
  }
});

test("AUTH_STAND_IN_URL: with accounts on, sign-in trusts no stand-in server unless this backend is a local one", async (t) => {
  const reset = { AUTH_RESEND_KEY: "re_stand_in", AUTH_EMAIL_FROM: "turtl <no-reply@example.com>", AUTH_STAND_IN_URL: "https://stand-in.example" };
  {
    const w = world(t, { ...HOSTED, ...reset });
    const settings = w.load("convex/auth/settings.ts");
    assert.equal(settings.standInUrl(), undefined);
    assert.equal(settings.appleKeysUrl(), "https://appleid.apple.com/auth/keys", "Apple's own keys decide an Apple sign-in");
    assert.equal(settings.resetEmail().endpoint, "https://api.resend.com/emails");
    assert.equal((await settings.check.handler({}, {})).standIn, false);
  }
  {
    const w = world(t, { ...HOSTED, CONVEX_CLOUD_URL: "not a url", ...reset });
    assert.equal(w.load("convex/auth/settings.ts").standInUrl(), undefined, "an address that cannot be read is not local");
  }
  for (const env of [{ ...LOCAL }, {}]) {
    const w = world(t, { ...env, ...reset });
    assert.equal(w.load("convex/auth/settings.ts").appleKeysUrl(), "https://stand-in.example/apple/auth/keys", "a local backend and the demo keep it");
  }
});

// Finding 5: customer reports open at most so many new cases on a project a day; past it a report is kept on no case
// and says why. Each project has its own count, and the demo is unchanged.
test("customer reports open at most INTAKE_CASES_PER_DAY new cases on a project a day", async (t) => {
  const report = async (w, appId, n) => {
    const reportId = await w.backend.db.insert("reports", { appId, channel: "form", fromRef: `form:device:person-${n}`, text: `Problem number ${n} with paying`, provider: "turtl-form", providerEventId: `event-${appId}-${n}`, receivedAt: n });
    return await w.backend.db.insert("reportTriage", { reportId, appId, fingerprint: `problem ${n}`, status: "pending" });
  };
  const land = (w, triageId) => w.as(null)("intake/records", "land", { triageId, verdict: "bug", source: "rules", reason: "Rule-based triage.", open: { title: "Paying fails", impact: "A customer cannot pay." } });
  {
    const w = world(t, { AUTH_REQUIRED: "true", INTAKE_CASES_PER_DAY: "2" });
    const { alice, bob } = await seed(w);
    const outcomes = [];
    for (let n = 1; n <= 3; n++) outcomes.push((await land(w, await report(w, alice.appId, n))).outcome);
    assert.deepEqual(outcomes, ["opened", "opened", "ignored"]);
    const third = w.backend.rows("reportTriage").filter((row) => row.appId === alice.appId).at(-1);
    assert.match(third.reason, /^Rule-based triage\. Kept, but no case was opened: customer reports have already opened 2 cases on this project today/);
    assert.equal(third.caseId, undefined);
    assert.equal((await land(w, await report(w, bob.appId, 4))).outcome, "opened", "Bob's project has its own count");
    assert.equal(w.calls.filter(([name]) => name === "startCaseRun").length, 3);
  }
  {
    const w = world(t, { INTAKE_CASES_PER_DAY: "2" });
    const { alice } = await seed(w);
    for (let n = 1; n <= 3; n++) assert.equal((await land(w, await report(w, alice.appId, n))).outcome, "opened", "the demo has no cap");
  }
});

// Finding 7: each project and each intake key brings its own limits, so an account has at most so many of each.
test("an account past its project cap, or a project past its key cap, is refused in plain words", async (t) => {
  {
    const w = world(t, { AUTH_REQUIRED: "true", PROJECTS_PER_ACCOUNT: "2", INTAKE_KEYS_PER_PROJECT: "2" });
    const { alice, bob } = await seed(w);
    const asAlice = w.as("alice");
    await asAlice("onboarding/projects", "add", { repoUrl: "https://github.com/acme/web" });
    await refuses(asAlice("onboarding/projects", "add", { repoUrl: "https://github.com/acme/api" }), "This account already has 2 projects, the most one account can have. Contact support if you need more.");
    assert.equal(w.backend.rows("apps").filter((app) => app.ownerId === "alice").length, 2);
    assert.ok((await w.as("bob")("onboarding/projects", "add", { repoUrl: "https://github.com/acme/api" })).projectId, "the cap is each account's own");
    const first = (await asAlice("intake/keys", "issue", { appId: alice.appId })).key;
    await asAlice("intake/keys", "issue", { appId: alice.appId });
    await refuses(asAlice("intake/keys", "issue", { appId: alice.appId }), "This project already has 2 report keys in use, the most one project can have. Stop one from taking reports before making another.");
    await asAlice("intake/keys", "revoke", { key: first });
    assert.match((await asAlice("intake/keys", "issue", { appId: alice.appId })).key, /^tik_/, "a stopped key makes room");
    assert.match((await w.as("bob")("intake/keys", "issue", { appId: bob.appId })).key, /^tik_/);
  }
  {
    const w = world(t, { PROJECTS_PER_ACCOUNT: "1", INTAKE_KEYS_PER_PROJECT: "1" });
    const { alice } = await seed(w);
    await w.as(null)("onboarding/projects", "add", { repoUrl: "https://github.com/acme/web", passcode: PASSCODE });
    for (let n = 0; n < 2; n++) await w.as(null)("intake/keys", "issue", { appId: alice.appId, passcode: PASSCODE });
    assert.equal(w.backend.rows("intakeKeys").length, 2, "the demo has no caps");
  }
});

// Finding 9: a project that names another account's repository does not learn the size of that account's code map.
test("an overview counts only a code map of the caller's own projects with accounts on", async (t) => {
  const network = (projectId) => ({
    projectId, repo: "alice/shop", ref: "main", namespace: "code_" + projectId, source: "built", generatedAt: 1,
    clusters: [{ id: "c1", name: "Checkout", summary: "s" }, { id: "c2", name: "Admin", summary: "s" }],
    nodes: ["pay", "cart", "admin"].map((id) => ({ id, clusterId: "c1", label: id, kind: "module", summary: "s" })),
    edges: [],
  });
  {
    const w = world(t, { AUTH_REQUIRED: "true" });
    const { alice } = await seed(w);
    const { db } = w.backend;
    await db.insert("codeNetworks", network(alice.appId));
    const bobs = await db.insert("apps", { name: "copycat", ownerId: "bob", repoUrl: "https://github.com/alice/shop" });
    const alices = await db.insert("apps", { name: "shop-staging", ownerId: "alice", repoUrl: "https://github.com/alice/shop" });
    assert.deepEqual((await w.as("alice")("screens/overview", "forProject", { projectId: alice.appId })).map, { parts: 3, groups: 2 });
    assert.equal((await w.as("bob")("screens/overview", "forProject", { projectId: bobs })).map, null, "Bob's project names Alice's repository and sees no map");
    assert.deepEqual((await w.as("alice")("screens/overview", "forProject", { projectId: alices })).map, { parts: 3, groups: 2 }, "Alice's other project may use her own map");
  }
  {
    const w = world(t);
    const { alice } = await seed(w);
    await w.backend.db.insert("codeNetworks", network(alice.appId));
    const other = await w.backend.db.insert("apps", { name: "copycat", ownerId: "solo-owner", repoUrl: "https://github.com/alice/shop" });
    assert.deepEqual((await w.as(null)("screens/overview", "forProject", { projectId: other })).map, { parts: 3, groups: 2 }, "the demo is unchanged");
  }
});

// Finding 4: Stop cancels the jobs kept on the case's own attempts, by id, and never reads the whole table of
// scheduled jobs, which every account's work grows until such a read fails for everyone.
test("Stop cancels the case's own scheduled jobs by id and reads no one else's", async (t) => {
  const w = world(t, { AUTH_REQUIRED: "true" });
  const { alice, bob } = await seed(w);
  const { db } = w.backend;
  const scheduler = w.ctxFor("alice").scheduler;
  const running = async (caseId, proposalId) => {
    const stepId = await db.insert("steps", { caseId, key: "execute", title: "Execute", dependsOn: ["plan"], kind: "approval", purpose: "authorize_and_execute", status: "running" });
    const jobs = [
      await scheduler.runAfter(0, { path: "internal.runner.run.execute" }, { attemptId: "pending" }),
      await scheduler.runAfter(60_000, { path: "internal.runner.run.checkTimeout" }, { attemptId: "pending", limitMs: 60_000 }),
    ];
    const attemptId = await db.insert("stepAttempts", { stepId, caseId, attempt: 1, status: "running", startedAt: 1, scheduledJobs: jobs });
    await db.patch(stepId, { currentAttemptId: attemptId });
    await db.patch(caseId, { status: "executing" });
    await db.insert("actions", {
      caseId, proposalId, approvedProposalVersion: 1, optionKey: "recover", type: "set_feature_flag", requestedBy: "owner",
      actor: { kind: "owner", identity: "x" }, environment: "production", revision: { app: "r1" },
      executionPayload: { actionCatalogId: "actionCatalog:1", type: "set_feature_flag", target: { environment: "production", resourceRef: "flags#x" }, parameters: [], config: { kind: "http", url: "https://x.test/flags", method: "POST" }, acceptanceCriteria: [], checkRefs: [] },
      status: "pending", idempotencyKey: `${proposalId}:v1:recover`, requestedAt: 1,
    });
    return jobs;
  };
  const alicesJobs = await running(alice.caseId, alice.proposalId);
  const bobsJobs = await running(bob.caseId, bob.proposalId);
  const stopped = await w.as("alice")("decisions", "stop", { caseId: alice.caseId });
  assert.equal(stopped.stopped, true);
  const state = (id) => w.backend.scheduled.find((job) => job.id === id).job.state.kind;
  assert.deepEqual(alicesJobs.map(state), ["canceled", "canceled"], "the run and its time limit are cancelled");
  assert.deepEqual(bobsJobs.map(state), ["pending", "pending"], "nobody else's job is touched");
  assert.deepEqual(w.backend.systemReads, [], "no read of the whole _scheduled_functions table");
});
