import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { CLOSED_CASE_STATUSES } from "../constants";
import { startCaseRun } from "../runner/run";
import { HARNESS_VERSION, RATE_LIMITS, TRIAGE_PROMPT_VERSION, fingerprint, windowStart, type Candidate } from "./rules";
import { vReportHint, vTriageVerdict } from "./schema";

export const PROVIDER = "turtl-form";
const LOCK_MS = 120_000;
const MAX_TRIAGE_ATTEMPTS = 3;
const MAX_CANDIDATES = 20;
const SAMPLE_TEXTS = 3;

const isOpen = (row: Doc<"cases">) => !(CLOSED_CASE_STATUSES as readonly string[]).includes(row.status);
const isCustomerCase = (row: Doc<"cases">) =>
  row.raisedBy === "customer" && (row.kind === "bug_report" || row.kind === "feature_request");

async function sha256(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function reportsOn(ctx: QueryCtx, caseId: Id<"cases">) {
  return await ctx.db
    .query("reports")
    .withIndex("by_case_and_requester", (q) => q.eq("caseId", caseId))
    .collect();
}

// reportCount counts messages; distinctRequesterCount counts the people (fromRef) behind them.
async function recount(ctx: MutationCtx, caseId: Id<"cases">) {
  const rows = await reportsOn(ctx, caseId);
  await ctx.db.patch(caseId, { reportCount: rows.length, distinctRequesterCount: new Set(rows.map((r) => r.fromRef)).size });
}

// Stores one report from the public endpoint after its key and rate limits pass, and queues its triage.
export const receive = internalMutation({
  args: {
    key: v.string(),
    text: v.string(),
    hint: v.optional(vReportHint),
    contact: v.optional(v.string()),
    reporterId: v.optional(v.string()),
    reportId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: true; duplicate: boolean } | { ok: false; status: number; code: string; message: string; retryAfterSeconds?: number }> => {
    const key = await ctx.db.query("intakeKeys").withIndex("by_key", (q) => q.eq("key", args.key)).unique();
    if (!key || key.revokedAt !== undefined || !(await ctx.db.get(key.appId))) {
      return { ok: false, status: 403, code: "UNKNOWN_KEY", message: "This report key is not recognised." };
    }
    const appId = key.appId;
    const fromRef = args.contact
      ? `form:contact:${(await sha256(args.contact.toLowerCase())).slice(0, 24)}`
      : args.reporterId
        ? `form:device:${args.reporterId}`
        : `form:anonymous:${args.reportId ?? crypto.randomUUID()}`;
    const providerEventId = args.reportId ?? crypto.randomUUID();
    const existing = await ctx.db
      .query("reports")
      .withIndex("by_app_and_provider_event", (q) => q.eq("appId", appId).eq("provider", PROVIDER).eq("providerEventId", providerEventId))
      .unique();
    if (existing) return { ok: true, duplicate: true };

    const now = Date.now();
    const buckets = RATE_LIMITS.map((limit) => ({
      ...limit,
      bucket: limit.name.startsWith("key") ? `${limit.name}:${key._id}` : `${limit.name}:${appId}:${fromRef}`,
      start: windowStart(now, limit.windowMs),
    }));
    const windows = await Promise.all(
      buckets.map((b) =>
        ctx.db.query("intakeRateWindows").withIndex("by_bucket_and_window", (q) => q.eq("bucket", b.bucket).eq("windowStart", b.start)).unique(),
      ),
    );
    const full = buckets.findIndex((b, i) => (windows[i]?.count ?? 0) >= b.max);
    if (full >= 0) {
      const b = buckets[full];
      return {
        ok: false,
        status: 429,
        code: "RATE_LIMITED",
        message: "Too many reports right now. Please try again later.",
        retryAfterSeconds: Math.ceil((b.start + b.windowMs - now) / 1000),
      };
    }
    for (const [i, b] of buckets.entries()) {
      const row = windows[i];
      if (row) {
        await ctx.db.patch(row._id, { count: row.count + 1 });
        continue;
      }
      const stale = await ctx.db.query("intakeRateWindows").withIndex("by_bucket_and_window", (q) => q.eq("bucket", b.bucket).lt("windowStart", b.start)).collect();
      for (const old of stale) await ctx.db.delete(old._id);
      await ctx.db.insert("intakeRateWindows", { bucket: b.bucket, windowStart: b.start, count: 1 });
    }

    const reportId = await ctx.db.insert("reports", {
      appId,
      channel: "form",
      fromRef,
      text: args.text,
      provider: PROVIDER,
      providerEventId,
      receivedAt: now,
    });
    await ctx.db.insert("reportTriage", {
      reportId,
      appId,
      fingerprint: fingerprint(args.text),
      status: "pending",
      ...(args.hint && { hint: args.hint }),
      ...(args.contact && { contact: args.contact }),
    });
    await ctx.scheduler.runAfter(0, internal.intake.triage.processNext, { appId });
    return { ok: true, duplicate: false };
  },
});

// Takes the app's triage lock and its oldest pending report; null while another triage holds the lock.
export const claim = internalMutation({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }): Promise<Id<"reportTriage"> | null> => {
    const now = Date.now();
    const lock = await ctx.db.query("intakeLocks").withIndex("by_app", (q) => q.eq("appId", appId)).unique();
    if (lock && lock.until > now) return null;
    const next = await ctx.db
      .query("reportTriage")
      .withIndex("by_app_and_status", (q) => q.eq("appId", appId).eq("status", "pending"))
      .first();
    if (!next) {
      if (lock) await ctx.db.delete(lock._id);
      return null;
    }
    const attempts = (next.attempts ?? 0) + 1;
    if (attempts > MAX_TRIAGE_ATTEMPTS) {
      await ctx.db.patch(next._id, {
        status: "done",
        outcome: "ignored",
        reason: `Triage failed ${MAX_TRIAGE_ATTEMPTS} times, so the report is kept but is on no case.`,
        triagedAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.intake.triage.processNext, { appId });
      return null;
    }
    if (lock) await ctx.db.patch(lock._id, { until: now + LOCK_MS });
    else await ctx.db.insert("intakeLocks", { appId, until: now + LOCK_MS });
    await ctx.db.patch(next._id, { startedAt: now, attempts });
    await ctx.scheduler.runAfter(LOCK_MS + 1_000, internal.intake.triage.processNext, { appId });
    return next._id;
  },
});

export const release = internalMutation({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    const lock = await ctx.db.query("intakeLocks").withIndex("by_app", (q) => q.eq("appId", appId)).unique();
    if (lock) await ctx.db.delete(lock._id);
    const more = await ctx.db
      .query("reportTriage")
      .withIndex("by_app_and_status", (q) => q.eq("appId", appId).eq("status", "pending"))
      .first();
    if (more) await ctx.scheduler.runAfter(0, internal.intake.triage.processNext, { appId });
  },
});

// What triage reads: the report, its app, and the app's open customer cases with a few of their reports.
export const triageInput = internalQuery({
  args: { triageId: v.id("reportTriage") },
  handler: async (ctx, { triageId }) => {
    const triage = await ctx.db.get(triageId);
    if (!triage || triage.status !== "pending") return null;
    const report = await ctx.db.get(triage.reportId);
    const app = await ctx.db.get(triage.appId);
    if (!report || !app) return null;
    const open = (await ctx.db.query("cases").withIndex("by_app_and_signature", (q) => q.eq("appId", app._id)).collect())
      .filter((row) => isOpen(row) && isCustomerCase(row))
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, MAX_CANDIDATES);
    const candidates: (Candidate & { title: string })[] = [];
    for (const [i, row] of open.entries()) {
      const attached = await ctx.db.query("reportTriage").withIndex("by_case", (q) => q.eq("caseId", row._id)).collect();
      const texts = (await reportsOn(ctx, row._id)).slice(0, SAMPLE_TEXTS).map((r) => r.text.slice(0, 300));
      candidates.push({
        ref: `C${i + 1}`,
        caseId: row._id,
        kind: row.kind as Candidate["kind"],
        title: row.title,
        fingerprints: attached.map((t) => t.fingerprint),
        texts,
      });
    }
    return { triage, report, appName: app.name, candidates };
  },
});

// Writes the agentRuns row for each model triage that landed on this case, once its receive step has an attempt.
async function recordRuns(ctx: MutationCtx, caseId: Id<"cases">) {
  const step = await ctx.db
    .query("steps")
    .withIndex("by_case_and_key", (q) => q.eq("caseId", caseId).eq("key", "detect_or_receive"))
    .unique();
  if (!step?.currentAttemptId) return 0;
  const pending = (await ctx.db.query("reportTriage").withIndex("by_case", (q) => q.eq("caseId", caseId)).collect()).filter(
    (t) => t.modelId && !t.agentRunId,
  );
  for (const triage of pending) await insertTriageRun(ctx, triage, { caseId, stepId: step._id, stepAttemptId: step.currentAttemptId });
  return pending.length;
}

// A triage that lands on no case still made a model call, so its row names the app instead of a case.
async function insertTriageRun(
  ctx: MutationCtx,
  triage: Doc<"reportTriage">,
  owner: { caseId: Id<"cases">; stepId: Id<"steps">; stepAttemptId: Id<"stepAttempts"> } | { appId: Id<"apps"> },
) {
  const agentRunId = await ctx.db.insert("agentRuns", {
    ...owner,
    taskType: "triage_customer_report",
    config: { modelId: triage.modelId!, harnessVersion: HARNESS_VERSION, promptVersion: TRIAGE_PROMPT_VERSION, credentialRef: "OPENAI_API_KEY" },
    taskCharacteristics: {
      complexity: "one customer message against the app's open customer cases",
      risk: "untrusted customer text",
      framework: "Expo and Convex",
      repositoryArea: "not inspected",
    },
    contextRefs: [],
    routingReason: "Fixed: the only triage configuration. No routing between configurations yet.",
    status: triage.modelError ? "failed" : "completed",
    ...(triage.modelError && { error: `No model answered: ${triage.modelError}. Rule-based triage was used instead.` }),
    ...(triage.durationMs !== undefined && { durationMs: triage.durationMs }),
    corrections: [],
  });
  await ctx.db.patch(triage._id, { agentRunId });
}

export const recordTriageRuns = internalMutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => recordRuns(ctx, caseId),
});

// Applies one triage decision: ignore the report, attach it to an open case, or open a case raised by the customer.
export const land = internalMutation({
  args: {
    triageId: v.id("reportTriage"),
    verdict: vTriageVerdict,
    source: v.union(v.literal("exact_copy"), v.literal("model"), v.literal("rules")),
    reason: v.string(),
    attachTo: v.optional(v.id("cases")),
    open: v.optional(v.object({ title: v.string(), impact: v.string() })),
    suggestedCaseIds: v.optional(v.array(v.id("cases"))),
    modelId: v.optional(v.string()),
    modelError: v.optional(v.string()),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ outcome: "attached" | "opened" | "ignored"; caseId: Id<"cases"> | null }> => {
    const triage = await ctx.db.get(args.triageId);
    if (!triage || triage.status !== "pending") throw new Error("This report was already triaged.");
    const report = (await ctx.db.get(triage.reportId))!;
    const fields = {
      status: "done" as const,
      verdict: args.verdict,
      source: args.source,
      reason: args.reason,
      triagedAt: Date.now(),
      ...(args.suggestedCaseIds && { suggestedCaseIds: args.suggestedCaseIds }),
      ...(args.modelId && { modelId: args.modelId }),
      ...(args.modelError && { modelError: args.modelError }),
      ...(args.durationMs !== undefined && { durationMs: args.durationMs }),
    };
    const wanted = args.verdict === "bug" ? "bug_report" : "feature_request";
    const target = args.attachTo ? await ctx.db.get(args.attachTo) : null;
    if (args.verdict !== "noise" && target && target.appId === report.appId && isOpen(target) && isCustomerCase(target) && target.kind === wanted) {
      await ctx.db.patch(report._id, { caseId: target._id });
      await ctx.db.patch(triage._id, { ...fields, outcome: "attached", caseId: target._id });
      await recount(ctx, target._id);
      await recordRuns(ctx, target._id);
      return { outcome: "attached", caseId: target._id };
    }
    if (args.verdict === "noise" || !args.open) {
      await ctx.db.patch(triage._id, { ...fields, outcome: "ignored" });
      if (args.modelId) await insertTriageRun(ctx, (await ctx.db.get(triage._id))!, { appId: report.appId });
      return { outcome: "ignored", caseId: null };
    }
    const app = (await ctx.db.get(report.appId))!;
    const journey = await ctx.db.query("journeys").withIndex("by_app", (q) => q.eq("appId", app._id)).first();
    const caseId = await startCaseRun(ctx, {
      appId: app._id,
      kind: wanted,
      raisedBy: "customer",
      raisedByRef: "customer report form",
      title: args.open.title,
      impact: args.open.impact,
      signature: `customer:${triage._id}`,
      reportCount: 1,
    });
    await ctx.db.patch(caseId, { distinctRequesterCount: 1, ...(journey && { journeyId: journey._id }) });
    await ctx.db.patch(report._id, { caseId });
    await ctx.db.patch(triage._id, { ...fields, outcome: "opened", caseId });
    await ctx.scheduler.runAfter(0, internal.notices.notifyOwner, {
      caseId,
      event: "opened",
      text:
        wanted === "bug_report"
          ? `A customer reported a problem with ${app.name}. turtl opened a bug report and is looking into it. Open turtl to read it.`
          : `A customer asked for a new feature in ${app.name}. turtl opened a feature request. Open turtl to read it.`,
    });
    return { outcome: "opened", caseId };
  },
});

// The reports on one case, oldest first, for the workflow's handlers.
export const caseReports = internalQuery({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) =>
    (await reportsOn(ctx, caseId)).sort((a, b) => a.receivedAt - b.receivedAt).map((r) => ({ _id: r._id, text: r.text, receivedAt: r.receivedAt })),
});

// The case screen: what customers wrote on one case, newest first, and how many people. Contact details are never returned.
export const forCase = query({
  args: { caseId: v.string() },
  handler: async (ctx, args) => {
    const caseId = ctx.db.normalizeId("cases", args.caseId);
    if (!caseId) return null;
    const rows = await reportsOn(ctx, caseId);
    return {
      people: new Set(rows.map((r) => r.fromRef)).size,
      reports: rows
        .sort((a, b) => b.receivedAt - a.receivedAt)
        .map((r) => ({ id: r._id, text: r.text, channel: r.channel, receivedAt: r.receivedAt })),
    };
  },
});

// Every report an app received and how triage handled it, newest first. Contact details are never returned.
export const forApp = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    const rows = await ctx.db.query("reportTriage").withIndex("by_app_and_status", (q) => q.eq("appId", appId)).collect();
    return await Promise.all(
      rows
        .sort((a, b) => b._creationTime - a._creationTime)
        .map(async (t) => {
          const report = await ctx.db.get(t.reportId);
          return {
            reportId: t.reportId,
            text: report?.text ?? "",
            receivedAt: report?.receivedAt ?? t._creationTime,
            fromRef: report?.fromRef ?? "",
            status: t.status,
            verdict: t.verdict ?? null,
            source: t.source ?? null,
            outcome: t.outcome ?? null,
            caseId: t.caseId ?? null,
            reason: t.reason ?? null,
            modelError: t.modelError ?? null,
            agentRunId: t.agentRunId ?? null,
          };
        }),
    );
  },
});
