# Hackathon log

- **Project:** turtl
- **What it does:** A mobile on-call app for people who own a live app and have no operations team: it tracks each case (an outage, a bug report or a feature request) as a series of steps from detection to learning, watches a registered journey, proposes a fix, and acts only with the owner's approval or a narrow permission the owner granted.
- **Live app:** not deployed
- **Repo:** https://github.com/ronoktanvir/turtl
- **Frontend:** Other (Expo iOS simulator build on Revyl cloud devices; no public hosted frontend)
- **Convex deployment:** https://patient-kudu-956.convex.cloud
- **Components:** none
- **Convex features:** authentication (Convex Auth), schema, tables, indexes, queries, mutations, actions, internal functions, HTTP actions, crons, scheduled functions, file storage, realtime queries
- **Auth:** Convex Auth (`@convex-dev/auth` 0.0.98): email and password (with the address confirmed by an emailed code), Sign in with Apple, and GitHub, whenever `AUTH_REQUIRED` is set to anything but empty or `false`. Unset, empty or `false`, the deployment is the single-owner demo: nobody signs in, and it refuses to run if it holds any account
- **AI models:** gpt-5.4-mini (Quick look diagnosis, and by default fix proposals, case chat, report triage and preference reading; `DIAGNOSIS_MODEL` and `FIXES_MODEL` override it), gpt-6.1-sol (Careful review diagnosis and council consolidation), gpt-5.5 and gpt-6.1-terra (council members), gpt-5.4 (broader-cause examination, `STRUCTURAL_MODEL` overrides it), gpt-6-luna (assistant chat, code network and onboarding inspection, `OPENAI_MODEL` overrides it), gpt-4o-mini-transcribe and gpt-4o-mini-tts (voice); claude-sonnet-4-5 and gemini-2.5-pro join the council only when `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` is set. All are called through each provider's API, not the Convex AI Gateway
- **Started:** 2026-11-15T20:37:34Z
- **Last updated:** 2026-11-17T00:26:20Z

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

### 2026-11-15 - 26b9f42
Pull request #19 rewrote the memory and permission parts of the cards as plain sentences, with no change to behavior or schema. Each condition reads as a sentence built from its fact, comparison and value; a "not when" check that only mirrors a condition is dropped; the permission offer names its one action, its limit of three runs and what ends it; and raw ids, ISO times and full revisions no longer appear. The plan step no longer says a remembered recovery always needs owner approval. Checked in Expo web against a local backend (`components/feed/plainWords.ts`, `components/feed/incident.ts`, `convex/permissions.ts`, `convex/runner/handlers/plan.ts`).

### 2026-11-15 - 5b46ef1
Pull request #20 added two dev controls so the booking demo can be recorded more than once. Reset booking history, behind `DEV_TOOLS_ENABLED`, stops pending booking work, removes the booking app's permissions, restores recommendations and clears the staged failures over HTTP, confirms a passing journey, then deletes that app's journey cases and their child records; it leaves Supermemory entries in place and says so. "Owner: turn recommendations on" changes only that flag. The monitor now ignores a failure older than the latest passing check, so an in-flight failure cannot recreate deleted history. Proven on local backends only, not deployed. Convex features: actions, internal mutations (`convex/memory/reset.ts`, `convex/dev.ts`, `convex/monitor.ts`, `components/dev/`).

### 2026-11-16 - 320de85
Pull request #18 added Still, the customer-facing booking app turtl protects, as a separate Expo Router package under `protected-app/` with no Convex folder of its own. It calls the booking demo's functions on turtl's deployment, and control credentials never reach it. Checked in Expo web against a local backend: a healthy booking saved, the staged recommendations timeout stopped a booking, and a booking saved again once recommendations were turned off. This is local web evidence, not a hosted or device proof (`protected-app/`, `tsconfig.json`).

### 2026-11-16 - 36ffc7c
Pull request #21 limited the dev tools to the cases they create. `advance` and `autoRun` refuse a case that is not a sample, `autoRunStep` does nothing for one, and the live-run Approve and Decline refuse any case outside the live-run test app; the `DEV_TOOLS_ENABLED` gate still runs first. Proven on a local deployment. It also brought this log up to date through #17. Convex features: mutations, internal mutation (`convex/dev.ts`, `hackathon.md`).

### 2026-11-16 - 712ca89
Pull request #27 added the redesigned app on an in-memory example store: Home, Project home and its settings, Begin Fix and Features, the Fix screen with Overview, Logs and Code, Investigate further, Fix enacting and the Investigate code network, with the theme and turtle brand assets. Screens read only through the hooks in `data/index.ts`, so the backend can be wired in later inside `data/`. Approve, merge, Stop and chat change only the example store, and the old live case list moved to `/live`. Checked in Expo web; not run on a phone. It landed on `main` through #28, which was built on it (`data/`, `theme/`, `app/`).

### 2026-11-16 - 72940b4
Pull request #28 polished the new UI: Capriola type, Lucide icons, Dark by default with Light as an explicit setting, turtle poses and short transitions that respect reduced motion, a pinch-and-pan Investigate graph, and a Plan drawn as a downward graph with a concurrent batch of checks. A Login screen opens first; its buttons enter Projects without real sign-in. Everything still runs on the example store, and `convex/` is untouched. Checked by scripted walks in Expo web at two phone widths. A backend-free iOS simulator build succeeded, but native gestures and transitions were not exercised on a phone (`app/`, `components/`, `theme/`, `assets/`).

### 2026-11-16 - 6192573
Pull request #24 let the verify step run the booking journey on a Revyl cloud device. `revyl/runs:start` queues the journey's Revyl workflow, follows it in the background for up to 20 minutes, keeps up to eight step screenshots in Convex file storage and records the verdict; `revyl/runs:screenshots` returns them for a case. Verify waits up to six minutes, and the device criterion is covered only by a finished run. Without `REVYL_API_KEY` the call returns `not_configured` and the criterion stays Not covered. Exercised only against a local mock of Revyl's API, not real Revyl. Convex features: internal actions, file storage, query, tables (`convex/revyl/`, `convex/runner/handlers/verify.ts`).

### 2026-11-16 - 25e1e41
Pull request #22 gave a case one to four proposed fixes with exactly one recommended. The plan step keeps the catalog fix, which stays the rule-based recommendation that memory and permissions depend on, and asks the model for up to three code-change fixes bound to the app's pull request catalog entry; without a model key it writes the single catalog fix and says why. `fixes.investigate` is the Investigate further chat: a fix turtl proposes there goes into a new pending proposal version and still needs approval. Proven on a local deployment. Convex features: action, queries, mutation, table (`convex/fixOptions.ts`, `convex/fixes.ts`, `convex/runner/handlers/plan.ts`).

### 2026-11-16 - 52de289
Pull request #23 shipped a code-change fix as a pull request. Approving one starts a Capy thread that writes the change, and the case waits in `waiting_for_deploy`. A 30-second cron reads the pull request and its checks from GitHub into a new `pullRequests` table. `pullRequests.merge` re-reads GitHub and merges only when the pull request is open, its checks pass, GitHub can merge it and its head is still the one the owner was shown; the merge completes the action and the runner moves on to verify. There is no sign-in, so the merge is recorded as the solo owner. Without `GITHUB_TOKEN` or `CAPY_API_KEY` the functions return `not_configured`. Convex features: crons, actions, internal mutations, table (`convex/pullRequests.ts`, `convex/prTracking/`, `convex/crons.ts`).

### 2026-11-16 - 8ff509c
Pull request #25 backed the Investigate screen with a code network. `codeNetwork/build:build` reads a repository from GitHub, builds its import, call and table graph, asks OpenAI to group it into plain-language clusters, and indexes each file and cluster in the project's own Supermemory namespace. `codeNetwork/ask:ask` answers a question scoped to the project, a cluster or a file from those chunks, and is off unless `CODE_NETWORK_CHAT_ENABLED` is `true`. A checked-in seed holds this repository's network (12 clusters, 140 nodes). Proven on a local deployment with real Supermemory and OpenAI keys. Convex features: internal action, action, queries, tables (`convex/codeNetwork/`, `convex/supermemory.ts`).

### 2026-11-16 - ddbc6e9
Pull request #29 replaced the example projects with Listener Ladder, Orca, Superprediction and Guardian. Listener Ladder carries a full ranking-timeout story with cited logs and code, game screenshots, three proposed repairs and a code network, and the current-issues dashboard and Project home were tightened to fit a phone screen. This is example data, not a real repair: no game test, code change or deployment happened. A backend-free iOS simulator build succeeded; nothing ran on a phone (`data/example/`, `components/project/`, `app/project/`).

### 2026-11-16 - a7c5d67
Pull request #26 made the learn step write one Markdown case note from the records the steps already stored, with no model call, and index it in Supermemory. A later full investigation on the same app gives up to three earlier notes to the diagnosis model as background; the prompt says a past case is never support or an approval, and without notes the request is unchanged. Each hit is resolved back to a Convex record, with recent learn notes as the fallback. Checked on a local backend with no model or Supermemory key; a real model call and real indexing were not run. Convex features: internal actions, internal queries (`convex/memory/service.ts`, `convex/runner/handlers/learn.ts`, `convex/runner/handlers/investigate.ts`, `convex/diagnosis.ts`).

### 2026-11-16 - 067b7ed
Pull request #30 added three Listener Ladder feature requests to the example data, each with artwork, cited context, two options and a plan, and made execution readable: real inline citation links on web, start and finish times, live elapsed time and remaining estimates, with the clock paused for merge decisions and Stop. Approval counts now separate fixes from requests. Tests cover citation rendering and the clock. This is example content; a backend-free iOS build succeeded, but nothing ran on a phone (`data/example/`, `components/execution/`, `tests/`).

### 2026-11-16 - 677cdee
Pull request #31 let the owner stop a case. `decisions.stop` cancels an approved action before it is sent to the live app, cancels queued case work, skips the remaining steps and keeps the history. For a pull request still being written or open, it stops tracking and blocks a later merge, but leaves the Capy and GitHub work in place and says so. Once a send or merge has started, Stop refuses. The case ends `declined` and the action `cancelled`. Proven with synthetic fixtures on a local backend. Convex features: mutation, scheduled functions (`convex/decisions.ts`, `convex/prTracking/records.ts`).

### 2026-11-16 - 210d37b
Pull request #33 made case-note recall look for exact case references in Supermemory's source chunks instead of extracted memories, and fall back to recent learn notes in Convex when the search fails or times out. Proven locally with real OpenAI and Supermemory: a recovered case's note was found by reference and given to a later diagnosis of a different cause. No device run was proven, because the Revyl key was refused (`convex/memory/service.ts`).

### 2026-11-16 - 44d5c3f
Pull request #32 let the code network build read a public repository when GitHub rejects the configured token: it retries without the token and leaves the rejected one off later requests. Private repositories still need valid access. Proven on a local backend with real GitHub, OpenAI and Supermemory: a fresh build indexed 124 documents and answered scoped questions with their sources (`convex/codeNetwork/build.ts`).

### 2026-11-16 - a194792
Pull request #34 connected the new screens to live Convex data: registered projects, recorded cases and evidence, real fix decisions, enactment and pull request state, screenshots and code-network chat. A build uses live data when `EXPO_PUBLIC_CONVEX_URL` is set, `EXPO_PUBLIC_DATA_SOURCE=example` keeps the example store, and a live field never falls back to example data. Owner controls wait for the backend's answer and show a refusal. The Revyl proof build is pinned to example data. Proven at phone width in Expo web against a local backend, from a staged outage through approval, verification and learning; the diagnosis was rule-based and device coverage stayed Not covered. Convex features: queries, realtime queries (`data/live/`, `convex/screens/`, `app/`).

### 2026-11-16 - 4804211
Pull request #35 kept an approved booking code change waiting after its pull request merges, until the booking app reports that exact merge commit as its revision. Only then does verify run, recording `after_deploy` evidence and checking health and the journey without the recommendations-off workaround; a verified code change can end `resolved`. GitHub check reads retry without a token after an authorization rejection, and merges stay authenticated and pinned to the head the owner saw. Proven on a local backend with labelled HTTP mocks; no real GitHub merge or device run is claimed. Convex features: internal actions, internal mutations (`convex/prTracking/`, `convex/runner/handlers/verify.ts`).

### 2026-11-16 - 54415d4
Pull request #36 gave case chat the latest action's outcome and the verification results labelled by phase, and added the owner's current question, which the earlier context had left out. Four real `gpt-5.4-mini` calls on a local backend explained a recovery without claiming a device pass, said no live change happened for a declined and a stopped case, and said a pending case was waiting for the owner. Convex features: action (`convex/fixes.ts`).

### 2026-11-16 - 330c958
Pull request #37 recorded each owner notice once. A transactional claim per case and event wraps the Keiki sender and stores its outcome; a duplicate run cannot send again, and an interrupted one stays `pending` instead of claiming success. No phone number or message body is stored. `notices.forCase` returns the records, and the booking reset now also deletes notices, pull request, chat and device records and their screenshots. Proven on a local backend with mocks; no real delivery is claimed. Convex features: query, internal mutations, table (`convex/notices.ts`, `convex/memory/reset.ts`, `convex/runner/run.ts`).

### 2026-11-16 - 1f3c2ac
Pull request #39 made the case overview say when a recovery ran automatically under the owner's scoped permission, with its recorded use count and limit, and only once the action completed and the case was restored or resolved. An owner's own action is never labelled automatic. Only the mapper and its tests changed. Its description reports a check at phone width against the hosted backend, where a recorded automatic recovery showed as use 1 of 3 (`data/live/caseMapping.ts`).

### 2026-11-16 - 7475b58
Pull request #40 told case chat who ran the action: the owner, by approving it, or turtl, automatically under an earlier scoped permission, with the use count. On a local three-case chain, two real model replies said "You approved this action" for the owner's action and named the scoped permission and "1 of 3" for the automatic one. Convex features: action (`convex/fixes.ts`).

### 2026-11-16 - ab1e6ce
Pull request #38 protected owner decisions with one owner passcode, without accounts. The owner sets it in project settings, and Convex stores only its SHA-256 digest. Approve, decline, stop, grant, revoke, merge and attach check it before doing anything. Until a passcode is claimed, the five older decision mutations still work for anyone with the backend address and settings warns about it, while linking and merging pull requests refuse. A phone keeps the passcode in `expo-secure-store`, so a new native build is needed. Proven on a local backend only. Convex features: mutations, query, internal mutation, table (`convex/ownerPasscode.ts`, `convex/decisions.ts`, `convex/permissions.ts`, `convex/pullRequests.ts`, `data/live/ownerPasscode.ts`).

### 2026-11-16 - cf5c9c3
Pull request #42 added voice to case chat. The owner taps the microphone, asks out loud and hears the answer, and turtl listens again until the owner ends the session. `voice.turn.talk` transcribes with `gpt-4o-mini-transcribe`, answers through the case chat and speaks the reply with `gpt-4o-mini-tts`; audio is never stored. Speech never makes a decision: a spoken approve, decline, merge or stop is told where the button is. Clips are capped at 30 seconds and 20 turns per case per 10 minutes, behind `VOICE_ENABLED`, and the chat context now says what the case is waiting on. Proven in Chromium with recorded clips against a local backend and real OpenAI calls; not tried on a phone. Convex features: action, query, tables (`convex/voice/`, `components/voice/`, `convex/fixes.ts`).

### 2026-11-16 - f4b1cb8
Pull request #44 let customers of a watched app report a bug or request a feature. `POST /intake/report` takes a report with a per-app intake key, stored only as a hash, with rate limits and idempotent resubmits, and the booking app gained a report form. Triage takes one report at a time: an exact copy attaches, otherwise Supermemory suggests similar open cases and the model sorts it into bug, request or noise, with a labelled rule-based fallback. Customer text reaches the model as data, and a report that only instructs turtl is ignored. A feature gets up to three "Build it" options, each a pull request the owner approves. Proven on a local backend with real `gpt-5.4-mini` and Supermemory calls. Convex features: HTTP actions, internal actions, scheduled functions, tables (`convex/intake/`, `convex/http.ts`, `convex/runner/handlers/detect_or_receive.ts`, `protected-app/report/ReportForm.tsx`).

### 2026-11-16 - 8a942f0
Pull request #41 removed the six-minute cutoff on the device check. Once a Revyl run has started, verification waits for its recorded verdict and resumes with fresh server checks when it arrives, with the step timeout paused; the 20-minute follow limit stays. Retries reuse the same run, and a run that ends abnormally fails verification instead of reading as Not covered. Proven on a local backend against a loopback Revyl mock, with no real device. Convex features: scheduled functions, internal mutations (`convex/revyl/`, `convex/runner/run.ts`, `convex/runner/handlers/verify.ts`).

### 2026-11-16 - 37bd98b
Pull request #52 made recommendations optional in the booking demo, as the code repair for its staged defect: booking no longer calls the recommendations provider, so a provider error, timeout or hang cannot stop a booking from being saved, and the journey reports recommendations as skipped. Proven with 14 isolated tests against mocked Convex storage, not on a deployed backend or a device (`convex/bookingDemo/`).

### 2026-11-16 - 3d01f64
Pull request #51 corrected the live enactment screen while Capy is writing a repair: it says "No pull request yet", and a merged pull request no longer claims verification has started before the new revision is deployed. Merge is offered only for a pull-request fix with an open recorded pull request, passing checks, GitHub's mergeability and the waiting-for-merge state. Frontend only, with 17 focused tests (`app/review/[caseId]/enacting.tsx`, `tests/enactment-pr-state.test.mjs`).

### 2026-11-16 - 65148f6
Pull request #56 reversed #52 on purpose, to give the demo back its staged defect. Its description says #52's repair had already been proven on the hosted backend; booking again waits for the simulated recommendations provider, so the staged timeout breaks it again. The four-file diff is the exact inverse of #52's merge, including removing its tests. This is a demo reset, not a production fix. Checked with typecheck and an inverse-patch comparison; the staged-defect script was not rerun (`convex/bookingDemo/`).

### 2026-11-16 - 6c1968d
Pull request #45 made the examine-broader-causes step real. When a case has related history on the same app (the same signature, failing journey step or recovery memory), one model call asks whether a deeper cause is at work; otherwise the step records why it did not look. A finding is kept only with a hypothesis, evidence from at least two cases, a bounded repair and a test that could disprove it. It joins the case's fixes as a code change that is never recommended, and shows on the case and on Project home. A recovery-memory match now skips only investigation, so this step still runs on a recurrence. A prevention check registers only when the app runs its scenario; the booking demo on `main` does not, so approving one ends "Not registered". Covered by unit tests; no live run is described. Convex features: mutation, queries, internal actions, scheduled functions, tables (`convex/structural/`, `convex/runner/handlers/examine_broader_causes.ts`, `convex/memory/flow.ts`).

### 2026-11-16 - a7c7f1c
Pull request #46 routed each diagnosis. A deterministic selector sends a case to a Quick look (`gpt-5.4-mini`, low reasoning) or a Careful review (`gpt-6.1-sol`, high reasoning); a failure touching auth, payments, deletion, migrations or secrets always gets the careful review, within a $0.50 diagnosis budget per case. A quick look that does not establish a cause hands up to a careful run. An unfamiliar case still unsure after that goes to a council of three OpenAI models consolidated by `gpt-6.1-sol`, with Claude and Gemini models joining only when their keys are set; the council's view says that agreement is not proof. Every run is logged with cost and outcome, a 2-minute cron settles outcomes, and after three counted outcomes the log can shift routing. Proven on a local backend with real OpenAI calls. Convex features: crons, internal actions, internal mutations, tables, indexes (`convex/routing/`, `convex/council/`, `convex/diagnosis.ts`, `convex/runner/handlers/investigate.ts`).

### 2026-11-16 - 81c85ef
Pull request #47 taught turtl the owner's preferences and decisions. A preference comes from the settings sheet, a note on a decision or the case chat, and is saved only when the owner confirms it with the passcode; it lives in Convex with a copy in Supermemory. A preference can move the recommendation to another fix the facts support, and the fix says so, but it never satisfies a memory condition or a permission. Approve, decline and stop record the owner's decision, and an option declined twice under the same conditions is not recommended again while another supported fix exists. Context that helped a verified fix is fetched first next time and flagged as possibly stale after the app's revision changes. Proven on a local backend with real `gpt-5.4-mini` and Supermemory calls. Convex features: mutations, queries, internal actions, tables (`convex/learning/`, `convex/decisions.ts`, `convex/fixOptions.ts`, `convex/runner/handlers/gather_context.ts`).

### 2026-11-16 - 8e2748e
Pull request #50 split evidence collection for new journey cases into two read-only branches after detection, app state and the error window, each with its own attempts and provenance, joined by one gather step that consumes their exact attempts. A failed or malformed required read stops the join instead of inventing facts, and a late result keeps its own diagnostics. The case Overview now shows the recorded graph and its real statuses before approval, not example timers. Proven on a local backend with localhost HTTP sources and in Expo web; not on a hosted deployment or a device. Convex features: scheduled functions, internal mutations (`convex/evidence/`, `convex/workflow.ts`, `convex/runner/`, `components/execution/WorkflowGraph.tsx`).

### 2026-11-16 - 5492ff2
Pull request #48 added the onboarding agent. Add project on Home takes a GitHub repository and, optionally, the live app's URL. turtl reads the repository, and one model call judges each readiness item (structured logs, health and readiness checks, journey checks, flags, recovery hooks, test fixtures) as found with file references, missing or unknown, dropping citations of files it did not read. The owner says what must never break and approves once with the passcode; turtl then asks Capy for a pull request adding a `turtl.json` manifest and tests, tracks it, and merges only on the owner's tap. After the merge it calls each declared endpoint and registers only those that answer. Only Expo with a Convex backend is prepared automatically. Proven on a local backend with real OpenAI and Capy calls; the merge itself was refused because GitHub rejected the configured token. Convex features: actions, mutations, crons, tables (`convex/onboarding/`, `app/add-project.tsx`, `app/project/[projectId]/prepare.tsx`).

### 2026-11-16 - ab5c1b1
Pull request #49 set titles and names in the Righteous font, with all other text staying in Capriola. The text component's title variants default to Righteous, a few names opt in, and title letter spacing was loosened to suit it. Checked in Expo web on example data (`components/ui/index.tsx`, `app/_layout.tsx`).

### 2026-11-16 - a6cf577
Pull request #54 added the backend for a turtl GitHub App, so repositories can be reached with short-lived installation tokens instead of one deployment-wide `GITHUB_TOKEN`. It defines the app's permissions in a manifest, signs the app's JWT with Web Crypto, reuses installation tokens until shortly before they expire, and receives installation webhooks at `POST /github/webhook`, checking the signature and applying each delivery once. `repositoryAccess` picks the credential for pull request tracking and the code network build; with no app variables set, both use `GITHUB_TOKEN` as before, and the onboarding agent still reads `GITHUB_TOKEN` directly. Nothing has run against real GitHub: the app does not exist yet, and every path was proven against a stand-in for GitHub's API. Convex features: HTTP actions, internal actions, internal mutations, tables (`convex/github/`, `convex/http.ts`, `convex/pullRequests.ts`, `convex/codeNetwork/build.ts`).

### 2026-11-16 - d67148c
Pull request #55 added the path to an App Store build: `development`, `preview` and `production` EAS profiles, an iPhone-only iOS configuration with a privacy manifest, and a lock that keeps the Dev pill, example data and the demo backend out of preview and production builds. It added CI that typechecks both apps and runs the non-browser tests on every pull request, a hand-started release workflow that refuses to run while the backend has no sign-in, and a table of backend variables with a check that reads names only. Two Release simulator builds ran on a Revyl cloud iPhone against a local backend. No Apple, Expo or production Convex credential exists yet, so no store build, signing or upload has run (`eas.json`, `app.config.ts`, `.github/workflows/`, `release/`).

### 2026-11-16 - f7a20a8
Pull request #57 added what App Review reads apart from the build: a data audit that traces what turtl collects and sends to eight outside services back to lines of code, App Privacy answers, a store listing for EAS Metadata, a review checklist against Apple's guidelines, a screenshot plan, and draft privacy, terms and support pages in a small Jekyll site with a GitHub Pages workflow. A check script holds the pack to the code. The gear sheet links to the three pages on live data only. The pages are not live because GitHub Pages is not switched on, nothing has been sent to App Store Connect, and the links were tapped only in the web preview (`store/`, `site/`, `store.config.json`, `components/legal/LegalLinks.tsx`).

### 2026-11-16 - 6e40dbf
Pull request #53 rewrote the README as the repository's front page, with screenshots from the example data, a diagram and table of the eight case stages, a table of configuration variable names, and the longer reference moved to `docs/`. It was checked against `main` at 8a942f0, so it does not describe the pull requests that landed beside it in #58; its stage table still calls examine broader causes a placeholder, which #45 had already replaced (`README.md`, `docs/`).

### 2026-11-16 - 0b482e4
Pull request #58 landed #56, #45, #46, #47, #50, #48, #49, #54, #55, #57 and #53 together, each with its own merge commit. Only the first two merged cleanly; every other conflict was two branches adding to the same list in a shared registry such as `convex/schema.ts`, `convex/crons.ts` or `data/index.ts`, and each resolution kept both sides. Two tests that load modules through a fixed list of allowed imports broke once the branches met: `tests/preferences.test.mjs` now stubs `./structural`, and `tests/workflow-evidence.test.mjs` now loads `convex/routing/validators.ts`. The combined head passed typecheck and 227 tests and was pushed to a local backend; nothing was deployed.

### 2026-11-15 - fbf6fed
Added `convex/access.ts`, the one place that decides who is calling and whether a project is theirs. With `AUTH_REQUIRED` unset the deployment stays the single-owner demo; with `AUTH_REQUIRED=true` a caller must be signed in and reaches only projects whose `ownerId` is their account. Nothing called it yet (`convex/access.ts`).

### 2026-11-15 - 3a02df0
Pushed notifications to the owner's phone through Expo's push service when a case needs their decision or a fix they allowed in advance has run. The words come from one pure function: the project's name as the title, one fixed sentence per event, and only the case id as data, so no customer's words, error or code can reach a locked screen. A Notifications row in the gear sheet asks the phone only when the owner taps, and a tap opens the case. Proven against a stand-in for Expo in tests and on a local backend; nothing has reached a real phone, which needs an Apple Developer membership. Convex features: tables, mutations, queries, internal actions, scheduled functions (`convex/push/`, `convex/notices.ts`, `components/push/`, `data/push/`).

### 2026-11-15 - 82ad039
Refused to send any deployment secret but the watched app's own token. A check's `credentialRef` names the setting turtl sends as a bearer token, and onboarding read it from a project's `turtl.json`, so with several owners a project could have named `OPENAI_API_KEY` and had turtl send it to that project's server. The request helper now refuses every other name before a request is made (`convex/protectedApp/`, `convex/onboarding/`).

### 2026-11-15 - 74d9b99
Kept Home's header turtle green and greeted an account with no projects with a first-run screen. A project with nothing open now shows what turtl is watching and when each check last passed, a screen that fails to draw says so with "Try again" and "Go to Projects" instead of going blank, and store builds send the old case list and case screen (`/live`, `/case/<id>`) to Projects. Covered by unit tests. Convex features: queries (`app/projects.tsx`, `app/_layout.tsx`, `convex/screens/overview.ts`).

### 2026-11-15 - 848e701
Made the booking demo honour turtl's prevention scenario, so approving "Book while recommendations are slow" can register. A customer's contact is now kept only as a keyed hash used to count one person once, and an owner can delete one report from its case. The report form became a self-contained folder any owner can copy, the microphone prompt now says recordings go to OpenAI, and `eas submit` reads the dynamic store listing. Covered by unit tests (`convex/bookingDemo/`, `convex/intake/`, `protected-app/report/`, `app.config.ts`).

### 2026-11-15 - 8652293
Made every public backend function ask `convex/access.ts` who is calling. With accounts on, another account's project, case or child row reads as missing and writes refuse with the function's own "not found" sentence; with accounts off nothing changes. A signed-in owner replaces the shared passcode in accounts mode, and the unused assistant action was deleted. `tests/access-coverage.test.mjs` parses every module and fails for a public function that does not ask (`convex/`, `tests/access-coverage.test.mjs`).

### 2026-11-15 - 01867f0
Made the case screens match the owner's design and made Approve show what will be sent. The coding agent now receives, word for word, the instructions stored when the fix was proposed, and the Approve sheet shows them behind "See the full instructions", open from the start when a model read customers' messages. Live steps, evidence and actions are named in plain words, the council moved to Logs and the prevention check to Fixes, and the Settings copy was restored. Covered by unit tests (`convex/fixes.ts`, `convex/fixOptions.ts`, `components/fix/`, `data/live/`).

### 2026-11-15 - 9c1cc16
Showed "Can't reach turtl" over an open sheet, so an owner who tapped Approve as the network dropped no longer sees a sheet stuck on "Approving…" with no reason (`app/_layout.tsx`, `components/ui/`).

### 2026-11-15 - 7b26038
Brought this log up to date through #58: one entry per merged pull request, headed by its merge commit, and one for the combination (`hackathon.md`).

### 2026-11-15 - 1792828
Added sign-in with Convex Auth 0.0.98: email and password, Sign in with Apple through the iPhone's own sheet, and GitHub through the same GitHub App that reaches repositories. Accounts are never merged by email. With accounts on, or in a store build, the Login screen signs people in and keeps the app behind it; Google's button is gone. A password reset by emailed code (Resend) switches on only when its key and sender are set, and sends at most one email a minute. Apple's refresh token is kept so it can be revoked later. Proven against stand-ins for Apple, GitHub and Resend; nothing has run against Apple. Convex features: authentication, tables, HTTP actions (`convex/auth.ts`, `convex/auth/`, `app/sign-in.tsx`, `app/sign-up.tsx`, `data/account/`).

### 2026-11-15 - cb56eda
Asked the owner before anything goes to an AI service. Every call to OpenAI, Supermemory, Capy or Keiki now passes a gate that, in accounts mode, refuses until the account has said yes on a screen listing each service and what it receives, read from `store/data-practices.json`; taking the permission back stops the next call. Each account also gets a monthly model allowance ($20 by default) and five coding-agent threads a day. Secrets are masked in repository content before it leaves turtl, and the code map no longer passes OpenAI's raw error text on. Covered by unit tests against stand-ins. Convex features: tables, mutations, queries, internal queries (`convex/consent/`, `convex/spend/`, `convex/codeNetwork/redact.ts`, `app/ai-permission.tsx`).

### 2026-11-16 - a04b384
Listed every variable the backend reads in the release table, so the release check knows each one by name (`release/backend-env.mjs`, `release/backend-runbook.md`).

### 2026-11-16 - a21100e
Let an owner connect GitHub from Add project, pick a repository, and disconnect. turtl never trusts the installation id GitHub puts in the setup address: GitHub confirms the person, and each installation is tied to the account that connected it. Disconnect touches only installations the account actually uses. Proven against a stand-in that plays GitHub and the person's browser, in tests and on a local backend; no real GitHub App exists yet. Convex features: HTTP actions, actions, internal mutations, tables (`convex/github/`, `app/add-project.tsx`).

### 2026-11-16 - 6412a9b
Added `vercel.json`, which builds the Expo web export and answers every path with its single page. With no backend address set, the build shows the built-in example data (`vercel.json`).

### 2026-11-16 - 68ec36c
Kept ordinary text in Capriola and titles in Righteous where a few screens had them the other way round (`components/`, `app/`).

### 2026-11-16 - fb01311
Fixed what running the combined app with accounts on turned up: the project and case sub-screens say "not found" for a project the owner cannot see, a rules-judged Preparation report says "No model answered" once, and the workflow browser test finds Chrome on a Mac (`app/project/`, `tests/workflow-browser.test.mjs`).

### 2026-11-16 - 0e67a4c
Pull request #59 landed the App Store's first wave on `main`: the access rule, push, the first run, the demo-app changes, the case screens, sign-in, the AI permission and spend limits, Connect GitHub, and the fixes above, each with its own merge commit. Nothing was deployed, and no store build has run.

### 2026-11-16 - efea476
Closed findings 3 to 9 and 11 of a security review of accounts mode. Stop and verify cancel a case's scheduled jobs by id instead of reading every account's; a project's overview counts only the caller's own code maps; a push token live on another account is refused; repository access goes only through an installation linked to the project's owner; the backend refuses the demo's deployment-wide variables when accounts are on; customer reports get their own daily allowance and case cap; the deployment caps new accounts, total model spend, projects and report keys; and the password reset stays open to an owner a stranger is trying to lock out. Covered by unit tests (`convex/runner/jobs.ts`, `convex/spend/`, `convex/auth/email.ts`, `convex/demoSettings.ts`, `convex/github/access.ts`).

### 2026-11-16 - afb1506
Set every piece of text that is not a full sentence (titles, names, labels, status words, counts, dates) in Righteous, and sentences in Capriola. The text component decides from the words it draws; errors, chat messages and quoted words are set in Capriola by hand. A follow-up, 826ed48, set the last few fonts the rule needed (`components/ui/typeface.ts`, `components/ui/index.tsx`).

### 2026-11-16 - 17fb5ff
Redesigned the issue list and the opened issue. The list takes the top half of the screen as compact rows (state turtle, title, date) with "Swipe up to begin review" below, and a green drop carries one screen into the next. An opened issue is headed by its own name, the Overview, Logs and Code tabs each have their own colour and regroup around the selected one, and Fixes is its own page, reached by swiping past the end of the issue or a button. Covered by unit tests and the UI citation test (`components/project/BeginScreen.tsx`, `components/fix/CasePage.tsx`, `components/fix/CaseTabs.tsx`, `components/ui/pulse.tsx`).

### 2026-11-16 - 36717d5
Let an owner delete their account from the app: "Delete account" under Sign out, in the gear sheet and in the account sheet behind Home's profile picture, only for a signed-in account. Accepting it ends every session and removes the ways to sign in at once; a resumable job then stops the account's work, waits for running actions to finish, deletes its copies at Supermemory, disconnects its GitHub installations, revokes its Apple token, and deletes its projects, cases, files and the account. A test fails for any table the deletion does not cover. Proven on a local backend against stand-ins for Supermemory, GitHub and Apple. Convex features: mutations, actions, crons, scheduled functions, file storage (`convex/account/`, `components/account/`).

### 2026-11-16 - b2e0e4b
Gave each project its own control token and each account its own coding agent key, sealed with AES-GCM under `SECRETS_ENCRYPTION_KEY` and never returned by a public function. With accounts on, turtl sends a project's requests only to its own address with its own token, watches every project in turns, and starts every Capy thread with the owner's own key on a repository the owner connected. Owners can make, see and revoke their project's report keys, Revyl is sent only its own key, and every GitHub call goes through one address. Proven in tests and on a local backend. Convex features: actions, internal mutations, tables (`convex/secrets/`, `convex/protectedApp/`, `convex/prTracking/codingAgent.ts`, `components/secrets/`).

### 2026-11-16 - c312a93
Pull request #60 made ten interface fixes from a critique of every screen: "Log in" and "Projects" said the same way everywhere, every control at least 44 points, green text that passes contrast in the light theme, project names kept whole at 320 wide, empty states on two bare screens, a feature request no longer called an urgent issue, and the Fix and Features lists usable with a mouse and a trackpad (`app/`, `components/`, `theme/`).

### 2026-11-16 - 2f99bfe
Merged `main`, with #60, into the wave-2 branch. The issue list keeps the redesigned layout and takes #60's state words and turtles; #60's sideways card strip, which the redesign removed, goes with its test. Typecheck, the backend typecheck, 453 tests, a local Convex push and the release preflight passed; nothing was deployed.

### 2026-11-16 - 065f727
Pull request #61 landed the App Store's second wave on `main`: the security review's fixes, account deletion, each project's own control token and each account's own coding agent key, the redesigned issue list and case screens, the typeface rule, and the critique's ten fixes. Nothing was deployed, and no store build has run.

### 2026-11-16 - b127289
Fixed what a second pass over the combined app found on a local backend with accounts on: stars stored on the case through an access-checked mutation, Logs without database ids, run ids or error codes, missing services and settings named in plain words, a project whose repository could not be read no longer saying "All clear", the Dev pill and the old case list hidden with accounts on, and the running-fix screen held together at 320 wide.

### 2026-11-16 - 00037c4
Brought every document up to the wave-2 commit: a new data-practices audit, App Privacy answers with Email Address, Name, User ID and Device ID, a privacy policy, terms and support page that describe accounts, deletion, notifications, emails and the AI permission, 50 more checklist lines ticked with their proof, and the review notes, README, this log and `docs/`. The permission screen's list now names what each AI service really receives, so every account is asked again.

### 2026-11-16 - 480fc17
Fixed what the second test pass found in files other work owned at the time: the control token row is right the moment a token is saved, owners no longer read setting names (they go to the backend log), journey text no longer carries error codes or run ids, the approval step's time leaves out the wait for the owner, and a case that closed because turtl could not reach the app says so and what to do. Such a case stays closed; a new check or report opens a new one.

### 2026-11-16 - ae4798f
Added the practice project (`convex/practice/`): a signed-in account can make one from the first-run screen or Add project, and turtl serves a small booking app for it at the deployment's own address under `/practice/<project>/`, with the project's own control token. The owner breaks it from the project page, up to ten times a day, turtl's ordinary watching opens a case, and the ordinary flow fixes it. It has no repository, never calls GitHub or a coding agent, and goes with the account. `practice/review:prepare` gives the App Review account its project with a case open.

### 2026-11-16 - e6324d9
Made turtl act on GitHub only where the person may change things: Connect GitHub links only repositories the person can push to and says why each other one is missing, turtl asks GitHub again before a merge or coding-agent work, and disconnecting or deleting an account uninstalls only an installation on the person's own GitHub account that no other account uses. An organisation's installation is unlinked, and the person is told who can remove it.

### 2026-11-16 - 8011d60
Made the accounts switch fail closed: `AUTH_REQUIRED` unset, empty or `false` is the single-owner demo and any other value turns accounts on, and the demo refuses to serve a deployment that holds any account. Every public function is now made with the builders in `convex/functions.ts`, which check that first, and a test fails for one that is not. Signing out removes the phone's push registration, GitHub's actions check that the session is alive, Apple refresh tokens are sealed at rest, and Keiki's and Revyl's base addresses are honoured only for a stand-in on a local backend.

### 2026-11-16 - e44afc7
Made the four local proofs true of the fail-closed rule: each shows the demo on a backend with no account, then the refusal once an account exists, both the sentence the caller reads and the line in the backend log. The secrets proof had passed for the wrong reason and now seeds a sign-in row for each owner.

### 2026-11-16 - a189b62
Made sign-up confirm the email address: a password account reads as signed out everywhere and sees only "Check your email" until it enters the code turtl emails through Resend, and one that never confirms is deleted after seven days. Reset and confirmation codes are twenty characters, arrive as a `turtl://` link and as text to paste, work for a day, and at most five of each kind go to one address a day. A completed reset ends every other session. Password sign-ups, confirmations, and Apple and GitHub sign-ups each have their own hourly and daily ceilings.

### 2026-11-16 - ad3d5cb
Brought the practice proof and the App Review account under confirmed sign-up: the proof's two accounts confirm with the code the stand-in received, `auth/review:ensureAccount` marks the review account's address confirmed, and `practice/review:prepare` refuses an account that is not confirmed.

### 2026-11-16 - 4e92400
Gave each account a daily share of the deployment's AI ceiling, and another for its customers' reports, admitted in the same transaction that checks the share, with the end of each day kept for diagnosing outages. When a ceiling is reached turtl says why and explains with its own rules; the case still opens. The monitor now keeps a next-check time for each project that has checks and starts one action for each due project, checking a project that fails the same way after 1, 2, 4, 8, then every 15 minutes. Pull-request and preparation syncing take due rows in bounded batches, and a live address must use the default https port.

### 2026-11-16 - 275159d
Went through the practice project as a new person would, from sign-up to account deletion, at both widths and in both themes. The flow worked; the wording did not, in places: the example build no longer opens a backend connection, step ids read as words, turtl's own reading says what it knows without guessing at a cause, a broken practice app says "Practice app broken" instead of "Users affected", and the empty repository picker fits both kinds of person.

### 2026-11-16 - 65ddc8c
Bounded six more reads that grew without limit: settling agent runs now looks at each waiting run on its own schedule through an index, and settles one that never finishes after 30 days; the structural step reads the newest 200 cases; past-case notes, a memory's uses, the day's council reviews and context sources read a bounded number of rows. `tests/bounded-reads.test.mjs` requires it.

### 2026-11-16 - 9c2d407
Made a phone receive notifications only while the session that registered it is alive, so a lost phone stops receiving project names once its owner resets their password elsewhere. A reset removes the account's ended phones at once and an hourly sweep removes the rest; registrations from before the change receive nothing until the app is opened signed in to the same account.

### 2026-11-16 - 8686894
Took the bigger items from the practice pass: the theme a person chooses is kept across launches and read before the first screen draws, the running-fix screen shows Stop only while a fix is under way and Merge only for an open pull request, an empty Fix list on a project whose check is still failing says why no issue is open, the practice sheet at its daily limit says when it resets, the two checks a case records are labelled, and turtl offers typing in place of talking only when typing would work.

### 2026-11-16 - d0d28bb
Made the checks panel show the warning triangle in the failing colour while any check is failing, instead of a green shield above a row that said "Not passing".

### 2026-11-16 - a2fcd6e
Sent basic security headers with the web export (`vercel.json`): no content sniffing, no framing by other sites, a referrer limited to the origin across sites, and no camera or location, with the microphone kept for the page itself because Talk uses it.

### 2026-11-16 - f5625a1
Made every document true of wave 3, and took Keiki off the AI permission screen: accounts mode never sent it anything, so it is now demo-only like the council's Anthropic and Google models, and the gate refuses it with accounts on. The sentence under the list now says the screen asks only about AI services and that turtl uses the others each for one job. Each account is asked about AI once more because the list changed.

### 2026-11-16 - d7397ae
Made the Delete account screen say what Disconnect and the privacy policy already said: turtl's app stays installed on an organization's GitHub until one of its owners removes it.

### 2026-11-16 - 0065cf3
Kept the outage reserve for real outages on established projects: it admits only a case the monitor raised on a project that is not a practice app, whose check had passed for a day before it failed, on an account at least two weeks old. A practice app's cases get their own $2.00 a day and never draw on the reserve, and a call's cost estimate counts the bytes sent. About twenty-two established accounts acting together can still use up a day; the operator's settings for that are in the runbook.

### 2026-11-16 - 8c5a028
Closed the gaps in masking secrets before repository content leaves: nothing from a secret file leaves in any form, text is masked before it is shortened, every string the onboarding inspection sends has been masked, and more shapes of secret are recognised while lockfile hashes, digests, commit hashes and ids are kept. On a realistic repository it changes no ordinary line and lets no planted secret through.

### 2026-11-16 - ab9a02f
Made reset and confirmation links carry only the code, so a link someone else sends cannot set a password on, or sign anyone into, another account; the reset screen uses the address this phone last asked to reset, kept for a day, and says whose account is about to change. One email domain may take a tenth of each sign-up ceiling (a large mail provider a half), and `EMAILS_PER_DAY` bounds every email turtl sends, of which sign-ups may use at most two thirds, so a flood of sign-ups cannot take an owner's reset.

### 2026-11-16 - 56105ee
Closed the demo on a deployment that holds accounts: with `AUTH_REQUIRED` unset there, the monitor, customer reports, the AI permission gate, GitHub's pages and webhook, requests to owners' apps, the runner and push delivery refuse too, with one log line a day saying why. A project's live address may no longer be the deployment's own site or API; a practice project is the one exception, for its own path only.

### 2026-11-16 - b019a6e
Fixed a step of the local proof for each project's own control token, which assumed every monitor tick checks every project. It now waits for that project's own next check and proves the same things as before.

### 2026-11-16 - a00a2e2
Refused turtl's own address as a project's live app however its host is spelled: addresses are compared as the network reads them, in lower case and without a trailing dot, so a variant spelling of the backend's own address no longer gets through.

### 2026-11-16 - b52d84b
Brought every document to the finished wave-3 code and pinned the App Store pack's audit to `56105ee`: emails that carry only a code, secret masking, the closed demo, the outage reserve and the practice allowance, and what the app keeps on the phone. A read of the site as an owner would read it fixed an over-claim about deletion and added answers on resets and on apps that do not answer.

### 2026-11-16 - 937a361
Made sure a full day of emails cannot stop an owner's reset: each confirmed address's first reset email of the day is sent even when `EMAILS_PER_DAY` is used up, and a sign-up that cannot be emailed now makes no account and offers Sign in with Apple or GitHub, or an email address tomorrow.

### 2026-11-16 - 4eea484
Made sure an owner's own outage is always diagnosed: each account has $1.25 a day (`OUTAGE_FLOOR_PER_DAY_USD`), outside the shared day, for finding the cause of an outage turtl's checks found on its own real project, which no other account can use up. A practice app's allowance now sits inside the account's own share.

### 2026-11-16 - 9d5bb95
Put a hard stop on what the deployment spends on AI in a day (`DEPLOYMENT_MODEL_HARD_STOP_PER_DAY_USD`, twice the daily ceiling unless set, $50 with the defaults), the shared day and every account's floor together, so a month costs at most $1,550.

### 2026-11-16 - b173a40
Documented the outage floor, the hard stop, the first reset of the day and the stricter own-address rule, and pinned the App Store pack's audit to `9d5bb95`.

### 2026-11-16 - fb2a04b
Made a failed model call give its hold back: a call the AI service refuses with an error status releases its hold at once, and one that times out keeps it for ten minutes and is then counted at its hold, settled by a sweep each minute (`modelCallHolds`). No hold lasts until midnight any more.

### 2026-11-16 - 1361273
Opened a case when an owner's app stops answering: three of the monitor's tries in a row of a check with no usable reply (no reply within 30 seconds, a failed connection, or no check result) open one "Not answering" case for the project, at most 10 a day, with a push, and it closes with a second push when the app answers again, or unresolved when turtl stops checking. turtl makes no model call on it and it never reaches the outage floor or reserve. Before it opens, turtl holds it while its own site gives no reply, a 5xx or a 429, or while at least five other projects that answered in the last half hour have all gone quiet; practice projects never get one. Each check keeps a count of unanswered tries and each watched project when it last got a usable reply (`convex/protectedApp/notAnswering.ts`, `convex/monitor.ts`, `convex/push/message.ts`).

### 2026-11-16 - 9d8e87b
Gave a not-answering case its own screens: it is titled "Your app stopped answering", shows in the issue list as urgent with the word "Not answering" and nothing to swipe into, and its page has nothing to approve. Open, the page says what turtl saw, names three places to look (the host's status page, the last deploy, the app's address opened by hand) and says turtl keeps checking, up to every 15 minutes; closed, it reads all clear only when every check passed on return, and needing the owner when turtl stopped checking. A check the app gives no answer to reads "Not answering" on the project, and a project whose only issue is one of these offers "See the issue" (`data/live/caseMapping.ts`, `components/project/issueState.ts`, `components/project/Watching.tsx`).

### 2026-11-16 - 47ff350
Stopped health and readiness checks from raising false alarms: only a journey check that has passed at least once can stop answering (`canStopAnswering` in `convex/protectedApp/watching.ts`). Health and readiness endpoints never give the monitor a check result, and a check that has never passed has not answered yet, so neither keeps a count, opens a case or shows as not answering. Nothing retires a check yet, so a route an owner removes keeps its case open until it is back.

### 2026-11-16 - 1fccf26
Brought every document to not-answering cases and pinned the App Store pack's audit to `c38bf0e`: the README, the support page, the privacy policy and terms, the data practices and review checklist, the review notes, the runbook's new log section, and the data model, with what is not examined and the gap that no check is retired stated plainly.

### 2026-11-16 - fb424d5
Made a not-answering case mean what its title says: the app gives turtl nothing at all. A try is quiet only with no response or a reply of 500 or above with no check result; any reply below 500 (a 404, a 401, a 429, a redirect) is an answer, so a removed route or a rotated token no longer reads as an outage. A case opens only when every countable check sent is quiet three times in a row and no check in the round answered, and closes as soon as any check answers. The project records its open case (`apps.notAnsweringCase`), practice projects are no evidence in the fleet check, and a fleet hold ends once the project has been quiet for 30 minutes (`convex/protectedApp/notAnswering.ts`, `convex/monitor.ts`, `convex/schema.ts`).

### 2026-11-16 - 8b4f4da
Brought the documents to that revision: what counts as quiet, when a case opens and closes, the new field, and what the rule gives up (a check whose route is gone, an app that answers everything below 500, one check failing while another answers, projects with no journey that has passed).

### 2026-11-16 - 0e66f7a
Counted only a check result as the app answering: a reply below 500 with no result (a 404, a 401, a redirect, a page a proxy or CDN sends by itself) is unreadable and counts for nothing either way, so a front layer that answers for a stopped app no longer hides the outage. A case opens when the countable checks that gave a result or went quiet are all at three and no check gave a result; it closes on any result, and closes quietly when turtl can no longer tell because its checks get only replies it cannot read. A verify step's pass closes the case only if seen after it opened (`convex/protectedApp/notAnswering.ts`, `convex/monitor.ts`, `data/live/caseMapping.ts`).

### 2026-11-16 - 59a4dac
Brought the documents to that revision, with the third revision's list of what turtl gives up: unreadable checks, hosts that serve a page for a stopped app, one check failing beside one with a result, projects with no countable check, a lone readable check's 5xx, alerts up to half an hour late while turtl suspects itself, and more than one push when an outage turns unreadable for a round.

### 2026-11-17 - c03efd4
Let a round that finishes after a newer one decide nothing: when any of its tries is older than what its check already has on record, it changes no count for that check and neither opens nor closes a not-answering case, so a late round can no longer close the case on its health check's reply alone; the next round decides (`convex/protectedApp/notAnswering.ts`).

### 2026-11-17 - acba95b
Said so in the documents, added the fourth review's two limits (a case closes as "can no longer tell" when a rotated control token stops its checks mid-outage; the fleet check reads any reply below 500 as turtl's requests getting out), and pinned the App Store pack's audit to `c03efd4`.

### 2026-11-17 - 72dc762
Sent health and readiness checks as what they are: the monitor sends each as a GET and reads it as registration does, where a 200 passes and a readiness check's 503 with a body is the app saying it is not ready (`readProbe` in `convex/protectedApp/client.ts`). Before, every check got a POST under the journey contract, so these two never gave a result and read "Passed" from the day they were registered. A pass now moves when the check last passed, and a quiet one shows on the project at three in a row as "Not answering" or "Not ready". A project with a journey check that has ever passed is still decided by its journey checks alone, so a proxy answering `/health` by itself neither stops its not-answering case nor closes it; a project with none is decided by its probes (`probesDecide` in `convex/protectedApp/watching.ts`). A probe never opens an ordinary case, and a customer's report attaches a journey check, never a probe.

Retired the checks a project's `turtl.json` no longer lists: Check again reads the file as it is now on the preparation's branch (before, the merge commit every time, so the list could never change), and a registration that succeeds stamps `retiredAt` on each of its own rows the file dropped, keeps the row for the cases and verifications that point at it, and leaves it out of the monitor, the not-answering rule, the project and a customer's report (`liveChecks`). Listing it again revives the row, and at most 25 retired rows are kept (`convex/onboarding/records.ts`).

### 2026-11-17 - 9757de7
Fixed what an independent review of that change found (nothing High or Medium): rounds that outlive their lease decide again beside a passing health check, since only a check that decides can make a round superseded; a slow Check again that ends after a newer one writes nothing, each registration being named by when it was started; a check that turns from a probe into a journey check under the same name, and a revived check's run of passes, start again; registration matches a name only among the rows it owns, so it no longer writes over a prevention check; a customer's report attaches no prevention check; and Check again reads the repository's default branch when the preparation's branch is gone.

### 2026-11-17 - 75b654f
After a second review pass found the fixes sound, said which branch Check again read when it was not the preparation's, and added a test for each of the four lines that pass found untested.

### 2026-11-17 - 3f67039
Said all of it in the documents, with what it gives up (a probe-only project is not told while something in front of the app answers its health route, and is told when the health route itself errors; beside journey checks a quiet probe only shows on the project), and pinned the App Store pack's audit to `75b654f`.
