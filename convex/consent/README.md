# The AI permission

Before turtl sends an owner's code, case details, customers' reports, questions or voice to an outside AI service, the owner says yes on one screen that names each service and what it receives. The backend enforces the answer, not only the screen. This applies in accounts mode (`AUTH_REQUIRED=true`). In the single-owner demo the gate answers yes without reading anything, so the demo behaves exactly as before.

## Files

- `services.ts`: the list, read from `store/data-practices.json` (the services with `needsPermission: true`), a version for each service and for the whole list, and the rule `permissionFor(answer, service)`. Pure: the app's example data and the tests load it as it is.
- `schema.ts`: `aiConsents`, one row per answer, keyed by account. The newest row is in force. `allowed` rows name the services and the version of each that was on the screen; `declined` rows name none; taking permission back stamps `withdrawnAt`.
- `permission.ts`: `status` (what the app reads to decide whether to show the screen, and the list it shows), `allow`, `decline`, `withdraw`. The account comes from `requireAccount` in `convex/access.ts`.
- `gate.ts`: the question every outbound call asks, `internal.consent.gate.check`, and `gateFor(ctx, scope)`, the handle vendor helpers take.
- `outbound.ts`: `sendTo(service)`, the only `fetch` that reaches an AI service, and the plain errors (`Refused`, `VendorError`, `plainFailure`).

## How a call asks

Every vendor helper takes a `Gate` as its first argument and asks it before it sends:

```ts
const gate = gateFor(ctx, { appId });           // or { caseId } or { account }
const answer = await callModel(gate, { ... });  // askJson(gate, ...), respond(gate, ...), searchChunks(gate, ...)
```

Scheduled actions and crons carry no identity, so the gate reads the owner from the project: `appId -> apps.ownerId -> aiConsents`. A case resolves through its project. The answer is no when:

| Why | Words on the case |
| --- | --- |
| The account never answered | you have not said yet whether turtl may send anything to OpenAI, so nothing was sent (you can allow it in Settings) |
| The owner said Not now | you chose not to let turtl send anything to OpenAI, so nothing was sent (…) |
| The owner took permission back | you took back turtl's permission to send anything to OpenAI, so nothing was sent (…) |
| A service was added to the list after the answer | turtl added X to its list after you answered, so nothing was sent to it until you read the list again in Settings |
| What a service receives changed after the answer | what turtl sends to X changed after you agreed, so nothing was sent until you read it again in Settings |
| The service is not on the list at all (Anthropic and Google for the council, Keiki for the demo's texts: only the single-owner demo uses them) | turtl has not asked you about Anthropic, so nothing was sent to it |
| The project has no owner | turtl could not tell whose project this is, so nothing was sent to X |
| The month's model spend is used up (`convex/spend`) | this account has used its $20.00 of AI for November 2026, so no model was asked; it starts again on 1 December |
| The account's share of the day is used up (`convex/spend`) | this account has used today's $2.50 of AI, the most one account uses in a day, so no model was asked; it starts again tomorrow |
| Its projects' customer reports used their share of the day | this account's projects have used today's $1.00 of AI for reading customer reports, so no model was asked; it starts again tomorrow |
| The deployment's day is used up | turtl has reached the most AI it uses in one day across everyone, so no model was asked; it starts again tomorrow |
| Only the part kept for outages is left, and this is not an outage's diagnosis | turtl is keeping the rest of today's AI for finding the cause of outages, so no model was asked; it starts again tomorrow |
| Only that part is left, and this account has used more than $0.50 today | turtl is keeping the rest of today's AI for outages on accounts that have used less than $0.50 of it today, and this account has used more, so no model was asked; it starts again tomorrow |
| The day's coding agents are used up (`convex/spend`) | this account has already started 5 code changes today, … so Capy was not asked; it can start more tomorrow |

On a no the helper returns what it returns when its key is missing: `callModel`, `askJson` and the voice calls return the reason, so the diagnosis, the fix options, triage and the chat fall back to their rules or a plain refusal and record the reason; `respond` and the Supermemory functions throw `Refused`, whose message is the reason as a sentence; Capy returns it as its message; Keiki (demo only) reports `not_configured`. Callers that already checked `SUPERMEMORY_API_KEY` or `OPENAI_API_KEY` up front also ask `gate.blocked(service)` there, so the step's summary says why.

The gate asks again on every call, so taking permission back stops the next call. Long uploads (the code map's documents, 20 at a time) ask before each batch. Deleting a document at Supermemory (`deleteDocuments`) goes through with no permission, since it sends nothing but the ids to remove.

## Adding an outbound call

1. Put the service in `store/data-practices.json` with `needsPermission: true`, its hosts, and what it receives. Every account is asked again, because the list's version changes.
2. Add its id to `Outbound` in `services.ts`.
3. In the helper, take a `Gate`, call `gate.open(service)` and use the `fetch` it returns. Never call `fetch` yourself: `tests/consent-gate.test.mjs` fails on a bare `fetch(` in any file that names a gated host, and on any new file that calls `fetch` at all until it is listed there as a host that needs no permission.
4. If it spends model money, pass the call's estimate to `gate.open(service, "send", callEstimate(model, texts, maxOutputTokens))`, and call `gate.spent(costUsd)` after the answer (`modelCost` in `convex/spend/limits.ts` prices it). `open` holds the estimate against the account's day until `spent` replaces it (`internal.consent.gate.admit`); `blocked` only asks (`internal.consent.gate.check`).

## The app

`app/ai-permission.tsx` shows the list from `status` with Allow and Not now. `components/consent/ConsentGate.tsx` (one line in `app/_layout.tsx`) sends a signed-in owner there while `status.needsAnswer` is true. The gear sheet's AI row reads it again and takes it back. Screens that depend on a blocked service show one line saying what turtl cannot do (`components/consent/AiNotice.tsx`). None of it shows in the example build or the demo, where `status.enforced` is false.
