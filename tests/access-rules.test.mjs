import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  "AUTH_REQUIRED", "DEV_TOOLS_ENABLED", "PROTECTED_APP_CONTROL_SECRET_SHA256", "PROTECTED_APP_URL", "PROTECTED_APP_CONTROL_SECRET", "CODE_NETWORK_CHAT_ENABLED", "OPENAI_API_KEY", "SUPERMEMORY_API_KEY",
  // Demo-only and stand-in variables (finding 8), what they need beside them, and the deployment's own address.
  "GITHUB_TOKEN", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_SLUG", "GITHUB_APP_WEBHOOK_SECRET", "AUTH_STAND_IN_URL", "AUTH_RESEND_KEY", "AUTH_EMAIL_FROM",
  "KEIKI_API_KEY", "KEIKI_AGENT_ID", "KEIKI_OWNER_CONTACT", "EXPO_PUSH_API_URL", "REVYL_API_KEY", "REVYL_BOOKING_WORKFLOW_ID", "CONVEX_CLOUD_URL", "CONVEX_SITE_URL", "CUSTOM_AUTH_SITE_URL",
  // Limits (findings 5 and 7).
  "INTAKE_CASES_PER_DAY", "INTAKE_SPEND_PER_DAY_USD", "PROJECTS_PER_ACCOUNT", "INTAKE_KEYS_PER_PROJECT",
];
const PASSCODE = "local-fixture-passcode";
const SIGN_IN = "Sign in to continue.";
const NOT_AVAILABLE = "That project is not available on this account.";

const ref = (path) => new Proxy({ path }, { get: (target, key) => (key === "path" ? target.path : ref(path + "." + String(key))) });
const registered = (kind, visibility = "public") => (definition) => ({ kind, visibility, ...definition });
const generated = {
  "convex/_generated/api": { api: ref("api"), internal: ref("internal"), components: ref("components") },
  "convex/_generated/server": {
    query: registered("query"),
    mutation: registered("mutation"),
    action: registered("action"),
    internalQuery: registered("query", "internal"),
    internalMutation: registered("mutation", "internal"),
    internalAction: registered("action", "internal"),
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
      // A folder's module is its index.ts (convex/runner/handlers).
      return load(resolve(root, existsSync(resolve(root, key + ".ts")) ? key + ".ts" : key + "/index.ts"));
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
// `real` names stand-ins to leave out, so those modules load as they are.
function world(t, env = {}, { real = [] } = {}) {
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
  const mocks = standIns(calls);
  for (const name of real) delete mocks[name];
  const load = createLoader(mocks);
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
// In the single-owner demo every project is the one owner's: a project another account owns would mean the deployment
// holds accounts, and then the demo serves nothing (convex/access.ts, demoHoldsAccounts).
async function seed({ backend, access }) {
  const { db } = backend;
  const project = async (owner, name) => {
    const appId = await db.insert("apps", { name, ownerId: access.accessEnforced() ? owner : access.SOLO_ACCOUNT, repoUrl: `https://github.com/${owner}/${name}`, productionUrl: `https://${owner}.test` });
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
  // The demo's actions still answer as before. The one thing they ask first is that the deployment holds no account
  // (convex/functions.ts, review finding 13).
  assert.deepEqual(await anyone("codeNetwork/ask", "ask", { scope: { kind: "project", projectId: alice.appId }, message: "What is this?" }), { outcome: "not_configured", missing: ["CODE_NETWORK_CHAT_ENABLED", "SUPERMEMORY_API_KEY", "OPENAI_API_KEY"] });
  assert.deepEqual(w.backend.runs, ["internal.access.demoOpen"]);
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

// Review, "Worth a second look": REVYL_BASE_URL and KEIKI_BASE_URL moved the operator's own keys to whatever host they
// named, on any deployment. They are stand-in addresses now, like EXPO_PUSH_API_URL above.
test("ATTACK (review): REVYL_BASE_URL and KEIKI_BASE_URL: with accounts on, the operator's keys go to Revyl and Keiki unless this backend is a local one", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (input, init) => (sent.push({ host: new URL(String(input)).host, key: init?.headers?.Authorization }), new Response(JSON.stringify({ task_id: "task-1" }), { status: 200 })));
  const revyl = { REVYL_API_KEY: "operator-revyl-key", REVYL_BASE_URL: "https://stand-in.example" };
  {
    const w = world(t, { ...HOSTED, ...revyl });
    // An account's verify step names its own workflow; the key is the operator's.
    const started = await w.load("convex/revyl/runs.ts").startRun(w.ctxFor(null).actionCtx, { phase: "after", workflowId: "wf-account" });
    assert.equal(started.outcome, "started");
    assert.deepEqual(sent, [{ host: "backend.revyl.ai", key: "Bearer operator-revyl-key" }], "the key went to Revyl, not to the address the variable names");
  }
  for (const env of [{ ...LOCAL }, {}]) {
    const w = world(t, { ...env, ...revyl, REVYL_BASE_URL: "http://127.0.0.1:8215" });
    assert.equal(w.load("convex/revyl/api.ts").revylConfig({ workflowId: "wf" }).config.baseUrl, "http://127.0.0.1:8215", "a local backend and the demo keep it");
  }

  const keikiSent = [];
  const gate = { open: async () => ({ ok: true, fetch: async (input) => (keikiSent.push(new URL(String(input)).host), new Response(JSON.stringify({ results: [{ outcome: "ran" }] }))) }) };
  const keiki = { KEIKI_API_KEY: "operator-keiki-key", KEIKI_AGENT_ID: "agent-1", KEIKI_OWNER_CONTACT: "+15550000000", KEIKI_BASE_URL: "http://127.0.0.1:8216" };
  {
    const w = world(t, keiki);
    assert.equal((await w.load("convex/keiki.ts").sendOwnerNotice(gate, "The shop needs a decision.")).outcome, "ran");
    assert.deepEqual(keikiSent, ["127.0.0.1:8216"], "the demo keeps its stand-in");
  }
  {
    // With accounts on Keiki texts nobody today (KEIKI_OWNER_CONTACT is the demo's), and its address is Keiki's own.
    const w = world(t, { ...HOSTED, ...keiki, KEIKI_BASE_URL: "https://stand-in.example" });
    assert.deepEqual(await w.load("convex/keiki.ts").sendOwnerNotice(gate, "Alice's shop needs a decision."), { outcome: "not_configured" });
    assert.deepEqual(keikiSent, ["127.0.0.1:8216"], "nothing more was sent");
  }
});

test("AUTH_STAND_IN_URL: with accounts on, sign-in trusts no stand-in server unless this backend is a local one", async (t) => {
  const reset = { AUTH_RESEND_KEY: "re_stand_in", AUTH_EMAIL_FROM: "turtl <no-reply@example.com>", AUTH_STAND_IN_URL: "https://stand-in.example" };
  {
    const w = world(t, { ...HOSTED, ...reset });
    const settings = w.load("convex/auth/settings.ts");
    assert.equal(settings.standInUrl(), undefined);
    assert.equal(settings.appleKeysUrl(), "https://appleid.apple.com/auth/keys", "Apple's own keys decide an Apple sign-in");
    assert.equal(settings.emailService().endpoint, "https://api.resend.com/emails");
    assert.equal((await settings.check.handler({}, {})).standIn, false);
  }
  {
    const w = world(t, { ...HOSTED, CONVEX_CLOUD_URL: "not a url", ...reset });
    assert.equal(w.load("convex/auth/settings.ts").standInUrl(), undefined, "an address that cannot be read is not local");
  }
  // Review, "Worth a second look": a self-hosted backend left on its default address reads as local. With accounts on
  // it is still not pointed at another server: a stand-in counts only when it is on this machine too.
  {
    const w = world(t, { ...LOCAL, ...reset });
    assert.equal(w.load("convex/auth/settings.ts").standInUrl(), undefined, "a local backend ignores a stand-in on another host");
    assert.equal(w.load("convex/auth/settings.ts").appleKeysUrl(), "https://appleid.apple.com/auth/keys");
  }
  {
    const w = world(t, { ...LOCAL, ...reset, AUTH_STAND_IN_URL: "http://127.0.0.1:8202" });
    assert.equal(w.load("convex/auth/settings.ts").appleKeysUrl(), "http://127.0.0.1:8202/apple/auth/keys", "a local backend keeps a stand-in on this machine");
  }
  {
    const w = world(t, reset);
    assert.equal(w.load("convex/auth/settings.ts").appleKeysUrl(), "https://stand-in.example/apple/auth/keys", "the demo keeps it");
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

// ---- Review finding 13: AUTH_REQUIRED fails closed ----

const UNAVAILABLE = "turtl is unavailable right now. Please try again later.";

// Any value but unset, empty or "false" meant to turn accounts on, so it does: a signed-out stranger sees nothing.
for (const value of ["TRUE", "True", "1", "yes", " true", "true "]) {
  test(`ATTACK (finding 13): AUTH_REQUIRED=${JSON.stringify(value)} is accounts mode, so a signed-out stranger lists no account's projects or cases`, async (t) => {
    const w = world(t, { AUTH_REQUIRED: value });
    const { alice } = await seed(w);
    // A production deployment has no owner passcode.
    for (const row of w.backend.rows("ownerPasscodeConfig")) await w.backend.db.delete(row._id);
    assert.equal(w.access.accessEnforced(), true);
    const stranger = w.as(null);
    assert.deepEqual(await stranger("screens/projects", "list"), []);
    assert.deepEqual(await stranger("cases", "list"), []);
    await refuses(stranger("decisions", "approve", { proposalId: alice.proposalId, version: 1, optionKey: "recover" }), SIGN_IN);
    assert.deepEqual((await w.as("alice")("screens/projects", "list")).map((p) => p.app._id), [alice.appId], "alice sees her own project only");
  });
}

test("AUTH_REQUIRED unset, empty, or exactly \"false\" is the single-owner demo; anything else is accounts", (t) => {
  for (const env of [{}, { AUTH_REQUIRED: "" }, { AUTH_REQUIRED: "false" }]) assert.equal(world(t, env).access.accessEnforced(), false, JSON.stringify(env));
  for (const value of ["true", "TRUE", "1", "yes", " true", "true ", "False", "0", "no", "off", "ture"]) assert.equal(world(t, { AUTH_REQUIRED: value }).access.accessEnforced(), true, value);
});

// Every public function in convex/, found by the plain pattern tests/access-coverage.test.mjs checks its scan against.
function publicFunctionsByFile() {
  const files = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "_generated" ? [] : files(path);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
    });
  return files(resolve(root, "convex")).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/^export const (\w+) = (query|mutation|action)\(/gm)].map(([, name]) => ({ module: file.slice(root.length + 1 + "convex/".length, -3), name })),
  );
}

const snapshot = (w) => JSON.stringify(Object.keys(w.load("convex/schema.ts").default.tables).map((table) => w.backend.rows(table)));

async function accountsHeld(w) {
  const userId = await w.backend.db.insert("users", { email: "alice@example.com" });
  await w.backend.db.insert("authAccounts", { userId, provider: "password", providerAccountId: "alice@example.com" });
}

// The variable going missing (or emptied, or set to "false") on a deployment that has served accounts must not open
// it: the demo refuses to serve when the deployment holds any account.
test("ATTACK (finding 13): with AUTH_REQUIRED unset on a deployment that holds an account, a stranger is refused, and the log says why once", async (t) => {
  for (const env of [{}, { AUTH_REQUIRED: "" }, { AUTH_REQUIRED: "false" }]) {
    const w = world(t, env);
    const { alice } = await seed(w);
    await accountsHeld(w);
    const logged = t.mock.method(console, "error", () => {});
    const stranger = w.as(null);
    await refuses(stranger("screens/projects", "list"), UNAVAILABLE);
    await refuses(stranger("cases", "list"), UNAVAILABLE);
    await refuses(stranger("decisions", "approve", { proposalId: alice.proposalId, version: 1, optionKey: "recover", passcode: PASSCODE }), UNAVAILABLE);
    await refuses(stranger("users", "account"), UNAVAILABLE);
    // A refused call saves nothing, so the monitor's cron writes the one line (review finding 20): once, not a minute.
    assert.equal(logged.mock.callCount(), 0);
    const tick = w.load("convex/monitor.ts").tick;
    for (let minute = 0; minute < 3; minute++) await tick.handler(w.ctxFor(null).actionCtx, {});
    assert.equal(logged.mock.callCount(), 1);
    assert.match(String(logged.mock.calls[0].arguments[0]), /AUTH_REQUIRED is unset, empty or "false", which makes this deployment the single-owner demo, but it holds accounts/);
    logged.mock.restore();
  }
});

// ---- Review finding 20: nothing runs in the demo's terms on a deployment that holds accounts ----

const APP_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const CLOSED_DEMO_SKIPPED = "This deployment holds accounts but runs as the single-owner demo, so the monitor checked nothing (the backend log says why).";

// "Holds accounts", each way it can: a sign-in, a user, or a project another account owns (one left mid-deletion,
// or after the sign-in tables were wiped or restored from an older copy).
const HELD = {
  "a sign-in": async (w) => accountsHeld(w),
  "a user and nothing else": async (w) => void (await w.backend.db.insert("users", { email: "left@example.com" })),
  "a project another account owns, with no sign-in or user left": async (w) => void (await w.backend.db.insert("apps", { name: "left", ownerId: "jx7dkqxmalice", productionUrl: "https://left.test" })),
  "a project whose owner sorts after the demo's": async (w) => void (await w.backend.db.insert("apps", { name: "later", ownerId: "zz9owner", productionUrl: "https://later.test" })),
};

for (const [how, hold] of Object.entries(HELD)) {
  test(`ATTACK (finding 20): with AUTH_REQUIRED unset and ${how}, the monitor opens no case and sends nothing, intake keeps nothing, and the gate refuses`, async (t) => {
    // The booking demo's address and secret, and turtl's GitHub App, as a deployment that served accounts would have.
    const w = world(t, { PROTECTED_APP_URL: "https://booking.test/booking-demo", PROTECTED_APP_CONTROL_SECRET: "deployment-secret", GITHUB_APP_ID: "4242", GITHUB_APP_PRIVATE_KEY: APP_KEY });
    const { alice } = await seed(w);
    await hold(w);
    t.mock.method(console, "error", () => {});
    const sent = recordingFetch(t);
    const ctx = w.ctxFor(null);
    const access = w.access;
    assert.equal(await access.demoHoldsAccounts(ctx), true);
    // The monitor's cron: every account's journeys, at any address, would be checked with the deployment's secret.
    await w.backend.db.insert("journeys", { appId: alice.appId, name: "Book", description: "Book.", checkVersion: "v1", check: { kind: "http", config: { url: "https://alice.test/journey-check", method: "POST", expectedStatus: 200, credentialRef: "PROTECTED_APP_CONTROL_SECRET" } } });
    const cases = w.backend.rows("cases").length;
    assert.deepEqual(await w.load("convex/monitor.ts").tick.handler(ctx.actionCtx, {}), { skipped: CLOSED_DEMO_SKIPPED });
    assert.deepEqual(sent, [], "no request left");
    assert.equal(w.backend.rows("cases").length, cases, "no case opened");
    // A customer report with a project's key.
    await w.backend.db.insert("intakeKeys", { appId: alice.appId, key: "alice-key", createdAt: 1 });
    const reports = w.backend.rows("reports").length;
    const received = await w.load("convex/intake/records.ts").receive.handler(ctx, { key: "alice-key", text: "I can't book." });
    assert.deepEqual(received, { ok: false, status: 503, code: "UNAVAILABLE", message: UNAVAILABLE });
    assert.equal(w.backend.rows("reports").length, reports, "the report was not kept");
    // The consent gate, for every outbound call an action makes.
    const gate = w.load("convex/consent/gate.ts").gateFor(ctx.actionCtx, { appId: alice.appId });
    for (const service of ["openai", "supermemory", "capy", "keiki"]) assert.deepEqual(await gate.open(service), { ok: false, reason: UNAVAILABLE }, service);
    assert.equal(await gate.blocked("supermemory", "erase"), UNAVAILABLE);
    // GitHub credentials, requests to an owner's app, and push delivery.
    assert.deepEqual(await w.load("convex/github/access.ts").repositoryAccess(ctx.actionCtx, "alice/shop", { appId: alice.appId }), { ok: false, reason: "github_error", message: UNAVAILABLE });
    const app = await w.load("convex/protectedApp/watched.ts").watchedApp(ctx.actionCtx, { appId: alice.appId });
    assert.equal(app.refuse("https://alice.test/journey-check"), "turtl is unavailable right now, so it sent nothing");
    assert.equal(await w.load("convex/push/deliver.ts").recipients.handler(ctx, { caseId: alice.caseId }), null);
    assert.deepEqual(sent, []);
  });
}

test("ATTACK (finding 20): with AUTH_REQUIRED unset and an account present, the runner starts no step and runs none already dispatched", async (t) => {
  const w = world(t, {}, { real: ["convex/runner/run"] });
  const { alice } = await seed(w);
  const stepId = await w.backend.db.insert("steps", { caseId: alice.caseId, key: "investigate", title: "Investigate", dependsOn: [], kind: "agent", purpose: "investigate", status: "pending" });
  const attemptId = await w.backend.db.insert("stepAttempts", { stepId, caseId: alice.caseId, attempt: 1, status: "running", startedAt: 1 });
  await w.backend.db.patch(stepId, { currentAttemptId: attemptId });
  await accountsHeld(w);
  const run = w.load("convex/runner/run.ts");
  const ctx = w.ctxFor(null);
  const attempts = w.backend.rows("stepAttempts").length;
  await run.advance.handler(ctx, { caseId: alice.caseId });
  assert.equal(w.backend.rows("stepAttempts").length, attempts, "no attempt started");
  assert.deepEqual(w.backend.scheduled, [], "nothing dispatched");
  assert.equal(await run.loadInput.handler(ctx, { attemptId }), null, "an attempt dispatched earlier does not run");
});

// ---- turtl's own addresses as a live app (third review, "worth a second look") ----

const OWN = { AUTH_REQUIRED: "true", CONVEX_SITE_URL: "https://patient-otter-123.convex.site", CONVEX_CLOUD_URL: "https://patient-otter-123.convex.cloud" };

test("ATTACK (review): a project cannot give turtl's own site or API as its live app, and no request for one goes there", async (t) => {
  const w = world(t, OWN);
  const { alice } = await seed(w);
  const asAlice = w.as("alice");
  const own = "The live app address must be your app's own address, not turtl's.";
  // The same addresses spelled another way are still turtl's own: a trailing dot, or capitals (finding 25).
  const spelled = ["https://patient-otter-123.convex.site.", "https://patient-otter-123.convex.cloud./api/mutation", "https://PATIENT-OTTER-123.convex.site/booking-demo", "https://Patient-Otter-123.Convex.Site./practice/x"];
  for (const liveUrl of [OWN.CONVEX_SITE_URL, `${OWN.CONVEX_SITE_URL}/booking-demo`, `${OWN.CONVEX_SITE_URL}/practice/${alice.appId}`, `${OWN.CONVEX_SITE_URL}/intake/report?key=x`, OWN.CONVEX_CLOUD_URL, ...spelled]) {
    await refuses(asAlice("onboarding/projects", "add", { repoUrl: "https://github.com/alice/other", liveUrl }), own);
  }
  // On another port or over http the host is still turtl's, and the port and https rules refuse it.
  await refuses(asAlice("onboarding/projects", "add", { repoUrl: "https://github.com/alice/other", liveUrl: "https://patient-otter-123.convex.site:8443/" }), "The live app address must be the one your customers use, with no port number, like https://app.example.com.");
  await refuses(asAlice("onboarding/projects", "add", { repoUrl: "https://github.com/alice/other", liveUrl: "http://patient-otter-123.convex.site/" }), "The live app address must start with https://, so what turtl sends your app is always encrypted.");
  assert.ok(!w.backend.rows("apps").some((app) => app.productionUrl?.includes("convex")), "nothing was registered");

  // A project row that names turtl's site anyway (written before this rule): the monitor's plan skips it, and a request
  // its turtl.json could name, to any of turtl's own routes, never leaves.
  const sent = recordingFetch(t);
  const owner = await w.backend.db.insert("users", { email: "alice@example.com" });
  await w.backend.db.patch(alice.appId, { productionUrl: OWN.CONVEX_SITE_URL, ownerId: owner });
  await w.backend.db.insert("journeys", { appId: alice.appId, name: "Book", description: "Book.", checkVersion: "v1", check: { kind: "http", config: { url: `${OWN.CONVEX_SITE_URL}/journey-check`, method: "POST", expectedStatus: 200 } } });
  const plan = await w.load("convex/protectedApp/watching.ts").planFor(w.ctxFor(null), w.backend.rows("apps").find((app) => app._id === alice.appId));
  // unanswered: no check of it has tries with no answer on record (convex/protectedApp/notAnswering.ts).
  assert.deepEqual(plan, { kind: "skip", reason: own, unanswered: false });
  const ctx = w.ctxFor(owner).actionCtx;
  const app = await w.load("convex/protectedApp/watched.ts").watchedApp(ctx, { appId: alice.appId });
  const client = w.load("convex/protectedApp/client.ts");
  for (const path of ["/booking-demo/flags", "/intake/report", "/github/callback?state=x&code=y", "/practice/other/journey-check"]) {
    assert.equal((await client.call(OWN.CONVEX_SITE_URL + path, { app, method: "POST" })).kind, "not_sent", path);
  }
  for (const path of ["/api/query", "/api/mutation"]) assert.equal((await client.call(OWN.CONVEX_CLOUD_URL + path, { app, method: "POST" })).kind, "not_sent", path);
  for (const url of ["https://patient-otter-123.convex.site./booking-demo/flags", "https://patient-otter-123.convex.cloud./api/mutation"]) assert.equal((await client.call(url, { app, method: "POST" })).kind, "not_sent", url);
  assert.deepEqual(sent, [], "no request left");
});

test("a practice project keeps its checks: turtl's own site under its own path, and nowhere else there", async (t) => {
  const w = world(t, OWN);
  const { alice } = await seed(w);
  const owner = await w.backend.db.insert("users", { email: "alice@example.com" });
  await w.backend.db.patch(alice.appId, { productionUrl: `${OWN.CONVEX_SITE_URL}/practice/${alice.appId}`, practice: true, ownerId: owner });
  const row = w.backend.rows("apps").find((candidate) => candidate._id === alice.appId);
  await w.backend.db.insert("journeys", { appId: alice.appId, name: "Book", description: "Book.", checkVersion: "v1", check: { kind: "http", config: { url: `${row.productionUrl}/journey-check`, method: "POST", expectedStatus: 200 } } });
  const plan = await w.load("convex/protectedApp/watching.ts").planFor(w.ctxFor(null), row);
  assert.equal(plan.kind, "run", JSON.stringify(plan));
  assert.equal(plan.base, row.productionUrl);
  const app = await w.load("convex/protectedApp/watched.ts").watchedApp(w.ctxFor(owner).actionCtx, { appId: alice.appId });
  assert.equal(app.refuse(`${row.productionUrl}/journey-check`), null, "its own path");
  assert.equal(app.refuse(`${row.productionUrl}/flags?x=1`), null);
  for (const path of [`/practice/${alice.appId}/../../intake/report`, `/practice/${alice.appId}%2f..%2f..%2fbooking-demo/flags`, "/practice/another-project/journey-check", "/booking-demo/flags", "/github/webhook"]) {
    const refused = app.refuse(OWN.CONVEX_SITE_URL + path);
    assert.ok(refused === "turtl does not send a project's requests to turtl's own addresses, so it sent nothing" || /only to its own address/.test(refused ?? ""), path + ": " + refused);
  }
  assert.ok(app.refuse(`${OWN.CONVEX_CLOUD_URL}/api/mutation`));
  // A project that is not a practice project may not use a practice path either.
  await w.backend.db.patch(alice.appId, { practice: undefined });
  assert.equal((await w.load("convex/protectedApp/watching.ts").planFor(w.ctxFor(null), { ...row, practice: undefined })).kind, "skip");
});

test("with AUTH_REQUIRED unset and no account, the monitor, intake, the gate and push delivery behave as before", async (t) => {
  const w = world(t);
  const { alice } = await seed(w);
  const ctx = w.ctxFor(null);
  assert.equal(await w.access.demoHoldsAccounts(ctx), false);
  assert.deepEqual(await w.load("convex/monitor.ts").tick.handler(ctx.actionCtx, {}), { skipped: "PROTECTED_APP_URL is not set on this deployment, so no journey was checked." });
  await w.backend.db.insert("intakeKeys", { appId: alice.appId, key: "alice-key", createdAt: 1 });
  assert.equal((await w.load("convex/intake/records.ts").receive.handler(ctx, { key: "alice-key", text: "I can't book." })).ok, true);
  const gate = w.load("convex/consent/gate.ts").gateFor(ctx.actionCtx, { appId: alice.appId });
  assert.deepEqual(await gate.open("supermemory").then((answer) => answer.ok), true);
  assert.equal(await w.load("convex/push/deliver.ts").recipients.handler(ctx, { caseId: alice.caseId }).then((plan) => plan?.account), "solo-owner");
});

test("with AUTH_REQUIRED unset and an account present, every public function refuses before it reads or writes anything", async (t) => {
  const w = world(t);
  const { alice } = await seed(w);
  await accountsHeld(w);
  t.mock.method(console, "error", () => {});
  const stranger = w.as(null);
  const before = snapshot(w);
  const found = publicFunctionsByFile();
  assert.ok(found.length >= 70, `only ${found.length} public functions found`);
  for (const { module, name } of found) {
    assert.equal(w.load(`convex/${module}.ts`)[name].visibility, "public", `${module}:${name}`);
    // Connect's disconnect asks for the demo's owner passcode before anything else; someone who knows it is still refused.
    const args = module.endsWith("/connect") && name === "disconnect" ? { passcode: PASSCODE } : { appId: alice.appId, caseId: alice.caseId, projectId: alice.appId };
    await refuses(stranger(module, name, args), UNAVAILABLE);
  }
  assert.equal(snapshot(w), before, "nothing was written");
});

// ---- Cross-account calls (review, "Coverage tripwire") ----
// tests/access-coverage.test.mjs proves each public function calls a check; this proves the check guards the ids the
// function reads. Every public function that takes the id of a project, a case, or a row that hangs off one is called
// as alice with bob's ids, through every shape of its arguments. Each must refuse or answer as if the row did not
// exist: nothing of bob's comes back, and nothing in the database changes.

// Ids passed as text, by argument name. An argument made with v.id() names its table itself.
const ID_FIELDS = {
  id: "cases", caseId: "cases", appId: "apps", projectId: "apps", proposalId: "proposals", keyId: "intakeKeys", reportId: "reports",
  preferenceId: "ownerPreferences", suggestionId: "preferenceSuggestions", inspectionId: "onboardingInspections",
  findingId: "structuralFindings", memoryId: "recoveryMemories", permissionId: "permissions", agentRunId: "agentRuns",
};

// Every shape of a value the validator accepts that carries an id, filled with bob's ids; other values are plausible.
function samples(json, name, ids) {
  switch (json.type) {
    case "id":
      return [ids[json.tableName]];
    case "string":
      return [ID_FIELDS[name] ? ids[ID_FIELDS[name]] : name === "message" ? "What is this?" : "x"];
    case "number":
      return [1];
    case "boolean":
      return [true];
    case "bytes":
      return [new ArrayBuffer(8)];
    case "literal":
      return [json.value];
    case "union":
      return json.value.flatMap((member) => samples(member, name, ids));
    case "array":
      return [[]];
    case "null":
      return [null];
    case "object":
      return Object.entries(json.value).reduce(
        (shapes, [field, { fieldType, optional }]) => (optional && !carriesId(fieldType, field) ? shapes : shapes.flatMap((shape) => samples(fieldType, field, ids).map((value) => ({ ...shape, [field]: value })))),
        [{}],
      );
    default:
      return [{}];
  }
}
const carriesId = (json, name) => json.type === "id" || (json.type === "string" && name in ID_FIELDS) || ((json.type === "union" ? json.value : json.type === "object" ? Object.entries(json.value).map(([field, { fieldType }]) => ({ ...fieldType, field })) : []).some((member) => carriesId(member, member.field ?? name)));
const argsJson = (definition) => ({ type: "object", value: Object.fromEntries(Object.entries(definition.args ?? {}).map(([field, validator]) => [field, { fieldType: validator.json, optional: validator.isOptional === "optional" }])) });

test("as one account, every public function that takes an id refuses another account's ids or answers as if they did not exist", async (t) => {
  const w = world(t, { AUTH_REQUIRED: "true" });
  const { alice, bob } = await seed(w);
  const { db } = w.backend;
  // Bob's rows in every table a public function takes an id of.
  const bobs = { apps: bob.appId, cases: bob.caseId, proposals: bob.proposalId, ownerPreferences: bob.preferenceId };
  bobs.reports = w.backend.rows("reports").find((row) => row.appId === bob.appId)._id;
  bobs.intakeKeys = await db.insert("intakeKeys", { appId: bob.appId, key: "bob-key", createdAt: 1 });
  bobs.preferenceSuggestions = await db.insert("preferenceSuggestions", { appId: bob.appId, caseId: bob.caseId, statement: "bob's suggestion", source: "chat", status: "pending", createdAt: 1 });
  bobs.onboardingInspections = await db.insert("onboardingInspections", { appId: bob.appId, repo: "bob/salon", folders: [], status: "done", items: [], suggestions: [] });
  bobs.recoveryMemories = await db.insert("recoveryMemories", { appId: bob.appId, sourceCaseId: bob.caseId, signature: "bob", symptoms: "bob's salon is down", conditions: [], conditionChecks: [], cause: "bob's cause" });
  bobs.permissions = await db.insert("permissions", { appId: bob.appId, memoryId: bobs.recoveryMemories, actionType: "set_feature_flag", grantedBy: { kind: "owner", identity: "bob" }, grantedAt: 1, scope: { environment: "production", resourceRef: "flags#bob" }, parameterConstraints: [], conditions: [] });
  bobs.agentRuns = await db.insert("agentRuns", { caseId: bob.caseId, appId: bob.appId, taskType: "plan", config: { modelId: "bob-model" } });
  bobs.structuralFindings = await db.insert("structuralFindings", { appId: bob.appId, caseId: bob.caseId, agentRunId: bobs.agentRuns, hypothesis: "bob's hypothesis", evidence: [] });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});

  const asAlice = w.as("alice");
  const tried = [];
  for (const { module, name } of publicFunctionsByFile()) {
    const definition = w.load(`convex/${module}.ts`)[name];
    const json = argsJson(definition);
    if (!carriesId(json, "")) continue;
    for (const args of samples(json, "", bobs)) {
      const before = snapshot(w);
      let outcome;
      try {
        outcome = { answer: await asAlice(module, name, args) };
      } catch (error) {
        outcome = { refused: message(error), plain: typeof error?.data === "string" };
      }
      const label = `${module}:${name}(${JSON.stringify(args)})`;
      tried.push(label);
      assert.equal(snapshot(w), before, `${label} changed the database`);
      // A refusal in plain words (a ConvexError, whose sentence reaches the person), not a failure.
      if ("refused" in outcome) assert.ok(outcome.plain, `${label} failed instead of refusing: ${outcome.refused}`);
      else assert.doesNotMatch(JSON.stringify(outcome.answer) ?? "", /bob|salon/i, `${label} answered with bob's records`);
    }
  }
  assert.ok(tried.length >= 50, `only ${tried.length} calls were made`);
  // Alice's own ids still work through the same path, so the refusals above are about whose rows they are.
  assert.equal((await asAlice("cases", "get", { id: alice.caseId }))._id, alice.caseId);
});

test("with AUTH_REQUIRED unset and no account, the demo serves as before", async (t) => {
  const w = world(t);
  const { alice, bob } = await seed(w);
  const stranger = w.as(null);
  assert.deepEqual((await stranger("screens/projects", "list")).map((p) => p.app._id), [alice.appId, bob.appId]);
  assert.deepEqual((await stranger("cases", "list")).map((row) => row._id), [bob.caseId, alice.caseId]);
  assert.deepEqual(await stranger("users", "mode"), { accounts: false, github: false, passwordReset: false });
});
