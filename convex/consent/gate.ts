import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type ActionCtx, type QueryCtx } from "../_generated/server";
import { accessEnforced, demoHoldsAccounts, SOLO_ACCOUNT, UNAVAILABLE } from "../access";
import { deploymentSpendToday } from "../spend/ceilings";
import { accountDay, holdModelCall, intakeSpendToday, monthSpend, threadsToday, type Share } from "../spend/ledger";
import {
  accountIntakeSpendPerDayUsd,
  accountModelSpendPerDayUsd,
  codingThreadsPerDay,
  deploymentModelSpendPerDayUsd,
  intakeSpendPerDayUsd,
  MAX_CALL_HOLD_USD,
  MODEL_CALL_HOLD_USD,
  modelSpendLimitUsd,
  outageReserveAccountUsd,
  outageReserveAccountAgeMs,
  outageReservePercent,
  outageReserveSteadyMs,
  practiceAiPerDayUsd,
  spendRefusal,
} from "../spend/limits";
import { sendTo } from "./outbound";
import { asAgreement, latestAgreement } from "./permission";
import { MODEL_SERVICES, permissionFor, refusal, serviceName, type Outbound } from "./services";

// The question every outbound call asks before it sends: is this project's owner's permission in force for this
// service, and is the account inside its limits? Most calls run in scheduled actions with no identity, so the owner
// is read from the project (appId -> apps.ownerId), or from a case's project, never from ctx.auth.
//
// In the single-owner demo (AUTH_REQUIRED unset) every answer is yes and nothing is read or written, so the demo
// behaves exactly as before. In accounts mode a missing, declined, taken-back or outdated permission, or a spent
// limit, is a no with a reason in plain words, and the vendor helper falls back the way it does without its key.

/** Whose project a call is for: a project, a case (its project), or an account directly. */
export type Scope = { appId: string } | { caseId: string } | { account: string };

/**
 * Whose allowance a model call spends. "account" (the default): the owner's monthly allowance, which diagnosis needs.
 * "intake": the project's daily allowance for its customers' reports (triage, and reading the cases they open), so
 * whatever a customer posts cannot spend the owner's allowance and stop turtl diagnosing their outages.
 * "outage": the owner's allowance, for investigating or planning a case the monitor raised (the scope must be that
 * case). Such a call may also use the last part of the deployment's day, kept for outages (convex/spend/README.md).
 */
export type Allowance = "account" | "intake" | "outage";

/**
 * send: an ordinary call. start_thread: starting a coding agent, which also counts against the daily limit.
 * erase: a request that only deletes the owner's data at the vendor; it is let through without permission.
 */
export type Purpose = "send" | "start_thread" | "erase";

type Answer = { ok: true; account: string; appId?: Id<"apps">; held?: number; practice?: boolean } | { ok: false; reason: string };

export interface Gate {
  /** Null when turtl may send to this service now, otherwise the plain reason it may not. */
  blocked(service: Outbound, purpose?: Purpose): Promise<string | null>;
  /** Asks, and on a yes hands back the only fetch that may reach the service. A model call is counted at once, at
   * `estimateUsd` (the most it is likely to cost: callEstimate in convex/spend/limits.ts) until spent() reports it. */
  open(service: Outbound, purpose?: Purpose, estimateUsd?: number): Promise<{ ok: true; fetch: typeof fetch } | { ok: false; reason: string }>;
  /** Adds a call's estimated cost to the account's month and day, in place of its hold. Does nothing in the demo. */
  spent(costUsd: number): Promise<void>;
  /** Counts a started coding-agent thread against the account's day. Does nothing in the demo. */
  threadStarted(requestId: string): Promise<void>;
}

const vScope = v.union(v.object({ appId: v.string() }), v.object({ caseId: v.string() }), v.object({ account: v.string() }));
const vPurpose = v.union(v.literal("send"), v.literal("start_thread"), v.literal("erase"));
const vAllowance = v.union(v.literal("account"), v.literal("intake"), v.literal("outage"));

type Owner = {
  account: string | null;
  appId: Id<"apps"> | null;
  raisedByMonitor: boolean;
  /** The project is a practice app (convex/practice): it has no customers, and its cases are made at will. */
  practice: boolean;
  /** For a case the monitor raised: how long its check had been passing before it failed. */
  passingForMs: number;
};

async function ownerOf(ctx: Pick<QueryCtx, "db">, scope: Scope): Promise<Owner> {
  if ("account" in scope) return { account: scope.account || null, appId: null, raisedByMonitor: false, practice: false, passingForMs: 0 };
  let appId = "appId" in scope ? ctx.db.normalizeId("apps", scope.appId) : null;
  let raisedByMonitor = false;
  let passingForMs = 0;
  if ("caseId" in scope) {
    const caseId = ctx.db.normalizeId("cases", scope.caseId);
    const row = caseId ? await ctx.db.get(caseId) : null;
    appId = row?.appId ?? null;
    raisedByMonitor = row?.raisedBy === "monitor";
    passingForMs = row?.passingForMs ?? 0;
  }
  const app = appId ? await ctx.db.get(appId) : null;
  return { account: app?.ownerId ?? null, appId: app ? app._id : null, raisedByMonitor, practice: app?.practice === true, passingForMs };
}

/** When the account was made, or null when it is not an account turtl knows. */
async function accountMadeAt(ctx: Pick<QueryCtx, "db">, account: string): Promise<number | null> {
  const id = ctx.db.normalizeId("users", account);
  return id ? ((await ctx.db.get(id))?._creationTime ?? null) : null;
}

type Args = { scope: Scope; service: string; purpose: Purpose; allowance?: Allowance; estimateUsd?: number };
type Decision = { answer: Answer; hold: Share | null };

const isModelCall = (service: string, purpose: Purpose) => purpose === "send" && (MODEL_SERVICES as readonly string[]).includes(service);

// The answer for one call. `hold` names the account's day share a model call it lets through counts against until its
// cost comes back: admit holds it, check (which only asks) does not.
async function decide(ctx: Pick<QueryCtx, "db">, { scope, service, purpose, allowance = "account" }: Args): Promise<Decision> {
  const no = (reason: string): Decision => ({ answer: { ok: false, reason }, hold: null });
  // The demo says yes, unless the deployment holds accounts: then it is no demo, and nothing leaves (convex/access.ts).
  if (!accessEnforced()) return (await demoHoldsAccounts(ctx)) ? no(UNAVAILABLE) : { answer: { ok: true, account: SOLO_ACCOUNT }, hold: null };
  const { account, appId, raisedByMonitor, practice, passingForMs } = await ownerOf(ctx, scope);
  if (purpose === "erase") return { answer: { ok: true, account: account ?? "" }, hold: null };
  if (!account) return no(refusal.noOwner(serviceName(service)));
  // A customer-report call is billed to its project, so it must name one.
  if (allowance === "intake" && !appId) return no(refusal.noOwner(serviceName(service)));
  const permitted = permissionFor(asAgreement(await latestAgreement(ctx, account)), service);
  if (!permitted.ok) return { answer: permitted, hold: null };
  const now = Date.now();
  let hold: Decision["hold"] = null;
  if (isModelCall(service, purpose)) {
    // The deployment's own daily ceiling comes first: however many accounts there are, the day's total is bounded.
    const ceiling = deploymentModelSpendPerDayUsd();
    const total = await deploymentSpendToday(ctx, now);
    if (total >= ceiling) return no(spendRefusal.deploymentSpent());
    // Then the account's share of that day, so one account (its own calls, or its customers' reports) cannot reach the
    // ceiling alone and stop every other owner's diagnosis (finding 12). Calls still running count at their hold.
    const day = await accountDay(ctx, account, now);
    const own = day.ownUsd + day.ownHeldUsd;
    if (allowance === "intake") {
      const limit = intakeSpendPerDayUsd();
      if ((await intakeSpendToday(ctx, appId!, now)) >= limit) return no(spendRefusal.intakeSpent(limit));
      const share = accountIntakeSpendPerDayUsd();
      if (day.intakeUsd + day.intakeHeldUsd >= share) return no(spendRefusal.accountIntakeSpent(share));
      hold = "intake";
    } else {
      const limit = modelSpendLimitUsd();
      if ((await monthSpend(ctx, account, now)) >= limit) return no(spendRefusal.overLimit(limit, now));
      if (practice) {
        // A practice app's cases have their own small allowance, enough for its ten breaks a day explained by AI, so
        // breaking it neither uses up the owner's share nor reaches the part of the day kept for outages (finding 19).
        const allowed = practiceAiPerDayUsd();
        if (day.practiceUsd + day.practiceHeldUsd >= allowed) return no(spendRefusal.practiceSpent(allowed));
        hold = "practice";
      } else {
        const share = accountModelSpendPerDayUsd();
        if (own >= share) return no(spendRefusal.accountDaySpent(share));
        hold = "own";
      }
    }
    // The last part of the day is kept for finding the cause of outages the monitor found, on accounts that have used
    // little of the day: a few accounts that used their whole shares cannot reach it, and each other account draws on
    // it only until its own day passes outageReserveAccountUsd(). Only real outages on established projects qualify
    // (finding 19): never a practice app, whose cases anyone makes at will; only a check that had been passing for
    // outageReserveSteadyMs() before it failed; only an account older than outageReserveAccountAgeMs().
    if (total >= ceiling * (1 - outageReservePercent() / 100)) {
      if (allowance !== "outage" || !raisedByMonitor || practice) return no(spendRefusal.reserveKept());
      const steady = outageReserveSteadyMs();
      if (passingForMs < steady) return no(spendRefusal.reserveNotSteady(Math.round(steady / 3_600_000)));
      const age = outageReserveAccountAgeMs();
      const madeAt = await accountMadeAt(ctx, account);
      if (madeAt === null || now - madeAt < age) return no(spendRefusal.reserveNewAccount(Math.round(age / 86_400_000)));
      const under = outageReserveAccountUsd();
      if (own >= under) return no(spendRefusal.reserveUsed(under));
    }
  }
  if (purpose === "start_thread") {
    const cap = codingThreadsPerDay();
    if ((await threadsToday(ctx, account, now)) >= cap) return no(spendRefusal.threadCap(cap));
  }
  return {
    answer: allowance === "intake" ? { ok: true, account, appId: appId! } : { ok: true, account, ...(hold === "practice" && { practice: true }) },
    hold,
  };
}

const vArgs = { scope: vScope, service: v.string(), purpose: vPurpose, allowance: v.optional(vAllowance), estimateUsd: v.optional(v.number()) };

/** What an admitted call is held at: its caller's estimate, within bounds, or the flat hold when it gave none. */
const holdFor = (estimateUsd: number | undefined) =>
  estimateUsd !== undefined && Number.isFinite(estimateUsd) && estimateUsd > 0 ? Math.min(estimateUsd, MAX_CALL_HOLD_USD) : MODEL_CALL_HOLD_USD;
const vAnswer = v.union(
  v.object({ ok: v.literal(true), account: v.string(), appId: v.optional(v.id("apps")), held: v.optional(v.number()), practice: v.optional(v.boolean()) }),
  v.object({ ok: v.literal(false), reason: v.string() }),
);

// Asks without counting anything: for `blocked`, which only wants to know.
export const check = internalQuery({
  args: vArgs,
  returns: vAnswer,
  handler: async (ctx, args): Promise<Answer> => (await decide(ctx, args)).answer,
});

// Asks and, on a yes for a model call, counts the call at its estimate against the account's day in the same
// transaction. Calls started together are then counted one after another, so a burst stops at the account's share:
// the day's total can pass the share by at most the last call let through.
export const admit = internalMutation({
  args: vArgs,
  returns: vAnswer,
  handler: async (ctx, args): Promise<Answer> => {
    const { answer, hold } = await decide(ctx, args);
    if (!answer.ok || !hold) return answer;
    const held = holdFor(args.estimateUsd);
    await holdModelCall(ctx, answer.account, hold, held);
    return { ...answer, held };
  },
});

type Runner = Pick<ActionCtx, "runQuery" | "runMutation">;

/** The gate for one project, case or account. Make one per action and pass it to the vendor helpers. A gate for
 * customer reports (allowance "intake") spends the project's daily customer-report allowance, never the account's. */
export function gateFor(ctx: Runner, scope: Scope, allowance: Allowance = "account"): Gate {
  const enforced = accessEnforced();
  let account: string | null = enforced ? null : SOLO_ACCOUNT;
  let intakeApp: Id<"apps"> | null = null;
  // The project is a practice app: its calls count against the account's practice allowance.
  let practice = false;
  // The holds of the model calls this gate let through whose cost has not come back yet, oldest first.
  const holds: number[] = [];

  // `estimateUsd` set: the call is about to be sent, so a model call is counted at once (admit); otherwise only asked.
  const ask = async (service: Outbound, purpose: Purpose, admitting: { estimateUsd?: number } | null): Promise<Answer> => {
    if (!enforced) return await ctx.runQuery(internal.consent.gate.check, { scope, service, purpose });
    // Deleting the owner's copies at a vendor needs no permission: it sends nothing but the ids to remove.
    if (purpose === "erase") return { ok: true, account: account ?? "" };
    const args = { scope, service, purpose, ...(allowance !== "account" && { allowance }) };
    const answer: Answer = admitting && isModelCall(service, purpose)
      ? await ctx.runMutation(internal.consent.gate.admit, { ...args, ...(admitting.estimateUsd !== undefined && { estimateUsd: admitting.estimateUsd }) })
      : await ctx.runQuery(internal.consent.gate.check, args);
    if (answer.ok) {
      account = answer.account;
      intakeApp = answer.appId ?? intakeApp;
      practice ||= answer.practice === true;
      if (answer.held) holds.push(answer.held);
    }
    return answer;
  };

  return {
    blocked: async (service, purpose = "send") => {
      const answer = await ask(service, purpose, null);
      return answer.ok ? null : answer.reason;
    },
    open: async (service, purpose = "send", estimateUsd) => {
      const answer = await ask(service, purpose, { estimateUsd });
      return answer.ok ? { ok: true, fetch: sendTo(service) } : { ok: false, reason: answer.reason };
    },
    spent: async (costUsd) => {
      if (!enforced || !account) return;
      if (allowance === "intake" && !intakeApp) return;
      // Each call's cost takes the place of the hold it was let through with.
      const release = holds.shift() ?? 0;
      if (!(costUsd > 0) && release === 0) return;
      try {
        await ctx.runMutation(internal.spend.ledger.addModelSpend, {
          account,
          costUsd: costUsd > 0 ? costUsd : 0,
          ...(intakeApp && { appId: intakeApp }),
          ...(release > 0 && { held: release }),
          ...(practice && { practice: true }),
        });
      } catch {
        console.error("Recording model spend failed");
      }
    },
    threadStarted: async (requestId) => {
      if (!enforced || !account) return;
      try {
        await ctx.runMutation(internal.spend.ledger.recordThread, { account, requestId });
      } catch {
        console.error("Recording a coding-agent thread failed");
      }
    },
  };
}
