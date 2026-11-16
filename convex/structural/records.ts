import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import { CLOSED_CASE_STATUSES, type ProposalOption } from "../constants";
import { keyFor, MAX_FIXES, pullRequestEntry, pullRequestOption } from "../fixOptions";
import { latestProposal } from "../protectedApp/records";
import { loadSteps } from "../workflow";
import { CHECK_SCENARIOS, isScenario, scenarioUrl, shouldExamine, type HistoryCase, type KnownRecord, type ScenarioId } from "./rules";
import { vFindingChange, vFindingEvidence, vFindingTest } from "./schema";

export const HARNESS_VERSION = "turtl-structural-v1";
export const PROMPT_VERSION = "structural-prompt-v1";
const HISTORY_LIMIT = 50;
const RELATED_LIMIT = 8;
// What the structural step reads is bounded, however large the project grows (its cases come from the monitor and from
// customers' reports, so others can grow them). Past these, what is lost:
/** The project's newest cases read; the HISTORY_LIMIT before this one are taken from them. Only when more than 150
 * cases opened between this case and its examination does it see fewer than HISTORY_LIMIT earlier ones. */
const CASES_READ = 200;
/** The project's newest findings read: an older finding that already connects these cases is not seen, and the step
 * examines them again (one more model call) instead of skipping. */
const FINDINGS_READ = 200;
/** A case's first evidence rows read: the step offers the first 20 (or 8) that are not memory matches, so only a case
 * with more than 80 memory matches among its first 100 rows offers fewer. */
const EVIDENCE_READ = 100;
/** A case's newest verifications, first actions and recovery memories read: older ones of a case with more are not. */
const PER_CASE_READ = 50;
const CODE_NODE_LIMIT = 40;
const ATTACH_RETRY_MS = 5_000;
const ATTACH_TRIES = 60;

type Facts = Record<string, string | number | boolean>;

const factsOf = (steps: Awaited<ReturnType<typeof loadSteps>>): Facts =>
  (steps.find((s) => s.purpose === "gather_context")?.currentAttempt?.output?.facts as Facts | undefined) ?? {};

const failedStepOf = (facts: Facts) => (typeof facts["journey.failedStep"] === "string" ? facts["journey.failedStep"] : undefined);

async function historyRow(ctx: QueryCtx, row: Doc<"cases">): Promise<HistoryCase & { facts: Facts; steps: Awaited<ReturnType<typeof loadSteps>> }> {
  const steps = await loadSteps(ctx, row._id);
  const facts = factsOf(steps);
  const learned = await ctx.db
    .query("recoveryMemories")
    .withIndex("by_source_case", (q) => q.eq("sourceCaseId", row._id))
    .take(PER_CASE_READ);
  const verifications = await ctx.db
    .query("verifications")
    .withIndex("by_case", (q) => q.eq("caseId", row._id))
    .order("desc")
    .take(PER_CASE_READ);
  return {
    id: row._id,
    title: row.title,
    createdAt: row._creationTime,
    ...(row.signature && { signature: row.signature }),
    ...(failedStepOf(facts) && { failedStep: failedStepOf(facts) }),
    memoryIds: [...(row.matchedMemoryId ? [row.matchedMemoryId] : []), ...learned.map((m) => m._id)],
    verifiedRecovery: verifications.some((x) => x.phase !== "before" && x.actionId !== undefined && x.verdict === "passed"),
    isSample: !!row.isSample,
    facts,
    steps,
  };
}

const clip = (text: string | undefined, length: number) =>
  text === undefined ? undefined : text.length > length ? `${text.slice(0, length)}…` : text;

// Everything the structural step decides from: whether to examine at all, and when it does, the records
// the one model call reads. Every id the model may cite is in `known`.
export const examineContext = internalQuery({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    const row = await ctx.db.get(caseId);
    if (!row) throw new Error("Case not found.");
    const journey = row.journeyId ? await ctx.db.get(row.journeyId) : null;
    if (journey?.preventionFindingId) {
      return {
        skip: "Not examined: this case was opened by a prevention check from an earlier structural finding, which already names the likely deeper cause.",
        relatedCaseIds: [],
      };
    }
    const all = await ctx.db
      .query("cases")
      .withIndex("by_app", (q) => q.eq("appId", row.appId))
      .order("desc")
      .take(CASES_READ);
    const earlier = all
      .filter((c) => c._id !== caseId && c._creationTime < row._creationTime)
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, HISTORY_LIMIT);
    const current = await historyRow(ctx, row);
    const history = await Promise.all(earlier.map((c) => historyRow(ctx, c)));
    const trigger = shouldExamine(current, history);
    const relatedCaseIds = trigger.related.map((c) => c.id as Id<"cases">);
    if (!trigger.examine) return { skip: trigger.summary, relatedCaseIds };

    const findings = await ctx.db
      .query("structuralFindings")
      .withIndex("by_app", (q) => q.eq("appId", row.appId))
      .order("desc")
      .take(FINDINGS_READ);
    const covering = findings.find((f) => relatedCaseIds.every((id) => f.connectedCaseIds.includes(id)));
    if (covering) {
      const source = await ctx.db.get(covering.caseId);
      return {
        skip: `Not examined again: a structural finding from an earlier case (${source?.title ?? "a case"}) already connects these related cases, and there is no new related case since.`,
        relatedCaseIds,
        coveringFindingId: covering._id,
      };
    }

    const known: Record<string, KnownRecord> = {};
    const evidenceOf = async (id: Id<"cases">, limit: number) =>
      (await ctx.db.query("evidence").withIndex("by_case", (q) => q.eq("caseId", id)).take(EVIDENCE_READ))
        .filter((e) => e.kind !== "memory_match")
        .slice(0, limit)
        .map((e) => {
          known[e._id] = { kind: "evidence", label: e.title, caseId: id };
          return { id: e._id, kind: e.kind, title: e.title, ...(e.body && { body: clip(e.body, 500) }) };
        });
    const diagnosisOf = (steps: Awaited<ReturnType<typeof loadSteps>>) => {
      const step = steps.find((s) => s.purpose === "investigate");
      const diagnosis = step?.currentAttempt?.output?.diagnosis as { cause?: string; source?: string; confidence?: number } | undefined;
      if (diagnosis?.cause) return { cause: diagnosis.cause, source: diagnosis.source, confidence: diagnosis.confidence };
      return step?.status === "skipped" ? { skipped: step.skipReason ?? "skipped" } : null;
    };

    const caseLabel = (c: Doc<"cases">) =>
      `${c.title} (${c.status.replace(/_/g, " ")}, opened ${new Date(c._creationTime).toISOString().slice(0, 16).replace("T", " ")} UTC)`;
    known[row._id] = { kind: "case", label: caseLabel(row) };
    const currentRecords = {
      id: row._id,
      title: row.title,
      impact: row.impact,
      facts: current.facts,
      diagnosis: diagnosisOf(current.steps),
      evidence: await evidenceOf(caseId, 20),
    };

    const related = [];
    for (const item of trigger.related.slice(-RELATED_LIMIT)) {
      const id = item.id as Id<"cases">;
      const relatedRow = earlier.find((c) => c._id === id)!;
      known[id] = { kind: "case", label: caseLabel(relatedRow) };
      const actions = await ctx.db.query("actions").withIndex("by_case", (q) => q.eq("caseId", id)).take(PER_CASE_READ);
      const verifications = await ctx.db.query("verifications").withIndex("by_case", (q) => q.eq("caseId", id)).order("desc").take(PER_CASE_READ);
      const memories = (
        await Promise.all(item.memoryIds.map((memoryId) => ctx.db.get(memoryId as Id<"recoveryMemories">)))
      ).filter((m): m is Doc<"recoveryMemories"> => !!m);
      for (const a of actions) known[a._id] = { kind: "action", label: `${a.type} (${a.status})`, caseId: id };
      for (const x of verifications) known[x._id] = { kind: "verification", label: `${x.phase} check: ${x.verdict}`, caseId: id };
      for (const m of memories) known[m._id] = { kind: "recoveryMemory", label: `Recovery memory: ${clip(m.cause, 80)}`, caseId: m.sourceCaseId };
      related.push({
        id,
        title: relatedRow.title,
        status: relatedRow.status,
        openedAt: relatedRow._creationTime,
        sample: relatedRow.isSample ? "seeded sample case, not a real incident" : undefined,
        relatedBy: item.reasons,
        facts: item.facts,
        diagnosis: diagnosisOf(item.steps),
        evidence: await evidenceOf(id, 8),
        actions: actions.map((a) => ({ id: a._id, type: a.type, option: a.optionKey, requestedBy: a.requestedBy, status: a.status, result: clip(a.result, 300) })),
        verifications: verifications.map((x) => ({ id: x._id, phase: x.phase, verdict: x.verdict, summary: clip(x.summary, 300) })),
        recoveryMemories: memories.map((m) => ({ id: m._id, cause: m.cause, actionType: m.actionType, conditions: m.conditions, timesVerified: m.timesVerified })),
      });
    }

    const app = await ctx.db.get(row.appId);
    const network = await ctx.db
      .query("codeNetworks")
      .withIndex("by_project", (q) => q.eq("projectId", row.appId))
      .order("desc")
      .first();
    const words = new Set(
      [current, ...trigger.related]
        .flatMap((c) => [c.failedStep, ...Object.values(c.facts)])
        .filter((w): w is string => typeof w === "string")
        .flatMap((w) => w.toLowerCase().split(/[^a-z]+/))
        .filter((w) => w.length > 3 && !["none", "failed", "passed", "true", "false"].includes(w)),
    );
    const codeMap = network
      ? {
          source: network.source,
          repo: network.repo,
          clusters: network.clusters.map((c) => ({ id: c.id, name: c.name, summary: c.summary })),
          nodes: network.nodes
            .filter((n) => [...words].some((w) => `${n.id} ${n.label} ${n.summary}`.toLowerCase().includes(w)))
            .slice(0, CODE_NODE_LIMIT)
            .map((n) => {
              known[n.id] = { kind: "codeNode", label: n.path ?? n.label };
              return { id: n.id, label: n.label, path: n.path, summary: n.summary };
            }),
        }
      : null;

    const checkUrl = journey?.check.kind === "http" ? journey.check.config.url : null;
    const availableChecks: { id: ScenarioId; name: string; description: string }[] =
      checkUrl
        ? (Object.keys(CHECK_SCENARIOS) as ScenarioId[])
            .filter((id) => scenarioUrl(checkUrl, id))
            .map((id) => ({ id, ...CHECK_SCENARIOS[id] }))
        : [];

    return {
      skip: null,
      reason: trigger.reason,
      triggerSummary: trigger.summary,
      relatedCaseIds,
      seededCaseCount: trigger.related.filter((c) => c.isSample).length,
      known,
      prompt: {
        app: app?.name ?? "the app",
        current: currentRecords,
        relatedCases: related,
        availableChecks,
        codeMap,
      },
    };
  },
});

export const startRun = internalMutation({
  args: {
    caseId: v.id("cases"),
    stepId: v.id("steps"),
    stepAttemptId: v.id("stepAttempts"),
    modelId: v.string(),
    relatedCaseCount: v.number(),
    hasCodeMap: v.boolean(),
    reason: v.string(),
  },
  handler: async (ctx, { caseId, stepId, stepAttemptId, modelId, relatedCaseCount, hasCodeMap, reason }) => {
    const attempt = await ctx.db.get(stepAttemptId);
    if (!attempt || attempt.caseId !== caseId || attempt.stepId !== stepId) {
      throw new Error("The step attempt does not belong to this case.");
    }
    return await ctx.db.insert("agentRuns", {
      caseId,
      stepId,
      stepAttemptId,
      taskType: "examine_broader_causes",
      config: { modelId, harnessVersion: HARNESS_VERSION, promptVersion: PROMPT_VERSION, credentialRef: "OPENAI_API_KEY" },
      taskCharacteristics: {
        complexity: `${relatedCaseCount} related case${relatedCaseCount === 1 ? "" : "s"}`,
        risk: "a recommendation only; nothing runs without the owner's approval",
        framework: "Expo and Convex",
        repositoryArea: hasCodeMap ? "code map of the app" : "not inspected: no code map",
      },
      contextRefs: [],
      routingReason: `Fixed: one direct call, made only because ${reason}.`,
      status: "running",
      corrections: [],
    });
  },
});

export const finishRun = internalMutation({
  args: {
    agentRunId: v.id("agentRuns"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    durationMs: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { agentRunId, ...fields }) => {
    const run = await ctx.db.get(agentRunId);
    if (!run || run.status !== "running") throw new Error("This agent run is not running.");
    await ctx.db.patch(agentRunId, fields);
  },
});

// Stores a complete finding, offers its prevention check when the monitor can run it, and starts adding
// its change to the case's fixes once the plan step has proposed some.
export const recordFinding = internalMutation({
  args: {
    caseId: v.id("cases"),
    stepAttemptId: v.id("stepAttempts"),
    agentRunId: v.id("agentRuns"),
    hypothesis: v.string(),
    evidence: v.array(vFindingEvidence),
    change: vFindingChange,
    test: vFindingTest,
    confidence: v.number(),
    connectedCaseIds: v.array(v.id("cases")),
    seededCaseCount: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.caseId);
    const attempt = await ctx.db.get(args.stepAttemptId);
    if (!row || !attempt || attempt.caseId !== row._id) throw new Error("The step attempt does not belong to this case.");
    const journey = row.journeyId ? await ctx.db.get(row.journeyId) : null;
    const scenario = args.test.scenario;
    const url =
      isScenario(scenario) && journey?.check.kind === "http" ? scenarioUrl(journey.check.config.url, scenario) : null;
    const credentialRef = journey?.check.kind === "http" ? journey.check.config.credentialRef : undefined;
    const findingId = await ctx.db.insert("structuralFindings", {
      appId: row.appId,
      ...args,
      connectedCaseIds: [...new Set([row._id, ...args.connectedCaseIds])],
      ...(url &&
        isScenario(scenario) && {
          check: {
            scenario,
            name: CHECK_SCENARIOS[scenario].name,
            description: CHECK_SCENARIOS[scenario].description,
            url,
            ...(credentialRef && { credentialRef }),
            status: "offered" as const,
          },
        }),
      foundAt: Date.now(),
    });
    await ctx.scheduler.runAfter(ATTACH_RETRY_MS, internal.structural.records.attachFix, { findingId, tries: 0 });
    return findingId;
  },
});

const isClosed = (status: Doc<"cases">["status"]) => (CLOSED_CASE_STATUSES as readonly string[]).includes(status);

// Adds the finding's change to the case's fixes as the next proposal version, through the same pull request
// path as every code change. The plan step runs after this one, so it waits for the first proposal.
export const attachFix = internalMutation({
  args: { findingId: v.id("structuralFindings"), tries: v.number() },
  handler: async (ctx, { findingId, tries }) => {
    const finding = await ctx.db.get(findingId);
    if (!finding || finding.optionKey || finding.fixNote) return;
    const note = (fixNote: string) => ctx.db.patch(findingId, { fixNote });
    const row = await ctx.db.get(finding.caseId);
    if (!row) return;
    const proposal = await latestProposal(ctx, row._id);
    if (isClosed(row.status)) return await note("The case closed before turtl could add this change to its fixes.");
    if (proposal && proposal.decisionStatus !== "pending") {
      return await note("A fix was already chosen for this case, so this change was not added to its list. It stays here as a recommendation.");
    }
    if (!proposal || row.status !== "waiting_for_owner") {
      if (tries + 1 >= ATTACH_TRIES) return await note("The case had no fixes to choose from within five minutes, so this change was not added to its list.");
      await ctx.scheduler.runAfter(ATTACH_RETRY_MS, internal.structural.records.attachFix, { findingId, tries: tries + 1 });
      return;
    }
    const journey = row.journeyId ? await ctx.db.get(row.journeyId) : null;
    const catalog = await ctx.db
      .query("actionCatalog")
      .withIndex("by_app_and_type", (q) => q.eq("appId", row.appId))
      .collect();
    const entry = pullRequestEntry(catalog);
    if (!journey || !entry) {
      return await note("This app cannot ship code changes through turtl yet, so this change was not added to its fixes.");
    }
    let options = proposal.options;
    let replaced: ProposalOption | null = null;
    if (options.length >= MAX_FIXES) {
      replaced =
        options
          .filter((o) => !o.recommended && !o.proposedInChat && o.delivery === "pull_request")
          .sort((a, b) => a.confidence - b.confidence)[0] ?? null;
      if (!replaced) {
        return await note(`The list already has ${MAX_FIXES} fixes that turtl should not replace, so this change was not added to it.`);
      }
      options = options.filter((o) => o.key !== replaced!.key);
    }
    const lead = options.find((o) => o.recommended) ?? options[0];
    const caseEvidence = finding.evidence.filter((e) => e.ref.kind === "evidence");
    const evidenceIds = [
      ...new Set([
        ...(lead?.evidenceIds ?? []),
        ...(await Promise.all(caseEvidence.map((e) => ctx.db.get(e.ref.id as Id<"evidence">))))
          .filter((e): e is Doc<"evidence"> => !!e && e.caseId === row._id)
          .map((e) => e._id),
      ]),
    ];
    const option: ProposalOption = {
      ...pullRequestOption(
        entry,
        {
          title: finding.change.title,
          kind: finding.change.kind,
          why: finding.hypothesis,
          whatChanges: finding.change.whatChanges,
          whatMightBeLost: finding.change.whatMightBeLost,
          howChecked: `${finding.test.description} The deeper cause is ruled out if ${finding.test.disprovedIf.replace(/^if\s+/i, "").replace(/^./, (c) => c.toLowerCase())}`,
          change: `${finding.change.change}\n\nKeep the change to: ${finding.change.scope.join("; ")}.`,
          confidence: finding.confidence,
        },
        { journey, doneMeans: proposal.doneMeans, evidenceIds, usersCantNow: lead?.usersCantNow },
        keyFor(finding.change.title, options.map((o) => o.key)),
      ),
      why: [
        { text: `${finding.hypothesis} ` },
        { text: `turtl connected ${finding.connectedCaseIds.length} cases to reach this.` },
        ...finding.evidence
          .filter((e) => e.ref.kind === "evidence" && evidenceIds.includes(e.ref.id as Id<"evidence">))
          .map((e) => ({ text: ` ${e.says}`, cite: e.ref.id })),
      ],
    };
    const proposalId = await ctx.db.insert("proposals", {
      caseId: row._id,
      stepId: proposal.stepId,
      version: proposal.version + 1,
      decisionStatus: "pending",
      options: [...options, option],
      doneMeans: proposal.doneMeans,
    });
    await ctx.db.patch(findingId, {
      proposalId,
      optionKey: option.key,
      ...(replaced && {
        fixNote: `Added as a fix in place of "${replaced.title}" (${Math.round(replaced.confidence * 100)}% confidence), to keep the list at ${MAX_FIXES}.`,
      }),
    });
  },
});
