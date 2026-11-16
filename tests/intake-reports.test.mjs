import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import ts from "typescript";

// convex/intake/records.ts's real functions against an in-memory copy of its tables: a customer's contact is never
// stored, old rows are cleared, and an owner deletes one report (or an account's reports go) with the case recounted
// and the Supermemory copy deleted. Supermemory is a stand-in: global fetch is replaced, so nothing leaves this process.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const ref = (path) => new Proxy({ path }, { get: (target, key) => (key === "path" ? target.path : ref(`${path}.${String(key)}`)) });
const registered = (kind) => (definition) => ({ kind, ...definition });
const generated = {
  "convex/_generated/api": { api: ref("api"), internal: ref("internal") },
  "convex/_generated/server": {
    query: registered("query"), mutation: registered("mutation"), action: registered("action"),
    internalQuery: registered("query"), internalMutation: registered("mutation"), internalAction: registered("action"),
  },
};
const mocks = {
  "convex/runner/run": { startCaseRun: async () => { throw new Error("No case is opened in these tests."); } },
  "convex/fixOptions": { askJson: async () => ({ ok: false, reason: "not used" }), fixesModelId: () => "none" },
};

function loader() {
  const loaded = new Map();
  const load = (file) => {
    if (loaded.has(file)) return loaded.get(file).exports;
    const module = { exports: {} };
    loaded.set(file, module);
    const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    const require = (name) => {
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
    runInThisContext(`(function(require, exports, module) { ${outputText}\n})`, { filename: file })(require, module.exports, module);
    return module.exports;
  };
  return (path) => load(resolve(root, path));
}

const load = loader();
const records = load("convex/intake/records.ts");
const { contactRef } = load("convex/intake/rules.ts");

// Tables in memory. An index is read by its fields in order; the scheduler only records what it was asked to run.
const INDEXES = {
  "reports.by_app_and_provider_event": ["appId", "provider", "providerEventId"],
  "reports.by_case_and_requester": ["caseId", "fromRef"],
  "reports.by_case_and_received": ["caseId", "receivedAt"],
  "reportTriage.by_report": ["reportId"],
  "reportTriage.by_app_and_status": ["appId", "status"],
  "reportTriage.by_case": ["caseId"],
  "evidence.by_case": ["caseId"],
  "stepAttempts.by_case": ["caseId"],
  "intakeKeys.by_key": ["key"],
  "intakeRateWindows.by_bucket_and_window": ["bucket", "windowStart"],
  // convex/access.ts asks whether a signed-in password account has confirmed its email address (none waits here).
  "authUnconfirmed.by_account": ["account"],
  // The single-owner demo first checks the deployment holds no account, which reads projects by owner (convex/access.ts).
  "apps.by_owner": ["ownerId"],
};

function backend({ identity = null } = {}) {
  const tables = new Map();
  const scheduled = [];
  let counter = 0;
  const rows = (table) => tables.get(table) ?? tables.set(table, []).get(table);
  const find = (id) => [...tables.values()].flat().find((row) => row._id === id) ?? null;
  const query = (table) => {
    let list = rows(table).slice();
    const chain = {
      withIndex(name, build) {
        const fields = INDEXES[`${table}.${name}`];
        assert.ok(fields, `No index ${table}.${name}`);
        const tests = [];
        let position = 0;
        const q = {
          eq(field, value) { assert.equal(field, fields[position++], `Index ${name} read out of order`); tests.push((row) => row[field] === value); return q; },
          lt(field, value) { tests.push((row) => row[field] < value); return q; },
          gt(field, value) { tests.push((row) => row[field] > value); return q; },
        };
        build?.(q);
        list = list.filter((row) => tests.every((t) => t(row)));
        // Rows in the order of the index's next field, as Convex returns them.
        const next = fields[position];
        if (next) list.sort((a, b) => (a[next] < b[next] ? -1 : a[next] > b[next] ? 1 : 0));
        return chain;
      },
      order(direction) {
        if (direction === "desc") list.reverse();
        return chain;
      },
      take: async (n) => list.slice(0, n),
      collect: async () => list,
      first: async () => list[0] ?? null,
      unique: async () => { assert.ok(list.length <= 1, `More than one ${table} row`); return list[0] ?? null; },
      paginate: async ({ cursor, numItems }) => {
        const start = cursor ? Number(cursor) : 0;
        return { page: list.slice(start, start + numItems), isDone: start + numItems >= list.length, continueCursor: String(start + numItems) };
      },
    };
    return chain;
  };
  const db = {
    query,
    get: async (id) => find(id),
    normalizeId: (table, id) => (typeof id === "string" && id.startsWith(`${table}:`) ? id : null),
    insert: async (table, fields) => { const _id = `${table}:${++counter}`; rows(table).push({ _id, _creationTime: counter, ...fields }); return _id; },
    patch: async (id, fields) => {
      const row = find(id);
      assert.ok(row, `No row ${id}`);
      for (const [key, value] of Object.entries(fields)) { if (value === undefined) delete row[key]; else row[key] = value; }
    },
    delete: async (id) => { for (const list of tables.values()) { const i = list.findIndex((row) => row._id === id); if (i >= 0) list.splice(i, 1); } },
  };
  const ctx = {
    db,
    auth: { getUserIdentity: async () => identity },
    scheduler: { runAfter: async (delay, fn, args) => { scheduled.push({ delay, path: fn.path, args }); } },
    // An action's question, answered by the real function over this database (the consent gate asks one in the demo
    // too, whether the deployment holds accounts: convex/access.ts).
    runQuery: async (fn, args) => {
      const segments = fn.path.split(".").slice(1);
      const name = segments.pop();
      return await load("convex/" + segments.join("/") + ".ts")[name].handler(ctx, args);
    },
  };
  return { ctx, rows, scheduled, insert: db.insert };
}

const ENV = ["INTAKE_CONTACT_KEY", "SUPERMEMORY_API_KEY", "SUPERMEMORY_NAMESPACE_PREFIX", "INTAKE_NAMESPACE_PREFIX", "AUTH_REQUIRED"];
async function withEnv(values, work) {
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  for (const name of ENV) delete process.env[name];
  Object.assign(process.env, values);
  try { return await work(); } finally { for (const name of ENV) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } }
}

// A customer case with two reports from one person (same contact) and one from another, each with its evidence.
async function seeded(b, { ownerId } = {}) {
  const appId = await b.insert("apps", { name: "Still", ...(ownerId && { ownerId }) });
  await b.insert("intakeKeys", { appId, key: "tik_test", createdAt: 1 });
  const caseId = await b.insert("cases", { appId, kind: "bug_report", raisedBy: "customer", status: "waiting_for_owner", reportCount: 3, distinctRequesterCount: 2, title: "Customer report: I cannot book a massage.", impact: "A customer reported a problem." });
  await b.insert("stepAttempts", { caseId, summary: 'A rule-based reading says: the first in their words: "I cannot book a massage.".', output: { diagnosis: { cause: '3 customer reports, the first in their words: "I cannot book a massage.".', confidence: 0.2 } } });
  await b.insert("evidence", { caseId, kind: "diagnosis", title: "Rule-based reading", body: 'The first in their words: "I cannot book a massage.".', sourceRef: "rule-based reading of the reports" });
  const reports = [];
  for (const [text, fromRef] of [["The booking button does nothing.", "form:device:a"], ["Still broken today.", "form:device:a"], ["I cannot book a massage.", "form:device:b"]]) {
    const id = await b.insert("reports", { appId, caseId, channel: "form", fromRef, text, provider: "turtl-form", providerEventId: text, receivedAt: reports.length });
    await b.insert("reportTriage", { reportId: id, appId, fingerprint: text, status: "done", caseId });
    await b.insert("evidence", { caseId, kind: "customer_report", title: `A customer wrote: "${text}"`, body: text, sourceRef: `reports/${id}` });
    reports.push(id);
  }
  await b.insert("evidence", { caseId, kind: "journey_check", title: "The booking check failed.", sourceRef: "POST /journey-check" });
  return { appId, caseId, reports };
}

test("a contact becomes a keyed hash with INTAKE_CONTACT_KEY, the demo's plain hash without it, and is never stored", async () => {
  const plain = await contactRef("Ada@Example.com");
  assert.equal(plain, "form:contact:" + createHash("sha256").update("ada@example.com").digest("hex").slice(0, 24), "unchanged without the key");
  const keyed = await contactRef("Ada@Example.com", "k".repeat(32));
  assert.match(keyed, /^form:contact-keyed:[0-9a-f]{32}$/);
  assert.equal(keyed, await contactRef("ada@example.com", "k".repeat(32)), "one person, one reference");
  assert.notEqual(keyed, await contactRef("ada@example.com", "another key, another reference"));
  assert.ok(!keyed.includes(createHash("sha256").update("ada@example.com").digest("hex").slice(0, 24)), "the keyed reference is not the plain hash");

  await withEnv({ INTAKE_CONTACT_KEY: "k".repeat(32) }, async () => {
    const b = backend();
    await seeded(b);
    for (const reportId of ["r-1", "r-2"]) {
      const result = await records.receive.handler(b.ctx, { key: "tik_test", text: "The page is blank.", contact: "ada@example.com", reportId });
      assert.deepEqual(result, { ok: true, duplicate: false });
    }
    const fresh = b.rows("reports").filter((r) => r.providerEventId.startsWith("r-"));
    assert.equal(fresh[0].fromRef, keyed);
    assert.equal(fresh[1].fromRef, keyed);
    const stored = JSON.stringify([...b.rows("reports"), ...b.rows("reportTriage"), ...b.rows("intakeRateWindows")]);
    assert.ok(!stored.toLowerCase().includes("ada@example.com"), "the address is stored nowhere");
    assert.ok(b.rows("reportTriage").every((t) => !("contact" in t)));
  });
});

test("forgetStoredContacts clears contacts stored the old way and moves their people to the keyed reference", async () => {
  await withEnv({ INTAKE_CONTACT_KEY: "k".repeat(32) }, async () => {
    const b = backend();
    const { appId, caseId } = await seeded(b);
    const legacy = await contactRef("Bo@Example.com");
    for (let i = 0; i < 3; i++) {
      const id = await b.insert("reports", { appId, caseId, channel: "form", fromRef: legacy, text: `Old report ${i}`, provider: "turtl-form", providerEventId: `old-${i}`, receivedAt: 10 + i });
      await b.insert("reportTriage", { reportId: id, appId, fingerprint: `old ${i}`, status: "done", caseId, contact: "Bo@Example.com" });
    }
    let result = await records.forgetStoredContacts.handler(b.ctx, {});
    for (const next of b.scheduled.filter((s) => s.path === "internal.intake.records.forgetStoredContacts")) result = await records.forgetStoredContacts.handler(b.ctx, next.args);
    assert.equal(result.done, true);
    assert.ok(b.rows("reportTriage").every((t) => !("contact" in t)));
    const moved = b.rows("reports").filter((r) => r.providerEventId.startsWith("old-"));
    assert.ok(moved.every((r) => r.fromRef === moved[0].fromRef && r.fromRef.startsWith("form:contact-keyed:")));
    const row = b.rows("cases").find((c) => c._id === caseId);
    assert.deepEqual([row.reportCount, row.distinctRequesterCount], [6, 3]);
  });
});

test("forgetStoredContacts without the key still clears every stored contact", async () => {
  await withEnv({}, async () => {
    const b = backend();
    const { appId } = await seeded(b);
    const id = await b.insert("reports", { appId, channel: "form", fromRef: await contactRef("c@d.co"), text: "Old", provider: "turtl-form", providerEventId: "old", receivedAt: 1 });
    await b.insert("reportTriage", { reportId: id, appId, fingerprint: "old", status: "done", contact: "c@d.co" });
    assert.deepEqual(await records.forgetStoredContacts.handler(b.ctx, {}), { cleared: 1, rekeyed: 0, done: true });
    assert.ok(!JSON.stringify(b.rows("reportTriage")).includes("c@d.co"));
  });
});

// The Supermemory stand-in: every request the SDK makes lands here.
async function withSupermemoryStandIn(work) {
  const requests = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    requests.push({ url, method: init.method ?? input.method, body: init.body ? JSON.parse(init.body) : null, authorization: new Headers(init.headers).get("authorization") });
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try { return await work(requests); } finally { globalThis.fetch = real; }
}

test("an owner deletes one report: the words go, the counts are corrected, and the Supermemory copy is deleted", async () => {
  await withEnv({ SUPERMEMORY_API_KEY: "stand-in-key", INTAKE_NAMESPACE_PREFIX: "test_" }, async () => {
    const b = backend();
    const { appId, caseId, reports } = await seeded(b);
    const result = await records.deleteReport.handler(b.ctx, { caseId, reportId: reports[2] });
    assert.deepEqual(result, { reportCount: 2, people: 1 });
    const row = b.rows("cases").find((c) => c._id === caseId);
    assert.deepEqual([row.reportCount, row.distinctRequesterCount], [2, 1]);
    assert.equal(b.rows("reports").length, 2);
    assert.ok(!b.rows("reportTriage").some((t) => t.reportId === reports[2]));
    const text = "I cannot book a massage.";
    assert.ok(!JSON.stringify([...b.rows("reports"), ...b.rows("evidence"), ...b.rows("reportTriage"), ...b.rows("cases"), ...b.rows("stepAttempts")]).includes(text), "the customer's words are gone, quotes included");
    assert.equal(row.title, "Customer report: [a deleted report]");
    assert.equal(b.rows("stepAttempts")[0].output.diagnosis.confidence, 0.2, "the rest of a step's output is kept");
    const redacted = b.rows("evidence").find((e) => e.sourceRef === `reports/${reports[2]}`);
    assert.match(redacted.title, /deleted by the owner/);
    assert.equal(b.rows("evidence").find((e) => e.sourceRef === `reports/${reports[0]}`).body, "The booking button does nothing.", "other reports keep their words");

    const forget = b.scheduled.find((s) => s.path === "internal.intake.records.forgetCopies");
    assert.deepEqual(forget.args, { appId, reportIds: [reports[2]], tries: 0 });
    await withSupermemoryStandIn(async (requests) => {
      assert.deepEqual(await records.forgetCopies.handler(b.ctx, forget.args), { removed: true });
      assert.equal(requests.length, 1);
      const [request] = requests;
      assert.equal(request.method, "DELETE");
      assert.ok(request.url.includes(encodeURIComponent(`test_reports_${appId}`.replace(/[^a-zA-Z0-9_:-]/g, "_"))), request.url);
      assert.deepEqual(request.body, { ids: [reports[2]] });
      assert.equal(request.authorization, "Bearer stand-in-key");
    });
  });
});

test("a quote stays while another report on the case still says the same words", async () => {
  await withEnv({}, async () => {
    const b = backend();
    const { appId, caseId, reports } = await seeded(b);
    await b.insert("reports", { appId, caseId, channel: "form", fromRef: "form:device:c", text: "I cannot book a massage.", provider: "turtl-form", providerEventId: "copy", receivedAt: 9 });
    assert.deepEqual(await records.deleteReport.handler(b.ctx, { caseId, reportId: reports[2] }), { reportCount: 3, people: 2 });
    assert.equal(b.rows("cases").find((c) => c._id === caseId).title, "Customer report: I cannot book a massage.");
    assert.match(b.rows("evidence").find((e) => e.kind === "diagnosis").body, /I cannot book a massage/);
    assert.match(b.rows("evidence").find((e) => e.sourceRef === `reports/${reports[2]}`).title, /deleted by the owner/);
  });
});

test("without a Supermemory key, deleting a report sends nothing anywhere", async () => {
  await withEnv({}, async () => {
    const b = backend();
    const { appId, reports } = await seeded(b);
    await withSupermemoryStandIn(async (requests) => {
      const result = await records.forgetCopies.handler(b.ctx, { appId, reportIds: [reports[0]], tries: 0 });
      assert.equal(result.removed, false);
      assert.equal(requests.length, 0);
    });
  });
});

test("deleting a report is refused without the owner passcode in the demo, for another case, and twice", async () => {
  await withEnv({}, async () => {
    const b = backend();
    const { caseId, reports } = await seeded(b);
    await b.insert("ownerPasscodeConfig", { passcodeDigest: createHash("sha256").update("correct horse").digest("hex") });
    await assert.rejects(records.deleteReport.handler(b.ctx, { caseId, reportId: reports[0] }), (error) => /passcode is incorrect/.test(error.data));
    await assert.rejects(records.deleteReport.handler(b.ctx, { caseId, reportId: reports[0], passcode: "wrong guess" }), (error) => /passcode is incorrect/.test(error.data));
    assert.equal(b.rows("reports").length, 3, "nothing was deleted");
    const other = await b.insert("cases", { appId: b.rows("apps")[0]._id, kind: "bug_report", raisedBy: "customer", status: "waiting_for_owner" });
    await assert.rejects(records.deleteReport.handler(b.ctx, { caseId: other, reportId: reports[0], passcode: "correct horse" }), (error) => /not available/.test(error.data));
    await assert.rejects(records.deleteReport.handler(b.ctx, { caseId: "nonsense", reportId: reports[0], passcode: "correct horse" }), (error) => /not available/.test(error.data));
    await records.deleteReport.handler(b.ctx, { caseId, reportId: reports[0], passcode: "correct horse" });
    await assert.rejects(records.deleteReport.handler(b.ctx, { caseId, reportId: reports[0], passcode: "correct horse" }), (error) => /not available/.test(error.data));
  });
});

test("with accounts on, only the account that owns the app can delete its reports", async () => {
  await withEnv({ AUTH_REQUIRED: "true" }, async () => {
    const stranger = backend({ identity: { subject: "users:2|session" } });
    const { caseId, reports } = await seeded(stranger, { ownerId: "users:1" });
    await assert.rejects(records.deleteReport.handler(stranger.ctx, { caseId, reportId: reports[0] }), (error) => /not available/.test(error.data));
    const nobody = backend();
    const seededForNobody = await seeded(nobody, { ownerId: "users:1" });
    await assert.rejects(records.deleteReport.handler(nobody.ctx, { caseId: seededForNobody.caseId, reportId: seededForNobody.reports[0] }), (error) => /Sign in/.test(error.data));
    const owner = backend({ identity: { subject: "users:1|session" } });
    const mine = await seeded(owner, { ownerId: "users:1" });
    assert.deepEqual(await records.deleteReport.handler(owner.ctx, { caseId: mine.caseId, reportId: mine.reports[0] }), { reportCount: 2, people: 2 });
  });
});

test("the app deletes a report through the owner passcode and says why it could not", async () => {
  const calls = [];
  let answer = { reportCount: 1, people: 1 };
  mocks["data/live/client"] = {
    errorMessage: (error) => error.data ?? error.message,
    useLiveQuery: (query, args) => ({ query: query.path, args }),
    requireLiveClient: () => ({ mutation: async (fn, args) => { calls.push({ path: fn.path, args }); if (answer instanceof Error) throw answer; return answer; } }),
  };
  mocks["data/live/ownerPasscode"] = { withOwnerPasscode: (work) => work("correct horse") };
  const client = loader()("data/reports/live.ts");
  assert.deepEqual(client.useCustomerReports("cases:1"), { query: "api.intake.records.forCase", args: { caseId: "cases:1" } });
  assert.deepEqual(await client.deleteCustomerReport("cases:1", "reports:2"), { reportCount: 1, people: 1 });
  assert.deepEqual(calls, [{ path: "api.intake.records.deleteReport", args: { caseId: "cases:1", reportId: "reports:2", passcode: "correct horse" } }]);
  answer = Object.assign(new Error("Server Error"), { data: "That report is not available. It may already have been deleted." });
  await assert.rejects(client.deleteCustomerReport("cases:1", "reports:2"), /not available/);
  const example = loader()("data/reports/example.ts");
  assert.equal(example.useCustomerReports("case-1"), null, "example data shows no report control");
});

test("deleteAppReports removes every report of an app in batches, for deleting an account", async () => {
  await withEnv({}, async () => {
    const b = backend();
    const { appId, caseId } = await seeded(b);
    for (let i = 0; i < 150; i++) await b.insert("reports", { appId, channel: "form", fromRef: `form:device:${i}`, text: `noise ${i}`, provider: "turtl-form", providerEventId: `n-${i}`, receivedAt: i });
    const otherApp = await b.insert("apps", { name: "Other" });
    await b.insert("reports", { appId: otherApp, channel: "form", fromRef: "x", text: "keep me", provider: "turtl-form", providerEventId: "k", receivedAt: 1 });
    let result = await records.deleteAppReports.handler(b.ctx, { appId });
    assert.deepEqual(result, { deleted: 100, more: true });
    result = await records.deleteAppReports.handler(b.ctx, { appId });
    assert.deepEqual(result, { deleted: 53, more: false });
    assert.deepEqual(b.rows("reports").map((r) => r.text), ["keep me"]);
    assert.equal(b.rows("reportTriage").length, 0);
    const row = b.rows("cases").find((c) => c._id === caseId);
    assert.deepEqual([row.reportCount, row.distinctRequesterCount], [0, 0]);
    assert.equal(b.scheduled.filter((s) => s.path === "internal.intake.records.forgetCopies").reduce((n, s) => n + s.args.reportIds.length, 0), 153);
  });
});
