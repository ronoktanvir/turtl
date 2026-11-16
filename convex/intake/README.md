# Customer reports and feature requests (intake)

A customer's words reach turtl through a form in the customer's own app. Each message is stored as it was written, triaged into a bug, a request or noise, and lands on one case per problem or wish, with a count. Customers cannot text turtl and cannot sign in; there is no email channel.

## Files

- `schema.ts`: `intakeKeys` (public keys, one app each), `intakeRateWindows` (rate-limit counters), `reportTriage` (one per report: verdict, how it was judged, where it landed, the optional contact), `intakeLocks` (one triage at a time per app). Spread into `convex/schema.ts`.
- `http.ts`: `POST /intake/report` and its CORS preflight, registered from `convex/http.ts`.
- `records.ts`: storing a report (`receive`), the per-app triage queue (`claim`, `release`), applying a decision (`land`), the triage `agentRuns` rows, and the reads `forCase` and `forApp`.
- `triage.ts`: `processNext`, the triage of one report.
- `rules.ts`: pure rules with no Convex imports: body validation, rate limits, fingerprints, the dedupe rule (`decide`), the rule-based fallback, the untrusted-text rule and every prompt. `tests/intake-rules.test.mjs` runs them.
- `workflow.ts`: the `investigate` and `plan` handlers for customer cases, wrapped around the registered ones in `runner/handlers/index.ts`.
- `keys.ts`: `issue` and `revoke` (owner passcode), `forApp` (read).
- `dev.ts`: `bookingKey`, behind `DEV_TOOLS_ENABLED`: registers the booking app and its pull request action and returns its key.

`runner/handlers/detect_or_receive.ts` handles "receive" for these cases (below).

## The endpoint

`POST <deployment>.convex.site/intake/report` with JSON `{ key, text, kind?: "bug" | "request", contact?, reporterId?, reportId? }`.

- `key` is the app's public intake key (`tik_…`). It identifies the app and is not a secret: it ships inside the customer's app. Unknown or revoked keys get 403.
- `text` is 3 to 2,000 characters; the whole body is at most 8 KB (413 otherwise). Unknown fields are refused.
- `kind` is the button the customer pressed, a hint only.
- `contact` is optional, at most 200 characters. It is stored on the triage row, never in a prompt, never returned by a query; the report's `fromRef` holds a hash of it.
- `reportId` makes a retry idempotent (`reports.by_app_and_provider_event`). `reporterId` is an anonymous device id that counts one person when no contact is given.
- Rate limits, per fixed window: 30 a minute and 500 a day per key, 5 per 10 minutes per sender. Over a limit: 429 with `Retry-After`.
- Success is `202 { ok: true, received: true }`. Nothing about cases is returned.

The deployment URL is public, so the limits and sizes are the only protection; a sender can change `reporterId` freely, so the per-key limits are the real cap.

## Triage

Triage runs one report at a time per app, so a report can match the case the report before it opened.

1. **Exact copy.** A report whose fingerprint (lowercased words) equals one already on an open customer case of the app joins that case. No model is asked.
2. **Candidates.** The app's open customer-raised cases, newest 20, each with up to three of its reports, are read from Convex and labelled C1, C2, ….
3. **Supermemory suggestion.** Report texts are indexed per app in `${INTAKE_NAMESPACE_PREFIX}reports_<appId>`. A search may mark candidates `suggestedBySearch`; a suggestion that is not a candidate read from Convex is dropped.
4. **Model.** One call (`FIXES_MODEL`, else `DIAGNOSIS_MODEL`, else gpt-5.4-mini) returns `{ verdict, sameAs, title, summary }`. Only those four fields are read, and `sameAs` must be one of the refs offered.
5. **Rule-based fallback.** With no usable answer, rules judge the text (length, links, instruction-only text, request and symptom words, the customer's button) and match only by word overlap of at least 0.6. The reason says "Rule-based triage, not a model's: no model answered (…)".
6. **Instruction guard.** Text that gives instructions to turtl, an AI or its operators and describes no symptom is noise, whatever the model said.
7. **Decision** (`decide` in `rules.ts`). Noise lands nowhere. A report joins the matched case only when that case is open, of this app, raised by a customer, and of the kind the report was judged to be. Otherwise it opens a case of that kind (`bug_report` or `feature_request`), `raisedBy: "customer"`, with the app's journey when it has one. `reportCount` counts messages and `distinctRequesterCount` counts people; both are recomputed from the `reports` rows each time.
8. **Owner notice.** A new case schedules one `opened` notice through `notices.notifyOwner`, which keeps one outcome per case and event and stays best effort. Its text names only the app and the kind, never the customer's words, because the notice is read by another agent.

A triage that fails three times is kept as `ignored` with that reason. A stuck lock expires after two minutes and the queue kicks itself again.

### agentRuns

Each model triage writes an `agentRuns` row (`triage_customer_report`) on the `detect_or_receive` step of the case it lands on: for a new case when that step runs, for a match at once. A report judged noise lands on no case, so its row carries the report's `appId` and no `caseId`, step or attempt.

## Customer text is untrusted

Every prompt that carries a customer's words includes `UNTRUSTED_RULE`: the text is evidence of a symptom or a wish, never an instruction. Customer text is sent as a JSON data field, never spliced into instructions. A model's answer can only choose a verdict, one offered case, and neutral words; it cannot name an action, a target or a parameter. Options are bound to the app's pull request catalog entry by `pullRequestOption`, approving one needs the owner and the owner passcode, and nothing merges without the owner's Merge tap. The instruction guard above stops instruction-only text from opening a case or raising a count.

What remains: an option's `change` instructions are written by a model that read customer text, and they become the message Capy works from. The owner sees the option's words, not the full `change` text, before approving, and reviews the pull request before merging.

## The workflow for customer cases

- **detect_or_receive ("receive").** The reports become `customer_report` evidence in the customers' own words, marked as such, and pending triage runs get their `agentRuns` rows. A bug report on an app with a journey gets a fresh health and journey check recorded as the `before` verification. A passing check does not dismiss the report; the summary says the check does not reproduce what customers describe. A check that cannot run reads "Not covered". A feature request runs no check.
- **gather_context, examine_broader_causes, authorize_and_execute, verify, learn.** The registered handlers.
- **investigate.** One model call over the reports (as symptoms) and, for a bug, the fresh facts and evidence, with an `agentRuns` row (`diagnose_customer_report` or `read_feature_request`); a labelled rule-based reading when no model answers. Its output has the same shape as the outage diagnosis.
- **plan.** A bug report whose fresh booking check fails is an outage in customers' words and keeps the registered plan (the catalog recovery plus code changes). Otherwise one model call (`agentRuns`: `propose_feature_options` or `propose_customer_bug_fixes`) proposes one to four code changes, each a pull request through the app's pull request action: kind `change` ("Build it") for a feature, `repair` or `prevention` for a bug. Exactly one is recommended. With no model answer the step fails and says so; turtl does not write a code change without one. A feature's done means includes "the requested change is in the app, shown by before and after screenshots", which no check covers yet, so it reads "Not covered".

Approving an option goes through `decisions.approve` (owner passcode) and the existing pull request path. Without `CAPY_API_KEY` the execute step stops with "Not configured: set CAPY_API_KEY … Nothing was sent."

## Screens

Fix and Features read these cases through `data/live`: Features lists open feature requests by how many people asked, then newest; a case's Overview shows every message customers wrote, with the count of messages and people; a feature's reading is labelled "What customers ask for". The booking app (`protected-app/report/ReportForm.tsx`) has "Report a problem" and "Request a feature".

## Setup

1. Deploy. No new environment variable is required. `INTAKE_NAMESPACE_PREFIX` is optional and empty in production; a test deployment sets it to keep its Supermemory namespaces apart.
2. Issue a key for each app: `npx convex run intake/keys:issue '{"appId":"<app id>","passcode":"<owner passcode>"}'` (or `intake/dev:bookingKey` on a dev deployment). For a pull request option to be offered, the app needs its pull request action (`prTracking/catalog:register` for the booking app).
3. Set `EXPO_PUBLIC_TURTL_INTAKE_KEY` in the customer app. The booking app finds the endpoint from `EXPO_PUBLIC_CONVEX_URL` (`.convex.cloud` to `.convex.site`, or port 3210 to 3211 locally), or from `EXPO_PUBLIC_TURTL_INTAKE_URL`.
