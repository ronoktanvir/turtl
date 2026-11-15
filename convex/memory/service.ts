import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, type ActionCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { vParameterValue } from "../constants";
import { addMemory, searchMemories } from "../supermemory";
import { applicability } from "./checks";

declare const process: { env: Record<string, string | undefined> };

export async function learnCase(
  ctx: ActionCtx,
  caseId: Id<"cases">,
): Promise<{
  saved: boolean;
  summary: string;
  memoryId?: Id<"recoveryMemories">;
  timesApplied?: number;
  timesVerified?: number;
  supermemoryWritten: boolean;
}> {
  const written = await ctx.runMutation(internal.memory.records.write, {
    caseId,
  });
  if (!written.saved)
    return {
      saved: false,
      summary: `Nothing was saved to recovery memory. ${written.reason}`,
      supermemoryWritten: false,
    };
  const memory = await ctx.runQuery(internal.memory.records.get, {
    memoryId: written.memoryId,
  });
  let supermemoryWritten = false;
  let indexing =
    "Supermemory was not written because SUPERMEMORY_API_KEY is not configured.";
  if (process.env.SUPERMEMORY_API_KEY && memory) {
    try {
      const response: unknown = await addMemory(
        `app_${memory.appId}`,
        [
          `Convex recovery memory: ${memory._id}`,
          `Symptoms: ${memory.symptoms}`,
          `Observed cause: ${memory.cause}`,
          `Recovery: ${memory.actionType}; disable the optional recommendations feature.`,
          `Use only when: ${memory.conditions.join("; ")}.`,
          `Do not use when: ${memory.notWhen.join("; ")}.`,
          `Verified by Convex verification ${memory.verificationId} at app revision ${memory.appRevision}.`,
          "This is a candidate recovery, never approval or permission to execute.",
        ].join("\n"),
        {
          memoryId: memory._id,
          appId: memory.appId,
          signature: memory.signature,
        },
      );
      if (
        response &&
        typeof response === "object" &&
        "id" in response &&
        typeof response.id === "string"
      ) {
        await ctx.runMutation(internal.memory.records.storeSupermemoryId, {
          memoryId: memory._id,
          supermemoryId: response.id,
        });
      }
      supermemoryWritten = true;
      indexing = "The searchable description was written to Supermemory.";
    } catch {
      indexing =
        "Supermemory was not written because indexing failed; the Convex recovery record is saved.";
    }
  }
  return {
    saved: true,
    memoryId: written.memoryId,
    timesApplied: written.timesApplied,
    timesVerified: written.timesVerified,
    supermemoryWritten,
    summary: `${written.created ? "Saved" : written.changed ? "Updated" : "Kept"} recovery memory for the verified recommendations recovery: ${written.timesApplied} distinct completed application${written.timesApplied === 1 ? "" : "s"}, ${written.timesVerified} verified. ${memory?.invalidatedAt !== undefined ? "This memory remains invalidated and will not apply on recall. " : ""}${indexing}`,
  };
}

export const learn = internalAction({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => await learnCase(ctx, caseId),
});

export const recall = internalAction({
  args: {
    appId: v.id("apps"),
    signature: v.string(),
    facts: v.record(v.string(), vParameterValue),
    symptoms: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { appId, signature, facts, symptoms },
  ): Promise<{
    candidates: (Doc<"recoveryMemories"> & {
      applies: boolean;
      failedChecks: string[];
    })[];
    supermemorySearched: boolean;
    summary: string;
  }> => {
    const exact = await ctx.runQuery(internal.memory.records.candidates, {
      appId,
      signature,
      texts: [],
    });
    let texts: string[] = [];
    let supermemorySearched = false;
    let summary =
      "Supermemory was not searched because SUPERMEMORY_API_KEY is not configured; Convex signature candidates were rechecked.";
    if (process.env.SUPERMEMORY_API_KEY) {
      try {
        texts = await searchMemories(
          `app_${appId}`,
          symptoms ||
            exact.map((row) => row.symptoms).join("\n") ||
            `Journey failed at ${facts["journey.failedStep"] ?? "an unknown step"} with ${facts["journey.errorCode"] ?? "an unknown error"}.`,
        );
        supermemorySearched = true;
        summary =
          "Convex signature candidates and Supermemory hits backed by Convex records were rechecked. Recall does not authorize execution.";
      } catch {
        summary =
          "Supermemory search failed; Convex signature candidates were rechecked. Recall does not authorize execution.";
      }
    }
    const rows = texts.length
      ? await ctx.runQuery(internal.memory.records.candidates, {
          appId,
          signature,
          texts,
        })
      : exact;
    const candidates = rows.map((row) => {
      const result = applicability(row, facts);
      if (!row.evidenceValid)
        result.failedChecks.push(
          "The source action no longer has a passing verification for its current recorded outcome.",
        );
      if (row.signature !== signature)
        result.failedChecks.push(
          "The current symptom signature differs from this recovery's signature.",
        );
      return {
        ...row,
        applies: result.failedChecks.length === 0,
        failedChecks: result.failedChecks,
      };
    });
    return { candidates, supermemorySearched, summary };
  },
});
