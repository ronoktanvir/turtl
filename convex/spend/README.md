# What one account may spend

A reviewer who approves fixes again and again cannot run up an unlimited bill. With accounts on (`AUTH_REQUIRED=true`), each account has:

- **A monthly limit on model spend**, `MODEL_SPEND_LIMIT_USD` (default $20), per calendar month in UTC. Every model call that the gate lets through adds its estimated cost to the account's month. Once the total reaches the limit, the gate refuses every OpenAI, Anthropic or Google call for that account until the month turns, and the case says so in plain words.
- **A daily limit on coding agents**, `CODING_THREADS_PER_DAY` (default 5), per calendar day in UTC. Every Capy thread is billed to the deployment's `CAPY_API_KEY`, so starting one counts. A retried start with the same request id counts once. Reading a thread that already exists does not count.

Each project also has its own allowance for what its customers cause, apart from the account's, so a customer who posts reports at every key's limit cannot spend the owner's month and stop turtl diagnosing the owner's outages:

- **A daily allowance for customer reports**, `INTAKE_SPEND_PER_DAY_USD` (default $0.50), per project per calendar day in UTC. Report triage (`convex/intake/triage.ts`) and the investigate and plan steps of a case customers opened (`convex/intake/workflow.ts`) ask the gate with `gateFor(ctx, { appId }, "intake")`; their cost lands on the project's day (`intakeDays`), never on the account's month. Once it is spent, triage judges reports by its rules and those cases get the labelled rule-based reading, until the next day. The account's own model calls are unaffected.
- **A daily cap on new cases from customer reports**, `INTAKE_CASES_PER_DAY` (default 5), per project. Past it a report that would open a case is kept on no case, and its triage reason says why; a report that matches an open case still joins it.

Every limit above is per account or per project, and nothing yet stops a script from making accounts (there is no email check until an email service is chosen; see `convex/auth/README.md`), so the deployment has ceilings of its own (`ceilings.ts`):

- **A daily ceiling on every account's model spend together**, `DEPLOYMENT_MODEL_SPEND_PER_DAY_USD` (default $25). The gate checks it before any model call, whichever allowance it spends; past it no model is asked for anyone until the next day (UTC).
- **New accounts per hour and per day**, `NEW_ACCOUNTS_PER_HOUR` (default 20) and `NEW_ACCOUNTS_PER_DAY` (default 100), counted by Convex Auth's `afterUserCreatedOrUpdated` callback (`convex/auth.ts`) inside the mutation that makes the user, so a refused sign-up leaves nothing behind. Any method counts: email and password, Apple, GitHub.
- **Projects per account**, `PROJECTS_PER_ACCOUNT` (default 10), checked by `onboarding/projects:add`; **intake keys per project**, `INTAKE_KEYS_PER_PROJECT` (default 3 taking reports at once), checked by `intake/keys:issue`.

The totals live in `deploymentTotals` (one row per total per hour or day; older ones are deleted as a new one starts). They belong to no account and are not deleted with one.

## Each account's share of the day

The daily ceiling is one pool every account shares, so without more one account could reach it alone (its month in a morning of chat, plus its projects' customer reports) and no other owner would get a diagnosis until midnight UTC (second review, finding 12). So each account has a share of the day, checked by the gate after the ceiling:

- **Its own calls**, `ACCOUNT_MODEL_SPEND_PER_DAY_USD` (default $2.50): diagnosis, fix options, the case chat, voice, reading its repositories and the code map.
- **Its projects' customer reports together**, `ACCOUNT_INTAKE_SPEND_PER_DAY_USD` (default $1.00), on top of each project's own `INTAKE_SPEND_PER_DAY_USD`. Kept apart from the first, so customers cannot use up what diagnosing the owner's outages needs.

Both live in `accountSpendDays` (one row per account per day; older days are deleted as a new one starts; the rows go with the account). A call is counted from the moment the gate lets it through: `internal.consent.gate.admit` holds the caller's estimate of its cost (`callEstimate(model, promptChars, maxOutputTokens)`, or $0.10 when it gives none) in the same transaction as the check, and `addModelSpend` replaces the hold with what the call cost. So calls started together are counted one after another and a burst stops at the share; the day can pass the share by at most the last call let through. A call that fails before reporting its cost keeps its hold until the day ends.

With the defaults one account can put at most about $3.50 (plus one call each side) into the deployment's $25.00 day, so it takes at least eight accounts acting together to reach the ceiling.

In the single-owner demo there is no limit and nothing is recorded.

## Files

- `limits.ts`: the two limits, the month and day keys, and `modelCost(model, usage)`: the list price from `convex/routing/configs.ts`, or the dearest price on that list for a model it does not price, so an unpriced model cannot slip past the limit. Speech-to-text and text-to-speech report no tokens and count $0.01 a call.
- `schema.ts`: `modelSpend` (one row per account per month: estimated dollars and calls), `accountSpendDays` (one row per account per day: its own calls and its customers' reports, spent and held), `codingThreads` (one row per thread started, by day) and `intakeDays` (one row per project per day: what its customer reports cost and how many cases they opened; older days are deleted as a new one starts).
- `ledger.ts`: `addModelSpend` (to the project's day when the gate was made for customer reports, otherwise the account's month) and `recordThread`, written only by the gate (`convex/consent/gate.ts`) after a call it let through; `openIntakeCase`, which `intake/records:land` asks before opening a case; and the readers the gate checks before a call.
- `status.ts`: `api.spend.status.mine`, the gear sheet's line: spend this month against the limit, and coding agents started today against theirs.

## Estimates, not invoices

Costs are estimates from the tokens each provider reports and published list prices. A burst of calls that start together can each pass the check before any of them is recorded, so the total can pass the limit by what those calls cost. The limit stops the next call, not the one in flight.
