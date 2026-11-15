import { v } from "convex/values";
import type { Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { vOutputRef } from "../constants";

export const vHandlerResult = v.union(
  v.object({
    status: v.literal("done"),
    summary: v.string(),
    handoff: v.optional(
      v.object({ note: v.string(), refs: v.optional(v.array(vOutputRef)) }),
    ),
    output: v.optional(v.any()),
    externalRef: v.optional(v.string()),
    caseStatus: v.optional(v.literal("restored")),
  }),
  v.object({
    status: v.literal("waiting"),
    summary: v.string(),
    externalRef: v.optional(v.string()),
    caseStatus: v.optional(v.literal("waiting_for_deploy")),
  }),
  v.object({
    status: v.literal("failed"),
    error: v.string(),
    summary: v.optional(v.string()),
    externalRef: v.optional(v.string()),
  }),
);

export type HandlerResult = Infer<typeof vHandlerResult>;

export type LoadedInput = {
  case: Doc<"cases">;
  step: Doc<"steps">;
  attempt: Doc<"stepAttempts">;
  parents: { step: Doc<"steps">; attempt: Doc<"stepAttempts"> | null }[];
  previousAttempts: Doc<"stepAttempts">[];
};

export type HandlerInput = LoadedInput & {
  idempotencyKey: string;
  approval: { approvedAt: number } | null;
};

export type StepHandler = {
  timeoutMs: number;
  run: (ctx: ActionCtx, input: HandlerInput) => Promise<HandlerResult>;
};
