# Structural causes and prevention checks

The `examine_broader_causes` step (brief 5.6), the structural recommendation it can produce (5.8), and the prevention check that can come with it (5.9). The runner calls `examineBroaderCauses` in `examine.ts` through `convex/runner/handlers/examine_broader_causes.ts`.

## When it runs

The step always runs, and calls a model only when the case has related history (`rules.ts`). An earlier case of the same app is related when it shares:

- the case's **signature** (for the monitor, the same journey),
- its **component**: the journey step that failed (`journey.failedStep` from gather_context), or
- a **recorded cause**: a recovery memory one case learned or matched and the other matched.

It examines with at least two related cases, or with one when the same component or cause comes back after a recovery that was verified (an after-action verification that passed). Otherwise it finishes with a summary such as "Not examined: no related cases." It also skips, with a summary that says why, when the case was opened by a prevention check from an earlier finding, or when an earlier finding already connects every related case. So it is called rarely.

A recovery memory match no longer skips this step (`convex/memory/flow.ts` now skips only `investigate`), because a recurrence after a verified recovery is exactly when a broader cause is worth asking about. The step itself decides whether to call the model.

## The examination

One JSON-mode chat completion (`STRUCTURAL_MODEL`, falling back to the diagnosis model) reads the current case's facts, diagnosis and evidence; each related case's facts, diagnosis, evidence, actions, verifications and recovery memories; and, when the app has one in `codeNetworks`, the clusters and the code nodes whose names match the failing steps. Every model call writes an `agentRuns` row with `taskType: "examine_broader_causes"`.

The step never fails the case. It has a 45 s model timeout inside a 90 s step timeout, and every outcome is a `done` result whose summary says what happened: not examined (and why), no model answered, no structural cause found, an incomplete reply, or a finding. Planning, approval and verification go on as before; nothing here shortens or skips verification.

## The four-part rule

`readFinding` accepts a reply only when it has all four parts:

1. a concrete hypothesis;
2. evidence that names real records by id (cases, evidence, verifications, recovery memories, actions, code nodes), at least two of them, from at least two cases;
3. a bounded change: a repair or prevention, at most three named areas, instructions under 1,500 characters;
4. a test that could disprove it (what to run, and which outcome rules the hypothesis out).

A reply missing a part is kept on the step attempt's output as a note (`output.incomplete`) and is never offered to the owner. Complete findings are stored in `structuralFindings` (`schema.ts`) with the cases they connect and a confidence.

## Where the owner sees it

- **Fixes:** `attachFix` adds the change as the next proposal version through the same pull request option every code change uses (`pullRequestOption` in `convex/fixOptions.ts`), once the plan step has proposed and the case waits on the owner. It is never the recommended fix. When the list already holds four, it replaces the least confident code change that is neither recommended nor from the chat, and records that on the finding. When the owner already decided, or the case closed, the finding records why it was not added.
- **Overview and project:** `queries.forCase` and `queries.forProject` feed the finding card on the case's Overview and the "turtl found a deeper cause" row on Project home. Findings stay on the project after their case closes.

## Prevention checks

A finding offers a check when its test names a scenario the monitor can run (`CHECK_SCENARIOS` in `rules.ts`): a variant of an HTTP journey check, run by the protected app with one dependency degraded for that run only. Today there is one, `slow_recommendations`: `POST <journey-check>?scenario=slow_recommendations`.

`checks.approve` is the owner's approval (owner passcode, asks once: a second approval is refused). turtl then runs the check once (`checks.runOnce`). Only when that run returns a verdict for that very scenario (the app echoes `scenario`) does `checks.settle` register it as a `journeys` row with `preventionFindingId` set. The cron monitor then runs it like any journey; a failure opens a case titled "A prevention check failed: …", and that case's own examine step does not examine again.

The booking demo must support the scenario for this to register: `convex/bookingDemo/checks.ts` accepts `scenario` and echoes it, and `convex/http.ts` passes the query parameter through. Without that, the fresh run is refused with "Not registered: the app answered without running this scenario".

## Deploy and dev notes

- New optional environment variable: `STRUCTURAL_MODEL` (defaults to `DIAGNOSIS_MODEL`, then `gpt-5.4-mini`). It uses `OPENAI_API_KEY`.
- `structural/dev:clear({ appId })` (behind `DEV_TOOLS_ENABLED`) removes an app's findings and their prevention checks. Run it before `dev:resetBooking`: the reset turns recommendations back on and needs every journey to pass, and the slow-recommendations check fails by design while booking still waits on recommendations.
