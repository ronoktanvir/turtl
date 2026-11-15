# Recovery memory

`internal.memory.records.write({ caseId })` is the atomic Convex write. It learns only the supported recovery: disabling `recommendationsEnabled` after a recommendations timeout. It requires the recorded distinguishing context facts, an approved frozen proposal, a completed action, and its latest passing `after_fix` verification for the same environment, revision, check version, current verification attempt, and required criteria. Declined, unresolved, incomplete, and unverified cases cannot write a memory.

`internal.memory.service.learn({ caseId })` wraps that write with best-effort Supermemory indexing. The runner's `learn` handler calls the same implementation and reports the actual result. Missing keys and indexing errors leave the Convex record intact and are named in the summary.

## Recall seam

From a Convex action, after obtaining a **fresh** journey check, flags, health, errors, and revision using the facts vocabulary in the phase-2 seams:

```ts
const recalled = await ctx.runAction(internal.memory.service.recall, {
  appId,
  signature,
  facts,
  symptoms,
});
const applicable = recalled.candidates.find((candidate) => candidate.applies);
```

The caller supplies fresh facts, not a memory's old facts. Recall does not fetch the protected app, skip a workflow step, create a proposal, execute an action, or grant permission. The incident-flow integration owns those decisions. Each candidate includes its Convex record, `applies`, and owner-readable `failedChecks`. Conditions require every comparison; matching or unknown not-when comparisons block use. Missing, incorrectly typed, unsupported facts, changed revisions, changed symptom signatures, invalidation, and disqualified source evidence fail closed. The staging switch is not a supported fact.

## Record identity and counts

Memories share a row only for the same app, symptom signature, cause checks (including revision), and exact frozen action payload. This prevents two different targets or causes from contaminating each other's counts. Counts are recomputed from stored action outcomes on a successful learn: `timesApplied` counts distinct completed applications; `timesVerified` counts the verified subset. Both deduplicate by the intended action's `idempotencyKey`, not verification rows or learn invocations. The case signature index bounds the scan to that app and symptom. These are caches, not event counters.

Supermemory text contains a `Convex recovery memory: <id>` reference. Search hits must resolve to a real record belonging to the app; orphaned, paraphrased/unlinkable, and foreign-app hits are ignored. Signature-index recall remains available without Supermemory. The shared `supermemory.ts` adapter currently returns only text from search and `void` from add, so it exposes no provider id to store. The service persists an id if the adapter later returns one. It retries indexing on later successful learns, so transient failures or adding a missing key are recoverable; the current adapter has no stable document-id input, so repeated indexing can create duplicate searchable descriptions. None of those descriptions grants authority.

## Local evidence

Only on an anonymous local Convex deployment, with no Supermemory key:

```sh
CONVEX_AGENT_MODE=anonymous npx convex dev
npx convex env set DEV_TOOLS_ENABLED true
npx convex run memory/dev:prove '{}'
npm run typecheck
```

`prove` creates explicitly staged fixtures through the workflow helpers, not direct step writes. It asserts verified insertion; a second case updating the same row; three checks and repeated learn counting once; separate applied/verified counts; no memory for declined, unresolved, unverified, wrong-revision, uncovered, or later-failing outcomes; matching facts; a same-signature `submit_booking` counterexample; missing/type-invalid/unsupported/not-when facts; explicit invalidation; later disqualification of source proof; Convex-backed and orphaned search hits; app isolation; the real learn handler; and the no-key summary. It refuses to run unless `DEV_TOOLS_ENABLED=true` and no Supermemory key is configured. It does not exercise a protected app, paid provider, or Revyl.
