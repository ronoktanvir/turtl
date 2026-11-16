import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { askJson, fixesModelId } from "../fixOptions";

// One JSON model call with its agentRuns row written before and finished after, whatever the outcome.
export async function askJsonWithRun(
  ctx: ActionCtx,
  run: {
    caseId: Id<"cases">;
    stepAttemptId?: Id<"stepAttempts">;
    taskType: string;
    promptVersion: string;
    contextRefs?: Id<"contextSources">[];
  },
  system: string,
  user: unknown,
): Promise<Awaited<ReturnType<typeof askJson>>> {
  const started = Date.now();
  const agentRunId: Id<"agentRuns"> | null = await ctx.runMutation(internal.learning.runs.start, {
    ...run,
    modelId: fixesModelId(),
  });
  const answer = await askJson(system, user);
  if (agentRunId) {
    await ctx.runMutation(internal.learning.runs.finish, {
      agentRunId,
      status: answer.ok ? "completed" : "failed",
      durationMs: Date.now() - started,
      ...(!answer.ok && { error: `No model answered: ${answer.reason}.` }),
    });
  }
  return answer;
}

export const PREFERENCE_FIELD =
  'preference: if the owner states a lasting preference about how turtl should handle their app (what must keep working, what to avoid, a trade-off they prefer), restate it as one short sentence in the owner\'s voice, at most 12 words, such as "Keep booking up." or "Don\'t restart active jobs."; otherwise null. Never invent one, and never treat a one-off question or a reason for this one decision as a lasting preference.';

const NOTE_PROMPT = [
  "The owner of a small app left this note when deciding on a fix turtl proposed. The owner is not an engineer.",
  `Reply with a JSON object {"preference": string | null}. ${PREFERENCE_FIELD}`,
].join("\n");

export async function preferenceFromNote(
  ctx: ActionCtx,
  caseId: Id<"cases">,
  note: string,
  decision: string,
): Promise<{ ok: true; preference: string | null } | { ok: false; reason: string }> {
  const answer = await askJsonWithRun(
    ctx,
    { caseId, taskType: "extract_preference", promptVersion: "preference-from-note-v1" },
    NOTE_PROMPT,
    { decision, note },
  );
  if (!answer.ok) return answer;
  return { ok: true, preference: cleanStatement(answer.json.preference) };
}

export function cleanStatement(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 200) : null;
}
