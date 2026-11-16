# Data model and workflow rules

All tables are defined in [`convex/schema.ts`](../convex/schema.ts), which also spreads in the tables of `convex/intake/`, `convex/revyl/`, `convex/voice/` and `convex/codeNetwork/`. The stage list, statuses, kinds, validators, and types are defined once in [`convex/constants.ts`](../convex/constants.ts), which both the Convex functions and the app import. Do not redefine them elsewhere.

`convex/_generated/` is committed; regenerate it with `npx convex dev` when you change the schema or functions.

## Cases and their steps

- `apps`: `name`, optional `repoUrl`, `productionUrl`, `revision`, `ownerId` (an opaque owner reference until sign-in exists; nothing enforces it yet), `isSample`.
- `cases`: `appId`, optional `journeyId` and `matchedMemoryId`, `title`, `impact` (plain language), `kind` (`outage`, `bug_report`, `feature_request`), `raisedBy` (`monitor`, `owner`, `customer`) with optional `raisedByRef` naming the actual user, service, or customer, `status`, optional `signature`, `reportCount`, `distinctRequesterCount`, `resolvedAt`, `isSample`. Statuses: `open`, `investigating`, `waiting_for_owner`, `executing`, `waiting_for_deploy`, `verifying`, `restored`, `resolved`, `unresolved`, `declined`. `restored` means service is back; `resolved` means the permanent repair is finished.
- `steps`: the stable, logical steps of a case's workflow. `caseId`, `key` (unique within the case), `title`, `dependsOn` (keys of steps in the same case), `kind` (`function`, `agent`, `approval`), `purpose` (a stage id), `status` (`pending`, `running`, `waiting`, `done`, `failed`, `skipped`), optional `skipReason`, `currentAttemptId` and `staged` (dev staging, see the [runner README](../convex/runner/README.md#dev-staging)). A new case gets an initial template of eight steps, one per stage, in a chain.
- `stepAttempts`: one row per execution of a step. `stepId`, `caseId`, `attempt` (from 1), `status` (`running`, `waiting`, `done`, `failed`), optional `startedAt`, `finishedAt`, `summary`, `handoff`, `error`, `externalRef`, `inputRefs` (the parent attempts it consumed), `output`, `outputRefs` and `lateResultAt`.

The eight stages, in order: `detect_or_receive`, `gather_context`, `investigate`, `examine_broader_causes`, `plan`, `authorize_and_execute` (the one `approval` step), `verify`, `learn`.

## Workflow rules

The rules that keep these tables consistent live in [`convex/workflow.ts`](../convex/workflow.ts); call those helpers instead of writing to the tables directly:

- `createCaseFromTemplate` inserts a case and its steps, and rejects duplicate keys, unknown `dependsOn` keys, and cycles.
- `startAttempt` works only when every step the step depends on is `done` or `skipped`, and inserts the next attempt. Starting again after a failed attempt is a retry; the earlier attempt row is never changed. A step has at most three attempts (`MAX_ATTEMPTS`).
- `finishAttempt` takes an attempt id and changes nothing unless that attempt is the step's current one, so a late result cannot overwrite a newer attempt.
- `skipStep` records a reason and refuses a `verify` step unless the case is `declined`.

How the runner drives these helpers (scheduling, approval, retries, timeouts, and the handler contract) is in [`convex/runner/README.md`](../convex/runner/README.md).

## The other tables

| Table | What a row is |
| --- | --- |
| `journeys` | A user journey of an app and the check that tests it (HTTP or Revyl), with its check version. |
| `actionCatalog` | An action turtl may run on an app (an HTTP call or a Capy code change), with its parameter constraints. |
| `reports` | A customer's message, as written, with its channel and provider event id. |
| `evidence` | Something a step observed, with the environment and revision it was observed on. |
| `proposals` | A versioned set of fixes for a case and the owner's decision on it. |
| `actions` | An approved fix, its frozen execution payload, idempotency key and outcome. |
| `verifications` | A check of a case's criteria before or after a fix, with each criterion's result. |
| `recoveryMemories` | A verified recovery turtl can offer again, with the conditions that must hold. |
| `permissions` | A scoped permission the owner granted to run one action on its own. |
| `ownerPreferences` | A preference the owner stated about an app. |
| `agentRuns` | One model or agent run, with its configuration, routing reason and outcome. |
| `contextSources` | Code, a document, an architecture note or a decision indexed as context for an app. |
| `ownerNotices` | One owner alert per case and event, with its outcome. |
| `ownerPasscodeConfig` | The hash of the owner passcode. |
| `fixChatMessages` | The Investigate further chat about a case. |
| `pullRequests` | A pull request turtl follows for an approved code change. |
| `intakeKeys`, `intakeRateWindows`, `reportTriage`, `intakeLocks` | Customer intake: see [`convex/intake/README.md`](../convex/intake/README.md). |
| `revylRuns`, `revylScreenshots` | Revyl device runs and the screenshots they kept. |
| `voiceTurns` | One spoken turn about a case (the audio is never stored). |
| `codeNetworks`, `codeChatMessages` | The code map of a project and the questions asked about it. |
| `bookingDemoSettings`, `bookingDemoBookings`, `bookingDemoAttempts` | The booking demo app: see [`convex/bookingDemo/README.md`](../convex/bookingDemo/README.md). |

The validators for most of these rows are in `convex/constants.ts`, and the comment above each table in `convex/schema.ts` states the rules its mutations must keep.
