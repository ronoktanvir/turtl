# Dev tools

Development-only controls create a sample app and sample cases (one outage, one bug report, one feature request, each with its eight steps) and move them through their steps, so the app can be shown and tested without real detection. Two switches must both be on, or the app shows no trace of the tools:

- **Server:** the Convex environment variable `DEV_TOOLS_ENABLED` must be `true`, and the deployment must be the single-owner demo (`AUTH_REQUIRED` unset). With accounts on the tools stay closed whatever the variable says (`devToolsEnabled()` in [`convex/access.ts`](../convex/access.ts)). Otherwise every function in [`convex/dev.ts`](../convex/dev.ts) except `status` refuses to run, and so do the other dev-only functions (`fixes.devThreeFixCase`, `intake/dev:bookingKey`, `codeNetwork/dev:loadSeed`, `structural/dev`, the dev-only pull request functions in `convex/pullRequests.ts`, and `memory/dev`). The internal `memory/reset` functions check `DEV_TOOLS_ENABLED` too. Turn it on for your deployment with `npx convex env set DEV_TOOLS_ENABLED true`; never set it in production.
- **Client:** the app renders the "Dev" pill only in a development build environment (`EXPO_PUBLIC_APP_ENV` empty or `development`; the `preview` and `production` profiles in `eas.json` lock it out), when a backend URL is configured, when `__DEV__` is true (a development build) or `EXPO_PUBLIC_DEV_TOOLS` is `1`, and only when the server reports the tools as enabled ([`data/source.ts`](../data/source.ts)).

The local proofs (`convex/push/localProof.ts`, `convex/secrets/localProof.ts`, `convex/account/localProof.ts`, `convex/evidence/localProof.ts`) are separate: they refuse anything but a backend running on localhost.

The pill opens a panel in three groups.

**Sample cases**

- **New sample cases** creates one case of each kind.
- **Advance** starts the next step, or finishes the running one, on the first unfinished sample case.
- **Auto-run** takes all unfinished sample cases to done, about one step every 1.2 seconds.
- **Reset samples** deletes the sample cases, their steps and attempts, and the sample app.

**Live runs**, whose steps run on the backend runner by themselves:

- **Start live run** creates a case that stops at "Waiting for you".
- **Approve** and **Decline** decide it.
- **Clear live runs** removes those cases.

**Booking app**, which acts on the booking demo hosted on the same deployment (see [`convex/bookingDemo/README.md`](../convex/bookingDemo/README.md)):

- **Register booking app** and **Check now**.
- **Stage outage (staged)**, **Clear staged outage**, **Stage store failure (staged)** and **Clear staged store failure**.
- **Reset booking (deletes incident history)** and **Owner: turn recommendations on**.
- **Approve proposal** and **Decline proposal** for the booking case that waits for the owner.

These controls change a shared live backend and can message the owner, so leave them alone on a deployment someone else is using.

When the client switch is on and a backend URL is configured, Projects also links to the older live case feed ("Live cases", `/live`). A store build sends `/live` and `/case/<id>` to Projects.
