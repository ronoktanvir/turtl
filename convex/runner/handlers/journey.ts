import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import type { Revision } from "../../constants";
import { ENVIRONMENT, type WatchedApp } from "../../protectedApp/client";
import { watchedApp } from "../../protectedApp/watched";
import type { HandlerInput } from "../contract";

// Shared by the handlers that work on a monitored journey (the booking app). A case with no journey,
// such as a dev live run, keeps each handler's placeholder.

export type CaseContext = {
  case: Doc<"cases">;
  app: Doc<"apps"> | null;
  journey: Doc<"journeys"> | null;
  catalog: Doc<"actionCatalog">[];
  steps: (Doc<"steps"> & { currentAttempt: Doc<"stepAttempts"> | null })[];
  evidence: Doc<"evidence">[];
  proposal: Doc<"proposals"> | null;
  action: Doc<"actions"> | null;
};

export type JourneyContext = CaseContext & {
  base: string;
  journey: Doc<"journeys">;
  check: { url: string; credentialRef?: string };
  /** The case's project, which every request to its app is sent for (convex/protectedApp/watched.ts). */
  watched: WatchedApp;
};

export async function loadJourneyContext(
  ctx: ActionCtx,
  input: HandlerInput,
): Promise<{ ok: true; context: JourneyContext } | { ok: false; reason: string }> {
  const context: CaseContext = await ctx.runQuery(internal.protectedApp.records.caseContext, {
    caseId: input.case._id,
  });
  const base = context.app?.productionUrl;
  if (!base) return { ok: false, reason: "The case's app has no control URL registered." };
  const journey = context.journey;
  if (!journey) return { ok: false, reason: "The case has no journey to check." };
  if (journey.check.kind !== "http") {
    return { ok: false, reason: "Only http journey checks can be run; this journey uses another kind." };
  }
  return { ok: true, context: { ...context, base, journey, check: journey.check.config, watched: await watchedApp(ctx, { appId: input.case.appId }) } };
}

export function evidenceRow(
  input: HandlerInput,
  revision: Revision,
  fields: { kind: string; title: string; body?: string; sourceRef?: string },
) {
  return {
    caseId: input.case._id,
    stepId: input.step._id,
    stepAttemptId: input.attempt._id,
    observedAt: Date.now(),
    environment: ENVIRONMENT,
    revision,
    ...fields,
  };
}

export type Facts = Record<string, string | number | boolean>;

export const factsOf = (context: CaseContext): Facts | null =>
  (context.steps.find((s) => s.purpose === "gather_context")?.currentAttempt?.output?.facts as
    | Facts
    | undefined) ?? null;
