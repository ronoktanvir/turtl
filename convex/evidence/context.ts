import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { HandlerInput } from "../runner/contract";
import type { JourneyContext } from "../runner/handlers/journey";
import { readAppState, readErrorWindow } from "./collectors";
import { joinSnapshots, type AppEvidence } from "./snapshots";

export type { AppEvidence } from "./snapshots";

export async function readAppEvidence(ctx: ActionCtx, input: HandlerInput, context: JourneyContext): Promise<AppEvidence> {
  const collectorRoles = ["collect_app_state", "collect_error_window"];
  const isCollector = (step: { key: string; purpose: string }) => collectorRoles.includes(step.key) || collectorRoles.includes(step.purpose);
  const hasCollectors = context.steps.some(isCollector)
    || input.parents.some(({ step, attempt }) => isCollector(step) || (attempt?.output !== null && typeof attempt?.output === "object" && Object.hasOwn(attempt.output, "collector")))
    || input.step.dependsOn.some((key) => collectorRoles.includes(key));
  if (hasCollectors) {
    const consumed = joinSnapshots(input, context);
    const projections = await ctx.runMutation(internal.evidence.records.projectEvidence, { attemptId: input.attempt._id });
    return { ...consumed, refs: [...consumed.refs, ...projections] };
  }
  const [state, errors] = await Promise.all([readAppState(input, context.base), readErrorWindow(input, context.base)]);
  const rows = [...state.rows, ...errors.rows];
  const ids: Id<"evidence">[] = await ctx.runMutation(internal.protectedApp.records.addEvidence, { rows });
  return {
    facts: { ...state.facts, ...errors.facts },
    missing: [...state.missing, ...errors.missing],
    revision: state.revision,
    refs: ids.map((id, i) => ({ kind: "evidence", id, label: rows[i].kind })),
    readCount: state.readCount + errors.readCount,
    sourceCount: 4,
  };
}
