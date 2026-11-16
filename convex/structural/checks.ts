import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery, mutation } from "../_generated/server";
import { guardRow } from "../access";
import { requireOwnerPasscode } from "../ownerPasscode";
import { call, CHECK_VERSION, describeFailure } from "../protectedApp/client";
import { vCheckRun } from "./schema";

// A finding's prevention check: offered with the finding, approved once by the owner (passcode checked),
// run once fresh, and registered as a journey only when that run returned a result. From then on the cron
// monitor runs it like any journey, and a failure opens a case.

export const approve = mutation({
  args: { findingId: v.string(), passcode: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await guardRow(ctx, "structuralFindings", args.findingId, "This finding no longer exists.");
    await requireOwnerPasscode(ctx, args.passcode);
    const findingId = ctx.db.normalizeId("structuralFindings", args.findingId);
    const finding = findingId ? await ctx.db.get(findingId) : null;
    if (!findingId || !finding) throw new ConvexError("This finding no longer exists.");
    const check = finding.check;
    if (!check) throw new ConvexError("This finding offers no check the monitor can run.");
    if (check.status !== "offered") throw new ConvexError(`This check was already approved (${check.status.replace("_", " ")}).`);
    await ctx.db.patch(findingId, { check: { ...check, status: "running", approvedAt: Date.now() } });
    await ctx.scheduler.runAfter(0, internal.structural.checks.runOnce, { findingId });
    return null;
  },
});

// The owner reads this on the case: where the run stopped, in words, never the app's error code.
export function failedRunWords(failedStep: string | undefined): string {
  return failedStep ? `Its first run failed at the "${failedStep}" step.` : "Its first run failed.";
}

export const load = internalQuery({
  args: { findingId: v.id("structuralFindings") },
  handler: async (ctx, { findingId }) => await ctx.db.get(findingId),
});

// The one fresh run before registering. The app must answer with a verdict for this very scenario; an app
// that ignores the scenario and runs its plain journey check does not count.
export const runOnce = internalAction({
  args: { findingId: v.id("structuralFindings") },
  handler: async (ctx, { findingId }) => {
    const finding = await ctx.runQuery(internal.structural.checks.load, { findingId });
    const check = finding?.check;
    if (!check || check.status !== "running") return;
    const at = Date.now();
    const response = await call(check.url, { method: "POST", credentialRef: check.credentialRef, timeoutMs: 30_000 });
    const body = (response.kind === "response" ? response.body : null) as {
      verdict?: unknown;
      scenario?: unknown;
      failedStep?: unknown;
      error?: { code?: unknown } | null;
    } | null;
    let reason: string | null = null;
    if (response.kind !== "response") reason = `the check got no answer (${describeFailure(response)})`;
    else if ((response.status !== 200 && response.status !== 503) || (body?.verdict !== "passed" && body?.verdict !== "failed")) {
      reason = `the check returned HTTP ${response.status} with no verdict`;
    } else if (body?.scenario !== check.scenario) {
      reason = "the app answered without running this scenario, so it cannot run this check yet";
    }
    if (reason || !body) {
      await ctx.runMutation(internal.structural.checks.settle, { findingId, outcome: { ok: false, reason: reason ?? "no result" } });
      return;
    }
    const verdict = body.verdict as "passed" | "failed";
    const failedStep = typeof body.failedStep === "string" ? body.failedStep : undefined;
    await ctx.runMutation(internal.structural.checks.settle, {
      findingId,
      outcome: {
        ok: true,
        run: {
          verdict,
          ...(failedStep && { failedStep }),
          summary:
            verdict === "passed"
              ? "Its first run passed: a test booking was saved while the scenario was applied."
              : `${failedRunWords(failedStep)} The monitor will open a case for it.`,
          at,
        },
      },
    });
  },
});

export const settle = internalMutation({
  args: {
    findingId: v.id("structuralFindings"),
    outcome: v.union(v.object({ ok: v.literal(true), run: vCheckRun }), v.object({ ok: v.literal(false), reason: v.string() })),
  },
  handler: async (ctx, { findingId, outcome }) => {
    const finding = await ctx.db.get(findingId);
    const check = finding?.check;
    if (!finding || !check || check.status !== "running") return;
    if (!outcome.ok) {
      await ctx.db.patch(findingId, {
        check: { ...check, status: "not_registered", reason: `Not registered: ${outcome.reason}.` },
      });
      return;
    }
    const journeyId = await ctx.db.insert("journeys", {
      appId: finding.appId,
      name: check.name,
      description: check.description,
      check: {
        kind: "http",
        config: { url: check.url, method: "POST", expectedStatus: 200, ...(check.credentialRef && { credentialRef: check.credentialRef }) },
      },
      checkVersion: `${CHECK_VERSION}+${check.scenario}`,
      preventionFindingId: findingId,
      ...(outcome.run.verdict === "passed" && { lastPassedAt: outcome.run.at }),
    });
    await ctx.db.patch(findingId, { check: { ...check, status: "registered", journeyId, freshRun: outcome.run } });
  },
});
