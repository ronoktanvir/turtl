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

const DAY = 86_400_000;

/**
 * Accounts (users:<name>), each with `projects` projects and a practice project (the last), every one of them allowing
 * AI, and a case the monitor raised on each. By default each account is a month old and each case's check had been
 * passing for two days before it failed; `newAccounts` were made an hour ago.
 */
function world(accounts, { newAccounts = [] } = {}) {
  const apps = [];
  const cases = [];
  const users = [];
  for (const [name, projects] of Object.entries(accounts)) {
    users.push({ _id: `users:${name}`, _creationTime: NOV_16 - (newAccounts.includes(name) ? 3_600_000 : 30 * DAY) });
    for (let n = 0; n <= projects; n++) {
      apps.push({ _id: `apps:${name}-${n}`, ownerId: `users:${name}`, ...(n === projects && { practice: true }) });
      cases.push({ _id: `cases:${name}-${n}`, appId: `apps:${name}-${n}`, raisedBy: "monitor", kind: "outage", status: "investigating", passingForMs: 2 * DAY });
    }
  }
  return memoryDb(
    { ...consentTables, ...spendTables, apps: null, cases: null, users: null },
    { apps, cases, users, aiConsents: users.map((user, n) => consent(user._id, n)) },
  );
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
const CHAT = { estimate: limits.callEstimate("gpt-5.4-mini", "x".repeat(30_000)), cost: limits.callEstimate("gpt-5.4-mini", "x".repeat(30_000)) * 0.6 };
const READING = { estimate: limits.callEstimate("gpt-6-luna", "x".repeat(60_000), 12_000), cost: limits.callEstimate("gpt-6-luna", "x".repeat(60_000), 12_000) * 0.7 };
const VOICE = { estimate: limits.VOICE_CALL_ESTIMATE_USD, cost: limits.VOICE_CALL_ESTIMATE_USD };
// A customer report read on a project's own allowance.
const TRIAGE = { estimate: limits.callEstimate("gpt-5.4-mini", "x".repeat(8_000)), cost: limits.callEstimate("gpt-5.4-mini", "x".repeat(8_000)) * 0.8, allowance: "intake" };
// Investigating a case the monitor raised: the careful configuration's model, a long evidence prompt.
const DIAGNOSIS = { estimate: limits.callEstimate("gpt-6.1-sol", "x".repeat(20_000), 4_000), cost: limits.callEstimate("gpt-6.1-sol", "x".repeat(20_000), 4_000) * 0.7, allowance: "outage" };

/**
 * Accounts acting together, each doing everything it may in a day, in the order that takes the most: diagnosis of an
 * outage the monitor raised on one of its real projects (the cases the reserve is for), then of its practice app, which
 * it breaks at will, in bursts, then its customers' reports on every project. Returns how many accounts it took before
 * the gate refused Alice's diagnosis of an outage on her app, day by day, or null for a day they could not.
 * `newAccounts`: the attackers were made today. `steady: false`: their real projects' checks had only just started
 * passing before they failed.
 */
async function accountsToStopAlice(t, env, { days = 1, newAccounts = false, steady = true, count = 60 } = {}) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["Date"], now: NOV_16 });
  return await withEnv({ ...ACCOUNTS, ...env }, async () => {
    const attackers = Array.from({ length: count }, (_, n) => `mallory${n}`);
    const db = world({ alice: 1, ...Object.fromEntries(attackers.map((name) => [name, 10])) }, { newAccounts: newAccounts ? attackers : [] });
    if (!steady) for (const name of attackers) await db.patch(`cases:${name}-0`, { passingForMs: 60_000 });
    const ctx = actions(db);
    const alice = () => gates.check.handler({ db }, { scope: { caseId: "cases:alice-0" }, service: "openai", purpose: "send", allowance: "outage" });
    const results = [];
    for (let day = 0; day < days; day++) {
      t.mock.timers.setTime(NOV_16 + day * DAY);
      let stopped = null;
      for (const [n, name] of attackers.entries()) {
        await spendAll(ctx, { caseId: `cases:${name}-0` }, DIAGNOSIS, 20);
        await spendAll(ctx, { caseId: `cases:${name}-10` }, DIAGNOSIS, 20);
        for (let p = 0; p <= 10; p++) await spendAll(ctx, { appId: `apps:${name}-${p}` }, TRIAGE, 20);
        const answer = await alice();
        if (!answer.ok) {
          stopped = { accounts: n + 1, refusal: answer.reason, total: await ceilings.deploymentSpendToday({ db }, Date.now()) };
          break;
        }
      }
      results.push(stopped);
    }
    return days === 1 ? results[0] : results;
  });
}

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
    const day = await ledger.accountDay({ db }, "users:mallory", Date.now());
    const own = chat.total + readings.total + voice.total;
    assert.ok(Math.abs(day.ownUsd - own) < 1e-4, `${day.ownUsd} for ${own}`);
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
    assert.equal((await ledger.accountDay({ db }, "users:mallory", Date.now())).ownHeldUsd, 2.5);
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

// Statement 2: a part of the day kept for outages. Any account can make the monitor raise cases at will (its own app,
// or its practice app), so a part kept for those cases alone empties as fast as the rest. What makes it last is that an
// account may draw on it only while it has used little of the day.
test("ATTACK (finding 12): accounts acting together; the part of the day kept for outages multiplies how many it takes", async (t) => {
  const none = await accountsToStopAlice(t, { OUTAGE_RESERVE_PERCENT: "0" });
  const plain = await accountsToStopAlice(t, { OUTAGE_RESERVE_ACCOUNT_USD: "2.5" });
  const kept = await accountsToStopAlice(t, {});
  // Accounts a month old, each with a real project whose check had passed for days (the hardest kind to get). With no
  // reserve: $25 / about $5.50 an account (its own $2.50, its practice app's $2, its customers' $1). A reserve any such
  // account may draw on up to its whole share (the reviewer's first suggestion) adds two accounts ($10 / $2.50 each,
  // less what they left of the general part). The reserve as built ($10, only while under $0.50 today) takes the
  // general $15 (three accounts) and then about $0.50 an account for the $10: four times as many.
  assert.equal(none.accounts, 5, JSON.stringify(none));
  assert.ok(plain.accounts <= none.accounts + 2, JSON.stringify(plain));
  assert.ok(kept.accounts >= 20, JSON.stringify(kept));
  assert.equal(none.refusal, limits.spendRefusal.deploymentSpent());
  assert.equal(kept.refusal, limits.spendRefusal.deploymentSpent());
  console.log(`accounts it takes to stop another owner's diagnosis: no reserve ${none.accounts}, plain reserve ${plain.accounts}, the reserve as built ${kept.accounts}`);
});

// Third review, finding 19: about 24 accounts, made once, drained the reserve every day through practice-app cases,
// which anyone makes at will. The reserve is now for real outages on established projects of established accounts.
test("ATTACK (finding 19): 40 fresh accounts breaking practice apps and spending their shares leave Alice's diagnosis passing, two days running", async (t) => {
  const days = await accountsToStopAlice(t, {}, { days: 2, newAccounts: true, count: 40 });
  assert.deepEqual(days, [null, null], "neither day did they stop it");
});

// Statement 3: the arithmetic now, and what the operator can turn when a group of patient accounts does it anyway.
test("ATTACK (finding 19): how many accounts it takes now, on day 1 and the day after, and what the operator's settings change", async (t) => {
  // Fresh accounts (any number): never, on either day, until they are 14 days old.
  assert.deepEqual(await accountsToStopAlice(t, {}, { days: 2, newAccounts: true, count: 60 }), [null, null]);
  // Accounts over 14 days old, each holding a real project whose live app passed turtl's check for a day before it
  // failed: the general $15 takes three of them, the $10 reserve about twenty more, and the same accounts can do it
  // again the next day (each rotates to another of its projects that has passed for a day).
  const [first, second] = await accountsToStopAlice(t, {}, { days: 2 });
  assert.ok(first.accounts >= 20 && second.accounts >= 20, JSON.stringify([first, second]));
  assert.ok(Math.abs(second.accounts - first.accounts) <= 1, "the same accounts again");
  // What the operator can change when it happens: keep more of the day, or let each account draw less of it.
  const moreKept = await accountsToStopAlice(t, { OUTAGE_RESERVE_PERCENT: "60" });
  const lessEach = await accountsToStopAlice(t, { OUTAGE_RESERVE_ACCOUNT_USD: "0.25" }, { count: 80 });
  assert.ok(moreKept.accounts > first.accounts && lessEach.accounts > first.accounts, JSON.stringify({ moreKept, lessEach }));
  console.log(`aged accounts with established projects needed: day 1 ${first.accounts}, day 2 ${second.accounts}; with 60% kept ${moreKept.accounts}; with $0.25 each ${lessEach.accounts}`);
});

test("ATTACK (finding 19): accounts a month old whose projects' checks had only just started passing cannot drain the reserve either", async (t) => {
  assert.equal(await accountsToStopAlice(t, {}, { steady: false, count: 40 }), null);
});

// What finding the cause of one practice-app break costs, call by call, with the default models: a quick diagnosis, a
// careful one when the quick one is unsure, the fixes on offer, and a look for a broader cause. English prompts of
// these lengths, about four characters to a token; each call is held at its estimate until its cost comes back.
const PRACTICE_CASE = [
  { model: "gpt-5.4-mini", prompt: 15_000, max: 2_000, out: 1_500, allowance: "outage" },
  { model: "gpt-6.1-sol", prompt: 30_000, max: 12_000, out: 6_000, allowance: "outage" },
  { model: "gpt-5.4-mini", prompt: 20_000, max: undefined, out: 1_000, allowance: "outage" },
  { model: "gpt-5.4", prompt: 30_000, max: undefined, out: 1_500, allowance: undefined },
].map(({ model, prompt, max, out, allowance }) => ({
  estimate: limits.callEstimate(model, "x".repeat(prompt), max),
  cost: limits.modelCost(model, { inputTokens: prompt / 4, outputTokens: out }),
  allowance,
}));

test("a practice app's cases have their own allowance: ten breaks a day explained by AI fit, then it stops, with a plain sentence", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_16 });
  await withEnv({ ...ACCOUNTS, PRACTICE_AI_PER_DAY_USD: undefined }, async () => {
    const db = world({ ada: 1 });
    const ctx = actions(db);
    const practiceCase = { caseId: "cases:ada-1" };
    const perBreak = PRACTICE_CASE.reduce((sum, call) => sum + call.cost, 0);
    assert.ok(perBreak > 0.1 && perBreak < 0.2, `one break costs $${perBreak.toFixed(3)}`);
    // The ten breaks the practice app allows in a day, each explained.
    for (let n = 0; n < 10; n++) {
      for (const call of PRACTICE_CASE) assert.equal((await modelCall(ctx, practiceCase, call)).ok, true, `break ${n + 1}`);
    }
    let day = await ledger.accountDay({ db }, "users:ada", Date.now());
    assert.ok(Math.abs(day.practiceUsd - 10 * perBreak) < 1e-4, `${day.practiceUsd} for ${10 * perBreak}`);
    assert.equal(day.ownUsd, 0, "the owner's own share is untouched");
    assert.ok((await ledger.monthSpend({ db }, "users:ada", Date.now())) > 0, "it counts toward the month like the owner's own calls");
    // And no more: asking about it again and again stops at the allowance.
    const more = await spendAll(ctx, practiceCase, CHAT, 20);
    assert.equal(more.refusal, limits.spendRefusal.practiceSpent(2));
    day = await ledger.accountDay({ db }, "users:ada", Date.now());
    assert.ok(day.practiceUsd <= 2 + CHAT.estimate, `the practice app's day stopped at $${day.practiceUsd.toFixed(2)}`);
    // The owner's real project is diagnosed as before.
    assert.equal((await modelCall(ctx, { caseId: "cases:ada-0" }, DIAGNOSIS)).ok, true);
    assert.equal(
      limits.spendRefusal.practiceSpent(2),
      "this account has used today's $2.00 of AI for its practice app, so no model was asked; it starts again tomorrow",
    );
  });
  await withEnv({ PRACTICE_AI_PER_DAY_USD: undefined }, () => assert.equal(limits.practiceAiPerDayUsd(), 2));
  await withEnv({ PRACTICE_AI_PER_DAY_USD: "5" }, () => assert.equal(limits.practiceAiPerDayUsd(), 5));
});

test("a practice app never draws on the part of the day kept for outages", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_16 });
  await withEnv(ACCOUNTS, async () => {
    const db = world({ ada: 1 });
    await db.insert("deploymentTotals", { name: "model_usd_day", window: "2026-11-16", value: 15.2, updatedAt: 1 });
    assert.equal((await modelCall(actions(db), { caseId: "cases:ada-1" }, DIAGNOSIS)).reason, limits.spendRefusal.reserveKept());
    assert.equal((await modelCall(actions(db), { caseId: "cases:ada-0" }, DIAGNOSIS)).ok, true);
  });
});

test("the reserve admits only an outage the monitor raised on a real project whose check had passed for a day, of an account over 14 days old", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_16 });
  await withEnv(ACCOUNTS, async () => {
    const db = world({ alice: 1, newcomer: 1 }, { newAccounts: ["newcomer"] });
    // Only the part kept for outages is left.
    await db.insert("deploymentTotals", { name: "model_usd_day", window: "2026-11-16", value: 15.2, updatedAt: 1 });
    const ask = (caseId) => gates.check.handler({ db }, { scope: { caseId }, service: "openai", purpose: "send", allowance: "outage" });
    assert.equal((await ask("cases:alice-0")).ok, true, "a real outage on an established project");
    assert.equal((await ask("cases:alice-1")).reason, limits.spendRefusal.reserveKept(), "her practice app: never");
    await db.patch("cases:alice-0", { passingForMs: 23 * 3_600_000 });
    assert.equal((await ask("cases:alice-0")).reason, limits.spendRefusal.reserveNotSteady(24), "a check that had passed for less than a day");
    await db.patch("cases:alice-0", { passingForMs: undefined });
    assert.equal((await ask("cases:alice-0")).reason, limits.spendRefusal.reserveNotSteady(24), "a case from before the time was kept");
    assert.equal((await ask("cases:newcomer-0")).reason, limits.spendRefusal.reserveNewAccount(14), "an account made this hour");
    await db.patch("users:newcomer", { _creationTime: NOV_16 - 15 * DAY });
    assert.equal((await ask("cases:newcomer-0")).ok, true, "fifteen days later it qualifies");
    for (const reason of [limits.spendRefusal.reserveNotSteady(24), limits.spendRefusal.reserveNewAccount(14)]) assert.doesNotMatch(reason, /[A-Z]{2,}_|users:|cases:/);
    assert.equal(
      limits.spendRefusal.reserveNotSteady(24),
      "turtl is keeping the rest of today's AI for outages on apps whose checks had been passing for a day before they failed, and this one's had not, so no model was asked; it starts again tomorrow",
    );
  });
  await withEnv({ OUTAGE_RESERVE_STEADY_HOURS: undefined, OUTAGE_RESERVE_ACCOUNT_AGE_DAYS: undefined }, () => {
    assert.deepEqual([limits.outageReserveSteadyMs(), limits.outageReserveAccountAgeMs()], [24 * 3_600_000, 14 * DAY]);
  });
  await withEnv({ OUTAGE_RESERVE_STEADY_HOURS: "72", OUTAGE_RESERVE_ACCOUNT_AGE_DAYS: "30" }, () => {
    assert.deepEqual([limits.outageReserveSteadyMs(), limits.outageReserveAccountAgeMs()], [72 * 3_600_000, 30 * DAY]);
  });
});

test("once only the reserve is left, the case chat and customer reports wait, and an outage on an account that used little is still diagnosed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_16 });
  await withEnv(ACCOUNTS, async () => {
    const db = world({ alice: 1, mallory: 1 });
    // $15.20 of the $25 day is used: only the $10 kept for outages is left (and $0.20 of it is gone).
    await db.insert("deploymentTotals", { name: "model_usd_day", window: "2026-11-16", value: 15.2, updatedAt: 1 });
    const ctx = actions(db);
    assert.equal((await modelCall(ctx, { caseId: "cases:alice-0" }, CHAT)).reason, limits.spendRefusal.reserveKept(), "the chat waits");
    assert.equal((await modelCall(ctx, { appId: "apps:alice-0" }, TRIAGE)).reason, limits.spendRefusal.reserveKept(), "customer reports wait");
    assert.equal((await modelCall(ctx, { appId: "apps:alice-0" }, DIAGNOSIS)).reason, limits.spendRefusal.reserveKept(), "only a case the monitor raised qualifies");
    await db.patch("cases:alice-1", { raisedBy: "customer", kind: "bug_report" });
    assert.equal((await modelCall(ctx, { caseId: "cases:alice-1" }, DIAGNOSIS)).reason, limits.spendRefusal.reserveKept(), "a customer's case does not");
    assert.equal((await modelCall(ctx, { caseId: "cases:alice-0" }, DIAGNOSIS)).ok, true, "her outage is diagnosed");
    // Mallory used her share earlier today: the reserve is not hers to draw on.
    await db.insert("accountSpendDays", { account: "users:mallory", day: "2026-11-16", ownUsd: 2.5, ownHeldUsd: 0, intakeUsd: 0, intakeHeldUsd: 0, calls: 50, updatedAt: 1 });
    assert.equal((await modelCall(ctx, { caseId: "cases:mallory-0" }, DIAGNOSIS)).reason, limits.spendRefusal.accountDaySpent(2.5));
    await db.patch(db.rows("accountSpendDays").find((row) => row.account === "users:mallory")._id, { ownUsd: 0.6 });
    assert.equal((await modelCall(ctx, { caseId: "cases:mallory-0" }, DIAGNOSIS)).reason, limits.spendRefusal.reserveUsed(0.5));
    assert.equal(
      limits.spendRefusal.reserveUsed(0.5),
      "turtl is keeping the rest of today's AI for outages on accounts that have used less than $0.50 of it today, and this account has used more, so no model was asked; it starts again tomorrow",
    );
  });
});

test("the reserve's settings: defaults, 0 keeps none, 100 keeps the whole day, and it keeps its proportion of the ceiling", async (t) => {
  await withEnv({ OUTAGE_RESERVE_PERCENT: undefined, OUTAGE_RESERVE_ACCOUNT_USD: undefined }, () => {
    assert.deepEqual([limits.outageReservePercent(), limits.outageReserveAccountUsd()], [40, 0.5]);
  });
  await withEnv({ OUTAGE_RESERVE_PERCENT: "0", OUTAGE_RESERVE_ACCOUNT_USD: "1" }, () => assert.deepEqual([limits.outageReservePercent(), limits.outageReserveAccountUsd()], [0, 1]));
  for (const nonsense of ["-2", "101", "lots", ""]) {
    await withEnv({ OUTAGE_RESERVE_PERCENT: nonsense, OUTAGE_RESERVE_ACCOUNT_USD: "0" }, () => assert.deepEqual([limits.outageReservePercent(), limits.outageReserveAccountUsd()], [40, 0.5], nonsense));
  }
  t.mock.timers.enable({ apis: ["Date"], now: NOV_16 });
  const ask = (db, allowance) => gates.check.handler({ db }, { scope: { caseId: "cases:alice-0" }, service: "openai", purpose: "send", allowance });
  await withEnv({ ...ACCOUNTS, OUTAGE_RESERVE_PERCENT: "100" }, async () => {
    const db = world({ alice: 1 });
    assert.equal((await ask(db, "account")).reason, limits.spendRefusal.reserveKept());
    assert.equal((await ask(db, "outage")).ok, true);
  });
  // A $100 ceiling keeps its last $40; $59 into it, the chat still passes.
  await withEnv({ ...ACCOUNTS, DEPLOYMENT_MODEL_SPEND_PER_DAY_USD: "100" }, async () => {
    const db = world({ alice: 1 });
    await db.insert("deploymentTotals", { name: "model_usd_day", window: "2026-11-16", value: 59, updatedAt: 1 });
    assert.equal((await ask(db, "account")).ok, true);
    await db.patch(db.rows("deploymentTotals")[0]._id, { value: 60 });
    assert.equal((await ask(db, "account")).reason, limits.spendRefusal.reserveKept());
  });
});

// Statement 4 (review, "worth a second look"): a case customers raised ran examine_broader_causes on the owner's own
// allowance, so a customer posting related reports spent what diagnosing the owner's outages needs.
test("ATTACK: a case a customer raised examines broader causes on the project's customer-report allowance, never the owner's", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_16 });
  const answered = { choices: [{ message: { content: JSON.stringify({ finding: null, note: "No shared cause." }) } }], usage: { prompt_tokens: 20_000, completion_tokens: 1_500 } };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(answered), { headers: { "Content-Type": "application/json" } }));
  const examine = load("convex/structural/examine.ts");
  const context = { skip: null, prompt: { availableChecks: [] }, known: {}, relatedCaseIds: ["cases:x", "cases:y"], triggerSummary: "two related cases.", reason: "related_history", seededCaseCount: 0 };
  await withEnv({ ...ACCOUNTS, OPENAI_API_KEY: "sk-test-stand-in" }, async () => {
    const db = world({ alice: 2 });
    await db.patch("cases:alice-0", { raisedBy: "customer", kind: "bug_report" });
    const base = actions(db);
    const ctx = {
      runQuery: async (fn, args) => (fn.path === "internal.structural.records.examineContext" ? context : base.runQuery(fn, args)),
      runMutation: async (fn, args) => (fn.path.startsWith("internal.structural.records.") ? "agentRuns:1" : base.runMutation(fn, args)),
    };
    const run = (caseRow) => examine.examineBroaderCauses(ctx, { case: caseRow, step: { _id: "steps:1" }, attempt: { _id: "stepAttempts:1" } });
    const cost = limits.modelCost("gpt-5.4", { inputTokens: 20_000, outputTokens: 1_500 });

    assert.match((await run({ _id: "cases:alice-0", appId: "apps:alice-0", raisedBy: "customer", kind: "bug_report" })).summary, /found no structural cause/);
    let day = await ledger.accountDay({ db }, "users:alice", Date.now());
    assert.equal(day.ownUsd, 0, "the owner's own day is untouched");
    assert.equal(await ledger.monthSpend({ db }, "users:alice", Date.now()), 0, "and so is her month");
    assert.ok(Math.abs(day.intakeUsd - cost) < 1e-6);
    assert.ok(Math.abs((await ledger.intakeSpendToday({ db }, "apps:alice-0", Date.now())) - cost) < 1e-6, "the project's customer-report day paid");

    // An outage the monitor found is still examined on the owner's allowance.
    await run({ _id: "cases:alice-1", appId: "apps:alice-1", raisedBy: "monitor", kind: "outage" });
    day = await ledger.accountDay({ db }, "users:alice", Date.now());
    assert.ok(Math.abs(day.ownUsd - cost) < 1e-6);
  });
});

// Statement 3: whichever ceiling is reached, turtl degrades instead of going dark. Every refusal is a plain sentence
// (no setting names, no ids), every helper hands it back instead of failing, and the case screen says it once.
const CEILINGS = [
  ["the deployment's day", async (db) => db.insert("deploymentTotals", { name: "model_usd_day", window: "2026-11-16", value: 25, updatedAt: 1 }), { own: limits.spendRefusal.deploymentSpent(), outage: limits.spendRefusal.deploymentSpent(), intake: limits.spendRefusal.deploymentSpent() }],
  ["the account's month", async (db) => db.insert("modelSpend", { account: "users:ada", month: "2026-11", costUsd: 20, calls: 1, updatedAt: 1 }), { own: limits.spendRefusal.overLimit(20, NOV_16), outage: limits.spendRefusal.overLimit(20, NOV_16) }],
  ["the account's own share of the day", async (db) => db.insert("accountSpendDays", { account: "users:ada", day: "2026-11-16", ownUsd: 2.5, ownHeldUsd: 0, intakeUsd: 0, intakeHeldUsd: 0, calls: 1, updatedAt: 1 }), { own: limits.spendRefusal.accountDaySpent(2.5), outage: limits.spendRefusal.accountDaySpent(2.5) }],
  ["its customers' share of the day", async (db) => db.insert("accountSpendDays", { account: "users:ada", day: "2026-11-16", ownUsd: 0, ownHeldUsd: 0, intakeUsd: 1, intakeHeldUsd: 0, calls: 1, updatedAt: 1 }), { intake: limits.spendRefusal.accountIntakeSpent(1) }],
  ["the project's customer-report day", async (db) => db.insert("intakeDays", { appId: "apps:ada-0", day: "2026-11-16", costUsd: 0.5, calls: 1, casesOpened: 0, updatedAt: 1 }), { intake: limits.spendRefusal.intakeSpent(0.5) }],
  ["all but the part kept for outages", async (db) => db.insert("deploymentTotals", { name: "model_usd_day", window: "2026-11-16", value: 15, updatedAt: 1 }), { own: limits.spendRefusal.reserveKept(), intake: limits.spendRefusal.reserveKept() }],
  ["the outage part, for an account past $0.50 today", async (db) => {
    await db.insert("deploymentTotals", { name: "model_usd_day", window: "2026-11-16", value: 15, updatedAt: 1 });
    await db.insert("accountSpendDays", { account: "users:ada", day: "2026-11-16", ownUsd: 0.6, ownHeldUsd: 0, intakeUsd: 0, intakeHeldUsd: 0, calls: 1, updatedAt: 1 });
  }, { outage: limits.spendRefusal.reserveUsed(0.5), own: limits.spendRefusal.reserveKept(), intake: limits.spendRefusal.reserveKept() }],
];
const CALL_KINDS = [
  ["investigating or planning an outage the monitor found (and its council)", { caseId: "cases:ada-0" }, "outage"],
  ["examining broader causes, the case chat, voice, code questions, reading a repository", { caseId: "cases:ada-0" }, undefined],
  ["triaging a customer's report, or reading a case customers raised", { appId: "apps:ada-0" }, "intake"],
];
const plain = (sentence) => {
  assert.doesNotMatch(sentence, /[A-Z]{2,}_[A-Z_]+|apps:|cases:|_id|undefined|NaN|null/, sentence);
  assert.match(sentence, /no model was asked/);
};

test("ATTACK: whichever ceiling is reached, every kind of model call is refused with a plain sentence and nothing is sent", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_16 });
  await withEnv(ACCOUNTS, async () => {
    for (const [ceiling, reach, expected] of CEILINGS) {
      for (const [kind, scope, allowance] of CALL_KINDS) {
        const db = world({ ada: 1 });
        await reach(db);
        const ctx = actions(db);
        const opened = await gates.gateFor(ctx, scope, allowance).open("openai", "send", 0.05);
        const wanted = expected[allowance ?? "own"];
        if (wanted === undefined) {
          assert.equal(opened.ok, true, `${ceiling} leaves ${kind} alone`);
          continue;
        }
        assert.deepEqual(opened, { ok: false, reason: wanted }, `${ceiling}: ${kind}`);
        plain(wanted);
        assert.deepEqual(db.rows("accountSpendDays").map((row) => row.ownHeldUsd + row.intakeHeldUsd).filter(Boolean), [], "a refused call is not held");
      }
    }
  });
});

test("each model helper hands the refusal back for its caller's rule-based fallback, and sends nothing", async (t) => {
  t.mock.method(globalThis, "fetch", async (input) => assert.fail(`sent ${input}`));
  const refusing = (reason) => ({ blocked: async () => reason, open: async () => ({ ok: false, reason }), spent: async () => assert.fail("spent"), threadStarted: async () => {} });
  const { askJson } = load("convex/fixOptions.ts");
  const { callModel } = load("convex/routing/models.ts");
  const { respond } = load("convex/codeNetwork/openai.ts");
  const voice = load("convex/voice/openai.ts");
  await withEnv({ ...ACCOUNTS, OPENAI_API_KEY: "sk-test-stand-in" }, async () => {
    for (const reason of new Set(CEILINGS.flatMap(([, , expected]) => Object.values(expected)))) {
      // Fix options, triage, a customer case's reading, the case chat: askJson's reason is what they record and show.
      assert.deepEqual(await askJson(refusing(reason), "system", { a: 1 }), { ok: false, reason });
      // Diagnosis and the council: a refusal is an infrastructure failure marked blocked, never handed up to a stronger model.
      const answer = await callModel(refusing(reason), { ref: { provider: "openai", model: "gpt-6.1-sol" }, system: "s", user: "u", timeoutMs: 1000, maxOutputTokens: 100 });
      assert.deepEqual([answer.ok, answer.infra, answer.blocked, answer.reason], [false, true, true, reason]);
      // The code questions and repository readings: Refused, whose message is the reason as a sentence.
      await assert.rejects(respond(refusing(reason), { instructions: "i", input: "q", maxOutputTokens: 10 }), (error) => error.name === "Refused" && error.message === `${reason.startsWith("turtl") ? reason : reason[0].toUpperCase() + reason.slice(1)}.`);
      const heard = await voice.transcribe(refusing(reason), new ArrayBuffer(8), "audio/m4a", "prompt");
      assert.deepEqual(heard, { ok: false, reason });
    }
  });
});

test("the case screen says why no model was asked once, in the gate's own words", async () => {
  const { mapCaseDetail } = await import("../data/live/caseMapping.ts");
  for (const reason of [limits.spendRefusal.deploymentSpent(), limits.spendRefusal.accountDaySpent(2.5), limits.spendRefusal.reserveUsed(0.5)]) {
    // As convex/runner/handlers/investigate.ts records it on the outage's diagnosis.
    const diagnosis = { source: "rules", cause: "Booking waited for recommendations.", noModelReason: `No model answered: ${reason}.` };
    const detail = mapCaseDetail({
      case: { _id: "case-1", _creationTime: 1, appId: "app-1", title: "Booking failed", impact: "A test booking failed.", kind: "outage", raisedBy: "monitor", status: "waiting_for_owner" },
      journey: null, executeAttempts: [], evidence: [], proposal: null, action: null, verifications: [], agentRuns: [],
      steps: [{ _id: "step-1", _creationTime: 2, caseId: "case-1", key: "investigate", title: "Investigate", dependsOn: [], kind: "agent", purpose: "investigate", status: "done",
        currentAttempt: { _id: "attempt-1", _creationTime: 3, stepId: "step-1", caseId: "case-1", attempt: 1, status: "done", startedAt: 3, finishedAt: 4, summary: "s", output: { diagnosis } } }],
    }, null, null, [], 3);
    const text = detail.overview.filter((block) => block.kind === "paragraph").flatMap((block) => block.spans.map((span) => span.text)).join("\n");
    assert.match(text, /Rule-based reading, not a model diagnosis: Booking waited for recommendations\./);
    assert.equal(text.match(/No model answered/g).length, 1, text);
    assert.ok(text.includes(`No model answered: ${reason}.`), text);
  }
});

// Finding 19 (estimates): a call's hold assumed 3 characters a token, and dense text tokenizes at well under that, so a
// call could cost more than it was held at. The estimate now counts UTF-8 bytes, which no tokenizer exceeds.
const DENSE = "𠜎𠜱𠝹𠱓𠱸𠲖𠳏".repeat(800) + "漢字のテキストと絵文字🙂🙃".repeat(400) + "Ελληνικά и кириллица ".repeat(200);
const bytesOf = (text) => Buffer.byteLength(text, "utf8");

test("ATTACK (finding 19): a prompt of dense non-Latin text is held at no less than it can cost", async (t) => {
  // The most such a prompt can cost: one token per byte, the most any tokenizer makes of it.
  const worst = (model, texts, out = limits.ASSUMED_OUTPUT_TOKENS) => limits.modelCost(model, { inputTokens: texts.reduce((sum, text) => sum + bytesOf(text), 0), outputTokens: out });
  assert.ok(limits.callEstimate("gpt-5.4-mini", DENSE) >= worst("gpt-5.4-mini", [DENSE]));
  // Characters were not enough: the old estimate was a third of what this prompt can be.
  const old = limits.modelCost("gpt-5.4-mini", { inputTokens: Math.ceil(DENSE.length / 3), outputTokens: limits.ASSUMED_OUTPUT_TOKENS });
  assert.ok(old < worst("gpt-5.4-mini", [DENSE]));
  assert.ok(bytesOf(DENSE) > 3 * DENSE.length / 2, "three or four bytes a character");

  // Each model helper estimates from what it sends: fix options and triage, diagnosis and the council, code questions.
  const asked = [];
  const recording = { blocked: async () => null, open: async (service, purpose, estimateUsd) => (asked.push(estimateUsd), { ok: false, reason: "stop" }), spent: async () => {}, threadStarted: async () => {} };
  const { askJson } = load("convex/fixOptions.ts");
  const { callModel } = load("convex/routing/models.ts");
  const { respond } = load("convex/codeNetwork/openai.ts");
  await withEnv({ OPENAI_API_KEY: "sk-test-stand-in", FIXES_MODEL: undefined, DIAGNOSIS_MODEL: undefined, OPENAI_MODEL: undefined }, async () => {
    await askJson(recording, "system", { report: DENSE });
    assert.ok(asked.at(-1) >= worst("gpt-5.4-mini", ["system", JSON.stringify({ report: DENSE })]));
    await callModel(recording, { ref: { provider: "openai", model: "gpt-6.1-sol" }, system: "s", user: DENSE, timeoutMs: 1000, maxOutputTokens: 4000 });
    assert.ok(asked.at(-1) >= worst("gpt-6.1-sol", ["s", DENSE], 4000));
    await assert.rejects(respond(recording, { instructions: "i", input: [{ role: "user", content: DENSE }], maxOutputTokens: 1500 }));
    assert.ok(asked.at(-1) >= limits.modelCost("unpriced", { inputTokens: bytesOf(DENSE) + 1, outputTokens: 1500 }));
  });

  // Through the gate: a hundred such calls started together stop at the share, however dense the text.
  t.mock.timers.enable({ apis: ["Date"], now: NOV_16 });
  await withEnv(ACCOUNTS, async () => {
    const db = world({ mallory: 1 });
    const ctx = actions(db);
    const dense = { estimate: limits.callEstimate("gpt-5.4-mini", DENSE), cost: worst("gpt-5.4-mini", [DENSE]) };
    await Promise.all(Array.from({ length: 100 }, () => modelCall(ctx, { caseId: "cases:mallory-0" }, dense)));
    assert.ok((await ledger.accountDay({ db }, "users:mallory", Date.now())).ownUsd <= 2.5 + dense.estimate);
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
