# Tests

Every suite here uses `node:test`. Nothing in them calls a real vendor: OpenAI, Supermemory, Capy, GitHub, Apple, Resend, Expo's push service and Revyl are stand-ins or recorded responses, so a passing test proves turtl's side of a call, not the vendor's.

```sh
npm run typecheck   # the app and convex/
npm run test:ci     # every *.test.mjs that needs no browser (what CI runs)
npm run test:ui     # every *.test.mjs, including the two browser tests below
```

## Backend functions without a server

Most backend tests load the real modules from `convex/` through `tests/fixtures/convex-memory.mjs`: relative imports follow the real files, `convex/_generated` is a stand-in, and an in-memory database answers only through the indexes the schema declares and writes only the fields it names. `withEnv` sets environment variables for one test, which is how a suite runs the same function once with accounts on (`AUTH_REQUIRED=true`) and once as the single-owner demo.

Accounts mode is covered this way:

- `access-rules.test.mjs` runs the public functions against a copy of every table with a fake caller: another account's project, case or row reads as missing and writes refuse, and the demo behaves as before. `access-coverage.test.mjs` parses every module and fails for a public query, mutation or action that does not ask `convex/access.ts` who is calling. `access-client.test.mjs` covers the app's side: owner decisions without a passcode in accounts mode.
- `accounts.test.mjs` runs sign-in against `fixtures/auth-stand-in.mjs`, a stand-in for GitHub's OAuth pages, Apple's keys and token endpoints, and Resend: every way an Apple token is refused, nonce replay, the password flows and their words.
- `email-codes.test.mjs` performs the attacks on emailed codes against the same stand-in and a stand-in for Convex Auth that shares turtl's in-memory database: 1,000 wrong reset codes leave the owner's working, five emails a day to an address with the newest always working, the wrong-password lock cleared by a reset, a code redeemed once, a password account held at Check your email until it confirms, throwaway sign-ups unable to fill the Apple, GitHub or confirmation ceilings, the sweep of unconfirmed accounts, and the operator's override.
- `consent-gate.test.mjs` and `consent-ui.test.mjs`: nothing reaches an AI service until the account says yes, taking it back stops the next call, the list comes from `store/data-practices.json`, and no file calls `fetch` past the gate. `spend.test.mjs`: the monthly model allowance, the daily coding-agent limit, the customer-report allowance and the deployment's ceilings.
- `account-deletion.test.mjs` fails for any table in `convex/schema.ts` that account deletion neither removes nor lists as exempt with a reason, and runs the deletion job for one of two accounts over a copy of every table, with stand-in servers for Supermemory (`fixtures/supermemory-stand-in.mjs`) and Apple and a GitHub disconnect that fails once: afterwards nothing of the first account is left and the second is untouched.
- `project-secrets.test.mjs` and `watched-app-credentials.test.mjs`: control tokens and coding agent keys are sealed, never returned, and sent only to their own project's address; no deployment secret is sent to a project.
- `github-app.test.mjs` and `github-connect.test.mjs` run `convex/github` against a stand-in for GitHub's API and the person's browser (`github-harness.mjs`, `scripts/github-app/stub.mjs`): the app JWT, installation tokens, webhook signatures and replays, Connect GitHub with a forged installation id refused, and disconnect.
- `push.test.mjs` runs `convex/push` against `fixtures/expo-push-stub.mjs`: what a push may say, who receives it, refusals across accounts.
- `bounded-reads.test.mjs` fails for a read whose size grows with the whole deployment.

## On a local Convex backend

The `*.integration.mjs` files repeat the main paths in Convex's own runtime, scheduler and `fetch`, on a local anonymous deployment (`npx convex dev --local-cloud-port <port>`), with stand-ins served on local ports. Each refuses to run against anything but a local backend, and they are not part of `npm run test:ci`. See the comment at the top of each: `push-local`, `project-secrets-local`, `evidence-local` and `evidence-collectors`. Account deletion's local proof is `scripts/account-deletion/prove-local.mjs`, and Connect GitHub's is under `scripts/github-app/`.

## UI regressions

Start the example UI with `EXPO_PUBLIC_DATA_SOURCE=example npx expo start --web --port 8081`, then run `npm run test:ui`. This explicit override also works when a local Convex setup has written a backend URL to `.env.local`. Do not set a conflicting data-source override in another local environment file.

The citation check (`inline-citations.test.mjs`) uses Chromium at a 390px viewport. Set `CHROME_PATH` when Chrome is not installed at a standard Linux or macOS path; set `UI_BASE_URL` to test another local preview. It opens an issue's Fixes page, compares each linked paragraph against identical plain text and verifies keyboard activation without navigation. `workflow-browser.test.mjs` builds the plan graph into a standalone page; see [`workflow.md`](workflow.md).

Timing tests check the accelerated example clock independently of a browser.

The live mapping, network, action and query-client tests run without a server. They cover recorded evidence and verification, exact repository identity, owner decisions, scoped permissions, the displayed merge head, and readable failures on a lagging deployment. Their mocked action responses are not proof that an external service ran.

The voice tests load the voice rules, the talk action and the hands-free turn taking without a server. They check that a spoken approve, decline, merge or stop is answered with where its button is and never reaches a decision, the refusals (switch off, missing key, long clip, rate limit), and the work state the case chat answers "what are you stuck on" from.

The store and release tests (`store-listing`, `store-lock`, `release-config`) hold the listing, the build profiles and the release lock to the repository.
