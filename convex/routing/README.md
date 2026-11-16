# Routing, escalation and the performance log

The investigate step no longer uses one fixed configuration. For each case it chooses one of two configurations, hands an answer that does not establish a cause up to the stronger one, and logs every run so later choices move with recorded outcomes. This is routing that updates from outcomes, not models that learn.

## Files

- `configs.ts`: the one place configurations are defined (model, provider, reasoning level, instructions, the context each receives, time and output limits), the provider key table, list prices, `ROUTING_POLICY_VERSION` and the per-case diagnosis budget. It imports nothing.
- `models.ts`: the model client. A configuration names a provider and a model; `callModel` calls OpenAI, Anthropic or Google with the key from the deployment and returns JSON, token usage and an estimated cost. A missing key, a timeout or an HTTP failure is an infrastructure failure; an answer that arrived but cannot be used is not.
- `selector.ts`: the pure selector (`selectConfiguration`) and the check that a diagnosis establishes a cause (`unsupportedReasons`). Same inputs and log, same choice; `tests/routing-selector.test.mjs` proves it.
- `log.ts`: `agentRuns` writes (`startRun`, `finishRun`, `handUp`), the history the selector reads, outcome settling, and the owner's correction.
- `view.ts`: `api.routing.view.forCase`, the read the app's `useAgentWork` hook uses.
- `validators.ts`: the optional routing fields on `agentRuns`.

## Configurations

| Key | Label | Model | Context |
| --- | --- | --- | --- |
| `quick` | Quick look | `gpt-5.4-mini`, low reasoning (`DIAGNOSIS_MODEL` overrides the model) | facts, evidence bodies cut to 300 characters, up to three past case notes |
| `careful` | Careful review | `gpt-6.1-sol`, high reasoning | facts, full evidence, past case notes, look-alike memories that did not apply, and the quick look's handoff |

The quick look names a cause only when the observations show both what failed and why. The careful review must weigh at least two explanations and list the missing evidence.

## How a configuration is chosen

The selector reads these traits (computed in `convex/diagnosis.ts` `traitsFor`): the kind of case; whether the failure reproduced on the fresh check; the abnormal signals and the components they implicate; how many of the expected kinds of evidence could be read; whether recovery memory matched, or a look-alike was checked and rejected; whether the same failure was verified before; the consequence of the actions on offer; the time and money left; and the performance log.

1. **Consequence first, separately from difficulty.** A failure that touches auth, sessions, tokens, permissions, payments, deletion, migrations or secrets, or an app whose action catalog holds an irreversible action, always gets the careful review, however easy the failure looks. The log never downgrades it.
2. **Difficulty.** Each of these adds to a score: not reproducing (2), no fresh check (1), more than one component (1), more than two abnormal signals (1), missing evidence (1), a rejected look-alike memory (1), a failure never verified before (1). At 2 or more the case gets the careful review.
3. **The log.** Within the same bucket of traits (kind, area of the app, reproduction, breadth, familiarity, consequence), with at least 3 counted outcomes: if the quick look was verified in less than half, the case goes straight to the careful review; if it was verified in at least 80%, a case that only looked harder comes back to the quick look. Infrastructure failures are not counted. Buckets are recomputed from each run's stored traits, so changing the bucketing re-buckets old outcomes.
4. **Limits.** If the careful review does not fit the time left in the step or the case's remaining diagnosis budget ($0.50), the quick look runs and the reason says so.

`routingReason` states the real reason in plain words; `routingPolicyVersion` is `routing-v1`.

## Escalation

A diagnosis does not establish a cause when its confidence is below 60%, it cites no evidence, it does not account for the failed step or its error code, or it rests only on the failure's own symptoms (journey and error-count facts, the revision, a passing health check) with no other observation behind it. The quick look's answer is then handed up: a new `agentRuns` row runs the careful configuration with the quick look's reading and reasons as its `handoff`. Both rows link to each other (`routing.escalatedToRunId`, `routing.escalatedFromRunId`), the first is logged as `failed` with the reason, and an `agent_handoff` evidence row records it for the owner. A careful answer that is still unsupported is labelled "Unconfirmed cause" and may go to the council (`convex/council/README.md`).

## Outcomes

Each run's `outcome` is `verified`, `corrected`, `failed` or `infra_failure`. A model call that fails for infrastructure is `infra_failure` at once; a handed-up run is `failed`. Other runs settle when the case does: a passing verification after the fix makes them `verified`; a failed verification or an unresolved case makes them `failed`; a declined fix is recorded but not counted. The cron `settle agent run outcomes` (every 2 minutes) settles them, and `routing/log:settle` does one case. The owner's `api.routing.log.correct` (owner passcode) marks a run `corrected`. No screen calls it yet.

## Local proof

```sh
CONVEX_AGENT_MODE=anonymous npx convex dev
npx convex env set OPENAI_API_KEY ...   # and DEV_TOOLS_ENABLED, PROTECTED_APP_URL, the control secret and its hash
npx convex run dev:registerBooking '{}'
npx convex run dev:stageStoreFailure '{"on":true}' && npx convex run dev:checkNow '{}'
npx convex run routing/view:forCase '{"caseId":"<case>"}'
```
