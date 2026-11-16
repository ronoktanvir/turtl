import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalQuery, type ActionCtx, type QueryCtx } from "../_generated/server";
import { accessEnforced, SOLO_ACCOUNT } from "../access";
import { monthSpend, threadsToday } from "../spend/ledger";
import { codingThreadsPerDay, modelSpendLimitUsd, spendRefusal } from "../spend/limits";
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
 * send: an ordinary call. start_thread: starting a coding agent, which also counts against the daily limit.
 * erase: a request that only deletes the owner's data at the vendor; it is let through without permission.
 */
export type Purpose = "send" | "start_thread" | "erase";

type Answer = { ok: true; account: string } | { ok: false; reason: string };

export interface Gate {
  /** Null when turtl may send to this service now, otherwise the plain reason it may not. */
  blocked(service: Outbound, purpose?: Purpose): Promise<string | null>;
  /** Asks, and on a yes hands back the only fetch that may reach the service. */
  open(service: Outbound, purpose?: Purpose): Promise<{ ok: true; fetch: typeof fetch } | { ok: false; reason: string }>;
  /** Adds a call's estimated cost to the account's month. Does nothing in the demo. */
  spent(costUsd: number): Promise<void>;
  /** Counts a started coding-agent thread against the account's day. Does nothing in the demo. */
  threadStarted(requestId: string): Promise<void>;
}

const vScope = v.union(v.object({ appId: v.string() }), v.object({ caseId: v.string() }), v.object({ account: v.string() }));
const vPurpose = v.union(v.literal("send"), v.literal("start_thread"), v.literal("erase"));

async function ownerOf(ctx: Pick<QueryCtx, "db">, scope: Scope): Promise<string | null> {
  if ("account" in scope) return scope.account || null;
  let appId = "appId" in scope ? ctx.db.normalizeId("apps", scope.appId) : null;
  if ("caseId" in scope) {
    const caseId = ctx.db.normalizeId("cases", scope.caseId);
    appId = caseId ? ((await ctx.db.get(caseId))?.appId ?? null) : null;
  }
  const app = appId ? await ctx.db.get(appId) : null;
  return app?.ownerId ?? null;
}

export const check = internalQuery({
  args: { scope: vScope, service: v.string(), purpose: vPurpose },
  returns: v.union(v.object({ ok: v.literal(true), account: v.string() }), v.object({ ok: v.literal(false), reason: v.string() })),
  handler: async (ctx, { scope, service, purpose }): Promise<Answer> => {
    if (!accessEnforced()) return { ok: true, account: SOLO_ACCOUNT };
    const account = await ownerOf(ctx, scope);
    if (purpose === "erase") return { ok: true, account: account ?? "" };
    if (!account) return { ok: false, reason: refusal.noOwner(serviceName(service)) };
    const permitted = permissionFor(asAgreement(await latestAgreement(ctx, account)), service);
    if (!permitted.ok) return permitted;
    const now = Date.now();
    if (purpose === "send" && (MODEL_SERVICES as readonly string[]).includes(service)) {
      const limit = modelSpendLimitUsd();
      if ((await monthSpend(ctx, account, now)) >= limit) return { ok: false, reason: spendRefusal.overLimit(limit, now) };
    }
    if (purpose === "start_thread") {
      const cap = codingThreadsPerDay();
      if ((await threadsToday(ctx, account, now)) >= cap) return { ok: false, reason: spendRefusal.threadCap(cap) };
    }
    return { ok: true, account };
  },
});

/**
 * The gate for a call no project owns (only convex/assistant.ts, which is being deleted). Open in the demo, as before;
 * in accounts mode it refuses everything, because there is no owner whose permission could apply.
 */
export function unscopedGate(): Gate {
  const refused = (service: Outbound) => (accessEnforced() ? refusal.noOwner(serviceName(service)) : null);
  return {
    blocked: async (service) => refused(service),
    open: async (service) => {
      const reason = refused(service);
      return reason ? { ok: false, reason } : { ok: true, fetch: sendTo(service) };
    },
    spent: async () => {},
    threadStarted: async () => {},
  };
}

type Runner = Pick<ActionCtx, "runQuery" | "runMutation">;

/** The gate for one project, case or account. Make one per action and pass it to the vendor helpers. */
export function gateFor(ctx: Runner, scope: Scope): Gate {
  const enforced = accessEnforced();
  let account: string | null = enforced ? null : SOLO_ACCOUNT;

  const ask = async (service: Outbound, purpose: Purpose): Promise<Answer> => {
    if (!enforced) return { ok: true, account: SOLO_ACCOUNT };
    // Deleting the owner's copies at a vendor needs no permission: it sends nothing but the ids to remove.
    if (purpose === "erase") return { ok: true, account: account ?? "" };
    const answer: Answer = await ctx.runQuery(internal.consent.gate.check, { scope, service, purpose });
    if (answer.ok) account = answer.account;
    return answer;
  };

  return {
    blocked: async (service, purpose = "send") => {
      const answer = await ask(service, purpose);
      return answer.ok ? null : answer.reason;
    },
    open: async (service, purpose = "send") => {
      const answer = await ask(service, purpose);
      return answer.ok ? { ok: true, fetch: sendTo(service) } : { ok: false, reason: answer.reason };
    },
    spent: async (costUsd) => {
      if (!enforced || !account || !(costUsd > 0)) return;
      try {
        await ctx.runMutation(internal.spend.ledger.addModelSpend, { account, costUsd });
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
