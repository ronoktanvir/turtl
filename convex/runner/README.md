# Runner

The runner moves a case through its steps on the Convex scheduler, with no client connected. It never writes `steps` or `stepAttempts` rows itself: every change goes through the helpers in `convex/workflow.ts`.

## Files

- `run.ts`: the runner. All of its functions are internal.
- `contract.ts`: the handler contract (`StepHandler`, `HandlerInput`, `HandlerResult`, `vHandlerResult`).
- `handlers/<purpose>.ts`: one handler per step purpose. For a case with a journey (the booking app), every handler except `learn` does real work (`examine_broader_causes` examines only when the case has related history; see `convex/structural/README.md`); a case with no journey, such as a dev live run, gets each handler's placeholder.
- `handlers/journey.ts`: helpers those handlers share.
- `handlers/index.ts`: the one place handlers are registered, keyed by purpose.

To replace a handler, edit its own file. Nothing else needs to change.

## How a run goes

1. `startCase` (or `startCaseRun` from inside another mutation) inserts the case with the eight-step template and schedules `advance`.
2. `advance` finds every step that is `pending`, or `failed` with attempts left, whose dependencies are `done` or `skipped`. For each it starts a new attempt, sets the case status for that stage, and schedules `execute` plus a `checkTimeout` at the handler's `timeoutMs`. The two job ids are kept on the attempt (`scheduledJobs`), and Stop, a verify step waiting on a device run, and an attempt waiting on a pull request cancel by those ids (`jobs.ts`). Nothing reads the whole `_scheduled_functions` table: every account's work adds to it, so such a read would eventually fail for everyone (`tests/bounded-reads.test.mjs`).
3. `execute` (an action) loads the input, calls the handler, and passes its result to `recordResult`. A handler that throws counts as a failure.
4. `recordResult` applies the result to the attempt and the step, then schedules `advance` again. When every step is `done` or `skipped`, the case is `resolved`, unless a handler already set it to `restored`, which it keeps.

An `approval` step (`authorize_and_execute`) is not handed to its handler on arrival. The runner parks it in `waiting` and the case in `waiting_for_owner`, and nothing after it runs until `approve` or `decline`:

- `approve` resumes the same attempt, sets the case to `executing`, and calls the handler with `approval.approvedAt` set.
- `decline` finishes the attempt with "Declined by the owner. Nothing was executed.", sets the case to `declined`, and skips every pending step, `verify` included.

A failed attempt is retried as a new attempt after a second, up to `MAX_ATTEMPTS` (3, in `convex/workflow.ts`). When the last one fails, the case is `unresolved`. A retry of the approval step asks the owner again, unless the owner already approved an action for the case: then it runs again without asking, and the handler reconciles before sending anything.

Case status by stage: `detect_or_receive` sets `open`; `gather_context` to `plan` set `investigating`; `authorize_and_execute` sets `waiting_for_owner`, then `executing` once approved; `verify` sets `verifying`; `learn` keeps the status it finds. A handler may also set `waiting_for_deploy` (with a `waiting` result) or `restored` (with a `done` result).

A case for an app that stops answering turtl's checks (`convex/protectedApp/notAnswering.ts`, signature `not_answering:<appId>`) never reaches the runner: it is made with one step, `wait_for_answer`, parked as `waiting` from the start and never dispatched, so it has no time limit, no retries and no model call, and `advance` finds nothing ready in it. Its status is `waiting_for_app`, which is open. The monitor closes it at the end of a round: `resolved` when any check gives a result again, `unresolved` when turtl stops checking the project, every check of a round is refused, or turtl can no longer tell (its checks get only replies it cannot read).

## The handler contract

```ts
type StepHandler = {
  timeoutMs: number;
  run: (ctx: ActionCtx, input: HandlerInput) => Promise<HandlerResult>;
};
```

`HandlerInput` holds:

- `case`, `step`, and `attempt`: the current rows.
- `parents`: each step this one depends on, with the exact attempt it consumes. That attempt is recorded on this attempt's `inputRefs` when it starts, so a later retry of a parent cannot change what this attempt read.
- `previousAttempts`: this step's earlier attempts, with their `externalRef`, so a retry can check what an earlier attempt already started before repeating it.
- `idempotencyKey`: stable across every attempt of the step. Pass it to any external service that accepts one.
- `approval`: `{ approvedAt }` for an approval step the owner approved, otherwise `null`.

`HandlerResult` is one of:

- `{ status: "done", summary, handoff?: { note, refs? }, output?, externalRef?, caseStatus?: "restored" }`. `handoff.note` is the short note for later steps and `refs` are its structured output references (`{ kind, id, label? }`); they are stored on the attempt as `handoff` and `outputRefs`.
- `{ status: "waiting", summary, externalRef?, caseStatus?: "waiting_for_deploy" }`: the step waits for an external callback. That callback calls `internal.runner.run.recordResult` with the attempt id and a final result.
- `{ status: "failed", error, summary?, externalRef? }`.

A summary says what actually happened. A placeholder says it is a placeholder.

## Late results and timeouts

A result for an attempt that is no longer the step's `currentAttemptId`, or that already finished, is written on that attempt with `lateResultAt` and never changes the step. `checkTimeout` fails an attempt that is still `running` or `waiting` when its handler's `timeoutMs` runs out; the error says its outcome is unknown, because external work it started may still have happened.

## Dev staging

`steps.staged` makes the runner fail (`fail: n`) or hold back past the time limit (`hang: n`) the first `n` attempts of a step, so retries, timeouts, and late results can be shown. Only `dev:startLiveRun` sets it, behind `DEV_TOOLS_ENABLED`, and every staged summary and error says "Staged".
