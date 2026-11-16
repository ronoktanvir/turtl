import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoader, memoryDb, withEnv } from "./fixtures/convex-memory.mjs";

// RC-02: a reviewer who approves fixes again and again cannot run up an unlimited bill. Each account has a monthly
// limit on model spend and a daily limit on coding agents (Capy). Neither exists in the single-owner demo.

const load = createLoader();
const limits = load("convex/spend/limits.ts");
const ledger = load("convex/spend/ledger.ts");
const status = load("convex/spend/status.ts");
const services = load("convex/consent/services.ts");
const gates = load("convex/consent/gate.ts");
const { consentTables } = load("convex/consent/schema.ts");
const { spendTables } = load("convex/spend/schema.ts");

const ADA = "acct-ada";
const NOV_15 = Date.parse("2026-11-15T12:00:00Z");
const ACCOUNTS = { AUTH_REQUIRED: "true", MODEL_SPEND_LIMIT_USD: undefined, CODING_THREADS_PER_DAY: undefined };
const allowed = {
  _id: "aiConsents:1",
  account: ADA,
  answer: "allowed",
  services: services.ASKED.map(({ id, version }) => ({ id, version })),
  listVersion: services.LIST_VERSION,
  answeredAt: 1,
};
const world = (seed = {}) =>
  memoryDb({ ...consentTables, ...spendTables, apps: null, cases: null }, { apps: [{ _id: "apps:1", ownerId: ADA }], aiConsents: [allowed], ...seed });
const signedIn = (account) => ({ getUserIdentity: async () => (account ? { subject: `${account}|s` } : null) });

test("the limits have sensible defaults and read the environment, ignoring nonsense", async () => {
  await withEnv({ MODEL_SPEND_LIMIT_USD: undefined, CODING_THREADS_PER_DAY: undefined }, () => {
    assert.equal(limits.modelSpendLimitUsd(), 20);
    assert.equal(limits.codingThreadsPerDay(), 5);
  });
  await withEnv({ MODEL_SPEND_LIMIT_USD: "7.5", CODING_THREADS_PER_DAY: "2.9" }, () => {
    assert.equal(limits.modelSpendLimitUsd(), 7.5);
    assert.equal(limits.codingThreadsPerDay(), 2);
  });
  for (const nonsense of ["", "0", "-3", "lots", "Infinity"]) {
    await withEnv({ MODEL_SPEND_LIMIT_USD: nonsense, CODING_THREADS_PER_DAY: nonsense }, () => {
      assert.equal(limits.modelSpendLimitUsd(), 20, nonsense);
      assert.equal(limits.codingThreadsPerDay(), 5, nonsense);
    });
  }
});

test("months and days are calendar months and days in UTC, named in plain words", () => {
  assert.equal(limits.monthKey(NOV_15), "2026-11");
  assert.equal(limits.dayKey(NOV_15), "2026-11-15");
  assert.equal(limits.monthLabel("2026-11"), "November 2026");
  assert.equal(limits.nextMonthStart(NOV_15), "1 December");
  assert.equal(limits.nextMonthStart(Date.parse("2026-12-31T23:00:00Z")), "1 January");
  assert.equal(
    limits.spendRefusal.overLimit(20, NOV_15),
    "this account has used its $20.00 of AI for November 2026, so no model was asked; it starts again on 1 December",
  );
  assert.equal(limits.spendRefusal.threadCap(5), "this account has already started 5 code changes today, the most for one day, so Capy was not asked; it can start more tomorrow");
});

test("a call's cost is its list price, and a model with no list price counts at the dearest one", () => {
  assert.equal(limits.modelCost("gpt-5.4-mini", { inputTokens: 1000, outputTokens: 100 }).toFixed(6), "0.001200");
  assert.equal(limits.modelCost("unlisted-model", { inputTokens: 1_000_000, outputTokens: 0 }), 10, "the dearest input price on the list");
  assert.equal(limits.modelCost("unlisted-model", { inputTokens: 0, outputTokens: 1_000_000 }), 50);
  assert.equal(limits.modelCost("gpt-5.4", null), 0);
});

test("spend adds up per account per month and starts again in a new month", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_15 });
  const db = world();
  await ledger.addModelSpend.handler({ db }, { account: ADA, costUsd: 0.4 });
  await ledger.addModelSpend.handler({ db }, { account: ADA, costUsd: 0.1 });
  await ledger.addModelSpend.handler({ db }, { account: ADA, costUsd: 0 });
  await ledger.addModelSpend.handler({ db }, { account: "acct-bob", costUsd: 3 });
  assert.equal(await ledger.monthSpend({ db }, ADA, Date.now()), 0.5);
  assert.deepEqual(db.rows("modelSpend").map(({ account, month, calls }) => [account, month, calls]), [[ADA, "2026-11", 2], ["acct-bob", "2026-11", 1]]);
  t.mock.timers.setTime(Date.parse("2026-12-01T00:00:01Z"));
  assert.equal(await ledger.monthSpend({ db }, ADA, Date.now()), 0);
  await ledger.addModelSpend.handler({ db }, { account: ADA, costUsd: 1 });
  assert.equal(db.rows("modelSpend").length, 3);
});

test("a coding agent counts once per request, per day", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_15 });
  const db = world();
  await ledger.recordThread.handler({ db }, { account: ADA, requestId: "turtl:a" });
  await ledger.recordThread.handler({ db }, { account: ADA, requestId: "turtl:a" });
  await ledger.recordThread.handler({ db }, { account: ADA, requestId: "turtl:b" });
  assert.equal(await ledger.threadsToday({ db }, ADA, Date.now()), 2);
  t.mock.timers.setTime(Date.parse("2026-11-16T00:00:01Z"));
  assert.equal(await ledger.threadsToday({ db }, ADA, Date.now()), 0);
});

test("past the monthly limit no model is asked for that account; other services and accounts carry on", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_15 });
  await withEnv(ACCOUNTS, async () => {
    const db = world({ modelSpend: [{ _id: "modelSpend:1", account: ADA, month: "2026-11", costUsd: 20.01, calls: 900, updatedAt: 1 }] });
    const check = (service, purpose = "send") => gates.check.handler({ db }, { scope: { appId: "apps:1" }, service, purpose });
    for (const service of ["openai", "anthropic", "google"]) {
      const answer = await check(service);
      assert.equal(answer.ok, false, service);
    }
    assert.equal((await check("openai")).reason, limits.spendRefusal.overLimit(20, NOV_15));
    assert.deepEqual(await check("supermemory"), { ok: true, account: ADA }, "the limit is on model spend only");
    assert.deepEqual(await check("capy"), { ok: true, account: ADA });
    await withEnv({ MODEL_SPEND_LIMIT_USD: "50" }, async () => assert.equal((await check("openai")).ok, true));
  });
});

test("past the daily limit no coding agent starts, though one already running is still followed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_15 });
  await withEnv(ACCOUNTS, async () => {
    const started = (n) => Array.from({ length: n }, (_, i) => ({ _id: `codingThreads:${i}`, account: ADA, day: "2026-11-15", requestId: `turtl:${i}`, startedAt: 1 }));
    const four = world({ codingThreads: started(4) });
    assert.equal((await gates.check.handler({ db: four }, { scope: { appId: "apps:1" }, service: "capy", purpose: "start_thread" })).ok, true);
    const five = world({ codingThreads: started(5) });
    assert.deepEqual(await gates.check.handler({ db: five }, { scope: { appId: "apps:1" }, service: "capy", purpose: "start_thread" }), { ok: false, reason: limits.spendRefusal.threadCap(5) });
    assert.equal((await gates.check.handler({ db: five }, { scope: { appId: "apps:1" }, service: "capy", purpose: "send" })).ok, true);
  });
});

// Review finding 5: customer reports are read on the project's own daily allowance, so a customer who posts at every
// key's limit cannot spend the owner's monthly allowance and stop turtl diagnosing the owner's outages.
test("customer reports have their own allowance per project: once spent, triage is refused and outage diagnosis still passes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_15 });
  await withEnv({ ...ACCOUNTS, INTAKE_SPEND_PER_DAY_USD: undefined }, async () => {
    const spent = { _id: "intakeDays:1", appId: "apps:1", day: "2026-11-15", costUsd: 0.5, calls: 200, casesOpened: 0, updatedAt: 1 };
    const db = world({ intakeDays: [spent] });
    const check = (allowance, service = "openai") => gates.check.handler({ db }, { scope: { appId: "apps:1" }, service, purpose: "send", ...(allowance && { allowance }) });
    assert.deepEqual(await check("intake"), { ok: false, reason: limits.spendRefusal.intakeSpent(0.5) });
    assert.equal(limits.spendRefusal.intakeSpent(0.5), "this project has used today's $0.50 of AI for reading customer reports, so no model was asked; it starts again tomorrow");
    assert.deepEqual(await check(undefined), { ok: true, account: ADA }, "the same account's outage diagnosis still passes the gate");
    assert.deepEqual(await check("account"), { ok: true, account: ADA });
    assert.deepEqual(await check("intake", "supermemory"), { ok: true, account: ADA, appId: "apps:1" }, "the allowance is on model spend only");
    // The allowance is the project's, by day: another day, or a higher limit, lets triage ask a model again.
    t.mock.timers.setTime(Date.parse("2026-11-16T00:00:01Z"));
    assert.deepEqual(await check("intake"), { ok: true, account: ADA, appId: "apps:1" });
    t.mock.timers.setTime(NOV_15);
    await withEnv({ INTAKE_SPEND_PER_DAY_USD: "2" }, async () => assert.equal((await check("intake")).ok, true));
  });
});

test("what customer reports cost lands on the project's day, never on the account's month", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_15 });
  await withEnv(ACCOUNTS, async () => {
    const db = world({ intakeDays: [{ _id: "intakeDays:0", appId: "apps:1", day: "2026-11-01", costUsd: 0.4, calls: 9, casesOpened: 2, updatedAt: 1 }] });
    // The action-side gate for triage asks with the intake allowance and records spend against the project.
    const wrote = [];
    const ctx = {
      runQuery: async (fn, args) => gates.check.handler({ db }, args),
      runMutation: async (fn, args) => (wrote.push([fn.path, args]), ledger.addModelSpend.handler({ db }, args)),
    };
    const triage = gates.gateFor(ctx, { appId: "apps:1" }, "intake");
    assert.equal((await triage.open("openai")).ok, true);
    await triage.spent(0.3);
    await triage.spent(0.25);
    assert.deepEqual(wrote.map(([, args]) => args), [{ account: ADA, costUsd: 0.3, appId: "apps:1" }, { account: ADA, costUsd: 0.25, appId: "apps:1" }]);
    assert.equal(await ledger.monthSpend({ db }, ADA, Date.now()), 0, "the owner's month is untouched");
    assert.equal((await ledger.intakeSpendToday({ db }, "apps:1", Date.now())).toFixed(2), "0.55");
    assert.deepEqual(db.rows("intakeDays").map(({ day, calls }) => [day, calls]), [["2026-11-15", 2]], "an earlier day's row is dropped when a new day starts");
    assert.match((await triage.open("openai")).reason, /used today's \$0\.50 of AI for reading customer reports/);
    // Diagnosis of an outage on the same project is on the account's allowance.
    const diagnosis = gates.gateFor(ctx, { appId: "apps:1" });
    assert.equal((await diagnosis.open("openai")).ok, true);
    await diagnosis.spent(0.1);
    assert.deepEqual(wrote.at(-1)[1], { account: ADA, costUsd: 0.1 });
    assert.equal(await ledger.monthSpend({ db }, ADA, Date.now()), 0.1);
  });
});

test("customer reports open at most so many cases on a project a day", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_15 });
  await withEnv({ INTAKE_CASES_PER_DAY: "2" }, async () => {
    const db = world();
    assert.deepEqual([await ledger.openIntakeCase({ db }, "apps:1"), await ledger.openIntakeCase({ db }, "apps:1"), await ledger.openIntakeCase({ db }, "apps:1")], [true, true, false]);
    assert.equal(await ledger.openIntakeCase({ db }, "apps:2"), true, "the cap is per project");
    t.mock.timers.setTime(Date.parse("2026-11-16T00:00:01Z"));
    assert.equal(await ledger.openIntakeCase({ db }, "apps:1"), true, "and per day");
  });
  await withEnv({ INTAKE_CASES_PER_DAY: undefined, INTAKE_SPEND_PER_DAY_USD: undefined }, () => {
    assert.equal(limits.intakeCasesPerDay(), 5);
    assert.equal(limits.intakeSpendPerDayUsd(), 0.5);
  });
});

test("the gear sheet's line: where the account stands, and nothing in the demo", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_15 });
  const db = world({
    modelSpend: [{ _id: "modelSpend:1", account: ADA, month: "2026-11", costUsd: 3.25, calls: 40, updatedAt: 1 }],
    codingThreads: [{ _id: "codingThreads:1", account: ADA, day: "2026-11-15", requestId: "turtl:1", startedAt: 1 }],
  });
  await withEnv({ AUTH_REQUIRED: undefined }, async () => {
    const demo = await status.mine.handler({ db, auth: signedIn(null) }, {});
    assert.deepEqual([demo.enforced, demo.spentUsd, demo.threadsToday], [false, 0, 0]);
  });
  await withEnv(ACCOUNTS, async () => {
    assert.deepEqual(await status.mine.handler({ db, auth: signedIn(ADA) }, {}), {
      enforced: true, signedIn: true, month: "November 2026", spentUsd: 3.25, limitUsd: 20, threadsToday: 1, threadsPerDay: 5,
    });
    const signedOut = await status.mine.handler({ db, auth: signedIn(null) }, {});
    assert.deepEqual([signedOut.signedIn, signedOut.spentUsd], [false, 0]);
  });
});
