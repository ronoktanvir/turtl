import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  internalAction,
  internalQuery,
  type ActionCtx,
} from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { gateFor } from "../consent/gate";
import { NO_SUPERMEMORY, vParameterValue, type Stage } from "../constants";
import { latestAction, latestProposal } from "../protectedApp/records";
import type { Facts } from "../runner/handlers/journey";
import { addMemory, searchChunks, searchMemories } from "../supermemory";
import { loadSteps } from "../workflow";
import { applicability } from "./checks";

declare const process: { env: Record<string, string | undefined> };

const CASE_NOTE_PREFIX = "Convex case note: ";
const PAST_CASE_NOTES = 3;
const RECENT_CASES_SCANNED = 30;
const PAST_CASE_SEARCH_MS = 8_000;

type CaseNoteRecords = {
  case: Doc<"cases">;
  steps: (Doc<"steps"> & { currentAttempt: Doc<"stepAttempts"> | null })[];
  proposal: Doc<"proposals"> | null;
  action: Doc<"actions"> | null;
  verification: Doc<"verifications"> | null;
  matchedMemory: Doc<"recoveryMemories"> | null;
};

type PastCaseNotes = {
  notes: { caseId: Id<"cases">; note: string }[];
  fromSearch: boolean;
};

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
    `Supermemory was not written because ${NO_SUPERMEMORY}.`;
  const gate = gateFor(ctx, { caseId });
  const refused = process.env.SUPERMEMORY_API_KEY && memory ? await gate.blocked("supermemory") : null;
  if (refused) indexing = `Supermemory was not written because ${refused}; the Convex recovery record is saved.`;
  else if (process.env.SUPERMEMORY_API_KEY && memory) {
    try {
      const response: unknown = await addMemory(
        gate,
        `app_${memory.appId}`,
        [
          `Convex recovery memory: ${memory._id}`,
          `Symptoms: ${memory.symptoms}`,
          `Observed cause: ${memory.cause}`,
          `Recovery: ${memory.actionType}; disable the optional recommendations feature.`,
          `Use only when: ${memory.conditions.join("; ")}.`,
          `Do not use when: ${memory.notWhen.join("; ")}.`,
          `Verified by Convex verification ${memory.verificationId} at app revision ${memory.appRevision}.`,
          `Verification criteria: ${memory.criterionResults?.map((result) => `${result.criterionId}: ${result.status}`).join("; ") ?? "See the source verification"}.`,
          `Condition source: ${memory.conditionSource ?? "fallback"}.`,
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
    summary: `${written.created ? "Saved" : written.changed ? "Updated" : "Kept"} recovery memory: ${written.timesApplied} distinct completed application${written.timesApplied === 1 ? "" : "s"}, ${written.timesVerified} verified by the journey check. ${memory?.conditionSource === "fallback" ? "Conditions use the labelled fallback fact pattern because the diagnosis named no usable supporting facts. " : "Conditions retain the observations supporting the diagnosis. "}${
      memory?.criterionResults?.some((result) => result.status === "uncovered")
        ? `Not covered: ${memory.criterionResults
            .filter((result) => result.status === "uncovered")
            .map((result) => result.criterionId)
            .join(", ")}. `
        : ""
    }${memory?.invalidatedAt !== undefined ? "This memory remains invalidated and will not apply on recall. " : ""}${indexing}`,
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
      `Supermemory was not searched because ${NO_SUPERMEMORY}; the cases turtl keeps itself were rechecked.`;
    const gate = gateFor(ctx, { appId });
    const refused = process.env.SUPERMEMORY_API_KEY ? await gate.blocked("supermemory") : null;
    if (refused) summary = `Supermemory was not searched because ${refused}; Convex signature candidates were rechecked.`;
    else if (process.env.SUPERMEMORY_API_KEY) {
      try {
        texts = await searchMemories(
          gate,
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

export const caseNoteRecords = internalQuery({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }): Promise<CaseNoteRecords> => {
    const row = await ctx.db.get(caseId);
    if (!row) throw new Error("Case not found.");
    const steps = await loadSteps(ctx, caseId);
    const verificationId = ctx.db.normalizeId(
      "verifications",
      String(
        steps.find((step) => step.purpose === "verify")?.currentAttempt?.output
          ?.verificationId,
      ),
    );
    return {
      case: row,
      steps,
      proposal: await latestProposal(ctx, caseId),
      action: await latestAction(ctx, caseId),
      verification: verificationId ? await ctx.db.get(verificationId) : null,
      matchedMemory: row.matchedMemoryId
        ? await ctx.db.get(row.matchedMemoryId)
        : null,
    };
  },
});

// One Markdown note per case, built only from what its steps recorded. It is background for later
// diagnoses: it never skips a step, changes a recommendation, or approves an action.
export async function writeCaseNote(
  ctx: ActionCtx,
  caseId: Id<"cases">,
  learnSummary: string,
): Promise<{ note: string; summary: string }> {
  const records: CaseNoteRecords = await ctx.runQuery(
    internal.memory.service.caseNoteRecords,
    { caseId },
  );
  const {
    case: row,
    steps,
    proposal,
    action,
    verification,
    matchedMemory,
  } = records;
  const step = (purpose: Stage) =>
    steps.find((item) => item.purpose === purpose);
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  const facts = (step("gather_context")?.currentAttempt?.output?.facts ??
    {}) as Facts;
  const investigation = step("investigate");
  const diagnosis = investigation?.currentAttempt?.output?.diagnosis as
    | {
        source: "model" | "rules";
        cause: string;
        confidence: number;
        supportingFactKeys?: string[];
        modelId: string | null;
      }
    | undefined;
  const supportingKeys = (diagnosis?.supportingFactKeys ?? []).filter(
    (key) => key in facts,
  );
  const factLines = (keys: string[]) =>
    keys.map((key) => `- \`${key}\`: ${JSON.stringify(facts[key])}`);
  const chosen = proposal?.options.find(
    (option) => option.key === proposal.chosenKey,
  );
  const uncovered =
    verification?.criterionResults.filter(
      (result) => result.status === "uncovered",
    ) ?? [];

  const note = [
    `${CASE_NOTE_PREFIX}${row._id}`,
    "",
    `# ${row.title}`,
    "",
    "## What broke",
    row.impact,
    step("detect_or_receive")?.currentAttempt?.summary ??
      "The detection step recorded no summary.",
    "",
    "## Facts that mattered",
    ...(supportingKeys.length
      ? ["The facts the diagnosis relied on:", ...factLines(supportingKeys)]
      : investigation?.status === "skipped" && matchedMemory
        ? [
            `Investigation was skipped. Recovery memory ${matchedMemory._id}'s conditions held on fresh facts:`,
            ...matchedMemory.conditions.map((condition) => `- ${condition}`),
          ]
        : Object.keys(facts).length
          ? [
              "No diagnosis named supporting facts, so every gathered fact is listed:",
              ...factLines(Object.keys(facts)),
            ]
          : ["No facts were gathered."]),
    "",
    "## Cause",
    ...(diagnosis
      ? [
          diagnosis.cause,
          `Source: ${diagnosis.source === "model" ? `the model ${diagnosis.modelId}` : "a rule-based reading of the facts, not a model's diagnosis"}; confidence ${percent(diagnosis.confidence)}.`,
        ]
      : investigation?.status === "skipped"
        ? [
            `No fresh diagnosis: investigation was skipped. ${investigation.skipReason ?? ""}`.trim(),
            ...(matchedMemory
              ? [`Remembered cause: ${matchedMemory.cause}`]
              : []),
          ]
        : ["No cause was recorded."]),
    "",
    "## Proposed and decided",
    ...(proposal
      ? [
          ...proposal.options.map(
            (option) =>
              `- Proposal v${proposal.version}: ${option.title} (${option.recommended ? "recommended" : "not recommended"}, confidence ${percent(option.confidence)}).`,
          ),
          proposal.decisionStatus === "approved"
            ? `Approved "${chosen?.title ?? proposal.chosenKey}" ${action?.permissionId ? "under a standing permission the owner granted" : "by the owner"}.`
            : proposal.decisionStatus === "declined"
              ? "Declined by the owner."
              : "No decision was recorded.",
        ]
      : ["Nothing was proposed."]),
    "",
    "## What ran",
    action
      ? `${action.type} on ${action.environment} with ${action.executionPayload.parameters.map((p) => `${p.name} = ${JSON.stringify(p.value)}`).join(", ")}: ${action.status}. ${action.result ?? ""}`.trim()
      : "Nothing ran.",
    "",
    "## What the check showed",
    ...(verification
      ? [
          `Verdict: ${verification.verdict}. ${verification.summary}`,
          ...verification.criterionResults.map(
            (result) =>
              `- ${result.criterionId}: ${result.status}. ${result.summary}`,
          ),
          uncovered.length
            ? `Not covered: ${uncovered.map((result) => result.criterionId).join(", ")}.`
            : "Every criterion was covered.",
        ]
      : [
          step("verify")?.currentAttempt?.summary ??
            "No check after the change was recorded.",
        ]),
    "",
    "## Outcome",
    `Case status when this note was written: ${row.status}.`,
    learnSummary,
  ].join("\n");

  let indexing =
    `it was not indexed in Supermemory because ${NO_SUPERMEMORY}`;
  const gate = gateFor(ctx, { appId: row.appId });
  const refused = process.env.SUPERMEMORY_API_KEY ? await gate.blocked("supermemory") : null;
  if (refused) indexing = `it was not indexed in Supermemory because ${refused}`;
  else if (process.env.SUPERMEMORY_API_KEY) {
    try {
      await addMemory(gate, `app_${row.appId}`, note, {
        caseId: row._id,
        appId: row.appId,
        kind: "case_note",
      });
      indexing = "Supermemory accepted it for indexing";
    } catch {
      indexing = "indexing it in Supermemory failed";
    }
  }
  return {
    note,
    summary: `Saved a case note as this step's handoff; ${indexing}.`,
  };
}

export const pastCaseNotes = internalQuery({
  args: { caseId: v.id("cases"), linked: v.array(v.string()) },
  handler: async (ctx, { caseId, linked }): Promise<PastCaseNotes> => {
    const current = await ctx.db.get(caseId);
    if (!current) throw new Error("Case not found.");
    const noteOf = async (row: Doc<"cases"> | null) => {
      if (!row || row._id === caseId || row.appId !== current.appId)
        return null;
      const learn = (
        await ctx.db
          .query("steps")
          .withIndex("by_case", (q) => q.eq("caseId", row._id))
          .collect()
      ).find((step) => step.purpose === "learn");
      const attempt = learn?.currentAttemptId
        ? await ctx.db.get(learn.currentAttemptId)
        : null;
      return attempt?.status === "done" &&
        attempt.handoff?.startsWith(`${CASE_NOTE_PREFIX}${row._id}\n`)
        ? { caseId: row._id, note: attempt.handoff }
        : null;
    };
    const notes: PastCaseNotes["notes"] = [];
    for (const text of linked) {
      const id = ctx.db.normalizeId("cases", text);
      const found = id ? await noteOf(await ctx.db.get(id)) : null;
      if (found && !notes.some((note) => note.caseId === found.caseId))
        notes.push(found);
      if (notes.length === PAST_CASE_NOTES) break;
    }
    if (notes.length) return { notes, fromSearch: true };
    const recent = (
      await ctx.db
        .query("cases")
        .withIndex("by_app_and_signature", (q) => q.eq("appId", current.appId))
        .collect()
    )
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, RECENT_CASES_SCANNED);
    for (const row of recent) {
      const found = await noteOf(row);
      if (found) notes.push(found);
      if (notes.length === PAST_CASE_NOTES) break;
    }
    return { notes, fromSearch: false };
  },
});

// Up to three earlier case notes for the diagnosis model. Any failure returns none, so investigation
// runs exactly as it would without notes.
export async function readPastCaseNotes(
  ctx: ActionCtx,
  row: Doc<"cases">,
  facts: Facts,
): Promise<{ caseIds: Id<"cases">[]; notes: string[]; summary: string }> {
  try {
    let linked: string[] = [];
    let searchFailed = false;
    const gate = gateFor(ctx, { appId: row.appId });
    const refused = process.env.SUPERMEMORY_API_KEY ? await gate.blocked("supermemory") : null;
    if (process.env.SUPERMEMORY_API_KEY && !refused) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const texts = await Promise.race([
        searchChunks(
          gate,
          `app_${row.appId}`,
          `${row.title}. ${row.impact} Journey failed at ${facts["journey.failedStep"] ?? "an unknown step"} with ${facts["journey.errorCode"] ?? "an unknown error"}.`,
          { limit: 10, anyOf: [{ field: "kind", value: "case_note" }] },
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Supermemory search timed out.")),
            PAST_CASE_SEARCH_MS,
          );
        }),
      ]).catch(() => {
        searchFailed = true;
        return [];
      }).finally(() => clearTimeout(timer));
      linked = texts.flatMap(({ text }) =>
        [...text.matchAll(/Convex case note: ([a-zA-Z0-9]+)/g)].map(
          (match) => match[1],
        ),
      );
    }
    const found: PastCaseNotes = await ctx.runQuery(
      internal.memory.service.pastCaseNotes,
      { caseId: row._id, linked },
    );
    const count = found.notes.length;
    const read = `Read ${count} earlier case note${count === 1 ? "" : "s"} for this app`;
    return {
      caseIds: found.notes.map((note) => note.caseId),
      notes: found.notes.map((note) => note.note),
      summary: !count
        ? `${read}: none are saved yet.`
        : found.fromSearch
          ? `${read}, found by Supermemory search, as background for the model.`
          : `${read} from the most recent learn notes in Convex (${refused ? `Supermemory was not searched because ${refused}` : searchFailed ? "Supermemory search failed" : process.env.SUPERMEMORY_API_KEY ? "Supermemory search linked to none" : NO_SUPERMEMORY}), as background for the model.`,
    };
  } catch {
    return {
      caseIds: [],
      notes: [],
      summary:
        "Read 0 earlier case notes: reading them failed, so the diagnosis used only this case's facts and evidence.",
    };
  }
}
