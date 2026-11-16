import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { query } from "../functions";
import { canSeeApp, canSeeCase } from "../access";
import { CLOSED_CASE_STATUSES, NO_SUPERMEMORY } from "../constants";
import { startCaseRun } from "../runner/run";
import { HARNESS_VERSION, RATE_LIMITS, TRIAGE_PROMPT_VERSION, fingerprint, windowStart, type Candidate } from "./rules";
import { vReportHint, vTriageVerdict } from "./schema";
// Deleting a report, and keeping a customer's contact only as a reference.
import { ConvexError } from "convex/values";
import { internalAction } from "../_generated/server";
import { mutation } from "../functions";
import { accessEnforced, demoHoldsAccounts, requireCase, UNAVAILABLE } from "../access";
import { requireOwnerPasscode } from "../ownerPasscode";
import { gateFor } from "../consent/gate";
import { deleteDocuments } from "../supermemory";
import { openIntakeCase } from "../spend/ledger";
import { intakeCasesPerDay, spendRefusal } from "../spend/limits";
import { CONTACT_REF, contactRef } from "./rules";
import { reportsNamespace } from "./triage";

declare const process: { env: Record<string, string | undefined> };

export const PROVIDER = "turtl-form";
const LOCK_MS = 120_000;
const MAX_TRIAGE_ATTEMPTS = 3;
const MAX_CANDIDATES = 20;
const SAMPLE_TEXTS = 3;

const isOpen = (row: Doc<"cases">) => !(CLOSED_CASE_STATUSES as readonly string[]).includes(row.status);
const isCustomerCase = (row: Doc<"cases">) =>
  row.raisedBy === "customer" && (row.kind === "bug_report" || row.kind === "feature_request");

// Every read here is bounded per case or per project (second review: one owner's customers could otherwise grow a
// project's reports until its triage failed). A case's counts are kept on the case as reports join and leave it.
/** Reports read from one case at most: the newest (and, for the workflow, the first). */
const CASE_REPORTS_READ = 200;
/** Triage rows read from one case at most, newest first: where a report that just landed is. */
const CASE_TRIAGE_READ = 200;
/** The newest cases on a project that triage looks through for open customer cases a report may join. */
const CASES_SCANNED = 200;
/** Reports the reports screen lists, newest first. */
const APP_REPORTS_LISTED = 200;
/** Reports a full recount reads at most (only the one-off forgetStoredContacts); past it the kept counts stand. */
const RECOUNT_LIMIT = 1_000;

/** The newest reports on a case, newest first. */
async function reportsOn(ctx: QueryCtx, caseId: Id<"cases">, limit = CASE_REPORTS_READ) {
  return await ctx.db
    .query("reports")
    .withIndex("by_case_and_received", (q) => q.eq("caseId", caseId))
    .order("desc")
    .take(limit);
}

// reportCount counts messages; distinctRequesterCount counts the people (fromRef) behind them. Kept as each report
// joins (+1, before it is attached) or leaves (-1, after it is deleted): the person counts once while any report of
// theirs is on the case.
async function countReport(ctx: MutationCtx, caseId: Id<"cases">, fromRef: string, change: 1 | -1) {
  const row = await ctx.db.get(caseId);
  if (!row) return null;
  const theirs = await ctx.db.query("reports").withIndex("by_case_and_requester", (q) => q.eq("caseId", caseId).eq("fromRef", fromRef)).first();
  const counts = {
    reportCount: Math.max(0, (row.reportCount ?? 0) + change),
    distinctRequesterCount: Math.max(0, (row.distinctRequesterCount ?? 0) + (theirs ? 0 : change)),
  };
  await ctx.db.patch(caseId, counts);
  return counts;
}

// Counts a case's reports again from scratch, after the owner deletes one and in the one-off that re-keys people (forgetStoredContacts). A case with
// more reports than RECOUNT_LIMIT keeps the counts kept as its reports came.
async function recount(ctx: MutationCtx, caseId: Id<"cases">) {
  const rows = await ctx.db.query("reports").withIndex("by_case_and_requester", (q) => q.eq("caseId", caseId)).take(RECOUNT_LIMIT + 1);
  if (rows.length > RECOUNT_LIMIT) return;
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
    // The single-owner demo on a deployment that holds accounts keeps no report (convex/access.ts).
    if (await demoHoldsAccounts(ctx)) return { ok: false, status: 503, code: "UNAVAILABLE", message: UNAVAILABLE };
    const key = await ctx.db.query("intakeKeys").withIndex("by_key", (q) => q.eq("key", args.key)).unique();
    if (!key || key.revokedAt !== undefined || !(await ctx.db.get(key.appId))) {
      return { ok: false, status: 403, code: "UNKNOWN_KEY", message: "This report key is not recognised." };
    }
    const appId = key.appId;
    // The contact becomes this reference and is then dropped: it is not stored anywhere (rules.ts, contactRef).
    const fromRef = args.contact
      ? await contactRef(args.contact, process.env.INTAKE_CONTACT_KEY)
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
      const stale = await ctx.db.query("intakeRateWindows").withIndex("by_bucket_and_window", (q) => q.eq("bucket", b.bucket).lt("windowStart", b.start)).take(10);
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
    const open = (await ctx.db.query("cases").withIndex("by_app", (q) => q.eq("appId", app._id)).order("desc").take(CASES_SCANNED))
      .filter((row) => isOpen(row) && isCustomerCase(row))
      .slice(0, MAX_CANDIDATES);
    const candidates: (Candidate & { title: string })[] = [];
    for (const [i, row] of open.entries()) {
      const attached = await ctx.db.query("reportTriage").withIndex("by_case", (q) => q.eq("caseId", row._id)).order("desc").take(CASE_TRIAGE_READ);
      const texts = (await reportsOn(ctx, row._id, SAMPLE_TEXTS)).map((r) => r.text.slice(0, 300));
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
  const pending = (await ctx.db.query("reportTriage").withIndex("by_case", (q) => q.eq("caseId", caseId)).order("desc").take(CASE_TRIAGE_READ)).filter(
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
      await countReport(ctx, target._id, report.fromRef, 1);
      await ctx.db.patch(report._id, { caseId: target._id });
      await ctx.db.patch(triage._id, { ...fields, outcome: "attached", caseId: target._id });
      await recordRuns(ctx, target._id);
      return { outcome: "attached", caseId: target._id };
    }
    if (args.verdict === "noise" || !args.open) {
      await ctx.db.patch(triage._id, { ...fields, outcome: "ignored" });
      if (args.modelId) await insertTriageRun(ctx, (await ctx.db.get(triage._id))!, { appId: report.appId });
      return { outcome: "ignored", caseId: null };
    }
    const app = (await ctx.db.get(report.appId))!;
    // With accounts on, customer reports open at most so many cases on a project a day (finding 5): each new case is
    // investigated and planned, so an unbounded stream of distinct reports would be an unbounded bill.
    if (accessEnforced() && !(await openIntakeCase(ctx, app._id))) {
      await ctx.db.patch(triage._id, { ...fields, outcome: "ignored", reason: `${args.reason} ${spendRefusal.intakeCases(intakeCasesPerDay())}` });
      if (args.modelId) await insertTriageRun(ctx, (await ctx.db.get(triage._id))!, { appId: report.appId });
      return { outcome: "ignored", caseId: null };
    }
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

// The reports on one case, oldest first, for the workflow's handlers: the first one and the newest after it.
export const caseReports = internalQuery({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    const first = await ctx.db.query("reports").withIndex("by_case_and_received", (q) => q.eq("caseId", caseId)).first();
    const newest = await reportsOn(ctx, caseId, CASE_REPORTS_READ - 1);
    const rows = first && !newest.some((r) => r._id === first._id) ? [first, ...newest] : newest;
    return rows.sort((a, b) => a.receivedAt - b.receivedAt).map((r) => ({ _id: r._id, text: r.text, receivedAt: r.receivedAt }));
  },
});

// The case screen: what customers wrote on one case, newest first, and how many people. Contact details are never returned.
export const forCase = query({
  args: { caseId: v.string() },
  handler: async (ctx, args) => {
    // What customers wrote is shown only to the owner of the app they sent it to.
    if (!(await canSeeCase(ctx, args.caseId))) return null;
    const caseId = ctx.db.normalizeId("cases", args.caseId);
    const row = caseId ? await ctx.db.get(caseId) : null;
    if (!caseId || !row) return null;
    const rows = await reportsOn(ctx, caseId);
    return {
      people: row.distinctRequesterCount ?? new Set(rows.map((r) => r.fromRef)).size,
      reports: rows.map((r) => ({ id: r._id, text: r.text, channel: r.channel, receivedAt: r.receivedAt })),
    };
  },
});

// The reports an app received and how triage handled them, newest first (the newest APP_REPORTS_LISTED). Contact
// details are never returned.
export const forApp = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    if (!(await canSeeApp(ctx, appId))) return [];
    const pending = await ctx.db.query("reportTriage").withIndex("by_app_and_status", (q) => q.eq("appId", appId).eq("status", "pending")).order("desc").take(APP_REPORTS_LISTED);
    const done = await ctx.db.query("reportTriage").withIndex("by_app_and_status", (q) => q.eq("appId", appId).eq("status", "done")).order("desc").take(APP_REPORTS_LISTED);
    const rows = [...pending, ...done].sort((a, b) => b._creationTime - a._creationTime).slice(0, APP_REPORTS_LISTED);
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

// Deleting reports: one at the owner's request, or all of an app's when its account goes.

export const REPORT_NOT_AVAILABLE = "That report is not available. It may already have been deleted.";
const DELETED_EVIDENCE = {
  title: "A customer's report, deleted by the owner",
  body: "The owner deleted this report, so turtl no longer keeps the customer's words.",
};
const EVIDENCE_SCAN = 2_000;
const BATCH = 100;
const FORGET_TRIES = 3;

// Removes reports: their rows, their triage rows, and their words in their cases' evidence. An evidence row stays,
// so the case's history still adds up, but it says the report was deleted. Returns the cases they were on. The
// caller recounts those cases and asks Supermemory to forget the copies (forgetCopies).
// Other places quote a report: a rule-based case title, the rule-based reading ("the first in their words: …"), and
// step outputs. Those quotes are replaced too, unless another report still on the case says the same words.
// Deleting a whole app's reports (deleteAppReports) passes scrubQuotes: false: its cases are deleted with the account,
// and reading every case's history in one batch would exceed a mutation's read limit.
export async function removeReports(ctx: MutationCtx, reports: Doc<"reports">[], { scrubQuotes = true } = {}): Promise<Id<"cases">[]> {
  const byCase = new Map<Id<"cases">, Doc<"reports">[]>();
  for (const report of reports) {
    for (const triage of await ctx.db.query("reportTriage").withIndex("by_report", (q) => q.eq("reportId", report._id)).take(10)) {
      await ctx.db.delete(triage._id);
    }
    await ctx.db.delete(report._id);
    if (report.caseId) {
      byCase.set(report.caseId, [...(byCase.get(report.caseId) ?? []), report]);
      // The case no longer counts it (nor its person, once none of theirs is left on it).
      await countReport(ctx, report.caseId, report.fromRef, -1);
    }
  }
  for (const [caseId, removed] of byCase) {
    const sourceRefs = new Set(removed.map((r) => `reports/${r._id}`));
    const remaining = (await reportsOn(ctx, caseId)).map((r) => r.text.replace(/\s+/g, " "));
    const needles = scrubQuotes ? [...new Set(removed.flatMap((r) => quotesOf(r.text)))].filter((n) => !remaining.some((text) => text.includes(n))) : [];
    for (const row of await ctx.db.query("evidence").withIndex("by_case", (q) => q.eq("caseId", caseId)).take(EVIDENCE_SCAN)) {
      if (row.kind === "customer_report" && row.sourceRef && sourceRefs.has(row.sourceRef)) await ctx.db.patch(row._id, DELETED_EVIDENCE);
      else if (needles.length) {
        const title = scrub(row.title, needles);
        const body = row.body === undefined ? undefined : scrub(row.body, needles);
        if (title !== row.title || body !== row.body) await ctx.db.patch(row._id, { title, ...(body !== undefined && { body }) });
      }
    }
    if (!needles.length) continue;
    const row = await ctx.db.get(caseId);
    if (row) {
      const title = scrub(row.title, needles);
      const impact = scrub(row.impact, needles);
      if (title !== row.title || impact !== row.impact) await ctx.db.patch(caseId, { title, impact });
    }
    for (const attempt of await ctx.db.query("stepAttempts").withIndex("by_case", (q) => q.eq("caseId", caseId)).take(EVIDENCE_SCAN)) {
      // Its summary, handoff, output and error can each quote the reading of the reports.
      const { _id, _creationTime, ...fields } = attempt;
      const changed = Object.fromEntries(Object.entries(fields).filter(([key, value]) => JSON.stringify(scrub(value, needles)) !== JSON.stringify(value)).map(([key, value]) => [key, scrub(value, needles)]));
      if (Object.keys(changed).length) await ctx.db.patch(_id, changed);
    }
  }
  return [...byCase.keys()];
}

const DELETED_QUOTE = "[a deleted report]";
const MIN_QUOTE = 12;

// The forms a report's words are quoted in: whole, the first 140 characters (customer_report evidence titles), and
// the first sentence cut at 70 (ruleTitle). Very short texts are not searched for, so ordinary words are not erased.
function quotesOf(text: string): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  const first = flat.split(/(?<=[.!?])\s/)[0].trim();
  const cut = first.length > 70 ? first.slice(0, 70).replace(/\s+\S*$/, "") : first;
  return [flat, flat.slice(0, 140), cut].filter((q) => q.length >= MIN_QUOTE);
}

function scrub<T>(value: T, needles: string[]): T {
  if (typeof value === "string") return needles.reduce((s: string, n) => s.split(n).join(DELETED_QUOTE), value) as T;
  if (Array.isArray(value)) return value.map((item) => scrub(item, needles)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, item]) => [k, scrub(item, needles)])) as T;
  return value;
}

// The owner deletes one report on one of their cases. The case's counts go down by it, and the copy turtl keeps in
// Supermemory for matching reports is deleted too. In the single-owner demo the owner passcode guards it.
export const deleteReport = mutation({
  args: { caseId: v.string(), reportId: v.string(), passcode: v.optional(v.string()) },
  returns: v.object({ reportCount: v.number(), people: v.number() }),
  handler: async (ctx, args) => {
    const caseId = ctx.db.normalizeId("cases", args.caseId);
    if (!caseId) throw new ConvexError(REPORT_NOT_AVAILABLE);
    await requireCase(ctx, caseId);
    if (!accessEnforced()) await requireOwnerPasscode(ctx, args.passcode);
    const reportId = ctx.db.normalizeId("reports", args.reportId);
    const report = reportId ? await ctx.db.get(reportId) : null;
    if (!report || report.caseId !== caseId) throw new ConvexError(REPORT_NOT_AVAILABLE);
    await removeReports(ctx, [report]);
    await ctx.scheduler.runAfter(0, internal.intake.records.forgetCopies, { appId: report.appId, reportIds: [report._id], tries: 0 });
    // A rare owner action: count again from scratch while the case is small enough, so the counts are exact.
    await recount(ctx, caseId);
    const row = await ctx.db.get(caseId);
    return { reportCount: row?.reportCount ?? 0, people: row?.distinctRequesterCount ?? 0 };
  },
});

// Every report an app received, a batch at a time, for deleting an account or a project: rows, triage rows, the
// words in evidence, and the Supermemory copies. Cases that remain count them no more. Schedules itself until none
// is left.
export const deleteAppReports = internalMutation({
  args: { appId: v.id("apps") },
  returns: v.object({ deleted: v.number(), more: v.boolean() }),
  handler: async (ctx, { appId }) => {
    const rows = await ctx.db.query("reports").withIndex("by_app_and_provider_event", (q) => q.eq("appId", appId)).take(BATCH + 1);
    const batch = rows.slice(0, BATCH);
    await removeReports(ctx, batch, { scrubQuotes: false });
    if (batch.length) await ctx.scheduler.runAfter(0, internal.intake.records.forgetCopies, { appId, reportIds: batch.map((r) => r._id), tries: 0 });
    const more = rows.length > BATCH;
    if (more) await ctx.scheduler.runAfter(0, internal.intake.records.deleteAppReports, { appId });
    return { deleted: batch.length, more };
  },
});

// Deletes the copies of these reports that triage added to the app's Supermemory namespace, by the report id they
// were added under. Without SUPERMEMORY_API_KEY turtl made no copy and sends nothing. A failure is retried twice.
export const forgetCopies = internalAction({
  args: { appId: v.id("apps"), reportIds: v.array(v.string()), tries: v.number() },
  returns: v.object({ removed: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, { appId, reportIds, tries }) => {
    if (!process.env.SUPERMEMORY_API_KEY) return { removed: false, reason: `${NO_SUPERMEMORY}, so turtl keeps no copy there.` };
    try {
      await deleteDocuments(gateFor(ctx, { appId }), reportsNamespace(appId), reportIds);
      return { removed: true };
    } catch (error) {
      const reason = `Supermemory did not confirm the deletion (${error instanceof Error ? error.name : "unknown error"}).`;
      if (tries + 1 < FORGET_TRIES) {
        await ctx.scheduler.runAfter(60_000 * (tries + 1), internal.intake.records.forgetCopies, { appId, reportIds, tries: tries + 1 });
      } else {
        console.error(`${reason} Gave up after ${FORGET_TRIES} tries for ${reportIds.length} report(s) of app ${appId}.`);
      }
      return { removed: false, reason };
    }
  },
});

// One-off: reports received before contacts stopped being stored kept the contact as written on reportTriage.
// This clears it from every such row, a batch at a time. With INTAKE_CONTACT_KEY set, it first moves the report's
// person reference to the keyed hash, so people keep being counted once. Set the key before running it:
//   npx convex run intake/records:forgetStoredContacts '{}'
export const forgetStoredContacts = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ cleared: v.number(), rekeyed: v.number(), done: v.boolean() }),
  handler: async (ctx, { cursor }) => {
    const key = process.env.INTAKE_CONTACT_KEY;
    const page = await ctx.db.query("reportTriage").paginate({ cursor: cursor ?? null, numItems: BATCH });
    let cleared = 0;
    let rekeyed = 0;
    const cases = new Set<Id<"cases">>();
    for (const triage of page.page) {
      if (triage.contact === undefined) continue;
      const report = await ctx.db.get(triage.reportId);
      if (key && report?.fromRef.startsWith(CONTACT_REF)) {
        await ctx.db.patch(report._id, { fromRef: await contactRef(triage.contact, key) });
        rekeyed++;
        if (report.caseId) cases.add(report.caseId);
      }
      await ctx.db.patch(triage._id, { contact: undefined });
      cleared++;
    }
    for (const caseId of cases) if (await ctx.db.get(caseId)) await recount(ctx, caseId);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.intake.records.forgetStoredContacts, { cursor: page.continueCursor });
    return { cleared, rekeyed, done: page.isDone };
  },
});
