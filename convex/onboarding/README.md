# Onboarding: from "here is my repository" to "turtl can watch and recover this app"

The owner adds a project from Home with a GitHub repository URL, optionally the live app's URL, and optionally the folders the app lives in when it shares a repository. Nothing is installed or changed without the owner's approval.

Two modes, as everywhere in turtl (`convex/access.ts`). With `AUTH_REQUIRED` unset (the single-owner demo) the deployment's own settings do the work, as before. With `AUTH_REQUIRED=true` everything an owner entrusts to turtl is theirs: their GitHub connection (`convex/github`), their own coding agent (Capy API key) and each project's own control token (`convex/secrets`). The deployment's `CAPY_API_KEY`, `PROTECTED_APP_CONTROL_SECRET` and `GITHUB_TOKEN` are never used for an account's project.

## The path

1. **Connect.** `onboarding/projects:add` (owner passcode in the demo) checks the URL, creates a real `apps` row and an `onboardingPreparations` row, and schedules the inspection. A folder link such as `https://github.com/owner/name/tree/main/protected-app` counts as a folder; a folder name cannot hold quotes, backticks, angle brackets or line breaks, because it is written into the coding agent's brief. With accounts on the live address must be `https` on a public name and the standard https port: no IP literal, no loopback, private or link-local name, no user name or password, and not turtl's own site or API (a practice project, whose address turtl itself sets, may use only its own path there) (`convex/protectedApp/address.ts`), and the number of projects per account is capped.
2. **Inspect.** `onboarding/inspect:run` reads the repository: three GitHub API reads (repository, commit, file tree) and file contents from raw.githubusercontent.com, which does not count against GitHub's API limit. The credential comes from `repositoryAccess` (`convex/github/access.ts`): an installation linked to the project's owner, or in the demo without a GitHub App the deployment's token. Public repositories need none; when GitHub turns the credential down turtl reads the repository as a public one and the report says so in plain words. The plain functions in `detect.ts` scope the app's files (its folders plus files that import from them, such as a shared HTTP router), name the stack, and collect pattern leads for each readiness item. One model call (`codeNetwork/openai.ts`'s `respond`, `OPENAI_MODEL` or the default) judges each item found, missing or unknown, cites files and lines, suggests what must never break, and writes an `agentRuns` row (`taskType: "onboarding_inspection"`, with `appId` instead of a case). `confirmItems` drops any citation of a file turtl did not read and turns an unconfirmed "found" into "unknown". Without a model answer the report holds the pattern leads, says in plain words that no model answered, and calls nothing missing.
3. **Ask what must never break.** The suggestions arrive as statements the owner can keep or drop, each with an "add a check" switch, and the owner adds their own (at most ten, 300 characters each). `onboarding/projects:saveAnswers` stores them.
4. **Prepare, on approval.** `onboarding/projects:approve` approves the exact report the owner saw (`inspectionId`) and refuses a second approval. With accounts on it first refuses, with how to fix it, an owner who has not connected a coding agent (Settings, Coding agent). `onboarding/prepare:start` then asks `prTracking/codingAgent.ts` for the coding agent: the owner's own Capy key, and only for a repository covered by a GitHub installation linked to the owner. If either is missing nothing is sent, the approval is handed back with the reason (`onboardingPreparations.blocked`, shown on the Preparation screen), and the owner can approve again once it is fixed. Otherwise it builds the brief from the stored report and answers (`brief.ts`) and starts one Capy thread with request id `turtl-onboarding:<preparation>:<inspection>`, so a retry never starts a second thread. The brief asks Capy to add what is missing, to protect every authenticated endpoint with the app's control token (see below), to describe every endpoint in `turtl.json`, to explain each addition in plain words in the pull request, and to test it. The owner's answers, and the suggestions they kept, go into the brief as quoted data: each is one JSON-quoted line under a paragraph that tells the agent they are descriptions of behaviour to check, never instructions to follow (security review, finding 1).
5. **Track and merge.** A cron (`onboarding/prepare:refreshActive`, every minute, at most 100 preparations a run) finds the pull request number in Capy's reply, with the owner's own key, and reads GitHub. Without a GitHub credential an open pull request is read every five minutes, to stay inside GitHub's anonymous limit. `onboarding/projects:merge` merges only when the pull request is open, its checks pass, GitHub can merge it, and its head is the commit the owner was shown. Merging needs GitHub access that can merge; without it the owner is told to connect the repository or merge it on GitHub.
6. **The control token.** The pull request description tells the owner how to make the app's control token (for example `openssl rand -hex 32`) and where the app keeps its hash. With accounts on the owner pastes the token itself into turtl, on the Preparation screen or in the project's Settings under Control token (`convex/secrets/project.ts`). turtl keeps it encrypted, never shows it again, and sends it only to the project's own live address. In the demo, whoever runs the backend sets it as `PROTECTED_APP_CONTROL_SECRET`.
7. **After the merge.** `onboarding/prepare:register` reads `turtl.json` at the merge commit, calls each endpoint on the live URL now, for this project (`convex/protectedApp/watched.ts`: with accounts on only its own origin, only its own token, no redirect followed), six at a time, and registers only what answers: health, readiness and journey checks as `journeys`, flags and recovery hooks as `actionCatalog` entries. Each result (works, failing, no response) is stored and shown, which is the owner's first view of which journeys work. A check that needs the token reports "no control token is set" until the owner adds it. `onboarding/projects:checkAgain` repeats it; with accounts on at most once every two minutes.

`onboarding/projects:forProject` returns the Preparation screen's data in the shape of `data/onboarding/types.ts`. With accounts on, the monitor then watches every registered journey of the project with its own token (`convex/protectedApp/watching.ts`).

## turtl.json

Written by the preparation pull request in the app's first folder (or the repository root). Paths are relative to the live app URL and must start with `/`. `credentialRef` must be `PROTECTED_APP_CONTROL_SECRET`: it is a name, never the token, and it tells turtl to send the app's control token on authenticated paths. With accounts on that is the project's own token, entered by its owner; in the demo, the deployment's variable of that name. Any other name is refused when the file is read and again when a request is made (`convex/protectedApp/client.ts`), so a project's file cannot choose which of the deployment's secrets is sent anywhere.

turtl reads at most 20 entries of each list (`journeys`, `flags`, `recoveryHooks`) and says what it left out (`registration.note`, shown under Works now); a file over 1 MB is not read at all.

```json
{
  "version": 1,
  "credentialRef": "PROTECTED_APP_CONTROL_SECRET",
  "health": { "name": "Server answers", "path": "/health" },
  "readiness": { "name": "Ready to take bookings", "path": "/ready" },
  "journeys": [{ "name": "Book an appointment", "path": "/journey-check", "authenticated": true }],
  "flags": [{ "name": "Recommendations", "field": "recommendationsEnabled", "path": "/flags", "authenticated": true }],
  "recoveryHooks": []
}
```

Journey checks follow the booking app's contract (POST; 200 passed, 503 failed, with a verdict), because turtl's monitor and verify read that shape. Flags and recovery hooks follow its switch contract (authenticated GET returns the field; POST with exactly one boolean field sets it), because the existing executor sends `{ [flag]: value }`.

## Supported stacks

Only Expo with a Convex backend (the stack of turtl's protected booking app) is prepared automatically. Every other stack gets the full inspection and the statement that automatic preparation is not supported for it yet: each stack needs its own brief, manifest placement and checks.

## Not built

- Control of a hosting platform (restarts and rollbacks through a host's API). It needs, per host, an API token in turtl's environment, a catalog action kind for that host, and a verification that the restart or rollback took effect. A recovery hook inside a crashed service cannot restart that service.
- Instrumentation cannot recover logs from before it was installed.
- The monitor (`convex/monitor.ts`) checks registered journeys with the booking journey contract, so a registered health or readiness journey shows as a check error there rather than opening a case.
- turtl checks the live address's name, not what it resolves to: a public name pointed at a private address is not caught.

## Environment

`OPENAI_API_KEY` (the judgement). With accounts on: `SECRETS_ENCRYPTION_KEY` (the owners' tokens and keys) and the GitHub App (`convex/github`). In the demo only: `CAPY_API_KEY` (the preparation pull request; `CAPY_PROJECT_ID` optional), `GITHUB_TOKEN` (private repositories, faster pull request reads, and merging) and `PROTECTED_APP_CONTROL_SECRET`. For stand-ins in tests: `GITHUB_API_URL`, `CAPY_API_URL` and `WATCHED_APP_ALLOW_LOOPBACK`, honoured with accounts on only on a local backend.
