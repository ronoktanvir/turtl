import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { askJson, fixesModelId } from "../fixOptions";
import { addDocuments, searchChunks } from "../supermemory";
import { TRIAGE_PROMPT, decide, exactCopy, instructionOnly, readTriage, ruleMatch, ruleTitle, ruleTriage, type Verdict } from "./rules";

declare const process: { env: Record<string, string | undefined> };

const SEARCH_TIMEOUT_MS = 8_000;

// Where an app's customer reports live in Supermemory. INTAKE_NAMESPACE_PREFIX keeps a test deployment's
// reports apart from production's; it is empty in production.
export const reportsNamespace = (appId: string) =>
  `${process.env.INTAKE_NAMESPACE_PREFIX ?? ""}reports_${appId}`.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 100);

const withTimeout = <T,>(work: Promise<T>, ms: number) =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);

// Supermemory may suggest open cases whose reports read like this one. Only a suggestion: triage checks it
// against the candidates read from Convex, and a model or the rules still decide.
async function suggest(appId: string, text: string, caseIds: string[]): Promise<string[]> {
  if (!process.env.SUPERMEMORY_API_KEY || !caseIds.length) return [];
  try {
    const results = await withTimeout(searchChunks(reportsNamespace(appId), text, { limit: 5 }), SEARCH_TIMEOUT_MS);
    const found = results.map((r) => r.metadata.caseId).filter((id): id is string => typeof id === "string" && caseIds.includes(id));
    return [...new Set(found)];
  } catch {
    return [];
  }
}

async function triageOne(ctx: ActionCtx, triageId: Id<"reportTriage">) {
  const input = await ctx.runQuery(internal.intake.records.triageInput, { triageId });
  if (!input) return;
  const { triage, report, appName, candidates } = input;

  const copy = exactCopy(triage.fingerprint, candidates);
  if (copy) {
    await ctx.runMutation(internal.intake.records.land, {
      triageId,
      verdict: copy.kind === "bug_report" ? "bug" : "request",
      source: "exact_copy",
      reason: "An exact copy of a report already on this open case.",
      attachTo: copy.caseId as Id<"cases">,
    });
    return;
  }

  const suggested = await suggest(report.appId, report.text, candidates.map((c) => c.caseId));
  const started = Date.now();
  const answer = await askJson(TRIAGE_PROMPT, {
    app: appName,
    customerChose: triage.hint ?? null,
    message: report.text,
    openCases: candidates.map((c) => ({
      ref: c.ref,
      kind: c.kind,
      title: c.title,
      suggestedBySearch: suggested.includes(c.caseId),
      sampleReports: c.texts,
    })),
  });
  const durationMs = Date.now() - started;
  const read = answer.ok ? readTriage(answer.json, candidates.map((c) => c.ref)) : null;
  const modelError = answer.ok ? (read ? undefined : "the model's answer was not a usable triage") : answer.reason;

  let verdict: Verdict;
  let sameAs: string | null;
  let reason: string;
  let title: string | null = null;
  let summary: string | null = null;
  if (read) {
    ({ verdict, sameAs, title, summary } = read);
    reason = `${fixesModelId()} judged it ${verdict}${sameAs ? ` and the same as open case ${sameAs}` : ""}.`;
  } else {
    const rule = ruleTriage(report.text, triage.hint);
    verdict = rule.verdict;
    sameAs = verdict === "noise" ? null : ruleMatch(report.text, verdict, candidates);
    reason = `Rule-based triage, not a model's: no model answered (${modelError}). Judged ${verdict} because ${rule.reason}${sameAs ? `, and its words overlap open case ${sameAs}` : ""}.`;
  }
  if (verdict !== "noise" && instructionOnly(report.text)) {
    verdict = "noise";
    sameAs = null;
    reason = `${reason} Overruled by the instruction guard: the text gives instructions and describes no symptom, so it is noise.`;
  }
  const decision = decide({ verdict, sameAs }, candidates);
  const landed = await ctx.runMutation(internal.intake.records.land, {
    triageId,
    verdict,
    source: read ? "model" : "rules",
    reason,
    modelId: fixesModelId(),
    durationMs,
    ...(modelError && { modelError }),
    ...(suggested.length && { suggestedCaseIds: suggested as Id<"cases">[] }),
    ...(decision.outcome === "attached" && { attachTo: decision.caseId as Id<"cases"> }),
    ...(decision.outcome === "opened" && {
      open: {
        title: title ?? ruleTitle(report.text, verdict as "bug" | "request"),
        impact:
          summary ??
          (verdict === "bug"
            ? "A customer reported a problem through the report form. No model summarised it."
            : "A customer asked for a new feature through the report form. No model summarised it."),
      },
    }),
  });
  if (landed.caseId && process.env.SUPERMEMORY_API_KEY) {
    await withTimeout(
      addDocuments(reportsNamespace(report.appId), [
        { id: report._id, content: report.text, metadata: { caseId: landed.caseId, reportId: report._id, kind: verdict } },
      ]),
      SEARCH_TIMEOUT_MS,
    ).catch(() => undefined);
  }
}

// Triage runs one report at a time per app, so each report can match the case the one before it opened.
export const processNext = internalAction({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    const triageId = await ctx.runMutation(internal.intake.records.claim, { appId });
    if (!triageId) return;
    try {
      await triageOne(ctx, triageId);
    } finally {
      await ctx.runMutation(internal.intake.records.release, { appId });
    }
  },
});
