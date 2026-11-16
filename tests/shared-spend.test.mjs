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
  OUTAGE_RESERVE_PERCENT: undefined,
  OUTAGE_RESERVE_ACCOUNT_USD: undefined,
  OUTAGE_RESERVE_STEADY_HOURS: undefined,
  OUTAGE_RESERVE_ACCOUNT_AGE_DAYS: undefined,
  OUTAGE_FLOOR_PER_DAY_USD: undefined,
  PRACTICE_AI_PER_DAY_USD: undefined,
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
 * passing for two days before it failed; `newAccounts` were made an hour ago, and `madeAgo` names other ages.
 */
function world(accounts, { newAccounts = [], madeAgo = {} } = {}) {
  const apps = [];
  const cases = [];
  const users = [];
  for (const [name, projects] of Object.entries(accounts)) {
    users.push({ _id: `users:${name}`, _creationTime: NOV_16 - (madeAgo[name] ?? (newAccounts.includes(name) ? 3_600_000 : 30 * DAY)) });
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

// One real outage with the default models, call by call, at ordinary sizes: the quick look (gpt-5.4-mini), the careful
// review it hands up to (gpt-6.1-sol), the council's three default OpenAI members asked side by side and its summary
// (gpt-6.1-sol), then the fixes on offer (gpt-5.4-mini, held at ASSUMED_OUTPUT_TOKENS). Each call is held at what
// convex/routing/models.ts or convex/fixOptions.ts holds it at, and costs English at about four characters a token.
const call = (model, chars, max, inputTokens, outputTokens) => ({
  estimate: limits.callEstimate(model, "x".repeat(chars), max),
  cost: limits.modelCost(model, { inputTokens, outputTokens }),
});
const REAL_OUTAGE = {
  diagnosis: [call("gpt-5.4-mini", 15_000, 2_000, 3_750, 1_500), call("gpt-6.1-sol", 40_000, 12_000, 10_000, 6_000)],
  council: [call("gpt-6.1-sol", 40_000, 6_000, 10_000, 2_000), call("gpt-5.5", 40_000, 6_000, 10_000, 2_000), call("gpt-6.1-terra", 40_000, 6_000, 10_000, 2_000)],
  summary: call("gpt-6.1-sol", 60_000, 4_000, 15_000, 1_500),
  fixes: call("gpt-5.4-mini", 30_000, undefined, 7_500, 1_500),
};
// The most one outage can cost with the default models: the diagnosis's whole budget (DIAGNOSIS_BUDGET_USD, $0.50), a
// council whose members and summary reach its $0.50 limit as convex/council/run.ts reckons it (a third of the
// characters as tokens, each answer at its most), and the fixes at their most output.
const { DIAGNOSIS_BUDGET_USD } = load("convex/routing/configs.ts");
const councilCall = (model, chars, max) => ({ estimate: limits.callEstimate(model, "x".repeat(chars), max), cost: limits.modelCost(model, { inputTokens: Math.ceil(chars / 3), outputTokens: max }) });
const quickMost = call("gpt-5.4-mini", 15_000, 2_000, 3_750, 2_000);
const MOST_OUTAGE = {
  diagnosis: [quickMost, { estimate: limits.callEstimate("gpt-6.1-sol", "x".repeat(200_000), 12_000), cost: DIAGNOSIS_BUDGET_USD - quickMost.cost }],
  council: [councilCall("gpt-6.1-sol", 47_000, 6_000), councilCall("gpt-5.5", 47_000, 6_000), councilCall("gpt-6.1-terra", 47_000, 6_000)],
  summary: councilCall("gpt-6.1-sol", 94_000, 4_000),
  fixes: call("gpt-5.4-mini", 30_000, undefined, 7_500, limits.ASSUMED_OUTPUT_TOKENS),
};
const costOf = (outage) => [...outage.diagnosis, ...outage.council, outage.summary, outage.fixes].reduce((sum, { cost }) => sum + cost, 0);

/**
 * Finds the cause of one outage the monitor raised as the steps do: the investigate step's gate for the diagnosis, the
 * council's own gate (its members admitted side by side, then its summary), and the plan step's gate for the fixes.
 * Returns what passed and the reason for each call refused.
 */
async function diagnoseOutage(ctx, caseId, outage = REAL_OUTAGE) {
  const scope = { caseId };
  const refusals = [];
  let cost = 0;
  const one = async (gate, { estimate, cost: spent }) => {
    const opened = await gate.open("openai", "send", estimate);
    if (!opened.ok) return refusals.push(opened.reason);
    await gate.spent(spent);
    cost += spent;
  };
  const investigate = gates.gateFor(ctx, scope, "outage");
  for (const step of outage.diagnosis) await one(investigate, step);
  const council = gates.gateFor(ctx, scope, "outage");
  const members = await Promise.all(outage.council.map(({ estimate }) => council.open("openai", "send", estimate)));
  for (const [n, opened] of members.entries()) {
    if (!opened.ok) refusals.push(opened.reason);
    else {
      await council.spent(outage.council[n].cost);
      cost += outage.council[n].cost;
    }
  }
  await one(council, outage.summary);
  await one(gates.gateFor(ctx, scope, "outage"), outage.fixes);
  return { ok: refusals.length === 0, refusals, cost };
}

const floorOf = (day) => day.floorUsd + day.floorHeldUsd;

/**
 * Accounts acting together, each doing everything it may in a day: finding the cause of an outage on one of its real
 * projects (its own share, then the reserve while it may, then its own floor), breaking its practice app, and its
 * customers' reports on every project, in bursts. Then Alice's outage on her real project, in full (REAL_OUTAGE). Day by
 * day: how many accounts it took to use up the general part (Alice's case chat refused) and the whole day, what Alice's
 * chat was told, how her outage went and on what, and what the shared day and the floors came to.
 * `newAccounts`: the attackers were made an hour ago. `steady: false`: their real projects' checks had only just started
 * passing before they failed. `aliceMadeAgo`: how long ago Alice made her account (a day by default).
 */
async function attack(t, env, { days = 1, count = 10, newAccounts = true, steady = true, aliceMadeAgo = DAY } = {}) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["Date"], now: NOV_16 });
  return await withEnv({ ...ACCOUNTS, ...env }, async () => {
    const attackers = Array.from({ length: count }, (_, n) => `mallory${n}`);
    const db = world({ alice: 1, ...Object.fromEntries(attackers.map((name) => [name, 10])) }, { newAccounts: newAccounts ? attackers : [], madeAgo: { alice: aliceMadeAgo } });
    if (!steady) for (const name of attackers) await db.patch(`cases:${name}-0`, { passingForMs: 60_000 });
    const ctx = actions(db);
    const aliceChat = () => gates.check.handler({ db }, { scope: { caseId: "cases:alice-0" }, service: "openai", purpose: "send" });
    const shared = () => ceilings.deploymentSpendToday({ db }, Date.now());
    const results = [];
    for (let day = 0; day < days; day++) {
      t.mock.timers.setTime(NOV_16 + day * DAY);
      let general = null;
      let whole = null;
      for (const [n, name] of attackers.entries()) {
        await spendAll(ctx, { caseId: `cases:${name}-0` }, DIAGNOSIS, 20);
        await spendAll(ctx, { caseId: `cases:${name}-10` }, DIAGNOSIS, 20);
        for (let p = 0; p <= 10; p++) await spendAll(ctx, { appId: `apps:${name}-${p}` }, TRIAGE, 20);
        if (general === null && !(await aliceChat()).ok) general = n + 1;
        if (whole === null && (await shared()) >= limits.deploymentModelSpendPerDayUsd()) whole = n + 1;
      }
      const chat = await aliceChat();
      const before = await shared();
      const outage = await diagnoseOutage(ctx, "cases:alice-0");
      const alice = await ledger.accountDay({ db }, "users:alice", Date.now());
      const theirs = await Promise.all(attackers.map((name) => ledger.accountDay({ db }, `users:${name}`, Date.now())));
      results.push({
        general,
        whole,
        chat: chat.ok ? null : chat.reason,
        outage,
        aliceFloor: floorOf(alice),
        aliceShared: alice.ownUsd + alice.ownHeldUsd,
        shared: before,
        sharedAfter: await shared(),
        floors: theirs.reduce((sum, row) => sum + floorOf(row), 0),
        maxFloor: Math.max(...theirs.map(floorOf)),
        accountsShared: theirs.reduce((sum, row) => sum + row.ownUsd + row.practiceUsd + row.intakeUsd, 0) + alice.ownUsd,
      });
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

// Fourth review, finding 23: three brand-new accounts filled the general $15, and the reserve refuses every owner under
// 14 days old, so a new owner's outage got no diagnosis at all. Each account now has a floor of its own for its own
// outages, outside the shared day (OUTAGE_FLOOR_PER_DAY_USD), and its practice app spends within its share.
test("ATTACK (finding 23): ten fresh accounts doing everything they may leave a day-old owner's outage on her real project diagnosed in full, two days running", async (t) => {
  const days = await attack(t, {}, { days: 2, count: 10 });
  for (const [n, day] of days.entries()) {
    const which = `day ${n + 1}: ${JSON.stringify(day)}`;
    // They used up the general part: Alice's case chat waits, with the sentence that says so.
    assert.equal(day.chat, limits.spendRefusal.reserveKept(), which);
    // And every call of her outage's diagnosis passed: the diagnosis, the council and its summary, the fixes.
    assert.deepEqual(day.outage.refusals, [], which);
    // On her own floor (the reserve is not for an account a day old), none of it in the shared day.
    assert.ok(Math.abs(day.aliceFloor - day.outage.cost) < 1e-4, which);
    assert.equal(day.aliceShared, 0, which);
    assert.ok(Math.abs(day.sharedAfter - day.shared) < 1e-9, which);
  }
});

// Statement 3: the practice app's $2 is within each account's share, so it adds no room in the shared day. A fresh
// account now puts at most its own $2.50 and its customers' $1 into the shared day, each passed by at most the last call
// let through (about $3.57 in all; with the practice allowance beside the share it was $5.50, and three accounts
// filled the general $15).
test("ATTACK (finding 23): it takes five fresh accounts to use up the general part, seven with no reserve, and no number of them stops another owner's outage", async (t) => {
  const kept = await attack(t, {}, { count: 8 });
  const none = await attack(t, { OUTAGE_RESERVE_PERCENT: "0" }, { count: 12 });
  // $15 / $3.57 an account: the fifth fills it. $25 / $3.57: the seventh.
  assert.equal(kept.general, 5, JSON.stringify(kept));
  assert.equal(none.general, 7, JSON.stringify(none));
  // Fresh accounts never reach the reserve, so with it the day stops near $15; without it, at $25.
  assert.equal(kept.whole, null, JSON.stringify(kept));
  assert.ok(kept.shared < 15 + 1, JSON.stringify(kept));
  assert.equal(none.whole, 7, JSON.stringify(none));
  assert.equal(none.chat, limits.spendRefusal.deploymentSpent());
  assert.deepEqual([kept.outage.refusals, none.outage.refusals], [[], []]);
  console.log(`fresh accounts to use up the general part: ${kept.general} with the reserve, ${none.general} without; Alice's outage cost her floor $${kept.outage.cost.toFixed(3)}`);
});

// The reserve, with the floor beside it: accounts a month old whose projects had passed for a day still drain it (it
// takes about twenty), and then an established owner's outage goes on on the floor too.
test("ATTACK (finding 12, 19, 23): established accounts drain the reserve and still cannot stop another owner's outage, new or established", async (t) => {
  const [first, second] = await attack(t, {}, { days: 2, count: 30, newAccounts: false, aliceMadeAgo: 30 * DAY });
  for (const day of [first, second]) {
    assert.equal(day.chat, limits.spendRefusal.deploymentSpent(), JSON.stringify(day));
    assert.ok(day.whole >= 20, JSON.stringify(day));
    assert.deepEqual(day.outage.refusals, [], JSON.stringify(day));
    assert.ok(Math.abs(day.aliceFloor - day.outage.cost) < 1e-4, "the reserve was drained, so it ran on her floor");
  }
  // A day-old owner, the same.
  const fresh = await attack(t, {}, { count: 30, newAccounts: false });
  assert.deepEqual([fresh.chat, fresh.outage.refusals], [limits.spendRefusal.deploymentSpent(), []], JSON.stringify(fresh));
  // Accounts whose projects' checks had only just started passing never reach the reserve; the general part still stops.
  const unsteady = await attack(t, {}, { count: 12, newAccounts: false, steady: false });
  assert.equal(unsteady.whole, null, JSON.stringify(unsteady));
  assert.deepEqual(unsteady.outage.refusals, []);
  console.log(`aged accounts with established projects to drain the reserve: day 1 ${first.whole}, day 2 ${second.whole}`);
});

test("one real outage with the default models fits the floor, the most one can cost included; a smaller floor would cut the last one short", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_16 });
  const ordinary = costOf(REAL_OUTAGE);
  const most = costOf(MOST_OUTAGE);
  assert.ok(ordinary > 0.25 && ordinary < 0.4, `an ordinary outage costs $${ordinary.toFixed(3)}`);
  assert.ok(most > 1 && most < 1.1, `the most one outage costs $${most.toFixed(3)}`);
  const councilMost = [...MOST_OUTAGE.council.map(({ cost }) => cost), MOST_OUTAGE.summary.cost].reduce((sum, cost) => sum + cost, 0);
  assert.ok(councilMost <= 0.5, "the council's own limit");
  const run = (env, outage) =>
    withEnv({ ...ACCOUNTS, ...env }, async () => {
      const db = world({ alice: 1 }, { madeAgo: { alice: DAY } });
      // Nothing is left in the shared day.
      await db.insert("deploymentTotals", { name: "model_usd_day", window: "2026-11-16", value: 25, updatedAt: 1 });
      return await diagnoseOutage(actions(db), "cases:alice-0", outage);
    });
  assert.deepEqual((await run({}, REAL_OUTAGE)).refusals, []);
  assert.deepEqual((await run({}, MOST_OUTAGE)).refusals, []);
  assert.deepEqual((await run({ OUTAGE_FLOOR_PER_DAY_USD: "1" }, MOST_OUTAGE)).refusals, [limits.spendRefusal.floorUsed(1)]);
  await withEnv({ OUTAGE_FLOOR_PER_DAY_USD: undefined }, () => assert.equal(limits.outageFloorPerDayUsd(), 1.25));
  for (const nonsense of ["", "0", "-1", "lots"]) await withEnv({ OUTAGE_FLOOR_PER_DAY_USD: nonsense }, () => assert.equal(limits.outageFloorPerDayUsd(), 1.25, nonsense));
  await withEnv({ OUTAGE_FLOOR_PER_DAY_USD: "3" }, () => assert.equal(limits.outageFloorPerDayUsd(), 3));
  console.log(`one outage with the default models: $${ordinary.toFixed(3)} at ordinary sizes, $${most.toFixed(3)} at the most`);
});

test("ATTACK (finding 23): the floor is only for an outage turtl's checks found on the owner's own real project: never a practice app, a case customers raised, or another account's project", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOV_16 });
  await withEnv(ACCOUNTS, async () => {
    const db = world({ alice: 1, mallory: 2 }, { newAccounts: ["alice", "mallory"] });
    // Nothing is left in the shared day.
    await db.insert("deploymentTotals", { name: "model_usd_day", window: "2026-11-16", value: 25, updatedAt: 1 });
    const ctx = actions(db);
    const spentUp = limits.spendRefusal.deploymentSpent();
    const floor = async (name) => floorOf(await ledger.accountDay({ db }, `users:${name}`, Date.now()));
    // Her practice app, which she breaks at will.
    assert.equal((await modelCall(ctx, { caseId: "cases:alice-1" }, DIAGNOSIS)).reason, spentUp, "a practice app");
    // A case customers raised on her real project, however its calls are labelled.
    await db.patch("cases:alice-0", { raisedBy: "customer", kind: "bug_report" });
    for (const allowance of ["outage", "intake", undefined]) {
      assert.equal((await modelCall(ctx, { caseId: "cases:alice-0" }, { ...DIAGNOSIS, allowance })).reason, spentUp, `a customer's case, ${allowance}`);
    }
    await db.patch("cases:alice-0", { raisedBy: "monitor", kind: "outage" });
    // A call for the project rather than for a case the monitor raised, and the case chat on that case.
    assert.equal((await modelCall(ctx, { appId: "apps:alice-0" }, DIAGNOSIS)).reason, spentUp, "not a case");
    assert.equal((await modelCall(ctx, { caseId: "cases:alice-0" }, CHAT)).reason, spentUp, "the chat");
    assert.equal(await floor("alice"), 0, "none of them touched her floor");
    // Mallory's outages on her two real projects draw her own floor, and stop at it.
    const mallory = await spendAll(ctx, { caseId: "cases:mallory-0" }, DIAGNOSIS, 20);
    assert.equal(mallory.refusal, limits.spendRefusal.floorUsed(1.25));
    assert.equal((await modelCall(ctx, { caseId: "cases:mallory-1" }, DIAGNOSIS)).reason, mallory.refusal, "her other project has the same floor");
    assert.ok((await floor("mallory")) >= 1.25 && (await floor("mallory")) <= 1.25 + DIAGNOSIS.estimate);
    assert.equal(await floor("alice"), 0, "and Alice's is untouched");
    // Alice's own outage passes on hers, and the shared day is where it was.
    assert.equal((await modelCall(ctx, { caseId: "cases:alice-0" }, DIAGNOSIS)).ok, true);
    assert.ok(Math.abs((await floor("alice")) - DIAGNOSIS.cost) < 1e-6);
    assert.equal(await ceilings.deploymentSpendToday({ db }, Date.now()), 25);
    plain(limits.spendRefusal.floorUsed(1.25));
    assert.equal(
      limits.spendRefusal.floorUsed(1.25),
      "this account has used the $1.25 turtl keeps for it each day for finding the cause of its own outages, and no other AI is left for it today, so no model was asked; it starts again tomorrow",
    );
  });
});

// Statement 2: what the guarantee costs the operator. Floor spend is outside the shared day, so the worst day is the
// ceiling plus the floors actually used; each account's month (MODEL_SPEND_LIMIT_USD) counts its floor spend too.
test("the operator's worst case is the ceiling plus the floors used, and no account's floor passes its month", async (t) => {
  // Forty fresh accounts doing everything they may, then Alice's outage.
  const day = await attack(t, {}, { count: 40 });
  // Each drew its whole floor, and no more than one call past it.
  assert.ok(day.maxFloor <= 1.25 + DIAGNOSIS.estimate, JSON.stringify(day));
  assert.ok(day.floors >= 40 * 1.25 && day.floors <= 40 * (1.25 + DIAGNOSIS.estimate), JSON.stringify(day));
  // None of it is in the shared day: that is exactly what the accounts spent within their shares.
  assert.ok(Math.abs(day.sharedAfter - day.accountsShared) < 1e-3, JSON.stringify(day));
  const operator = day.sharedAfter + day.floors + day.aliceFloor;
  const bound = limits.deploymentModelSpendPerDayUsd() + 41 * (1.25 + DIAGNOSIS.estimate);
  assert.ok(operator <= bound, `$${operator.toFixed(2)} of at most $${bound.toFixed(2)}`);
  console.log(`forty fresh accounts and Alice: shared day $${day.sharedAfter.toFixed(2)}, floors $${(day.floors + day.aliceFloor).toFixed(2)}`);

  // One account drawing its whole floor every day: its month stops it at $20, within sixteen days ($1.25 a day, and
  // each day up to one call past it).
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-12-01T09:00:00Z") });
  await withEnv(ACCOUNTS, async () => {
    const db = world({ mallory: 1 }, { newAccounts: ["mallory"] });
    const ctx = actions(db);
    const refusals = [];
    for (let n = 0; n < 31; n++) {
      t.mock.timers.setTime(Date.parse("2026-12-01T09:00:00Z") + n * DAY);
      const window = new Date(Date.now()).toISOString().slice(0, 10);
      await db.insert("deploymentTotals", { name: "model_usd_day", window, value: 25, updatedAt: 1 });
      refusals.push((await spendAll(ctx, { caseId: "cases:mallory-0" }, DIAGNOSIS, 20)).refusal);
    }
    const month = await ledger.monthSpend({ db }, "users:mallory", Date.now());
    // The month is checked against costs that came back, so the calls of the burst that reached it can pass it, by no
    // more than the floor holds at once.
    assert.ok(month >= 20 && month <= 20 + 1.25 + DIAGNOSIS.estimate, `$${month.toFixed(2)} in December`);
    const overLimit = limits.spendRefusal.overLimit(20, Date.now());
    const over = refusals.indexOf(overLimit);
    assert.ok(over >= 14 && over <= 16, `the month stopped it on day ${over + 1}`);
    assert.ok(refusals.slice(0, over).every((reason) => reason === limits.spendRefusal.floorUsed(1.25)), "until then, its floor each day");
    assert.ok(refusals.slice(over).every((reason) => reason === overLimit), "and then nothing for the rest of the month");
  });

  // The arithmetic in convex/spend/README.md, from the settings' defaults: in a day, at most the 200 accounts the
  // sign-up limits let in that day (100 through Apple or GitHub, 100 confirmed password accounts) plus the accounts
  // already there can draw a floor; in a month, each at most its $20.
  const signUpsPerDay = limits.DEFAULT_NEW_ACCOUNTS_PER_DAY + limits.DEFAULT_CONFIRMED_SIGNUPS_PER_DAY;
  assert.equal(signUpsPerDay, 200);
  assert.equal(limits.DEFAULT_DEPLOYMENT_MODEL_SPEND_PER_DAY_USD + limits.DEFAULT_OUTAGE_FLOOR_PER_DAY_USD * signUpsPerDay, 275);
  assert.equal(30 * limits.DEFAULT_DEPLOYMENT_MODEL_SPEND_PER_DAY_USD + Math.min(30 * limits.DEFAULT_OUTAGE_FLOOR_PER_DAY_USD, limits.DEFAULT_MODEL_SPEND_LIMIT_USD) * 30 * signUpsPerDay, 120_750);
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

test("a practice app's cases have an allowance within the account's share: ten breaks a day explained by AI fit, then it stops, with a plain sentence", async (t) => {
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
    assert.equal(day.ownUsd, 0, "kept apart from the owner's own calls");
    assert.ok((await ledger.monthSpend({ db }, "users:ada", Date.now())) > 0, "it counts toward the month like the owner's own calls");
    // And no more: asking about it again and again stops at the allowance.
    const more = await spendAll(ctx, practiceCase, CHAT, 20);
    assert.equal(more.refusal, limits.spendRefusal.practiceSpent(2));
    day = await ledger.accountDay({ db }, "users:ada", Date.now());
    assert.ok(day.practiceUsd <= 2 + CHAT.estimate, `the practice app's day stopped at $${day.practiceUsd.toFixed(2)}`);
    // Within the share (finding 23): what is left of her $2.50 is all her own calls may spend today.
    const own = await spendAll(ctx, { caseId: "cases:ada-0" }, CHAT, 20);
    assert.equal(own.refusal, limits.spendRefusal.accountDaySpent(2.5));
    day = await ledger.accountDay({ db }, "users:ada", Date.now());
    assert.ok(day.ownUsd + day.practiceUsd <= 2.5 + CHAT.estimate, `her share stopped at $${(day.ownUsd + day.practiceUsd).toFixed(2)}`);
    assert.ok(day.ownUsd < 0.5 + CHAT.estimate, `her own calls had $${day.ownUsd.toFixed(2)}`);
    // An outage on her real project is still diagnosed: on her floor, now that her share is used.
    assert.equal((await modelCall(ctx, { caseId: "cases:ada-0" }, DIAGNOSIS)).ok, true);
    assert.ok(Math.abs((await ledger.accountDay({ db }, "users:ada", Date.now())).floorUsd - DIAGNOSIS.cost) < 1e-6);
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
    // Where an outage's diagnosis is let through: the reserve, or (finding 23) the owner's own floor when the reserve
    // will not have it. An owner no longer reads the reserve's refusals; the floor's sentence is the one left.
    const where = async (caseId) => {
      const answer = await gates.admit.handler({ db }, { scope: { caseId }, service: "openai", purpose: "send", allowance: "outage", estimateUsd: 0.05 });
      return answer.ok ? (answer.floor ? "floor" : "reserve") : answer.reason;
    };
    assert.equal(await where("cases:alice-0"), "reserve", "a real outage on an established project");
    assert.equal(await where("cases:alice-1"), limits.spendRefusal.reserveKept(), "her practice app: neither");
    await db.patch("cases:alice-0", { passingForMs: 23 * 3_600_000 });
    assert.equal(await where("cases:alice-0"), "floor", "a check that had passed for less than a day");
    await db.patch("cases:alice-0", { passingForMs: undefined });
    assert.equal(await where("cases:alice-0"), "floor", "a case from before the time was kept");
    assert.equal(await where("cases:newcomer-0"), "floor", "an account made this hour");
    await db.patch("users:newcomer", { _creationTime: NOV_16 - 15 * DAY });
    assert.equal(await where("cases:newcomer-0"), "reserve", "fifteen days later it qualifies");
    // The floor was held, not added to the shared day.
    assert.equal(await ceilings.deploymentSpendToday({ db }, Date.now()), 15.2);
  });
  await withEnv({ OUTAGE_RESERVE_STEADY_HOURS: undefined, OUTAGE_RESERVE_ACCOUNT_AGE_DAYS: undefined }, () => {
    assert.deepEqual([limits.outageReserveSteadyMs(), limits.outageReserveAccountAgeMs()], [24 * 3_600_000, 14 * DAY]);
  });
  await withEnv({ OUTAGE_RESERVE_STEADY_HOURS: "72", OUTAGE_RESERVE_ACCOUNT_AGE_DAYS: "30" }, () => {
    assert.deepEqual([limits.outageReserveSteadyMs(), limits.outageReserveAccountAgeMs()], [72 * 3_600_000, 30 * DAY]);
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
// An outage the monitor raised on the owner's real project is left alone wherever its own floor still has room
// (finding 23): it waits only once the account's month or its floor is used too.
const daySpent = (fields) => ({ account: "users:ada", day: "2026-11-16", ownUsd: 0, ownHeldUsd: 0, intakeUsd: 0, intakeHeldUsd: 0, calls: 1, updatedAt: 1, ...fields });
const CEILINGS = [
  ["the deployment's day", async (db) => db.insert("deploymentTotals", { name: "model_usd_day", window: "2026-11-16", value: 25, updatedAt: 1 }), { own: limits.spendRefusal.deploymentSpent(), intake: limits.spendRefusal.deploymentSpent() }],
  ["the account's month", async (db) => db.insert("modelSpend", { account: "users:ada", month: "2026-11", costUsd: 20, calls: 1, updatedAt: 1 }), { own: limits.spendRefusal.overLimit(20, NOV_16), outage: limits.spendRefusal.overLimit(20, NOV_16) }],
  ["the account's own share of the day", async (db) => db.insert("accountSpendDays", daySpent({ ownUsd: 2.5 })), { own: limits.spendRefusal.accountDaySpent(2.5) }],
  ["its share, its practice app's part of it", async (db) => db.insert("accountSpendDays", daySpent({ ownUsd: 0.5, practiceUsd: 2 })), { own: limits.spendRefusal.accountDaySpent(2.5) }],
  ["its customers' share of the day", async (db) => db.insert("accountSpendDays", daySpent({ intakeUsd: 1 })), { intake: limits.spendRefusal.accountIntakeSpent(1) }],
  ["the project's customer-report day", async (db) => db.insert("intakeDays", { appId: "apps:ada-0", day: "2026-11-16", costUsd: 0.5, calls: 1, casesOpened: 0, updatedAt: 1 }), { intake: limits.spendRefusal.intakeSpent(0.5) }],
  ["all but the part kept for outages", async (db) => db.insert("deploymentTotals", { name: "model_usd_day", window: "2026-11-16", value: 15, updatedAt: 1 }), { own: limits.spendRefusal.reserveKept(), intake: limits.spendRefusal.reserveKept() }],
  ["the outage part, for an account past $0.50 today", async (db) => {
    await db.insert("deploymentTotals", { name: "model_usd_day", window: "2026-11-16", value: 15, updatedAt: 1 });
    await db.insert("accountSpendDays", daySpent({ ownUsd: 0.6 }));
  }, { own: limits.spendRefusal.reserveKept(), intake: limits.spendRefusal.reserveKept() }],
  ["the deployment's day and the account's floor", async (db) => {
    await db.insert("deploymentTotals", { name: "model_usd_day", window: "2026-11-16", value: 25, updatedAt: 1 });
    await db.insert("accountSpendDays", daySpent({ floorUsd: 1.25 }));
  }, { own: limits.spendRefusal.deploymentSpent(), outage: limits.spendRefusal.floorUsed(1.25), intake: limits.spendRefusal.deploymentSpent() }],
  ["the account's own share and its floor", async (db) => db.insert("accountSpendDays", daySpent({ ownUsd: 2.5, floorUsd: 1.25 })), { own: limits.spendRefusal.accountDaySpent(2.5), outage: limits.spendRefusal.floorUsed(1.25) }],
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
        const held = (row) => row.ownHeldUsd + row.intakeHeldUsd + (row.practiceHeldUsd ?? 0) + (row.floorHeldUsd ?? 0);
        assert.deepEqual(db.rows("accountSpendDays").map(held).filter(Boolean), [], "a refused call is not held");
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
  for (const reason of [limits.spendRefusal.deploymentSpent(), limits.spendRefusal.accountDaySpent(2.5), limits.spendRefusal.floorUsed(1.25)]) {
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
    // The demo's one question is whether the deployment holds accounts (review finding 20, convex/access.ts), asked
    // through the gate's check: never an admission, a hold or a share.
    const asked = [];
    const ctx = { runQuery: async (fn) => (asked.push(fn.path), { ok: true, account: "solo-owner" }), runMutation: () => assert.fail("the demo wrote spend") };
    const gate = gates.gateFor(ctx, { appId: "apps:1" });
    assert.equal((await gate.open("openai", "send", 1)).ok, true);
    assert.deepEqual(asked, ["internal.consent.gate.check"]);
    await gate.spent(1);
  });
});
