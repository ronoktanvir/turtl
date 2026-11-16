import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import ts from "typescript";
import { startAuthStandIn } from "./fixtures/auth-stand-in.mjs";
import { startSupermemoryStandIn } from "./fixtures/supermemory-stand-in.mjs";

// Deleting an account (convex/account, checklist RC-23 and RC-25).
//
// The tripwire: every table in convex/schema.ts must be removed by the deletion (a line in convex/account/registry.ts)
// or be listed in EXEMPT below with the reason it holds nothing of an account's. A table added without either fails
// here, with what to do.
//
// Then the job itself runs against an in-memory copy of every table, with a row in every table for two accounts: the
// first asks to be deleted, the scheduler runs to the end (with the clock moved on over its waits), and afterwards no
// row anywhere names anything of the first account while every row of the second is untouched. Supermemory and Apple
// are stand-in servers (tests/fixtures); GitHub's disconnect is replaced by a stand-in that fails once.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const esModules = { "@convex-dev/auth/server": await import("@convex-dev/auth/server") };

// Tables that deleting an account leaves alone, and why. Adding one here needs a reason a reviewer would accept.
const EXEMPT = {
  ownerPasscodeConfig: "The single-owner demo's passcode digest. It belongs to no account, and accounts mode never reads it.",
  bookingDemoSettings: "The booking demo's own switches. The demo app is turtl's test patient, not an account's data.",
  bookingDemoBookings: "Bookings the booking demo's test journeys made in the demo app. No account's data.",
  bookingDemoAttempts: "The booking demo's own log of booking attempts. No account's data.",
  githubWebhookDeliveries: "GitHub's delivery ids and body digests, kept so a replayed webhook changes nothing. They name an installation number, never a person or an account.",
  authAppleNonces: "SHA-256 hashes of Apple sign-in nonces already used. They name nobody, and each is deleted minutes after its token expires.",
  authEmailCodes: "One row per code emailed in the last day, filed under a SHA-256 hash of the address and holding only the code's hash. It names no account, and must outlive one: it is what stops deleting an account and signing up again from mailing an address more than five times a day. The hourly sweep deletes each row a day after it was sent.",
  deploymentTotals: "Deployment-wide running totals (new accounts per hour and day, every account's model spend per day). They count everyone and name no account.",
  monitorCursor: "The monitor's place in its round of projects: one deployment-wide row holding a point in time. It names no account and no project.",
  accountDeletions: "The record that a deletion happened. Once the job is done it holds a hash of the account id, the times and counts, and nothing else.",
};

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

function createLoader(mocks = {}) {
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

const schemaTables = () => createLoader()("convex/schema.ts").default.tables;
const indexFields = (table, name) => table.export().indexes.find((index) => index.indexDescriptor === name)?.fields;

// ---------------------------------------------------------------------------------------------- the tripwire

test("every table in the schema is removed by account deletion, or exempt with a reason", () => {
  const tables = schemaTables();
  const registry = createLoader()("convex/account/registry.ts");
  const lists = [...registry.caseErasers, ...registry.projectErasers, ...registry.accountErasers];
  const covered = new Set([
    ...registry.engineTables,
    ...lists.flatMap((entry) => (entry.kind === "rows" ? [entry.table] : entry.tables)),
    ...Object.values(registry.vendorTables).flat(),
  ]);
  const forgotten = Object.keys(tables).filter((name) => !covered.has(name) && !(name in EXEMPT));
  assert.deepEqual(
    forgotten,
    [],
    "Deleting an account does not remove these tables' rows. For each, add one line to convex/account/registry.ts in the list " +
      "for what its rows hang off (caseRows(table, index) for a case, projectRows(table, index) for a project, " +
      "accountRows(table, index) for an account, or call(scope, name, [table], internal.<module>.<eraser>) for an internal " +
      "mutation that deletes them a batch at a time and returns { done }). If the table holds nothing of any account's, add " +
      "it to EXEMPT in tests/account-deletion.test.mjs with the reason.",
  );
  for (const name of Object.keys(EXEMPT)) {
    assert.ok(name in tables, `EXEMPT names ${name}, which is no longer in convex/schema.ts. Remove it.`);
    assert.ok(!covered.has(name) || name === "accountDeletions", `${name} is both removed by the registry and exempt. Remove it from EXEMPT.`);
    assert.ok(EXEMPT[name].length > 40, `${name} is exempt without a real reason.`);
  }
  for (const name of covered) assert.ok(name in tables, `convex/account/registry.ts names ${name}, which is not in convex/schema.ts.`);
});

test("each registry line reads its table by an index whose first field holds the case, project or account", () => {
  const tables = schemaTables();
  const registry = createLoader()("convex/account/registry.ts");
  const expected = new Map([
    [registry.caseErasers, "caseId"],
    [registry.projectErasers, "appId"],
    [registry.accountErasers, "account"],
  ]);
  for (const [list, field] of expected) {
    for (const entry of list.filter((row) => row.kind === "rows")) {
      const fields = indexFields(tables[entry.table], entry.index);
      assert.ok(fields, `${entry.table} has no index ${entry.index}`);
      assert.equal(fields[0], entry.field, `${entry.table}.${entry.index} starts with ${fields[0]}, not ${entry.field}`);
      if (entry.field !== field) assert.ok(entry.text || entry.field === field, `${entry.table} links by ${entry.field}; say text: true when it holds the id as text`);
    }
  }
  const names = [...registry.projectErasers, ...registry.accountErasers].filter((entry) => entry.kind !== "rows").map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, "every call and inline entry has its own name");
});

test("the Supermemory namespaces deleted are the ones turtl writes to", () => {
  const read = (path) => readFileSync(join(root, path), "utf8");
  const registry = createLoader()("convex/account/registry.ts");
  const names = registry.namespaces.map((name) => name("apps:7"));
  assert.deepEqual(names, ["app_apps:7", "prefs_apps:7", "reports_apps:7", "code_apps:7"]);
  // The writers name them so; a change there must change registry.ts too.
  assert.match(read("convex/learning/preferences.ts"), /export const preferenceNamespace = \(appId: Id<"apps">\) => `prefs_\$\{appId\}`;/);
  assert.match(read("convex/intake/triage.ts"), /`\$\{process\.env\.INTAKE_NAMESPACE_PREFIX \?\? ""\}reports_\$\{appId\}`\.replace\(\/\[\^a-zA-Z0-9_:-\]\/g, "_"\)\.slice\(0, 100\)/);
  assert.match(read("convex/codeNetwork/schema.ts"), /`code_\$\{projectId\}`/);
  // Every file that writes to Supermemory, and the namespace it writes to. A new writer must add its namespace to
  // registry.namespaces (or write under one of these) and be listed here.
  const writers = {
    "convex/memory/service.ts": /`app_\$\{/,
    "convex/learning/preferences.ts": /preferenceNamespace\(/,
    "convex/intake/triage.ts": /reportsNamespace\(/,
    "convex/codeNetwork/build.ts": /codeNamespace\(/,
  };
  const files = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? (entry.name === "_generated" ? [] : files(join(dir, entry.name))) : /\.ts$/.test(entry.name) ? [join(dir, entry.name)] : []));
  const found = files("convex").filter((file) => /\b(addMemory|putDocument|addDocuments)\(/.test(read(file).replace(/^\s*\/\/.*$/gm, "")) && file !== "convex/supermemory.ts");
  assert.deepEqual(found.sort(), Object.keys(writers).sort(), "a file writes to Supermemory that account deletion does not know about: add its namespace to `namespaces` in convex/account/registry.ts and the file here");
  for (const [file, pattern] of Object.entries(writers)) assert.match(read(file), pattern, file);
});

test("Apple's refresh tokens are read only by internal functions in convex/auth and convex/account", () => {
  const read = (path) => readFileSync(join(root, path), "utf8");
  const files = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? (entry.name === "_generated" ? [] : files(join(dir, entry.name))) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []));
  const touching = [...files("convex"), ...files("app"), ...files("components"), ...files("data")].filter((file) => /authAppleTokens|appleTokens\.tokensOf/.test(read(file)));
  assert.deepEqual(touching.sort(), ["convex/account/registry.ts", "convex/account/vendors.ts", "convex/auth/appleTokens.ts", "convex/auth/schema.ts"]);
  const source = read("convex/auth/appleTokens.ts");
  assert.doesNotMatch(source, /\b(query|mutation|action)\(\{/, "appleTokens.ts registers only internal functions");
});

// ---------------------------------------------------------------------------------------------- the job, in memory

// Convex's ordering, enough for these tables.
function compare(a, b) {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  if (typeof a !== typeof b) return typeof a < typeof b ? -1 : 1;
  return a < b ? -1 : 1;
}
const operators = { eq: (a, b) => a === b, gt: (a, b) => compare(a, b) > 0, gte: (a, b) => compare(a, b) >= 0, lt: (a, b) => compare(a, b) < 0, lte: (a, b) => compare(a, b) <= 0 };

// Every table of the real schema in memory, read only through declared indexes (with _creationTime last, as Convex
// adds it), files in a pretend storage, a scheduler, and mutations that roll back when they throw.
function createBackend(load, { overrides = {}, failDelete = null } = {}) {
  const schema = load("convex/schema.ts").default.tables;
  let tables = new Map(Object.keys(schema).map((name) => [name, []]));
  let files = new Map();
  let scheduled = [];
  let counter = 0;
  let deletes = 0;
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
    for (const name of Object.keys(fields)) assert.ok(name in known, table + " has no field " + name);
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  };
  const builder = (table, fields, conditions, order) => {
    const run = () => {
      const rows = rowsOf(table)
        .filter((row) => conditions.every(([operator, field, value]) => operators[operator](row[field], value)))
        .sort((a, b) => fields.reduce((found, field) => found || compare(a[field], b[field]), 0) || a._creationTime - b._creationTime);
      return structuredClone(order === "desc" ? rows.reverse() : rows);
    };
    return {
      withIndex: (name, build) => {
        const declared = schema[table].export().indexes.find((index) => index.indexDescriptor === name)?.fields;
        assert.ok(declared, table + " has no index " + name);
        const indexed = [...declared, "_creationTime"];
        const found = [];
        const range = Object.fromEntries(Object.keys(operators).map((operator) => [operator, (field, value) => (found.push([operator, field, value]), range)]));
        build?.(range);
        let position = 0;
        for (const [operator, field] of found) {
          assert.equal(field, indexed[position], `${table}.${name} cannot be read by ${field} here`);
          if (operator === "eq") position++;
        }
        return builder(table, indexed, found, order);
      },
      order: (direction) => builder(table, fields, conditions, direction),
      collect: async () => assert.fail("An unbounded collect on " + table),
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
      checked(found.table, Object.fromEntries(Object.entries(next).filter(([key]) => !key.startsWith("_"))));
      found.rows[found.index] = next;
    },
    delete: async (id) => {
      deletes++;
      if (failDelete && failDelete(deletes)) throw new Error("A stand-in failure in the middle of a batch.");
      const found = locate(id);
      assert.ok(found, "No document " + id);
      found.rows.splice(found.index, 1);
    },
    query: (table) => builder(table, [], [], "asc"),
    system: {
      normalizeId: (table, id) => (typeof id === "string" && id.startsWith(table + ":") ? id : null),
      get: async (id) => {
        if (files.has(id)) return { _id: id, size: files.get(id).length };
        const job = scheduled.find((entry) => entry.id === id);
        return job ? { _id: id, name: job.path, state: { kind: "pending" } } : null;
      },
    },
  };
  const storage = {
    delete: async (id) => {
      assert.ok(files.has(id), "No file " + id);
      files.delete(id);
    },
  };
  const scheduler = {
    runAfter: async (delay, fn, args) => scheduler.runAt(Date.now() + delay, fn, args),
    runAt: async (at, fn, args) => {
      const id = `_scheduled_functions:${++counter}`;
      scheduled.push({ id, at, path: fn.path, args: structuredClone(args) });
      return id;
    },
    cancel: async (id) => {
      const index = scheduled.findIndex((entry) => entry.id === id);
      assert.ok(index !== -1, "No pending job " + id);
      cancelled.push(scheduled.splice(index, 1)[0]);
    },
  };
  const definitionOf = (path) => {
    const segments = path.split(".").slice(1);
    const name = segments.pop();
    const definition = load("convex/" + segments.join("/") + ".ts")[name];
    assert.ok(definition?.handler, "No function " + path);
    return definition;
  };
  const calls = [];
  const cancelled = [];
  const call = async (path, args, identity = null) => {
    calls.push(path);
    if (overrides[path]) return await overrides[path](structuredClone(args), api);
    const definition = definitionOf(path);
    const auth = { getUserIdentity: async () => identity };
    if (definition.kind === "action") return await definition.handler(actionCtx(identity), structuredClone(args));
    if (definition.kind === "query") return await definition.handler({ db, auth }, structuredClone(args));
    // A mutation is one transaction: when it throws, nothing it did stays.
    const saved = { tables: structuredClone(tables), files: new Map(files), scheduled: structuredClone(scheduled), counter };
    try {
      return await definition.handler({ db, auth, scheduler, storage }, structuredClone(args));
    } catch (error) {
      ({ tables, files, scheduled, counter } = saved);
      throw error;
    }
  };
  const actionCtx = (identity) => ({
    auth: { getUserIdentity: async () => identity },
    scheduler,
    runQuery: (fn, args) => call(fn.path, args, identity),
    runMutation: (fn, args) => call(fn.path, args, identity),
    runAction: (fn, args) => call(fn.path, args, identity),
  });
  const api = {
    db,
    files: () => files,
    store: (id) => files.set(id, "png bytes"),
    rows: (table) => structuredClone(rowsOf(table)),
    all: () => structuredClone(Object.fromEntries(tables)),
    scheduled: () => scheduled,
    cancelled,
    schedule: (path, args, delay = 0) => scheduler.runAfter(delay, { path }, args),
    calls,
    call,
    // Runs scheduled functions in time order, moving the clock on to each, until none is left.
    drain: async (clock, limit = 2000) => {
      for (let step = 0; step < limit; step++) {
        if (!scheduled.length) return step;
        scheduled.sort((a, b) => a.at - b.at);
        const job = scheduled.shift();
        if (job.at > Date.now()) clock.skip(job.at - Date.now());
        try {
          await call(job.path, job.args);
        } catch (error) {
          // A failed scheduled function is logged by Convex and not retried; the job's own cron picks it up.
          api.failures.push({ path: job.path, error });
        }
      }
      assert.fail("The scheduler never went quiet.");
    },
    failures: [],
  };
  return api;
}

// Date.now, moved on over the job's waits. Servers and tokens in this process see the same time.
function clockFor(t) {
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow.call(Date) + skew;
  t.after(() => {
    Date.now = realNow;
  });
  return { skip: (ms) => (skew += ms) };
}

const VARIABLES = ["AUTH_REQUIRED", "CONVEX_CLOUD_URL", "AUTH_STAND_IN_URL", "AUTH_APPLE_TEAM_ID", "AUTH_APPLE_KEY_ID", "AUTH_APPLE_PRIVATE_KEY", "AUTH_APPLE_BUNDLE_ID", "SUPERMEMORY_API_KEY", "SUPERMEMORY_BASE_URL", "SUPERMEMORY_NAMESPACE_PREFIX", "INTAKE_NAMESPACE_PREFIX"];

async function world(t, { env = {}, overrides, failDelete, mocks } = {}) {
  const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of VARIABLES) delete process.env[name];
  const apple = await startAuthStandIn();
  const memory = await startSupermemoryStandIn();
  t.after(async () => {
    await apple.close();
    await memory.close();
    for (const name of VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  Object.assign(process.env, {
    AUTH_REQUIRED: "true",
    AUTH_STAND_IN_URL: apple.url,
    AUTH_APPLE_TEAM_ID: apple.appleClient.teamId,
    AUTH_APPLE_KEY_ID: apple.appleClient.keyId,
    AUTH_APPLE_PRIVATE_KEY: apple.appleClient.privateKey.replace(/\n/g, " "),
    SUPERMEMORY_API_KEY: memory.apiKey,
    SUPERMEMORY_BASE_URL: memory.url,
    // Stand-in addresses are honoured with accounts on only on a local backend (convex/demoSettings.ts).
    CONVEX_CLOUD_URL: "http://127.0.0.1:3210",
    ...env,
  });
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete process.env[name];
  const load = createLoader(mocks);
  const backend = createBackend(load, { overrides, failDelete });
  const clock = clockFor(t);
  return { load, backend, apple, memory, clock, registry: load("convex/account/registry.ts") };
}

// One account with a row in every table the deletion reaches, each pointing at that account's project, case, account
// or sign-in records. Returns every id it made, so a test can look for any of them afterwards.
async function seedAccount({ backend, registry, apple, memory }, label, installationId) {
  const { db } = backend;
  const made = [];
  const add = async (table, fields) => {
    const id = await db.insert(table, fields);
    made.push(id);
    return id;
  };
  const email = `${label}@example.com`;
  const user = await add("users", { email, name: label });
  const method = await add("authAccounts", { userId: user, provider: "password", providerAccountId: email, secret: "scrypt-hash" });
  await add("authVerificationCodes", { accountId: method, provider: "password-reset", code: "hashed-code", expirationTime: Date.now() + 60_000 });
  await add("authRateLimits", { identifier: method, lastAttemptTime: Date.now(), attemptsLeft: 9 });
  await add("authRateLimits", { identifier: email, lastAttemptTime: Date.now(), attemptsLeft: 9 });
  const session = await add("authSessions", { userId: user, expirationTime: Date.now() + 86_400_000 });
  const parent = await add("authRefreshTokens", { sessionId: session, expirationTime: Date.now() + 86_400_000 });
  await add("authRefreshTokens", { sessionId: session, expirationTime: Date.now() + 86_400_000, parentRefreshTokenId: parent });
  await add("authVerifiers", { sessionId: session, signature: `verifier-${label}` });
  // Signed in with Apple too: the refresh token comes from the stand-in, as from a real sign-in.
  const appleUser = `001234.${label}.0001`;
  const code = apple.issueAppleCode(appleUser);
  const response = await fetch(`${apple.url}/apple/auth/token`, { method: "POST", body: new URLSearchParams({ client_id: "com.turtl.oncall", client_secret: await clientSecretFor(apple), code, grant_type: "authorization_code" }) });
  const refreshToken = (await response.json()).refresh_token;
  await add("authAppleTokens", { userId: user, refreshToken, storedAt: Date.now() });

  const appId = await add("apps", { name: `${label}'s shop`, ownerId: user, repoUrl: `https://github.com/${label}/shop`, productionUrl: `https://${label}.example.com` });
  const caseId = await add("cases", { appId, title: "Checkout is down", impact: "Nobody can pay.", kind: "outage", raisedBy: "monitor", status: "waiting_for_owner" });
  const closedCase = await add("cases", { appId, title: "Old outage", impact: "Fixed.", kind: "outage", raisedBy: "monitor", status: "resolved" });
  const value = { case: caseId, project: appId, account: user };
  const fileOf = new Map();
  const seed = async (scope, entry, target) => {
    const fields = { [entry.field]: target };
    if (entry.file) {
      const file = `_storage:${label}-${made.length}`;
      backend.store(file);
      made.push(file);
      fields[entry.file] = file;
      fileOf.set(entry.table, file);
    }
    if (entry.table === "reportTriage") fields.status = scope === "case" ? "done" : "pending";
    if (entry.table === "codeNetworks") fields.namespace = `code_${appId}`;
    await add(entry.table, fields);
  };
  for (const entry of registry.caseErasers.filter((row) => row.kind === "rows")) {
    await seed("case", entry, caseId);
    await seed("case", entry, closedCase);
  }
  for (const entry of registry.projectErasers.filter((row) => row.kind === "rows")) await seed("project", entry, value.project);
  // A password account still waiting to confirm its address reads as signed out, so it cannot ask to be deleted the way
  // these tests do; the sweep and "start over" delete one (tests/email-codes.test.mjs). Its hold is added by hold(),
  // once the request is in, so the job is seen to remove it too.
  for (const entry of registry.accountErasers.filter((row) => row.kind === "rows" && row.table !== "authUnconfirmed")) await seed("account", entry, user);
  const hold = async () => await add("authUnconfirmed", { account: user, since: Date.now() });
  // The report form's key and its rate-limit windows, per key and per sender.
  const key = await add("intakeKeys", { appId, key: `key-${label}`, createdAt: Date.now() });
  await add("intakeRateWindows", { bucket: `key-minute:${key}`, windowStart: 1, count: 3 });
  await add("intakeRateWindows", { bucket: `key-day:${key}`, windowStart: 1, count: 3 });
  await add("intakeRateWindows", { bucket: `sender-10min:${appId}:form:device:${label}-phone`, windowStart: 1, count: 1 });
  await add("intakeRateWindows", { bucket: `sender-10min:${appId}:form:contact-keyed:abc`, windowStart: 2, count: 1 });
  // Connect GitHub: one installation only this account uses.
  await add("githubInstallations", { installationId, accountLogin: label, repositorySelection: "selected", status: "active", updatedAt: 1 });
  await add("githubInstallationRepositories", { installationId, fullName: `${label}/shop`, fullNameLower: `${label}/shop`, seenAt: 1 });
  await add("githubInstallationTokens", { installationId, token: `ghs_${label}`, expiresAt: Date.now() + 3_600_000 });
  const attempt = await add("githubConnectAttempts", { account: user, stateHash: `state-${label}`, codeVerifier: "", returnTo: "turtl://add-project", status: "finished", expiresAt: 1 });
  await add("githubInstallationLinks", { account: user, installationId, attemptId: attempt, active: true, githubUserId: installationId * 10, githubLogin: label, confirmedAt: 1 });
  // An AI permission in force, and the copies at Supermemory.
  await db.patch(made.find((id) => id.startsWith("aiConsents:") && backendRow(backend, id)?.account === user), { answer: "allowed", services: [], listVersion: "v", answeredAt: 1 });
  const names = [...registry.namespaces.map((name) => name(appId))];
  for (const name of names) memory.hold(name, 3);
  return { user, email, session, method, appId, caseId, closedCase, refreshToken, made, names, installationId, hold, identity: { subject: `${user}|${session}` } };
}

const backendRow = (backend, id) => backend.rows(id.split(":")[0]).find((row) => row._id === id);

async function clientSecretFor(apple) {
  const { importPKCS8, SignJWT } = await import("jose");
  const key = await importPKCS8(apple.appleClient.privateKey, "ES256");
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: apple.appleClient.keyId }).setIssuer(apple.appleClient.teamId).setSubject("com.turtl.oncall").setAudience("https://appleid.apple.com").setIssuedAt(now).setExpirationTime(now + 300).sign(key);
}

// GitHub's disconnect, as convex/github/connect.ts does it, without GitHub: the first call fails the way an
// unreachable GitHub does, the next removes the account's links and attempts and marks the installation deleted.
function githubStandIn() {
  const seen = [];
  let failures = 1;
  const disconnect = async ({ account }, backend) => {
    seen.push(account);
    if (failures-- > 0) return { ok: false, disconnected: 0, failed: [{ installationId: 0, message: "GitHub could not be reached." }] };
    const links = backend.rows("githubInstallationLinks").filter((row) => row.account === account);
    for (const link of links) {
      for (const table of ["githubInstallationRepositories", "githubInstallationTokens"]) for (const row of backend.rows(table).filter((r) => r.installationId === link.installationId)) await backend.db.delete(row._id);
      const installation = backend.rows("githubInstallations").find((row) => row.installationId === link.installationId);
      await backend.db.patch(installation._id, { status: "deleted" });
      await backend.db.delete(link._id);
    }
    for (const row of backend.rows("githubConnectAttempts").filter((r) => r.account === account)) await backend.db.delete(row._id);
    return { ok: true, disconnected: links.length, failed: [] };
  };
  return { seen, disconnect };
}

const message = (error) => error?.data ?? error?.message;
// An id or a word, found only whole: "apps:5" is not in "apps:50".
const mentions = (text, marker) => new RegExp(`(?<![A-Za-z0-9_])${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`).test(text);

test("deleting an account removes every row of it in every table, its files, and its copies at vendors; another account's stay", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
  const github = githubStandIn();
  const w = await world(t, { overrides: { "internal.github.connect.disconnectAccount": (args, backend) => github.disconnect(args, backend) } });
  const { backend, apple, memory, clock } = w;
  const alice = await seedAccount(w, "alice", 8001);
  const bob = await seedAccount(w, "bob", 8002);
  const before = backend.all();
  const access = w.load("convex/access.ts");
  const as = (who) => ({ db: backend.db, auth: { getUserIdentity: async () => who.identity } });
  assert.equal(await access.requireAccount(as(alice)), alice.user);

  const { request } = w.load("convex/account/deletion.ts");
  const accepted = await backend.call("api.account.deletion.request", {}, alice.identity);
  assert.equal(typeof accepted.requestedAt, "number");
  void request;
  await alice.hold();

  // From the moment it is accepted: the session has ended, nobody can sign in to it, and the AI permission is back.
  await assert.rejects(access.requireAccount(as(alice)), (error) => message(error) === "Sign in to continue.");
  assert.equal(await access.signedInAccount(as(alice)), null);
  assert.equal(await access.requireAccount(as(bob)), bob.user, "the other account is still signed in");
  assert.equal(backend.rows("authAccounts").filter((row) => row.userId === alice.user).length, 0, "no way left to sign in");
  assert.ok(backend.rows("aiConsents").find((row) => row.account === alice.user).withdrawnAt, "the AI permission is taken back");
  assert.deepEqual(backend.scheduled().map((job) => job.path).sort(), ["internal.account.deletion.run", "internal.push.devices.removeAccount"]);
  // Asking twice does nothing new.
  await assert.rejects(backend.call("api.account.deletion.request", {}, alice.identity), (error) => message(error) === "Sign in to continue.");

  await backend.drain(clock);
  assert.deepEqual(backend.failures, []);

  // Nothing anywhere names anything of Alice's: not her ids, her email, her session, her token, her files.
  const markers = [...alice.made, alice.email, alice.refreshToken, ...alice.names];
  const after = backend.all();
  for (const [table, rows] of Object.entries(after)) {
    for (const row of rows) {
      const text = JSON.stringify(row);
      // A GitHub installation turtl uninstalled keeps its row, marked deleted, without the login it was on.
      if (table === "githubInstallations" && row.installationId === alice.installationId) {
        assert.deepEqual({ status: row.status, accountLogin: row.accountLogin }, { status: "deleted", accountLogin: "" });
        continue;
      }
      for (const marker of markers) assert.ok(!mentions(text, marker), `${table} still holds ${marker}: ${text}`);
    }
  }
  assert.ok(![...backend.files().keys()].some((file) => file.startsWith("_storage:alice")), "Alice's screenshots are deleted from storage");
  // Bob's rows are exactly as they were.
  for (const [table, rows] of Object.entries(before)) {
    const bobs = rows.filter((row) => bob.made.includes(row._id));
    for (const row of bobs) assert.deepEqual(after[table].find((other) => other._id === row._id), row, `${table} ${row._id} of the other account changed`);
  }
  assert.ok([...backend.files().keys()].some((file) => file.startsWith("_storage:bob")));

  // Supermemory deleted Alice's namespaces and only hers; Apple revoked her token and only hers; GitHub was asked again after failing.
  assert.deepEqual(memory.deleted.sort(), [...new Set(alice.names)].sort());
  assert.ok(bob.names.every((name) => memory.held.has(name)));
  assert.deepEqual(apple.appleRevoked, [{ token: alice.refreshToken, hint: "refresh_token" }]);
  assert.deepEqual(github.seen, [alice.user, alice.user], "the GitHub disconnect failed once and was retried");
  assert.deepEqual(errors, [`Account deletion ${backend.rows("accountDeletions")[0]._id}: github did not confirm (try 1); it is tried again later.`]);

  // The record: done, and nothing personal in it.
  const [record] = backend.rows("accountDeletions");
  assert.equal(record.status, "done");
  assert.equal(record.account, undefined);
  assert.equal(record.accountHash, createHash("sha256").update(alice.user).digest("hex"));
  for (const marker of markers) assert.ok(!mentions(JSON.stringify(record), marker));
  assert.deepEqual(record.removed.projects, 1);
  assert.deepEqual(record.removed.cases, 2);
  assert.ok(record.vendors.every((task) => task.state !== "pending" && task.target === undefined));
  const lookup = await backend.call("internal.account.deletion.lookup", { account: alice.user });
  assert.equal(lookup.status, "done");
  assert.ok(lookup.finishedAt >= lookup.requestedAt);

  // Running it again changes nothing.
  const settled = backend.all();
  await backend.call("internal.account.deletion.run", { deletionId: record._id });
  await backend.drain(clock);
  assert.deepEqual(backend.all(), settled);
});

test("before it waits, the job closes open cases, cancels their scheduled steps, and switches off the monitor and the report form", async (t) => {
  const w = await world(t, { overrides: { "internal.github.connect.disconnectAccount": async () => ({ ok: true, disconnected: 0, failed: [] }) } });
  const { backend } = w;
  const alice = await seedAccount(w, "alice", 8001);
  // A step the runner dispatched and that has not started: its run and its time limit, kept on the attempt.
  const steps = backend.rows("steps").filter((row) => row.caseId === alice.caseId);
  const execute = await backend.schedule("internal.runner.run.execute", { attemptId: "pending" }, 1_000);
  const timeout = await backend.schedule("internal.runner.run.checkTimeout", { attemptId: "pending" }, 60_000);
  await backend.db.insert("stepAttempts", { caseId: alice.caseId, stepId: steps[0]._id, attempt: 1, status: "running", scheduledJobs: [execute, timeout] });
  await backend.call("api.account.deletion.request", {}, alice.identity);
  // Run only the first part: the stop, up to the wait.
  const job = backend.scheduled().find((entry) => entry.path === "internal.account.deletion.run");
  await backend.call(job.path, job.args);
  const [record] = backend.rows("accountDeletions");
  assert.equal(record.stage, "settle");
  assert.ok(record.settleUntil - Date.now() > 10 * 60_000, "it waits out every action that could still be running");
  assert.equal(backend.rows("cases").find((row) => row._id === alice.caseId).status, "declined");
  assert.deepEqual(backend.cancelled.map((job) => job.path), ["internal.runner.run.execute", "internal.runner.run.checkTimeout"], "the step it had scheduled is cancelled");
  assert.equal(backend.rows("cases").find((row) => row._id === alice.closedCase).status, "resolved");
  assert.equal(backend.rows("journeys").filter((row) => row.appId === alice.appId).length, 0, "the monitor has nothing to check");
  assert.equal(backend.rows("permissions").filter((row) => row.appId === alice.appId).length, 0, "no standing permission to act on");
  assert.ok(backend.rows("intakeKeys").filter((row) => row.appId === alice.appId).every((row) => row.revokedAt), "the report form refuses");
  assert.equal(backend.rows("reportTriage").filter((row) => row.appId === alice.appId && row.status === "pending").length, 0, "no report waits for a model");
  assert.ok(backend.rows("authSessions").filter((row) => row.userId === alice.user).every((row) => row.expirationTime === 0));
  assert.ok(backend.scheduled().some((entry) => entry.path === "internal.account.deletion.run" && entry.at === record.settleUntil));
});

test("a failure half way rolls back that batch only, and the job resumes and finishes", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
  const w = await world(t, {
    overrides: { "internal.github.connect.disconnectAccount": async () => ({ ok: true, disconnected: 0, failed: [] }) },
    failDelete: (count) => count === 40,
  });
  const { backend, clock } = w;
  const alice = await seedAccount(w, "alice", 8001);
  const bob = await seedAccount(w, "bob", 8002);
  await backend.call("api.account.deletion.request", {}, alice.identity);
  await backend.drain(clock);
  assert.ok(errors.some((line) => /Account deletion .* stopped .*stand-in failure.*resumes in 5 minutes/.test(line)), errors.join("\n"));
  const [record] = backend.rows("accountDeletions");
  assert.equal(record.status, "done");
  assert.equal(record.lastError, undefined);
  for (const [table, rows] of Object.entries(backend.all())) {
    if (table.startsWith("github")) continue; // GitHub is a stand-in that removes nothing here
    for (const row of rows) assert.ok(!alice.made.some((id) => mentions(JSON.stringify(row), id)), `${table} still holds Alice's ${row._id}`);
  }
  assert.ok(backend.rows("apps").some((row) => row._id === bob.appId));
});

test("a stalled job is restarted by the cron, and only one driver works at a time", async (t) => {
  const w = await world(t, { overrides: { "internal.github.connect.disconnectAccount": async () => ({ ok: true, disconnected: 0, failed: [] }) } });
  const { backend, clock } = w;
  const alice = await seedAccount(w, "alice", 8001);
  await backend.call("api.account.deletion.request", {}, alice.identity);
  const [record] = backend.rows("accountDeletions");
  // Two drivers at once: the second finds the first's lease and stands back.
  await backend.db.patch(record._id, { lease: { driver: "one", until: Date.now() + 9 * 60_000 } });
  assert.deepEqual(await backend.call("internal.account.deletion.next", { deletionId: record._id, driver: "two" }), { kind: "busy" });
  assert.equal(backend.rows("accountDeletions")[0].stage, "stop", "the second driver changed nothing");
  // The scheduled run is lost; nothing happens until the cron sees the job has not moved for a while.
  backend.scheduled().length = 0;
  assert.equal(await backend.call("internal.account.deletion.resumeStalled", {}), 0);
  clock.skip(20 * 60_000);
  assert.equal(await backend.call("internal.account.deletion.resumeStalled", {}), 1);
  await backend.drain(clock);
  assert.equal(backend.rows("accountDeletions")[0].status, "done");
  assert.equal(backend.rows("apps").length, 0);
});

test("a registry call entry is called until it says done, once per project", async (t) => {
  const seen = [];
  const realRegistry = createLoader()("convex/account/registry.ts");
  const registry = {
    ...realRegistry,
    projectErasers: [...realRegistry.projectErasers, realRegistry.call("project", "test.settings", ["councilSettings"], ref("internal.test.erase.project"))],
  };
  registry.callEntry = (scope, name) => (scope === "project" ? registry.projectErasers : registry.accountErasers).find((entry) => entry.kind === "call" && entry.name === name);
  const w = await world(t, {
    mocks: { "convex/account/registry": registry },
    overrides: {
      "internal.github.connect.disconnectAccount": async () => ({ ok: true, disconnected: 0, failed: [] }),
      // A module's eraser that deletes one row a call.
      "internal.test.erase.project": async ({ appId }, backend) => {
        seen.push(appId);
        const row = backend.rows("councilSettings").find((r) => r.appId === appId);
        if (row) await backend.db.delete(row._id);
        return { done: seen.length >= 3 };
      },
    },
  });
  const { backend, clock } = w;
  const alice = await seedAccount({ ...w, registry: realRegistry }, "alice", 8001);
  await backend.db.insert("councilSettings", { appId: alice.appId, members: [], maxCostUsd: 1, updatedAt: 1 });
  await backend.call("api.account.deletion.request", {}, alice.identity);
  await backend.drain(clock);
  assert.deepEqual(seen, [alice.appId, alice.appId, alice.appId], "called again until it said done, then not again");
  assert.equal(backend.rows("councilSettings").length, 0);
  assert.equal(backend.rows("accountDeletions")[0].status, "done");
});

test("the single-owner demo has no account to delete, and a signed-out caller is refused", async (t) => {
  const w = await world(t, { env: { AUTH_REQUIRED: undefined } });
  await assert.rejects(w.backend.call("api.account.deletion.request", {}, null), (error) => message(error) === "This turtl has no accounts, so there is no account to delete.");
  assert.equal(w.backend.rows("accountDeletions").length, 0);
  process.env.AUTH_REQUIRED = "true";
  await assert.rejects(w.backend.call("api.account.deletion.request", {}, null), (error) => message(error) === "Sign in to continue.");
});

test("an ended session signs nobody in, though its token has not expired; demo and actions are unchanged", async () => {
  const access = createLoader()("convex/access.ts");
  const sessions = { "authSessions:1": { _id: "authSessions:1", expirationTime: Date.now() + 60_000 }, "authSessions:2": { _id: "authSessions:2", expirationTime: 0 } };
  // No account here waits to confirm its email address (authUnconfirmed is empty; tests/email-codes.test.mjs covers that).
  const noHold = { withIndex: () => ({ first: async () => null }) };
  const db = { normalizeId: (table, id) => (id.startsWith(table + ":") ? id : null), get: async (id) => sessions[id] ?? null, query: (table) => (assert.equal(table, "authUnconfirmed"), noHold) };
  const as = (subject, withDb = true) => ({ ...(withDb && { db }), auth: { getUserIdentity: async () => ({ subject }) } });
  const saved = process.env.AUTH_REQUIRED;
  process.env.AUTH_REQUIRED = "true";
  try {
    assert.equal(await access.signedInAccount(as("users:7|authSessions:1")), "users:7");
    assert.equal(await access.signedInAccount(as("users:7|authSessions:2")), null, "an expired session");
    assert.equal(await access.signedInAccount(as("users:7|authSessions:3")), null, "a deleted session");
    assert.equal(await access.signedInAccount(as("users:7|authSessions:3", false)), "users:7", "an action has no database and asks through internal.access");
    assert.equal(await access.signedInAccount(as("alice|session-1")), "alice", "a subject that names no session is read as before");
  } finally {
    if (saved === undefined) delete process.env.AUTH_REQUIRED;
    else process.env.AUTH_REQUIRED = saved;
  }
});

// ---------------------------------------------------------------------------------------------- the screen

test("Delete account sits under Sign out for a signed-in account only, says what goes, and asks once more", () => {
  const read = (path) => readFileSync(join(root, path), "utf8");
  const section = read("components/account/AccountSection.tsx");
  assert.match(section, /if \(status !== "signedIn"\) return null;/, "nothing in the demo or the example build, where nobody is signed in");
  assert.ok(section.indexOf('testID="account-sign-out"') < section.indexOf("<DeleteAccount />"), "under Sign out");
  // The account sheet behind Home's profile picture shows the same section.
  assert.match(read("components/account/ProfileButton.tsx"), /<AccountSection heading=\{false\} \/>/);

  const screen = read("components/account/DeleteAccount.tsx");
  const DELETED = [.../export const DELETED = \[([\s\S]*?)\] as const;/.exec(screen)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const said = DELETED.join(" | ");
  const items = { projects: /projects/, cases: /case/, "the map of the code": /map of your code/, screenshots: /Screenshots/, "customers' reports": /reports your customers sent/, "GitHub access": /access to your GitHub/, "this phone's notifications": /Notifications on this phone/, memory: /remembers/ };
  for (const [what, pattern] of Object.entries(items)) assert.match(said, pattern, `the list says ${what} goes`);
  assert.match(screen, /This can't be undone\./);
  // Two taps: Continue, then Yes. Each control has a testID; Button gives each the button role.
  assert.ok(screen.indexOf('testID="account-delete-continue"') < screen.indexOf('testID="account-delete-confirm"'));
  for (const id of ["account-delete", "account-delete-continue", "account-delete-cancel", "account-delete-confirm", "account-delete-keep"]) assert.match(screen, new RegExp(`testID="${id}"`));
  assert.deepEqual([...screen.matchAll(/font="(\w+)"/g)].map((match) => match[1]), ["text"], "only the error, which may arrive without a full stop, sets its face by hand");

  // The type rule: the list's items are labels (Righteous); the sentences around them are Capriola.
  const { faceFor } = createLoader()("components/ui/typeface.ts");
  for (const item of DELETED) assert.equal(faceFor(item), "title", item);
  const sentences = ["Deleting your account removes all of this from turtl, and from the services turtl uses to keep it.", "This can't be undone.", "Delete your account and everything in it now? You won't be able to get any of it back."];
  for (const sentence of sentences) {
    assert.ok(screen.includes(sentence), sentence);
    assert.equal(faceFor(sentence), "text", sentence);
  }
});

test("deleting asks the backend first, then signs out to Login, which shows one line saying the account is being deleted", () => {
  const read = (path) => readFileSync(join(root, path), "utf8");
  const live = read("data/account/live.ts");
  const action = live.slice(live.indexOf("deleteAccount: async () => {"));
  assert.ok(action.indexOf("api.account.deletion.request") < action.indexOf("setSignedOutNotice(notices.deleting)"));
  assert.ok(action.indexOf("setSignedOutNotice(notices.deleting)") < action.indexOf("await signOut();"));
  assert.match(read("data/account/example.ts"), /deleteAccount: nothing/, "the example build deletes nothing");
  assert.match(live, /authorizationCode: credential\.authorizationCode/, "Sign in with Apple hands the backend the code it trades for the token to revoke");
  const { words } = createLoader()("data/account/notice.ts");
  assert.equal(words.deleting, "Your account is being deleted. turtl is removing everything it kept for it.");
  const { faceFor } = createLoader()("components/ui/typeface.ts");
  assert.equal(faceFor(words.deleting), "text");
  const login = read("app/index.tsx");
  assert.ok(login.indexOf("<DeleteAccountNotice />") < login.indexOf('testID="login-enter"'), "above Login's buttons");
  assert.match(read("components/account/DeleteAccountNotice.tsx"), /if \(!notice\) return null;/);
});
