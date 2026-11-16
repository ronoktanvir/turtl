# Dev tools

Development-only controls create a sample app and sample cases (one outage, one bug report, one feature request, each with its eight steps) and move them through their steps, so the app can be shown and tested without real detection. Two switches must both be on, or the app shows no trace of the tools:

- **Server:** the Convex environment variable `DEV_TOOLS_ENABLED` must be `true`. Without it, every function in [`convex/dev.ts`](../convex/dev.ts) except `status` refuses to run, and so do the other dev-only functions (`fixes.devThreeFixCase`, `intake/dev:bookingKey`, `codeNetwork/dev:loadSeed`, the dev-only pull request functions in `convex/pullRequests.ts`, and `memory/dev` and `memory/reset`). Turn it on for your deployment with `npx convex env set DEV_TOOLS_ENABLED true`.
- **Client:** the app renders the "Dev" pill only when a backend URL is configured, when `__DEV__` is true (a development build) or `EXPO_PUBLIC_DEV_TOOLS` is `1` (set it in `.env.local` or in the build environment for a release build), and only when the server reports the tools as enabled.

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

When the client switch is on and a backend URL is configured, Projects also links to the older live case feed ("Live cases", `/live`).
