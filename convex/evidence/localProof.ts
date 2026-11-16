import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery } from "../_generated/server";
import { CREDENTIAL_REF, CHECK_VERSION } from "../protectedApp/client";
import { startCaseRun } from "../runner/run";
import { createCaseFromTemplate, EVIDENCE_TEMPLATE_STEPS, loadSteps, TEMPLATE_STEPS } from "../workflow";

declare const process: { env: Record<string, string | undefined> };

function requireLocalProof() {
  const host = new URL(process.env.CONVEX_CLOUD_URL ?? "https://invalid.example").hostname;
  if (process.env.DEV_TOOLS_ENABLED !== "true" || process.env.EVIDENCE_LOCAL_PROOF !== "true" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    throw new Error("Evidence proofs require an explicitly enabled localhost backend.");
  }
  const external = Object.entries(process.env).filter(([name, value]) => value && (
    name.endsWith("_API_KEY") || name === "GITHUB_TOKEN" || name === "PROTECTED_APP_URL" ||
    name.startsWith("KEIKI_") || name.startsWith("REVYL_")
  )).map(([name]) => name);
  if (external.length) throw new Error(`Local evidence proofs refuse external provider configuration: ${external.join(", ")}.`);
}

export const seed = internalMutation({
  args: {
    base: v.string(),
    label: v.string(),
    mode: v.union(v.literal("parallel"), v.literal("legacy"), v.literal("sample"), v.literal("no_journey")),
    paused: v.optional(v.boolean()),
  },
  handler: async (ctx, { base, label, mode, paused }) => {
    requireLocalProof();
    const url = new URL(base);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash) {
      throw new Error("Evidence proof HTTP sources must be local, credential-free URLs.");
    }
    const appId = await ctx.db.insert("apps", {
      name: `Local evidence proof: ${label}`,
      productionUrl: base,
      ownerId: "solo-owner",
    });
    const journeyId = mode === "no_journey" ? undefined : await ctx.db.insert("journeys", {
      appId,
      name: "Local mock booking journey",
      description: "Deterministic localhost HTTP evidence; not hosted or device proof.",
      checkVersion: CHECK_VERSION,
      check: { kind: "http", config: {
        url: `${base}/journey-check`, method: "POST", expectedStatus: 200, credentialRef: CREDENTIAL_REF,
      } },
    });
    if (journeyId) await ctx.db.insert("actionCatalog", {
      appId,
      type: "set_feature_flag",
      name: "Turn off local mock recommendations",
      description: "Changes only the isolated local proof HTTP server.",
      reversible: true,
      config: { kind: "http", url: `${base}/flags`, method: "POST", credentialRef: CREDENTIAL_REF },
      parameterConstraints: [
        { name: "flag", type: "string", required: true, allowedValues: ["recommendationsEnabled"] },
        { name: "value", type: "boolean", required: true, allowedValues: [false] },
      ],
    });
    const fields = {
      appId,
      ...(journeyId && { journeyId }),
      title: `Local evidence proof: ${label}`,
      impact: "Only localhost fixture traffic; no real customers or alerts.",
      kind: "outage" as const,
      raisedBy: "owner" as const,
      signature: `local_evidence:${label}`,
      ...(mode === "sample" && { isSample: true }),
    };
    const caseId = mode === "legacy" || paused
      ? await createCaseFromTemplate(ctx, fields, mode === "parallel" ? EVIDENCE_TEMPLATE_STEPS : TEMPLATE_STEPS)
      : await startCaseRun(ctx, fields);
    if (mode === "legacy" && !paused) await ctx.scheduler.runAfter(0, internal.runner.run.advance, { caseId });
    return { caseId, appId, journeyId: journeyId ?? null };
  },
});

export const snapshot = internalQuery({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    requireLocalProof();
    const row = await ctx.db.get(caseId);
    return {
      case: row,
      steps: await loadSteps(ctx, caseId),
      attempts: await ctx.db.query("stepAttempts").withIndex("by_case", (q) => q.eq("caseId", caseId)).collect(),
      evidence: await ctx.db.query("evidence").withIndex("by_case", (q) => q.eq("caseId", caseId)).collect(),
      actions: await ctx.db.query("actions").withIndex("by_case", (q) => q.eq("caseId", caseId)).collect(),
      proposals: await ctx.db.query("proposals").withIndex("by_case", (q) => q.eq("caseId", caseId)).collect(),
      verifications: await ctx.db.query("verifications").withIndex("by_case", (q) => q.eq("caseId", caseId)).collect(),
      memories: await ctx.db.query("recoveryMemories").withIndex("by_source_case", (q) => q.eq("sourceCaseId", caseId)).collect(),
      notices: await ctx.db.query("ownerNotices").withIndex("by_case_and_event", (q) => q.eq("caseId", caseId)).collect(),
    };
  },
});
