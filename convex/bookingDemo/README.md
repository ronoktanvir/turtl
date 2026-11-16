# Protected booking backend: shared-hosting demo shortcut

This is the booking app turtl protects. It shares turtl's Convex deployment **only as a hosting shortcut for the demo**, because a second Convex project was not available in time. The on-call app must not import booking functions or read booking tables. Its only integration path remains HTTP through `convex/protectedApp/client.ts`. The schema composes the booking validators, but application logic remains separate.

The weakened boundary is credential isolation: turtl's caller secret (`PROTECTED_APP_CONTROL_SECRET`) and the booking verifier's hash (`PROTECTED_APP_CONTROL_SECRET_SHA256`) now occupy the same deployment environment. The verifier still reads only the hash; this co-location does not provide independent secret isolation. No new cross-app imports, table reads, or privileged internal shortcuts are introduced.

## Namespaces and contract

- Customer functions are `api.bookingDemo.booking.getCatalog`, `getFlags`, `recommendations`, and `submit`. They require no sign-in and never change control settings.
- Booking data uses only `bookingDemoSettings`, `bookingDemoBookings`, and `bookingDemoAttempts`. Bare `settings`, `bookings`, and `bookingAttempts` are unused; no migration from or dependency on those accidental empty tables is needed.
- The unchanged HTTP control contract is mounted at `/booking-demo/health`, `/booking-demo/revision`, `/booking-demo/flags`, `/booking-demo/staged-failure`, `/booking-demo/journey-check`, and `/booking-demo/errors`.
- Set `PROTECTED_APP_URL=https://<deployment>.convex.site/booking-demo` in turtl. Keep the prefix, omit a trailing slash, and use the **site** URL rather than `.convex.cloud`. Existing turtl callers append the remaining paths unchanged.
- Request/response fields, bearer hash verification, 401/503 responses, fixture cleanup, impact semantics, and revision reporting match the [standalone app's contract](https://github.com/ronoktanvir/turtl/blob/capy/protected-booking-demo/protected-app/README.md). Only the base URL changes.

The optional recommendations still deliberately gate the booking write (**staged defect**). The staged `providerTimeout` failure is recovered by disabling `recommendationsEnabled`. The independent staged `bookingStoreFailure` rejects the booking write at `submit_booking` with `BOOKING_STORE_UNAVAILABLE`, with recommendations on or off. It takes precedence if both staged failures are on. These are test instruments, not production failure injection or permanent repairs.

## Scenarios: the prevention check

`POST /booking-demo/journey-check?scenario=slow_recommendations` runs the same fixture booking with the live settings, except that the recommendations provider is slowed past its time limit for that one run (`JOURNEY_SCENARIOS` in `journeyCore.ts`). It is what turtl's prevention check "Book while recommendations are slow" calls (`CHECK_SCENARIOS` in `convex/structural/rules.ts`).

- The settings row is never written: the scenario is applied in memory, `configuration` in the answer reports the live settings, and customers never meet it.
- The fixture booking is deleted like any other, and a failure is not recorded in `/errors`.
- The answer carries `"scenario": "slow_recommendations"`; turtl registers the check only when the scenario is echoed. A call without the parameter has no `scenario` field and behaves exactly as before.
- An empty, repeated or unknown `scenario` is refused with 400 `UNKNOWN_SCENARIO` (after the bearer check, so an unauthenticated call still gets 401). Other query parameters are ignored, as before.
- With the staged defect in place (recommendations on), the scenario fails at `recommendations` with `RECOMMENDATIONS_TIMEOUT`, so once registered the monitor opens a case for it every time it runs. With recommendations off it passes. `dev:resetBooking` needs every journey to pass, so clear the finding and its check first with `structural/dev:clear`.

## Environment and verification

On the shared deployment, configure:

- `PROTECTED_APP_URL`: that deployment's site URL plus `/booking-demo`.
- `PROTECTED_APP_CONTROL_SECRET`: the caller's original random bearer token, already managed by turtl's configuring machine.
- `PROTECTED_APP_CONTROL_SECRET_SHA256`: the lowercase 64-character hex SHA-256 of that token; transfer only this hash to the deploying machine.
- `PROTECTED_APP_REVISION`: the exact deployed backend PR head commit SHA, not the older standalone-app commit or the `booking-demo-v1` local fallback.
- `DEV_TOOLS_ENABLED=true`: required for `dev:registerBooking`, `dev:stageOutage`, and `dev:checkNow`. This is a public, single-owner demo without authentication in front of its development controls.

After deploying, register with `npx convex run dev:registerBooking '{}'`. Existing registration is idempotent; if the app was previously registered under a different base URL, inspect that registration before proceeding because this port does not modify turtl's registry.

For local verification, run an anonymous root Convex deployment and set its `PROTECTED_APP_URL` to `http://127.0.0.1:<site-port>/booking-demo`, with a matching caller token/hash and development controls enabled. No model key is required: turtl labels its deterministic diagnosis fallback when no model answers. Do not treat that as a model run or a Revyl device proof.

From the repository root, the integration check runs against the full prefixed base URL:

```sh
CONTROL_BASE_URL=http://127.0.0.1:3211/booking-demo \
  node convex/bookingDemo/control.test.mjs
```

Export caller-side `PROTECTED_APP_CONTROL_SECRET` in the shell first. The script prints redacted transcripts, checks all eight flag/failure configurations and the `slow_recommendations` scenario, rejects malformed state changes and unknown scenarios, verifies hash authentication, and restores all settings. `tests/booking-scenario.test.mjs` checks the scenario without a server.

To prove the prevention check end to end on a local deployment with no model key: `dev:registerBooking`, `dev:stageOutage '{"on":true}'` and `dev:checkNow` to open a case, `dev:stageOutage '{"on":false}'`, then seed a finding by hand with `structural/records:startRun` and `structural/records:recordFinding` (internal functions `npx convex run` can call; give the test `"scenario": "slow_recommendations"`). Approving it with `structural/checks:approve` registers the journey "Book while recommendations are slow", and the next `dev:checkNow` runs it and opens a case. Run it only against an isolated deployment without concurrent customer traffic. Its `.test.mjs` name keeps the Node-only check script out of Convex function deployment.

The Expo booking screens are not included in this backend port. A separate frontend change will use the namespaced customer functions on this deployment. The original standalone branch is retained for local tests until then.
