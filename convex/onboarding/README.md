# Onboarding: from "here is my repository" to "turtl can watch and recover this app"

The owner adds a project from Home with a GitHub repository URL, optionally the live app's URL, and optionally the folders the app lives in when it shares a repository. Nothing is installed or changed without the owner's approval.

## The path

1. **Connect.** `onboarding/projects:add` (owner passcode) checks the URL, creates a real `apps` row and an `onboardingPreparations` row, and schedules the inspection. A folder link such as `https://github.com/owner/name/tree/main/protected-app` counts as a folder.
2. **Inspect.** `onboarding/inspect:run` reads the repository: three GitHub API reads (repository, commit, file tree) and file contents from raw.githubusercontent.com, which does not count against GitHub's API limit. Public repositories need no token. When `GITHUB_TOKEN` is missing or GitHub rejects it (401), turtl reads without it and the report says so; a private repository then fails with a plain message naming the token. The plain functions in `detect.ts` scope the app's files (its folders plus files that import from them, such as a shared HTTP router), name the stack, and collect pattern leads for each readiness item. One model call (`codeNetwork/openai.ts`'s `respond`, `OPENAI_MODEL` or the default) judges each item found, missing or unknown, cites files and lines, suggests what must never break, and writes an `agentRuns` row (`taskType: "onboarding_inspection"`, with `appId` instead of a case). `confirmItems` drops any citation of a file turtl did not read and turns an unconfirmed "found" into "unknown". Without a model answer the report holds the pattern leads, says no model answered, and calls nothing missing.
3. **Ask what must never break.** The suggestions arrive as statements the owner can keep or drop, each with an "add a check" switch, and the owner adds their own. `onboarding/projects:saveAnswers` stores them.
4. **Prepare, on approval.** `onboarding/projects:approve` (owner passcode) approves the exact report the owner saw (`inspectionId`) and refuses a second approval. `onboarding/prepare:start` builds the brief from the stored report and answers (`brief.ts`) and starts one Capy thread through `prTracking/capy.ts` with request id `turtl-onboarding:<preparation>:<inspection>`, so a retry never starts a second thread. The brief asks Capy to add what is missing, to describe every endpoint in `turtl.json`, to explain each addition in plain words in the pull request, and to test it.
5. **Track and merge.** A cron (`onboarding/prepare:refreshActive`, every minute) finds the pull request number in Capy's reply and reads GitHub. Without a working `GITHUB_TOKEN` an open pull request is read every five minutes, to stay inside GitHub's anonymous limit. `onboarding/projects:merge` (owner passcode, configured) merges only when the pull request is open, its checks pass, GitHub can merge it, and its head is the commit the owner was shown. Merging needs a token that can merge.
6. **After the merge.** `onboarding/prepare:register` reads `turtl.json` at the merge commit, calls each endpoint on the live URL now, and registers only what answers: health, readiness and journey checks as `journeys`, flags and recovery hooks as `actionCatalog` entries. Each result (works, failing, no response) is stored and shown, which is the owner's first view of which journeys work. `onboarding/projects:checkAgain` (owner passcode) repeats it.

`onboarding/projects:forProject` returns the Preparation screen's data in the shape of `data/onboarding/types.ts`.

## turtl.json

Written by the preparation pull request in the app's first folder (or the repository root). Paths are relative to the live app URL. `credentialRef` must be `PROTECTED_APP_CONTROL_SECRET`, the one setting on turtl's deployment that it will send as the bearer token for authenticated paths; it is never the secret itself. Any other name is refused when the file is read and again when a request is made (`convex/protectedApp/client.ts`), so a project's file cannot choose which of the deployment's secrets is sent to that project's server.

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
- GitHub sign-in: the owner pastes a URL.
- Instrumentation cannot recover logs from before it was installed.
- The monitor (`convex/monitor.ts`) checks registered journeys with the booking journey contract, so a registered health or readiness journey shows as a check error there rather than opening a case.

## Environment

`OPENAI_API_KEY` (the judgement), `CAPY_API_KEY` (the preparation pull request; `CAPY_PROJECT_ID` optional), `GITHUB_TOKEN` (private repositories, faster pull request reads, and merging), and the variable each `turtl.json` names as `credentialRef`.
