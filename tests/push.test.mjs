import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import ts from "typescript";
import { startExpoPushStub } from "./fixtures/expo-push-stub.mjs";

// convex/push's real functions against an in-memory copy of its tables and tests/fixtures/expo-push-stub.mjs, a
// stand-in for Expo's push service served over HTTP in this process; and data/push's controller against a fake
// phone and backend. Nothing here talks to Expo.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const VARIABLES = ["AUTH_REQUIRED", "EXPO_PUSH_API_URL", "EXPO_ACCESS_TOKEN", "KEIKI_API_KEY", "KEIKI_AGENT_ID", "KEIKI_OWNER_CONTACT", "CONVEX_CLOUD_URL"];
const CASE = "jd7a0b1c2d3e4f5g6h7j8k9m0n1p2q3r";
const TOKEN = (name) => `ExponentPushToken[${name}]`;

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
      if (name in mocks) return mocks[name];
      if (!name.startsWith(".")) return nodeRequire(name);
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

// The one index outside convex/push that these functions read, as convex/schema.ts declares it.
const OTHER_INDEXES = { ownerNotices: { by_case_and_event: ["caseId", "event"] } };

// An in-memory database. Push tables are checked against convex/push/schema.ts: only named fields, only declared
// indexes, read by their fields in order. A patch with an undefined field removes it, as Convex does.
function createBackend(load, identity) {
  const schema = load("convex/push/schema.ts").pushTables;
  const tables = new Map();
  const scheduled = [];
  let counter = 0;
  const rowsOf = (table) => (tables.has(table) ? tables.get(table) : tables.set(table, []).get(table));
  const checked = (table, fields) => {
    if (schema[table]) for (const name of Object.keys(fields)) assert.ok(name in schema[table].validator.fields, `${table} has no field ${name}`);
    return fields;
  };
  const locate = (id) => {
    for (const rows of tables.values()) {
      const index = rows.findIndex((row) => row._id === id);
      if (index !== -1) return { rows, index };
    }
    return null;
  };
  const db = {
    // Ids here are "<table><n>aaaaaaaa"; the subject's session part ("session") names no session row.
    normalizeId: (table, id) => (typeof id === "string" && new RegExp(`^${table}\\d+a+$`).test(id) ? id : null),
    get: async (id) => structuredClone(locate(id)?.rows[locate(id).index] ?? null),
    insert: async (table, fields) => {
      const row = { _id: `${table}${++counter}aaaaaaaa`, _creationTime: Date.now(), ...checked(table, structuredClone(fields)) };
      rowsOf(table).push(row);
      return row._id;
    },
    patch: async (id, fields) => {
      const found = locate(id);
      assert.ok(found, "No document " + id);
      const next = { ...found.rows[found.index], ...fields };
      for (const [key, value] of Object.entries(fields)) if (value === undefined) delete next[key];
      checked(id.replace(/\d+a+$/, ""), fields);
      found.rows[found.index] = structuredClone(next);
    },
    delete: async (id) => {
      const found = locate(id);
      assert.ok(found, "No document " + id);
      found.rows.splice(found.index, 1);
    },
    query: (table) => ({
      // The single-owner demo first checks that Convex Auth's accounts table is empty (convex/access.ts).
      first: async () => structuredClone(rowsOf(table)[0] ?? null),
      withIndex: (name, build) => {
        const fields = schema[table]?.export().indexes.find((index) => index.indexDescriptor === name)?.fields ?? OTHER_INDEXES[table]?.[name];
        assert.ok(fields, `${table} has no index ${name}`);
        const conditions = [];
        const range = {
          eq: (field, value) => (conditions.push(["eq", field, value]), range),
          gt: (field, value) => (conditions.push(["gt", field, value]), range),
        };
        build(range);
        conditions.forEach(([, field], position) => assert.equal(field, fields[position], `${table}.${name} cannot be read by ${field} here`));
        let descending = false;
        const matched = () => {
          const rows = rowsOf(table).filter((row) => conditions.every(([op, field, value]) => (op === "eq" ? row[field] === value : row[field] !== undefined && row[field] > value)));
          const key = fields.find((field) => !conditions.some(([, f]) => f === field));
          const sorted = key ? [...rows].sort((a, b) => (a[key] ?? -Infinity) - (b[key] ?? -Infinity)) : rows;
          return structuredClone(descending ? sorted.reverse() : sorted);
        };
        const query = {
          order: (direction) => ((descending = direction === "desc"), query),
          first: async () => matched()[0] ?? null,
          take: async (count) => matched().slice(0, count),
          unique: async () => {
            const rows = matched();
            assert.ok(rows.length <= 1, `unique() matched ${rows.length} rows`);
            return rows[0] ?? null;
          },
        };
        return query;
      },
    }),
  };
  const auth = { getUserIdentity: async () => (identity.current ? { subject: `${identity.current}|session` } : null) };
  const scheduler = { runAfter: async (delay, fn, args) => void scheduled.push({ delay, path: fn.path, args: structuredClone(args) }) };
  async function run(path, args = {}) {
    const segments = path.split(".").slice(1);
    const name = segments.pop();
    const fn = load("convex/" + segments.join("/") + ".ts")[name];
    assert.ok(fn?.handler, "No function " + path);
    const ctx = fn.kind === "action" ? actionCtx : { db, auth, scheduler };
    return structuredClone((await fn.handler(ctx, structuredClone(args))) ?? null);
  }
  const actionCtx = { auth, scheduler, runQuery: (fn, args) => run(fn.path, args), runMutation: (fn, args) => run(fn.path, args) };
  return {
    db,
    run,
    scheduled,
    rows: (table) => structuredClone(rowsOf(table)),
    async next(path) {
      const index = scheduled.findIndex((job) => job.path === path);
      assert.notEqual(index, -1, "Nothing scheduled for " + path);
      const [job] = scheduled.splice(index, 1);
      return { job, result: await run(job.path, job.args) };
    },
  };
}

async function world(t, { accounts = false } = {}) {
  const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of VARIABLES) delete process.env[name];
  const stub = await startExpoPushStub();
  t.after(async () => {
    await stub.close();
    for (const name of VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  process.env.EXPO_PUSH_API_URL = stub.url;
  // With accounts on, the stand-in address is honoured only on a local backend (convex/demoSettings.ts), as these run.
  process.env.CONVEX_CLOUD_URL = "http://127.0.0.1:3210";
  if (accounts) process.env.AUTH_REQUIRED = "true";
  const identity = { current: null };
  const load = createLoader();
  const backend = createBackend(load, identity);
  const as = (account) => (identity.current = account);
  const call = (path, args) => backend.run(path, args);
  const seed = async (name, ownerId) => {
    const appId = await backend.db.insert("apps", { name, ...(ownerId ? { ownerId } : {}) });
    const caseId = await backend.db.insert("cases", { appId, title: "Customer wrote: card 4242 charged twice", impact: "TypeError: x is undefined at pay.ts:9", kind: "bug_report", raisedBy: "customer", status: "waiting_for_owner" });
    return { appId, caseId };
  };
  const notice = async (caseId, event) => backend.db.insert("ownerNotices", { caseId, event, outcome: "pending", observedAt: Date.now() });
  return { stub, load, backend, as, call, seed, notice };
}

// ——— What a notification says ———

test("a notification names the project, says a case needs the owner, and carries only the case id", () => {
  const { pushMessage, expoMessages, PUSH_BODIES, sendsPush } = createLoader()("convex/push/message.ts");
  const message = pushMessage({ projectName: "Booking app", caseId: CASE, event: "needs_decision" });
  assert.deepEqual(message, { title: "Booking app", body: "A case needs your decision. Open it to approve or decline a fix.", data: { caseId: CASE } });
  assert.deepEqual(expoMessages(message, [TOKEN("a")]), [{ to: TOKEN("a"), title: "Booking app", body: message.body, data: { caseId: CASE }, sound: "default", priority: "high" }]);
  assert.match(pushMessage({ projectName: "Booking app", caseId: CASE, event: "handled_under_permission" }).body, /fix you allowed ran/);
  assert.deepEqual(Object.keys(PUSH_BODIES).sort(), ["handled_under_permission", "needs_decision"]);
  assert.equal(sendsPush("opened"), false, "a new case does not interrupt the owner; a decision follows if one is needed");
  assert.equal(pushMessage({ projectName: "Booking app", caseId: CASE, event: "opened" }), null);
  assert.equal(pushMessage({ projectName: "Booking app", caseId: CASE, event: "toString" }), null);
  assert.equal(pushMessage({ projectName: "Booking app", caseId: "../../settings", event: "needs_decision" }), null);
  for (const body of Object.values(PUSH_BODIES)) assert.doesNotMatch(body, /free|offer|upgrade|new feature|try|sale|discount/i, "no notification is promotional");
});

test("nothing variable but the project name and the case id can reach a notification", () => {
  const source = readFileSync(resolve(root, "convex/push/message.ts"), "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m, "message.ts imports nothing, so no other data can flow into it");
  const { pushMessage, expoMessages, PUSH_BODIES, FALLBACK_TITLE } = createLoader()("convex/push/message.ts");
  const secrets = ["SECRET-customer-words", "TypeError: boom at x.ts:1", "sk_live_123", "const a = 1;"];
  const fixed = new Set([...Object.values(PUSH_BODIES), "default", "high", FALLBACK_TITLE]);
  for (let i = 0; i < 200; i++) {
    const projectName = `Project ${i} ${"x".repeat(i % 70)}\n\u0007${i % 3 ? "" : "  tabs\t"}`;
    const event = i % 2 ? "needs_decision" : "handled_under_permission";
    const input = { projectName, caseId: CASE, event, text: secrets[0], title: secrets[1], body: secrets[2], data: { code: secrets[3] }, impact: secrets[1] };
    const [message] = expoMessages(pushMessage(input), [TOKEN("phone")]);
    const json = JSON.stringify(message);
    for (const secret of secrets) assert.ok(!json.includes(secret), `"${secret}" reached the notification`);
    assert.deepEqual(Object.keys(message).sort(), ["body", "data", "priority", "sound", "title", "to"]);
    assert.deepEqual(Object.keys(message.data), ["caseId"]);
    assert.ok(fixed.has(message.body));
    assert.ok(message.title.startsWith(`Project ${i}`) && message.title.length <= 60 && !/[\u0000-\u001f]/.test(message.title));
  }
  assert.equal(pushMessage({ projectName: " \n\t", caseId: CASE, event: "needs_decision" }).title, FALLBACK_TITLE);
  assert.equal(pushMessage({ projectName: "a".repeat(200), caseId: CASE, event: "needs_decision" }).title, "a".repeat(59) + "…");
});

// ——— notices.ts: one push per case event, beside the unchanged text path ———

test("an owner notice schedules a push only for events where the owner must act, and the text path is unchanged", async (t) => {
  const w = await world(t);
  const { caseId } = await w.seed("Booking app", "solo-owner");
  for (const event of ["opened", "needs_decision", "handled_under_permission"]) {
    const result = await w.call("internal.notices.notifyOwner", { caseId, event, text: "for the Keiki agent" });
    assert.deepEqual(result, { outcome: "not_configured" }, "the text path reports as before");
  }
  assert.deepEqual(w.backend.rows("ownerNotices").map((row) => [row.event, row.outcome]), [["opened", "not_configured"], ["needs_decision", "not_configured"], ["handled_under_permission", "not_configured"]]);
  assert.deepEqual(w.backend.scheduled.map((job) => [job.path, job.args.event, job.delay]), [
    ["internal.push.deliver.forNotice", "needs_decision", 0],
    ["internal.push.deliver.forNotice", "handled_under_permission", 0],
  ]);
  assert.equal(await w.call("internal.notices.notifyOwner", { caseId, event: "needs_decision", text: "again" }), null, "a case event notifies once");
  assert.equal(w.backend.scheduled.length, 2);
});

// ——— Phones: register, refresh, remove, read; each asks convex/access.ts ———

test("the demo files every phone under the one owner and shows the row only where accounts are on", async (t) => {
  const w = await world(t);
  assert.deepEqual(await w.call("api.push.devices.status", {}), { accountsMode: false, signedIn: true, registered: false });
  await w.call("api.push.devices.register", { token: TOKEN("demo"), platform: "ios" });
  assert.deepEqual(await w.call("api.push.devices.status", { token: TOKEN("demo") }), { accountsMode: false, signedIn: true, registered: true });
  const [row] = w.backend.rows("pushTokens");
  assert.equal(row.account, "solo-owner");
  assert.equal(row.platform, "ios");
  assert.equal(row.addedAt, row.lastSeenAt);
});

test("with accounts on, a phone is filed under the signed-in account and nobody else can read or remove it", async (t) => {
  const w = await world(t, { accounts: true });
  assert.deepEqual(await w.call("api.push.devices.status", { token: TOKEN("a") }), { accountsMode: true, signedIn: false, registered: false });
  await assert.rejects(w.call("api.push.devices.register", { token: TOKEN("a"), platform: "ios" }), /Sign in to continue\./);
  await assert.rejects(w.call("api.push.devices.refresh", { token: TOKEN("a"), platform: "ios" }), /Sign in to continue\./);
  await assert.rejects(w.call("api.push.devices.remove", { token: TOKEN("a") }), /Sign in to continue\./);
  w.as("alice");
  await assert.rejects(w.call("api.push.devices.register", { token: "not-a-token", platform: "ios" }), /did not give a valid notification address/);
  await assert.rejects(w.call("api.push.devices.register", { token: TOKEN("a]x[") , platform: "ios" }), /valid notification address/);
  await w.call("api.push.devices.register", { token: TOKEN("a"), platform: "android" });
  assert.equal((await w.call("api.push.devices.status", { token: TOKEN("a") })).registered, true);
  w.as("bob");
  assert.equal((await w.call("api.push.devices.status", { token: TOKEN("a") })).registered, false, "bob cannot see alice's phone");
  await w.call("api.push.devices.remove", { token: TOKEN("a") });
  assert.equal(w.backend.rows("pushTokens").length, 1, "bob cannot remove alice's phone");
  await w.call("api.push.devices.refresh", { token: TOKEN("b"), platform: "ios", previousToken: TOKEN("a") });
  assert.deepEqual(w.backend.rows("pushTokens").map((row) => [row.token, row.account]).sort(), [[TOKEN("a"), "alice"], [TOKEN("b"), "bob"]], "a refresh never removes another account's token");
  // Review finding 11: a token live on alice's account cannot be moved to bob by registering or refreshing it, so
  // knowing alice's token does not take her notifications. Signing out on that phone frees it.
  await assert.rejects(w.call("api.push.devices.register", { token: TOKEN("a"), platform: "android" }), /still gets notifications for another turtl account/);
  await assert.rejects(w.call("api.push.devices.refresh", { token: TOKEN("a"), platform: "android", previousToken: TOKEN("b") }), /still gets notifications for another turtl account/);
  assert.deepEqual(w.backend.rows("pushTokens").map((row) => [row.token, row.account]).sort(), [[TOKEN("a"), "alice"], [TOKEN("b"), "bob"]], "nothing moved, and bob's own token stayed");
  const { caseId } = await w.seed("Alice's shop", "alice");
  const noticeId = await w.notice(caseId, "needs_decision");
  w.as(null);
  assert.equal(await w.call("internal.push.deliver.forNotice", { noticeId, caseId, event: "needs_decision" }), "sent");
  assert.deepEqual(w.stub.sends().at(-1).body.map((message) => message.to), [TOKEN("a")], "alice still receives her next push");
  w.as("alice");
  await w.call("api.push.devices.remove", { token: TOKEN("a") });
  w.as("bob");
  await w.call("api.push.devices.register", { token: TOKEN("a"), platform: "android" });
  assert.deepEqual(w.backend.rows("pushTokens").map((row) => row.account), ["bob", "bob"], "once alice signed out on that phone, it can be bob's");
  await w.call("api.push.devices.remove", { token: TOKEN("a") });
  assert.deepEqual(w.backend.rows("pushTokens").map((row) => row.token), [TOKEN("b")]);
});

test("a refreshed token replaces the old one, a full account replaces its oldest phone, and account deletion removes them all", async (t) => {
  const w = await world(t, { accounts: true });
  w.as("alice");
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(1_000);
    await w.call("api.push.devices.register", { token: TOKEN(`p${i}`), platform: "ios" });
  }
  t.mock.timers.tick(1_000);
  await w.call("api.push.devices.refresh", { token: TOKEN("p0-new"), platform: "ios", previousToken: TOKEN("p0") });
  let rows = w.backend.rows("pushTokens");
  assert.ok(!rows.some((row) => row.token === TOKEN("p0")), "the old token is gone");
  assert.equal(rows.filter((row) => row.disabledAt === undefined).length, 10);
  t.mock.timers.tick(1_000);
  await w.call("api.push.devices.register", { token: TOKEN("p11"), platform: "ios" });
  rows = w.backend.rows("pushTokens");
  assert.equal(rows.filter((row) => row.disabledAt === undefined).length, 10, "at most ten live phones");
  assert.deepEqual(rows.filter((row) => row.disabledReason === "replaced").map((row) => row.token), [TOKEN("p1")], "the least recently seen phone is replaced");
  t.mock.timers.tick(1_000);
  await w.call("api.push.devices.refresh", { token: TOKEN("p1"), platform: "ios" });
  assert.equal(w.backend.rows("pushTokens").find((row) => row.token === TOKEN("p1")).disabledAt, undefined, "a phone that comes back is live again");
  w.as("bob");
  await w.call("api.push.devices.register", { token: TOKEN("bob"), platform: "ios" });
  assert.deepEqual(await w.call("internal.push.devices.removeAccount", { account: "alice" }), { removed: 11, more: false });
  assert.deepEqual(w.backend.rows("pushTokens").map((row) => row.account), ["bob"]);
});

// ——— Delivery through the stand-in for Expo ———

test("a push goes once to every live phone of the project's owner and turns off a phone Expo no longer knows", async (t) => {
  const w = await world(t, { accounts: true });
  w.as("alice");
  await w.call("api.push.devices.register", { token: TOKEN("alice-1"), platform: "ios" });
  await w.call("api.push.devices.register", { token: TOKEN("alice-Gone"), platform: "android" });
  await w.call("api.push.devices.register", { token: TOKEN("alice-2"), platform: "android" });
  w.as("bob");
  await w.call("api.push.devices.register", { token: TOKEN("bob-1"), platform: "ios" });
  w.as(null);
  process.env.EXPO_ACCESS_TOKEN = "stub-access-token";
  const { caseId } = await w.seed("Alice's shop", "alice");
  const noticeId = await w.notice(caseId, "needs_decision");

  const outcome = await w.call("internal.push.deliver.forNotice", { noticeId, caseId, event: "needs_decision" });
  assert.equal(outcome, "partly_sent");
  const [send] = w.stub.sends();
  assert.equal(w.stub.sends().length, 1, "one request for all of the owner's phones");
  assert.equal(send.headers.authorization, "Bearer stub-access-token");
  assert.deepEqual(send.body.map((message) => message.to).sort(), [TOKEN("alice-1"), TOKEN("alice-2"), TOKEN("alice-Gone")], "only the owner's phones");
  for (const message of send.body) {
    assert.deepEqual(message, { to: message.to, title: "Alice's shop", body: "A case needs your decision. Open it to approve or decline a fix.", data: { caseId }, sound: "default", priority: "high" });
  }
  assert.ok(!JSON.stringify(send.body).includes("4242") && !JSON.stringify(send.body).includes("TypeError"), "the case's words never leave");
  const tokens = w.backend.rows("pushTokens");
  assert.equal(tokens.find((row) => row.token === TOKEN("alice-Gone")).disabledReason, "not_registered");
  const [record] = w.backend.rows("pushSends");
  assert.equal(record.noticeId, noticeId);
  assert.equal(record.outcome, "partly_sent");
  assert.deepEqual(record.tickets.map((ticket) => ticket.error ?? "ok"), ["ok", "DeviceNotRegistered", "ok"]);

  assert.equal(await w.call("internal.push.deliver.forNotice", { noticeId, caseId, event: "needs_decision" }), null, "a retry sends nothing");
  assert.equal(w.stub.sends().length, 1);

  // Receipts, read 15 minutes later as Expo asks. One phone has since been uninstalled.
  const receiptJob = w.backend.scheduled.find((job) => job.path === "internal.push.deliver.checkReceipts");
  assert.equal(receiptJob.delay, 15 * 60_000);
  w.stub.settings.receiptErrors[record.tickets[2].receiptId] = "DeviceNotRegistered";
  await w.backend.next("internal.push.deliver.checkReceipts");
  const receiptRequest = w.stub.requests.find((request) => request.path === "getReceipts");
  assert.deepEqual(receiptRequest.body, { ids: [record.tickets[0].receiptId, record.tickets[2].receiptId] });
  const after = w.backend.rows("pushSends")[0];
  assert.deepEqual(after.tickets.map((ticket) => ticket.receipt ?? "none"), ["ok", "none", "error"]);
  assert.ok(after.receiptsCheckedAt);
  assert.deepEqual(w.backend.rows("pushTokens").filter((row) => row.disabledAt === undefined).map((row) => row.token).sort(), [TOKEN("alice-1"), TOKEN("bob-1")]);

  // A phone turned off by Expo comes back when it registers again.
  w.as("alice");
  await w.call("api.push.devices.register", { token: TOKEN("alice-Gone"), platform: "android" });
  assert.equal(w.backend.rows("pushTokens").find((row) => row.token === TOKEN("alice-Gone")).disabledAt, undefined);
});

test("no phone, no owner, a quiet event or a failing Expo each send nothing more and never throw", async (t) => {
  const w = await world(t, { accounts: true });
  const unowned = await w.seed("Nobody's app");
  const noTokens = await w.seed("Carol's app", "carol");
  w.as("dave");
  await w.call("api.push.devices.register", { token: TOKEN("dave"), platform: "ios" });
  w.as(null);
  const daves = await w.seed("Dave's app", "dave");
  for (const { caseId } of [unowned, noTokens]) {
    assert.equal(await w.call("internal.push.deliver.forNotice", { noticeId: await w.notice(caseId, "needs_decision"), caseId, event: "needs_decision" }), null);
  }
  assert.equal(await w.call("internal.push.deliver.forNotice", { noticeId: await w.notice(daves.caseId, "opened"), caseId: daves.caseId, event: "opened" }), null);
  assert.equal(w.stub.requests.length, 0);
  assert.equal(w.backend.rows("pushSends").length, 0, "a push record exists only when a phone was there to send to");

  w.stub.settings.sendStatus = 500;
  assert.equal(await w.call("internal.push.deliver.forNotice", { noticeId: await w.notice(daves.caseId, "needs_decision"), caseId: daves.caseId, event: "needs_decision" }), "failed");
  assert.equal(w.backend.rows("pushSends")[0].status, 500);
  assert.equal(w.backend.rows("pushTokens")[0].disabledAt, undefined, "a failed request turns no phone off");
  assert.ok(!w.backend.scheduled.some((job) => job.path === "internal.push.deliver.checkReceipts"));

  process.env.EXPO_PUSH_API_URL = "http://127.0.0.1:9";
  assert.equal(await w.call("internal.push.deliver.forNotice", { noticeId: await w.notice(daves.caseId, "handled_under_permission"), caseId: daves.caseId, event: "handled_under_permission" }), "failed");
});

// ——— The phone: data/push/controller.ts ———

function phone({ permission = "undetermined", answer = "granted", token = TOKEN("phone"), supported = true } = {}) {
  const calls = [];
  const state = { permission, token };
  const device = {
    supported,
    platform: "ios",
    setup: async () => void calls.push("setup"),
    permission: async () => state.permission,
    request: async () => { calls.push("request"); state.permission = answer; return answer; },
    token: async () => { calls.push("token"); if (state.token instanceof Error) throw state.token; return state.token; },
    onTokenChange: () => () => {},
    onOpen: () => () => {},
    openSettings: async () => void calls.push("settings"),
  };
  return { device, calls, state };
}

function controllerWith(device, { memory = {}, failRemove = false } = {}) {
  const { createPushController } = createLoader()("data/push/controller.ts");
  const server = { calls: [], tokens: new Set() };
  const backend = {
    useStatus: () => undefined,
    register: async (token, platform) => { server.calls.push(["register", token, platform]); server.tokens.add(token); },
    refresh: async (token, platform, previous) => { server.calls.push(["refresh", token, previous]); if (previous) server.tokens.delete(previous); server.tokens.add(token); },
    remove: async (token) => { server.calls.push(["remove", token]); if (failRemove) throw new Error("Sign in to continue."); server.tokens.delete(token); },
  };
  const stored = { value: structuredClone(memory) };
  const controller = createPushController({ device: () => device, backend, readMemory: async () => structuredClone(stored.value), writeMemory: async (value) => void (stored.value = structuredClone(value)) });
  return { controller, server, stored };
}

test("the notifications row is hidden in the demo and the example build, and shows each state where it applies", () => {
  const { pushKind, offerDue } = createLoader()("data/push/controller.ts");
  const loaded = { memory: {}, permission: "undetermined" };
  const status = (accountsMode, signedIn = true, registered = false) => ({ accountsMode, signedIn, registered });
  const kind = (input) => pushKind({ live: true, storeBuild: false, supported: true, status: status(true), state: loaded, ...input });
  assert.equal(kind({ live: false }), "hidden", "example data");
  assert.equal(kind({ status: status(false) }), "hidden", "the demo backend in a development build");
  assert.equal(kind({ status: undefined }), "hidden", "nothing flashes in a development build while loading");
  assert.equal(kind({ status: null }), "hidden", "a backend without convex/push");
  assert.equal(kind({ storeBuild: true, status: undefined }), "loading");
  assert.equal(kind({ storeBuild: true, status: status(false) }), "off", "a store build shows the row even against the single-owner backend");
  assert.equal(kind({ supported: false }), "unsupported");
  assert.equal(kind({ status: status(true, false) }), "signed_out");
  assert.equal(kind({ state: { memory: null, permission: null } }), "loading");
  assert.equal(kind({ state: { memory: {}, permission: "denied" } }), "blocked");
  assert.equal(kind({ status: status(true, true, true), state: { memory: { token: TOKEN("x") }, permission: "granted" } }), "on");
  assert.equal(kind({ status: status(true, true, false), state: { memory: { token: TOKEN("x") }, permission: "granted" } }), "off");
  assert.equal(offerDue("off", loaded), true);
  assert.equal(offerDue("off", { memory: { offered: true }, permission: "undetermined" }), false, "offered once");
  assert.equal(offerDue("off", { memory: {}, permission: "granted" }), false);
  assert.equal(offerDue("hidden", loaded), false);
});

test("declining notifications leaves everything working and registers nothing", async () => {
  const p = phone({ answer: "denied" });
  const { controller, server, stored } = controllerWith(p.device);
  await controller.load();
  assert.deepEqual(p.calls, [], "loading asks nothing");
  await controller.turnOn();
  assert.deepEqual(p.calls, ["setup", "request"]);
  assert.deepEqual(server.calls, []);
  assert.equal(controller.get().permission, "denied");
  assert.match(controller.get().message, /Notifications stay off\. Everything else works/);
  assert.deepEqual(stored.value, { offered: true });
});

test("turning on registers this phone, turning off removes it, and sign-out removes it without ever throwing", async () => {
  const p = phone();
  const { controller, server, stored } = controllerWith(p.device);
  await controller.load();
  await controller.turnOn();
  assert.deepEqual(server.calls, [["register", TOKEN("phone"), "ios"]]);
  assert.deepEqual(stored.value, { offered: true, token: TOKEN("phone") });
  assert.equal(controller.get().message, null);
  await controller.turnOff();
  assert.deepEqual(server.calls.at(-1), ["remove", TOKEN("phone")]);
  assert.deepEqual(stored.value, { offered: true });
  await controller.turnOn();
  assert.equal(p.calls.filter((call) => call === "request").length, 1, "the phone's prompt shows once; later the answer is read");
  const signedOut = controllerWith(p.device, { memory: { token: TOKEN("phone"), offered: true }, failRemove: true });
  await signedOut.controller.remove();
  assert.deepEqual(signedOut.server.calls, [["remove", TOKEN("phone")]]);
  assert.deepEqual(signedOut.stored.value, { offered: true }, "the token leaves the phone's memory even when the backend refuses");
  await controllerWith(p.device).controller.remove();
});

test("a token the phone cannot get is explained in plain words", async () => {
  const p = phone({ token: new Error("ERR_NOTIFICATIONS_NO_EXPERIENCE_ID: No projectId found") });
  const { controller, server } = controllerWith(p.device);
  await controller.turnOn();
  assert.equal(controller.get().message, "This phone could not set up notifications. Check your connection and try again.");
  assert.deepEqual(server.calls, []);
  assert.equal(controller.get().busy, false);
});

test("at launch a changed token replaces the old one, and a phone whose notifications were turned off in settings is removed", async () => {
  const p = phone({ permission: "granted", token: TOKEN("new") });
  const { controller, server, stored } = controllerWith(p.device, { memory: { token: TOKEN("old"), offered: true } });
  await controller.keepFresh();
  assert.deepEqual(server.calls, [["refresh", TOKEN("new"), TOKEN("old")]]);
  assert.equal(stored.value.token, TOKEN("new"));
  await controller.keepFresh();
  assert.equal(server.calls.length, 1, "once per launch");
  await controller.keepFresh(true);
  assert.deepEqual(server.calls.at(-1), ["refresh", TOKEN("new"), undefined]);

  const revoked = phone({ permission: "denied" });
  const second = controllerWith(revoked.device, { memory: { token: TOKEN("kept"), offered: true } });
  await second.controller.keepFresh();
  assert.deepEqual(second.server.calls, [["remove", TOKEN("kept")]]);
  assert.deepEqual(second.stored.value, { offered: true });

  const never = controllerWith(phone({ permission: "granted" }).device);
  await never.controller.keepFresh();
  assert.deepEqual(never.server.calls, [], "a phone that never turned notifications on registers nothing on its own");
});

test("a tapped notification opens only a case id", () => {
  const { caseIdFrom } = createLoader()("data/push/types.ts");
  assert.equal(caseIdFrom({ caseId: CASE }), CASE);
  for (const data of [null, undefined, "x", {}, { caseId: 7 }, { caseId: "../settings" }, { caseId: "https://evil.example" }]) assert.equal(caseIdFrom(data), null);
});
