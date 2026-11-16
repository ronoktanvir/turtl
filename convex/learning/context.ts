import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { vContextSource } from "../constants";
import { latestAction, latestProposal } from "../protectedApp/records";
import { loadSteps } from "../workflow";
import type { Facts } from "./rules";

// Context learning (brief 5.7): which context gather_context supplied to a case, and which of it a diagnosis
// or the chosen fix used on the way to a verified recovery. Sources that helped are supplied first next
// time; one recorded at another app revision is flagged as possibly stale. Context never authorizes anything.

const MAX_CODE = 4;
const MAX_DETAIL = 600;
const STOP_WORDS = new Set(["the", "and", "can't", "cant", "with", "from", "that", "this", "none", "failed", "customers", "right", "now"]);

type Kind = Doc<"contextSources">["kind"];
export type SuppliedItem = { kind: Kind; sourceRef: string; label: string; detail: string; score: number };
export type ContextUse = {
  id: Id<"contextUses">;
  contextSourceId: Id<"contextSources">;
  kind: Kind;
  sourceRef: string;
  label: string;
  detail: string;
  helpedBefore: boolean;
  stale: boolean;
  staleNote?: string;
};

const stems = (text: string) =>
  text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word))
    .map((word) => word.slice(0, 5));

export const sources = internalQuery({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    const network = await ctx.db
      .query("codeNetworks")
      .withIndex("by_project", (q) => q.eq("projectId", appId))
      .first();
    const known = await ctx.db
      .query("contextSources")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .collect();
    const exists = async (row: Doc<"contextSources">) => {
      if (row.kind === "past_case") {
        const id = ctx.db.normalizeId("cases", row.sourceRef.replace("cases/", ""));
        return !!id && !!(await ctx.db.get(id));
      }
      if (row.kind === "memory") {
        const id = ctx.db.normalizeId("recoveryMemories", row.sourceRef.replace("recoveryMemories/", ""));
        const memory = id ? await ctx.db.get(id) : null;
        return !!memory && memory.invalidatedAt === undefined;
      }
      return true;
    };
    const live: Doc<"contextSources">[] = [];
    for (const row of known) if ((row.timesHelped ?? 0) > 0 && row.invalidatedAt === undefined && (await exists(row))) live.push(row);
    return {
      nodes: network?.nodes ?? [],
      networkRef: network ? `${network.repo}@${network.ref.slice(0, 12)}` : null,
      helped: live
        .sort((a, b) => (b.timesHelped ?? 0) - (a.timesHelped ?? 0) || (b.lastHelpedAt ?? 0) - (a.lastHelpedAt ?? 0)),
    };
  },
});

// Picks the context for a case, records it, and returns it with the sources that helped before first.
export async function supplyContext(
  ctx: ActionCtx,
  input: {
    caseRow: Doc<"cases">;
    stepAttemptId: Id<"stepAttempts">;
    facts: Facts;
    observed: string;
    revision: string | null;
    memories: { _id: Id<"recoveryMemories">; cause: string; conditions: string[]; applies: boolean }[];
  },
): Promise<{ uses: ContextUse[]; summary: string }> {
  const { caseRow, facts } = input;
  const found: {
    nodes: Doc<"codeNetworks">["nodes"];
    networkRef: string | null;
    helped: Doc<"contextSources">[];
  } = await ctx.runQuery(internal.learning.context.sources, { appId: caseRow.appId });
  // Code network nodes ranked by the rarer words of what failed: each stem counts by how few nodes share it.
  const nodeStems = found.nodes.map((node) => new Set(stems(`${node.label} ${node.path ?? ""} ${node.summary}`)));
  const weighted = new Map<string, number>();
  const weigh = (text: string, weight: number) => {
    for (const stem of stems(text)) {
      const shared = nodeStems.filter((set) => set.has(stem)).length;
      if (shared && shared <= found.nodes.length / 4) {
        weighted.set(stem, Math.max(weighted.get(stem) ?? 0, weight * Math.log(found.nodes.length / shared)));
      }
    }
  };
  for (const key of ["journey.failedStep", "journey.errorCode"]) {
    if (typeof facts[key] === "string") weigh(String(facts[key]).replace(/_/g, " "), 2);
  }
  weigh(`${caseRow.title} ${caseRow.impact} ${input.observed}`, 1);
  const items: SuppliedItem[] = found.nodes
    .map((node, i) => {
      const score = [...weighted].reduce((sum, [stem, weight]) => sum + (nodeStems[i].has(stem) ? weight : 0), 0);
      return {
        kind: (node.path?.endsWith(".md") ? "document" : "code") as Kind,
        sourceRef: `code:${node.path ?? node.id}`,
        label: node.path ? `${node.label} (${node.path})` : node.label,
        detail: node.summary.slice(0, MAX_DETAIL),
        score,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .filter((item, _, ranked) => item.score >= ranked[0].score * 0.6)
    .slice(0, MAX_CODE);
  const past: { notes: { caseId: Id<"cases">; note: string }[] } = await ctx.runQuery(internal.memory.service.pastCaseNotes, { caseId: caseRow._id, linked: [] });
  for (const note of past.notes) {
    items.push({
      kind: "past_case",
      sourceRef: `cases/${note.caseId}`,
      label: note.note.split("\n").find((line) => line.startsWith("# "))?.slice(2) ?? `Case ${note.caseId}`,
      detail: note.note.slice(0, MAX_DETAIL),
      score: 0,
    });
  }
  for (const memory of input.memories) {
    items.push({
      kind: "memory",
      sourceRef: `recoveryMemories/${memory._id}`,
      label: `Recovery memory ${memory._id}${memory.applies ? " (its conditions hold now)" : " (does not apply now)"}`,
      detail: `Cause: ${memory.cause}. Use only when: ${memory.conditions.join("; ")}.`.slice(0, MAX_DETAIL),
      score: 0,
    });
  }
  const nodeByRef = new Map(found.nodes.map((node) => [`code:${node.path ?? node.id}`, node]));
  for (const row of found.helped) {
    if (items.some((item) => item.sourceRef === row.sourceRef)) continue;
    const node = nodeByRef.get(row.sourceRef);
    if (row.kind !== "past_case" && row.kind !== "memory" && !node) continue;
    items.push({
      kind: row.kind,
      sourceRef: row.sourceRef,
      label: row.label ?? row.sourceRef,
      detail: (node?.summary ?? row.label ?? row.sourceRef).slice(0, MAX_DETAIL),
      score: 0,
    });
  }

  const uses: ContextUse[] = await ctx.runMutation(internal.learning.context.recordSupplied, {
    appId: caseRow.appId,
    caseId: caseRow._id,
    stepAttemptId: input.stepAttemptId,
    revision: input.revision ?? undefined,
    items,
  });
  const first = uses.filter((use) => use.helpedBefore);
  const stale = uses.filter((use) => use.stale);
  const counts = (["code", "document", "past_case", "memory"] as const)
    .map((kind) => [kind, uses.filter((use) => use.kind === kind).length] as const)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${{ code: "code source", document: "document", past_case: "past case", memory: "recovery memory" }[kind]}${n === 1 ? "" : "s"}`);
  const summary = !uses.length
    ? "Supplied no code, documents, past cases or memories: none are stored for this app yet."
    : [
        `Supplied ${counts.join(", ")} as context${input.revision ? ` at app revision ${input.revision}` : ""}.`,
        first.length
          ? `Fetched first, because they helped a verified fix before: ${first.map((use) => use.label).join("; ")}.`
          : "None of it has helped a verified fix yet.",
        stale.length ? `Possibly stale: ${stale.map((use) => use.staleNote).join(" ")}` : "",
      ]
        .filter(Boolean)
        .join(" ");
  return { uses, summary };
}

const vItem = v.object({
  kind: vContextSource.fields.kind,
  sourceRef: v.string(),
  label: v.string(),
  detail: v.string(),
  score: v.number(),
});

export const recordSupplied = internalMutation({
  args: {
    appId: v.id("apps"),
    caseId: v.id("cases"),
    stepAttemptId: v.id("stepAttempts"),
    revision: v.optional(v.string()),
    items: v.array(vItem),
  },
  handler: async (ctx, { appId, caseId, stepAttemptId, revision, items }): Promise<ContextUse[]> => {
    const now = Date.now();
    const rows: (ContextUse & { order: number })[] = [];
    for (const [index, item] of items.entries()) {
      let source = await ctx.db
        .query("contextSources")
        .withIndex("by_app_and_source", (q) => q.eq("appId", appId).eq("sourceRef", item.sourceRef))
        .first();
      if (!source) {
        const id = await ctx.db.insert("contextSources", {
          appId,
          kind: item.kind,
          sourceRef: item.sourceRef,
          ...(revision && { revision }),
          indexedAt: now,
          label: item.label,
          timesSupplied: 0,
          timesUsed: 0,
          timesHelped: 0,
        });
        source = (await ctx.db.get(id))!;
      }
      const helpedBefore = (source.timesHelped ?? 0) > 0;
      const stale = helpedBefore && !!source.revision && !!revision && source.revision !== revision;
      const staleNote = stale
        ? `${item.label} helped at app revision ${source.revision}, and the app now reports ${revision}, so it is not trusted without fresh evidence.`
        : undefined;
      await ctx.db.patch(source._id, {
        label: item.label,
        timesSupplied: (source.timesSupplied ?? 0) + 1,
        ...(!helpedBefore && revision && { revision }),
      });
      const id = await ctx.db.insert("contextUses", {
        appId,
        caseId,
        stepAttemptId,
        contextSourceId: source._id,
        kind: item.kind,
        sourceRef: item.sourceRef,
        label: item.label,
        ...(revision && { appRevision: revision }),
        rank: index,
        helpedBefore,
        stale,
        ...(staleNote && { staleNote }),
      });
      rows.push({
        id,
        contextSourceId: source._id,
        kind: item.kind,
        sourceRef: item.sourceRef,
        label: item.label,
        detail: item.detail,
        helpedBefore,
        stale,
        ...(staleNote && { staleNote }),
        order: helpedBefore ? -1000 + index - (source.timesHelped ?? 0) * 100 : index,
      });
    }
    for (const [rank, row] of rows.sort((a, b) => a.order - b.order).entries()) await ctx.db.patch(row.id, { rank });
    return rows.map(({ order: _order, ...use }) => use);
  },
});

// Marks which supplied sources the diagnosis or the chosen fix used, and, when the fix was verified, that they helped.
export const markForCase = internalMutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    const row = await ctx.db.get(caseId);
    const uses = await ctx.db.query("contextUses").withIndex("by_case", (q) => q.eq("caseId", caseId)).collect();
    if (!row || !uses.length) {
      return { supplied: 0, used: 0, helped: 0, verified: false, summary: "No context sources were recorded for this case." };
    }
    const steps = await loadSteps(ctx, caseId);
    const investigation = steps.find((s) => s.purpose === "investigate")?.currentAttempt?.output as
      | { diagnosis?: { source?: string }; pastCaseIds?: string[] }
      | undefined;
    const pastUsed = investigation?.diagnosis?.source === "model" ? new Set(investigation.pastCaseIds ?? []) : new Set<string>();
    const proposal = await latestProposal(ctx, caseId);
    const chosen = proposal?.decisionStatus === "approved" ? proposal.options.find((o) => o.key === proposal.chosenKey) : undefined;
    const fixUsed = new Set<string>(chosen?.contextIds ?? []);
    const action = await latestAction(ctx, caseId);
    const verified =
      !!action &&
      action.status === "completed" &&
      (await ctx.db.query("verifications").withIndex("by_action", (q) => q.eq("actionId", action._id)).collect()).some(
        (verification) => verification.phase !== "before" && verification.verdict === "passed",
      );
    const now = Date.now();
    let used = 0;
    let helped = 0;
    for (const use of uses) {
      const isUsed =
        fixUsed.has(use._id) ||
        (use.kind === "memory" && !!row.matchedMemoryId && use.sourceRef === `recoveryMemories/${row.matchedMemoryId}`) ||
        (use.kind === "past_case" && pastUsed.has(use.sourceRef.replace("cases/", "")));
      const isHelped = isUsed && verified;
      await ctx.db.patch(use._id, { used: isUsed, helped: isHelped, markedAt: now });
      if (!isUsed || use.markedAt !== undefined) continue;
      used++;
      const source = await ctx.db.get(use.contextSourceId);
      if (!source) continue;
      await ctx.db.patch(source._id, {
        timesUsed: (source.timesUsed ?? 0) + 1,
        ...(isHelped && {
          timesHelped: (source.timesHelped ?? 0) + 1,
          lastHelpedAt: now,
          ...(use.appRevision && { revision: use.appRevision }),
        }),
      });
      if (isHelped) helped++;
    }
    const summary = !used
      ? `Context learning: none of the ${uses.length} supplied sources was used by the diagnosis or the chosen fix.`
      : verified
        ? `Context learning: ${used} of ${uses.length} supplied sources were used by the diagnosis or the chosen fix, and the fix was verified, so they will be fetched first next time.`
        : `Context learning: ${used} of ${uses.length} supplied sources were used, but the fix was not verified, so none is marked as having helped.`;
    return { supplied: uses.length, used, helped, verified, summary };
  },
});
