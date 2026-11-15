# turtl

turtl is a mobile on-call app for people who own a live app and have no operations team. It tracks each case (an outage, a bug report, or a feature request) as a series of steps, from detecting a problem to learning from it. `turtl` is the working name.

## Stack

- Expo (React Native) with Expo Router and TypeScript
- Convex for the backend and live queries
- npm, with a committed `package-lock.json`

## Run it

```sh
npm install
npx convex dev    # in one terminal: syncs convex/ and writes .env.local
npx expo start    # in another terminal
```

The app reads the backend URL from `EXPO_PUBLIC_CONVEX_URL`. `npx convex dev` writes it to `.env.local`, which Git ignores; `.env.example` shows the shape. If the variable is missing, the app shows a screen saying the backend URL is not configured.

## Data shapes

All tables are defined in `convex/schema.ts`. The stage list, statuses, kinds, validators, and types are defined once in `convex/constants.ts`, which both the Convex functions and the app import. Do not redefine them elsewhere.

- `apps`: `name`, optional `repoUrl`, `productionUrl`, `revision`, `ownerId` (an opaque owner reference until sign-in exists; nothing enforces it yet), `isSample`.
- `cases`: `appId`, `title`, `impact` (plain language), `kind` (`outage`, `bug_report`, `feature_request`), `raisedBy` (`monitor`, `owner`, `customer`) with optional `raisedByRef` naming the actual user, service, or customer, `status`, optional `signature`, `reportCount`, `resolvedAt`, `isSample`. Statuses: `open`, `investigating`, `waiting_for_owner`, `executing`, `waiting_for_deploy`, `verifying`, `restored`, `resolved`, `unresolved`, `declined`. `restored` means service is back; `resolved` means the permanent repair is finished.
- `steps`: the stable, logical steps of a case's workflow. `caseId`, `key` (unique within the case), `title`, `dependsOn` (keys of steps in the same case), `kind` (`function`, `agent`, `approval`), `purpose` (a stage id), `status`, optional `skipReason` and `currentAttemptId`. A new case gets an initial template of eight steps, one per stage, in a chain.
- `stepAttempts`: one row per execution of a step. `stepId`, `caseId`, `attempt` (from 1), `status` (`running`, `waiting`, `done`, `failed`), optional `startedAt`, `finishedAt`, `summary`, `handoff`, `error`, `externalRef`.

The rules that keep these tables consistent live in `convex/workflow.ts`; call those helpers instead of writing to the tables directly:

- `createCaseFromTemplate` inserts a case and its steps, and rejects duplicate keys, unknown `dependsOn` keys, and cycles.
- `startAttempt` works only when every step the step depends on is `done` or `skipped`, and inserts the next attempt. Starting again after a failed attempt is a retry; the earlier attempt row is never changed.
- `finishAttempt` takes an attempt id and changes nothing unless that attempt is the step's current one, so a late result cannot overwrite a newer attempt.
- `skipStep` records a reason and refuses a `verify` step unless the case is `declined`.

`convex/_generated/` is committed; regenerate it with `npx convex dev` when you change the schema or functions.

## Dev tools

Development-only controls create a sample app and sample cases (one outage, one bug report, one feature request, each with its eight steps) and move them through their steps, so the app can be shown and tested without real detection. Two switches must both be on, or the app shows no trace of the tools:

- Server: the Convex environment variable `DEV_TOOLS_ENABLED` must be `true`. Without it every function in `convex/dev.ts` except `status` refuses to run. Turn it on for your deployment with `npx convex env set DEV_TOOLS_ENABLED true`.
- Client: the app renders the "Dev" pill only when `__DEV__` is true (a development build) or `EXPO_PUBLIC_DEV_TOOLS` is `1` (set it in `.env.local` or in the build environment for a release build), and only when the server reports the tools as enabled.

The pill opens a panel with New sample cases, Advance (starts the next step, or finishes the running one, on the first unfinished sample case), Auto-run (all unfinished sample cases to done, about one step every 1.2 seconds) and Reset samples (deletes the sample cases, their steps and attempts, and the sample app).
