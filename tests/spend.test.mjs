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
