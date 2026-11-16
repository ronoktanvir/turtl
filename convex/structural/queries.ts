import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { type QueryCtx } from "../_generated/server";
import { query } from "../functions";
import { canSeeApp, canSeeCase } from "../access";
import { signatureFor } from "../monitor";

// What the app shows of structural findings: on the case that produced one, and on its project, where a
// finding stays visible after its case closes.

export type FindingView = {
  id: string;
  projectId: string;
  caseId: string;
  caseTitle: string;
  hypothesis: string;
  evidence: { text: string; label: string; kind: string; cite?: string }[];
  change: { title: string; kind: "repair" | "prevention"; fixKey?: string; note?: string };
  test: { description: string; disprovedIf: string };
  confidence: number;
  connectedCaseCount: number;
  seededCaseCount: number;
  check?: {
    name: string;
    description: string;
    status: "offered" | "running" | "registered" | "not_registered";
    reason?: string;
    lastResult?: { verdict: "passed" | "failed"; at: number; summary: string };
  };
  foundAt: number;
};

async function view(ctx: QueryCtx, finding: Doc<"structuralFindings">): Promise<FindingView | null> {
  const row = await ctx.db.get(finding.caseId);
  if (!row) return null;
  const check = finding.check;
  let lastResult = check?.freshRun;
  const journey = check?.journeyId ? await ctx.db.get(check.journeyId) : null;
  if (check && journey) {
    if (journey.lastPassedAt && (!lastResult || journey.lastPassedAt > lastResult.at)) {
      lastResult = { verdict: "passed", at: journey.lastPassedAt, summary: "The monitor's latest run passed." };
    }
    const failure = await ctx.db
      .query("cases")
      .withIndex("by_app_and_signature", (q) => q.eq("appId", journey.appId).eq("signature", signatureFor(journey._id)))
      .order("desc")
      .first();
    if (failure && (!lastResult || failure._creationTime > lastResult.at)) {
      lastResult = { verdict: "failed", at: failure._creationTime, summary: `The monitor's run failed and opened a case: ${failure.title}.` };
    }
  }
  return {
    id: finding._id,
    projectId: finding.appId,
    caseId: finding.caseId,
    caseTitle: row.title,
    hypothesis: finding.hypothesis,
    evidence: finding.evidence.map((e) => ({
      text: e.says,
      label: e.ref.label,
      kind: e.ref.kind,
      ...(e.ref.kind === "evidence" && { cite: e.ref.id }),
    })),
    change: {
      title: finding.change.title,
      kind: finding.change.kind,
      ...(finding.optionKey && { fixKey: finding.optionKey }),
      ...(finding.fixNote && { note: finding.fixNote }),
    },
    test: { description: finding.test.description, disprovedIf: finding.test.disprovedIf },
    confidence: finding.confidence,
    connectedCaseCount: finding.connectedCaseIds.length,
    seededCaseCount: finding.seededCaseCount,
    ...(check && {
      check: {
        name: check.name,
        description: check.description,
        status: check.status,
        ...(check.reason && { reason: check.reason }),
        // Runs recorded before the code was left out still carry it, as "(RECOMMENDATIONS_TIMEOUT)".
        ...(lastResult && { lastResult: { verdict: lastResult.verdict, at: lastResult.at, summary: lastResult.summary.replace(/\s*\((?:[A-Z][A-Z0-9]*_)+[A-Z0-9]+\)/g, "") } }),
      },
    }),
    foundAt: finding.foundAt,
  };
}

// The finding this case produced, or null.
export const forCase = query({
  args: { caseId: v.string() },
  handler: async (ctx, args): Promise<FindingView | null> => {
    if (!(await canSeeCase(ctx, args.caseId))) return null;
    const caseId = ctx.db.normalizeId("cases", args.caseId);
    if (!caseId) return null;
    const finding = await ctx.db
      .query("structuralFindings")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .order("desc")
      .first();
    return finding ? await view(ctx, finding) : null;
  },
});

// A project's findings, newest first, whatever the state of the cases they came from.
export const forProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args): Promise<FindingView[]> => {
    if (!(await canSeeApp(ctx, args.projectId))) return [];
    const appId = ctx.db.normalizeId("apps", args.projectId);
    if (!appId) return [];
    const findings = await ctx.db
      .query("structuralFindings")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .order("desc")
      .take(20);
    return (await Promise.all(findings.map((f) => view(ctx, f)))).filter((f): f is FindingView => f !== null);
  },
});
