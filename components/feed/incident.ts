import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import { timeAgo, type CardId } from "./cards";

// What the six cards say for a case that has a journey (a real incident). Content only: CardPage draws it.

export type CaseCards = NonNullable<FunctionReturnType<typeof api.cases.cards>>;

export type Tone = "default" | "muted" | "good" | "bad" | "warn";
export type ContentRow = { text: string; label?: string; tone?: Tone; testID?: string };
export type ContentSection = { heading: string; rows: ContentRow[] };
export type CardContent = ContentSection[];

type Facts = Record<string, string | number | boolean>;
type Diagnosis = {
  source: "model" | "rules";
  cause: string;
  confidence: number;
  supportingEvidenceIds: string[];
  modelId: string | null;
  noModelReason: string | null;
};

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const when = (ts: number, now: number) => `${timeAgo(ts, now)} (${clock(ts)})`;
const percent = (n: number) => `${Math.round(n * 100)}%`;

const ACTION_STATUS: Record<string, { text: string; tone: Tone }> = {
  pending: { text: "Approved, about to start", tone: "warn" },
  running: { text: "Running now", tone: "warn" },
  completed: { text: "Done", tone: "good" },
  failed: { text: "Failed: the change was not applied", tone: "bad" },
  cancelled: { text: "Cancelled", tone: "muted" },
  unknown: {
    text: "Outcome unknown: the change was sent but no answer came back, so it may or may not have been applied. turtl checks the app's current state before trying again.",
    tone: "warn",
  },
};

const CRITERION_STATUS: Record<string, { text: string; tone: Tone }> = {
  passed: { text: "Passed", tone: "good" },
  failed: { text: "Failed", tone: "bad" },
  uncovered: { text: "Not covered", tone: "muted" },
};

const VERDICT: Record<string, { text: string; tone: Tone }> = {
  passed: { text: "Passed", tone: "good" },
  failed: { text: "Failed", tone: "bad" },
  inconclusive: { text: "Inconclusive", tone: "warn" },
};

function revisionText(revision: { commitSha?: string; buildId?: string; deploymentId?: string }) {
  const parts = [];
  if (revision.commitSha) parts.push(`commit ${revision.commitSha.slice(0, 7)}`);
  if (revision.buildId) parts.push(`build ${revision.buildId}`);
  if (revision.deploymentId) parts.push(`at ${revision.deploymentId}`);
  return parts.join(", ");
}

export function incidentContent(data: CaseCards, now: number): Partial<Record<CardId, CardContent>> | null {
  if (!data.case.journeyId) return null;
  const step = (purpose: string) => data.steps.find((s) => s.purpose === purpose);
  const facts = (step("gather_context")?.currentAttempt?.output?.facts ?? null) as Facts | null;
  const diagnosis = (step("investigate")?.currentAttempt?.output?.diagnosis ?? null) as Diagnosis | null;
  const evidence = data.evidence ?? [];
  const titleOf = (id: string) => evidence.find((e) => e._id === id)?.title;
  const evidenceRows = (ids: readonly string[], prefix: string): ContentRow[] =>
    ids
      .map((id) => titleOf(id))
      .filter((t): t is string => !!t)
      .map((text, i) => ({ text, testID: `${prefix}-${i}` }));
  const proposal = data.proposal;
  const option = proposal?.options.find((o) => o.recommended) ?? proposal?.options[0] ?? null;
  const action = data.action;
  const verifications = data.verifications ?? [];
  const before = verifications.filter((v) => v.phase === "before").at(-1) ?? null;
  const afterFix = verifications.filter((v) => v.phase === "after_fix");
  const latestCheck = afterFix.at(-1) ?? null;
  const criteria = [...(action?.executionPayload.acceptanceCriteria ?? option?.acceptanceCriteria ?? []), ...(proposal?.doneMeans ?? [])];
  const describe = (id: string) => criteria.find((c) => c.id === id)?.description ?? id;
  const result: Partial<Record<CardId, CardContent>> = {};

  const failedBookings = facts?.["errors.failedBookings"];
  const totalBookings = facts?.["errors.totalBookings"];
  const errorRate = facts?.["errors.errorRate"];
  const failedStep = facts?.["journey.failedStep"];
  const errorCode = facts?.["journey.errorCode"];
  result["what-broke"] = [
    {
      heading: "The journey that failed",
      rows: [
        {
          text:
            data.journey && failedStep && failedStep !== "none"
              ? `${data.journey.name}: stops at the "${failedStep}" step${errorCode && errorCode !== "none" ? ` (${errorCode})` : ""}.`
              : data.journey
                ? `${data.journey.name}: ${before?.summary ?? "checking…"}`
                : "Unknown journey.",
          testID: "broke-journey",
        },
      ],
    },
    {
      heading: "Customers affected",
      rows: [
        {
          text:
            typeof failedBookings === "number" && typeof totalBookings === "number"
              ? `${failedBookings} of ${totalBookings} booking attempts failed in the last 15 minutes${typeof errorRate === "number" ? ` (${percent(errorRate)})` : ""}.`
              : "Failed-booking counts have not been read yet.",
          testID: "broke-counts",
        },
      ],
    },
    {
      heading: "Noticed",
      rows: [{ text: `By the ${data.case.raisedBy}, ${when(data.case._creationTime, now)}.`, tone: "muted" }],
    },
  ];

  result["what-we-found"] = diagnosis
    ? [
        { heading: "Likely cause", rows: [{ text: diagnosis.cause, testID: "found-cause" }] },
        {
          heading: "How sure",
          rows: [
            {
              text:
                diagnosis.source === "model"
                  ? `${percent(diagnosis.confidence)}, from the model ${diagnosis.modelId}.`
                  : `${percent(diagnosis.confidence)}. This is a rule-based reading of the facts, not a model's diagnosis: no model answered (${diagnosis.noModelReason ?? "no reason recorded"}).`,
              tone: diagnosis.source === "model" ? "default" : "warn",
              testID: "found-confidence",
            },
          ],
        },
        { heading: "Evidence", rows: evidenceRows(diagnosis.supportingEvidenceIds, "found-evidence") },
      ]
    : [{ heading: "Likely cause", rows: [{ text: "Not known yet: the investigation has not finished.", tone: "muted" }] }];

  if (option && proposal) {
    const sections: CardContent = [
      {
        heading: option.recommended ? "We recommend" : "The option we have (not recommended)",
        rows: [{ text: `${option.title} (confidence ${percent(option.confidence)}).`, testID: "action-title" }],
      },
      { heading: "What customers can't do now", rows: [{ text: option.usersCantNow ?? "Not recorded.", testID: "action-users-cant" }] },
      { heading: "What this changes", rows: [{ text: option.whatChanges, testID: "action-changes" }] },
      { heading: "What might be lost for a while", rows: [{ text: option.whatMightBeLost, testID: "action-lost" }] },
      { heading: "Evidence behind it", rows: evidenceRows(option.evidenceIds, "action-evidence") },
      { heading: "How we'll check it worked", rows: [{ text: option.howChecked, testID: "action-how-checked" }] },
      {
        heading: "Done means",
        rows: proposal.doneMeans.map((c, i) => ({ text: c.description, testID: `action-done-means-${i}` })),
      },
    ];
    const memory = data.matchedMemory;
    if (memory) {
      sections.push({
        heading: "This worked before",
        rows: [
          {
            text: `This recovery was applied ${memory.timesApplied} time${memory.timesApplied === 1 ? "" : "s"} and verified ${memory.timesVerified} time${memory.timesVerified === 1 ? "" : "s"}${memory.lastVerifiedAt ? `, last verified ${when(memory.lastVerifiedAt, now)}` : ""}. The current facts were checked against it before it was offered.`,
            tone: "good",
            testID: "action-worked-before",
          },
        ],
      });
    }
    if (data.permissionNotRun && proposal.decisionStatus === "pending") {
      sections.push({
        heading: "Why turtl did not run it on its own",
        rows: [{ text: data.permissionNotRun, tone: "warn", testID: "action-not-run" }],
      });
    }
    const run = data.runPermission;
    if (run && proposal.chosenBy?.kind === "auto") {
      sections.push({
        heading: "Ran under your permission",
        rows: [
          {
            text: `turtl ran this on its own under the permission you granted ${when(run.grantedAt, now)}. This was use ${run.use} of ${run.maxAttempts}. You were not asked this time.`,
            tone: "good",
            testID: "action-permission",
          },
        ],
      });
    } else if (proposal.decisionStatus !== "pending") {
      sections.push({
        heading: "Your decision",
        rows: [
          {
            text:
              proposal.decisionStatus === "approved"
                ? `You approved "${proposal.options.find((o) => o.key === proposal.chosenKey)?.title ?? proposal.chosenKey}"${proposal.decidedAt ? `, ${when(proposal.decidedAt, now)}` : ""}.`
                : `You declined${proposal.decidedAt ? `, ${when(proposal.decidedAt, now)}` : ""}. Nothing was changed.`,
            tone: proposal.decisionStatus === "approved" ? "good" : "muted",
            testID: "action-decision",
          },
        ],
      });
    }
    result["recommended-action"] = sections;
  } else {
    result["recommended-action"] = [
      { heading: "Recommendation", rows: [{ text: "Nothing to approve yet: the plan is not ready.", tone: "muted" }] },
    ];
  }

  if (action) {
    const status = ACTION_STATUS[action.status] ?? { text: action.status, tone: "default" as Tone };
    const times: ContentRow[] = [
      { label: action.requestedBy === "auto" ? "Started under your permission" : "Approved", text: when(action.requestedAt, now) },
    ];
    if (action.startedAt) times.push({ label: "Started", text: when(action.startedAt, now) });
    if (action.completedAt) times.push({ label: "Finished", text: when(action.completedAt, now) });
    const attempts = (data.executeAttempts ?? [])
      .filter((a) => a.attempt > 0)
      .sort((a, b) => a.attempt - b.attempt)
      .map((a) => ({
        label: `Attempt ${a.attempt}`,
        text: a.error ?? a.summary ?? a.status,
        tone: (a.status === "failed" ? "bad" : a.status === "done" ? "good" : "default") as Tone,
        testID: `wip-attempt-${a.attempt}`,
      }));
    result["work-in-progress"] = [
      { heading: "Status", rows: [{ text: status.text, tone: status.tone, testID: "wip-status" }] },
      ...(action.result ? [{ heading: "What happened", rows: [{ text: action.result, testID: "wip-result" }] }] : []),
      { heading: "When", rows: times },
      ...(attempts.length > 1 ? [{ heading: "Attempts", rows: attempts }] : []),
    ];
  } else {
    result["work-in-progress"] = [
      {
        heading: "Status",
        rows: [
          {
            text:
              proposal?.decisionStatus === "declined"
                ? "Nothing was run: you declined."
                : "Nothing runs until you approve.",
            tone: "muted",
            testID: "wip-status",
          },
        ],
      },
    ];
  }

  const proof: CardContent = [];
  if (latestCheck) {
    const verdict = VERDICT[latestCheck.verdict] ?? { text: latestCheck.verdict, tone: "default" as Tone };
    proof.push(
      {
        heading: "After the change",
        rows: [
          { text: verdict.text, tone: verdict.tone, testID: "proof-verdict" },
          { text: latestCheck.summary },
          ...(afterFix.length > 1
            ? [{ text: `Checked ${afterFix.length} times after the change; this is the latest.`, tone: "muted" as Tone }]
            : []),
        ],
      },
      {
        heading: "Each check",
        rows: latestCheck.criterionResults.map((r) => ({
          label: CRITERION_STATUS[r.status]?.text ?? r.status,
          text: `${describe(r.criterionId)} ${r.summary}`,
          tone: CRITERION_STATUS[r.status]?.tone ?? "default",
          testID: `proof-criterion-${r.criterionId}`,
        })),
      },
      {
        heading: "What exactly was tested",
        rows: [
          { label: "Environment", text: latestCheck.environment },
          { label: "Revision", text: revisionText(latestCheck.revision) },
          { label: "Check", text: `${latestCheck.checkVersion}, criteria ${latestCheck.criteriaVersion}` },
          { label: "When", text: when(latestCheck.completedAt, now) },
        ],
      },
    );
  } else {
    proof.push({
      heading: "After the change",
      rows: [{ text: "Not checked yet: nothing has been changed and verified.", tone: "muted", testID: "proof-verdict" }],
    });
  }
  if (before) {
    proof.push({ heading: "Before any change", rows: [{ text: before.summary, tone: before.verdict === "failed" ? "bad" : "default" }] });
  }
  result.proof = proof;

  const learned = data.learnedMemory;
  const learnStep = step("learn");
  result["what-we-learned"] = learned
    ? [
        { heading: "Saved for next time", rows: [{ text: learned.cause, testID: "learned-cause" }] },
        { heading: "When it applies", rows: learned.conditions.map((text) => ({ text })) },
        ...(learned.notWhen.length ? [{ heading: "When it does not", rows: learned.notWhen.map((text) => ({ text })) }] : []),
      ]
    : [
        {
          heading: "Saved for next time",
          rows: [
            {
              text:
                learnStep?.currentAttempt?.summary ??
                (learnStep?.status === "skipped"
                  ? `Nothing: ${learnStep.skipReason ?? "this step did not run."}`
                  : "Nothing yet: learning runs after the fix is checked."),
              tone: "muted",
              testID: "learned-summary",
            },
          ],
        },
      ];

  const offer = data.permissionOffer;
  if (offer && data.case.status === "restored") {
    const values = offer.parameters.map((p) => `${p.name} = ${JSON.stringify(p.value)}`).join(", ");
    const title = data.proposal?.options.find((o) => o.actionType === offer.actionType)?.title ?? offer.actionType;
    const what = `${title} (${values}${offer.target ? ` on ${offer.target.resourceRef}, ${offer.target.environment}` : ""})`;
    const ends = `It ends when the booking app's revision changes from ${offer.active?.grantedAtRevision ?? offer.appRevision ?? "the one checked"}, or when you revoke it.`;
    const sections: CardContent = [];
    if (offer.active) {
      sections.push({
        heading: "Your permission",
        rows: [
          { text: `turtl may run this recovery on its own: ${what}.`, testID: "permission-active" },
          { text: `Granted ${when(offer.active.grantedAt, now)}. Used ${offer.active.used} of ${offer.active.maxAttempts} times.` },
          { text: ends, tone: "muted" },
        ],
      });
    } else if (offer.timesVerified >= offer.minVerified && !offer.invalidated) {
      sections.push(
        {
          heading: "Let turtl handle this on its own next time?",
          rows: [
            {
              text: `This recovery has worked and been verified ${offer.timesVerified} times. You can let turtl run it without asking, only under these rules.`,
              testID: "permission-offer",
            },
            { label: "The one action", text: what },
          ],
        },
        ...(data.learnedMemory?._id === offer.memoryId
          ? [
              {
                heading: "Only when",
                rows: [{ text: 'Every check under "When it applies" holds on fresh observations, and none under "When it does not" does. An unknown fact counts as not holding.' }],
              },
            ]
          : [
              { heading: "Only when all of these hold", rows: offer.conditions.map((text) => ({ text })) },
              ...(offer.notWhen.length ? [{ heading: "Never when any of these hold", rows: offer.notWhen.map((text) => ({ text })) }] : []),
            ]),
        {
          heading: "Limits",
          rows: [
            { text: `At most ${offer.maxAttempts} times. Failed and unclear runs count too.` },
            { text: ends },
            { text: "Every run is still checked afterwards. If a run does not restore service, the permission ends and turtl asks you next time." },
          ],
        },
      );
    }
    if (offer.ended) {
      sections.push({
        heading: "Earlier permission",
        rows: [{ text: `Ended: ${offer.ended.endedReason ?? "it was revoked."}`, tone: "muted", testID: "permission-ended" }],
      });
    }
    result["what-we-learned"] = [...(result["what-we-learned"] ?? []), ...sections];
  }

  return result;
}
