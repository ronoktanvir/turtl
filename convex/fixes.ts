import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { vOptionKind, type ProposalOption } from "./constants";
import {
  askJson,
  FIX_FIELDS,
  keyFor,
  MAX_FIXES,
  orderFixes,
  pullRequestEntry,
  pullRequestOption,
  readDraft,
  toFixOption,
  type FixOption,
} from "./fixOptions";
import { CRITERIA, DONE_MEANS, ENVIRONMENT } from "./protectedApp/client";
import { latestAction, latestProposal } from "./protectedApp/records";
import { registerBookingApp } from "./protectedApp/registry";
import type { Facts } from "./runner/handlers/journey";
import { createCaseFromTemplate, finishAttempt, loadSteps, setCaseStatus, startAttempt, waitOnAttempt } from "./workflow";

declare const process: { env: Record<string, string | undefined> };

// The Fixes screen and its "Investigate further" chat (ui-contract.md sections 2 and 6).

const MAX_MESSAGE_LENGTH = 2000;
const HISTORY_LENGTH = 20;

// The contract's ChatMessage.
export type ChatMessage = {
  id: string;
  role: "owner" | "turtl";
  text: string;
  at: number;
  proposedFix?: FixOption;
};

async function toChatMessage(ctx: QueryCtx, row: Doc<"fixChatMessages">): Promise<ChatMessage> {
  const proposal = row.proposalId ? await ctx.db.get(row.proposalId) : null;
  const option = proposal?.options.find((o) => o.key === row.optionKey);
  return {
    id: row._id,
    role: row.role,
    text: row.text,
    at: row.at,
    ...(option && { proposedFix: toFixOption(option) }),
  };
}

// A case's fixes from its latest proposal, recommended first, and which one was chosen. Null when the
// id is not a case; fixes is empty until the plan step has proposed something.
export const forCase = query({
  args: { caseId: v.string() },
  handler: async (ctx, args) => {
    const caseId = ctx.db.normalizeId("cases", args.caseId);
    if (!caseId || !(await ctx.db.get(caseId))) return null;
    const proposal = await latestProposal(ctx, caseId);
    return {
      proposalId: proposal?._id ?? null,
      version: proposal?.version ?? null,
      decisionStatus: proposal?.decisionStatus ?? null,
      chosenKey: proposal?.chosenKey ?? null,
      fixes: proposal ? orderFixes(proposal.options).map(toFixOption) : [],
    };
  },
});

// The Investigate further conversation for one case, oldest first. Null when the id is not a case.
export const messages = query({
  args: { caseId: v.string() },
  handler: async (ctx, args): Promise<ChatMessage[] | null> => {
    const caseId = ctx.db.normalizeId("cases", args.caseId);
    if (!caseId || !(await ctx.db.get(caseId))) return null;
    const rows = await ctx.db
      .query("fixChatMessages")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .collect();
    return await Promise.all(rows.map((row) => toChatMessage(ctx, row)));
  },
});

export const chatContext = internalQuery({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    const row = await ctx.db.get(caseId);
    if (!row) return null;
    const steps = await loadSteps(ctx, caseId);
    const output = (purpose: string) => steps.find((s) => s.purpose === purpose)?.currentAttempt?.output;
    const catalog = await ctx.db
      .query("actionCatalog")
      .withIndex("by_app_and_type", (q) => q.eq("appId", row.appId))
      .collect();
    const history = await ctx.db
      .query("fixChatMessages")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .order("desc")
      .take(HISTORY_LENGTH);
    const action = await latestAction(ctx, caseId);
    const verifications = await ctx.db
      .query("verifications")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .order("desc")
      .take(HISTORY_LENGTH);
    return {
      case: row,
      appName: (await ctx.db.get(row.appId))?.name ?? "the app",
      hasJourney: !!row.journeyId,
      hasPullRequestAction: !!pullRequestEntry(catalog),
      facts: (output("gather_context")?.facts as Facts | undefined) ?? null,
      cause: (output("investigate")?.diagnosis?.cause as string | undefined) ?? null,
      latestAction: action ? {
        id: action._id,
        type: action.type,
        status: action.status,
        result: action.result ?? null,
        completedAt: action.completedAt ?? null,
        cancelledBy: action.cancelledBy ?? null,
      } : null,
      verifications: verifications.map((verification) => ({
        phase: verification.phase,
        actionId: verification.actionId ?? null,
        verdict: verification.verdict,
        summary: verification.summary,
        completedAt: verification.completedAt,
        criteria: verification.criterionResults.map(({ criterionId, status, summary }) => ({ criterionId, status, summary })),
      })),
      proposal: await latestProposal(ctx, caseId),
      history: history.reverse().map((m) => ({ role: m.role, text: m.text })),
    };
  },
});

export const addMessage = internalMutation({
  args: {
    caseId: v.id("cases"),
    role: v.union(v.literal("owner"), v.literal("turtl")),
    text: v.string(),
    proposalId: v.optional(v.id("proposals")),
    optionKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ChatMessage> => {
    const id = await ctx.db.insert("fixChatMessages", { ...args, at: Date.now() });
    return await toChatMessage(ctx, (await ctx.db.get(id))!);
  },
});

const vDraft = v.object({
  title: v.string(),
  kind: vOptionKind,
  why: v.string(),
  whatChanges: v.string(),
  whatMightBeLost: v.string(),
  howChecked: v.string(),
  change: v.string(),
  confidence: v.number(),
});

// Adds a fix proposed in the chat as the next proposal version: the same options with this one appended,
// still pending, so it needs the owner's approval like any other. Refused when the list changed meanwhile.
export const appendChatFix = internalMutation({
  args: { caseId: v.id("cases"), proposalId: v.id("proposals"), draft: vDraft },
  handler: async (
    ctx,
    { caseId, proposalId, draft },
  ): Promise<{ ok: true; proposalId: Id<"proposals">; optionKey: string } | { ok: false; reason: string }> => {
    const row = await ctx.db.get(caseId);
    const latest = await latestProposal(ctx, caseId);
    if (!row || !latest || latest._id !== proposalId) {
      return { ok: false, reason: "The list of fixes changed while turtl was answering, so this fix was not added." };
    }
    if (latest.decisionStatus !== "pending" || row.status !== "waiting_for_owner") {
      return { ok: false, reason: "A decision on this case was already made, so this fix was not added." };
    }
    if (latest.options.length >= MAX_FIXES) {
      return { ok: false, reason: `The list already has ${MAX_FIXES} fixes, so this one was not added.` };
    }
    const journey = row.journeyId ? await ctx.db.get(row.journeyId) : null;
    const catalog = await ctx.db
      .query("actionCatalog")
      .withIndex("by_app_and_type", (q) => q.eq("appId", row.appId))
      .collect();
    const entry = pullRequestEntry(catalog);
    if (!journey || !entry) {
      return { ok: false, reason: "This app cannot ship code changes through turtl yet, so the fix was not added." };
    }
    const lead = latest.options.find((o) => o.recommended) ?? latest.options[0];
    const option: ProposalOption = {
      ...pullRequestOption(
        entry,
        draft,
        {
          journey,
          doneMeans: latest.doneMeans,
          evidenceIds: lead?.evidenceIds ?? [],
          usersCantNow: lead?.usersCantNow,
        },
        keyFor(draft.title, latest.options.map((o) => o.key)),
      ),
      proposedInChat: true,
    };
    const nextId = await ctx.db.insert("proposals", {
      caseId,
      stepId: latest.stepId,
      version: latest.version + 1,
      decisionStatus: "pending",
      options: [...latest.options, option],
      doneMeans: latest.doneMeans,
    });
    return { ok: true, proposalId: nextId, optionKey: option.key };
  },
});

const CHAT_PROMPT = [
  "You are turtl, talking with the owner of an app about one case on its Investigate further screen. The owner is not an engineer.",
  "Answer the owner's current message using only the supplied case, historical findings, latest action, phase-labelled verifications and fixes. If you do not know, say so. This chat does not execute a fix; a recorded completed action can show what already ran.",
  "The gathered facts, diagnosis and before-phase checks describe the incident before an action; they are history, not proof that the app is still broken. Use case.status for the recorded present state and the latest after_fix or after_deploy verification for latestAction.id, by completedAt, to explain the outcome. Never treat an uncovered criterion as passed or a before-phase failure as a failure after recovery.",
  "For a restored or resolved case with a passing after-action check, say service was restored and explain what restored it from latestAction.result. Do not say it is still broken or awaiting the same completed fix. Distinguish temporary recovery from a permanent repair, and do not claim a device check passed if it was uncovered.",
  "For a declined proposal or owner-cancelled action, explain that it was declined or stopped and no live change was applied, unless the recorded completed action or after-action verification shows otherwise. Stopping does not undo an earlier applied change. For waiting_for_owner, explain that the case is waiting for the owner's decision; do not claim a pending fix ran. Unknown, running or failed actions are not confirmed recoveries.",
  'Reply with a JSON object: {"reply": string, "fix": object | null}. reply: at most four plain sentences.',
  `Set fix only to propose a new fix that differs in substance from every current fix; never restate a current fix in other words. If no different sensible fix exists, set fix to null and say so. A new fix is a code change that ships as a pull request. ${FIX_FIELDS}`,
].join("\n");

// Investigate further: answers the owner's message about a case, and may add a new fix to the list as a
// new proposal version with proposedInChat set. newFix is the "New fix" button: it asks for another option.
export const investigate = action({
  args: { caseId: v.id("cases"), message: v.string(), newFix: v.optional(v.boolean()) },
  handler: async (ctx, { caseId, message, newFix }): Promise<ChatMessage> => {
    const asked = message.trim() || (newFix ? "New fix" : "");
    if (!asked) throw new Error("The message is empty.");
    if (asked.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`The message is too long: ${asked.length} characters, the limit is ${MAX_MESSAGE_LENGTH}.`);
    }
    const context = await ctx.runQuery(internal.fixes.chatContext, { caseId });
    if (!context) throw new Error("Case not found.");
    await ctx.runMutation(internal.fixes.addMessage, { caseId, role: "owner", text: asked });

    const { proposal } = context;
    const blocked = !context.hasJourney || !context.hasPullRequestAction
      ? "this app cannot ship code changes through turtl yet"
      : !proposal || proposal.decisionStatus !== "pending" || context.case.status !== "waiting_for_owner"
        ? "the case is not waiting on the owner to choose a fix"
        : proposal.options.length >= MAX_FIXES
          ? `the list already has ${MAX_FIXES} fixes`
          : null;
    const answer = await askJson(
      blocked ? `${CHAT_PROMPT}\nYou cannot add a fix now (${blocked}): set fix to null and say so if the owner asks for one.` : CHAT_PROMPT,
      {
        app: context.appName,
        case: { title: context.case.title, impact: context.case.impact, status: context.case.status },
        historicalFindings: { facts: context.facts, diagnosis: context.cause },
        latestAction: context.latestAction,
        verifications: context.verifications,
        decision: proposal ? { status: proposal.decisionStatus, chosenKey: proposal.chosenKey ?? null } : null,
        currentFixes: (proposal?.options ?? []).map((o) => ({
          title: o.title,
          kind: o.kind,
          recommended: o.recommended,
          why: (o.why ?? []).map((s) => s.text).join(""),
          whatChanges: o.whatChanges,
          whatMightBeLost: o.whatMightBeLost,
        })),
        conversation: context.history,
        message: asked,
        ...(newFix && {
          request: "The owner tapped New fix: propose one more fix that differs from the current ones, or say plainly why there is no other sensible one.",
        }),
      },
    );

    let reply = answer.ok
      ? typeof answer.json.reply === "string" && answer.json.reply.trim()
        ? answer.json.reply.trim()
        : "turtl had no answer to that."
      : `turtl can't answer right now: ${answer.reason}.`;
    let added: { proposalId: Id<"proposals">; optionKey: string } | null = null;
    if (answer.ok && blocked && (newFix || answer.json.fix)) {
      reply = `${reply} No fix was added: ${blocked}.`;
    } else if (answer.ok && answer.json.fix && proposal) {
      const draft = readDraft(answer.json.fix);
      if (!draft) reply = `${reply} The fix turtl described was incomplete, so it was not added to the list.`;
      else {
        const result = await ctx.runMutation(internal.fixes.appendChatFix, { caseId, proposalId: proposal._id, draft });
        if (result.ok) added = { proposalId: result.proposalId, optionKey: result.optionKey };
        else reply = `${reply} ${result.reason}`;
      }
    }
    return await ctx.runMutation(internal.fixes.addMessage, {
      caseId,
      role: "turtl",
      text: reply,
      ...(added ?? {}),
    });
  },
});

// Dev tools: a booking outage case waiting on the owner with three fixes (the contract's example story),
// so the Fixes screen can be shown without a model. Its facts are staged, not read from the booking app.
// Approving its recovery runs the real flag change on the booking demo; a code-change fix needs the
// pull request executor. Needs DEV_TOOLS_ENABLED=true and PROTECTED_APP_URL.
export const devThreeFixCase = mutation({
  args: {},
  handler: async (ctx): Promise<Id<"cases">> => {
    if (process.env.DEV_TOOLS_ENABLED !== "true") throw new Error("Dev tools are disabled on this deployment.");
    const { appId, journeyId, actionCatalogId } = await registerBookingApp(ctx);
    const journey = (await ctx.db.get(journeyId))!;
    const flagEntry = (await ctx.db.get(actionCatalogId))!;
    if (flagEntry.config.kind !== "http") throw new Error("The booking app's flag action is not an http action.");
    const prEntry = await ensurePullRequestEntry(ctx, appId);

    const caseId = await createCaseFromTemplate(ctx, {
      appId,
      kind: "outage",
      title: "Customers can't complete bookings",
      impact: "Nobody can book an appointment right now: booking waits on the recommendations provider, which is timing out.",
      raisedBy: "owner",
      raisedByRef: "dev tools: three-fix demo",
    });
    await ctx.db.patch(caseId, { journeyId });
    const facts: Facts = {
      "journey.verdict": "failed",
      "journey.failedStep": "recommendations",
      "journey.errorCode": "RECOMMENDATIONS_TIMEOUT",
      "flags.recommendationsEnabled": true,
      "health.ok": true,
      "errors.failedBookings": 7,
      "errors.totalBookings": 9,
    };
    const cause =
      "Booking waits for service recommendations while they are turned on, and the recommendations provider is timing out, so bookings never get saved.";
    const usersCantNow = "Customers can't finish a booking: 7 of 9 booking attempts in the last 15 minutes failed.";
    const basis = { journey, doneMeans: DONE_MEANS, evidenceIds: [], usersCantNow };
    const staged = "Dev fixture: staged for the three-fix demo, not observed from the booking app.";

    for (const step of await loadSteps(ctx, caseId)) {
      if (step.purpose === "authorize_and_execute") {
        const attemptId = await startAttempt(ctx, step._id);
        await waitOnAttempt(ctx, attemptId, { summary: "Waiting for the owner to approve or decline." });
        await setCaseStatus(ctx, caseId, "waiting_for_owner");
        break;
      }
      const attemptId = await startAttempt(ctx, step._id);
      let output: unknown;
      if (step.purpose === "gather_context") output = { facts };
      if (step.purpose === "investigate") {
        output = { diagnosis: { source: "rules", cause, confidence: 0.5, supportingEvidenceIds: [], supportingFactKeys: Object.keys(facts) } };
      }
      if (step.purpose === "plan") {
        const recovery: ProposalOption = {
          key: "turn_off_recommendations",
          title: "Turn off recommendations",
          kind: "recovery",
          actionType: flagEntry.type,
          actionCatalogId: flagEntry._id,
          target: { environment: ENVIRONMENT, resourceRef: `${flagEntry.config.url}#recommendationsEnabled` },
          parameters: [
            { name: "flag", value: "recommendationsEnabled" },
            { name: "value", value: false },
          ],
          acceptanceCriteria: [CRITERIA.recommendationsOff, ...DONE_MEANS],
          checkRefs: [{ journeyId, version: journey.checkVersion }],
          usersCantNow,
          whatChanges: "Turns off service suggestions in the booking app, so booking stops waiting for the recommendations provider.",
          whatMightBeLost:
            "Customers won't see suggested services until recommendations are turned back on. Bookings already made don't change, and the slow provider itself is not fixed.",
          howChecked:
            "turtl checks that recommendations read as off, then runs the booking check: a test booking must be saved and match its confirmation.",
          evidenceIds: [],
          recommended: true,
          confidence: 0.8,
          why: [
            { text: "Every failed booking stops at the recommendations step with RECOMMENDATIONS_TIMEOUT. " },
            { text: "With recommendations off, booking no longer waits for the slow provider, so it can save again within a minute." },
          ],
          delivery: "action",
        };
        const repair = pullRequestOption(
          prEntry,
          {
            title: "Load recommendations without blocking booking",
            kind: "repair",
            why: "Booking only fails because it waits for recommendations before it saves. Loading them alongside, with a short time limit, lets the booking save even when the provider is slow, and suggestions still show when it is fast.",
            whatChanges: "Booking stops waiting for recommendations: they load alongside, and booking goes ahead without them when the provider is slow.",
            whatMightBeLost: "When the provider is slow, customers book without seeing suggestions. It needs a review and a merge before it helps anyone.",
            howChecked: "turtl runs the booking check while the provider is still slow; a test booking must be saved.",
            change:
              "In the booking demo backend (convex/bookingDemo), stop the booking flow from waiting on the recommendations provider before saving: fetch recommendations with a short timeout and treat a timeout as no suggestions, so the booking is saved and confirmed either way.",
            confidence: 0.7,
          },
          basis,
          "load_recommendations_without_blocking",
        );
        const prevention = pullRequestOption(
          prEntry,
          {
            title: "Check the booking journey when the provider is slow",
            kind: "prevention",
            why: "The booking check only ran with a healthy provider, so this failure reached customers first. A check that runs with the provider slowed down would have caught it before release.",
            whatChanges: "Adds a booking check that runs with the recommendations provider slowed down.",
            whatMightBeLost: "Nothing for customers, but it does not fix today's outage, and every check run takes a little longer.",
            howChecked: "turtl runs the new check against the booking app: it should fail until booking stops waiting on the provider, then pass.",
            change:
              "Add a booking journey check in convex/bookingDemo that simulates a slow recommendations provider and asserts a booking is still saved and matches its confirmation.",
            confidence: 0.6,
          },
          basis,
          "check_booking_when_provider_slow",
        );
        const proposalId = await ctx.db.insert("proposals", {
          caseId,
          stepId: step._id,
          version: 1,
          decisionStatus: "pending",
          options: [recovery, repair, prevention],
          doneMeans: DONE_MEANS,
        });
        output = { proposalId, matchedMemoryId: null };
      }
      await finishAttempt(ctx, attemptId, { status: "done", summary: staged, output });
    }
    return caseId;
  },
});

// The pull request entry TURA-13 registers for the booking app, with the same shape, when it is not there yet.
async function ensurePullRequestEntry(ctx: MutationCtx, appId: Id<"apps">) {
  const catalog = await ctx.db
    .query("actionCatalog")
    .withIndex("by_app_and_type", (q) => q.eq("appId", appId))
    .collect();
  const existing = pullRequestEntry(catalog);
  if (existing) return existing;
  const id = await ctx.db.insert("actionCatalog", {
    appId,
    type: "open_pull_request",
    name: "Open a pull request",
    description: "Asks Capy to write the change on a branch and open a pull request. Nothing reaches customers until the owner merges it.",
    reversible: true,
    config: { kind: "capy", repoUrl: "https://github.com/ronoktanvir/turtl", baseBranch: "main" },
    parameterConstraints: [
      { name: "title", type: "string", required: true },
      { name: "change", type: "string", required: true },
    ],
  });
  return (await ctx.db.get(id))!;
}
