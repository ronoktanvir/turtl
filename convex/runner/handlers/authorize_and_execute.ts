import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { call, describeFailure } from "../../protectedApp/client";
import type { HandlerResult, StepHandler } from "../contract";

type Claim = { mode: "send" | "reconcile" | "completed" | "cancelled"; action: Doc<"actions"> };

const finish = (
  ctx: Parameters<StepHandler["run"]>[0],
  actionId: Id<"actions">,
  status: "completed" | "failed" | "unknown" | "running",
  result: string,
  externalRef?: string,
) =>
  ctx.runMutation(internal.protectedApp.records.finishAction, {
    actionId,
    status,
    result,
    ...(externalRef !== undefined && { externalRef }),
  });

// Runs the approved action's frozen payload once. An attempt whose outcome is unknown is reconciled
// by reading the flag before anything is sent again.
export const handler: StepHandler = {
  timeoutMs: 60_000,
  run: async (ctx, input): Promise<HandlerResult> => {
    if (!input.case.journeyId) {
      return {
        status: "done",
        summary: "Placeholder: the owner approved, but nothing was executed.",
        handoff: { note: "Nothing ran: execution is a placeholder.", refs: [] },
      };
    }
    const latest: Doc<"actions"> | null = (
      await ctx.runQuery(internal.protectedApp.records.caseContext, { caseId: input.case._id })
    ).action;
    if (!latest) return { status: "failed", error: "No approved action was found for this case." };
    const { mode, action }: Claim = await ctx.runMutation(internal.protectedApp.records.claimAction, {
      actionId: latest._id,
    });
    const refs = [{ kind: "action", id: action._id, label: action.type }];
    if (mode === "completed") {
      return { status: "done", summary: `Already done: ${action.result ?? "the action completed earlier."}`, handoff: { note: "The action had already completed.", refs } };
    }
    if (mode === "cancelled") return { status: "failed", error: "The action was cancelled." };

    const { config, parameters } = action.executionPayload;
    if (config.kind !== "http") return { status: "failed", error: `Unsupported action config: ${config.kind}.` };
    const flag = parameters.find((p) => p.name === "flag")?.value;
    const value = parameters.find((p) => p.name === "value")?.value;
    if (typeof flag !== "string" || typeof value !== "boolean") {
      await finish(ctx, action._id, "failed", "The approved payload has no flag and value; nothing was sent.");
      return { status: "failed", error: "The approved payload has no flag and value; nothing was sent." };
    }
    const flagIn = (body: unknown) => (body as Record<string, unknown> | null)?.[flag];
    const refOf = (body: unknown) =>
      `${flag}=${String(flagIn(body))} at ${(body as { updatedAt?: unknown } | null)?.updatedAt ?? "unknown time"}`;

    if (mode === "reconcile") {
      const read = await call(config.url, { credentialRef: config.credentialRef });
      if (read.kind !== "response" || read.status !== 200 || typeof flagIn(read.body) !== "boolean") {
        const result = `Could not read ${flag} to reconcile (${describeFailure(read)}); nothing was sent again.`;
        await finish(ctx, action._id, "unknown", result);
        return { status: "failed", error: `Outcome still unknown: ${result}` };
      }
      if (flagIn(read.body) === value) {
        const result = `Reconciled: the booking app already reports ${flag} = ${value}, so the change had been applied. Nothing was sent again.`;
        await finish(ctx, action._id, "completed", result, refOf(read.body));
        return { status: "done", summary: result, externalRef: refOf(read.body), handoff: { note: result, refs } };
      }
      await finish(ctx, action._id, "running", `Reconciled: ${flag} is still ${String(flagIn(read.body))}, so the change is sent again.`);
    }

    const sent = await call(config.url, {
      method: config.method === "GET" ? "GET" : "POST",
      body: { [flag]: value },
      credentialRef: config.credentialRef,
    });
    if (sent.kind === "not_sent") {
      const result = `Not sent: ${sent.reason}.`;
      await finish(ctx, action._id, "failed", result);
      return { status: "failed", error: result };
    }
    if (sent.kind === "no_response" || sent.status >= 500) {
      const result = `Sent ${config.method} ${new URL(config.url).pathname}, but ${describeFailure(sent)}: the change may or may not have been applied. The next attempt reads ${flag} before sending anything again.`;
      await finish(ctx, action._id, "unknown", result);
      return { status: "failed", error: `Outcome unknown. ${result}` };
    }
    if (sent.status !== 200 || flagIn(sent.body) !== value) {
      const result = `The booking app refused the change (${describeFailure(sent)}).`;
      await finish(ctx, action._id, "failed", result);
      return { status: "failed", error: result };
    }
    const result = `Turned ${flag} ${value ? "on" : "off"}: the booking app confirmed ${flag} = ${value}.`;
    await finish(ctx, action._id, "completed", result, refOf(sent.body));
    return { status: "done", summary: result, externalRef: refOf(sent.body), handoff: { note: result, refs } };
  },
};
