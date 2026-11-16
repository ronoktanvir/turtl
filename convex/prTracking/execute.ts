import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { gateFor } from "../consent/gate";
import type { HandlerInput, HandlerResult } from "../runner/contract";
import { capyConfig, instructionsToSend, startCapyThread } from "./capy";
import { repoFromUrl } from "./github";

const textParameter = (action: Doc<"actions">, name: string) => {
  const value = action.executionPayload.parameters.find((p) => p.name === name)?.value;
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

// Runs an approved "capy" action: Capy writes the change and opens a pull request, and the execute
// step waits (case waiting_for_deploy) until that pull request merges or closes.
export async function runCodeChange(ctx: ActionCtx, input: HandlerInput, action: Doc<"actions">): Promise<HandlerResult> {
  const { config } = action.executionPayload;
  if (config.kind !== "capy") return { status: "failed", error: `Not a code change: ${config.kind}.` };
  const fail = async (error: string): Promise<HandlerResult> => {
    await ctx.runMutation(internal.protectedApp.records.finishAction, { actionId: action._id, status: "failed", result: error });
    return { status: "failed", error };
  };

  const existing: Doc<"pullRequests"> | null = await ctx.runQuery(internal.prTracking.records.forAction, {
    actionId: action._id,
  });
  if (existing?.settledAt !== undefined) {
    return existing.mergedAt !== undefined
      ? { status: "done", summary: `Pull request #${existing.number} was merged.` }
      : { status: "failed", error: existing.openError ?? `Pull request #${existing.number} was closed without merging.` };
  }
  if (existing) {
    await ctx.runMutation(internal.prTracking.records.waitOn, { id: existing._id, attemptId: input.attempt._id });
    return {
      status: "waiting",
      summary: existing.snapshot
        ? existing.snapshot.state === "merged"
          ? `Pull request #${existing.number} was merged; waiting for the booking app to deploy its merged revision.`
          : `Waiting for the owner to merge pull request #${existing.number}.`
        : "Capy is still writing the change.",
      ...(existing.capyThreadId && { externalRef: `capy:${existing.capyThreadId}` }),
      caseStatus: "waiting_for_deploy",
    };
  }

  const repo = repoFromUrl(config.repoUrl);
  const title = textParameter(action, "title");
  // Exactly the text the owner read on the Approve sheet: the frozen copy of the option's stored instructions.
  const message = instructionsToSend(action.executionPayload.parameters, action.executionPayload.target);
  if (!repo) return fail(`"${config.repoUrl}" is not a GitHub repository; nothing was sent to Capy.`);
  if (!title || !message) return fail("The approved fix has no title or change to make; nothing was sent to Capy.");
  const capy = capyConfig();
  if (!capy.ok) {
    return fail(`Not configured: set ${capy.missing.join(" and ")} on the Convex deployment so Capy can write this change. Nothing was sent.`);
  }

  const started = await startCapyThread(gateFor(ctx, { appId: input.case.appId }), capy, {
    repo,
    requestId: `turtl:${action.idempotencyKey}`,
    title: `turtl: ${title}`.slice(0, 120),
    message,
  });
  if (!started.ok) return fail(`Could not ask Capy to write the change: ${started.message}`);
  const { threadId } = started.body;

  const id = await ctx.runMutation(internal.prTracking.records.insertForAction, {
    actionId: action._id,
    repo,
    baseBranch: config.baseBranch,
    capyThreadId: threadId,
  });
  await ctx.runMutation(internal.prTracking.records.waitOn, { id, attemptId: input.attempt._id });
  const summary = `Asked Capy to write "${title}" and open a pull request against ${config.baseBranch}.`;
  await ctx.runMutation(internal.protectedApp.records.finishAction, {
    actionId: action._id,
    status: "running",
    result: summary,
    externalRef: `capy:${threadId}`,
  });
  return { status: "waiting", summary, externalRef: `capy:${threadId}`, caseStatus: "waiting_for_deploy" };
}
