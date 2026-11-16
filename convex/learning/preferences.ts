import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx } from "../_generated/server";
import { requireOwnerPasscode } from "../ownerPasscode";
import { deleteDocuments, putDocument, searchWithMetadata } from "../supermemory";
import { cleanStatement, preferenceFromNote } from "./model";
import { vSuggestionSource } from "./schema";

declare const process: { env: Record<string, string | undefined> };

// What the owner says matters. Convex's ownerPreferences is the record; Supermemory holds a copy only for
// ranking which preferences bear on a case. Every write checks the owner passcode, and a suggestion turtl
// heard becomes a preference only when the owner confirms it.

export const MAX_STATEMENT_LENGTH = 200;
const MAX_APPLICABLE = 8;
const SEARCH_TIMEOUT_MS = 8_000;

export const preferenceNamespace = (appId: Id<"apps">) => `prefs_${appId}`;

function statementOf(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) throw new ConvexError("Write what matters to you first.");
  if (text.length > MAX_STATEMENT_LENGTH) {
    throw new ConvexError(`Keep it to ${MAX_STATEMENT_LENGTH} characters or fewer.`);
  }
  return text;
}

const toPreference = (row: Doc<"ownerPreferences">) => ({
  id: row._id as string,
  statement: row.statement,
  source: row.source ?? ("settings" as const),
  createdAt: row._creationTime,
});

export const list = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const appId = ctx.db.normalizeId("apps", projectId);
    const app = appId ? await ctx.db.get(appId) : null;
    if (!app) return null;
    const preferences = await ctx.db
      .query("ownerPreferences")
      .withIndex("by_app", (q) => q.eq("appId", app._id))
      .collect();
    const suggestions = await ctx.db
      .query("preferenceSuggestions")
      .withIndex("by_app_and_status", (q) => q.eq("appId", app._id).eq("status", "pending"))
      .collect();
    return {
      preferences: preferences.map(toPreference),
      suggestions: suggestions.map((row) => ({
        id: row._id as string,
        statement: row.statement,
        source: row.source,
        createdAt: row.createdAt,
      })),
    };
  },
});

export const add = mutation({
  args: { projectId: v.string(), statement: v.string(), passcode: v.optional(v.string()) },
  handler: async (ctx, { projectId, statement, passcode }) => {
    await requireOwnerPasscode(ctx, passcode);
    const appId = ctx.db.normalizeId("apps", projectId);
    if (!appId || !(await ctx.db.get(appId))) throw new ConvexError("This project was not found.");
    const id = await ctx.db.insert("ownerPreferences", { appId, statement: statementOf(statement), source: "settings" });
    await ctx.scheduler.runAfter(0, internal.learning.preferences.index, { preferenceId: id });
    return { id: id as string };
  },
});

export const remove = mutation({
  args: { preferenceId: v.string(), passcode: v.optional(v.string()) },
  handler: async (ctx, { preferenceId, passcode }) => {
    await requireOwnerPasscode(ctx, passcode);
    const id = ctx.db.normalizeId("ownerPreferences", preferenceId);
    const row = id ? await ctx.db.get(id) : null;
    if (!row) throw new ConvexError("This preference was already removed.");
    await ctx.db.delete(row._id);
    await ctx.scheduler.runAfter(0, internal.learning.preferences.unindex, {
      appId: row.appId,
      documentId: row.supermemoryId ?? row._id,
    });
    return null;
  },
});

export const confirm = mutation({
  args: { suggestionId: v.string(), statement: v.optional(v.string()), passcode: v.optional(v.string()) },
  handler: async (ctx, { suggestionId, statement, passcode }) => {
    await requireOwnerPasscode(ctx, passcode);
    const id = ctx.db.normalizeId("preferenceSuggestions", suggestionId);
    const suggestion = id ? await ctx.db.get(id) : null;
    if (!suggestion) throw new ConvexError("This suggestion no longer exists.");
    if (suggestion.status !== "pending") throw new ConvexError(`This suggestion was already ${suggestion.status}.`);
    const preferenceId = await ctx.db.insert("ownerPreferences", {
      appId: suggestion.appId,
      statement: statementOf(statement ?? suggestion.statement),
      source: suggestion.source,
      ...(suggestion.caseId && { sourceCaseId: suggestion.caseId }),
    });
    await ctx.db.patch(suggestion._id, { status: "saved", preferenceId });
    await ctx.scheduler.runAfter(0, internal.learning.preferences.index, { preferenceId });
    return { id: preferenceId as string };
  },
});

export const dismiss = mutation({
  args: { suggestionId: v.string(), passcode: v.optional(v.string()) },
  handler: async (ctx, { suggestionId, passcode }) => {
    await requireOwnerPasscode(ctx, passcode);
    const id = ctx.db.normalizeId("preferenceSuggestions", suggestionId);
    const suggestion = id ? await ctx.db.get(id) : null;
    if (!suggestion) throw new ConvexError("This suggestion no longer exists.");
    if (suggestion.status !== "pending") throw new ConvexError(`This suggestion was already ${suggestion.status}.`);
    await ctx.db.patch(suggestion._id, { status: "dismissed" });
    return null;
  },
});

// A suggestion waiting for the owner. Skipped when the same statement is already saved or waiting.
export const suggest = internalMutation({
  args: {
    appId: v.id("apps"),
    caseId: v.optional(v.id("cases")),
    statement: v.string(),
    source: vSuggestionSource,
    chatMessageId: v.optional(v.id("fixChatMessages")),
    decisionId: v.optional(v.id("ownerDecisions")),
  },
  handler: async (ctx, args) => {
    const same = (text: string) => text.toLowerCase().replace(/[.!\s]+$/g, "") === args.statement.toLowerCase().replace(/[.!\s]+$/g, "");
    const saved = await ctx.db.query("ownerPreferences").withIndex("by_app", (q) => q.eq("appId", args.appId)).collect();
    const pending = await ctx.db
      .query("preferenceSuggestions")
      .withIndex("by_app_and_status", (q) => q.eq("appId", args.appId).eq("status", "pending"))
      .collect();
    if (saved.some((row) => same(row.statement)) || pending.some((row) => same(row.statement))) return null;
    return await ctx.db.insert("preferenceSuggestions", { ...args, status: "pending", createdAt: Date.now() });
  },
});

export const forApp = internalQuery({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) =>
    await ctx.db.query("ownerPreferences").withIndex("by_app", (q) => q.eq("appId", appId)).collect(),
});

export const get = internalQuery({
  args: { preferenceId: v.id("ownerPreferences") },
  handler: async (ctx, { preferenceId }) => await ctx.db.get(preferenceId),
});

export const storeSupermemoryId = internalMutation({
  args: { preferenceId: v.id("ownerPreferences"), supermemoryId: v.string() },
  handler: async (ctx, { preferenceId, supermemoryId }) => {
    if (!(await ctx.db.get(preferenceId))) return false;
    await ctx.db.patch(preferenceId, { supermemoryId });
    return true;
  },
});

// Copies one preference to Supermemory and stores the document id on the row. A missing key leaves the
// Convex record as the only copy, which still applies.
export const index = internalAction({
  args: { preferenceId: v.id("ownerPreferences") },
  handler: async (ctx, { preferenceId }): Promise<{ indexed: boolean; reason?: string; supermemoryId?: string }> => {
    if (!process.env.SUPERMEMORY_API_KEY) return { indexed: false, reason: "SUPERMEMORY_API_KEY is not set." };
    const row: Doc<"ownerPreferences"> | null = await ctx.runQuery(internal.learning.preferences.get, { preferenceId });
    if (!row) return { indexed: false, reason: "The preference was removed before it was indexed." };
    const supermemoryId = await putDocument(
      preferenceNamespace(row.appId),
      row._id,
      `Owner preference (Convex ownerPreferences ${row._id}): ${row.statement}\nThis is what the owner said matters for this app. It is not evidence and never approves anything.`,
      { preferenceId: row._id, appId: row.appId, kind: "owner_preference" },
    );
    const kept: boolean = await ctx.runMutation(internal.learning.preferences.storeSupermemoryId, { preferenceId, supermemoryId });
    if (!kept) await deleteDocuments(preferenceNamespace(row.appId), [supermemoryId]);
    return { indexed: kept, supermemoryId };
  },
});

export const unindex = internalAction({
  args: { appId: v.id("apps"), documentId: v.string() },
  handler: async (_ctx, { appId, documentId }) => {
    if (!process.env.SUPERMEMORY_API_KEY) return { deleted: false };
    await deleteDocuments(preferenceNamespace(appId), [documentId]);
    return { deleted: true };
  },
});

export type AppliedPreference = { id: Id<"ownerPreferences">; statement: string };

// The preferences that bear on a case: every Convex record for the app, those Supermemory ranks as relevant
// first. A Supermemory hit with no Convex record is ignored.
export async function applicablePreferences(
  ctx: ActionCtx,
  appId: Id<"apps">,
  query: string,
): Promise<{ preferences: AppliedPreference[]; summary: string }> {
  const rows: Doc<"ownerPreferences">[] = await ctx.runQuery(internal.learning.preferences.forApp, { appId });
  if (!rows.length) return { preferences: [], summary: "You have not told turtl what matters for this app yet." };
  let ranked: string[] = [];
  let how = "SUPERMEMORY_API_KEY is not set, so they were not ranked";
  if (process.env.SUPERMEMORY_API_KEY) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const hits = await Promise.race([
        searchWithMetadata(preferenceNamespace(appId), query, MAX_APPLICABLE),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), SEARCH_TIMEOUT_MS);
        }),
      ]);
      ranked = hits.flatMap((hit) => (typeof hit.metadata.preferenceId === "string" ? [hit.metadata.preferenceId] : []));
      how = ranked.length ? "ranked by Supermemory" : "Supermemory ranked none of them, so all are passed on";
    } catch {
      how = "Supermemory search failed, so they were not ranked";
    } finally {
      clearTimeout(timer);
    }
  }
  const order = (row: Doc<"ownerPreferences">) => {
    const at = ranked.indexOf(row._id);
    return at === -1 ? ranked.length : at;
  };
  const preferences = [...rows]
    .sort((a, b) => order(a) - order(b) || b._creationTime - a._creationTime)
    .slice(0, MAX_APPLICABLE)
    .map((row) => ({ id: row._id, statement: row.statement }));
  return {
    preferences,
    summary: `Weighed ${preferences.length} preference${preferences.length === 1 ? "" : "s"} of yours (${how}).`,
  };
}

export const decisionForNote = internalQuery({
  args: { decisionId: v.id("ownerDecisions") },
  handler: async (ctx, { decisionId }) => await ctx.db.get(decisionId),
});

// A decision note may state a preference. turtl only suggests it; the owner confirms it before it counts.
export const suggestFromNote = internalAction({
  args: { decisionId: v.id("ownerDecisions") },
  handler: async (ctx, { decisionId }): Promise<{ suggested: boolean; reason: string }> => {
    const decision: Doc<"ownerDecisions"> | null = await ctx.runQuery(internal.learning.preferences.decisionForNote, { decisionId });
    if (!decision?.note) return { suggested: false, reason: "The decision has no note." };
    const described =
      decision.outcome === "declined"
        ? `The owner declined turtl's proposal (recommended: ${decision.recommendedTitle ?? "none"}).`
        : decision.outcome === "chose_other"
          ? `The owner approved "${decision.chosenTitle}" instead of the recommended "${decision.recommendedTitle}".`
          : decision.outcome === "stopped"
            ? `The owner stopped "${decision.chosenTitle}" after approving it.`
            : `The owner approved "${decision.chosenTitle}".`;
    const extracted = await preferenceFromNote(ctx, decision.caseId, decision.note, described);
    const statement = extracted.ok ? extracted.preference : cleanStatement(decision.note);
    if (!statement) return { suggested: false, reason: "The note states no lasting preference." };
    const id: Id<"preferenceSuggestions"> | null = await ctx.runMutation(internal.learning.preferences.suggest, {
      appId: decision.appId,
      caseId: decision.caseId,
      statement,
      source: "decision_note",
      decisionId,
    });
    return {
      suggested: !!id,
      reason: extracted.ok ? "A model read the note." : `No model answered (${extracted.reason}), so the note itself is suggested as written.`,
    };
  },
});
