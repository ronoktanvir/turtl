# Data model and workflow rules

All tables are defined in [`convex/schema.ts`](../convex/schema.ts), which also spreads in the tables each module defines in its own `schema.ts` (listed at the end of this page). The stage list, statuses, kinds, validators, and types are defined once in [`convex/constants.ts`](../convex/constants.ts), which both the Convex functions and the app import. Do not redefine them elsewhere.

`convex/_generated/` is committed; regenerate it with `npx convex dev` when you change the schema or functions.

## Cases and their steps

- `apps`: `name`, optional `repoUrl`, `productionUrl`, `revision`, `ownerId`, `isSample`, and `notAnsweringCase`: the project's open not-answering case, if any, which the monitor reads so that every round is settled while it is open (`convex/protectedApp/notAnswering.ts`). With accounts on (`AUTH_REQUIRED` set to anything but empty or `false`), `ownerId` is the account that owns the project, and [`convex/access.ts`](../convex/access.ts) lets a caller reach only projects whose `ownerId` is their own account; in the single-owner demo every project belongs to the one owner (`solo-owner`).
- `cases`: `appId`, optional `journeyId` and `matchedMemoryId`, `title`, `impact` (plain language), `kind` (`outage`, `bug_report`, `feature_request`), `raisedBy` (`monitor`, `owner`, `customer`) with optional `raisedByRef` naming the actual user, service, or customer, `status`, optional `signature`, `reportCount`, `distinctRequesterCount`, `resolvedAt`, `isSample`, and `starred` (the owner's "look at this later"; nothing in turtl acts on it). Statuses: `open`, `waiting_for_app`, `investigating`, `waiting_for_owner`, `executing`, `waiting_for_deploy`, `verifying`, `restored`, `resolved`, `unresolved`, `declined`. `restored` means service is back; `resolved` means the permanent repair is finished. `waiting_for_app` ("Not answering") is the one status of a case the monitor opened because the project's app gave its checks no answer at all: signature `not_answering:<appId>`, one step that is never run, and it ends `resolved` when any check answers or `unresolved` when turtl stops checking the project ([`convex/protectedApp/notAnswering.ts`](../convex/protectedApp/notAnswering.ts)).
- `steps`: the stable, logical steps of a case's workflow. `caseId`, `key` (unique within the case), `title`, `dependsOn` (keys of steps in the same case), `kind` (`function`, `agent`, `approval`), `purpose` (a stage id), `status` (`pending`, `running`, `waiting`, `done`, `failed`, `skipped`), optional `skipReason`, `currentAttemptId` and `staged` (dev staging, see the [runner README](../convex/runner/README.md#dev-staging)). A new case gets an initial template of eight steps, one per stage, in a chain.
- `stepAttempts`: one row per execution of a step. `stepId`, `caseId`, `attempt` (from 1), `status` (`running`, `waiting`, `done`, `failed`), optional `startedAt`, `finishedAt`, `summary`, `handoff`, `error`, `externalRef`, `inputRefs` (the parent attempts it consumed), `output`, `outputRefs`, `scheduledJobs` (the ids of the scheduled jobs it started, so Stop and account deletion can cancel them by id), `lateResultAt` and `lateResult`.

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
| `journeys` | A user journey of an app and the check that tests it (HTTP or Revyl), with its check version, `passingSince`: since when the check has passed every time (a failure or no answer clears it), and `unanswered`: how many of the monitor's tries in a row were quiet (no reply in time, a failed connection, or a status of 500 or above with no check result), when the first and the latest were, and what the latest got; anything else clears it. Only a POST journey check that has passed at least once keeps one (`canStopAnswering` in `convex/protectedApp/watching.ts`), never a health or readiness check. A case the monitor opens keeps how long that was in `cases.passingForMs`, which the outage reserve reads. |
| `actionCatalog` | An action turtl may run on an app (an HTTP call or a Capy code change), with its parameter constraints. |
| `reports` | A customer's message, as written, with its channel and provider event id. |
| `evidence` | Something a step observed, with the environment and revision it was observed on. |
| `proposals` | A versioned set of fixes for a case and the owner's decision on it. |
| `actions` | An approved fix, its frozen execution payload, idempotency key and outcome. |
| `verifications` | A check of a case's criteria before or after a fix, with each criterion's result. |
| `recoveryMemories` | A verified recovery turtl can offer again, with the conditions that must hold. |
| `permissions` | A scoped permission the owner granted to run one action on its own. |
| `ownerPreferences` | A preference the owner stated about an app. |
| `agentRuns` | One model or agent run, with its configuration, routing reason and outcome. A run waiting to be scored has `nextSettleAt`, and the settling cron takes due runs through the `by_settled_and_next` index in bounded batches; one that never finishes is settled as such after 30 days. |
| `contextSources` | Code, a document, an architecture note or a decision indexed as context for an app. |
| `ownerNotices` | One owner alert per case and event (`opened`, `needs_decision`, `handled_under_permission`, `not_answering`, `answering_again`), with its outcome. |
| `ownerPasscodeConfig` | The hash of the owner passcode. |
| `closedDemoNotices` | One row, naming no account: when the backend log last said the single-owner demo is closed because the deployment holds accounts (`convex/access.ts`). |
| `fixChatMessages` | The Investigate further chat about a case. |
| `pullRequests` | A pull request turtl follows for an approved code change. Syncing takes due rows by `nextSyncAt` (the `by_settled_and_next_sync` index) and slows down for rows that never settle. |
| `intakeKeys`, `intakeRateWindows`, `reportTriage`, `intakeLocks` | Customer intake: see [`convex/intake/README.md`](../convex/intake/README.md). |
| `revylRuns`, `revylScreenshots` | Revyl device runs and the screenshots they kept. |
| `voiceTurns` | One spoken turn about a case (the audio is never stored). |
| `codeNetworks`, `codeChatMessages` | The code map of a project and the questions asked about it. |
| `bookingDemoSettings`, `bookingDemoBookings`, `bookingDemoAttempts` | The booking demo app: see [`convex/bookingDemo/README.md`](../convex/bookingDemo/README.md). |
| `structuralFindings` | A deeper cause the examine-broader-causes step found across cases: [`convex/structural/README.md`](../convex/structural/README.md). |
| `councilSettings`, `councilReviews` | Which models sit on a project's council, and each council's review of a case: [`convex/council/README.md`](../convex/council/README.md). |
| `ownerDecisions`, `preferenceSuggestions`, `contextUses` | What the owner decided, preferences waiting for confirmation, and context that helped a fix: [`convex/learning/README.md`](../convex/learning/README.md). |
| `onboardingInspections`, `onboardingPreparations` | Reading a new project's repository, and the pull request that prepares it: [`convex/onboarding/README.md`](../convex/onboarding/README.md). |
| `githubInstallations`, `githubInstallationRepositories`, `githubInstallationTokens`, `githubWebhookDeliveries`, `githubConnectAttempts`, `githubInstallationLinks` | The GitHub App: installations, the repositories each covers, cached tokens, webhook deliveries, Connect GitHub attempts, and which account uses which installation: [`convex/github/README.md`](../convex/github/README.md). |
| `pushTokens`, `pushSends` | The owner's phones and what each push did. Each phone's row keeps the `sessionId` that registered it, and the phone receives only while that session is alive: [`convex/push/README.md`](../convex/push/README.md). |
| `users`, `authAccounts`, `authSessions`, `authRefreshTokens`, `authVerificationCodes`, `authVerifiers`, `authRateLimits`, `authAppleNonces`, `authAppleTokens`, `authEmailCodes`, `authUnconfirmed`, `authCounts` | Accounts and sign-in (Convex Auth's tables and turtl's own). `authAppleTokens` holds Apple's refresh token sealed under `SECRETS_ENCRYPTION_KEY`; `authEmailCodes` holds a hash of each emailed reset or confirmation code under a hash of the address, for a day; `authUnconfirmed` lists password accounts that have not confirmed their address yet, deleted after 7 days if they never do; `authCounts` holds running counts for the per-domain sign-up and confirmation limits and the day's emails, keyed by a SHA-256 of the domain (never the domain or an address), and the hourly sweep deletes every window before today: [`convex/auth/README.md`](../convex/auth/README.md). |
| `aiConsents` | Each account's answers on the AI permission screen: [`convex/consent/README.md`](../convex/consent/README.md). |
| `modelSpend`, `codingThreads`, `intakeDays`, `deploymentTotals`, `accountSpendDays`, `deploymentModelDays` | Spend and use counted against the limits, including `accountSpendDays`, one row per account per day: its own, practice-app, outage-floor and customer-report AI spend, and what is held for calls whose cost has not come back yet; and `deploymentModelDays`, one row per day and no account: what every account's outage floor spent that day, what is held for calls in flight, and when the hard stop was logged, counted with the shared day against the hard stop. Older days are deleted as new ones start: [`convex/spend/README.md`](../convex/spend/README.md). |
| `modelCallHolds` | One row per model call in flight: whose account, which share and day it is held on, what it is held at, and when the hold runs out. It is gone when the call's cost comes back, at once when the AI service refuses with an error status, or ten minutes on, when a sweep each minute counts it at its hold. Deleted with the account: [`convex/spend/README.md`](../convex/spend/README.md). |
| `accountDeletions` | The record of an account deletion: [`convex/account/README.md`](../convex/account/README.md). |
| `secrets` | A project's sealed control token or an account's sealed coding agent key: [`convex/secrets/README.md`](../convex/secrets/README.md). |
| `watchedProjects`, `monitorCursor` | With accounts on, the monitor's state for each project that has checks (when it is next due, how long it has failed the same way, and when a round last got a usable reply, which turtl reads across projects before a not-answering case opens), and how far the monitor has looked through the checks added to every project (`convex/protectedApp/watching.ts`). |
| `practiceApps`, `practiceBookings` | A practice project's app: its switches, the SHA-256 of its control token and the day's breaks, and the test bookings its check makes and deletes: [`convex/practice/`](../convex/practice). |

The validators for most of these rows are in `convex/constants.ts`, and the comment above each table in `convex/schema.ts` states the rules its mutations must keep.
