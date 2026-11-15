# Recovery memory

`internal.memory.records.write({ caseId })` is the atomic Convex write. It learns the supported action of disabling `recommendationsEnabled` from a completed action, an approved frozen proposal, and its latest passing `after_fix` verification for the same environment, revision, check version, and current verification attempt. The journey's own criterion (`booking_journey_passes`) must be covered and passed. Other uncovered or missing criteria are snapshotted as `uncovered`, never passed: in particular, the device criterion stays in the proposal and memory without claiming a Revyl run. Declined, unresolved, incomplete, and unverified cases cannot write a memory.

`internal.memory.service.learn({ caseId })` wraps that write with best-effort Supermemory indexing. The runner's `learn` handler calls the same implementation and reports the actual result. Missing keys and indexing errors leave the Convex record intact and are named in the summary.

## Recall seam

`gather_context` obtains a **fresh** journey check, flags, health, errors, and revision using the facts vocabulary in the phase-2 seams, then calls:

```ts
const recalled = await ctx.runAction(internal.memory.service.recall, {
  appId,
  signature,
  facts,
  symptoms,
});
const applicable = recalled.candidates.find((candidate) => candidate.applies);
```

Recall itself proposes only. Each candidate is recorded as evidence, including owner-readable failed checks. The runner rechecks and commits `matchedMemoryId` plus the two investigation skips atomically when it accepts the current gather-context result. A timed-out or stale result cannot skip anything. `plan` offers the remembered catalog action directly, with its success count, last verification time, and current recheck. Owner approval and fresh verification remain mandatory. When no memory applies, both investigation steps run normally and a different-cause failure does not get the remembered action as its recommendation.

Conditions require every comparison; matching or unknown not-when comparisons block use. Missing, incorrectly typed, unsupported facts, changed revisions, changed symptom signatures, invalidation, and disqualified source evidence fail closed. Failed health reads are left out rather than represented as observed false facts. The staging switch is not a supported fact.

## Diagnosis-supported conditions

Both the model response and the labelled rule-based diagnosis name `supportingFactKeys`. Learning retains their observed scalar values as condition checks, plus the action's required enabled flag, healthy service, revision, and observed journey-failure guards. This permits diagnosis-selected observations without letting a sparse model answer erase safety preconditions. Unsupported or unobserved keys are discarded. The original recommendations-timeout builder is used only when the diagnosis supplies no usable supporting keys, and both the memory's `conditionSource` and the learn summary label that fallback. A recurrence retains the matched memory's checks and cause instead of requiring an investigation that was deliberately skipped.

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

`prove` creates explicitly staged fixtures through the workflow helpers, not direct step writes. It asserts verified insertion; a second case updating the same row; three checks and repeated learn counting once; separate applied/verified counts; no memory for declined, unresolved, unverified, wrong-revision, uncovered journey criterion, or later-failing outcomes; matching facts; a same-signature `submit_booking` counterexample; missing/type-invalid/unsupported/not-when facts; explicit invalidation; later disqualification of source proof; Convex-backed and orphaned search hits; app isolation; diagnosis-selected facts and required guards; late recall callbacks not committing skips; the real learn handler; and the no-key summary. It refuses to run unless `DEV_TOOLS_ENABLED=true` and no Supermemory key is configured. It does not exercise a protected app, paid provider, or Revyl.

For the real two-backend path, register the protected booking app, stage its provider outage, run `dev:checkNow`, approve its proposal, and wait for verify and learn. Clear the outage and check a pass before staging the same failure again. The recurrence should skip investigation, offer the earlier recovery, and increment the same memory from `1/1` to `2/2` after approval and verification. After another passing check, use `dev:stageStoreFailure` to stage `bookingStoreFailure`; its `submit_booking` / `BOOKING_STORE_UNAVAILABLE` facts must reject that memory and run full investigation. These dev controls are test instrumentation only, labelled as staged, and require `DEV_TOOLS_ENABLED`.
