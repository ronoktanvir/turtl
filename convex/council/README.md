# The cross-model council

Several models read the same evidence independently, then a final step consolidates where they agree, where they disagree and what evidence is missing. Its output is an input to the proposal. It is never verification and never authorization, and every review carries the notice the owner reads: agreement between models is not proof.

## When it runs

From the investigate step only when the case is unfamiliar and the evidence ambiguous: no recovery memory matched, and the careful review's diagnosis still does not establish a cause (see `convex/routing/README.md`). It runs rarely:

- once per case;
- not again for the same failure (`failedStep:errorCode`) within 24 hours; the later case records a skipped review that says so;
- at most 4 times per app per day;
- within the app's cost limit (server default $0.50), estimated before any call from the input size and each member's maximum output at list price. Members that would pass the limit are not run;
- each member has 75 s and the consolidation 60 s; members run in parallel.

Every member call and the consolidation write an `agentRuns` row (`council_member`, `council_consolidate`). Members are shown to the consolidator as Reviewer A, B, C, without model names. If the consolidation call fails, the hypotheses are listed as given and labelled as not consolidated by a model.

## Members

`councilSettings` holds one app's members, consolidator and cost limit. With no row, the server default in `settings.ts` applies: `gpt-6.1-sol`, `gpt-5.5` and `gpt-6.1-terra` (three distinct OpenAI models), plus `claude-sonnet-4-5` and `gemini-2.5-pro`, which join as soon as `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` is set. Until then they are recorded as not run with that reason. The other labs' model ids have not been called from this deployment. Change the members with `internal.council.settings.set` (dashboard or CLI); `api.council.settings.forApp` reads them. The gear sheet has no model picker by contract.

## Entry point for other steps

```ts
await ctx.runAction(internal.council.run.examine, {
  caseId, stepId, stepAttemptId,
  purpose: "structural",
  question: "Do these failures share one structural cause?",
  failure, // optional; used for the once-a-day rule
  facts, evidence, // evidence: { id, kind, title, body? }[]
  context, // optional plain text, such as the hypothesis under test
});
```

From inside an action that already runs, call `examineWithCouncil(ctx, request)` from `run.ts` instead. It returns `{ status, reviewId, summary, costUsd }`; the review is in `councilReviews`, and `api.routing.view.forCase` returns the case's latest one.
