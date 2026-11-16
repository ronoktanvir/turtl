# Hackathon log

- **Project:** turtl
- **What it does:** A mobile on-call app for people who own a live app and have no operations team: it tracks each case (an outage, a bug report or a feature request) as a series of steps from detection to learning, watches a registered journey, proposes a fix, and acts only with the owner's approval or a narrow permission the owner granted.
- **Live app:** not deployed
- **Repo:** https://github.com/ronoktanvir/turtl
- **Frontend:** Other (Expo iOS simulator build on Revyl cloud devices; no public hosted frontend)
- **Convex deployment:** https://patient-kudu-956.convex.cloud
- **Components:** none
- **Convex features:** schema, tables, indexes, queries, mutations, actions, internal functions, HTTP actions, crons, scheduled functions, realtime queries
- **Auth:** none
- **AI models:** gpt-5.4-mini (case diagnosis, `DIAGNOSIS_MODEL` overrides it), gpt-6-luna (assistant chat, `OPENAI_MODEL` overrides it); both are called through the OpenAI API, not the Convex AI Gateway
- **Started:** 2026-11-15T20:37:34Z
- **Last updated:** 2026-11-15T23:29:48Z

## Log

### 2026-11-15 - 296ab0f
Scaffolded the Expo Router app in TypeScript with a root layout and a home screen (`app.json`, `package.json`, `app/_layout.tsx`, `app/index.tsx`).

### 2026-11-15 - e4361a4
Wired the app to Convex and defined the incident model: an `incidents` table and a `steps` table with a `by_incident` index, with the eight stages and the incident and step statuses defined once in `convex/constants.ts`. The home screen shows a live incident count from the `incidents.list` query, and shows a notice when the backend URL is not configured. The README documents the stack and how to run it. Convex features: schema, tables, indexes, query, realtime queries (`convex/schema.ts`, `convex/incidents.ts`, `app/index.tsx`, `app/_layout.tsx`).

### 2026-11-15 - 0b71096
Pull request #2 renamed the main record from `incidents` to `cases`, because the app tracks outages, bug reports and feature requests, not only incidents. `cases` has a required `kind` and `raisedBy`, `steps` points at it through `caseId` and a `by_case` index, and the constants gained case statuses, kinds and raised-by values. The home screen shows the case count from `cases.list`. Convex features: schema, tables, indexes, query, realtime queries (`convex/schema.ts`, `convex/constants.ts`, `convex/cases.ts`, `app/index.tsx`).

### 2026-11-15 - 881d8df
Pull request #5 added the case list and the case screen. Each case row shows its title, kind, who raised it, status and a six-segment progress strip, and each case opens to six swipeable cards that read live from Convex. Cards carry no actions yet. New queries `listWithSteps` and `get` return a case with its steps; a bad id returns `null` instead of throwing. Convex features: queries, realtime queries (`convex/cases.ts`, `app/index.tsx`, `app/case/[id].tsx`, `components/feed/`).

### 2026-11-15 - 4523c40
Pull request #6 added development-only sample cases so the feed can be shown without real detection. `createSampleCases` makes one case of each kind, `advance` moves one step, `autoRun` runs the sample cases on the Convex scheduler about every 1.2 seconds, and `resetSamples` removes them. Every function throws unless the deployment variable `DEV_TOOLS_ENABLED` is `true`, and a "Dev" pill in the app shows the controls only when the server reports they are on. Convex features: mutations, scheduled functions, query (`convex/dev.ts`, `components/dev/`).

### 2026-11-15 - c577c81
Pull request #3 added this build log and the skill that maintains it (`hackathon.md`, `.agents/skills/convex-hackathon-skill/`). It is process, not product progress, and is logged so each merged pull request has an entry.

### 2026-11-15 - e79bd5b
Pull request #4 added the Revyl config so each pull request gets an iOS simulator build and a proof-of-changes run on a cloud iPhone. The build reads `EXPO_PUBLIC_CONVEX_URL` from `build.env`, because Git ignores `.env.local`, and the config tells the proof agent how to create sample data from the Dev pill (`.revyl/config.yaml`, `.revyl/.gitignore`).

### 2026-11-15 - 02aa3d1
Pull request #7 reshaped the data under the app. New `apps` table; a case now has an app, an impact, a signature and a report count. A step is a stable logical step with dependencies, and each run of it is a row in the new `stepAttempts` table, so a retry adds an attempt and never edits an old one. `convex/workflow.ts` holds the rules: the eight-step template is validated on creation, a step starts only when its dependencies are done or skipped, a stale attempt's result is ignored, and a `verify` step can be skipped only on a declined case. Cases moved to ten statuses, with `waiting_for_deploy` and `restored` new. The feed and the dev tools were moved onto the new shapes. Convex features: schema, tables, indexes, queries, internal mutations (`convex/schema.ts`, `convex/workflow.ts`, `convex/cases.ts`, `convex/dev.ts`).

### 2026-11-15 - ef110f8
Pull request #8 added memory with Supermemory behind a Convex action. `assistant.chat` searches the user's memories, asks a model with those memories and the case's current steps, and stores both turns. It refuses unless `ASSISTANT_ENABLED` is `true`, limits message and reply length, and the Expo app never imports Supermemory. There is no chat screen yet. Convex features: action (`convex/assistant.ts`, `convex/supermemory.ts`).

### 2026-11-15 - a108867
Pull request #9 added the remaining data shapes as tables with validators and no functions: journeys, actionCatalog, reports, evidence, proposals, actions, verifications, recoveryMemories, ownerPreferences, permissions, agentRuns and contextSources. Proposals, permissions, verifications and actions are modelled as immutable, versioned records. It landed on `main` through #10, which merged it into its own branch first. Convex features: schema, tables, indexes (`convex/schema.ts`, `convex/constants.ts`).

### 2026-11-15 - 55e9baf
Pull request #11 added a helper that alerts the app's owner through Keiki: `sendOwnerNotice` and the internal action `keiki.notifyOwner`. Alerts are best effort and never throw. Until the Keiki variables are set on the deployment, the helper returns `not_configured` and sends nothing. Convex features: internal action (`convex/keiki.ts`).

### 2026-11-15 - da75b49
Pull request #10 added the case runner. A case's eight steps now run on the Convex scheduler with no client connected: the runner starts every ready step, calls one handler per step purpose, retries a failed attempt up to three times (then the case is `unresolved`), fails an attempt that outlives its timeout, and stores a late result without touching the step. The approval step waits for the owner, and `approve` or `decline` resumes or ends the case. The handlers were placeholders at this point. The dev tools gained a live-run section: Start live run, Approve, Decline and Clear live runs. Convex features: internal mutations, internal actions, scheduled functions (`convex/runner/`, `convex/workflow.ts`, `convex/dev.ts`).

### 2026-11-15 - e91aaef
Pull request #12 added recovery memory and replaced the placeholder `learn` handler. A memory is saved only from a completed recovery with an approved matching proposal and a passing after-fix check; declined, unresolved and unverified cases save nothing. Recall combines indexed candidates with Supermemory search hits, checks every condition against fresh facts, refuses on a "not when" match, and only proposes, never authorizes. Convex features: internal actions, internal queries, indexes (`convex/memory/`, `convex/runner/handlers/learn.ts`, `convex/schema.ts`).

### 2026-11-15 - ad4d580
Pull request #13 ran the first incident end to end on the backend. A cron checks each registered journey every minute and opens one outage case when the booking app's journey fails. The runner then reads the booking app's health, errors, flags and revision, asks a model for a diagnosis (or falls back to a labelled rule-based reading), writes a proposal to turn off recommendations, and waits. `decisions.approve` freezes the proposal and runs the flag change once; verify checks health, the flag and the journey again, and a verified recovery ends the case `restored`. `decisions.decline` ends it `declined`. There is no sign-in: both are callable by anyone with the deployment URL, and the actor is recorded as `solo-owner`. The owner is alerted when a case opens and when it needs a decision. Convex features: crons, scheduled functions, internal actions, mutations, queries (`convex/monitor.ts`, `convex/crons.ts`, `convex/decisions.ts`, `convex/diagnosis.ts`, `convex/protectedApp/`, `convex/runner/handlers/`).

### 2026-11-15 - 9118536
Pull request #14 put the first incident on the six case cards: what broke, what we found, the recommended action, work in progress, proof and what we learned. The owner can approve or decline from the card, always through a confirmation. Cards say when a diagnosis was rule-based because no model answered, and show each proof criterion's result, including "Not covered". Convex features: query, mutations, realtime queries (`components/feed/`, `convex/cases.ts`, `app/case/[id].tsx`).

### 2026-11-15 - ec1769e
Pull request #15 connected recovery memory to the live flow. A passing after-fix check can create a memory; gather-context recalls on fresh observations and plan offers the remembered action with its success count, but investigation is skipped only when every condition passes, and approval and verification are never skipped. A staged booking-store failure that shares the journey's signature but not its cause is refused the shortcut and goes through full investigation. Convex features: internal actions, internal mutations, scheduled functions (`convex/memory/`, `convex/runner/`, `convex/diagnosis.ts`).

### 2026-11-15 - ba3fa34
Pull request #16 hosted a demo booking backend inside the same Convex deployment, under `/booking-demo`, so turtl has a live app to protect: health, revision, flags, errors and journey-check routes, customer functions, and three prefixed tables (`bookingDemoSettings`, `bookingDemoBookings`, `bookingDemoAttempts`). turtl still reaches it only over HTTP, and its README states the weaker credential boundary of this shortcut. Convex features: HTTP actions, actions, tables, indexes (`convex/http.ts`, `convex/bookingDemo/`, `convex/schema.ts`).

### 2026-11-15 - 325c94f
Pull request #17 let the owner grant a scoped permission. After two verified recoveries, `permissions.grant` copies one action with pinned values, the memory's conditions, a limit of three uses, and an end when the app's revision changes, the owner revokes it, or a run under it fails to restore service. At the approval step the runner uses it only if every check still passes; otherwise the case goes back to the owner. Cards show the offer, "Ran under your permission", and why turtl did not act on its own. Convex features: mutations, internal mutations, indexes (`convex/permissions.ts`, `convex/runner/run.ts`, `components/feed/PermissionPanel.tsx`).
