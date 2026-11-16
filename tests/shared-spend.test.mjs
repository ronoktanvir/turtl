import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoader, memoryDb, withEnv } from "./fixtures/convex-memory.mjs";

// Second security review, finding 12 (the AI-spending half): the deployment's daily model ceiling is one pool every
// account shares. Each test here performs an attack on the real gate (convex/consent/gate.ts) and ledger
// (convex/spend/ledger.ts), through the same calls an action makes, and checks it no longer takes AI diagnosis away
// from another owner.

const load = createLoader();
const limits = load("convex/spend/limits.ts");
const ledger = load("convex/spend/ledger.ts");
const ceilings = load("convex/spend/ceilings.ts");
const gates = load("convex/consent/gate.ts");
const services = load("convex/consent/services.ts");
const { consentTables } = load("convex/consent/schema.ts");
const { spendTables } = load("convex/spend/schema.ts");

const NOV_16 = Date.parse("2026-11-16T09:00:00Z");
// Every limit at its default, with accounts on.
const ACCOUNTS = {
  AUTH_REQUIRED: "true",
  MODEL_SPEND_LIMIT_USD: undefined,
  INTAKE_SPEND_PER_DAY_USD: undefined,
  DEPLOYMENT_MODEL_SPEND_PER_DAY_USD: undefined,
  ACCOUNT_MODEL_SPEND_PER_DAY_USD: undefined,
  ACCOUNT_INTAKE_SPEND_PER_DAY_USD: undefined,
};

const consent = (account, n) => ({
  _id: `aiConsents:${n}`,
  account,
  answer: "allowed",
  services: services.ASKED.map(({ id, version }) => ({ id, version })),
  listVersion: services.LIST_VERSION,
  answeredAt: 1,
});

/** Accounts, each with `projects` projects (and a practice project), every one of them allowing AI. */
function world(accounts) {
  const apps = [];
  const cases = [];
  for (const [account, projects] of Object.entries(accounts)) {
    for (let n = 0; n <= projects; n++) {
      apps.push({ _id: `apps:${account}-${n}`, ownerId: account, ...(n === projects && { practice: true }) });
      cases.push({ _id: `cases:${account}-${n}`, appId: `apps:${account}-${n}`, raisedBy: "monitor", kind: "outage", status: "investigating" });
    }
  }
  return memoryDb({ ...consentTables, ...spendTables, apps: null, cases: null }, { apps, cases, aiConsents: Object.keys(accounts).map(consent) });
}

const FUNCTIONS = {
  "internal.consent.gate.check": () => gates.check,
  "internal.consent.gate.admit": () => gates.admit,
  "internal.spend.ledger.addModelSpend": () => ledger.addModelSpend,
};

// What an action's ctx does: queries run at once, and mutations one after another, as Convex's transactions are
// serializable. The model calls themselves run side by side between a mutation that admits them and one that records them.
function actions(db) {
  let chain = Promise.resolve();
  const serial = (work) => {
    const next = chain.then(work);
    chain = next.catch(() => {});
    return next;
  };
  return {
    runQuery: async (fn, args) => FUNCTIONS[fn.path]().handler({ db }, args),
    runMutation: (fn, args) => serial(() => FUNCTIONS[fn.path]().handler({ db }, args)),
  };
}

/**
 * One model call as the vendor helpers make it: ask the gate with the call's estimate, and on a yes report what it
 * cost. Each call is its own action, so it has its own gate.
 */
async function modelCall(ctx, scope, { estimate, cost, allowance }) {
  const gate = gates.gateFor(ctx, scope, allowance);
  const opened = await gate.open("openai", "send", estimate);
  if (!opened.ok) return { ok: false, reason: opened.reason };
  await gate.spent(cost);
  return { ok: true, cost };
}

/** Starts `width` calls at once, again and again, until a whole burst is refused. Returns what was let through. */
async function spendAll(ctx, scope, call, width) {
  let total = 0;
  for (let round = 0; round < 1000; round++) {
    const results = await Promise.all(Array.from({ length: width }, () => modelCall(ctx, scope, call)));
    const through = results.filter((result) => result.ok);
    total += through.reduce((sum, result) => sum + result.cost, 0);
    if (!through.length) return { total, refusal: results[0].reason };
  }
  assert.fail("the gate never said no");
}

// What the account's own calls cost when it does everything it may: the case chat (a small model, a long case), its
// projects' code questions and repository readings (a model with no list price, counted at the dearest), voice.
const CHAT = { estimate: limits.callEstimate("gpt-5.4-mini", 30_000), cost: limits.callEstimate("gpt-5.4-mini", 30_000) * 0.6 };
const READING = { estimate: limits.callEstimate("gpt-6-luna", 60_000, 12_000), cost: limits.callEstimate("gpt-6-luna", 60_000, 12_000) * 0.7 };
const VOICE = { estimate: limits.VOICE_CALL_ESTIMATE_USD, cost: limits.VOICE_CALL_ESTIMATE_USD };
// A customer report read on a project's own allowance.
const TRIAGE = { estimate: limits.callEstimate("gpt-5.4-mini", 8_000), cost: limits.callEstimate("gpt-5.4-mini", 8_000) * 0.8, allowance: "intake" };

test("ATTACK (finding 12): one account spends everything it may in a day, in bursts, and another owner's diagnosis still passes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_16 });
  await withEnv(ACCOUNTS, async () => {
    const db = world({ alice: 1, mallory: 10 });
    const ctx = actions(db);
    const mallory = { caseId: "cases:mallory-0" };

    // Mallory's own calls: wide bursts of chat, of repository readings on all ten projects and of voice, until the
    // gate refuses a whole burst. Before the fix, every call passed until her month ($20) was gone.
    const chat = await spendAll(ctx, mallory, CHAT, 60);
    const readings = await spendAll(ctx, { appId: "apps:mallory-3" }, READING, 11);
    const voice = await spendAll(ctx, mallory, VOICE, 100);
    assert.equal(chat.refusal, limits.spendRefusal.accountDaySpent(2.5));
    assert.equal(readings.refusal, chat.refusal);
    assert.equal(voice.refusal, chat.refusal);
    // Her customers' reports on all eleven projects (her practice project too), at the per-key limit, until each is refused.
    const intake = [];
    for (let n = 0; n <= 10; n++) intake.push(await spendAll(ctx, { appId: `apps:mallory-${n}` }, TRIAGE, 30));
    assert.ok(intake.every(({ refusal }) => refusal === limits.spendRefusal.accountIntakeSpent(1) || refusal === limits.spendRefusal.intakeSpent(0.5)));

    // What she managed: her day share and her customers' day share, each passed by at most the last call let through.
    const day = await ledger.accountDay({ db }, "mallory", Date.now());
    const own = chat.total + readings.total + voice.total;
    assert.ok(Math.abs(day.ownUsd - own) < 1e-6);
    assert.ok(day.ownUsd <= 2.5 + READING.estimate, `her own calls cost $${day.ownUsd.toFixed(2)}`);
    assert.ok(day.intakeUsd <= 1 + TRIAGE.estimate, `her customers' reports cost $${day.intakeUsd.toFixed(2)}`);
    assert.equal(day.ownHeldUsd + day.intakeHeldUsd, 0, "every hold was released by its call's cost");
    const deployment = await ceilings.deploymentSpendToday({ db }, Date.now());
    assert.ok(deployment < 25 / 4, `the deployment's day stands at $${deployment.toFixed(2)} of $25.00`);

    // Alice, who spent nothing, still gets her outage diagnosed, and her own customers' reports are still read.
    assert.deepEqual(await modelCall(ctx, { caseId: "cases:alice-0" }, CHAT), { ok: true, cost: CHAT.cost });
    assert.equal((await modelCall(ctx, { appId: "apps:alice-0" }, TRIAGE)).ok, true);
  });
});

test("a burst of calls started together is counted as each is let through, so it stops at the account's share", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_16 });
  await withEnv(ACCOUNTS, async () => {
    const db = world({ mallory: 1 });
    const ctx = actions(db);
    // 500 chats started at once: without holds every one would pass the check before any was counted.
    const gatesOpen = await Promise.all(Array.from({ length: 500 }, () => gates.gateFor(ctx, { caseId: "cases:mallory-0" }).open("openai", "send", 0.05)));
    const through = gatesOpen.filter((opened) => opened.ok).length;
    assert.equal(through, 50, "$2.50 at $0.05 a call");
    assert.equal((await ledger.accountDay({ db }, "mallory", Date.now())).ownHeldUsd, 2.5);
    // A caller that gives no estimate is held at the flat amount.
    assert.equal(limits.MODEL_CALL_HOLD_USD, 0.1);
  });
});

test("customers cannot use up the owner's own share: past the customer-report share, the owner's diagnosis still passes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_16 });
  await withEnv(ACCOUNTS, async () => {
    const db = world({ ada: 10 });
    const ctx = actions(db);
    for (let n = 0; n <= 10; n++) await spendAll(ctx, { appId: `apps:ada-${n}` }, TRIAGE, 10);
    assert.equal((await modelCall(ctx, { appId: "apps:ada-4" }, TRIAGE)).reason, limits.spendRefusal.accountIntakeSpent(1));
    assert.equal((await modelCall(ctx, { caseId: "cases:ada-0" }, CHAT)).ok, true, "the owner's own diagnosis is on another share");
  });
});

test("the shares are settings with sensible defaults, and nonsense falls back to them", async () => {
  await withEnv({ ACCOUNT_MODEL_SPEND_PER_DAY_USD: undefined, ACCOUNT_INTAKE_SPEND_PER_DAY_USD: undefined }, () => {
    assert.deepEqual([limits.accountModelSpendPerDayUsd(), limits.accountIntakeSpendPerDayUsd()], [2.5, 1]);
  });
  await withEnv({ ACCOUNT_MODEL_SPEND_PER_DAY_USD: "4", ACCOUNT_INTAKE_SPEND_PER_DAY_USD: "0.25" }, () => {
    assert.deepEqual([limits.accountModelSpendPerDayUsd(), limits.accountIntakeSpendPerDayUsd()], [4, 0.25]);
  });
  for (const nonsense of ["", "0", "-1", "lots"]) {
    await withEnv({ ACCOUNT_MODEL_SPEND_PER_DAY_USD: nonsense, ACCOUNT_INTAKE_SPEND_PER_DAY_USD: nonsense }, () => {
      assert.deepEqual([limits.accountModelSpendPerDayUsd(), limits.accountIntakeSpendPerDayUsd()], [2.5, 1], nonsense);
    });
  }
  assert.equal(limits.spendRefusal.accountDaySpent(2.5), "this account has used today's $2.50 of AI, the most one account uses in a day, so no model was asked; it starts again tomorrow");
  assert.equal(limits.spendRefusal.accountIntakeSpent(1), "this account's projects have used today's $1.00 of AI for reading customer reports, so no model was asked; it starts again tomorrow");
});

test("the account's day starts again at midnight UTC, and older days are dropped", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_16 });
  await withEnv(ACCOUNTS, async () => {
    const db = world({ mallory: 1 });
    const ctx = actions(db);
    await spendAll(ctx, { caseId: "cases:mallory-0" }, CHAT, 20);
    assert.equal((await modelCall(ctx, { caseId: "cases:mallory-0" }, CHAT)).ok, false);
    t.mock.timers.setTime(Date.parse("2026-11-17T00:00:01Z"));
    assert.equal((await modelCall(ctx, { caseId: "cases:mallory-0" }, CHAT)).ok, true);
    assert.deepEqual(db.rows("accountSpendDays").map((row) => row.day), ["2026-11-17"]);
  });
});

test("the single-owner demo has no shares: nothing is read or written for them", async () => {
  await withEnv({ AUTH_REQUIRED: undefined }, async () => {
    const ctx = { runQuery: () => assert.fail("the demo asked the database"), runMutation: () => assert.fail("the demo wrote spend") };
    const gate = gates.gateFor(ctx, { appId: "apps:1" });
    assert.equal((await gate.open("openai", "send", 1)).ok, true);
    await gate.spent(1);
  });
});
