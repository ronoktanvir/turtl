import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import ts from "typescript";
import { PLACEHOLDER_SITE, readManifest, registrationUrl, withSite } from "../scripts/github-app/link.mjs";
import { startGithubStub } from "../scripts/github-app/stub.mjs";

// These tests run convex/github's real functions against scripts/github-app/stub.mjs, a stand-in for GitHub's API
// served over HTTP in this process, and against an in-memory copy of its four tables. Nothing here talks to GitHub.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const APP_ID = "424242";
const WEBHOOK_SECRET = "stub-webhook-secret";
const LEGACY_TOKEN = "deployment-wide-token";
const START = Date.parse("2026-11-15T12:00:00Z");
const MINUTE = 60_000;
const VARIABLES = ["GITHUB_API_URL", "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_WEBHOOK_SECRET", "GITHUB_TOKEN", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "SUPERMEMORY_API_KEY", "OPENAI_API_KEY"];

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PKCS1 = keys.privateKey.export({ type: "pkcs1", format: "pem" });
const PKCS8 = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const PUBLIC = keys.publicKey.export({ type: "spki", format: "pem" });
const manifest = readManifest();

const ref = (path) => new Proxy({ path }, { get: (target, key) => (key === "path" ? target.path : ref(path + "." + String(key))) });
const registered = (kind) => (definition) => ({ kind, ...definition });
const generated = {
  "convex/_generated/api": { api: ref("api"), internal: ref("internal") },
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

// An in-memory copy of the module's tables with the parts of Convex's database, scheduler and function calls the
// module uses. An index can only be read by its own fields, in order, and a row can only hold fields the schema names.
function createBackend(load, overrides = {}) {
  const schema = load("convex/github/schema.ts").githubTables;
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
    query: (table) => ({
      withIndex: (name, build) => {
        const fields = schema[table].export().indexes.find((index) => index.indexDescriptor === name)?.fields;
        assert.ok(fields, table + " has no index " + name);
        const conditions = [];
        const range = {
          eq: (field, value) => (conditions.push(["eq", field, value]), range),
          lt: (field, value) => (conditions.push(["lt", field, value]), range),
        };
        build(range);
        conditions.forEach(([, field], position) => assert.equal(field, fields[position], table + "." + name + " cannot be read by " + field + " here"));
        const matched = () =>
          structuredClone(rowsOf(table).filter((row) => conditions.every(([operator, field, value]) => (operator === "eq" ? row[field] === value : row[field] < value))));
        return {
          collect: async () => matched(),
          first: async () => matched()[0] ?? null,
          take: async (count) => matched().slice(0, count),
          unique: async () => {
            const rows = matched();
            assert.ok(rows.length <= 1, table + "." + name + ": unique() matched " + rows.length + " rows");
            return rows[0] ?? null;
          },
        };
      },
    }),
  };
  const scheduler = { runAfter: async (_delay, fn, args) => void scheduled.push({ path: fn.path, args: structuredClone(args) }) };
  const calls = [];
  async function run(path, args = {}, kind) {
    calls.push(path);
    if (path in overrides) return structuredClone((await overrides[path](args)) ?? null);
    const segments = path.split(".").slice(1);
    const name = segments.pop();
    const fn = load("convex/" + segments.join("/") + ".ts")[name];
    assert.ok(fn?.handler, "No function " + path);
    if (kind) assert.equal(fn.kind, kind, path + " is not a " + kind);
    const result = await fn.handler(fn.kind === "action" ? ctx : { db, scheduler }, structuredClone(args));
    return structuredClone(result ?? null);
  }
  const ctx = {
    runQuery: (fn, args) => run(fn.path, args, "query"),
    runMutation: (fn, args) => run(fn.path, args, "mutation"),
    runAction: (fn, args) => run(fn.path, args, "action"),
    scheduler,
  };
  return {
    ctx,
    run,
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

// One isolated world per test: fresh module instances, empty tables, a stub GitHub, and only the variables the test sets.
async function world(t, { app = true, mocks, overrides, now } = {}) {
  const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of VARIABLES) delete process.env[name];
  if (now !== undefined) t.mock.timers.enable({ apis: ["Date"], now });
  const stub = await startGithubStub({ appId: APP_ID, publicKey: PUBLIC, permissions: manifest.default_permissions, events: manifest.default_events });
  t.after(async () => {
    await stub.close();
    for (const name of VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  process.env.GITHUB_API_URL = stub.url;
  if (app) Object.assign(process.env, { GITHUB_APP_ID: APP_ID, GITHUB_APP_SLUG: "turtl-on-call", GITHUB_APP_PRIVATE_KEY: PKCS1, GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET });
  const load = createLoader(mocks);
  const backend = createBackend(load, overrides);
  const { repositoryAccess } = load("convex/github/access.ts");
  const { receiveWebhook } = load("convex/github/http.ts");
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
  return { stub, load, backend, mints, deliver, access: (repo) => repositoryAccess(backend.ctx, repo) };
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

test("the app's JWT is RS256, names the app, lasts under ten minutes, and verifies with the app's public key", async () => {
  const { signAppJwt } = createLoader()("convex/github/jwt.ts");
  const seconds = START / 1000;
  for (const key of [PKCS1, PKCS8, PKCS1.replace(/\n/g, "\\n"), PKCS1.trim().replace(/\n/g, " ")]) {
    const jwt = await signAppJwt(APP_ID, key, START);
    assert.match(jwt, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const [header, claims, signature] = jwt.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
    assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")), { iat: seconds - 60, exp: seconds + 540, iss: APP_ID });
    const signed = Buffer.from(header + "." + claims);
    assert.equal(verify("RSA-SHA256", signed, keys.publicKey, Buffer.from(signature, "base64url")), true);
    assert.equal(verify("RSA-SHA256", signed, otherKeys.publicKey, Buffer.from(signature, "base64url")), false);
  }
  for (const unreadable of ["", "not a key", "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----", PUBLIC]) {
    assert.equal(await signAppJwt(APP_ID, unreadable, START), null);
  }
});

test("an installation token is minted with the app's JWT, cached, and replaced five minutes before it expires", async (t) => {
  const { stub, backend, mints, access } = await world(t, { now: START });
  stub.install({ id: 7001, login: "octo", repositories: ["octo/app"] });
  await backend.run("internal.github.installations.record", { installation: { installationId: 7001, accountLogin: "octo", repositorySelection: "selected" }, status: "active", repositories: [{ fullName: "octo/app" }], seenAt: START });

  const first = await access("octo/app");
  assert.deepEqual(first, { ok: true, source: "installation", token: "ghs_stub_1", installationId: 7001 });
  assert.equal(mints().length, 1);
  assert.equal(mints()[0].path, "/app/installations/7001/access_tokens");
  assert.equal(mints()[0].credential, "app");
  assert.deepEqual(mints()[0].jwt.header, { alg: "RS256", typ: "JWT" });
  assert.deepEqual(mints()[0].jwt.claims, { iat: START / 1000 - 60, exp: START / 1000 + 540, iss: APP_ID });
  assert.deepEqual(backend.rows("githubInstallationTokens").map(({ installationId, token, expiresAt }) => ({ installationId, token, expiresAt })), [
    { installationId: 7001, token: "ghs_stub_1", expiresAt: START + 60 * MINUTE },
  ]);

  assert.equal((await access("octo/app")).token, "ghs_stub_1");
  t.mock.timers.setTime(START + 54 * MINUTE);
  assert.equal((await access("octo/app")).token, "ghs_stub_1");
  assert.equal(mints().length, 1, "a token with more than five minutes left is reused");

  t.mock.timers.setTime(START + 55 * MINUTE + 1);
  assert.equal((await access("octo/app")).token, "ghs_stub_2");
  assert.equal(mints().length, 2, "a token inside its last five minutes is replaced");
  assert.deepEqual(backend.rows("githubInstallationTokens").map((row) => row.token), ["ghs_stub_2"]);
});

test("a JWT signed with the wrong key is refused, and nothing is cached", async (t) => {
  const { stub, backend, access } = await world(t);
  stub.install({ id: 7001, login: "octo", repositories: ["octo/app"] });
  process.env.GITHUB_APP_PRIVATE_KEY = otherKeys.privateKey.export({ type: "pkcs1", format: "pem" });
  const refused = await access("octo/app");
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "github_error");
  assert.match(refused.message, /401/);
  assert.equal(stub.requests.every((request) => request.credential === "refused"), true);
  assert.deepEqual(backend.rows("githubInstallationTokens"), []);
  assert.deepEqual(backend.rows("githubInstallations"), []);
});

test("a token is stored in one table that only github/tokens.ts reads, and no function in the module is public", async (t) => {
  const sources = (directory) =>
    readdirSync(resolve(root, directory), { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map((entry) => resolve(entry.parentPath, entry.name).slice(root.length + 1))
      .filter((path) => !path.startsWith("convex/_generated/"));
  const mentions = [...sources("convex"), ...sources("app"), ...sources("components"), ...sources("data")].filter((path) => readFileSync(resolve(root, path), "utf8").includes("githubInstallationTokens"));
  assert.deepEqual(mentions.sort(), ["convex/github/schema.ts", "convex/github/tokens.ts"]);
  for (const path of sources("convex/github")) {
    const imported = /import \{([^}]+)\} from "\.\.\/_generated\/server"/.exec(readFileSync(resolve(root, path), "utf8"))?.[1] ?? "";
    const names = imported.split(",").map((name) => name.replace(/\btype\b/, "").trim()).filter(Boolean);
    assert.deepEqual(names.filter((name) => ["query", "mutation", "action"].includes(name)), [], path + " registers a public function");
  }

  const { stub, backend, load, access } = await world(t);
  stub.install({ id: 7001, login: "octo", repositories: ["octo/app"] });
  const { token } = await access("octo/app");
  assert.match(token, /^ghs_stub_/);
  const visible = [
    await backend.run("internal.github.installations.covering", { repo: "octo/app" }),
    await backend.run("internal.github.installations.repositories", { installationId: 7001 }),
    await backend.run("internal.github.access.check", { repo: "octo/app" }),
    await backend.run("internal.github.sync.refresh", { installationId: 7001 }),
    backend.rows("githubInstallations"),
    backend.rows("githubInstallationRepositories"),
    backend.rows("githubWebhookDeliveries"),
  ];
  assert.equal(JSON.stringify(visible).includes("ghs_stub_"), false);
  assert.equal(typeof load("convex/github/tokens.ts").cached.handler, "function");
});

test("a webhook with GitHub's signature is applied; a wrong, missing, or malformed signature changes nothing", async (t) => {
  const { backend, deliver } = await world(t);
  const payload = created(7001, "octo", "octo/app", "octo/site");
  const body = JSON.stringify(payload);
  const good = "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  const refusals = {
    "signed with another secret": { secret: "another-secret" },
    "no signature header": { signature: null },
    "sha1 signature": { signature: "sha1=" + createHmac("sha1", WEBHOOK_SECRET).update(body).digest("hex") },
    "truncated signature": { signature: good.slice(0, -2) },
    "uppercase signature": { signature: "sha256=" + good.slice(7).toUpperCase() },
    "one flipped character": { signature: good.slice(0, -1) + (good.endsWith("0") ? "1" : "0") },
    "body changed after signing": { signature: good, body: body.replace("octo/site", "octo/secrets") },
  };
  for (const [name, options] of Object.entries(refusals)) {
    const refused = await deliver("installation", payload, options);
    assert.equal(refused.status, 401, name);
    assert.equal(refused.body.error.code, "INVALID_SIGNATURE", name);
  }
  assert.deepEqual(backend.calls, [], "a refused delivery never reaches the database");
  assert.equal(backend.snapshot(), JSON.stringify([["githubInstallations", []], ["githubInstallationRepositories", []], ["githubInstallationTokens", []], ["githubWebhookDeliveries", []]]));

  assert.deepEqual(await deliver("installation", payload, { signature: good }), { status: 200, body: { ok: true, outcome: "applied" } });
  assert.deepEqual(backend.rows("githubInstallations").map(({ installationId, accountLogin, repositorySelection, status }) => ({ installationId, accountLogin, repositorySelection, status })), [
    { installationId: 7001, accountLogin: "octo", repositorySelection: "selected", status: "active" },
  ]);
  assert.deepEqual(await backend.run("internal.github.installations.repositories", { installationId: 7001 }), [
    { fullName: "octo/app", private: true },
    { fullName: "octo/site", private: true },
  ]);
});

test("without GITHUB_APP_WEBHOOK_SECRET the receiver refuses every delivery", async (t) => {
  const { backend, deliver } = await world(t);
  delete process.env.GITHUB_APP_WEBHOOK_SECRET;
  for (const options of [{}, { secret: "" }, { signature: null }]) {
    const refused = await deliver("installation", created(7001, "octo", "octo/app"), options);
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.code, "WEBHOOK_NOT_CONFIGURED");
  }
  assert.deepEqual(backend.calls, []);
});

test("webhooks record installations created, suspended, unsuspended and deleted, and repositories added and removed", async (t) => {
  const { stub, backend, deliver, access, mints } = await world(t);
  stub.install({ id: 7001, login: "octo", repositories: ["octo/app", "octo/site"] });
  const status = () => backend.rows("githubInstallations").map((row) => row.status);
  const names = async () => (await backend.run("internal.github.installations.repositories", { installationId: 7001 })).map((repository) => repository.fullName);

  assert.equal((await deliver("installation", created(7001, "octo", "octo/app"))).body.outcome, "applied");
  assert.deepEqual(await names(), ["octo/app"]);
  assert.equal((await access("octo/app")).source, "installation");
  assert.equal(backend.rows("githubInstallationTokens").length, 1);

  assert.equal((await deliver("installation_repositories", changed("added", 7001, "octo", { added: ["octo/site", "octo/docs"] }))).body.outcome, "applied");
  assert.deepEqual(await names(), ["octo/app", "octo/docs", "octo/site"]);
  assert.equal(backend.rows("githubInstallationTokens").length, 0, "a change to the installation drops the cached token");
  assert.equal((await deliver("installation_repositories", changed("removed", 7001, "octo", { removed: ["octo/docs"] }))).body.outcome, "applied");
  assert.deepEqual(await names(), ["octo/app", "octo/site"]);
  assert.equal(await backend.run("internal.github.installations.covering", { repo: "octo/docs" }), null);
  assert.equal(await backend.run("internal.github.installations.covering", { repo: "OCTO/Site" }), 7001);

  await access("octo/site");
  stub.installations.get(7001).suspended_at = "2026-11-15T12:10:00Z";
  assert.equal((await deliver("installation", lifecycle("suspend", 7001, "octo", "2026-11-15T12:10:00Z"))).body.outcome, "applied");
  assert.deepEqual(status(), ["suspended"]);
  assert.equal(backend.rows("githubInstallationTokens").length, 0, "a suspended installation keeps no token");
  assert.deepEqual(await names(), [], "a suspended installation offers no repositories");
  const suspended = await access("octo/app");
  assert.equal(suspended.ok, false);
  assert.equal(suspended.reason, "suspended");

  stub.installations.get(7001).suspended_at = null;
  assert.equal((await deliver("installation", lifecycle("unsuspend", 7001, "octo", "2026-11-15T12:20:00Z"))).body.outcome, "applied");
  assert.deepEqual(status(), ["active"]);
  assert.deepEqual(await names(), ["octo/app", "octo/site"]);
  assert.equal((await access("octo/app")).source, "installation");

  const before = mints().length;
  stub.installations.delete(7001);
  assert.equal((await deliver("installation", lifecycle("deleted", 7001, "octo", "2026-11-15T12:30:00Z"))).body.outcome, "applied");
  assert.deepEqual(status(), ["deleted"]);
  assert.deepEqual(backend.rows("githubInstallationRepositories"), []);
  assert.deepEqual(backend.rows("githubInstallationTokens"), []);
  const gone = await access("octo/app");
  assert.equal(gone.ok, false);
  assert.equal(gone.reason, "not_installed");
  assert.equal(mints().length, before, "no token is asked for once the installation is deleted");

  assert.equal((await deliver("installation_repositories", changed("added", 7001, "octo", { added: ["octo/late"] }))).body.outcome, "ignored");
  assert.deepEqual(status(), ["deleted"]);
  assert.deepEqual(backend.rows("githubInstallationRepositories"), []);
});

test("a replayed delivery changes nothing, by its delivery id or by its signed body under a new id", async (t) => {
  const { backend, deliver } = await world(t);
  const install = created(7001, "octo", "octo/app", "octo/site");
  assert.equal((await deliver("installation", install, { deliveryId: "delivery-1" })).body.outcome, "applied");
  const removal = changed("removed", 7001, "octo", { removed: ["octo/site"] });
  assert.equal((await deliver("installation_repositories", removal, { deliveryId: "delivery-2" })).body.outcome, "applied");
  assert.equal((await deliver("installation", lifecycle("deleted", 7001, "octo", "2026-11-15T12:30:00Z"), { deliveryId: "delivery-3" })).body.outcome, "applied");
  const settled = backend.snapshot();

  assert.deepEqual(await deliver("installation", install, { deliveryId: "delivery-1" }), { status: 200, body: { ok: true, outcome: "duplicate" } });
  assert.deepEqual(await deliver("installation", install, { deliveryId: "a-new-id-for-an-old-body" }), { status: 200, body: { ok: true, outcome: "duplicate" } });
  assert.equal((await deliver("installation_repositories", removal, { deliveryId: randomUUID() })).body.outcome, "duplicate");
  assert.equal((await deliver("installation_repositories", changed("added", 7001, "octo", { added: ["octo/new"] }), { deliveryId: "delivery-2" })).body.outcome, "duplicate");
  assert.equal(backend.snapshot(), settled);
  assert.deepEqual(backend.rows("githubInstallations").map((row) => row.status), ["deleted"]);
  assert.equal(backend.rows("githubWebhookDeliveries").length, 3);
});

test("a signed delivery turtl does not read is acknowledged and stored nowhere; a malformed one is refused", async (t) => {
  const { backend, deliver } = await world(t);
  assert.deepEqual(await deliver("ping", { zen: "Keep it logically awesome.", hook_id: 1 }), { status: 200, body: { ok: true, outcome: "pong" } });
  assert.deepEqual(await deliver("push", { ref: "refs/heads/main", installation: installation(7001, "octo") }), { status: 200, body: { ok: true, outcome: "ignored" } });
  assert.deepEqual(await deliver("installation", { ...created(7001, "octo", "octo/app"), action: "transferred" }), { status: 200, body: { ok: true, outcome: "ignored" } });
  for (const [payload, options] of [
    [null, { body: "{not json" }],
    [{ action: "created" }, {}],
    [{ action: "created", installation: { id: "7001", account: { login: "octo" }, repository_selection: "selected" } }, {}],
    [{ ...created(7001, "octo"), repositories: [{ full_name: "octo/app/../../admin" }] }, {}],
    [{ ...created(7001, "octo"), installation: { ...installation(7001, "octo"), repository_selection: "everything" } }, {}],
  ]) {
    const refused = await deliver("installation", payload, options);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, "INVALID_PAYLOAD");
  }
  assert.equal((await deliver("installation", created(7001, "octo", "octo/app"), { deliveryId: null })).status, 400);
  assert.equal((await deliver("installation", created(7001, "octo", "octo/app"), { headers: { "Content-Length": "5000001" } })).status, 413);
  assert.deepEqual(backend.calls, []);
});

test("one place decides the credential: an installation token for a covered repository, and never GITHUB_TOKEN once the app is configured", async (t) => {
  const { stub, deliver, access, mints } = await world(t);
  process.env.GITHUB_TOKEN = LEGACY_TOKEN;
  stub.install({ id: 7001, login: "octo", repositories: ["octo/app"] });
  stub.install({ id: 7002, login: "hubot", repositories: ["hubot/robot"] });
  await deliver("installation", created(7001, "octo", "octo/app"));
  await deliver("installation", created(7002, "hubot", "hubot/robot"));

  const octo = await access("octo/app");
  const hubot = await access("Hubot/Robot");
  assert.deepEqual([octo.source, octo.installationId, hubot.source, hubot.installationId], ["installation", 7001, "installation", 7002]);
  assert.notEqual(octo.token, hubot.token);
  assert.deepEqual(mints().map((request) => request.path), ["/app/installations/7001/access_tokens", "/app/installations/7002/access_tokens"]);
  assert.equal(stub.tokens.get(octo.token).installationId, 7001);
  assert.equal(stub.tokens.get(hubot.token).installationId, 7002);

  const uncovered = await access("octo/private-notes");
  assert.equal(uncovered.ok, false);
  assert.equal(uncovered.reason, "not_installed");
  assert.match(uncovered.message, /not installed on octo\/private-notes/);
  assert.equal(JSON.stringify(uncovered).includes(LEGACY_TOKEN), false);

  const before = stub.requests.length;
  const invalid = await access("octo/app/../../../app/installations");
  assert.equal(invalid.reason, "invalid_repository");
  assert.equal(stub.requests.length, before, "a malformed repository never reaches GitHub");
});

test("a partly configured app stops repository access instead of falling back to GITHUB_TOKEN", async (t) => {
  const { stub, backend, access } = await world(t, { app: false });
  process.env.GITHUB_TOKEN = LEGACY_TOKEN;
  const partial = [
    [{ GITHUB_APP_ID: APP_ID }, /GITHUB_APP_PRIVATE_KEY is not set/],
    [{ GITHUB_APP_PRIVATE_KEY: PKCS1 }, /GITHUB_APP_ID is not set/],
    [{ GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET }, /GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY is not set/],
    [{ GITHUB_APP_SLUG: "turtl-on-call" }, /GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY is not set/],
    [{ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----" }, /not a PEM private key/],
  ];
  for (const [variables, message] of partial) {
    Object.assign(process.env, variables);
    const refused = await access("octo/app");
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "app_incomplete");
    assert.match(refused.message, message);
    assert.equal(JSON.stringify(refused).includes(LEGACY_TOKEN), false);
    assert.equal(refused.message.includes("AAAA"), false, "the key never appears in a message");
    for (const name of Object.keys(variables)) delete process.env[name];
  }
  assert.deepEqual(stub.requests, []);
  assert.deepEqual(backend.calls, []);
});

test("with no GitHub App configured, every repository gets the deployment's GITHUB_TOKEN, as it does today", async (t) => {
  const { stub, backend, access } = await world(t, { app: false });
  assert.deepEqual(await access("octo/app"), { ok: true, source: "deployment", token: undefined });
  process.env.GITHUB_TOKEN = LEGACY_TOKEN;
  assert.deepEqual(await access("octo/app"), { ok: true, source: "deployment", token: LEGACY_TOKEN });
  assert.deepEqual(await access("anyone/anything"), { ok: true, source: "deployment", token: LEGACY_TOKEN });
  assert.deepEqual(stub.requests, [], "GitHub is not asked anything");
  assert.deepEqual(backend.calls, [], "no table is read");
  process.env.AUTH_GITHUB_ID = "Iv1.signin-only";
  process.env.AUTH_GITHUB_SECRET = "signin-secret";
  assert.equal((await access("octo/app")).source, "deployment", "the sign-in variables alone do not switch repository access to the app");
});

test("when turtl's records are behind, GitHub has the last word", async (t) => {
  const { stub, backend, access, mints } = await world(t);
  stub.install({ id: 7001, login: "octo", selection: "all", repositories: ["octo/app", "octo/site"] });

  const healed = await access("octo/app");
  assert.deepEqual([healed.ok, healed.source, healed.installationId], [true, "installation", 7001]);
  assert.deepEqual(backend.rows("githubInstallations").map(({ installationId, accountLogin, repositorySelection, status }) => ({ installationId, accountLogin, repositorySelection, status })), [
    { installationId: 7001, accountLogin: "octo", repositorySelection: "all", status: "active" },
  ]);
  assert.equal(await backend.run("internal.github.installations.covering", { repo: "octo/app" }), 7001);
  const lookups = () => stub.requests.filter((request) => request.path.endsWith("/installation")).length;
  assert.equal(lookups(), 1);
  await access("octo/app");
  assert.equal(lookups(), 1, "a recorded repository is not looked up again");

  stub.failWith(500);
  const unreachable = await access("octo/site");
  assert.deepEqual([unreachable.ok, unreachable.reason], [false, "github_error"]);
  stub.failWith(null);

  stub.installations.delete(7001);
  await backend.run("internal.github.tokens.store", { installationId: 7001, token: "ghs_stub_expired", expiresAt: Date.now() - 1 });
  const before = mints().length;
  const removed = await access("octo/app");
  assert.deepEqual([removed.ok, removed.reason], [false, "not_installed"]);
  assert.equal(mints().length, before + 1);
  assert.deepEqual(backend.rows("githubInstallations").map((row) => row.status), ["deleted"], "a 404 from GitHub records the installation as deleted");
  assert.deepEqual(backend.rows("githubInstallationRepositories"), []);
  assert.deepEqual(backend.rows("githubInstallationTokens"), []);
});

test("listing reads every page from GitHub, makes the records match, and returns the repositories by name", async (t) => {
  const { stub, backend, deliver } = await world(t);
  const names = Array.from({ length: 230 }, (_, index) => "octo/repo-" + String(index).padStart(3, "0"));
  stub.install({ id: 7001, login: "octo", selection: "all", repositories: [...names.slice(100), { full_name: "octo/Public-Site", private: false }, ...names.slice(0, 100)] });
  await deliver("installation", created(7001, "octo", "octo/removed-on-github", "octo/repo-000"));

  const listed = await backend.run("internal.github.sync.refresh", { installationId: 7001 });
  assert.equal(listed.ok, true);
  assert.equal(listed.repositories.length, 231);
  assert.deepEqual(listed.repositories.slice(0, 3), [{ fullName: "octo/Public-Site", private: false }, { fullName: "octo/repo-000", private: true }, { fullName: "octo/repo-001", private: true }]);
  assert.deepEqual(await backend.run("internal.github.installations.repositories", { installationId: 7001 }), listed.repositories);
  assert.equal(listed.repositories.some((repository) => repository.fullName === "octo/removed-on-github"), false);
  const pages = stub.requests.filter((request) => request.path === "/installation/repositories");
  assert.deepEqual(pages.map((request) => request.credential), ["installation", "installation", "installation"]);
  assert.equal(backend.rows("githubInstallations")[0].repositorySelection, "all");

  const unknown = await backend.run("internal.github.sync.refresh", { installationId: 9999 });
  assert.deepEqual([unknown.ok, /404/.test(unknown.message)], [false, true]);
  stub.installations.get(7001).suspended_at = "2026-11-15T12:10:00Z";
  const suspended = await backend.run("internal.github.sync.refresh", { installationId: 7001 });
  assert.deepEqual([suspended.ok, /suspended/.test(suspended.message)], [false, true]);
  assert.deepEqual(await backend.run("internal.github.installations.repositories", { installationId: 7001 }), []);
});

test("a change between all and selected repositories, or a very long list, is read back from GitHub", async (t) => {
  const { stub, backend, deliver } = await world(t);
  stub.install({ id: 7001, login: "octo", selection: "all", repositories: ["octo/app", "octo/site", "octo/docs"] });
  await deliver("installation", { ...created(7001, "octo", "octo/app", "octo/site", "octo/docs"), installation: installation(7001, "octo", { selection: "all" }) });
  assert.deepEqual(backend.scheduled, []);

  stub.install({ id: 7001, login: "octo", selection: "selected", repositories: ["octo/app"] });
  assert.equal((await deliver("installation_repositories", changed("removed", 7001, "octo", { selection: "selected" }))).body.outcome, "applied");
  assert.deepEqual(backend.scheduled, [{ path: "internal.github.sync.refresh", args: { installationId: 7001 } }]);
  await backend.drain();
  assert.deepEqual(await backend.run("internal.github.installations.repositories", { installationId: 7001 }), [{ fullName: "octo/app", private: true }]);

  const many = Array.from({ length: 2001 }, (_, index) => "big/repo-" + String(index).padStart(4, "0"));
  stub.install({ id: 7002, login: "big", selection: "all", repositories: many });
  assert.equal((await deliver("installation", { ...created(7002, "big", ...many), installation: installation(7002, "big", { selection: "all" }) })).body.outcome, "applied");
  assert.equal(backend.rows("githubInstallationRepositories").filter((row) => row.installationId === 7002).length, 0);
  assert.deepEqual(backend.scheduled, [{ path: "internal.github.sync.refresh", args: { installationId: 7002 } }]);
  await backend.drain();
  assert.equal((await backend.run("internal.github.installations.repositories", { installationId: 7002 })).length, 2001);
});

test("the check reports what is configured and whether GitHub accepts it, with names and never values", async (t) => {
  const { stub, backend } = await world(t);
  process.env.GITHUB_TOKEN = LEGACY_TOKEN;
  stub.install({ id: 7001, login: "octo", repositories: ["octo/app"] });
  const report = await backend.run("internal.github.access.check", { repo: "octo/app" });
  assert.deepEqual(report, {
    app: "ready",
    variables: { GITHUB_APP_ID: "set", GITHUB_APP_SLUG: "set", GITHUB_APP_PRIVATE_KEY: "set", GITHUB_APP_WEBHOOK_SECRET: "set", AUTH_GITHUB_ID: "not set", AUTH_GITHUB_SECRET: "not set", GITHUB_TOKEN: "set" },
    github: { ok: true, slug: "turtl-on-call", slugMatches: true, permissions: manifest.default_permissions, permissionsMatch: true, events: [] },
    repository: { ok: true, source: "installation", installationId: 7001 },
  });
  for (const secret of [LEGACY_TOKEN, WEBHOOK_SECRET, "ghs_stub_", "PRIVATE KEY"]) assert.equal(JSON.stringify(report).includes(secret), false);

  process.env.GITHUB_APP_SLUG = "another-app";
  const drifted = await backend.run("internal.github.access.check", {});
  assert.deepEqual([drifted.github.slugMatches, drifted.repository], [false, null]);
});

test("the check on a deployment without the app reports the fallback", async (t) => {
  const { stub, backend } = await world(t, { app: false });
  process.env.GITHUB_TOKEN = LEGACY_TOKEN;
  const report = await backend.run("internal.github.access.check", { repo: "octo/app" });
  assert.deepEqual([report.app, report.github, report.repository], ["absent", null, { ok: true, source: "deployment", hasToken: true }]);
  assert.deepEqual(stub.requests, []);
});

const pullRequestMocks = (seen) => {
  const real = createLoader()("convex/prTracking/github.ts");
  return {
    "convex/decisions": { SOLO_OWNER: { kind: "owner", identity: "solo" } },
    "convex/prTracking/capy": {},
    "convex/prTracking/catalog": {},
    "convex/prTracking/records": {},
    "convex/prTracking/validators": { pullRequestOf: (repo, number, snapshot) => ({ repo, number, ...snapshot }) },
    "convex/protectedApp/client": {},
    "convex/prTracking/github": {
      ...real,
      readPullRequest: async (token, repo, number) => {
        seen.push({ token, repo, number });
        return { ok: true, body: { snapshot: { title: "Fix", url: "https://github.com/" + repo + "/pull/" + number, headSha: "abc", state: "open", checks: "passing", checkRuns: [], mergeable: true, mergeableState: "clean" } } };
      },
    },
  };
};

test("pull request tracking asks that one place: the installation's token when covered, GITHUB_TOKEN only without the app", async (t) => {
  const row = { _id: "pullRequests:1", repo: "octo/app", number: 12, requestedAt: START };
  const overrides = {
    "internal.prTracking.records.forCase": () => row,
    "internal.prTracking.records.applySnapshot": () => null,
    "internal.prTracking.records.deploymentTarget": () => null,
  };
  const scenario = async (name, options, prepare, expect) => {
    await t.test(name, async (t) => {
      const seen = [];
      const w = await world(t, { ...options, mocks: pullRequestMocks(seen), overrides });
      await prepare(w);
      const result = await w.load("convex/pullRequests.ts").refresh.handler(w.backend.ctx, { caseId: "cases:1" });
      await expect(result, seen, w);
    });
  };
  await scenario("no app, GITHUB_TOKEN set", { app: false }, () => void (process.env.GITHUB_TOKEN = LEGACY_TOKEN), (result, seen) => {
    assert.equal(result.outcome, "synced");
    assert.deepEqual(seen, [{ token: LEGACY_TOKEN, repo: "octo/app", number: 12 }]);
  });
  await scenario("no app, no GITHUB_TOKEN", { app: false }, () => {}, (result, seen) => {
    assert.deepEqual(result, { outcome: "not_configured", missing: ["GITHUB_TOKEN"] });
    assert.deepEqual(seen, []);
  });
  await scenario("app configured and installed", {}, (w) => {
    process.env.GITHUB_TOKEN = LEGACY_TOKEN;
    w.stub.install({ id: 7001, login: "octo", repositories: ["octo/app"] });
  }, (result, seen) => {
    assert.equal(result.outcome, "synced");
    assert.deepEqual(seen, [{ token: "ghs_stub_1", repo: "octo/app", number: 12 }]);
  });
  await scenario("app configured, not installed on the repository", {}, () => void (process.env.GITHUB_TOKEN = LEGACY_TOKEN), (result, seen) => {
    assert.equal(result.outcome, "failed");
    assert.match(result.message, /not installed on octo\/app/);
    assert.deepEqual(seen, []);
  });
});

test("the code network build asks that one place too", async (t) => {
  const mocks = {
    "convex/supermemory": { addDocuments: async () => ({ count: 0, failed: 0 }) },
    "convex/codeNetwork/graph": { buildGraph: () => ({ nodes: [], edges: [] }), fillClusters: () => new Map(), isSourcePath: () => true, lineCount: () => 0 },
    "convex/codeNetwork/openai": { respond: async () => assert.fail("no model call in this test") },
    "convex/codeNetwork/schema": { codeNamespace: (id) => "code_" + id },
  };
  const scenario = async (name, options, prepare, expect) => {
    await t.test(name, async (t) => {
      const w = await world(t, { ...options, mocks });
      process.env.SUPERMEMORY_API_KEY = "stub";
      await prepare(w);
      const real = globalThis.fetch;
      const seen = [];
      t.mock.method(globalThis, "fetch", async (input, init) => {
        if (String(input).startsWith(w.stub.url)) return real(input, init);
        seen.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      });
      const result = await w.load("convex/codeNetwork/build.ts").build.handler(w.backend.ctx, { projectId: "apps:1", repo: "octo/app", reuseLabels: true });
      await expect(result, seen);
    });
  };
  await scenario("no app, GITHUB_TOKEN set", { app: false }, () => void (process.env.GITHUB_TOKEN = LEGACY_TOKEN), (result, seen) => {
    assert.equal(result.outcome, "failed");
    assert.deepEqual(seen, [{ url: "https://api.github.com/repos/octo/app/commits/HEAD", authorization: "Bearer " + LEGACY_TOKEN }]);
  });
  await scenario("no app, no GITHUB_TOKEN: public repositories are still read without a credential", { app: false }, () => {}, (result, seen) => {
    assert.deepEqual(seen, [{ url: "https://api.github.com/repos/octo/app/commits/HEAD", authorization: null }]);
  });
  await scenario("app configured and installed", {}, (w) => {
    process.env.GITHUB_TOKEN = LEGACY_TOKEN;
    w.stub.install({ id: 7001, login: "octo", repositories: ["octo/app"] });
  }, (result, seen) => {
    assert.deepEqual(seen, [{ url: "https://api.github.com/repos/octo/app/commits/HEAD", authorization: "Bearer ghs_stub_1" }]);
  });
  await scenario("app configured, not installed on the repository", {}, () => void (process.env.GITHUB_TOKEN = LEGACY_TOKEN), (result, seen) => {
    assert.equal(result.outcome, "failed");
    assert.match(result.reason, /not installed on octo\/app/);
    assert.deepEqual(seen, [], "nothing is read from GitHub without an installation");
  });
});

test("the manifest asks for the least turtl's GitHub calls need, and the prefilled link carries exactly the manifest", () => {
  assert.deepEqual(manifest.default_permissions, { contents: "write", checks: "read", statuses: "read", metadata: "read" });
  assert.deepEqual(manifest.default_events, [], "installation events reach every GitHub App without a subscription");
  assert.equal(manifest.public, true);
  assert.equal(manifest.request_oauth_on_install, false);
  assert.equal(manifest.setup_on_update, true);
  const { WEBHOOK_PATH, SETUP_PATH } = createLoader()("convex/github/http.ts");
  assert.equal(manifest.hook_attributes.url, PLACEHOLDER_SITE + WEBHOOK_PATH);
  assert.equal(manifest.setup_url, PLACEHOLDER_SITE + SETUP_PATH);
  assert.deepEqual(manifest.callback_urls, [PLACEHOLDER_SITE + "/api/auth/callback/github", PLACEHOLDER_SITE + "/github/callback"]);

  const site = "https://happy-otter-123.convex.site";
  const link = new URL(registrationUrl(withSite(manifest, site + "/")));
  assert.equal(link.origin + link.pathname, "https://github.com/settings/apps/new");
  assert.equal(link.href.includes("YOUR-DEPLOYMENT"), false);
  const expected = {
    name: [manifest.name],
    description: [manifest.description],
    url: [manifest.url],
    public: ["true"],
    webhook_active: ["true"],
    webhook_url: [site + "/github/webhook"],
    setup_url: [site + "/github/setup"],
    setup_on_update: ["true"],
    request_oauth_on_install: ["false"],
    "callback_urls[]": [site + "/api/auth/callback/github", site + "/github/callback"],
    contents: ["write"],
    checks: ["read"],
    statuses: ["read"],
    metadata: ["read"],
  };
  assert.deepEqual(Object.fromEntries([...new Set(link.searchParams.keys())].map((name) => [name, link.searchParams.getAll(name)])), expected);
  assert.match(registrationUrl(manifest, "acme"), /^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?/);
});
