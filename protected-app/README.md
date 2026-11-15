# Still: the protected booking demo

This is the **app turtl protects**, not the on-call app. It has its own Expo Router app, npm lockfile, Convex functions, database, and deployment. Run every command below from `protected-app/`. Never point it at turtl's Convex deployment.

Customers select a treatment and a time, submit without signing in, and receive a confirmation backed by a stored `bookings` row. Services and tomorrow's four illustrative appointment times (UTC) come from the backend. Slots are not inventory: multiple demo bookings may choose the same time. No personal information, accounts, payment, or real AI is involved.

## The staged failures

`convex/provider.ts` is an in-process **simulated upstream recommendation provider**, not a model API. Normally it returns suggested service IDs after 120 ms. The staged `providerTimeout` switch makes it wait 1,200 ms and fail.

**The coupling in `convex/journeyCore.ts` is deliberately defective:** when `recommendationsEnabled` is true, submitting a booking waits for optional recommendations before writing the booking. The staged provider timeout therefore blocks booking and produces a structured failed attempt. Do not repair that dependency in this demo step; a later demo PR performs the permanent repair.

There is exactly one recovery flag, `recommendationsEnabled`. Setting it to false skips the provider on both the screen and the booking path. Booking then works even while `providerTimeout` remains true, provided the booking store itself is available.

The second **staged** test-instrumentation switch, `bookingStoreFailure`, makes the booking-write mutation in `convex/records.ts` reject before inserting a row. It returns `BOOKING_STORE_UNAVAILABLE` at `submit_booking`, independently of the recommendation flag. The customer sees the same “We couldn't save your spot.” heading, but the structured error identifies the different cause. Turning recommendations off cannot repair this counterexample. When both staged failures are enabled, the store failure takes precedence: the booking path skips the provider and attempts the deliberately failing write. The switches are test instrumentation, not additional recovery flags. Initial state: recommendations enabled, both staged failures off. Existing settings without `bookingStoreFailure` default to false.

## Local development (no Convex account or keys)

```sh
npm ci
CONVEX_AGENT_MODE=anonymous npx convex dev --once
```

This initializes an isolated, account-free project under this folder's ignored `.convex/` directory and generates `.env.local` and `convex/_generated/`. Start the local backend and keep it running:

```sh
CONVEX_AGENT_MODE=anonymous npx convex dev
```

In a second terminal, generate a local control secret for the caller and set only its lowercase hex SHA-256 hash in the **protected** backend. Do not commit either credential, the hash, or `.env.local`:

```sh
export PROTECTED_APP_CONTROL_SECRET="$(openssl rand -hex 32)"
export PROTECTED_APP_CONTROL_SECRET_SHA256="$(printf %s "$PROTECTED_APP_CONTROL_SECRET" | openssl dgst -sha256 -r | cut -d' ' -f1)"
npx convex env set PROTECTED_APP_CONTROL_SECRET_SHA256 "$PROTECTED_APP_CONTROL_SECRET_SHA256"
npx convex env set PROTECTED_APP_REVISION "$(git rev-parse HEAD)"
```

Set `EXPO_PUBLIC_CONVEX_URL` in `protected-app/.env.local` to the local Convex API URL printed by the CLI (usually `http://127.0.0.1:3210`), then:

```sh
npm run web
npm run typecheck
```

For a phone, use a backend address reachable from that phone, not its loopback address. The HTTP control base is the **site URL**, usually `http://127.0.0.1:3211` locally, not the Convex API port. Hosted Convex uses `https://<deployment>.convex.site` for HTTP and `.convex.cloud` for the client.

## Deploy later

Provision a **second Convex project**, separate from turtl. Supply its `CONVEX_DEPLOY_KEY` through the environment; set `PROTECTED_APP_CONTROL_SECRET_SHA256` (the lowercase hex SHA-256 of the caller's secret) and `PROTECTED_APP_REVISION` (the deployed commit SHA) in that project's Convex environment. The machine configuring turtl generates and retains the original secret; only the hash travels to the machine deploying this app. The single backend deployment command is:

```sh
npm run deploy
```

Set `EXPO_PUBLIC_CONVEX_URL` to that deployment's API URL before starting or building Expo. The original control secret belongs only on the calling server, never in this booking backend's environment, and neither secret nor hash may use an `EXPO_PUBLIC_` prefix. Remove the legacy `PROTECTED_APP_CONTROL_SECRET` environment variable from any previously configured booking deployment. turtl's backend needs the protected app's site URL and the original control secret. This PR does not connect them or host the Expo app.

No Revyl config is included. Native proof would need a separate protected-app Revyl project/build rooted here, its own Expo public backend URL in build environment, a backend reachable from the cloud simulator, and a journey that selects a treatment/time and checks confirmation. It must not reuse the root on-call app's proof or claim that a server check proves native UI behavior.

## HTTP control contract, v1

All paths below are relative to the protected Convex **site URL**. Responses have `Content-Type: application/json` and `Cache-Control: no-store`. Timestamps are Unix milliseconds. No CORS is offered: this interface is for server-to-server calls, not browser admin controls.

`GET /health` and `GET /revision` are public. **Every other endpoint, including reads, requires `Authorization: Bearer <secret>`.** The backend hashes the presented token with SHA-256 and compares its 32 digest bytes against `PROTECTED_APP_CONTROL_SECRET_SHA256` in a fixed-length loop with no value-dependent early exit. The stored hash itself is not a bearer credential. Every state-changing HTTP endpoint is authenticated. Public customer Convex actions intentionally allow unauthenticated demo bookings; they cannot change settings. Settings writes are internal Convex mutations, reachable externally only through authenticated HTTP actions.

Protected endpoints return `401` for a missing/wrong bearer token, or `503` when the backend hash is missing or is not exactly 64 lowercase hex characters:

```ts
{ error: { code: "UNAUTHORIZED", message: "A valid control bearer token is required." } }
{ error: { code: "CONTROL_NOT_CONFIGURED", message: "Control secret is not configured." } }
```

### Health and revision

`GET /health` takes no body. `200` proves only that the HTTP server responded, even during the staged outage:

```ts
{ ok: true, service: "protected-booking", timestamp: number }
```

`GET /revision` takes no body and returns `200`:

```ts
{ revision: string, environment: "protected-app" }
```

`revision` is `PROTECTED_APP_REVISION`, or the explicitly versioned source fallback `booking-demo-v1` for unconfigured local runs. Set the environment value to the deployed commit SHA for hosted evidence. `environment` identifies this app, not a production-verification claim; the caller must retain the exact target site URL.

### Flag

`GET /flags` takes no body. `POST /flags` accepts **exactly**:

```json
{ "recommendationsEnabled": false }
```

Both return `200`:

```ts
{ recommendationsEnabled: boolean, updatedAt: number | null }
```

`updatedAt` is null before the first settings write. Setting the same value is safe; it updates the timestamp. This changes no provider failure setting. Recovery is reversible by setting the flag back to true.

### Staged failure

`GET /staged-failure` takes no body. `POST /staged-failure` accepts **exactly one boolean field**, either:

```json
{ "providerTimeout": true }
```

or:

```json
{ "bookingStoreFailure": true }
```

Sending both fields in one request is invalid; setting either leaves the other unchanged.

Both return `200`:

```ts
{ staged: true, providerTimeout: boolean, bookingStoreFailure: boolean, timeoutMs: 1200, updatedAt: number | null }
```

This changes no recovery flag. In-flight bookings/checks use the configuration snapshot they read when they started; run a new check after changing settings.

For either settings POST, invalid JSON returns `400`:

```ts
{ error: { code: "INVALID_JSON", message: "Expected a JSON object." } }
```

An array, wrong field, extra field, or non-boolean value returns `400`:

```ts
{ error: { code: "INVALID_BODY", message: "Expected exactly one boolean field: recommendationsEnabled." } }
{ error: { code: "INVALID_BODY", message: "Expected exactly one boolean field: providerTimeout or bookingStoreFailure." } }
```

### Server booking journey

`POST /journey-check` takes **no body** (any supplied body is ignored). It loads the customer catalog, selects its first service/time, calls the **same booking implementation** as the app, verifies the persisted booking matches the confirmation, and deletes its fixture in a `finally` block. It does not exercise the Expo UI. Fixture bookings and failures never enter customer impact counts. Each check has a unique run ID; cleanup deletes only that run's bookings.

HTTP `200` means `verdict: "passed"`; HTTP `503` means `verdict: "failed"` (including a failed cleanup). Always read the JSON on `503`:

```ts
{
  runId: string,
  verdict: "passed" | "failed",
  failedStep: string | null,
  error: null | { code: string, message: string, step?: string, provider?: string, retryable?: boolean },
  steps: Array<{
    step: "load_catalog" | "recommendations" | "submit_booking" | "verify_persisted" | "cleanup",
    verdict: "passed" | "failed" | "skipped",
    detail: string
  }>,
  cleanup: { ok: boolean, deletedBookings: number },
  configuration: { recommendationsEnabled: boolean, providerTimeout: boolean, bookingStoreFailure: boolean },
  revision: string,
  environment: "protected-app",
  startedAt: number,
  completedAt: number
}
```

In the staged provider outage, `failedStep` is `recommendations`, `error.code` is `RECOMMENDATIONS_TIMEOUT`, `submit_booking` and `verify_persisted` are skipped, and cleanup deletes zero rows. With the flag off and the store available, recommendations are skipped and the remaining steps pass; cleanup deletes one row. With `bookingStoreFailure: true`, the result is `failedStep: "submit_booking"` and `error.code: "BOOKING_STORE_UNAVAILABLE"` with the recommendation flag either on or off. Recommendations are skipped because the staged store failure takes precedence; `submit_booking` fails, `verify_persisted` is skipped, and cleanup deletes zero rows. Unexpected execution errors use `JOURNEY_INTERNAL_ERROR`; cleanup errors use `CLEANUP_FAILED`. A persistence mismatch fails `verify_persisted` with `error: null`.

### Failed bookings and impact

`GET /errors` takes no body or parameters. `200` returns a rolling 15-minute window of **customer submission attempts**, not recommendation page loads or journey checks:

```ts
{
  window: { since: number, until: number, sampleLimit: 1000, truncated: boolean },
  counts: {
    totalBookings: number,
    failedBookings: number,
    successfulBookings: number,
    errorRate: number
  },
  errors: Array<{
    id: string,
    timestamp: number,
    revision: string,
    serviceId: string,
    date: string,
    time: string,
    code: string,
    message: string,
    step: string,
    provider?: string,
    retryable: boolean
  }>
}
```

`totalBookings` means attempted submissions, not stored bookings. `errorRate` is failed / total in `[0, 1]`, or zero for an empty window. Counts cover the latest 1,000 attempts in the window; `truncated: true` explicitly marks a capped sample, not an exact window-wide total. Errors are the newest 20 failures within that sample, newest first; `id` is the stable Convex attempt ID. A failed optional provider dependency reports `code: "RECOMMENDATIONS_TIMEOUT"`, `step: "recommendations"`, `provider: "simulated-recommendations"`, and `retryable: true`. The staged store failure reports `BOOKING_STORE_UNAVAILABLE`, `submit_booking`, no `provider` field, and `retryable: true`. Invalid customer selections report `INVALID_SELECTION`, `submit_booking`, and `retryable: false`. No customer identity is stored.

## Reproduce the recovery and counterexample

Export `CONTROL_BASE_URL` and a shell-only caller `PROTECTED_APP_CONTROL_SECRET` whose SHA-256 matches the backend's `PROTECTED_APP_CONTROL_SECRET_SHA256`. The test runner sends the original secret, never the stored hash. Never paste either into evidence. Requests use:

```sh
curl "$CONTROL_BASE_URL/health"
curl "$CONTROL_BASE_URL/revision"
curl -H "Authorization: Bearer $PROTECTED_APP_CONTROL_SECRET" "$CONTROL_BASE_URL/flags"
curl -H "Authorization: Bearer $PROTECTED_APP_CONTROL_SECRET" "$CONTROL_BASE_URL/staged-failure"
curl -X POST -H "Authorization: Bearer $PROTECTED_APP_CONTROL_SECRET" \
  -H 'Content-Type: application/json' -d '{"providerTimeout":true}' "$CONTROL_BASE_URL/staged-failure"
curl -X POST -H "Authorization: Bearer $PROTECTED_APP_CONTROL_SECRET" "$CONTROL_BASE_URL/journey-check"
curl -X POST -H "Authorization: Bearer $PROTECTED_APP_CONTROL_SECRET" \
  -H 'Content-Type: application/json' -d '{"recommendationsEnabled":false}' "$CONTROL_BASE_URL/flags"
curl -H "Authorization: Bearer $PROTECTED_APP_CONTROL_SECRET" "$CONTROL_BASE_URL/errors"
curl -X POST -H "Authorization: Bearer $PROTECTED_APP_CONTROL_SECRET" \
  -H 'Content-Type: application/json' -d '{"bookingStoreFailure":true}' "$CONTROL_BASE_URL/staged-failure"
curl -X POST -H "Authorization: Bearer $PROTECTED_APP_CONTROL_SECRET" "$CONTROL_BASE_URL/journey-check"
```

| State | recommendationsEnabled | providerTimeout | bookingStoreFailure | Expected booking/check |
| --- | --- | --- | --- | --- |
| Healthy | true | false | false | Confirmation; stored booking; journey passes |
| Staged provider outage | true | true | false | Booking not saved; failed attempt; journey fails at recommendations |
| Recovered | false | true | false | No provider call; confirmation; stored booking; journey passes |
| Staged store counterexample, flag on | true | either | true | Booking not saved; journey fails at submit_booking |
| Staged store counterexample, flag off | false | either | true | Same failure: disabling recommendations does not fix the store |

Reload the booking page after toggling the staged provider switch to refresh suggestions. Flag changes update the open page live through a Convex query. The staged store switch is checked on each submission. After an error, select a service and time and submit again once recovery is applied. A previously confirmed booking is never rewritten when the flag changes.

`npm run test:control` uses caller-side `PROTECTED_APP_CONTROL_SECRET` and exercises authentication (including rejection of the stored hash as a bearer token), body validation, all eight combinations of the recovery flag and two staged failure switches, fixture cleanup, and unchanged customer-impact counts. It prints redacted request/response transcripts. It temporarily changes all three settings and restores them in `finally`; run it only against an isolated test deployment with no concurrent customer traffic.
