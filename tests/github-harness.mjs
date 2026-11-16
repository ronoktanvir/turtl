import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { defineTable } from "convex/server";
import { v } from "convex/values";
import ts from "typescript";
import { readManifest } from "../scripts/github-app/link.mjs";
import { browse, startGithubStub } from "../scripts/github-app/stub.mjs";

// The harness for tests/github-app.test.mjs and tests/github-connect.test.mjs. They run convex/github's real functions
// against scripts/github-app/stub.mjs, a stand-in for GitHub served over HTTP in this process, and against an in-memory
// copy of the tables. Nothing here talks to GitHub.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const APP_ID = "424242";
const WEBHOOK_SECRET = "stub-webhook-secret";
const LEGACY_TOKEN = "deployment-wide-token";
const START = Date.parse("2026-11-15T12:00:00Z");
const MINUTE = 60_000;
const SITE = "http://turtl.test";
const SOLO = "solo-owner";
const VARIABLES = ["CONVEX_CLOUD_URL", "GITHUB_API_URL", "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_WEBHOOK_SECRET", "GITHUB_TOKEN", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "AUTH_REQUIRED", "CONVEX_SITE_URL", "SUPERMEMORY_API_KEY", "OPENAI_API_KEY"];

// Tables outside convex/github that the module reads: a project's owner (apps.ownerId, through a case) and the demo's
// owner passcode. Only the fields these tests need.
const otherTables = {
  apps: defineTable({ name: v.string(), ownerId: v.optional(v.string()) }).index("by_owner", ["ownerId"]),
  cases: defineTable({ appId: v.string() }),
  ownerPasscodeConfig: defineTable({ passcodeDigest: v.string() }),
  // Convex Auth's accounts and users, empty here: the single-owner demo first checks there are none (convex/access.ts).
  authAccounts: defineTable({ userId: v.string(), provider: v.string(), providerAccountId: v.string() }),
  users: defineTable({ email: v.optional(v.string()) }),
};

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PKCS1 = keys.privateKey.export({ type: "pkcs1", format: "pem" });
const PKCS8 = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const PUBLIC = keys.publicKey.export({ type: "spki", format: "pem" });
const manifest = readManifest();

const ref = (path) => new Proxy({ path }, { get: (target, key) => (key === "path" ? target.path : ref(path + "." + String(key))) });
const registered = (kind, visibility) => (definition) => ({ kind, visibility, ...definition });
const generated = {
  "convex/_generated/api": { api: ref("api"), internal: ref("internal") },
  "convex/_generated/server": {
    query: registered("query", "public"),
    mutation: registered("mutation", "public"),
    action: registered("action", "public"),
    internalQuery: registered("query", "internal"),
    internalMutation: registered("mutation", "internal"),
    internalAction: registered("action", "internal"),
    httpAction: (handler) => handler,
  },
};

// Loads a TypeScript module from the repository the way tests/voice.test.mjs does, following its relative
// imports to the real files unless a mock is given for that path.
function createLoader(mocks = {}) {
  const loaded = new Map();
  const load = (file) => {
    if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"));
    if (loaded.has(file)) return loaded.get(file).exports;
    const module = { exports: {} };
    loaded.set(file, module);
    const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    const require = (name) => {
      if (!name.startsWith(".")) return nodeRequire(name);
      const target = resolve(dirname(file), name);
      const key = target.slice(root.length + 1);
      if (key in mocks) return mocks[key];
      if (key in generated) return generated[key];
      return load(target.endsWith(".json") ? target : target + ".ts");
    };
    runInThisContext("(function(require, exports, module) { " + outputText + "\n})", { filename: file })(require, module.exports, module);
    return module.exports;
  };
  return (path) => load(resolve(root, path));
}

// An in-memory copy of the module's tables with the parts of Convex's database, scheduler, auth and function calls the
// module uses. An index can only be read by its own fields, in order, and a row can only hold fields the schema names.
// A caller is an account id (signed in) or null; identity carries from an action into what it calls, as in Convex.
function createBackend(load, overrides = {}) {
  const schema = { ...load("convex/github/schema.ts").githubTables, ...otherTables };
  const tables = new Map(Object.keys(schema).map((name) => [name, []]));
  const scheduled = [];
  let counter = 0;
  const rowsOf = (table) => {
    assert.ok(tables.has(table), "Unknown table " + table);
    return tables.get(table);
  };
  const locate = (id) => {
    for (const [table, rows] of tables) {
      const index = rows.findIndex((row) => row._id === id);
      if (index !== -1) return { table, rows, index };
    }
    throw new Error("No document " + id);
  };
  const checked = (table, fields) => {
    for (const [name, value] of Object.entries(fields)) {
      assert.ok(name in schema[table].validator.fields, table + " has no field " + name);
      assert.notEqual(value, null, table + "." + name + " is null");
    }
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  };
  const db = {
    insert: async (table, fields) => {
      const row = { _id: table + ":" + ++counter, _creationTime: Date.now(), ...checked(table, structuredClone(fields)) };
      rowsOf(table).push(row);
      return row._id;
    },
    patch: async (id, fields) => {
      const { table, rows, index } = locate(id);
      rows[index] = { ...rows[index], ...checked(table, structuredClone(fields)) };
    },
    delete: async (id) => {
      const { rows, index } = locate(id);
      rows.splice(index, 1);
    },
    get: async (id) => {
      for (const rows of tables.values()) {
        const row = rows.find((candidate) => candidate._id === id);
        if (row) return structuredClone(row);
      }
      return null;
    },
    normalizeId: (table, id) => (typeof id === "string" && id.startsWith(table + ":") ? id : null),
    query: (table) => ({
      first: async () => structuredClone(rowsOf(table)[0] ?? null),
      take: async (count) => structuredClone(rowsOf(table).slice(0, count)),
      unique: async () => {
        assert.ok(rowsOf(table).length <= 1, table + ": unique() matched " + rowsOf(table).length + " rows");
        return structuredClone(rowsOf(table)[0] ?? null);
      },
      withIndex: (name, build) => {
        const fields = schema[table].export().indexes.find((index) => index.indexDescriptor === name)?.fields;
        assert.ok(fields, table + " has no index " + name);
        const conditions = [];
        const range = {
          eq: (field, value) => (conditions.push(["eq", field, value]), range),
          lt: (field, value) => (conditions.push(["lt", field, value]), range),
          gt: (field, value) => (conditions.push(["gt", field, value]), range),
        };
        build(range);
        conditions.forEach(([, field], position) => assert.equal(field, fields[position], table + "." + name + " cannot be read by " + field + " here"));
        const holds = { eq: (a, b) => a === b, lt: (a, b) => a < b, gt: (a, b) => a > b };
        let descending = false;
        const matched = () => {
          const rows = structuredClone(rowsOf(table).filter((row) => conditions.every(([operator, field, value]) => holds[operator](row[field], value))));
          return descending ? rows.reverse() : rows;
        };
        const reader = {
          order: (direction) => ((descending = direction === "desc"), reader),
          collect: async () => matched(),
          first: async () => matched()[0] ?? null,
          take: async (count) => matched().slice(0, count),
          unique: async () => {
            const rows = matched();
            assert.ok(rows.length <= 1, table + "." + name + ": unique() matched " + rows.length + " rows");
            return rows[0] ?? null;
          },
        };
        return reader;
      },
    }),
  };
  const scheduler = { runAfter: async (_delay, fn, args) => void scheduled.push({ path: fn.path, args: structuredClone(args) }) };
  const auth = (caller) => ({ getUserIdentity: async () => (caller ? { subject: caller + "|session-1", tokenIdentifier: "turtl|" + caller } : null) });
  const calls = [];
  async function run(path, args = {}, kind, caller = null) {
    calls.push(path);
    if (path in overrides) return structuredClone((await overrides[path](args)) ?? null);
    const segments = path.split(".").slice(1);
    const name = segments.pop();
    const fn = load("convex/" + segments.join("/") + ".ts")[name];
    assert.ok(fn?.handler, "No function " + path);
    if (kind) assert.equal(fn.kind, kind, path + " is not a " + kind);
    assert.equal(fn.visibility, path.startsWith("api.") ? "public" : "internal", path + " is called as " + path.split(".")[0] + " but is " + fn.visibility);
    const result = await fn.handler(fn.kind === "action" ? as(caller) : { db, scheduler, auth: auth(caller) }, structuredClone(args));
    return structuredClone(result ?? null);
  }
  const as = (caller) => ({
    runQuery: (fn, args) => run(fn.path, args, "query", caller),
    runMutation: (fn, args) => run(fn.path, args, "mutation", caller),
    runAction: (fn, args) => run(fn.path, args, "action", caller),
    scheduler,
    auth: auth(caller),
  });
  const ctx = as(null);
  return {
    ctx,
    as,
    run,
    // A public function, called by the app as `caller`.
    call: (path, args, caller) => run("api." + path, args, undefined, caller),
    insert: (table, fields) => db.insert(table, fields),
    calls,
    scheduled,
    rows: (table) => structuredClone(rowsOf(table)),
    snapshot: () => JSON.stringify([...tables]),
    // Runs what the module scheduled, as Convex would after the mutation commits.
    async drain() {
      while (scheduled.length) {
        const { path, args } = scheduled.shift();
        await run(path, args);
      }
    },
  };
}

// One isolated world per test: fresh module instances, empty tables, a stub GitHub, and only the variables the test
// sets. connect adds the client id and secret and the deployment's address, which Connect GitHub needs; accounts
// turns accounts mode on (AUTH_REQUIRED=true).
async function world(t, { app = true, connect = false, accounts = false, mocks, overrides, now } = {}) {
  const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of VARIABLES) delete process.env[name];
  if (now !== undefined) t.mock.timers.enable({ apis: ["Date"], now });
  const stub = await startGithubStub({ appId: APP_ID, publicKey: PUBLIC, permissions: manifest.default_permissions, events: manifest.default_events, site: SITE });
  t.after(async () => {
    await stub.close();
    for (const name of VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  process.env.GITHUB_API_URL = stub.url;
  if (app) Object.assign(process.env, { GITHUB_APP_ID: APP_ID, GITHUB_APP_SLUG: "turtl-on-call", GITHUB_APP_PRIVATE_KEY: PKCS1, GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET });
  if (connect) Object.assign(process.env, { AUTH_GITHUB_ID: stub.clientId, AUTH_GITHUB_SECRET: stub.clientSecret, CONVEX_SITE_URL: SITE });
  // With accounts on, a stand-in address (GITHUB_API_URL) is honoured only on a local backend (convex/demoSettings.ts).
  if (accounts) Object.assign(process.env, { AUTH_REQUIRED: "true", CONVEX_CLOUD_URL: "http://127.0.0.1:3210" });
  const load = createLoader(mocks);
  const backend = createBackend(load, overrides);
  const { repositoryAccess } = load("convex/github/access.ts");
  const http = load("convex/github/http.ts");
  const { receiveWebhook } = http;
  // The person's browser: GitHub's pages come from the stub, turtl's two pages from the HTTP actions, which carry no identity.
  const open = (url) =>
    browse(url, {
      fetchPage: async (target) => {
        if (target.startsWith(SITE + "/github/setup")) return await http.setup(backend.ctx, new Request(target));
        if (target.startsWith(SITE + "/github/callback")) return await http.callback(backend.ctx, new Request(target));
        return await fetch(target, { redirect: "manual" });
      },
    });
  const mints = () => stub.requests.filter((request) => request.method === "POST" && request.path.endsWith("/access_tokens"));
  const deliver = async (event, payload, { secret = WEBHOOK_SECRET, deliveryId = randomUUID(), signature, body = JSON.stringify(payload), headers = {} } = {}) => {
    const response = await receiveWebhook(
      backend.ctx,
      new Request("http://turtl.test/github/webhook", {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": event,
          ...(deliveryId && { "X-GitHub-Delivery": deliveryId }),
          ...(signature !== null && { "X-Hub-Signature-256": signature ?? "sha256=" + createHmac("sha256", secret).update(body).digest("hex") }),
          ...headers,
        },
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  return { stub, load, backend, mints, deliver, open, http, access: (repo, owner = { account: SOLO }, purpose) => repositoryAccess(backend.ctx, repo, owner, purpose) };
}

// A world with Connect GitHub set up, and the person's side of it: `account` taps Connect GitHub in the app, `login` is
// who is signed in to github.com, and `choice` is what they do there (see willInstall in scripts/github-app/stub.mjs).
async function connectWorld(t, options = {}) {
  const w = await world(t, { connect: true, ...options });
  const project = async (ownerId) => {
    const appId = await w.backend.insert("apps", { name: "app", ...(ownerId && { ownerId }) });
    return { appId, caseId: await w.backend.insert("cases", { appId }) };
  };
  // `account` taps Connect GitHub in the app; `login` is who is signed in to github.com; `choice` is what they do there.
  const begin = async (account, login, choice, returnTo = "app") => {
    w.stub.signIn(login);
    if (choice !== undefined) w.stub.willInstall(choice);
    const { url } = await w.backend.call("github.connect.begin", { returnTo }, account);
    return url;
  };
  const connectAs = async (account, login, choice, returnTo) => {
    const url = await begin(account, login, choice, returnTo);
    const landed = await w.open(url);
    const back = new URL(landed.url);
    return { url, landed, back, result: back.searchParams.get("github"), ticket: back.searchParams.get("ticket") };
  };
  const connected = async (account, login, choice) => {
    const { ticket, result } = await connectAs(account, login, choice);
    assert.equal(result, "connected");
    return await w.backend.call("github.connect.finish", { ticket }, account);
  };
  const status = (account) => w.backend.call("github.connect.status", {}, account);
  const pickable = async (account) => (await w.backend.call("github.connect.repositories", {}, account)).map((repository) => repository.fullName);
  return { ...w, project, begin, connectAs, connected, status, pickable };
}

const installation = (id, login, { selection = "selected", suspended = false } = {}) => ({
  id,
  account: { login, type: "User", id: id + 1 },
  repository_selection: selection,
  suspended_at: suspended ? "2026-11-15T12:00:00Z" : null,
});
const repositories = (...names) => names.map((full_name, index) => ({ id: index + 1, name: full_name.split("/")[1], full_name, private: true }));
const created = (id, login, ...names) => ({ action: "created", installation: installation(id, login), repositories: repositories(...names), sender: { login } });
const lifecycle = (action, id, login, at) => ({ action, installation: { ...installation(id, login, { suspended: action === "suspend" }), updated_at: at }, sender: { login } });
const changed = (action, id, login, { added = [], removed = [], selection = "selected" } = {}) => ({
  action,
  installation: installation(id, login, { selection }),
  repository_selection: selection,
  repositories_added: repositories(...added),
  repositories_removed: repositories(...removed),
  sender: { login },
});

export {
  APP_ID,
  changed,
  connectWorld,
  created,
  createBackend,
  createLoader,
  installation,
  keys,
  LEGACY_TOKEN,
  lifecycle,
  manifest,
  MINUTE,
  otherKeys,
  PKCS1,
  PKCS8,
  PUBLIC,
  repositories,
  root,
  SITE,
  SOLO,
  START,
  WEBHOOK_SECRET,
  world,
};
